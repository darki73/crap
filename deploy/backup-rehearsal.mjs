import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { workspaceBackup } from "./workspace-backup.mjs";
const project = process.argv[2];
if (!/^crap-(ci|release-rehearsal)(-[a-z0-9]+)*$/.test(project || ""))
  throw new Error("Disposable rehearsal project required.");
const restored = `${project}-backup-restore`;
function docker(args) {
  const r = spawnSync("docker", args, {
    windowsHide: true,
    maxBuffer: 8 << 20,
  });
  if (r.status !== 0)
    throw new Error(
      "Rehearsal Docker operation failed; private output withheld.",
    );
  return r.stdout.toString().trim();
}
const compose = (p) => [
  "compose",
  "-p",
  p,
  "-f",
  "deploy/compose.legacy-test.yaml",
];
const query = (p, sql) =>
  docker([
    "exec",
    `${p}-postgres-1`,
    "psql",
    "-X",
    "-U",
    "postgres",
    "-d",
    "crap",
    "-At",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    sql,
  ]);
assert.equal(query(project, "SELECT count(*) FROM cliproxy.auth_store"), "0");
assert.equal(
  query(
    project,
    "SELECT count(*) FROM affinity_router.usage_events WHERE model <> 'claude-fixture'",
  ),
  "0",
);
assert.ok(
  Number(query(project, "SELECT count(*) FROM affinity_router.usage_events")) >=
    3,
);
assert.equal(
  docker([
    "volume",
    "ls",
    "-q",
    "--filter",
    `label=com.docker.compose.project=${restored}`,
  ]),
  "",
  "restore fixture already exists",
);
const fingerprint = (p) =>
  query(
    p,
    "SELECT md5(string_agg(row_to_json(t)::text,',' ORDER BY event_id)) FROM affinity_router.usage_events t",
  );
const before = fingerprint(project);
const dir = await mkdtemp(path.join(tmpdir(), "crap-backup-rehearsal-"));
const file = path.join(dir, "workspace.crap"),
  password = "disposable-backup-rehearsal-passphrase";
let restoredCreated = false;
try {
  await workspaceBackup({
    deployment: "legacy-test",
    action: "backup",
    project,
    file,
    password,
    keepStopped: true,
  });
  // No Telegram or Tailscale service is enabled in this fixture workspace.
  await workspaceBackup({
    deployment: "legacy-test",
    action: "restore",
    project: restored,
    file,
    password,
  });
  restoredCreated = true;
  await assert.rejects(
    workspaceBackup({
      deployment: "legacy-test",
      action: "restore",
      project: restored,
      file,
      password,
    }),
    /fresh project/,
  );
  for (const v of ["proxy-data", "control-data", "panel-data"]) {
    const hash = (p) =>
      docker([
        "run",
        "--rm",
        "--network",
        "none",
        "--read-only",
        "--user",
        "0:0",
        "--mount",
        `type=volume,source=${p}_${v},target=/snapshot,readonly`,
        "--entrypoint",
        "sh",
        "crap-panel:alpha-local",
        "-c",
        "find /snapshot -type f -exec sha256sum {} + | sort",
      ]);
    assert.equal(
      hash(restored),
      hash(project),
      `restored ${v} differs before activation`,
    );
  }
  docker([...compose(restored), "up", "-d", "--wait", "--wait-timeout", "180"]);
  assert.equal(fingerprint(restored), before, "restored usage ledger differs");
  docker([
    ...compose(restored),
    "exec",
    "-T",
    "panel",
    "node",
    "deploy/verify-restored.mjs",
  ]);
  for (const v of [
    "bootstrap-state",
    "postgres-secrets",
    "proxy-secrets",
    "control-secrets",
    "panel-secrets",
  ]) {
    const hash = (p) =>
      docker([
        "run",
        "--rm",
        "--network",
        "none",
        "--read-only",
        "--user",
        "0:0",
        "--mount",
        `type=volume,source=${p}_${v},target=/snapshot,readonly`,
        "--entrypoint",
        "sh",
        "crap-panel:alpha-local",
        "-c",
        "find /snapshot -type f -exec sha256sum {} + | sort",
      ]);
    assert.equal(hash(restored), hash(project), `restored ${v} differs`);
  }
  console.log(
    "PASS: full encrypted workspace restore boots; ledger, all secret volumes and encrypted integration settings match. Existing targets are refused.",
  );
} finally {
  try {
    if (restoredCreated) docker([...compose(restored), "down", "--volumes"]);
  } finally {
    docker([
      ...compose(project),
      "start",
      "control",
      "proxy",
      "gateway",
      "panel",
    ]);
    if (
      path.dirname(dir) !== tmpdir() ||
      !path.basename(dir).startsWith("crap-backup-rehearsal-")
    )
      throw new Error("Unsafe test cleanup path");
    await rm(dir, { recursive: true, force: true });
  }
}
