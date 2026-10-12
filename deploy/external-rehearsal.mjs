import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareExternal, validateDestination } from "./external-database.mjs";
import { privateDirectory } from "../control-panel/database-transfer.mjs";
const source = process.argv[2];
if (!/^crap-(ci|release-rehearsal)(-[a-z0-9]+)*$/.test(source || ""))
  throw new Error("Disposable project required");
const project = `${source}-external`;
const original = [
  "compose",
  "-p",
  source,
  "-f",
  "deploy/compose.legacy-test.yaml",
];
const root = await mkdtemp(path.join(os.tmpdir(), "crap-external-rehearsal-"));
await privateDirectory(root);
let created = false;
function docker(args, input) {
  const result = spawnSync("docker", args, {
    input,
    windowsHide: true,
    maxBuffer: 8 << 20,
  });
  if (result.status !== 0)
    throw new Error(
      "External fixture operation failed; private output withheld.",
    );
  return result.stdout.toString().trim();
}
const sql = (query) =>
  docker(
    [
      "exec",
      "-i",
      `${source}-postgres-1`,
      "psql",
      "-X",
      "-U",
      "postgres",
      "-d",
      "crap",
      "-At",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    query,
  );
assert.equal(
  sql(
    "SELECT (SELECT count(*) FROM cliproxy.auth_store)+(SELECT count(*) FROM affinity_router.usage_events WHERE model <> 'claude-fixture');",
  ),
  "0",
);
assert.equal(
  docker([
    "ps",
    "-aq",
    "--filter",
    `label=com.docker.compose.project=${project}`,
  ]),
  "",
);
const files = path.join(root, "workspace");
const override = path.join(root, "network.json");
await writeFile(
  override,
  JSON.stringify({
    networks: { default: { external: true, name: `${source}_default` } },
  }),
);
const compose = [
  "compose",
  "-p",
  project,
  "-f",
  "deploy/compose.external.yaml",
  "-f",
  override,
];
const prior = process.env.CRAP_EXTERNAL_FILES;
process.env.CRAP_EXTERNAL_FILES = files;
try {
  docker([...original, "stop", "gateway", "panel", "proxy", "control"]);
  docker([
    "exec",
    "--user",
    "postgres",
    `${source}-postgres-1`,
    "openssl",
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "/var/lib/postgresql/data/server.key",
    "-out",
    "/var/lib/postgresql/data/server.crt",
    "-subj",
    "/CN=postgres",
    "-addext",
    "subjectAltName=DNS:postgres",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-days",
    "2",
  ]);
  docker([
    "exec",
    "--user",
    "postgres",
    `${source}-postgres-1`,
    "chmod",
    "600",
    "/var/lib/postgresql/data/server.key",
  ]);
  sql("ALTER SYSTEM SET ssl = on;");
  sql("SELECT pg_reload_conf();");
  const ca = docker([
    "exec",
    `${source}-postgres-1`,
    "cat",
    "/var/lib/postgresql/data/server.crt",
  ]);
  const caFile = path.join(root, "ca.crt");
  await writeFile(caFile, ca);
  assert.throws(() =>
    validateDestination(
      { host: "postgres\nINJECT=1", database: "external_fixture" },
      ca,
    ),
  );
  assert.throws(() =>
    validateDestination(
      { host: "postgres", database: "crap'; DROP DATABASE crap;--" },
      ca,
    ),
  );
  await prepareExternal(
    { host: "postgres", database: "external_fixture", caFile },
    files,
  );
  await assert.rejects(
    prepareExternal(
      { host: "postgres", database: "external_fixture", caFile },
      files,
    ),
    /EEXIST/,
  );
  sql("CREATE DATABASE external_fixture;");
  const provision = await readFile(path.join(files, "provision.sql"));
  docker(
    [
      "exec",
      "-i",
      `${source}-postgres-1`,
      "psql",
      "-X",
      "-U",
      "postgres",
      "-d",
      "external_fixture",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    provision,
  );
  assert.throws(() =>
    docker(
      [
        "exec",
        "-i",
        `${source}-postgres-1`,
        "psql",
        "-X",
        "-U",
        "postgres",
        "-d",
        "external_fixture",
        "-v",
        "ON_ERROR_STOP=1",
      ],
      provision,
    ),
  );
  created = true;
  docker([...compose, "up", "-d", "--wait", "--wait-timeout", "180"]);
  docker([
    ...compose,
    "exec",
    "-T",
    "-e",
    "CRAP_REHEARSAL=1",
    "panel",
    "node",
    "deploy/smoke.mjs",
  ]);
  const { roles } = JSON.parse(
    await readFile(path.join(files, "destination.json")),
  );
  const check = (query) =>
    docker(
      [
        "exec",
        "-i",
        `${source}-postgres-1`,
        "psql",
        "-X",
        "-U",
        "postgres",
        "-d",
        "external_fixture",
        "-At",
        "-v",
        "ON_ERROR_STOP=1",
      ],
      query,
    );
  assert.equal(
    check(
      `SELECT has_database_privilege('${roles.control}',current_database(),'CREATE'),has_schema_privilege('${roles.control}','affinity_router','CREATE'),has_table_privilege('${roles.control}','affinity_router.schema_migrations','INSERT');`,
    ),
    "f|f|f",
  );
  assert.equal(
    check(
      `SELECT count(*)>0 FROM pg_stat_ssl s JOIN pg_stat_activity a USING(pid) WHERE a.usename='${roles.control}' AND s.ssl;`,
    ),
    "t",
  );
  assert.throws(() =>
    check(
      `SET ROLE ${roles.control}; DROP TABLE affinity_router.usage_events;`,
    ),
  );
  assert.throws(() =>
    check(
      `SET ROLE ${roles.proxy}; SELECT * FROM affinity_router.schema_migrations;`,
    ),
  );
  assert.throws(() =>
    check(`SET ROLE ${roles.proxy}; DROP TABLE cliproxy.auth_store;`),
  );
  // A wrong hostname must fail at TLS, with no fallback to unverified transport.
  docker([
    ...compose,
    "exec",
    "-T",
    "control",
    "crap-entrypoint",
    "affinity-db",
    "prune",
  ]);
  assert.throws(() =>
    docker([
      ...compose,
      "exec",
      "-T",
      "control",
      "crap-entrypoint",
      "sh",
      "-c",
      `AFFINITY_DATABASE_URL="$(printf '%s' "$AFFINITY_DATABASE_URL" | sed 's/@postgres:/@${source}-postgres-1:/')"; export AFFINITY_DATABASE_URL; exec affinity-db prune`,
    ]),
  );
  console.log(
    "PASS: external PostgreSQL over verified TLS, separate migration/runtime roles, occupied-target refusal, full packaged mock inference/accounting and runtime DDL isolation.",
  );
  // Exercise the same private handoff files produced by restore-database.mjs.
  docker([...compose, "stop", "gateway", "panel", "proxy", "control"]);
  const dump = docker([
    "exec",
    `${source}-postgres-1`,
    "pg_dump",
    "-U",
    "postgres",
    "-d",
    "external_fixture",
    "--no-owner",
    "--no-acl",
    "--schema=affinity_router",
    "--schema=cliproxy",
  ]);
  sql("CREATE DATABASE import_fixture;");
  docker(
    [
      "exec",
      "-i",
      `${source}-postgres-1`,
      "psql",
      "-X",
      "-U",
      "postgres",
      "-d",
      "import_fixture",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    dump,
  );
  const tables = check(
    "SELECT schemaname||'.'||tablename FROM pg_tables WHERE schemaname IN ('affinity_router','cliproxy') ORDER BY 1;",
  ).split("\n");
  const counts = {};
  for (const table of tables) {
    assert.match(table, /^(affinity_router|cliproxy)\.[a-z_]+$/);
    counts[table] = check(`SELECT count(*) FROM ${table};`);
  }
  const handoff = path.join(root, "handoff");
  await (await import("node:fs/promises")).mkdir(handoff);
  await writeFile(
    path.join(handoff, "handoff.json"),
    JSON.stringify({
      version: 1,
      schemas: ["affinity_router", "cliproxy"],
      counts,
    }),
  );
  const panelEnv = Object.fromEntries(
    (await readFile(path.join(files, "panel/service.env"), "utf8"))
      .trim()
      .split("\n")
      .map((x) => [x.slice(0, x.indexOf("=")), x.slice(x.indexOf("=") + 1)]),
  );
  await writeFile(
    path.join(handoff, "deployment.env"),
    `AFFINITY_ID_KEY=${panelEnv.AFFINITY_ID_KEY}\nAFFINITY_CONTROL_TOKEN=${panelEnv.AFFINITY_CONTROL_TOKEN}\nPANEL_MANAGEMENT_KEY=${panelEnv.MANAGEMENT_KEY}\n`,
  );
  const importedFiles = path.join(root, "imported");
  await prepareExternal(
    {
      host: "postgres",
      database: "import_fixture",
      caFile,
      importDirectory: handoff,
    },
    importedFiles,
  );
  docker(
    [
      "exec",
      "-i",
      `${source}-postgres-1`,
      "psql",
      "-X",
      "-U",
      "postgres",
      "-d",
      "import_fixture",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    await readFile(path.join(importedFiles, "provision.sql")),
  );
  // Reuse only this disposable project's now-stopped containers/volumes, after
  // removing them. The source and restored databases remain separate.
  docker([...compose, "down", "--volumes"]);
  created = false;
  process.env.CRAP_EXTERNAL_FILES = importedFiles;
  created = true;
  docker([...compose, "up", "-d", "--wait", "--wait-timeout", "180"]);
  docker([
    ...compose,
    "exec",
    "-T",
    "panel",
    "node",
    "deploy/verify-restored.mjs",
  ]);
  docker([
    ...compose,
    "exec",
    "-T",
    "-e",
    "CRAP_REHEARSAL=1",
    "panel",
    "node",
    "deploy/smoke.mjs",
  ]);
  console.log(
    "PASS: restored handoff preserves ledger and encryption identity, adopts runtime roles, adapts deployment paths and boots with exact trace coverage.",
  );
} finally {
  try {
    if (created) docker([...compose, "down", "--volumes"]);
  } finally {
    docker([...original, "start", "control", "proxy", "gateway", "panel"]);
    if (prior === undefined) delete process.env.CRAP_EXTERNAL_FILES;
    else process.env.CRAP_EXTERNAL_FILES = prior;
    if (
      path.dirname(root) !== os.tmpdir() ||
      !path.basename(root).startsWith("crap-external-rehearsal-")
    )
      throw new Error("Unsafe fixture cleanup path");
    await rm(root, { recursive: true, force: true });
  }
}
