import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, rm, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { runPrivate } from "./database.mjs";
import { secretCodec } from "./integrations.mjs";
import {
  fromDSN,
  privateDirectory,
  postgresTools,
  sealBundle,
  unsealBundle,
  writeDeployment,
} from "./database-transfer.mjs";

// Explicitly opt-in. Creates and drops only fresh, randomly named test databases.
test(
  "PostgreSQL 17 direct and encrypted portable transfer",
  { skip: process.env.CRAP_TEST_TRANSFER !== "1" },
  async () => {
    const root = fileURLToPath(new URL("../", import.meta.url));
    const suffix = randomUUID().replaceAll("-", "");
    const names = ["source", "direct", "portable"].map(
      (n) => `crap_transfer_test_${n}_${suffix}`,
    );
    const base = path.join(root, ".local-panel", `transfer-test-${suffix}`);
    await privateDirectory(base);
    const settings = await readFile(
      path.join(root, ".local-panel/affinity.env"),
      "utf8",
    );
    const source = fromDSN(
      settings
        .split(/\r?\n/)
        .find((x) => x.startsWith("AFFINITY_DATABASE_URL="))
        .slice("AFFINITY_DATABASE_URL=".length),
    );
    const container = "cliproxy-affinity-postgres-1";
    const sql = (database, query) =>
      runPrivate("docker", [
        "exec",
        container,
        "psql",
        "-X",
        "-A",
        "-t",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        source.user,
        "-d",
        database,
        "-c",
        query,
      ]);
    const created = [];
    try {
      for (const name of names) {
        await sql("postgres", `CREATE DATABASE ${name}`);
        created.push(name);
      }
      await sql(
        names[0],
        "CREATE SCHEMA affinity_router; CREATE SCHEMA cliproxy; CREATE TABLE affinity_router.schema_migrations(name text PRIMARY KEY,checksum text NOT NULL); CREATE TABLE cliproxy.auth_store(id text PRIMARY KEY, content jsonb NOT NULL); CREATE TABLE cliproxy.config_store(id text PRIMARY KEY,content text NOT NULL);",
      );
      for (const filename of [
        "001_usage.sql",
        "002_control.sql",
        "003_costs.sql",
        "004_cache_duration.sql",
        "005_integrations.sql",
      ]) {
        const body = await readFile(
          path.join(root, "affinity-router/storage/migrations", filename),
          "utf8",
        );
        await sql(names[0], body);
        await sql(
          names[0],
          `INSERT INTO affinity_router.schema_migrations VALUES ('migrations/${filename}','${createHash("sha256").update(body).digest("hex")}')`,
        );
      }
      await sql(
        names[0],
        `INSERT INTO cliproxy.auth_store VALUES ('fixture-account','{"refresh_token":"fixture-only-token","disabled":false}'); INSERT INTO cliproxy.config_store VALUES ('config','config-version: 8'); INSERT INTO affinity_router.usage_events(event_id,request_id,replica_id,account_id,client_id,provider,model,started_at,finished_at,outcome,quality) VALUES ('00000000-0000-0000-0000-000000000001','request','replica','account','client','claude','fixture',now(),now(),'succeeded','missing');`,
      );
      const pg = postgresTools(base),
        src = { ...source, database: names[0] },
        dst = { ...source, database: names[1] };
      const integrationFixture={telegram:{token:"fixture-bot-token",enabled:false}};
      const integrationCipher=secretCodec("ab".repeat(32)).seal(integrationFixture);
      await sql(names[0],`UPDATE affinity_router.integrations SET encrypted='${integrationCipher}' WHERE singleton`);
      const counts = await pg.inspect(src);
      await pg.dump(src);
      assert.equal((await pg.restore(dst, counts)).verified, true);
      const dump = path.join(base, "workspace.dump"),
        bundle = path.join(base, "workspace.crapdb");
      const manifest = {
        version: 1,
        schemas: ["affinity_router", "cliproxy"],
        mode: "rehearsal",
        createdAt: new Date().toISOString(),
        counts,
        secrets: {
          AFFINITY_ID_KEY: "ab".repeat(32),
          AFFINITY_CONTROL_TOKEN: "fixture-control-token",
          PANEL_MANAGEMENT_KEY: "fixture-management-token",
        },
        sha256: createHash("sha256")
          .update(await readFile(dump))
          .digest("hex"),
      };
      await sealBundle(dump, bundle, manifest, "fixture-encryption-passphrase");
      const restoredDir = path.join(base, "restored");
      await mkdir(restoredDir);
      const portable = await unsealBundle(
        bundle,
        restoredDir,
        "fixture-encryption-passphrase",
      );
      const portableTarget = { ...source, database: names[2] };
      await postgresTools(restoredDir).restore(
        portableTarget,
        portable.manifest.counts,
      );
      await writeDeployment(
        restoredDir,
        portableTarget,
        portable.manifest.secrets,
        portable.manifest,
      );
      for (const name of names.slice(1)) {
        const restoredCipher=(await sql(name,"SELECT encrypted FROM affinity_router.integrations WHERE singleton")).trim();
        assert.deepEqual(secretCodec(portable.manifest.secrets.AFFINITY_ID_KEY).open(restoredCipher),integrationFixture);
        assert.equal(
          (
            await sql(
              name,
              "SELECT content->>'refresh_token' FROM cliproxy.auth_store WHERE id='fixture-account'",
            )
          ).trim(),
          "fixture-only-token",
        );
        assert.equal(
          (
            await sql(
              name,
              "SELECT count(*) FROM affinity_router.schema_migrations",
            )
          ).trim(),
          "5",
        );
        assert.equal(
          (
            await sql(
              name,
              "SELECT request_id FROM affinity_router.usage_events",
            )
          ).trim(),
          "request",
        );
      }
      await assert.rejects(pg.restore(dst, counts), /already contains/);
    } finally {
      for (const name of created) {
        assert.match(
          name,
          /^crap_transfer_test_(source|direct|portable)_[a-f0-9]{32}$/,
        );
        await sql("postgres", `DROP DATABASE ${name}`);
      }
      const resolved = path.resolve(base);
      assert.ok(
        resolved.startsWith(path.resolve(root, ".local-panel") + path.sep),
      );
      await rm(resolved, { recursive: true, force: true });
    }
  },
);
