// Destructive ONLY to containers created below; source services are stopped and
// restarted, never deleted. Deliberately not a general-purpose backup command.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
const project = process.argv[2];
if (!/^crap-(?:ci|release-rehearsal)(?:-[a-z0-9-]+)?$/.test(project || ""))
  throw new Error(
    "Only an explicitly named CRAP rehearsal/CI project is allowed.",
  );
const compose = [
  "compose",
  "-p",
  project,
  "-f",
  fileURLToPath(new URL("compose.legacy-test.yaml", import.meta.url)),
];
function docker(args, input) {
  const r = spawnSync("docker", args, {
    input,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (r.status !== 0)
    throw new Error(
      `Docker rehearsal step failed (${args[0]} ${args[1]}). Error output withheld because database tools may include credentials.`,
    );
  return r.stdout;
}
const source = `${project}-postgres-1`;
const query = (container, sql) =>
  docker([
    "exec",
    container,
    "psql",
    "-X",
    "-v",
    "ON_ERROR_STOP=1",
    "-At",
    "-U",
    "postgres",
    "-d",
    "crap",
    "-c",
    sql,
  ])
    .toString()
    .trim();
assert.equal(
  query(source, "SELECT count(*) FROM cliproxy.auth_store"),
  "0",
  "Rehearsal refuses OAuth credentials",
);
assert.equal(
  query(
    source,
    "SELECT count(*) FROM affinity_router.usage_events WHERE model <> 'claude-fixture'",
  ),
  "0",
  "Rehearsal refuses non-fixture usage",
);
assert.ok(
  Number(query(source, "SELECT count(*) FROM affinity_router.usage_events")) >=
    3,
  "Run smoke.mjs first",
);
const info = (name) => JSON.parse(docker(["inspect", name]).toString())[0];
const secretVolume = (container) =>
  info(container).Mounts.find((m) => m.Destination === "/run/crap").Name;
const pgSecrets = secretVolume(source),
  controlSecrets = secretVolume(`${project}-control-1`),
  panelSecrets = secretVolume(`${project}-panel-1`);
const suffix = randomBytes(4).toString("hex"),
  network = `${project}-restore-${suffix}`,
  target = `${network}-db`,
  control = `${network}-control`;
const created = [];
let networkCreated = false,
  stopped = false;
function fingerprints(container) {
  const tables = query(
    container,
    "SELECT schemaname || '.' || tablename FROM pg_tables WHERE schemaname IN ('affinity_router','cliproxy') ORDER BY 1",
  )
    .split("\n")
    .filter(Boolean);
  return tables.map((table) => {
    if (!/^[a-z_]+\.[a-z_]+$/.test(table))
      throw new Error("Unexpected table name");
    return [
      table,
      query(
        container,
        `SELECT count(*) || ':' || md5(COALESCE(string_agg(row_to_json(t)::text, '' ORDER BY row_to_json(t)::text), '')) FROM ${table} t`,
      ),
    ];
  });
}
try {
  // These fixtures have no traffic or connected integrations; stop every writer.
  docker([...compose, "stop", "gateway", "panel", "proxy", "control"]);
  stopped = true;
  const before = fingerprints(source);
  const dump = docker([
    "exec",
    source,
    "pg_dump",
    "-U",
    "postgres",
    "-d",
    "crap",
    "-Fc",
    "--schema=affinity_router",
    "--schema=cliproxy",
  ]);
  docker(["network", "create", network]);
  networkCreated = true;
  docker([
    "run",
    "-d",
    "--name",
    target,
    "--network",
    network,
    "--network-alias",
    "postgres",
    "-e",
    "POSTGRES_DB=crap",
    "-e",
    "POSTGRES_PASSWORD_FILE=/run/crap/password",
    "--mount",
    `type=volume,source=${pgSecrets},target=/run/crap,readonly`,
    "--mount",
    `type=volume,source=${pgSecrets},target=/docker-entrypoint-initdb.d,readonly`,
    "postgres:17-bookworm@sha256:639ab7ceb90e13123085b741fb31ef493fba25463002f6da665352e7b534b652",
  ]);
  created.push(target);
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      ready =
        query(
          target,
          "SELECT count(*) FROM pg_namespace WHERE nspname IN ('affinity_router','cliproxy')",
        ) === "2";
    } catch {}
    if (ready) break;
    await delay(500);
  }
  assert.ok(ready, "Restore database did not initialize");
  assert.equal(
    query(
      target,
      "SELECT count(*) FROM pg_tables WHERE schemaname IN ('affinity_router','cliproxy')",
    ),
    "0",
    "Restore destination must be empty",
  );
  docker(
    [
      "exec",
      "-i",
      target,
      "pg_restore",
      "-U",
      "postgres",
      "-d",
      "crap",
      "--clean",
      "--if-exists",
      "--exit-on-error",
    ],
    dump,
  );
  assert.deepEqual(
    fingerprints(target),
    before,
    "Every restored table must match the stopped source",
  );
  docker([
    "run",
    "-d",
    "--name",
    control,
    "--network",
    network,
    "--network-alias",
    "control",
    "--mount",
    `type=volume,source=${controlSecrets},target=/run/crap,readonly`,
    "crap-control:alpha-local",
  ]);
  created.push(control);
  const result = docker([
    "run",
    "--rm",
    "--network",
    network,
    "--mount",
    `type=volume,source=${panelSecrets},target=/run/crap,readonly`,
    "crap-panel:alpha-local",
    "node",
    "deploy/verify-restored.mjs",
  ]);
  process.stdout.write(result);
  console.log(
    `PASS: logical restore into a separate PostgreSQL instance; ${before.length} tables matched exactly.`,
  );
} finally {
  try {
    for (const name of created.reverse()) docker(["rm", "-f", "-v", name]);
    if (networkCreated) docker(["network", "rm", network]);
  } finally {
    if (stopped)
      docker([...compose, "start", "control", "proxy", "gateway", "panel"]);
  }
}
let healthy = false;
for (let i = 0; i < 60; i++) {
  try {
    docker([...compose, "exec", "-T", "panel", "node", "deploy/health.mjs"]);
    healthy = true;
  } catch {}
  if (healthy) break;
  await delay(500);
}
assert.ok(healthy, "Source services did not recover after restart");
console.log(
  "PASS: source stack restarted with its persisted configuration and plugin.",
);
