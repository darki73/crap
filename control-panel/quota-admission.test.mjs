import test from "node:test";
import assert from "node:assert/strict";
import { createQuotaAdmission } from "./quota-admission.mjs";
test("replicas share quota admission and results, preserve backoff, and survive owner restart", async () => {
  let time = 1000,
    record = { version: 0, data: {} };
  const store = {
    load: async () => structuredClone(record),
    save: async (d) => {
      if (d.version !== record.version)
        throw new Error("Integration settings changed");
      record = structuredClone(d);
      record.version++;
    },
  };
  const a = createQuotaAdmission({ store, now: () => time }),
    b = createQuotaAdmission({ store, now: () => time });
  const results = await Promise.all([
    a.begin("account", "claude"),
    b.begin("account", "claude"),
  ]);
  assert.equal(results.filter((r) => r.granted).length, 1);
  const winner = results.find((r) => r.granted);
  const result = { checkedAt: time, windows: [{ label: "weekly", used: 10 }] };
  await a.finish(winner, time + 900000, result);
  const blocked = await b.begin("account", "claude");
  assert.equal(blocked.granted, false);
  assert.deepEqual(blocked.result, result);
  time += 900001;
  const next = await b.begin("account", "claude");
  assert.equal(next.granted, true);
  await a.finish(winner, time + 900000, result);
  assert.equal(
    (await b.begin("account", "claude")).nextAttemptAt,
    next.nextAttemptAt,
  );
  assert.equal(
    (
      await createQuotaAdmission({ store, now: () => time }).begin(
        "account",
        "claude",
      )
    ).granted,
    false,
  );
});
