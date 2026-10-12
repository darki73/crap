import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
const post = async (url, value) => {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
  assert.ok(r.ok);
  return r.json();
};
const provider = () => fetch("http://provider:8444").then((r) => r.json());
const send = (stream) =>
  fetch("http://boundary:8320/v1/messages", {
    method: "POST",
    headers: {
      authorization: "Bearer disposable-proof-client",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-fixture",
      stream,
      max_tokens: 16,
      messages: [{ role: "user", content: "crash fixture" }],
    }),
  });
await post("http://boundary:8320/fixture/policy", {
  account: "fixture-a",
  fault: false,
  skip: false,
  deny: false,
});
await post("http://provider:8444", { mode: "hold", reset: true });
const response = await send(true);
assert.equal(response.status, 200);
const reader = response.body.getReader();
assert.ok(!(await reader.read()).done);
// The host runner SIGKILLs only the disposable proxy after this synchronization.
console.log("READY_TO_KILL_DISPOSABLE_PROXY");
let failed = false;
try {
  while (!(await reader.read()).done) {}
} catch {
  failed = true;
}
assert.ok(failed, "a crashed stream must not look like successful completion");
for (let i = 0; i < 50 && !(await provider()).calls[0]?.closed; i++)
  await delay(100);
assert.ok(
  (await provider()).calls[0].closed,
  "crash must close the provider socket",
);
const before = (await provider()).calls.length;
const rejected = await send(false);
assert.equal(rejected.status, 503);
assert.equal((await rejected.json()).error.code, "crap_execution_unavailable");
assert.equal((await provider()).calls.length, before);
assert.equal(
  (await fetch("http://boundary:8320/fixture/state").then((r) => r.json()))
    .active,
  0,
);
console.log(
  "PASS: actual proxy SIGKILL terminates its stream, revokes the grant and blocks new inference",
);
