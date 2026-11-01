import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeClaudeUsage,
  createAccountUsageReader,
  QUOTA_INTERVAL_MS,
} from "./account-usage.mjs";
import {
  mergeResponseQuota,
  mergeQuotaResults,
  completeFreshQuota,
} from "./quota-observations.mjs";
const start = Date.parse("2026-11-01T00:00:00Z");
const profile = {
  organization: {
    organization_type: "claude_max",
    rate_limit_tier: "default_claude_max_20x",
  },
};

test("Ultra label does not itself remove the session limit; complete inventories can retire it", () => {
  const verified = normalizeClaudeUsage(
    { limits: [{ kind: "weekly_all", percent: 20 }] },
    profile,
  );
  assert.equal(verified.plan, "Ultra");
  assert.equal(
    verified.windows.find((w) => w.label === "5-hour window").status,
    "not_applicable",
  );
  const unverified = normalizeClaudeUsage(
    {
      limits: [
        { kind: "session", percent: 70 },
        { kind: "weekly_all", percent: 20 },
      ],
    },
    profile,
  );
  assert.equal(unverified.windows[0].used, 70);
  assert.equal(unverified.windows[0].status, undefined);
  assert.equal(
    normalizeClaudeUsage({ seven_day: { utilization: 20 } }, profile).windows
      .length,
    1,
    "partial legacy data cannot retire a window",
  );
  assert.equal(
    normalizeClaudeUsage(
      { five_hour: null, seven_day: { utilization: 20 } },
      profile,
    ).windows[1].status,
    "not_applicable",
  );
  assert.equal(normalizeClaudeUsage({ limits: [] }, profile).windows.length, 0);
  assert.equal(
    normalizeClaudeUsage(
      { limits: [{ kind: "weekly_all", percent: null }] },
      profile,
    ).windows.length,
    1,
  );
  assert.equal(
    normalizeClaudeUsage(undefined, {
      organization: {
        organization_type: "claude_max",
        rate_limit_tier: "default_claude_max_5x",
      },
    }).plan,
    "Max",
  );
  assert.equal(
    normalizeClaudeUsage(undefined, {
      organization: {
        organization_type: "claude_max",
        plan_display_name: "Ultra",
      },
    }).plan,
    "Ultra",
  );
});

test("retired session observations survive stale passive and shared readings, while newer real limits win", () => {
  const base = {
    ...normalizeClaudeUsage(
      { limits: [{ kind: "weekly_all", percent: 20 }] },
      profile,
    ),
    checkedAt: start,
  };
  base.windows = base.windows.map((w) => ({
    ...w,
    observedAt: start,
    source: "poll",
  }));
  const passive = (at) => ({
    observed_at: new Date(at).toISOString(),
    signals: { "anthropic-ratelimit-unified-5h-utilization": "1" },
  });
  assert.equal(mergeResponseQuota(base, passive(start - 1000), start), base);
  assert.equal(completeFreshQuota(base, start, QUOTA_INTERVAL_MS), true);
  const old = {
    checkedAt: start - 1000,
    windows: [{ label: "5-hour window", used: 100 }],
  };
  assert.equal(
    mergeQuotaResults(base, old).windows.find(
      (w) => w.label === "5-hour window",
    ).status,
    "not_applicable",
  );
  assert.equal(
    mergeResponseQuota(base, passive(start + 1000), start + 1000).windows.find(
      (w) => w.label === "5-hour window",
    ).used,
    100,
  );
});

test("manual usage refresh bypasses passive freshness but preserves cooldown and Retry-After", async () => {
  let time = start,
    status = 200;
  let calls = 0;
  const reader = createAccountUsageReader({
    upstreamURL: new URL("http://fixture.test"),
    managementKey: "fixture",
    now: () => time,
    fetcher: async (url, options) => {
      if (url.pathname.endsWith("credentials"))
        return Response.json({
          files: [
            {
              auth_index: "a",
              provider: "claude",
              quota: {
                observed_at: new Date(time).toISOString(),
                signals: {
                  "anthropic-ratelimit-unified-7d-utilization": "0.2",
                },
              },
            },
          ],
        });
      const endpoint = JSON.parse(options.body).url.split("/").at(-1);
      if (endpoint === "usage") calls++;
      return Response.json({
        status_code: endpoint === "usage" ? status : 200,
        header: { "Retry-After": "900" },
        body: JSON.stringify(
          endpoint === "usage"
            ? { limits: [{ kind: "weekly_all", percent: 20 }] }
            : profile,
        ),
      });
    },
  });
  await reader("a");
  time += 1000;
  const deferred = await reader("a", { refreshUsage: true });
  assert.equal(calls, 1);
  assert.equal(deferred.refreshDeferredUntil, start + QUOTA_INTERVAL_MS);
  time = start + QUOTA_INTERVAL_MS;
  await reader("a", { refreshUsage: true });
  assert.equal(calls, 2);
  time += QUOTA_INTERVAL_MS;
  status = 429;
  await reader("a", { refreshUsage: true });
  time += QUOTA_INTERVAL_MS;
  const blocked = await reader("a", { refreshUsage: true });
  assert.equal(calls, 3);
  assert.ok(blocked.refreshDeferredUntil > time);
});

test("manual refresh re-polls a fresh passive snapshot instead of waiting for daily inventory refresh", async () => {
  let time = start;
  let usageCalls = 0;
  const reader = createAccountUsageReader({
    upstreamURL: new URL("http://fixture.test"),
    managementKey: "fixture",
    now: () => time,
    fetcher: async (url, options) => {
      if (url.pathname.endsWith("credentials"))
        return Response.json({
          files: [
            {
              auth_index: "a",
              provider: "claude",
              quota: {
                observed_at: new Date(time).toISOString(),
                signals: {
                  "anthropic-ratelimit-unified-5h-utilization": "0.2",
                  "anthropic-ratelimit-unified-7d-utilization": "0.3",
                },
              },
            },
          ],
        });
      const endpoint = JSON.parse(options.body).url.split("/").at(-1);
      if (endpoint === "usage") usageCalls++;
      return Response.json({
        status_code: 200,
        body: JSON.stringify(
          endpoint === "profile"
            ? profile
            : {
                five_hour: { utilization: 20 },
                seven_day: { utilization: 30 },
              },
        ),
      });
    },
  });
  await reader("a");
  time += QUOTA_INTERVAL_MS;
  await reader("a");
  assert.equal(
    usageCalls,
    1,
    "background reads should use fresh passive measurements",
  );
  await reader("a", { refreshUsage: true });
  assert.equal(
    usageCalls,
    2,
    "manual refresh should request fresh inventory when eligible",
  );
});

test("explicit plan refresh survives shared quota deferral after restart", async () => {
  let calls = 0;
  const reader = createAccountUsageReader({
    upstreamURL: new URL("http://fixture.test"),
    managementKey: "fixture",
    now: () => start,
    quotaAdmission: {
      begin: async () => ({
        granted: false,
        nextAttemptAt: start + 60000,
        result: {
          plan: "Pro",
          checkedAt: start - 1000,
          windows: [{ label: "Weekly window", used: 20 }],
        },
      }),
    },
    fetcher: async (url, options) => {
      if (url.pathname.endsWith("credentials"))
        return Response.json({
          files: [{ auth_index: "a", provider: "claude" }],
        });
      assert.match(JSON.parse(options.body).url, /profile$/);
      calls++;
      return Response.json({ status_code: 200, body: JSON.stringify(profile) });
    },
  });
  const result = await reader("a", { refreshPlan: true });
  assert.equal(result.plan, "Ultra");
  assert.equal(calls, 1);
  await reader("a", { refreshPlan: true });
  assert.equal(calls, 1, "manual plan refresh must retain its own cooldown");
});
