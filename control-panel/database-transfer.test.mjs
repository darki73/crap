import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  mkdir,
  rm,
  access,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { request } from "node:http";
import { createPanelServer } from "./server.mjs";
import {
  connection,
  sealBundle,
  unsealBundle,
  postgresTools,
  createDatabaseTransfer,
} from "./database-transfer.mjs";

const passphrase = "test-only-long-passphrase";
const target = {
  host: "127.0.0.1",
  port: "55432",
  database: "transfer_test",
  user: "affinity",
  password: "secret-fixture",
  sslmode: "disable",
};
const secrets = {
  AFFINITY_ID_KEY: "ab".repeat(32),
  AFFINITY_CONTROL_TOKEN: "test-control-token",
  PANEL_MANAGEMENT_KEY: "test-management-token",
};
const counts = {
  "affinity_router.usage_events": "3",
  "cliproxy.auth_store": "2",
};
const bytes = Buffer.from("fixture PostgreSQL archive; secret OAuth data");
const manifest = {
  version: 1,
  schemas: ["affinity_router", "cliproxy"],
  mode: "rehearsal",
  counts,
  secrets,
  sha256: createHash("sha256").update(bytes).digest("hex"),
};
async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "crap-transfer-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("encrypted bundle preserves schemas and identity keys without plaintext secrets", async (t) => {
  const dir = await fixture(t),
    dump = path.join(dir, "fixture.dump"),
    bundle = path.join(dir, "backup.crapdb");
  await writeFile(dump, bytes);
  await sealBundle(dump, bundle, manifest, passphrase);
  const encrypted = await readFile(bundle);
  assert.equal(encrypted.includes(bytes), false);
  assert.equal(encrypted.includes(Buffer.from(secrets.AFFINITY_ID_KEY)), false);
  const out = path.join(dir, "restore");
  await mkdir(out);
  const restored = await unsealBundle(bundle, out, passphrase);
  assert.deepEqual(restored.manifest, manifest);
  assert.deepEqual(await readFile(restored.dump), bytes);
});
test("wrong password and tampering never produce a restorable archive", async (t) => {
  const dir = await fixture(t),
    dump = path.join(dir, "fixture.dump"),
    bundle = path.join(dir, "backup.crapdb");
  await writeFile(dump, bytes);
  await sealBundle(dump, bundle, manifest, passphrase);
  for (const tamper of [false, true]) {
    const out = path.join(dir, String(tamper));
    await mkdir(out);
    if (tamper) {
      const b = await readFile(bundle);
      b[50] ^= 1;
      await writeFile(bundle, b);
    }
    await assert.rejects(
      unsealBundle(
        bundle,
        out,
        tamper ? passphrase : "incorrect-long-passphrase",
      ),
      /Cannot unlock/,
    );
    await assert.rejects(access(path.join(out, "workspace.dump")));
    await assert.rejects(access(path.join(out, "authenticated.payload")));
  }
});
test("connection validation prevents env-file and connection-string injection", () => {
  assert.deepEqual(connection(target), { ...target, ca: undefined });
  for (const input of [
    { ...target, password: "x\nPGHOST=elsewhere" },
    { ...target, database: "postgres://elsewhere" },
    { ...target, host: "external.example" },
    { ...target, sslmode: "verify-full", ca: "not a certificate" },
  ])
    assert.throws(() => connection(input));
});
test("occupied target is refused without invoking restore", async (t) => {
  const dir = await fixture(t);
  const calls = [];
  const pg = postgresTools(dir, async (command, args) => {
    calls.push(args);
    if (args.includes("SHOW server_version_num")) return "170005";
    return '["cliproxy"]';
  });
  await assert.rejects(pg.restore(target, counts), /already contains/);
  assert.equal(
    calls.some((x) => x.includes("pg_restore")),
    false,
  );
});

for (const mode of ["rehearsal", "cutover", "failure"]) {
  test(`direct ${mode} transfer verifies data and enforces source lifecycle`, async (t) => {
    const root = await fixture(t);
    await mkdir(path.join(root, ".local-panel/database"), { recursive: true });
    await writeFile(
      path.join(root, ".local-panel/affinity.env"),
      `AFFINITY_DATABASE_URL=postgresql://affinity:source-secret@127.0.0.1:55432/affinity?sslmode=disable\nAFFINITY_CONTROL_URL=http://127.0.0.1:8318\nAFFINITY_CONTROL_TOKEN=${secrets.AFFINITY_CONTROL_TOKEN}\nAFFINITY_ID_KEY=${secrets.AFFINITY_ID_KEY}\n`,
    );
    await writeFile(
      path.join(root, ".local-panel/.env"),
      `PANEL_MANAGEMENT_KEY=${secrets.PANEL_MANAGEMENT_KEY}\n`,
    );
    let paused = false,
      stopped = false,
      restored = false;
    const calls = [];
    const run = async (command, args) => {
      calls.push([command, args]);
      if (command === "icacls") return "";
      if (args[0] === "inspect")
        return JSON.stringify([
          {
            State: { Running: true },
            Config: {
              Labels: { "com.docker.compose.project": "cliproxy-panel" },
              Env: [
                "PGSTORE_DSN=postgresql://affinity:source-secret@host.docker.internal:55432/affinity?sslmode=disable",
              ],
            },
          },
        ]);
      if (args[0] === "stop") {
        stopped = true;
        return "";
      }
      if (args[0] === "start") {
        stopped = false;
        return "";
      }
      if (args[0] === "cp") {
        await mkdir(args.at(-1));
        return "";
      }
      const env = await readFile(args[args.indexOf("--env-file") + 1], "utf8");
      const source = env.includes("PGDATABASE=affinity\n");
      if (args.includes("SHOW server_version_num")) return "170005";
      if (args.some((x) => x.includes("json_agg(nspname)")))
        return source || restored ? '["affinity_router","cliproxy"]' : "[]";
      if (args.some((x) => x.includes("FROM pg_tables")))
        return JSON.stringify(Object.keys(counts));
      if (args.at(-1).startsWith("SELECT count"))
        return args.at(-1).includes("usage_events") ? "3" : "2";
      const mount = args[args.indexOf("--mount") + 1];
      const dir = mount.slice(
        "type=bind,source=".length,
        -",target=/work".length,
      );
      if (args.includes("pg_dump")) {
        assert.equal(paused, true);
        assert.equal(stopped, true);
        await writeFile(path.join(dir, "workspace.dump"), bytes);
        return "";
      }
      if (args.includes("pg_restore")) {
        if (mode === "failure")
          throw new Error("TOP_SECRET fixture restore error");
        assert.ok(args.includes("--single-transaction"));
        assert.ok(args.includes("--no-owner"));
        assert.equal(args.includes("--clean"), false);
        restored = true;
        return "";
      }
      throw new Error("Unexpected command");
    };
    const fetcher = async (url, opts) => {
      if (opts.method === "POST") paused = JSON.parse(opts.body).paused;
      return { ok: true, json: async () => ({ paused }) };
    };
    const manager = createDatabaseTransfer({ root, run, fetcher });
    await manager.start({
      action: "direct",
      mode: mode === "failure" ? "rehearsal" : mode,
      target,
      passphrase,
      confirm: "transfer-workspace",
    });
    await manager.wait();
    const state = await manager.status();
    if (mode === "failure") {
      assert.equal(state.phase, "attention");
      assert.equal(state.sourcePaused, true);
      assert.equal(paused, true);
      assert.equal(stopped, true);
      assert.equal(JSON.stringify(state).includes("TOP_SECRET"), false);
      await manager.resume("destination-is-stopped");
      assert.equal(stopped, false);
      return;
    }
    assert.equal(state.phase, "complete", state.error);
    assert.equal(state.verified, true);
    assert.equal(paused, mode === "cutover");
    assert.equal(stopped, mode === "cutover");
    assert.equal(state.sourcePaused, mode === "cutover");
    assert.equal(JSON.stringify(state).includes("source-secret"), false);
    assert.equal(JSON.stringify(calls).includes("source-secret"), false);
    assert.equal(JSON.stringify(calls).includes(target.password), false);
    assert.ok((await readFile(await manager.download())).length > 0);
    if (mode === "cutover") {
      const backup = await manager.download();
      const { upload } = await manager.upload(createReadStream(backup));
      restored = false;
      await manager.start({
        action: "restore",
        mode: "rehearsal",
        target,
        passphrase,
        upload,
        confirm: "transfer-workspace",
      });
      await manager.wait();
      const imported = await manager.status();
      assert.equal(imported.phase, "complete", imported.error);
      assert.equal(imported.sourcePaused, true);
      assert.equal(imported.mode, "cutover");
      await assert.rejects(manager.resume(""), /Confirm/);
      await manager.resume("destination-is-stopped");
      assert.equal(paused, false);
      assert.equal(stopped, false);
    }
  });
}

test("transfer routes enforce the local panel boundary, route allowlist and body limit", async () => {
  let starts = 0,
    uploads = 0;
  const server = createPanelServer({
    upstream: "http://127.0.0.1:1",
    managementKey: "fixture",
    origins: ["http://panel.test"],
    databaseTransfer: {
      status: async () => ({ phase: "idle" }),
      start: async () => {
        starts++;
        return { phase: "checking" };
      },
      upload: async () => {
        uploads++;
        return { upload: "fixture" };
      },
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const call = (endpoint, body, headers = {}) =>
    new Promise((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: server.address().port,
          path: `/api/database/transfer${endpoint}`,
          method: "POST",
          headers: { Host: "panel.test", ...headers },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  try {
    assert.equal(await call("/start", "{}"), 403);
    assert.equal(
      await call("/upload", "file", {
        "X-Panel-Client": "cliproxy-panel",
        Origin: "https://external.example",
      }),
      403,
    );
    assert.equal(starts + uploads, 0);
    const headers = { "X-Panel-Client": "cliproxy-panel" };
    assert.equal(await call("/start", "x".repeat(100001), headers), 413);
    assert.equal(await call("/start", "{", headers), 409);
    assert.equal(await call("/arbitrary", "{}", headers), 404);
    assert.equal(starts, 0);
    assert.equal(await call("/start", "{}", headers), 202);
    assert.equal(starts, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
