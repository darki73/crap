import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startQuotaCollector } from "./affinity.mjs";
import {
  createAccountUsageReader,
  QUOTA_INTERVAL_MS,
} from "./account-usage.mjs";

function fixture() {
  let time = 0;
  let status = 200;
  let retryAfter;
  let plan = { organization_type: "claude_pro" };
  let profileStatus = 200;
  const calls = [];
  const options = {
    upstreamURL: new URL("http://fixture.test"),
    managementKey: "secret-management",
    now: () => time,
    fetcher: async (url, options) => {
      if (url.pathname.endsWith("credentials"))
        return Response.json({
          files: [{ auth_index: "private-auth-index", provider: "claude" }],
        });
      const body = JSON.parse(options.body);
      const endpoint = body.url.split("/").at(-1);
      calls.push(endpoint);
      return Response.json({
        status_code: endpoint === "usage" ? status : profileStatus,
        header: { "Retry-After": [retryAfter] },
        body: JSON.stringify(
          endpoint === "usage"
            ? { five_hour: { utilization: 1 } }
            : {
                organization: plan,
                account: { email: "private@example.com" },
                access_token: "private-token",
              },
        ),
      });
    },
  };
  return {
    options,
    calls,
    upgrade: () => {
      plan = {
        organization_type: "claude_max",
        rate_limit_tier: "default_claude_max_20x",
      };
    },
    failProfile: (retry) => {
      profileStatus = 429;
      retryAfter = retry;
    },
    advance: (ms) => {
      time += ms;
    },
    fail: (retry) => {
      status = 429;
      retryAfter = retry;
    },
    recover: () => {
      status = 200;
    },
  };
}

test("UI and collector share five-minute quota cache, while profile refreshes daily", async () => {
  const f = fixture();
  const reader = createAccountUsageReader(f.options);
  await Promise.all(
    Array.from({ length: 8 }, () => reader("private-auth-index")),
  );
  assert.deepEqual(f.calls, ["usage", "profile"]);
  f.advance(QUOTA_INTERVAL_MS - 1);
  await reader("private-auth-index");
  assert.equal(f.calls.length, 2);
  f.advance(1);
  await reader("private-auth-index");
  assert.deepEqual(f.calls, ["usage", "profile", "usage"]);
  f.advance(24 * 60 * 60000);
  await reader("private-auth-index");
  assert.deepEqual(f.calls.slice(-2), ["usage", "profile"]);
});

test("manual plan refresh picks up upgrades without refetching fresh quota and is throttled across restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "plan-cache-test-"));
  const cacheFile = join(directory, "cache.json");
  try {
    const f = fixture();
    const makeReader = () =>
      createAccountUsageReader({ ...f.options, cacheFile });
    const initial = await makeReader()("private-auth-index");
    f.upgrade();
    await makeReader()("private-auth-index", { refreshPlan: true });
    assert.deepEqual(f.calls, ["usage", "profile"]);
    f.advance(QUOTA_INTERVAL_MS);
    const quota = await makeReader()("private-auth-index");
    assert.equal(quota.plan, "Pro");
    const updated = await makeReader()("private-auth-index", {
      refreshPlan: true,
    });
    assert.equal(updated.plan, "Max 20×");
    assert.equal(updated.checkedAt, quota.checkedAt);
    assert.equal(updated.nextAttemptAt, quota.nextAttemptAt);
    assert.equal(updated.planCheckedAt, QUOTA_INTERVAL_MS);
    assert.deepEqual(f.calls, ["usage", "profile", "usage", "profile"]);
    assert.equal(
      JSON.stringify(updated.windows),
      JSON.stringify(quota.windows),
    );
    await makeReader()("private-auth-index", { refreshPlan: true });
    assert.equal(f.calls.length, 4);
    f.advance(QUOTA_INTERVAL_MS);
    f.failProfile("7200");
    const failure = await makeReader()("private-auth-index", {
      refreshPlan: true,
    });
    assert.equal(failure.plan, "Max 20×");
    assert.match(failure.profileError, /429/);
    f.advance(QUOTA_INTERVAL_MS);
    await makeReader()("private-auth-index", { refreshPlan: true });
    assert.equal(f.calls.filter((x) => x === "profile").length, 3);
    f.fail("900");
    f.advance(QUOTA_INTERVAL_MS);
    await makeReader()("private-auth-index", { refreshPlan: true });
    const before = f.calls.length;
    await makeReader()("private-auth-index", { refreshPlan: true });
    assert.equal(f.calls.length, before);
  } finally {
    await unlink(cacheFile).catch(() => {});
    await rmdir(directory);
  }
});

test("restart preserves sanitized observations and Retry-After/backoff without extra profile calls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quota-cache-test-"));
  const cacheFile = join(directory, "cache.json");
  try {
    const f = fixture();
    const makeReader = () =>
      createAccountUsageReader({ ...f.options, cacheFile });
    await makeReader()("private-auth-index");
    await makeReader()("private-auth-index");
    assert.equal(f.calls.length, 2);
    f.advance(QUOTA_INTERVAL_MS);
    f.fail("900");
    const failure = await makeReader()("private-auth-index");
    assert.match(failure.usageError, /429/);
    assert.equal(failure.nextAttemptAt, 20 * 60000);
    f.advance(10 * 60000);
    await makeReader()("private-auth-index");
    assert.equal(f.calls.length, 3);
    f.advance(5 * 60000);
    f.recover();
    const recovered = await makeReader()("private-auth-index");
    assert.equal(recovered.plan, "Pro");
    assert.equal(recovered.usageError, undefined);
    assert.deepEqual(f.calls, ["usage", "profile", "usage", "usage"]);
    const saved = await readFile(cacheFile, "utf8");
    for (const secret of [
      "private-auth-index",
      "private@example.com",
      "private-token",
      "secret-management",
    ])
      assert.ok(!saved.includes(secret));
  } finally {
    await unlink(`${cacheFile}.tmp`).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    await unlink(cacheFile).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    await rmdir(directory);
  }
});

test("collector inspects local headers every 15 seconds without extra provider calls", async () => {
  const f = fixture();
  const reader = createAccountUsageReader(f.options);
  await reader("private-auth-index");
  let ready;
  const scheduled = new Promise((resolve) => {
    ready = resolve;
  });
  const saved = [];
  const stop = startQuotaCollector({
    upstream: "http://fixture.test",
    controlURL: "http://control.test",
    managementKey: "test",
    token: "test",
    readUsage: reader,
    schedule: (_callback, delay) => {
      assert.equal(delay, 15_000);
      ready();
      return {};
    },
    cancel: () => {},
    fetcher: async (url, options) => {
      if (url.pathname.endsWith("credentials"))
        return Response.json({
          files: [
            {
              id: "fixture",
              auth_index: "private-auth-index",
              provider: "claude",
            },
          ],
        });
      saved.push(JSON.parse(options.body));
      return Response.json({ ok: true });
    },
  });
  await scheduled;
  assert.equal(f.calls.length, 2);
  assert.equal(saved[0].windows[0].used, 1);
  stop();
});
