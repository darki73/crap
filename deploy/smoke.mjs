// Run ONLY against an empty disposable release stack. All inference terminates
// at the in-process fixture; no provider credentials or external model are used.
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID, createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createIntegrationStore } from "../integrations.mjs";
if (process.env.CRAP_REHEARSAL !== "1")
  throw new Error("Set CRAP_REHEARSAL=1 only in a disposable release stack.");
const env = Object.fromEntries(
  (await readFile("/run/crap/service.env", "utf8"))
    .trim()
    .split("\n")
    .map((line) => {
      const i = line.indexOf("=");
      return [line.slice(0, i), line.slice(i + 1)];
    }),
);
const proxy = "http://proxy:8317",
  base = "http://panel:18080";
async function call(
  origin,
  key,
  route,
  body,
  method = body === undefined ? "GET" : "POST",
) {
  const r = await fetch(origin + route, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
  });
  if (!r.ok)
    throw new Error(`Rehearsal endpoint ${route} returned HTTP ${r.status}`);
  return r.json();
}
const management = (route, body, method) =>
  call(proxy, env.MANAGEMENT_KEY, "/v8/management" + route, body, method);
const control = (route, body, method) =>
  call(
    env.AFFINITY_CONTROL_URL,
    env.AFFINITY_CONTROL_TOKEN,
    route,
    body,
    method,
  );
const configuration = await management("/config");
assert.equal(
  (await management("/credentials")).files?.length || 0,
  0,
  "Rehearsal refuses connected accounts",
);
assert.ok(
  Object.values(configuration["api-keys"] || {}).every(
    (list) => !Array.isArray(list) || list.length === 0,
  ),
  "Rehearsal refuses configured providers",
);
const initial = await control("/state");
const existingEvents = new Set(initial.recent.map((e) => e.event_id));
const integrationStore = createIntegrationStore({
  url: env.AFFINITY_CONTROL_URL,
  token: env.AFFINITY_CONTROL_TOKEN,
  key: env.AFFINITY_ID_KEY,
});
const document = await integrationStore.load();
assert.ok(
  !document.data.telegram?.enabled && !document.data.tailscale?.enabled,
  "Rehearsal refuses enabled integrations",
);
document.data.rehearsalMarker = "encrypted-release-fixture";
await integrationStore.save(document);
assert.equal(
  (await integrationStore.load()).data.rehearsalMarker,
  "encrypted-release-fixture",
);
let calls = [];
const mock = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  calls.push(req.headers["x-api-key"] || req.headers.authorization);
  res.setHeader("request-id", `fixture-${randomUUID()}`);
  const message = {
    id: "msg_fixture",
    type: "message",
    role: "assistant",
    model: "claude-fixture",
    content: [{ type: "text", text: "release fixture" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 5,
      cache_creation: {
        ephemeral_5m_input_tokens: 3,
        ephemeral_1h_input_tokens: 2,
      },
      output_tokens: 7,
    },
  };
  if (!body.stream) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(message));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const event = (type, data) =>
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  event("message_start", {
    message: {
      ...message,
      content: [],
      stop_reason: null,
      usage: { ...message.usage, output_tokens: 0 },
    },
  });
  event("content_block_start", {
    index: 0,
    content_block: { type: "text", text: "" },
  });
  event("content_block_delta", {
    index: 0,
    delta: { type: "text_delta", text: "release fixture" },
  });
  event("content_block_stop", { index: 0 });
  event("message_delta", {
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 7 },
  });
  event("message_stop", {});
  res.end();
});
await new Promise((resolve) => mock.listen(18080, "0.0.0.0", resolve));
async function until(check) {
  for (let i = 0; i < 60; i++) {
    if (await check()) return;
    await delay(250);
  }
  throw new Error("Rehearsal condition did not become ready");
}
try {
  await management(
    "/config/api-keys/claude",
    [
      {
        name: "release-fixture",
        "base-url": base,
        keys: [{ "api-key": "fixture-a" }, { "api-key": "fixture-b" }],
        models: [{ name: "claude-fixture", alias: "claude-fixture" }],
      },
    ],
    "PUT",
  );
  const accounts = ["fixture-a", "fixture-b"].map(
    (key) =>
      "claude:apikey:" +
      createHash("sha256")
        .update(["claude:apikey", key, base, "", "", ""].join("\0"))
        .digest("hex")
        .slice(0, 12),
  );
  for (let i = 0; i < accounts.length; i++)
    await control("/quotas", {
      accountId: accounts[i],
      provider: "claude",
      checkedAt: Date.now(),
      windows: [{ label: "Weekly window", used: i ? 10 : 20 }],
    });
  await control(
    "/policy",
    { ...initial.policy, mode: "live", minimumRemaining: 5 },
    "PUT",
  );
  const clientKey = configuration.access["api-keys"][0];
  const session = `release-${randomUUID()}`;
  async function request(stream) {
    const r = await fetch("http://gateway:8319/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": clientKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
        "x-session-id": session,
      },
      body: JSON.stringify({
        model: "claude-fixture",
        max_tokens: 16,
        messages: [{ role: "user", content: "synthetic release test" }],
        stream,
      }),
    });
    if (!r.ok) throw new Error(`Mock inference failed: HTTP ${r.status}`);
    assert.match(await r.text(), /release fixture/);
  }
  await until(
    async () => (await management("/config/api-keys/claude")).length > 0,
  );
  await request(false);
  await request(true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0], calls[1], "Affinity must retain the account");
  const state = await control("/state");
  const selected = state.decisions.find(
    (d) => d.model === "claude-fixture",
  ).account_id;
  const ref = (raw) =>
    "v1:" +
    createHmac("sha256", Buffer.from(env.AFFINITY_ID_KEY, "hex"))
      .update(JSON.stringify(["v1", "local", "account", raw]))
      .digest("hex");
  const exhausted = accounts.find((id) => ref(id) === selected);
  assert.ok(exhausted);
  await control("/quotas", {
    accountId: exhausted,
    provider: "claude",
    checkedAt: Date.now(),
    windows: [{ label: "Weekly window", used: 99 }],
  });
  await request(false);
  assert.notEqual(calls[2], calls[1], "Exhausted account must fail over");
  await until(
    async () =>
      (await control("/state")).recent.filter(
        (e) =>
          e.model === "claude-fixture" &&
          !existingEvents.has(e.event_id) &&
          e.quality === "complete" &&
          e.reported_total === "42" &&
          e.cache_write_5m === "3" &&
          e.cache_write_1h === "2",
      ).length >= 3,
  );
  await until(
    async () =>
      (await control("/state")).coverage.matchedTraces >=
      initial.coverage.matchedTraces + 3,
  );
  const accepted = await fetch("http://127.0.0.1:3000/api/health", {
    headers: {
      "X-Panel-Client": "cliproxy-panel",
      Origin: "http://127.0.0.1:3000",
    },
  });
  assert.equal(accepted.status, 200);
  const integrations = await fetch("http://127.0.0.1:3000/api/integrations", {
    headers: {
      "X-Panel-Client": "cliproxy-panel",
      Origin: "http://127.0.0.1:3000",
    },
  });
  assert.equal(integrations.status, 200);
  assert.equal(
    (await integrations.json()).localApiOrigin,
    process.env.PANEL_LOCAL_API_ORIGIN,
  );
  const denied = await fetch("http://127.0.0.1:3000/api/config", {
    headers: {
      "X-Panel-Client": "cliproxy-panel",
      Origin: "https://untrusted.example",
    },
  });
  assert.equal(denied.status, 403);
  console.log(
    "PASS: isolated packaged stack, PostgreSQL, encrypted settings, plugin, affinity, quota failover, streaming, cache accounting and browser-origin boundary.",
  );
} finally {
  try {
    await management("/config/api-keys/claude", [], "PUT");
    const state = await control("/state");
    await control(
      "/policy",
      { ...state.policy, mode: initial.policy.mode },
      "PUT",
    );
  } finally {
    mock.closeAllConnections();
    await new Promise((resolve) => mock.close(resolve));
  }
}
