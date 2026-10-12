import test from "node:test";
import assert from "node:assert/strict";
import {
  secretCodec,
  createIntegrations,
  TelegramError,
  telegramClient,
  validDashboardURL,
  dashboardAddress,
  notificationCandidates,
} from "./integrations.mjs";
import { accountLabels } from "./account-labels.mjs";
import { createHash } from "node:crypto";

const key = "ab".repeat(32),
  botToken = "123456789:" + "fixture_secret_".repeat(3);

test("notification copy identifies accounts privately, uses window labels once and shows UTC resets", () => {
  const now = Date.parse("2026-10-06T00:00:00Z");
  const files = [
    {
      id: "secret-filename",
      provider: "claude",
      email: "alice@example.com",
      status: "error",
    },
    {
      id: "another-secret",
      label: "Work bob@example.com",
      email: "bob@example.com",
    },
  ];
  const labels = accountLabels(files, key);
  const ids = Object.keys(labels);
  const settings = {
    telegram: {
      alerts: { quota: true, account: true, daily: true },
      threshold: 20,
      digestHour: 0,
    },
  };
  const summary = {
    quotas: ids.map((account_id, i) => ({
      account_id,
      provider: "claude",
      observed_at: new Date(now).toISOString(),
      windows: [
        {
          label: i ? "Weekly · Fable" : "Weekly window",
          used: 97,
          resetAt: i ? null : now + 27 * 3600_000,
        },
      ],
    })),
    daily: {
      requests: 1234,
      tokens: "9007199254740993",
      failed: 0,
      unknown: 1,
    },
  };
  const messages = notificationCandidates(
    settings,
    summary,
    files,
    now,
    labels,
  );
  assert.match(
    messages[0].text,
    /Claude · a•••@e•••\nWeekly window: 3% remaining/,
  );
  assert.match(messages[0].text, /Resets in 1d 3h · 07 Oct 2026, 03:00 UTC/);
  assert.match(messages[1].text, /Work b•••@e•••/);
  assert.match(messages[1].text, /Reset time not reported/);
  assert.match(messages[2].text, /Claude · a•••@e•••/);
  assert.match(messages[3].text, /Upstream requests: 1,234/);
  assert.match(messages[3].text, /Reported tokens: 9,007,199,254,740,993/);
  const text = messages.map((x) => x.text).join("\n");
  for (const secret of [
    "alice@example.com",
    "bob@example.com",
    "secret-filename",
    "another-secret",
    "window window",
    ...ids,
  ])
    assert.equal(text.includes(secret), false);
  const fallback = notificationCandidates(settings, summary, [], now);
  assert.match(fallback[0].text, /Claude · Account/);
  summary.quotas[0].windows[0].resetAt = now - 1;
  assert.equal(
    notificationCandidates(settings, summary, [], now).filter(
      (x) => x.kind === "quota",
    ).length,
    1,
  );
});
function fixture() {
  const codec = secretCodec(key);
  let record = { version: 0, encrypted: "" },
    runtime = { phase: "disconnected" },
    time = Date.parse("2026-10-05T09:00:00Z"),
    updates = [],
    hook = "",
    failSend = null,
    sendCount = 0,
    lease = true;
  const calls = [];
  const store = {
    async load() {
      return { version: record.version, data: codec.open(record.encrypted) };
    },
    async save(d) {
      assert.equal(d.version, record.version);
      record = { version: record.version + 1, encrypted: codec.seal(d.data) };
      d.version = record.version;
    },
    async lease() {
      return lease;
    },
    async summary() {
      return {
        daily: { requests: 5, tokens: "123", unknown: 1, failed: 0 },
        quotas: [
          {
            account_id: "private-opaque-id",
            provider: "claude",
            windows: [
              {
                label: "weekly",
                used: 95,
                resetAt: Date.parse("2026-10-06T09:00:00Z"),
              },
            ],
            observed_at: new Date(time).toISOString(),
            error: false,
          },
        ],
      };
    },
  };
  const tailnet = {
    status: () => runtime,
    installed: async () => true,
    enrolled: async () => false,
    start: async () => {
      runtime = {
        phase: "online",
        dashboardUrl: "https://crap.example.ts.net",
      };
    },
    stop: async () => {
      runtime = { phase: "disconnected" };
    },
  };
  const telegram = async (token, method, payload) => {
    assert.equal(token, botToken);
    calls.push({ method, payload });
    if (method === "getMe") return { is_bot: true, username: "fixture_bot" };
    if (method === "getWebhookInfo") return { url: hook };
    if (method === "getUpdates") return updates;
    if (method === "sendMessage") {
      sendCount++;
      if (failSend) throw failSend;
      return { message_id: sendCount };
    }
    throw new Error("Unexpected Telegram method");
  };
  const config = {
    store,
    tailnet,
    telegram,
    managementKey: "test",
    now: () => time,
    fetcher: async () => ({
      ok: true,
      json: async () => ({ files: [], access: { "api-keys": ["fixture"] } }),
    }),
  };
  let manager = createIntegrations(config);
  return {
    get manager() {
      return manager;
    },
    calls,
    store,
    config,
    get record() {
      return record;
    },
    get sendCount() {
      return sendCount;
    },
    get time() {
      return time;
    },
    advance(ms) {
      time += ms;
    },
    setUpdates(v) {
      updates = v;
    },
    setHook(v) {
      hook = v;
    },
    setFail(v) {
      failSend = v;
    },
    setLease(v) {
      lease = v;
    },
    restart() {
      manager = createIntegrations(config);
    },
    async connect() {
      await manager.action("telegram/connect", { token: botToken });
      await manager.action("telegram/pair");
      const code = (await store.load()).data.pair.code;
      updates = [
        {
          update_id: 1,
          message: {
            chat: { id: 12345, type: "private" },
            from: { id: 12345 },
            text: `/start ${code}`,
            date: Math.floor(time / 1000),
          },
        },
      ];
      await manager.tick();
    },
  };
}
test("integration secrets are encrypted, authenticated and tied to the preserved workspace key", () => {
  const c = secretCodec(key),
    sealed = c.seal({ token: botToken });
  assert.equal(sealed.includes(botToken), false);
  assert.deepEqual(c.open(sealed), { token: botToken });
  assert.throws(() => secretCodec("cd".repeat(32)).open(sealed), /decrypt/);
  const bytes = Buffer.from(sealed, "base64");
  bytes[30] ^= 1;
  assert.throws(() => c.open(bytes.toString("base64")), /decrypt/);
});
test("no credentials means no enrollment, Telegram calls or notifications", async () => {
  const f = fixture();
  await f.manager.tick();
  assert.equal(f.calls.length, 0);
  assert.equal((await f.manager.status()).tailscale.phase, "disconnected");
});
test("pairing requires the fresh single-use code and a private matching user chat", async () => {
  const f = fixture();
  await f.manager.action("telegram/connect", { token: botToken });
  await f.manager.action("telegram/pair");
  const code = (await f.store.load()).data.pair.code;
  f.setUpdates([
    {
      update_id: 1,
      message: {
        chat: { type: "group", id: 12345 },
        from: { id: 12345 },
        text: `/start ${code}`,
        date: f.time / 1000,
      },
    },
    {
      update_id: 2,
      message: {
        chat: { type: "private", id: 12345 },
        from: { id: 12345 },
        text: "/start wrong",
        date: f.time / 1000,
      },
    },
  ]);
  await f.manager.tick();
  assert.equal((await f.manager.status()).telegram.paired, false);
  f.setUpdates([
    {
      update_id: 3,
      message: {
        chat: { type: "private", id: 12345 },
        from: { id: 12345 },
        text: `/start ${code}`,
        date: f.time / 1000,
      },
    },
  ]);
  await f.manager.tick();
  const status = await f.manager.status();
  assert.equal(status.telegram.paired, true);
  assert.equal(status.telegram.pairing, null);
  assert.equal(JSON.stringify(status).includes(botToken), false);
  assert.equal(f.record.encrypted.includes(botToken), false);
  assert.equal(f.sendCount, 0);
});
test("pairing expires without accepting delayed messages", async () => {
  const f = fixture();
  await f.manager.action("telegram/connect", { token: botToken });
  await f.manager.action("telegram/pair");
  f.advance(601_000);
  await f.manager.tick();
  assert.equal((await f.manager.status()).telegram.pairing, null);
});

test("pairing wakes the worker immediately, polls quickly and leaves notification cadence unchanged", async (t) => {
  const f = fixture();
  await f.connect();
  await f.manager.action("telegram/preferences", {
    enabled: true,
    threshold: 20,
    digestHour: 9,
    alerts: {},
    dashboardAddress: "",
  });
  f.setUpdates([]);
  let pending,
    summaryCalls = 0;
  const summary = f.store.summary;
  f.store.summary = async () => {
    summaryCalls++;
    return summary();
  };
  f.config.scheduler = {
    setTimeout(fn, delay) {
      pending = { fn, delay };
      return pending;
    },
    clearTimeout(handle) {
      if (pending === handle) pending = null;
    },
  };
  f.restart();
  t.after(() => f.manager.stop());
  async function runNext() {
    const task = pending;
    pending = null;
    f.advance(task.delay);
    await task.fn();
  }
  f.manager.start();
  await runNext();
  assert.equal(pending.delay, 15_000);
  assert.equal(summaryCalls, 1);
  await f.manager.action("telegram/pair");
  assert.equal(pending.delay, 0);
  await runNext();
  assert.equal(pending.delay, 2_000);
  await runNext();
  assert.equal(summaryCalls, 1);
  const pair = (await f.store.load()).data.pair;
  f.setUpdates([
    {
      update_id: 2,
      message: {
        chat: { id: 67890, type: "private" },
        from: { id: 67890 },
        text: `/start ${pair.code}`,
        date: Math.floor(f.time / 1000),
      },
    },
  ]);
  await runNext();
  assert.equal((await f.manager.status()).telegram.paired, true);
  assert.equal((await f.store.load()).data.telegram.chatId, "67890");
  assert.equal(pending.delay, 11_000);
  await runNext();
  assert.equal(summaryCalls, 2);
  assert.equal(pending.delay, 15_000);
});

test("fast pairing checks still honor Telegram backoff and stop after cancellation", async () => {
  const f = fixture();
  await f.manager.action("telegram/connect", { token: botToken });
  await f.manager.action("telegram/pair");
  let polls = 0;
  f.config.telegram = async () => {
    polls++;
    throw new TelegramError("limited", 37);
  };
  f.restart();
  await f.manager.tick({ maintenance: false });
  f.advance(2_000);
  await f.manager.tick({ maintenance: false });
  assert.equal(polls, 1);
  f.advance(35_000);
  await f.manager.tick({ maintenance: false });
  assert.equal(polls, 2);
  await f.manager.action("telegram/cancel-pair");
  f.advance(40_000);
  assert.equal(await f.manager.tick({ maintenance: false }), 15_000);
  assert.equal(polls, 2);
});
test("existing bot webhook is preserved and prevents takeover", async () => {
  const f = fixture();
  f.setHook("https://other.example/webhook");
  await assert.rejects(
    f.manager.action("telegram/connect", { token: botToken }),
    /active webhook/,
  );
  assert.equal((await f.manager.status()).telegram.configured, false);
  assert.equal(
    f.calls.some((x) => x.method === "deleteWebhook"),
    false,
  );
});
test("Telegram links follow live Tailscale state and omit unusable addresses", async () => {
  const f = fixture();
  await f.connect();
  await f.manager.action("telegram/preferences", {
    enabled: false,
    threshold: 20,
    digestHour: 9,
    alerts: {},
    dashboardAddress: "https://fallback.example",
  });
  await f.manager.action("telegram/test");
  assert.equal(
    f.calls.at(-1).payload.reply_markup.inline_keyboard[0][0].url,
    "https://fallback.example/#setup",
  );
  await f.manager.action("tailscale/connect", {
    hostname: "crap",
    allowedUsers: ["owner@example.com"],
    dashboard: true,
    api: false,
  });
  await f.manager.action("telegram/test");
  assert.equal(
    f.calls.at(-1).payload.reply_markup.inline_keyboard[0][0].url,
    "https://crap.example.ts.net/#setup",
  );
  await f.manager.action("tailscale/disconnect");
  await f.manager.action("telegram/test");
  assert.equal(
    f.calls.at(-1).payload.reply_markup.inline_keyboard[0][0].url,
    "https://fallback.example/#setup",
  );
  assert.equal(
    dashboardAddress(
      {
        tailscale: { enabled: true, dashboard: true },
        dashboardAddress: "https://fallback.example",
      },
      { phase: "disconnected" },
    ),
    null,
  );
  for (const url of [
    "http://localhost:5173",
    "http://127.0.0.1",
    "https://user:secret@example.com",
    "javascript:alert(1)",
  ])
    assert.equal(validDashboardURL(url), null);
});
test("quota alert deduplication survives restart and respects provider rate backoff", async () => {
  const f = fixture();
  await f.connect();
  await f.manager.action("telegram/preferences", {
    enabled: true,
    threshold: 20,
    digestHour: 9,
    alerts: { quota: true },
    dashboardAddress: "",
  });
  f.setFail(new TelegramError("limited", 120));
  await f.manager.tick();
  assert.equal(f.sendCount, 1);
  assert.equal((await f.manager.status()).deliveries[0].status, "pending");
  f.restart();
  await f.manager.tick();
  assert.equal(f.sendCount, 1);
  f.advance(121_000);
  f.setFail(null);
  await f.manager.tick();
  assert.equal(f.sendCount, 2);
  assert.equal(
    (await f.manager.status()).deliveries.filter((x) => x.status === "sent")
      .length,
    1,
  );
  await f.manager.tick();
  assert.equal(f.sendCount, 2);
});

test("quota reset jitter stays quiet across refreshes and restarts, recovery and rollover rearm alerts", async () => {
  const f = fixture();
  await f.connect();
  await f.manager.action("telegram/preferences", {
    enabled: true,
    threshold: 20,
    digestHour: 9,
    alerts: { quota: true },
    dashboardAddress: "",
  });
  const summary = f.store.summary;
  let used = 97,
    drift = 0,
    missing = false,
    stale = false;
  f.store.summary = async () => {
    const s = await summary();
    Object.assign(s.quotas[0].windows[0], {
      used,
      resetAt: missing ? null : Date.parse("2026-10-06T09:00:00Z") + drift,
    });
    if (stale)
      s.quotas[0].observed_at = new Date(f.time - 10 * 60_000).toISOString();
    return s;
  };
  await f.manager.tick();
  assert.equal(f.sendCount, 1);
  for (const offset of [-55_000, 123, 61_000, -42_789, 2000]) {
    f.advance(5 * 60_000);
    drift = offset;
    f.restart();
    await f.manager.tick();
  }
  assert.equal(
    f.sendCount,
    1,
    "changing reset estimates created duplicate alerts",
  );
  missing = true;
  f.advance(5 * 60_000);
  await f.manager.tick();
  missing = false;
  used = 100;
  await f.manager.tick();
  assert.equal(f.sendCount, 1);
  used = 10;
  stale = true;
  await f.manager.tick();
  stale = false;
  used = 97;
  await f.manager.tick();
  assert.equal(f.sendCount, 1, "older healthy observation rearmed alert");
  used = 10;
  f.advance(1000);
  await f.manager.tick();
  used = 97;
  f.advance(1000);
  await f.manager.tick();
  assert.equal(f.sendCount, 2, "recovery did not rearm alert");
  f.advance(Date.parse("2026-10-06T09:01:00Z") - f.time);
  drift = 7 * 86400_000;
  await f.manager.tick();
  assert.equal(f.sendCount, 3, "new window did not rearm alert");
  f.restart();
  drift -= 30_000;
  f.advance(5 * 60_000);
  await f.manager.tick();
  assert.equal(f.sendCount, 3);
});

test("unknown reset times do not create daily repeat alerts and accounts/windows remain independent", () => {
  const now = Date.parse("2026-10-06T23:59:00Z");
  const s = { telegram: { alerts: { quota: true }, threshold: 20 } };
  const summary = {
    quotas: [
      {
        account_id: "a",
        provider: "claude",
        observed_at: new Date(now).toISOString(),
        windows: [
          { label: "weekly", used: 97 },
          { label: "five-hour", used: 97 },
        ],
      },
    ],
  };
  const first = notificationCandidates(s, summary, [], now);
  summary.quotas[0].observed_at = new Date(now + 300_000).toISOString();
  const second = notificationCandidates(s, summary, [], now + 300_000);
  assert.deepEqual(
    second.map((x) => x.key),
    first.map((x) => x.key),
  );
  summary.quotas.push({ ...summary.quotas[0], account_id: "b" });
  assert.equal(
    new Set(
      notificationCandidates(s, summary, [], now + 300_000).map((x) => x.key),
    ).size,
    4,
  );
});

test("legacy quota messages seed stable episodes despite reset drift and suppress queued duplicates", () => {
  const now = Date.parse("2026-10-06T00:00:00Z"),
    resetAt = now + 86400_000;
  const legacy = createHash("sha256")
    .update(`quota:account:Weekly window:${resetAt}`)
    .digest("hex");
  const text =
    "CRAP · Quota running low\nClaude · a•••@e•••\nWeekly window: 3% remaining.\nResets in 1d · 07 Oct 2026, 00:00 UTC.";
  const s = {
    telegram: { alerts: { quota: true }, threshold: 20 },
    seen: { [legacy]: now - 300_000 },
    outbox: [
      {
        key: legacy,
        kind: "quota",
        text,
        status: "sent",
        createdAt: now - 300_000,
      },
      {
        key: "different-old-hash",
        kind: "quota",
        text,
        status: "pending",
        createdAt: now - 1000,
      },
    ],
  };
  const summary = {
    quotas: [
      {
        account_id: "account",
        provider: "claude",
        observed_at: new Date(now).toISOString(),
        windows: [
          { label: "Weekly window", used: 98, resetAt: resetAt - 35_123 },
        ],
      },
    ],
  };
  const [event] = notificationCandidates(s, summary, [], now, {
    account: "a•••@e•••",
  });
  assert.ok(s.seen[createHash("sha256").update(event.key).digest("hex")]);
  assert.equal(s.outbox[1].status, "superseded");
});
test("uncertain delivery is visible and never automatically duplicated", async () => {
  const f = fixture();
  await f.connect();
  f.setFail(new TelegramError("not confirmed", 0, true));
  await f.manager.action("telegram/test");
  assert.equal((await f.manager.status()).deliveries[0].status, "unknown");
  f.restart();
  f.setFail(null);
  await f.manager.tick();
  assert.equal(f.sendCount, 1);
});
test("another worker lease blocks message delivery and Tailscale enrollment", async () => {
  const f = fixture();
  await f.connect();
  f.setLease(false);
  await assert.rejects(f.manager.action("telegram/test"), /Another/);
  await assert.rejects(
    f.manager.action("tailscale/connect", {
      hostname: "crap",
      allowedUsers: ["owner@example.com"],
      dashboard: true,
    }),
    /Another/,
  );
  assert.equal(f.sendCount, 0);
});
test("Telegram errors sanitize provider text while preserving retry_after", async () => {
  const client = telegramClient(async () => ({
    ok: false,
    status: 429,
    json: async () => ({
      ok: false,
      error_code: 429,
      description: botToken,
      parameters: { retry_after: 37 },
    }),
  }));
  await assert.rejects(client(botToken, "sendMessage", {}), (error) => {
    assert.equal(error.retryAfter, 37);
    assert.equal(error.message.includes(botToken), false);
    return true;
  });
});

test("LAN settings persist without contacting providers and retain the public probe identifier", async () => {
  const f = fixture();
  await f.manager.action("lan/configure", {
    enabled: true,
    dashboardOrigin: "https://panel.example.com/",
    apiOrigin: "https://api.example.com",
  });
  const lan = (await f.manager.status()).lanAccess;
  assert.equal(lan.dashboardOrigin, "https://panel.example.com");
  assert.match(lan.probeId, /^[a-f0-9-]{36}$/);
  await f.manager.action("lan/configure", { enabled: false });
  assert.equal((await f.manager.status()).lanAccess.enabled, false);
  await f.manager.action("lan/configure", {
    ...lan,
    apiOrigin: "https://other.example.com",
  });
  assert.equal((await f.manager.status()).lanAccess.probeId, lan.probeId);
  for (const address of [
    "http://panel.example.com",
    "https://user:pass@panel.example.com",
    "https://panel.example.com/v1",
    "https://panel.example.com?key=secret",
  ]) {
    await assert.rejects(
      f.manager.action("lan/configure", { ...lan, apiOrigin: address }),
    );
  }
});
