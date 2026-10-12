import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
const env = Object.fromEntries(
  readFileSync("/run/crap/service.env", "utf8")
    .trim()
    .split("\n")
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1)];
    }),
);
async function call(
  base,
  key,
  path,
  body,
  method = body === undefined ? "GET" : "POST",
) {
  const r = await fetch(base + path, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw Error(`${path}: ${r.status} ${text.slice(0, 600)}`);
  return JSON.parse(text || "null");
}
const mgmt = (p, b, m) =>
  call("http://proxy:8317", env.MANAGEMENT_KEY, "/v8/management" + p, b, m);
const control = (p, b, m) =>
  call("http://control:8318", env.AFFINITY_CONTROL_TOKEN, p, b, m);
let cfg;
for (let i = 0; i < 60; i++) {
  try {
    cfg = await mgmt("/config");
    break;
  } catch {
    await delay(1000);
  }
}
assert.ok(cfg, "proxy ready");
assert.equal(
  (await mgmt("/credentials")).files.length,
  0,
  "refuse existing credentials",
);
for (const name of ["a", "b"]) {
  const cred = {
    type: "claude",
    email: `fixture-${name}@example.invalid`,
    access_token: `sk-ant-oat01-fixture-${name}`,
    refresh_token: `fixture-refresh-${name}`,
    expired: "2099-01-01T00:00:00Z",
    last_refresh: "2026-01-01T00:00:00Z",
  };
  const res = await fetch(
    `http://proxy:8317/v8/management/credentials?name=fixture-${name}.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.MANAGEMENT_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(cred),
    },
  );
  assert.ok(res.ok, `upload ${res.status}`);
}
await delay(2000);
const credentials = (await mgmt("/credentials")).files;
assert.equal(credentials.length, 2);
console.log(
  "Fixture credential types:",
  credentials.map((c) => ({
    kind: c.account_type,
    provider: c.provider,
    runtime: c.runtime_only,
  })),
);
const models = (await mgmt("/credentials/models?name=fixture-a.json")).models;
const model = models.find((m) => m.id.includes("sonnet"))?.id;
assert.ok(model, "Claude model catalog");
const key = cfg.access["api-keys"][0];
async function send(session, extra = {}, options = {}) {
  const r = await fetch("http://gateway:8319/v1/messages?beta=true", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "x-claude-code-session-id": session,
    },
    body: JSON.stringify({
      model,
      max_tokens: 20,
      messages: [{ role: "user", content: "Synthetic fixture only" }],
      ...extra,
    }),
    ...options,
  });
  return r;
}
let ready = false;
for (let i = 0; i < 30; i++) {
  ready = (await fetch("http://gateway:8319/readyz")).ok;
  if (ready) break;
  await delay(1000);
}
assert.ok(ready, "gateway ready");
const initialPolicy = (await control("/state")).policy;
await control(
  "/policy",
  {
    ...initialPolicy,
    minimumRemaining: 5,
    mode: "shadow",
    freshnessSeconds: 31,
    affinitySeconds: 61,
  },
  "PUT",
);
const savedPolicy = (await control("/state")).policy;
assert.equal(savedPolicy.minimumRemaining, 5);
assert.equal(
  savedPolicy.mode,
  initialPolicy.mode,
  "strict policy editing cannot activate legacy shadow mode",
);
assert.equal(savedPolicy.freshnessSeconds, initialPolicy.freshnessSeconds);
assert.equal(savedPolicy.affinitySeconds, initialPolicy.affinitySeconds);
let r = await send("family");
let raw = await r.text();
assert.equal(r.status, 200, raw);
assert.equal(JSON.parse(raw).usage.input_tokens, 10);
r = await send("family", { stream: true });
raw = await r.text();
assert.equal(r.status, 200, raw);
assert.ok(raw.includes("message_stop"));
const requests = (await (await fetch("http://provider:8080")).json()).filter(
  (c) => c.path.startsWith("/v1/messages"),
);
assert.equal(requests.length, 2, "exactly one upstream call per request");
assert.equal(requests[0].auth, requests[1].auth, "sticky account");
assert.ok(
  requests.every((c) => c.body.model === model),
  "original model",
);
console.log(
  "PASS: compiled plugin, original model, one dispatch per message, streaming and sticky account",
);
let state;
for (let i = 0; i < 30; i++) {
  state = await control("/state");
  if (state.summary.events === 2 && state.journal.completed === 2) break;
  await delay(500);
}
console.log(
  "Accounting:",
  JSON.stringify({
    summary: state.summary,
    journal: state.journal,
    coverage: state.coverage,
    quotas: state.quotas.map((q) => ({ windows: q.windows })),
  }),
);
assert.equal(state.summary.events, 2, "one usage record per request");
assert.equal(state.summary.reportedTokens, "84", "correct token totals");
assert.equal(state.journal.admitted, 2, "one admission record per request");
assert.equal(state.cache.fiveMinute, "6");
assert.equal(state.cache.oneHour, "4");
assert.equal(state.policy.mode, "live", "exercise migrated live legacy policy");
const boundAccount = credentials.find((c) =>
  requests[0].auth.includes(
    `fixture-${c.name.includes("fixture-a") ? "a" : "b"}`,
  ),
);
assert.ok(boundAccount, "selected fixture account");
await control("/quotas", {
  accountId: boundAccount.id || boundAccount.name,
  provider: "claude",
  checkedAt: Date.now() - 3600000,
  windows: [{ label: "Weekly window", used: 94 }],
  error: false,
});
await fetch("http://provider:8080", {
  method: "POST",
  body: JSON.stringify({ status: 529 }),
});
r = await send("family");
raw = await r.text();
assert.equal(r.status, 529, raw);
const after = (await (await fetch("http://provider:8080")).json()).filter((c) =>
  c.path.startsWith("/v1/messages"),
);
assert.equal(after.length, 3, "no retry of overload");
assert.equal(after.at(-1).auth, requests[0].auth);
await fetch("http://provider:8080", { method: "POST", body: "{}" });
r = await send("family");
assert.equal(r.status, 200, await r.text());
const next = (await (await fetch("http://provider:8080")).json()).filter((c) =>
  c.path.startsWith("/v1/messages"),
);
assert.equal(
  next.at(-1).auth,
  requests[0].auth,
  "overload does not move family",
);
console.log("PASS: overload returned without replay or account switch");
const account = credentials.find(
  (c) =>
    c.name === `fixture-${requests[0].auth.endsWith("-a") ? "a" : "b"}.json`,
);
assert.ok(account);
// A completed response puts the selected account below reserve. Only the next call moves.
await fetch("http://provider:8080", {
  method: "POST",
  body: JSON.stringify({ used: 0.97 }),
});
r = await send("family");
assert.equal(r.status, 200, await r.text());
await fetch("http://provider:8080", { method: "POST", body: "{}" });
r = await send("child", { parent_session_id: "family" });
assert.equal(r.status, 200, await r.text());
const moved = (await (await fetch("http://provider:8080")).json()).filter((c) =>
  c.path.startsWith("/v1/messages"),
);
assert.notEqual(
  moved.at(-1).auth,
  requests[0].auth,
  "child moves the family before the account reaches zero",
);
await control("/quotas", {
  accountId: account.id,
  provider: "claude",
  checkedAt: Date.now(),
  windows: [{ label: "Weekly window", used: 0 }],
});
r = await send("family");
assert.equal(r.status, 200, await r.text());
const retained = (await (await fetch("http://provider:8080")).json()).filter(
  (c) => c.path.startsWith("/v1/messages"),
);
assert.equal(
  retained.at(-1).auth,
  moved.at(-1).auth,
  "recovery does not pull family back",
);
console.log(
  "PASS: response quota drops below 5%, next request moves whole family, recovery does not pull it back",
);
const count = await fetch("http://gateway:8319/v1/messages/count_tokens", {
  method: "POST",
  headers: {
    "x-api-key": key,
    "content-type": "application/json",
    "x-claude-code-session-id": "family",
  },
  body: JSON.stringify({
    model,
    messages: [{ role: "user", content: "fixture" }],
  }),
});
assert.equal(count.status, 200, await count.clone().text());
assert.equal((await count.json()).input_tokens, 42);
const beforeDirect = (await (await fetch("http://provider:8080")).json())
  .length;
const direct = await fetch("http://proxy:8317/v1/messages", {
  method: "POST",
  headers: { "x-api-key": key, "content-type": "application/json" },
  body: JSON.stringify({
    model,
    max_tokens: 5,
    messages: [{ role: "user", content: "must not reach provider" }],
  }),
});
assert.ok(direct.status >= 400);
await direct.text();
assert.equal(
  (await (await fetch("http://provider:8080")).json()).length,
  beforeDirect,
  "native route cannot bypass grant",
);
await mgmt("/config/plugins/enabled", false, "PUT");
for (let i = 0; i < 30; i++) {
  if (!(await fetch("http://gateway:8319/readyz")).ok) break;
  await delay(200);
}
r = await send("family");
assert.equal(r.status, 503, await r.text());
await mgmt("/config/plugins/enabled", true, "PUT");
for (let i = 0; i < 50; i++) {
  if ((await fetch("http://gateway:8319/readyz")).ok) break;
  await delay(200);
}
r = await send("family");
assert.equal(r.status, 200, await r.text());
console.log(
  "PASS: exact-account token counting, native bypass denied, plugin disable blocks and re-enable recovers",
);
for (const c of credentials)
  await control("/quotas", {
    accountId: c.id,
    provider: "claude",
    checkedAt: Date.now(),
    windows: [
      { label: "Weekly window", used: 100, resetAt: Date.now() + 86400000 },
    ],
  });
r = await send("family");
raw = await r.text();
assert.equal(r.status, 429, raw);
assert.match(raw, /earliest reset/i);
console.log(
  "PASS: all exhausted returns immediate error and reset information",
);
for (const c of credentials)
  await control("/quotas", {
    accountId: c.id,
    provider: "claude",
    checkedAt: Date.now(),
    windows: [{ label: "Weekly window", used: 10 }],
  });
await fetch("http://provider:8080", {
  method: "POST",
  body: JSON.stringify({ hold: true }),
});
const held = await send("family", { stream: true });
assert.equal(held.status, 200);
const reader = held.body.getReader();
assert.ok((await reader.read()).value?.length);
const interrupted = (async () => {
  let text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
  } catch {}
  assert.ok(
    !text.includes("message_stop"),
    "must not fabricate successful completion",
  );
})();
await mgmt("/config/plugins/enabled", false, "PUT");
await Promise.race([
  interrupted,
  delay(10000).then(() => {
    throw Error("Active stream did not terminate on plugin quiescence");
  }),
]);
await mgmt("/config/plugins/enabled", true, "PUT");
await fetch("http://provider:8080", { method: "POST", body: "{}" });
for (let i = 0; i < 50; i++) {
  if ((await fetch("http://gateway:8319/readyz")).ok) break;
  await delay(200);
}
r = await send("family");
assert.equal(r.status, 200, await r.text());
console.log(
  "PASS: plugin quiescence terminates an active stream and admission recovers",
);
