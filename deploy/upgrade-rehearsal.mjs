// Run before replacing the disposable stack's old containers/images. This records
// exact image IDs and proves rollback from the resulting upgraded database.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { workspaceBackup } from "./workspace-backup.mjs";
import { privateDirectory } from "../control-panel/database-transfer.mjs";
const project = process.argv[2];
if (!/^crap-(ci|release-rehearsal)(-[a-z0-9]+)*$/.test(project || ""))
  throw new Error("Disposable project required");
const target = `${project}-rollback`;
const compose = (p) => [
  "compose",
  "-p",
  p,
  "-f",
  "deploy/compose.legacy-test.yaml",
];
const docker = (args) => {
  const r = spawnSync("docker", args, {
    windowsHide: true,
    maxBuffer: 8 << 20,
  });
  if (r.status !== 0)
    throw new Error("Upgrade rehearsal failed; private output withheld");
  return r.stdout.toString().trim();
};
const query = (p, sql) =>
  docker([
    ...compose(p),
    "exec",
    "-T",
    "postgres",
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
assert.equal(
  query(
    project,
    "SELECT (SELECT count(*) FROM cliproxy.auth_store)+(SELECT count(*) FROM affinity_router.usage_events WHERE model <> 'claude-fixture')",
  ),
  "0",
);
assert.equal(
  docker([
    "volume",
    "ls",
    "-q",
    "--filter",
    `label=com.docker.compose.project=${target}`,
  ]),
  "",
);
const versions = (p) =>
  query(
    p,
    "SELECT string_agg(name||':'||checksum,',' ORDER BY name) FROM affinity_router.schema_migrations",
  );
const ledger = (p) =>
  query(
    p,
    "SELECT md5(string_agg(row_to_json(t)::text,',' ORDER BY event_id)) FROM affinity_router.usage_events t",
  );
const oldSchema = versions(project),
  oldLedger = ledger(project);
const services = {};
for (const name of ["control", "gateway", "panel"]) {
  const info = JSON.parse(docker(["inspect", `${project}-${name}-1`]))[0];
  assert.equal(info.Config.Labels["com.docker.compose.project"], project);
  const tag = `crap-rollback-${name}:fixture-${info.Image.slice(7, 19)}`;
  docker(["tag", info.Image, tag]);
  services[name] = { image: tag, pull_policy: "never" };
}
services.proxy = { image: JSON.parse(docker(["inspect", `${project}-proxy-1`]))[0].Config.Image, pull_policy: "never" };
services.migrate = services.control;
services.bootstrap = services.panel;
const root = await mkdtemp(path.join(os.tmpdir(), "crap-upgrade-"));
await privateDirectory(root);
const archive = path.join(root, "before.crap"),
  override = path.join(root, "old-images.json"),
  password = "fixture-only-upgrade-passphrase";
await writeFile(override, JSON.stringify({ services }));
let restored = false;
try {
  await workspaceBackup({
    deployment: "legacy-test",
    action: "backup",
    project,
    file: archive,
    password,
    keepStopped: true,
  });
  docker([...compose(project), "up", "-d", "--wait", "--wait-timeout", "180"]);
  const newSchema = versions(project);
  docker([
    ...compose(project),
    "exec",
    "-T",
    "-e",
    "CRAP_REHEARSAL=1",
    "panel",
    "node",
    "deploy/smoke.mjs",
  ]);
  docker([...compose(project), "stop", "gateway", "panel", "proxy", "control"]);
  await workspaceBackup({
    deployment: "legacy-test",
    action: "restore",
    project: target,
    file: archive,
    password,
  });
  restored = true;
  docker([
    ...compose(target),
    "-f",
    override,
    "up",
    "-d",
    "--wait",
    "--wait-timeout",
    "180",
  ]);
  assert.equal(
    versions(target),
    oldSchema,
    "rollback did not restore the exact old migration set",
  );
  assert.equal(ledger(target), oldLedger, "rollback ledger changed");
  docker([
    ...compose(target),
    "exec",
    "-T",
    "panel",
    "node",
    "deploy/verify-restored.mjs",
  ]);
  console.log(
    `PASS: ${oldSchema === newSchema ? "same-version recovery" : "version-to-version upgrade and rollback"}; exact previous images, schema checksums, ledger and encryption identity restored.`,
  );
} finally {
  try {
    if (restored)
      docker([...compose(target), "-f", override, "down", "--volumes"]);
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
      path.dirname(root) !== os.tmpdir() ||
      !path.basename(root).startsWith("crap-upgrade-")
    )
      throw new Error("Unsafe fixture cleanup");
    await rm(root, { recursive: true, force: true });
  }
}
