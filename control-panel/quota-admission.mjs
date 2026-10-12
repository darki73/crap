import { createHash, randomUUID } from "node:crypto";
import { createIntegrationStore } from "./integrations.mjs";

// Atomic PostgreSQL-backed admission shared by panel replicas. A crash retains
// the five-minute reservation; stale completion cannot shorten another claim.
export function createQuotaAdmission({ store, now = Date.now }) {
  async function update(fn) {
    for (let i = 0; i < 5; i++) {
      const d = await store.load();
      d.data.quotaRefreshClaims ??= {};
      const result = fn(d.data.quotaRefreshClaims);
      try {
        await store.save(d);
        return result;
      } catch (error) {
        if (!error.message.includes("settings changed") || i === 4) throw error;
      }
    }
  }
  return {
    begin(account, provider) {
      const id = createHash("sha256")
        .update(JSON.stringify([provider, account]))
        .digest("hex");
      return update((claims) => {
        const old = claims[id];
        if (old?.nextAttemptAt > now())
          return {
            granted: false,
            nextAttemptAt: old.nextAttemptAt,
            result: old.result,
          };
        const claim = {
          claim: randomUUID(),
          nextAttemptAt: now() + 300_000,
          result: old?.result,
        };
        claims[id] = claim;
        return { ...claim, id, granted: true };
      });
    },
    finish(admission, nextAttemptAt, result) {
      return update((claims) => {
        const old = claims[admission.id];
        if (old?.claim === admission.claim) {
          old.nextAttemptAt = Math.max(old.nextAttemptAt, nextAttemptAt);
          old.result = result;
        }
      });
    },
  };
}
export function quotaAdmissionFromEnvironment({ url, token, key }) {
  return url && token && key
    ? createQuotaAdmission({
        store: createIntegrationStore({ url, token, key }),
      })
    : undefined;
}
