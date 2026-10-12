import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
const env = Object.fromEntries(
  readFileSync("/run/crap/service.env", "utf8")
    .trim()
    .split("\n")
    .map((line) => {
      const i = line.indexOf("=");
      return [line.slice(0, i), line.slice(i + 1)];
    }),
);
async function get(url, token) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  assert.ok(r.ok, "restored API ready");
  return r.json();
}
const management = (p) =>
  get("http://proxy:8317/v8/management" + p, env.MANAGEMENT_KEY);
const state = () =>
  get("http://control:8318/state", env.AFFINITY_CONTROL_TOKEN);
const before = await state();
assert.equal(before.strictRouting, true);
assert.equal((await management("/credentials")).files.length, 2);
const model = (
  await management("/credentials/models?name=fixture-a.json")
).models.find((m) => m.id.includes("sonnet")).id;
const config = await management("/config");
const r = await fetch("http://gateway:8319/v1/messages", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-api-key": config.access["api-keys"][0],
    "x-claude-code-session-id": "family",
  },
  body: JSON.stringify({
    model,
    max_tokens: 20,
    messages: [{ role: "user", content: "Synthetic restored conversation" }],
    stream: true,
  }),
});
assert.equal(r.status, 200, "resumed inference succeeds after strict restore");
assert.match(await r.text(), /message_stop/);
let after;
for (let i = 0; i < 40; i++) {
  after = await state();
  if (after.summary.events === before.summary.events + 1) break;
  await delay(250);
}
assert.equal(after.summary.events, before.summary.events + 1);
assert.equal(
  BigInt(after.summary.reportedTokens) - BigInt(before.summary.reportedTokens),
  42n,
);
console.log(
  "PASS: restored real plugin streams a resumed fixture conversation and records exactly one usage event.",
);
