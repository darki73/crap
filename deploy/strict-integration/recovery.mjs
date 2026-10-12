// Only called by the isolated fixture runner. Source and target have no internet.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { workspaceBackup } from "../workspace-backup.mjs";

export async function recovery(run, sourceCompose) {
  const source = "crap-strict-integration";
  const target = "crap-strict-integration-restored";
  const targetCompose = sourceCompose.map((v) => (v === source ? target : v));
  const query = async (project, sql) =>
    (
      await run([
        "exec",
        `${project}-postgres-1`,
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
      ])
    ).trim();
  // Refuse any non-fixture account, even in the reserved test project.
  assert.equal(
    await query(
      source,
      "SELECT count(*) FROM cliproxy.auth_store WHERE id NOT IN ('fixture-a.json','fixture-b.json')",
    ),
    "0",
  );
  if ((await run([...targetCompose, "ps", "-aq"])).trim())
    throw new Error("Restore fixture exists; inspect it first.");
  const dir = await mkdtemp(path.join(tmpdir(), "crap-strict-recovery-"));
  const file = path.join(dir, "workspace.crap");
  const imagesFile = path.join(dir, "compose.images.json");
  const services = Object.fromEntries(
    ["control", "gateway", "panel"].map((name) => [
      name,
      { image: `crap-${name}:alpha-local`, pull_policy: "never" },
    ]),
  );
  services.proxy = { image: JSON.parse(await run(["inspect", `${source}-proxy-1`]))[0].Config.Image, pull_policy: "never" };
  services.bootstrap = services.panel;
  services.migrate = services.control;
  await writeFile(imagesFile, JSON.stringify({ services }));
  const password = "strict-fixture-backup-passphrase";
  let restored = false;
  const tables = [
    "usage_events",
    "strict_families",
    "strict_sessions",
    "strict_pool",
    "schema_migrations",
  ];
  const fingerprint = async (project) =>
    Promise.all(
      tables.map((table) =>
        query(
          project,
          `SELECT count(*)||':'||COALESCE(md5(string_agg(row_to_json(t)::text,',' ORDER BY row_to_json(t)::text)),'empty') FROM affinity_router.${table} t`,
        ),
      ),
    );
  const bindings = (project) =>
    query(
      project,
      "SELECT COALESCE(json_agg(t ORDER BY id)::text,'[]') FROM (SELECT id,account_id FROM affinity_router.strict_families) t",
    );
  try {
    // Include panel in the packaged backup and verify the public health command.
    await run([
      ...sourceCompose,
      "up",
      "-d",
      "--wait",
      "--wait-timeout",
      "180",
      "panel",
    ]);
    await workspaceBackup({
      action: "backup",
      project: source,
      file,
      password,
      keepStopped: true,
      imagesFile,
    });
    const before = await fingerprint(source);
    const boundBefore = await bindings(source);
    await workspaceBackup({
      action: "restore",
      project: target,
      imagesFile,
      file,
      password,
    });
    restored = true;
    // The fixture also makes the gateway's normally internet-capable network
    // internal. Remove stopped restore helpers (NOT volumes) before applying
    // that topology change, avoiding stale Docker DNS aliases on recreation.
    await run(["compose", "-p", target, "-f", "deploy/compose.yaml", "down"]);
    // Restore leaves all inference services stopped; start with the SAME strict
    // entrypoint and only fixture-specific CA/provider networking added.
    await run([
      ...targetCompose,
      "up",
      "-d",
      "--wait",
      "--wait-timeout",
      "180",
      "panel",
      "gateway",
      "provider",
    ]);
    assert.deepEqual(
      await fingerprint(target),
      before,
      "restored ledger/family bindings differ",
    );
    const id = (await run([...targetCompose, "ps", "-q", "proxy"])).trim();
    const proxy = JSON.parse(await run(["inspect", id]))[0];
    const networks = Object.values(proxy.NetworkSettings.Networks);
    assert.equal(networks.length, 1);
    assert.equal(
      JSON.parse(await run(["network", "inspect", networks[0].NetworkID]))[0]
        .Internal,
      true,
    );
    assert.equal(
      Object.values(proxy.NetworkSettings.Ports ?? {}).some((v) => v?.length),
      false,
    );
    await run([
      ...targetCompose,
      "exec",
      "-T",
      "panel",
      "node",
      "deploy/health.mjs",
    ]);
    await run(
      [
        ...targetCompose,
        "run",
        "--rm",
        "--no-deps",
        "test",
        "node",
        "restored.mjs",
      ],
      true,
    );
    const after = await fingerprint(target);
    assert.deepEqual(
      after.slice(2, 4),
      before.slice(2, 4),
      "resumed conversation must retain its recovered account binding",
    );
    // updated_at is expected to advance when the retained family is used.
    assert.equal(
      await bindings(target),
      boundBefore,
      "resuming must retain the same account",
    );
    console.log(
      "PASS: encrypted strict restore preserves ledger, identities and permanent families; isolation and resumed inference survive recovery.",
    );
  } finally {
    if (restored) {
      await run([...targetCompose, "logs", "--no-color"]);
      await run([...targetCompose, "down", "--volumes", "--remove-orphans"]);
    }
    if (
      path.dirname(dir) !== tmpdir() ||
      !path.basename(dir).startsWith("crap-strict-recovery-")
    )
      throw new Error("Unsafe fixture staging cleanup");
    await rm(dir, { recursive: true, force: true });
  }
}
