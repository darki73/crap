import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { localDatabaseURL, createLocalDatabaseManager } from "./database.mjs";
import { createPanelServer } from "./server.mjs";

function fetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      url,
      { method: options.method || "GET", headers: options.headers },
      (response) => {
        response.resume();
        response.on("end", () => resolve({ status: response.statusCode }));
      },
    );
    request.on("error", reject);
    request.end(options.body);
  });
}

test("local adapter preserves credentials but changes only the Docker host", () => {
  const original =
    "postgres://user:sample-password@127.0.0.1:55432/affinity?sslmode=disable";
  const target = new URL(localDatabaseURL(original, true));
  assert.equal(target.hostname, "host.docker.internal");
  assert.equal(target.password, "sample-password");
  assert.equal(target.pathname, "/affinity");
});
test("local adapter rejects other targets without returning credentials", () => {
  for (const url of [
    "not-a-url-secret",
    "postgres://user:secret@remote:55432/affinity?sslmode=disable",
    "postgres://user:secret@localhost:5432/production?sslmode=disable",
  ]) {
    assert.throws(
      () => localDatabaseURL(url),
      (error) => !error.message.includes("secret"),
    );
  }
});
test("database routes require the panel boundary and explicit migration confirmation", async () => {
  let applies = 0;
  const server = createPanelServer({
    upstream: "http://127.0.0.1:1",
    managementKey: "test",
    origins: ["http://panel.test"],
    databaseManager: {
      status: async () => ({ phase: "idle" }),
      check: async () => ({ canApply: true }),
      apply: async () => {
        applies++;
        return { phase: "checking" };
      },
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/database`;
  const headers = { Host: "panel.test", "X-Panel-Client": "cliproxy-panel" };
  try {
    assert.equal(
      (
        await fetch(base + "/apply", {
          method: "POST",
          headers: { Host: "panel.test" },
          body: JSON.stringify({ confirm: "migrate-local-proxy" }),
        })
      ).status,
      403,
    );
    assert.equal(
      (await fetch(base + "/apply", { method: "POST", headers, body: "{}" }))
        .status,
      400,
    );
    assert.equal(applies, 0);
    assert.equal(
      (
        await fetch(base + "/apply", {
          method: "POST",
          headers,
          body: JSON.stringify({ confirm: "migrate-local-proxy" }),
        })
      ).status,
      202,
    );
    assert.equal(applies, 1);
    assert.equal(
      (await fetch(base + "/arbitrary", { method: "POST", headers })).status,
      404,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

for (const failure of ["import", "restart", null]) {
  test(`migration recovery boundary: ${failure || "success"}`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "crap-db-test-"));
    const calls = [];
    let postgres = false;
    await mkdir(path.join(root, ".local-panel/runtime"), { recursive: true });
    await writeFile(
      path.join(root, ".local-panel/runtime/config.yaml"),
      "config-version: 8\n",
    );
    await writeFile(
      path.join(root, ".local-panel/affinity.env"),
      "AFFINITY_DATABASE_URL=postgres://user:example@localhost:55432/affinity?sslmode=disable\nAFFINITY_CONTROL_URL=http://localhost:8318\n",
    );
    const manager = createLocalDatabaseManager({
      root,
      managementKey: "test",
      run: async (command, args) => {
        if (command !== "docker") return "";
        calls.push(args);
        if (args[0] === "inspect")
          return JSON.stringify([
            {
              Config: {
                Labels: {
                  "com.docker.compose.project": "cliproxy-panel",
                  "com.docker.compose.service": "proxy",
                },
                Env: [],
              },
              Mounts: [{ Destination: "/root/.cli-proxy-api", Type: "volume" }],
            },
          ]);
        if (
          args[0] === "compose" &&
          args.some((arg) => arg.endsWith("compose.json"))
        ) {
          postgres = true;
          if (failure === "restart") throw new Error("Restart failed");
        }
        return "";
      },
      databaseHelper: async (action) => {
        if (action === "import" && failure === "import")
          throw new Error("Import failed");
        return {
          database: "affinity",
          history: 5,
          credentials: 1,
          proxySchema: false,
        };
      },
      fetcher: async () => ({
        ok: true,
        json: async () => ({
          files: [
            {
              name: "account.json",
              path: postgres
                ? "/var/lib/cliproxy-pg/auths/account.json"
                : "/root/.cli-proxy-api/account.json",
            },
          ],
        }),
      }),
    });
    try {
      await manager.apply();
      await manager.wait();
      const status = await manager.status();
      assert.equal(status.running, false);
      assert.equal(
        status.phase,
        failure === "import"
          ? "failed"
          : failure === "restart"
            ? "attention"
            : "active",
      );
      const restores = calls.filter(
        (args) =>
          args[0] === "compose" &&
          !args.some((arg) => arg.endsWith("compose.json")),
      );
      assert.equal(restores.length, failure === "import" ? 1 : 0);
      assert.ok(!JSON.stringify(status).includes("postgres://"));
      if (!failure) await assert.rejects(manager.apply(), /already active/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
