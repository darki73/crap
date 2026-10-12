import test from "node:test";
import assert from "node:assert/strict";
import {
  claudeResponseWindows,
  mergeResponseQuota,
  completeFreshQuota,
  mergeQuotaResults,
} from "./quota-observations.mjs";
import {
  createAccountUsageReader,
  QUOTA_INTERVAL_MS,
} from "./account-usage.mjs";
const start = Date.parse("2026-10-06T00:00:00Z");
function quota(time, signals) {
  return { observed_at: new Date(time).toISOString(), signals };
}
const headers = {
  "Anthropic-Ratelimit-Unified-5h-Utilization": "0.01",
  "Anthropic-Ratelimit-Unified-7d-Utilization": "0.1",
};
test("a shared result cannot rewind an omitted local response window", () => {
  const result = mergeQuotaResults(
    { checkedAt: start, windows: [{ label: "Weekly window", used: 1 }] },
    {
      checkedAt: start + 1000,
      windows: [
        {
          label: "Weekly window",
          used: 2,
          observedAt: start + 1000,
          source: "response",
        },
        {
          label: "5-hour window",
          used: 3,
          observedAt: start - 1000,
          source: "response",
        },
      ],
    },
  );
  assert.equal(result.windows[0].used, 2);
  assert.equal(result.windows[1].observedAt, start - 1000);
});
test("passive windows validate values, retain independent ages, and never rewind newer data", () => {
  const result = {
    checkedAt: start - 400_000,
    windows: [{ label: "Weekly window", used: 5 }],
  };
  const merged = mergeResponseQuota(
    result,
    quota(start, { "anthropic-ratelimit-unified-5h-utilization": "0.02" }),
    start,
  );
  assert.equal(merged.windows[0].observedAt, start - 400_000);
  assert.equal(completeFreshQuota(merged, start, QUOTA_INTERVAL_MS), false);
  const complete = mergeResponseQuota(merged, quota(start, headers), start);
  assert.equal(completeFreshQuota(complete, start, QUOTA_INTERVAL_MS), true);
  assert.equal(
    complete.windows.find((w) => w.label === "5-hour window").used,
    2,
  );
  assert.equal(
    mergeResponseQuota(complete, quota(start - 1000, headers), start),
    complete,
  );
  assert.deepEqual(
    claudeResponseWindows(
      quota(start, { "anthropic-ratelimit-unified-5h-utilization": "NaN" }),
      start,
    ),
    [],
  );
  assert.deepEqual(
    claudeResponseWindows(quota(start + 120000, headers), start),
    [],
  );
  assert.equal(
    claudeResponseWindows(
      quota(start, { "anthropic-ratelimit-unified-5h-status": "rejected" }),
      start,
    )[0].used,
    100,
  );
  assert.deepEqual(
    claudeResponseWindows(
      quota(start, { "anthropic-ratelimit-unified-5h-status": "allowed" }),
      start,
    ),
    [],
  );
});
test("fresh complete response observations skip quota polling; idle expiry resumes it and respects backoff", async () => {
  let time = start,
    observation = quota(start, headers),
    status = 200;
  const calls = [];
  const reader = createAccountUsageReader({
    upstreamURL: new URL("http://fixture.test"),
    managementKey: "fixture",
    now: () => time,
    fetcher: async (url, options) => {
      if (url.pathname.endsWith("credentials"))
        return Response.json({
          files: [{ auth_index: "a", provider: "claude", quota: observation }],
        });
      const endpoint = JSON.parse(options.body).url.split("/").at(-1);
      calls.push(endpoint);
      return Response.json({
        status_code: status,
        header: { "Retry-After": "900" },
        body: JSON.stringify(
          endpoint === "profile"
            ? { organization: { organization_type: "claude_max" } }
            : { five_hour: { utilization: 3 }, seven_day: { utilization: 10 } },
        ),
      });
    },
  });
  const a = await reader("a");
  assert.equal(a.windows[0].source, "poll");
  assert.deepEqual(calls, ["usage", "profile"]);
  time += 240000;
  observation = quota(time, headers);
  await reader("a");
  assert.deepEqual(calls, ["usage", "profile"]);
  time += 300001;
  await reader("a");
  assert.deepEqual(calls, ["usage", "profile", "usage"]);
  time += 300001;
  status = 429;
  await reader("a");
  assert.equal(calls.length, 4);
  time += 1000;
  observation = quota(time, headers);
  const healthy = await reader("a");
  assert.equal(healthy.usageError, undefined);
  time += 301000;
  await reader("a");
  assert.equal(
    calls.length,
    4,
    "response updates bypassed provider Retry-After",
  );
});
