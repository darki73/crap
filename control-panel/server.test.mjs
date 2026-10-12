import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createPanelServer } from "./server.mjs";
import { normalizeClaudeUsage } from "./account-usage.mjs";
import { normalizeCodexUsage, normalizePluginUsage } from "./account-usage.mjs";
import { allowsManagementRoute } from "./management-routes.mjs";

test("strict panel checks gateway readiness separately from the management relay", async () => {
  const managementCalls = [],
    gatewayCalls = [];
  let ready = true;
  const management = http.createServer((req, res) => {
    managementCalls.push({ url: req.url, auth: req.headers.authorization });
    res.writeHead(req.url.startsWith("/v8/management/") ? 200 : 404, {
      "Content-Type": "application/json",
    });
    res.end(JSON.stringify({ access: {}, files: [] }));
  });
  const gateway = http.createServer((req, res) => {
    gatewayCalls.push({ url: req.url, auth: req.headers.authorization });
    res.writeHead(ready ? 200 : 503);
    res.end(ready ? "" : "private readiness details");
  });
  const upstream = await listen(management);
  const inferenceURL = await listen(gateway);
  const panel = createPanelServer({
    upstream,
    inferenceURL,
    managementKey: "private-management",
    origins: ["http://localhost:3000"],
  });
  const address = await listen(panel);
  const headers = {
    Host: "localhost:3000",
    "X-Panel-Client": "cliproxy-panel",
  };
  try {
    for (const endpoint of ["config", "credentials", "health"]) {
      const response = await fetch(`${address}/api/${endpoint}`, { headers });
      assert.equal(response.status, 200);
      const body = await response.json();
      if (endpoint === "health") assert.deepEqual(body, { status: "ok" });
    }
    assert.deepEqual(managementCalls, [
      { url: "/v8/management/config", auth: "Bearer private-management" },
      { url: "/v8/management/credentials", auth: "Bearer private-management" },
    ]);
    assert.deepEqual(gatewayCalls, [{ url: "/readyz", auth: undefined }]);
    ready = false;
    const unavailable = await fetch(`${address}/api/health`, { headers });
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), {
      error: "The proxy gateway is not ready.",
    });
    const denied = await fetch(`${address}/api/health`, {
      headers: { Host: "localhost:3000" },
    });
    assert.equal(denied.status, 403);
    assert.equal(gatewayCalls.length, 2);
  } finally {
    await close(panel);
    await close(gateway);
    await close(management);
  }
});

test("personalized downloads require the panel boundary; CLI redemption is scoped and never redirects", async () => {
  const calls = [];
  const panel = createPanelServer({
    upstream: "http://localhost:1",
    managementKey: "private-management",
    origins: ["http://localhost:3000"],
    clientEnrollment: {
      list: async () => [],
      create: async (input, origin) => {
        calls.push({ input, origin });
        return { content: "personalized-fixture" };
      },
      redeem: async (token) => {
        calls.push(token);
        return "fixture-credential-response";
      },
      remove: async (id) => calls.push(id),
    },
  });
  const address = await listen(panel),
    headers = {
      Host: "localhost:3000",
      "X-Panel-Client": "cliproxy-panel",
      Origin: "http://localhost:3000",
    };
  try {
    assert.equal(
      (
        await fetch(address + "/api/client-enrollment", {
          method: "POST",
          headers: { Host: "localhost:3000" },
          body: "{}",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(address + "/api/client-enrollment", {
          method: "POST",
          headers: { ...headers, Origin: "https://evil.example" },
          body: "{}",
        })
      ).status,
      403,
    );
    const r = await fetch(address + "/api/client-enrollment", {
      method: "POST",
      headers,
      body: '{"name":"Laptop"}',
    });
    assert.equal(r.status, 201);
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.deepEqual(calls[0], {
      input: { name: "Laptop" },
      origin: "http://localhost:3000",
    });
    assert.equal(
      (
        await fetch(address + "/client-setup/redeem", {
          method: "POST",
          headers,
          body: "x",
        })
      ).status,
      403,
    );
    const redeem = await fetch(address + "/client-setup/redeem", {
      method: "POST",
      headers: { Host: "localhost:3000" },
      body: "a".repeat(64),
    });
    assert.equal(redeem.status, 200);
    assert.equal(redeem.headers.get("cache-control"), "no-store");
    assert.equal(await redeem.text(), "fixture-credential-response");
    assert.equal(
      (
        await fetch(address + "/client-setup/redeem", {
          method: "POST",
          headers: { Host: "localhost:3000" },
          body: "a".repeat(65),
        })
      ).status,
      400,
    );
    assert.equal(calls.length, 2);
  } finally {
    await close(panel);
  }
});

test("client setup downloads are fixed public assets without secrets or arbitrary file access", async () => {
  const panel = createPanelServer({
    upstream: "http://127.0.0.1:1",
    managementKey: "never-in-download",
    origins: ["http://localhost:3000"],
  });
  const address = await listen(panel);
  const headers = { Host: "localhost:3000" };
  try {
    for (const name of ["crap.ps1", "crap.sh", "guide.md"]) {
      const r = await fetch(`${address}/client-setup/${name}`, { headers });
      assert.equal(r.status, 200);
      const text = await r.text();
      assert.ok(text.includes("CRAP"));
      assert.equal(text.includes("never-in-download"), false);
      if (name !== "guide.md")
        assert.ok(r.headers.get("content-disposition").includes(name));
    }
    assert.equal(
      (await fetch(`${address}/client-setup/other.env`, { headers })).status,
      404,
    );
    assert.equal(
      (
        await fetch(`${address}/client-setup/crap.ps1`, {
          headers,
          method: "POST",
        })
      ).status,
      405,
    );
    assert.equal(
      (
        await fetch(`${address}/client-setup/crap.ps1`, {
          headers: { Host: "untrusted.example" },
        })
      ).status,
      403,
    );
  } finally {
    await close(panel);
  }
});
import { accountLabels } from "./account-labels.mjs";

test("affinity bridge isolates control credentials and only exposes allowed operations", async () => {
  const requests = [];
  const control = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({
      path: req.url,
      auth: req.headers.authorization,
      body: Buffer.concat(chunks).toString(),
    });
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify(
        req.url === "/state" ? { policy: { mode: "shadow" } } : { ok: true },
      ),
    );
  });
  const upstream = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/v8/management/credentials") {
      res.end(
        JSON.stringify({
          files: [{ id: "private-account", email: "alice@example.com" }],
        }),
      );
      return;
    }
    res.end(
      JSON.stringify({
        plugins: [
          { id: "affinity-router", registered: true, effective_enabled: true },
        ],
      }),
    );
  });
  const controlURL = await listen(control);
  const upstreamURL = await listen(upstream);
  const panel = createPanelServer({
    upstream: upstreamURL,
    managementKey: "management-secret",
    origins: ["http://panel.test"],
    affinityURL: controlURL,
    affinityToken: "control-secret",
    affinityIdentityKey: "6b".repeat(32),
  });
  const address = await listen(panel);
  const headers = { Host: "panel.test", "X-Panel-Client": "cliproxy-panel" };
  try {
    const state = await fetch(address + "/api/affinity/state", { headers });
    assert.equal(state.status, 200);
    const stateBody = await state.json();
    assert.equal(stateBody.pluginRegistered, true);
    assert.deepEqual(Object.values(stateBody.accountLabels), ["a•••@e•••"]);
    assert.ok(!JSON.stringify(stateBody).includes("alice@example.com"));
    assert.ok(!JSON.stringify(stateBody).includes("private-account"));
    const price = await fetch(address + "/api/affinity/prices", {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "fixture" }),
    });
    assert.equal(price.status, 200);
    assert.equal(requests.at(-1).auth, "Bearer control-secret");
    assert.equal(requests.at(-1).path, "/prices");
    assert.equal(
      (
        await fetch(address + "/api/affinity/usage", {
          method: "POST",
          headers,
          body: "{}",
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await fetch(address + "/api/affinity/policy", {
          method: "PUT",
          headers: { ...headers, Origin: "https://foreign.invalid" },
          body: "{}",
        })
      ).status,
      403,
    );
    assert.equal(requests.length, 2);
  } finally {
    await close(panel);
    await close(control);
    await close(upstream);
  }
});

test("account labels prefer friendly names, mask embedded emails and omit raw filenames", () => {
  const labels = accountLabels(
    [
      { id: "first", email: "alice@example.com", label: "Personal Max" },
      { id: "second", email: "bob@example.org", label: "Work bob@example.org" },
      { id: "third", email: "carol@example.net" },
      { id: "secret-filename.json" },
    ],
    "6b".repeat(32),
  );
  assert.deepEqual(Object.values(labels), [
    "Personal Max",
    "Work b•••@e•••",
    "c•••@e•••",
  ]);
  assert.ok(Object.keys(labels).every((key) => /^v1:[a-f0-9]{64}$/.test(key)));
  assert.deepEqual(
    accountLabels([{ id: "first", email: "alice@example.com" }], ""),
    {},
  );
});

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
// Use http.request so Host and Sec-Fetch-Site are sent verbatim in rejection tests.
function fetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      url,
      { method: options.method ?? "GET", headers: options.headers },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const buffer = Buffer.concat(chunks);
          resolve({
            status: response.statusCode,
            headers: new Headers(response.headers),
            text: async () => buffer.toString(),
            json: async () => JSON.parse(buffer.toString()),
            arrayBuffer: async () => buffer,
          });
        });
      },
    );
    request.on("error", reject);
    request.end(options.body);
  });
}

test("local bridge authentication, filtering, and failure handling", async (t) => {
  const received = [];
  let status = 200;
  const upstreamServer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({
      url: req.url,
      auth: req.headers.authorization,
      method: req.method,
      body: Buffer.concat(chunks).toString(),
    });
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        req.url === "/v8/management/config"
          ? {
              management: { "secret-key": "private-hash" },
              server: { tls: { key: "private" } },
              access: { "api-keys": ["client-key"] },
              routing: { strategy: "round-robin" },
            }
          : status === 200
            ? { status: "ok" }
            : { error: "upstream rejected request" },
      ),
    );
  });
  const upstream = await listen(upstreamServer);
  const server = createPanelServer({
    upstream,
    managementKey: "test-admin-secret",
    origins: ["http://localhost:3000"],
  });
  const address = await listen(server);
  const headers = {
    Host: "localhost:3000",
    "X-Panel-Client": "cliproxy-panel",
  };
  try {
    await t.test(
      "injects management authentication and strips management secrets",
      async () => {
        const response = await fetch(address + "/api/config", { headers });
        assert.equal(response.status, 200);
        const result = await response.json();
        assert.equal(result.management, undefined);
        assert.equal(result.server, undefined);
        assert.deepEqual(result.access, { "api-keys": ["client-key"] });
        assert.equal(received.at(-1).auth, "Bearer test-admin-secret");
      },
    );
    await t.test(
      "rejects requests without the panel header, foreign origins, cross-site fetches, and foreign hosts",
      async () => {
        const before = received.length;
        for (const badHeaders of [
          { Host: "localhost:3000" },
          { ...headers, Origin: "https://foreign.example" },
          { ...headers, "Sec-Fetch-Site": "cross-site" },
          { ...headers, Host: "foreign.example" },
        ]) {
          const response = await fetch(address + "/api/config", {
            headers: badHeaders,
          });
          assert.equal(response.status, 403);
          await response.arrayBuffer();
        }
        assert.equal(received.length, before);
      },
    );
    await t.test(
      "cannot reach unlisted operations or replace the complete config",
      async () => {
        for (const [pathname, method] of [
          ["/api/config", "PUT"],
          ["/api/config/management", "POST"],
          ["/api/requests/api-call", "GET"],
          ["/api/health", "POST"],
        ]) {
          const response = await fetch(address + pathname, {
            method,
            headers,
            body: method === "GET" ? undefined : "{}",
          });
          assert.ok([404, 405].includes(response.status));
          await response.arrayBuffer();
        }
      },
    );
    await t.test("forwards a scoped config mutation exactly", async () => {
      const body = JSON.stringify({ retry: { "request-retry": 2 } });
      const response = await fetch(address + "/api/config/routing", {
        method: "PATCH",
        headers: { ...headers, "Content-Type": "application/json" },
        body,
      });
      assert.equal(response.status, 200);
      assert.equal(received.at(-1).body, body);
      assert.equal(received.at(-1).url, "/v8/management/config/routing");
    });
    await t.test("preserves upstream errors", async () => {
      status = 401;
      const response = await fetch(address + "/api/credentials", { headers });
      assert.equal(response.status, 401);
      assert.equal((await response.json()).error, "upstream rejected request");
      status = 200;
    });
    await t.test(
      "forwards the OAuth lifecycle through management authentication",
      async () => {
        const callback = JSON.stringify({
          provider: "codex",
          state: "example-state",
          code: "example-code",
        });
        for (const [endpoint, method, body] of [
          ["/oauth/auth-url?provider=codex&is_webui=true", "GET"],
          ["/oauth/status?state=example-state", "GET"],
          ["/oauth/callback", "POST", callback],
          ["/oauth/session?state=example-state", "DELETE"],
        ]) {
          const response = await fetch(address + "/api" + endpoint, {
            method,
            headers,
            body,
          });
          assert.equal(response.status, 200);
          assert.equal(received.at(-1).auth, "Bearer test-admin-secret");
          assert.equal(received.at(-1).url, "/v8/management" + endpoint);
          if (body) assert.equal(received.at(-1).body, body);
        }
      },
    );
    await t.test("rejects unbound OAuth polling and cancellation", async () => {
      const before = received.length;
      for (const [endpoint, method] of [
        ["/oauth/status", "GET"],
        ["/oauth/session?state=", "DELETE"],
      ]) {
        const response = await fetch(address + "/api" + endpoint, {
          method,
          headers,
        });
        assert.equal(response.status, 400);
      }
      assert.equal(received.length, before);
    });
    await t.test("rejects oversized writes before forwarding", async () => {
      const before = received.length;
      const response = await fetch(
        address + "/api/credentials?name=test.json",
        { method: "POST", headers, body: "x".repeat(2 * 1024 * 1024 + 1) },
      );
      assert.equal(response.status, 413);
      await response.arrayBuffer();
      assert.equal(received.length, before);
    });
    await close(upstreamServer);
    await t.test(
      "reports unreachable proxy without leaking connection details",
      async () => {
        const response = await fetch(address + "/api/health", { headers });
        assert.equal(response.status, 502);
        assert.match((await response.json()).error, /unavailable/);
      },
    );
  } finally {
    await close(server);
    if (upstreamServer.listening) await close(upstreamServer);
  }
});

test("Claude account lookup is scoped, sanitized and cached", async () => {
  const calls = [];
  const upstreamServer = http.createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/v8/management/credentials") {
      res.end(
        JSON.stringify({
          files: [
            { auth_index: "claude-one", provider: "claude" },
            { auth_index: "unsupported-one", provider: "unknown" },
          ],
        }),
      );
      return;
    }
    if (req.url === "/v8/management/plugins") {
      res.end(JSON.stringify({ plugins: [] }));
      return;
    }
    assert.equal(req.url, "/v8/management/requests/api-call");
    assert.equal(req.headers.authorization, "Bearer test-admin-secret");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    calls.push(body);
    assert.equal(body.auth_index, "claude-one");
    assert.equal(body.method, "GET");
    assert.equal(body.header.Authorization, "Bearer $TOKEN$");
    assert.ok(
      [
        "https://api.anthropic.com/api/oauth/usage",
        "https://api.anthropic.com/api/oauth/profile",
      ].includes(body.url),
    );
    const data = body.url.endsWith("/usage")
      ? {
          five_hour: { utilization: 1, resets_at: "2026-10-05T16:50:00Z" },
          seven_day: { utilization: 0 },
          extra_usage: { is_enabled: false },
        }
      : {
          organization: { organization_type: "claude_pro" },
          account: { email: "private@example.com" },
          access_token: "private-token",
        };
    res.end(JSON.stringify({ status_code: 200, body: JSON.stringify(data) }));
  });
  const upstream = await listen(upstreamServer);
  const panel = createPanelServer({
    upstream,
    managementKey: "test-admin-secret",
    origins: ["http://localhost:3000"],
  });
  const address = await listen(panel);
  const headers = {
    Host: "localhost:3000",
    "X-Panel-Client": "cliproxy-panel",
  };
  try {
    const response = await fetch(
      address +
        "/api/accounts/usage?auth_index=claude-one&url=https://evil.invalid",
      { headers },
    );
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.plan, "Pro");
    assert.equal(data.windows[0].used, 1);
    assert.equal(data.windows[1].used, 0);
    assert.equal(data.extraUsageEnabled, false);
    assert.ok(!JSON.stringify(data).includes("private"));
    await (
      await fetch(address + "/api/accounts/usage?auth_index=claude-one", {
        headers,
      })
    ).json();
    assert.equal(calls.length, 2);
    assert.equal(
      (await fetch(address + "/api/accounts/usage", { headers })).status,
      400,
    );
    assert.equal(
      (
        await fetch(
          address + "/api/accounts/usage?auth_index=unsupported-one",
          {
            headers,
          },
        )
      ).status,
      502,
    );
    assert.equal(
      (
        await fetch(address + "/api/accounts/usage?auth_index=missing", {
          headers,
        })
      ).status,
      502,
    );
    assert.equal(
      (
        await fetch(address + "/api/accounts/usage?auth_index=claude-one", {
          headers: { ...headers, Origin: "https://evil.invalid" },
        })
      ).status,
      403,
    );
    assert.equal(calls.length, 2);
  } finally {
    await close(panel);
    await close(upstreamServer);
  }
});

test("Claude normalization supports current limits, old windows and missing values", () => {
  const data = normalizeClaudeUsage(
    {
      limits: [
        { kind: "session", percent: 1, resets_at: "2026-10-05T16:50:00Z" },
        { kind: "weekly_all", percent: 0 },
        {
          kind: "weekly_scoped",
          percent: 23,
          scope: { model: { display_name: "Sonnet" } },
        },
      ],
    },
    {
      organization: {
        organization_type: "claude_max",
        rate_limit_tier: "default_claude_max_20x",
      },
    },
  );
  assert.deepEqual(
    data.windows.map((w) => w.used),
    [1, 0, 23],
  );
  assert.equal(data.plan, "Max 20×");
  assert.equal(data.windows[2].label, "Weekly · Sonnet");
  const missing = normalizeClaudeUsage(
    { five_hour: { utilization: null, resets_at: "invalid" } },
    undefined,
  );
  assert.equal(missing.windows[0].used, undefined);
  assert.equal(missing.windows[0].resetAt, undefined);
  assert.equal(missing.plan, undefined);
});

test("management routes permit documented operations and reject traversal and wrong methods", () => {
  for (const [path, method] of [
    ["/admin/config", "PUT"],
    ["/config.yaml", "GET"],
    ["/config/plugins/configs/test", "PATCH"],
    ["/credentials/models", "GET"],
    ["/credentials/refresh", "POST"],
    ["/plugins/p/quota", "DELETE"],
    ["/plugins/store/p/install", "POST"],
    ["/observability/logs/errors/error-test.log", "GET"],
    ["/routing/model-definitions/claude", "GET"],
    ["/requests/api-call", "POST"],
  ])
    assert.equal(
      allowsManagementRoute(path, method),
      true,
      `${method} ${path}`,
    );
  for (const [path, method] of [
    ["/config/x/%2e%2e/y", "PUT"],
    ["/plugins/a%2fb", "DELETE"],
    ["/plugins/store", "DELETE"],
    ["/credentials/models", "POST"],
    ["/random", "GET"],
    ["/config/x%5cy", "PATCH"],
  ])
    assert.equal(
      allowsManagementRoute(path, method),
      false,
      `${method} ${path}`,
    );
});

test("Codex and plugin quota normalization retain zero and distinguish missing measurements", () => {
  const codex = normalizeCodexUsage({
    plan_type: "plus",
    rate_limit: {
      primary_window: {
        used_percent: 0,
        limit_window_seconds: 18000,
        reset_at: 1800000000,
      },
      secondary_window: { used_percent: 50, limit_window_seconds: 604800 },
    },
    code_review_rate_limits: {
      primary_window: { used_percent: 10, limit_window_seconds: 604800 },
    },
    additional_rate_limits: [
      {
        limit_name: "Additional model",
        rate_limit: {
          primary_window: { used_percent: 80, limit_window_seconds: 18000 },
        },
      },
    ],
  });
  assert.equal(codex.plan, "plus");
  assert.equal(codex.windows[0].used, 0);
  assert.equal(codex.windows[0].resetAt, 1800000000000);
  assert.equal(codex.windows[1].label, "Weekly window");
  assert.equal(codex.windows[2].label, "Code review · Weekly window");
  assert.equal(codex.windows[2].used, 10);
  assert.equal(codex.windows[3].label, "Additional model · 5-hour window");
  assert.equal(codex.windows[3].used, 80);
  const plugin = normalizePluginUsage({
    subscription: { plan: "Test" },
    groups: [
      {
        displayName: "Models",
        buckets: [
          { window: "Daily", remainingFraction: 0.25 },
          { window: "Other" },
        ],
      },
    ],
  });
  assert.equal(plugin.windows[0].used, 75);
  assert.equal(plugin.windows[1].used, undefined);
});

test("advanced bridge preserves YAML bodies and strips refreshed tokens", async () => {
  const received = [];
  const upstreamServer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({
      url: req.url,
      contentType: req.headers["content-type"],
      body: Buffer.concat(chunks).toString(),
    });
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify(
        req.url === "/v8/management/credentials/refresh"
          ? { ok: true, auth: { access_token: "secret-token" } }
          : { management: { "secret-key": "hash" }, server: { port: 8317 } },
      ),
    );
  });
  const upstream = await listen(upstreamServer);
  const panel = createPanelServer({
    upstream,
    managementKey: "test",
    origins: ["http://localhost:3000"],
  });
  const address = await listen(panel);
  const headers = {
    Host: "localhost:3000",
    "X-Panel-Client": "cliproxy-panel",
  };
  try {
    const yaml = "routing:\n  strategy: round-robin\n";
    await fetch(address + "/api/config.yaml", {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/yaml" },
      body: yaml,
    });
    assert.equal(received.at(-1).body, yaml);
    assert.equal(received.at(-1).contentType, "application/yaml");
    const refresh = await fetch(address + "/api/credentials/refresh", {
      method: "POST",
      headers,
      body: '{"name":"test.json"}',
    });
    assert.deepEqual(await refresh.json(), { ok: true });
    const full = await fetch(address + "/api/admin/config", { headers });
    assert.equal((await full.json()).management["secret-key"], "hash");
    assert.equal(received.at(-1).url, "/v8/management/config");
    const denied = await fetch(address + "/api/admin/config", {
      headers: { ...headers, Origin: "https://foreign.invalid" },
    });
    assert.equal(denied.status, 403);
  } finally {
    await close(panel);
    await close(upstreamServer);
  }
});

test("runtime reports only the deployment category behind the panel boundary", async () => {
  for (const [runtimeEnvironment, deployment] of [
    [
      {
        KUBERNETES_SERVICE_HOST: "private-cluster-address",
        SECRET: "private-value",
      },
      "kubernetes",
    ],
    [{}, "unknown"],
  ]) {
    const panel = createPanelServer({
      upstream: "http://localhost:1",
      managementKey: "fixture-management-key",
      origins: ["http://localhost:3000"],
      runtimeEnvironment,
    });
    const address = await listen(panel);
    const headers = {
      Host: "localhost:3000",
      "X-Panel-Client": "cliproxy-panel",
    };
    try {
      const response = await fetch(`${address}/api/runtime`, { headers });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { deployment });
      assert.equal(
        (
          await fetch(`${address}/api/runtime`, {
            headers: { Host: "localhost:3000" },
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await fetch(`${address}/api/runtime`, {
            headers: { ...headers, Origin: "https://other.example" },
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await fetch(`${address}/api/runtime`, {
            headers,
            method: "PUT",
            body: "{}",
          })
        ).status,
        405,
      );
    } finally {
      await close(panel);
    }
  }
});
