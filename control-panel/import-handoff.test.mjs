import test from "node:test";
import assert from "node:assert/strict";
import { prepareImportedIntegrations } from "./import-handoff.mjs";
test("a restored workspace pauses integrations once while preserving credentials and queued notifications", async () => {
  const data = {
    tailscale: { enabled: true, allowedUsers: ["owner@example.test"] },
    telegram: { enabled: true, token: "fixture", chatId: "42" },
    outbox: [{ id: "unsent" }],
    pair: { code: "old" },
    dashboardAddress: "https://old.example",
  };
  let writes = 0;
  const store = {
    load: async () => ({ data }),
    save: async () => {
      writes++;
    },
  };
  await prepareImportedIntegrations(store, "abcdef123456");
  assert.equal(data.telegram.enabled, false);
  assert.equal(data.tailscale.enabled, false);
  assert.equal(data.telegram.token, "fixture");
  assert.equal(data.outbox.length, 1);
  assert.equal(data.pair, null);
  data.telegram.enabled = true;
  await prepareImportedIntegrations(store, "abcdef123456");
  assert.equal(data.telegram.enabled, true);
  assert.equal(writes, 1);
  await assert.rejects(prepareImportedIntegrations(store, "invalid"));
});
