import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createIntegrationStore } from "../integrations.mjs";
const env = Object.fromEntries(
  (await readFile("/run/crap/service.env", "utf8"))
    .trim()
    .split("\n")
    .map((line) => {
      const i = line.indexOf("=");
      return [line.slice(0, i), line.slice(i + 1)];
    }),
);
const store = createIntegrationStore({
  url: env.AFFINITY_CONTROL_URL,
  token: env.AFFINITY_CONTROL_TOKEN,
  key: env.AFFINITY_ID_KEY,
});
let ready = false;
for (let i = 0; i < 60; i++) {
  try {
    ready = (await fetch(env.AFFINITY_CONTROL_URL + "/healthz")).ok;
  } catch {}
  if (ready) break;
  await delay(250);
}
assert.ok(ready, "Restored control service did not become ready");
assert.equal(
  (await store.load()).data.rehearsalMarker,
  "encrypted-release-fixture",
);
const r = await fetch(env.AFFINITY_CONTROL_URL + "/state", {
  headers: { Authorization: `Bearer ${env.AFFINITY_CONTROL_TOKEN}` },
});
assert.ok(r.ok);
assert.ok(
  (await r.json()).recent.filter((e) => e.model === "claude-fixture").length >=
    3,
);
console.log(
  "PASS: restored control service reads the ledger and decrypts workspace settings using preserved keys.",
);
