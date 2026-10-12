import assert from "node:assert/strict";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";

const headers = {
  authorization: "Bearer disposable-proof-client",
  "content-type": "application/json",
};
const payload = (stream) => ({
  model: "claude-fixture",
  max_tokens: 16,
  stream,
  messages: [{ role: "user", content: "Only a mock request" }],
});
const post = async (url, value) => {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
  assert.ok(r.ok);
  return r.json();
};
const policy = (value) => post("http://boundary:8320/fixture/policy", value);
const provider = (value) =>
  value
    ? post("http://provider:8444", value)
    : fetch("http://provider:8444").then((r) => r.json());
const state = () =>
  fetch("http://boundary:8320/fixture/state").then((r) => r.json());
const inference = (stream = false, signal) =>
  fetch("http://boundary:8320/v1/messages", {
    method: "POST",
    headers,
    body: JSON.stringify(payload(stream)),
    signal,
  });
async function until(check, label) {
  for (let i = 0; i < 80; i++) {
    if (await check()) return;
    await delay(100);
  }
  throw Error(`Timed out: ${label}`);
}
async function management(route, value) {
  const r = await fetch("http://proxy:8317/v8/management" + route, {
    method: value === undefined ? "GET" : "PUT",
    headers: {
      authorization: "Bearer disposable-proof-management",
      "content-type": "application/json",
    },
    body: value === undefined ? undefined : JSON.stringify(value),
  });
  assert.ok(r.ok, `${route}: ${r.status}`);
  return r.json();
}
async function waitReady() {
  await until(async () => {
    try {
      return (await management("/plugins")).plugins?.some(
        (p) => p.id === "strict-proof" && p.registered && p.effective_enabled,
      );
    } catch {
      return false;
    }
  }, "plugin registration");
}
async function blocked() {
  const r = await inference();
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error.code, "crap_execution_unavailable");
}
async function connect(ticket = "", target = "provider:8443") {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "boundary",
      port: 8321,
      method: "CONNECT",
      path: target,
      headers: ticket
        ? {
            "proxy-authorization":
              "Basic " + Buffer.from("execution:" + ticket).toString("base64"),
          }
        : {},
    });
    req.on("connect", (res, socket) => {
      socket.destroy();
      resolve(res.statusCode);
    });
    req.on("error", reject);
    req.end();
  });
}
await waitReady();
await provider({ reset: true, mode: "success" });
await policy({ account: "fixture-a", fault: false, deny: false, skip: false });

for (const account of ["fixture-a", "fixture-a", "fixture-b"]) {
  await policy({ account });
  const r = await inference();
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal((await r.json()).content[0].text, "proof");
}
assert.deepEqual(
  (await provider()).calls.map((c) => c.account),
  ["fixture-a", "fixture-a", "fixture-b"],
);
assert.equal((await state()).active, 0);
console.log(
  "PASS: exact account selection overrides round-robin, across repeated TLS requests",
);

const oldTicket = (await state()).lastTicket;
assert.equal(await connect(oldTicket), 403);
assert.equal(await connect(), 403);
assert.equal(await connect("made-up"), 403);
console.log(
  "PASS: outbound gate rejects absent, forged and revoked execution grants",
);

let count = (await provider()).calls.length;
await policy({ account: "missing" });
await blocked();
assert.equal((await provider()).calls.length, count);
await policy({ account: "fixture-a", deny: true });
await blocked();
assert.equal((await provider()).calls.length, count);
await policy({ deny: false });
console.log(
  "PASS: missing account and rejected routing decision cannot fall back",
);

await provider({ reset: true, mode: "fail-a" });
await policy({ account: "fixture-a" });
await blocked();
let calls = (await provider()).calls;
assert.ok(calls.length > 0);
assert.ok(calls.every((c) => c.account === "fixture-a"));
assert.equal(calls.length, 1, "strict configuration disables automatic retry");
// Even if an operator enables host retries, pinning must never choose B.
try {
  await management("/config/routing/retry/request-retry", 2);
  await provider({ reset: true, mode: "fail-a" });
  await blocked();
  calls = (await provider()).calls;
  assert.ok(calls.length > 0);
  assert.ok(calls.every((c) => c.account === "fixture-a"));
  console.log(
    `PASS: retry-enabled host remains pinned (${calls.length} fixture dispatches, all account A)`,
  );
} finally {
  await management("/config/routing/retry/request-retry", 0);
}
await policy({ account: "fixture-b" });
assert.equal((await inference()).status, 200);
assert.equal((await provider()).calls.at(-1).account, "fixture-b");
console.log(
  "PASS: provider failure never selects another account; CRAP explicitly authorizes the next account",
);

await provider({ reset: true, mode: "hold" });
await policy({ account: "fixture-a" });
let r = await inference(true);
assert.equal(r.status, 200);
let reader = r.body.getReader(),
  text = "";
while (!text.includes("first")) {
  const part = await reader.read();
  assert.ok(!part.done);
  text += new TextDecoder().decode(part.value);
}
assert.equal((await provider()).released, false);
await provider({ release: true });
for (;;) {
  const part = await reader.read();
  if (part.done) break;
  text += new TextDecoder().decode(part.value);
}
assert.ok(text.includes("last") && text.includes("message_stop"));
await until(async () => (await state()).active === 0, "stream grant cleanup");
console.log(
  "PASS: first stream chunks reach the client before the provider finishes",
);

// Keep A open while routing B, then ensure neither grant can be claimed twice.
await provider({ reset: true, mode: "hold" });
await policy({ account: "fixture-a" });
const streamA = await inference(true),
  readerA = streamA.body.getReader();
assert.ok(!(await readerA.read()).done);
const ticketA = (await state()).lastTicket;
await policy({ account: "fixture-b" });
const streamB = await inference(true),
  readerB = streamB.body.getReader();
assert.ok(!(await readerB.read()).done);
assert.deepEqual(
  (await provider()).calls.map((c) => c.account),
  ["fixture-a", "fixture-b"],
);
assert.equal((await state()).active, 2);
assert.equal(await connect(ticketA, "other-provider:8443"), 403);
assert.equal(
  (
    await fetch("http://boundary:8320/claim", {
      method: "POST",
      headers: { authorization: "Bearer " + ticketA },
    })
  ).status,
  410,
);
await provider({ release: true });
await Promise.all(
  [readerA, readerB].map(async (r) => {
    while (!(await r.read()).done) {}
  }),
);
await until(async () => (await state()).active === 0, "concurrent cleanup");
console.log(
  "PASS: concurrent account grants remain separate, single-claim and destination-restricted",
);

await provider({ reset: true, mode: "hold" });
const abort = new AbortController();
r = await inference(true, abort.signal);
reader = r.body.getReader();
assert.ok(!(await reader.read()).done);
abort.abort();
await until(
  async () =>
    (await provider()).calls.length === 1 && (await provider()).calls[0].closed,
  "provider observes client cancellation",
);
await until(
  async () => (await state()).active === 0,
  "cancelled grant cleanup",
);
console.log(
  "PASS: cancelling a blocked stream closes the provider connection and revokes its grant",
);

await provider({ reset: true, mode: "success" });
const raw = await fetch("http://proxy:8317/v1/messages", {
  method: "POST",
  headers,
  body: JSON.stringify(payload(false)),
});
assert.ok(!raw.ok);
await raw.text();
assert.equal((await provider()).calls.length, 0);
console.log(
  "PASS: even a direct ordinary CLIProxy request cannot cross the outbound gate",
);

await policy({ fault: true });
await blocked();
assert.equal((await provider()).calls.length, 0);
await policy({ fault: false });
console.log(
  "PASS: actual plugin handler failure produces a CRAP error with zero provider calls",
);

await policy({ skip: true });
await blocked();
assert.equal((await provider()).calls.length, 0);
await policy({ skip: false });
console.log(
  "PASS: a skipped/unhandled model router cannot fall back to a provider",
);

try {
  await management("/config/plugins/enabled", false);
  await until(
    async () => !(await management("/plugins")).plugins_enabled,
    "plugin disabled",
  );
  await blocked();
  assert.equal((await provider()).calls.length, 0);
  console.log("PASS: disabled plugin has no ordinary inference fallback");
} finally {
  await management("/config/plugins/enabled", true);
}
await waitReady();
await until(async () => {
  const result = await inference();
  await result.text();
  return result.ok;
}, "plugin recovery");
console.log("PASS: supported plugin re-enable recovers the execution path");
console.log(
  "Strict proof complete: synthetic HTTPS Claude Messages only; no live services or credentials used.",
);
