import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  randomUUID,
  createHash,
} from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { access } from "node:fs/promises";
import path from "node:path";
import { privateDirectory } from "./database-transfer.mjs";
import { accountDisplayLabel, accountLabels } from "./account-labels.mjs";
import { localAPIOrigin } from "./local-api-origin.mjs";

const defaults = () => ({
  tailscale: {
    enabled: false,
    hostname: "crap",
    allowedUsers: [],
    dashboard: true,
    api: false,
  },
  telegram: {
    enabled: false,
    token: "",
    username: "",
    chatId: "",
    alerts: { account: true, quota: true, service: true, daily: false },
    threshold: 20,
    digestHour: 9,
  },
  dashboardAddress: "",
  outbox: [],
  seen: {},
  pair: null,
  offset: 0,
  healthFailures: 0,
});
const digest = (x) => createHash("sha256").update(x).digest("hex");
export function secretCodec(hexKey) {
  if (!/^(?:[a-f0-9]{2}){32,}$/i.test(hexKey || ""))
    throw new Error("Workspace encryption key is unavailable.");
  const key = Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(hexKey, "hex"),
      Buffer.from("crap-integrations"),
      Buffer.from("v1"),
      32,
    ),
  );
  return {
    seal(value) {
      const iv = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from("crap-integrations-v1"));
      const data = Buffer.concat([
        cipher.update(JSON.stringify(value)),
        cipher.final(),
      ]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
    },
    open(value) {
      if (!value) return defaults();
      try {
        const b = Buffer.from(value, "base64"),
          dec = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
        dec.setAAD(Buffer.from("crap-integrations-v1"));
        dec.setAuthTag(b.subarray(12, 28));
        return JSON.parse(
          Buffer.concat([dec.update(b.subarray(28)), dec.final()]).toString(),
        );
      } catch {
        throw new Error(
          "Cannot decrypt integration settings. Restore the original workspace identity key.",
        );
      }
    },
  };
}
export function validDashboardURL(value) {
  try {
    const u = new URL(value.trim());
    const host = u.hostname.toLowerCase();
    if (
      !["https:", "http:"].includes(u.protocol) ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host.startsWith("127.") ||
      ["[::1]", "[::]", "0.0.0.0"].includes(host)
    )
      return null;
    return u.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}
export function dashboardAddress(settings, runtime) {
  if (settings.tailscale.enabled && settings.tailscale.dashboard)
    return runtime.phase === "online"
      ? validDashboardURL(runtime.dashboardUrl || "")
      : null;
  return validDashboardURL(settings.dashboardAddress || "");
}
export function createIntegrationStore({ url, token, key, fetcher = fetch }) {
  const codec = secretCodec(key);
  async function control(route, method = "GET", body) {
    let response;
    try {
      response = await fetcher(new URL(route, url), {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: "error",
      });
    } catch {
      throw new Error("Integration storage is unavailable.");
    }
    if (!response.ok)
      throw new Error(
        response.status === 409
          ? "Integration settings changed. Refresh and try again."
          : "Integration storage is unavailable or paused for database migration.",
      );
    return response.json();
  }
  return {
    async load() {
      const d = await control("/integrations");
      return { version: d.version, data: codec.open(d.encrypted) };
    },
    async save(d) {
      const result = await control("/integrations", "PUT", {
        version: d.version,
        encrypted: codec.seal(d.data),
      });
      d.version = result.version;
    },
    async lease(owner) {
      return (await control("/integrations/lease", "POST", { owner })).granted;
    },
    summary: () => control("/integrations/summary"),
  };
}
export function createTailnetRuntime({
  root,
  launch = spawn,
  panelURL = "http://127.0.0.1:3001",
  proxyURL = "http://127.0.0.1:8317",
  executable: overrideExecutable,
}) {
  let child = null,
    state = { phase: "disconnected" };
  const directory = path.join(root, ".local-panel/tailscale");
  const executable =
    overrideExecutable ||
    path.join(
      root,
      ".local-panel",
      process.platform === "win32" ? "tailnet-gateway.exe" : "tailnet-gateway",
    );
  return {
    status: () => ({ ...state }),
    async installed() {
      try {
        await access(executable);
        return true;
      } catch {
        return false;
      }
    },
    async enrolled() {
      try {
        await access(path.join(directory, "tailscaled.state"));
        return true;
      } catch {
        return false;
      }
    },
    async start(config, authKey = "") {
      if (child)
        throw new Error(
          "Disconnect private access before changing its configuration.",
        );
      await privateDirectory(directory);
      await access(executable).catch(() => {
        throw new Error(
          "Build the Tailscale gateway first with npm run tailscale:build.",
        );
      });
      const env = { ...process.env };
      for (const key of Object.keys(env))
        if (key.startsWith("TS_") || key.startsWith("TSNET_")) delete env[key];
      const processChild = launch(executable, [], {
        cwd: root,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env,
      });
      child = processChild;
      state = { phase: "connecting" };
      processChild.stderr.resume();
      processChild.stdin.on("error", () => {});
      const lines = createInterface({ input: processChild.stdout });
      lines.on("line", (line) => {
        if (child !== processChild || line.length > 8192) return;
        try {
          const value = JSON.parse(line);
          if (
            !["connecting", "online", "needs-https", "error"].includes(
              value.phase,
            )
          )
            return;
          const next = { phase: value.phase };
          if (value.authUrl) {
            const url = new URL(value.authUrl);
            if (
              url.protocol === "https:" &&
              url.hostname === "login.tailscale.com"
            )
              next.authUrl = url.toString();
          }
          for (const k of ["dashboardUrl", "apiUrl"])
            if (value[k]) {
              const url = new URL(value[k]);
              if (url.protocol === "https:" && url.hostname.endsWith(".ts.net"))
                next[k] = url.toString().replace(/\/$/, "");
            }
          if (value.error)
            next.error =
              value.phase === "needs-https"
                ? "Enable MagicDNS and HTTPS certificates in Tailscale, then reconnect."
                : "Private access stopped. Check enrollment, HTTPS and local service availability.";
          state = next;
        } catch {
          /* Non-status output is never exposed. */
        }
      });
      processChild.on("error", () => {
        if (child === processChild) {
          child = null;
          state = {
            phase: "error",
            error: "The private-access gateway could not start.",
          };
        }
      });
      processChild.on("exit", () => {
        if (child === processChild) {
          child = null;
          state = {
            phase: "error",
            error: "Private access stopped. Reconnect from setup.",
          };
        }
      });
      processChild.stdin.write(
        JSON.stringify({
          ...config,
          dir: directory,
          authKey,
          panelURL,
          proxyURL,
        }) + "\n",
      );
    },
    async stop() {
      const old = child;
      child = null;
      state = { phase: "disconnected" };
      if (old) {
        old.stdin.end();
        await new Promise((resolve) => old.once("exit", resolve));
      }
    },
  };
}
export class TelegramError extends Error {
  constructor(message, retryAfter = 0, uncertain = false) {
    super(message);
    this.retryAfter = retryAfter;
    this.uncertain = uncertain;
  }
}
export function telegramClient(fetcher = fetch) {
  return async (token, method, payload = {}) => {
    let response, body;
    try {
      response = await fetcher(
        `https://api.telegram.org/bot${token}/${method}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          redirect: "error",
        },
      );
      body = await response.json();
    } catch {
      throw new TelegramError(
        "Telegram could not confirm the request.",
        0,
        method === "sendMessage",
      );
    }
    if (!response.ok || !body.ok) {
      const code = body.error_code || response.status;
      throw new TelegramError(
        code === 429
          ? "Telegram rate limit reached. Waiting before retrying."
          : code === 401
            ? "Telegram rejected the bot token."
            : code === 409
              ? "This bot has another update consumer. Use a dedicated bot."
              : "Telegram rejected the request. Check the bot and private chat.",
        code === 429
          ? Math.max(
              1,
              Math.min(86400, Number(body.parameters?.retry_after) || 60),
            )
          : 0,
        code >= 500 && method === "sendMessage",
      );
    }
    return body.result;
  };
}
function providerName(provider) {
  return (
    {
      claude: "Claude",
      codex: "Codex",
      gemini: "Gemini",
      antigravity: "Antigravity",
    }[provider] || "Provider"
  );
}
function countText(value) {
  const text = String(value ?? 0);
  return /^\d+$/.test(text) ? BigInt(text).toLocaleString("en-US") : "0";
}
function resetText(resetAt, now) {
  if (
    typeof resetAt !== "number" ||
    !Number.isFinite(resetAt) ||
    !Number.isFinite(new Date(resetAt).getTime())
  )
    return "Reset time not reported.";
  const minutes = Math.max(1, Math.ceil((resetAt - now) / 60_000));
  const days = Math.floor(minutes / 1440),
    hours = Math.floor((minutes % 1440) / 60),
    mins = minutes % 60;
  const duration = [
    days && `${days}d`,
    hours && `${hours}h`,
    mins && `${mins}m`,
  ]
    .filter(Boolean)
    .slice(0, 2)
    .join(" ");
  const date = new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(resetAt));
  return `Resets in ${duration} · ${date} UTC.`;
}
// Provider reset estimates can drift on every refresh. Anchor each low-quota
// episode to durable state instead of using the estimate itself as its identity.
function quotaAlertKey(s, account, window, observed, now, low, text, hasLabel) {
  const tolerance = 5 * 60_000;
  const identity = digest(
    JSON.stringify([account.account_id, account.provider, window.label]),
  );
  const reset =
    Number.isFinite(window.resetAt) && window.resetAt > 0
      ? window.resetAt
      : null;
  s.quotaAlerts ??= {};
  let state = s.quotaAlerts[identity];
  if (state && observed < state.observed) return null;
  const newWindow =
    state?.resetAt &&
    reset &&
    reset > state.resetAt + tolerance &&
    observed >= state.resetAt - tolerance;
  const initial = !state;
  if (!state || newWindow || (low && !state.low)) {
    state = { episode: randomUUID(), resetAt: reset, observed, low };
    s.quotaAlerts[identity] = state;
  }
  state.observed = observed;
  state.lastSeen = now;
  state.low = low;
  // Keep the original anchor when the estimate drifts or temporarily disappears.
  if (!state.resetAt && reset) state.resetAt = reset;
  const key = `quota-episode:${identity}:${state.episode}`;
  if (initial && low) {
    // Upgrade existing alerts without sending one more copy. Old records only
    // have a hashed key and display text, so match the current legacy key first.
    const legacy = digest(
      `quota:${account.account_id}:${window.label}:${window.resetAt || new Date(now).toISOString().slice(0, 10)}`,
    );
    const prefix = text.slice(0, text.lastIndexOf(": "));
    const previous = (s.outbox || []).filter((event) => {
      if (event.kind !== "quota") return false;
      if (event.key === legacy) return true;
      if (!hasLabel || !event.text.startsWith(prefix + ": ")) return false;
      const match = event.text.match(
        /· (\d{2} [A-Za-z]{3} \d{4}), (\d{2}:\d{2}) UTC\.$/,
      );
      const oldReset = match
        ? Date.parse(`${match[1]} ${match[2]}:00 GMT`)
        : null;
      return reset && oldReset
        ? Math.abs(reset - oldReset) <= tolerance
        : !reset && !oldReset && now - event.createdAt < 86400_000;
    });
    s.seen ??= {};
    const alreadySeen = s.seen[legacy] || previous[0]?.createdAt;
    if (alreadySeen) s.seen[digest(key)] = alreadySeen;
    // Preserve at most one pending delivery (including its Retry-After), or none
    // if an earlier copy was already sent or its delivery is uncertain.
    let keepPending = !previous.some((event) =>
      ["sent", "sending", "unknown"].includes(event.status),
    );
    for (const event of previous) {
      if (event.status !== "pending") continue;
      if (keepPending) {
        keepPending = false;
        continue;
      }
      event.status = "superseded";
    }
  }
  for (const [id, entry] of Object.entries(s.quotaAlerts)) {
    if (now - entry.lastSeen > 32 * 86400_000) delete s.quotaAlerts[id];
  }
  return low ? key : null;
}
export function notificationCandidates(s, summary, files, now, labels = {}) {
  const result = [],
    prefs = s.telegram,
    day = new Date(now).toISOString().slice(0, 10);
  if (prefs.alerts.quota)
    for (const account of summary.quotas || []) {
      const observed = Date.parse(account.observed_at);
      if (
        account.error ||
        !Number.isFinite(observed) ||
        observed > now + 60_000 ||
        now - observed > 15 * 60_000
      )
        continue;
      for (const w of account.windows || []) {
        const windowObserved = w.observedAt ?? observed;
        if (
          !Number.isFinite(windowObserved) ||
          windowObserved > now + 60_000 ||
          now - windowObserved > 15 * 60_000
        )
          continue;
        if (
          typeof w.used !== "number" ||
          !Number.isFinite(w.used) ||
          w.used < 0 ||
          (w.resetAt && w.resetAt <= now)
        )
          continue;
        const remaining = Math.max(0, 100 - w.used);
        const text = `CRAP · Quota running low\n${providerName(account.provider)} · ${labels[account.account_id] || "Account"}\n${String(
          w.label || "Usage window",
        )
          .replace(/[^\s<>/@]+@[^\s<>/@]+/g, "[private]")
          .replace(/[\r\n\t]+/g, " ")
          .slice(
            0,
            80,
          )}: ${Math.round(remaining)}% remaining.\n${resetText(w.resetAt, now)}`;
        const key = quotaAlertKey(
          s,
          account,
          w,
          windowObserved,
          now,
          remaining <= prefs.threshold,
          text,
          !!labels[account.account_id],
        );
        if (!key) continue;
        result.push({
          key,
          kind: "quota",
          page: "usage",
          text,
        });
      }
    }
  if (prefs.alerts.account)
    for (const account of files || []) {
      if (
        account.disabled ||
        !["error", "unavailable"].includes(account.status)
      )
        continue;
      result.push({
        key: `account:${digest(String(account.id || account.name))}:${day}`,
        kind: "account",
        page: "providers",
        text: `CRAP · Account needs attention\n${providerName(account.provider)} · ${accountDisplayLabel(account) || "Account"}\nThis enabled account is reporting an error. Open Accounts & Providers to review it.`,
      });
    }
  if (prefs.alerts.daily && new Date(now).getUTCHours() >= prefs.digestHour) {
    const d = summary.daily || {};
    result.push({
      key: `daily:${day}`,
      kind: "daily",
      page: "ledger",
      text: `CRAP · Last 24 hours\nUpstream requests: ${countText(d.requests)}\nReported tokens: ${countText(d.tokens)}\nFailed requests: ${countText(d.failed)}\nRequests with unknown token totals: ${countText(d.unknown)}`,
    });
  }
  return result;
}

export function createIntegrations({
  store,
  tailnet,
  managementKey,
  identityKey,
  upstream = "http://127.0.0.1:8317",
  localApiOrigin = process.env.PANEL_LOCAL_API_ORIGIN ||
    "http://localhost:8317",
  fetcher = fetch,
  telegram = telegramClient(fetcher),
  now = Date.now,
  scheduler = { setTimeout, clearTimeout },
}) {
  const owner = randomUUID();
  let chain = Promise.resolve(),
    timer,
    watchdog,
    leaseUntil = 0,
    stopped = false,
    started = false,
    running = false,
    nextMaintenance = 0,
    lastWorkerError = "";
  const exclusive = (fn) => {
    const job = chain.then(fn);
    chain = job.catch(() => {});
    return job;
  };
  async function proxy(route) {
    let r;
    try {
      r = await fetcher(new URL(`/v8/management/${route}`, upstream), {
        headers: { Authorization: `Bearer ${managementKey}` },
        redirect: "error",
      });
    } catch {
      throw new Error("The local proxy is unavailable.");
    }
    if (!r.ok) throw new Error("The local proxy is unavailable.");
    return r.json();
  }
  function publicState(s) {
    const t = s.telegram,
      runtime = tailnet.status();
    return {
      localApiOrigin: localAPIOrigin(localApiOrigin),
      tailscale: { ...s.tailscale, ...runtime },
      telegram: {
        enabled: t.enabled,
        configured: !!t.token,
        username: t.username,
        paired: !!t.chatId,
        chatLabel: t.chatId
          ? `Private chat · •••${String(t.chatId).slice(-4)}`
          : "",
        alerts: t.alerts,
        threshold: t.threshold,
        digestHour: t.digestHour,
        pairing:
          s.pair && s.pair.expires > now()
            ? {
                url: `https://t.me/${t.username}?start=${s.pair.code}`,
                expires: s.pair.expires,
              }
            : null,
      },
      dashboardAddress: s.dashboardAddress,
      notificationBase: dashboardAddress(s, runtime),
      deliveries: s.outbox
        .slice(-20)
        .reverse()
        .map(({ id, kind, status, createdAt, error }) => ({
          id,
          kind,
          status,
          createdAt,
          error,
        })),
      workerError: lastWorkerError,
    };
  }
  async function loaded() {
    const d = await store.load();
    d.data = { ...defaults(), ...d.data };
    return d;
  }
  async function lease() {
    if (!(await store.lease(owner)))
      throw new Error(
        "Another integration worker is active. Retry after its lease expires.",
      );
    leaseUntil = now() + 60_000;
  }
  async function enqueue(d, event) {
    const key = digest(event.key);
    if (d.data.seen[key]) return;
    const id = randomUUID();
    d.data.seen[key] = now();
    d.data.outbox.push({
      id,
      ...event,
      key,
      status: "pending",
      createdAt: now(),
      nextAt: 0,
    });
    d.data.outbox = d.data.outbox.slice(-50);
    const entries = Object.entries(d.data.seen)
      .filter(([, time]) => now() - time < 32 * 86400_000)
      .slice(-500);
    d.data.seen = Object.fromEntries(entries);
    await store.save(d);
  }
  async function deliver(d) {
    const s = d.data,
      t = s.telegram;
    const unknown = s.outbox.filter((x) => x.status === "sending");
    for (const event of unknown) {
      event.status = "unknown";
      event.error =
        "Delivery was interrupted; it will not be resent automatically.";
    }
    if (unknown.length) await store.save(d);
    const event = s.outbox.find(
      (x) => x.status === "pending" && x.nextAt <= now(),
    );
    if (!event || !t.token || !t.chatId || (t.retryAt || 0) > now()) return;
    await lease();
    event.status = "sending";
    await store.save(d);
    const base = dashboardAddress(s, tailnet.status());
    const payload = {
      chat_id: t.chatId,
      text: event.text,
      link_preview_options: { is_disabled: true },
    };
    if (base)
      payload.reply_markup = {
        inline_keyboard: [
          [{ text: "Open Control Room", url: `${base}/#${event.page}` }],
        ],
      };
    try {
      await telegram(t.token, "sendMessage", payload);
      event.status = "sent";
      event.error = null;
    } catch (e) {
      event.status = e.retryAfter
        ? "pending"
        : e.uncertain
          ? "unknown"
          : "failed";
      event.nextAt = now() + (e.retryAfter || 0) * 1000;
      if (e.retryAfter) t.retryAt = event.nextAt;
      event.error =
        e instanceof TelegramError ? e.message : "Telegram delivery failed.";
    }
    await store.save(d);
  }
  async function tick({ maintenance = true } = {}) {
    return exclusive(async () => {
      const d = await loaded(),
        s = d.data;
      lastWorkerError = "";
      if (!maintenance && !s.pair) return 15_000;
      if (
        !s.tailscale.enabled &&
        !s.telegram.enabled &&
        !s.pair &&
        !s.outbox.some((x) => x.status === "pending")
      )
        return 15_000;
      if (!(await store.lease(owner))) {
        await tailnet.stop();
        return 15_000;
      }
      leaseUntil = now() + 60_000;
      if (
        s.tailscale.enabled &&
        tailnet.status().phase === "disconnected" &&
        (await tailnet.enrolled())
      )
        await tailnet.start(s.tailscale);
      if (s.pair && s.pair.expires <= now()) {
        s.pair = null;
        await store.save(d);
      }
      if (
        s.pair &&
        s.telegram.token &&
        (!s.pair.nextAt || s.pair.nextAt <= now()) &&
        (s.telegram.retryAt || 0) <= now()
      ) {
        try {
          const updates = await telegram(s.telegram.token, "getUpdates", {
            offset: s.offset,
            limit: 100,
            timeout: 0,
            allowed_updates: ["message"],
          });
          for (const update of updates) {
            s.offset = Math.max(s.offset, update.update_id + 1);
            const m = update.message;
            if (
              m?.chat?.type === "private" &&
              m.chat.id === m.from?.id &&
              m.text === `/start ${s.pair.code}` &&
              m.date * 1000 >= s.pair.createdAt - 1000
            ) {
              s.telegram.chatId = String(m.chat.id);
              s.pair = null;
              break;
            }
          }
          await store.save(d);
        } catch (e) {
          s.pair.nextAt = now() + (e.retryAfter || 30) * 1000;
          if (e.retryAfter) s.telegram.retryAt = s.pair.nextAt;
          lastWorkerError =
            e instanceof TelegramError
              ? e.message
              : "Telegram pairing is unavailable.";
          await store.save(d);
        }
      }
      const delay = s.pair ? 2_000 : 15_000;
      if (!maintenance) return delay;
      if (s.telegram.enabled && s.telegram.token && s.telegram.chatId) {
        const summary = await store.summary();
        let files = [];
        try {
          files = (await proxy("credentials")).files || [];
          s.healthFailures = 0;
          s.outage = null;
        } catch {
          s.healthFailures++;
          if (!s.outage) s.outage = now();
        }
        const candidates = notificationCandidates(
          s,
          summary,
          files,
          now(),
          accountLabels(files, identityKey),
        );
        if (s.telegram.alerts.service && s.healthFailures >= 2)
          candidates.push({
            key: `service:${s.outage}`,
            kind: "service",
            page: "diagnostics",
            text: "CRAP · Proxy unavailable\nThe proxy failed consecutive health checks. Open Diagnostics to review it.",
          });
        await store.save(d);
        for (const event of candidates) await enqueue(d, event);
      }
      await deliver(d);
      return delay;
    });
  }
  function scheduleCycle(delay) {
    scheduler.clearTimeout(timer);
    timer = scheduler.setTimeout(cycle, delay);
  }
  async function cycle() {
    running = true;
    let delay = 15_000;
    const maintenance = now() >= nextMaintenance;
    try {
      delay = await tick({ maintenance });
    } catch (e) {
      lastWorkerError =
        e instanceof TelegramError
          ? e.message
          : "Integration worker is waiting for storage or service availability.";
      await tailnet.stop();
    } finally {
      if (maintenance) nextMaintenance = now() + 15_000;
      running = false;
      if (!stopped)
        scheduleCycle(Math.min(delay, Math.max(0, nextMaintenance - now())));
    }
  }
  return {
    async status() {
      const d = await loaded();
      return {
        ...publicState(d.data),
        tailscale: {
          ...publicState(d.data).tailscale,
          installed: await tailnet.installed(),
        },
      };
    },
    action(name, input = {}) {
      return exclusive(async () => {
        const d = await loaded(),
          s = d.data;
        switch (name) {
          case "tailscale/connect": {
            if (
              !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
                input.hostname || "",
              )
            )
              throw new Error(
                "Use a hostname with 1–63 lowercase letters, numbers or hyphens.",
              );
            if (
              !Array.isArray(input.allowedUsers) ||
              !input.allowedUsers.length ||
              input.allowedUsers.length > 20 ||
              input.allowedUsers.some(
                (x) =>
                  typeof x !== "string" ||
                  x.length > 254 ||
                  !/^\S+@\S+\.\S+$/.test(x),
              )
            )
              throw new Error(
                "Specify the Tailscale login emails allowed to access this workspace.",
              );
            if (!input.dashboard && !input.api)
              throw new Error("Choose dashboard or inference access.");
            if (
              input.authKey &&
              !/^tskey-auth-[a-zA-Z0-9-]+$/.test(input.authKey)
            )
              throw new Error(
                "Use a Tailscale device auth key, not a tailnet API token or OAuth client secret.",
              );
            if (input.api) {
              const config = await proxy("config");
              if (!config.access?.["api-keys"]?.length)
                throw new Error(
                  "Configure at least one client API key before enabling remote inference.",
                );
            }
            await lease();
            await tailnet.stop();
            s.tailscale = {
              enabled: true,
              hostname: input.hostname,
              allowedUsers: [
                ...new Set(input.allowedUsers.map((x) => x.toLowerCase())),
              ],
              dashboard: !!input.dashboard,
              api: !!input.api,
            };
            await store.save(d);
            await tailnet.start(s.tailscale, input.authKey || "");
            break;
          }
          case "tailscale/disconnect":
            s.tailscale.enabled = false;
            await store.save(d);
            await tailnet.stop();
            break;
          case "telegram/connect": {
            if (!/^\d{5,20}:[A-Za-z0-9_-]{20,}$/.test(input.token || ""))
              throw new Error("Enter the bot token supplied by BotFather.");
            const bot = await telegram(input.token, "getMe");
            if (!bot.is_bot || !bot.username)
              throw new Error("This token does not identify a Telegram bot.");
            const hook = await telegram(input.token, "getWebhookInfo");
            if (hook.url)
              throw new Error(
                "This bot has an active webhook. Use a dedicated bot; CRAP will not remove an existing integration.",
              );
            s.telegram = {
              ...s.telegram,
              token: input.token,
              username: bot.username,
              chatId: "",
              enabled: false,
            };
            s.offset = 0;
            s.pair = null;
            s.outbox = [];
            await store.save(d);
            break;
          }
          case "telegram/pair":
            if (!s.telegram.token) throw new Error("Connect a bot first.");
            await lease();
            s.pair = {
              code: randomBytes(24).toString("base64url"),
              createdAt: now(),
              expires: now() + 10 * 60_000,
            };
            await store.save(d);
            if (started && !running) scheduleCycle(0);
            break;
          case "telegram/cancel-pair":
            s.pair = null;
            await store.save(d);
            break;
          case "telegram/preferences": {
            if (
              !Number.isInteger(input.threshold) ||
              input.threshold < 1 ||
              input.threshold > 99 ||
              !Number.isInteger(input.digestHour) ||
              input.digestHour < 0 ||
              input.digestHour > 23
            )
              throw new Error(
                "Use a quota threshold of 1–99% and a UTC digest hour of 0–23.",
              );
            if (input.enabled && (!s.telegram.token || !s.telegram.chatId))
              throw new Error(
                "Connect a bot and pair a private chat before enabling alerts.",
              );
            if (
              input.dashboardAddress &&
              !validDashboardURL(input.dashboardAddress)
            )
              throw new Error(
                "Enter a reachable dashboard URL without credentials, a query or localhost.",
              );
            s.dashboardAddress = input.dashboardAddress || "";
            s.telegram = {
              ...s.telegram,
              enabled: !!input.enabled,
              threshold: input.threshold,
              digestHour: input.digestHour,
              alerts: Object.fromEntries(
                ["account", "quota", "service", "daily"].map((k) => [
                  k,
                  !!input.alerts?.[k],
                ]),
              ),
            };
            if (!s.telegram.enabled)
              s.outbox = s.outbox.filter((x) => x.status !== "pending");
            await store.save(d);
            break;
          }
          case "telegram/test":
            if (!s.telegram.chatId)
              throw new Error("Pair your private chat first.");
            await lease();
            await enqueue(d, {
              key: `test:${randomUUID()}`,
              kind: "test",
              page: "setup",
              text: "CRAP · Test notification\nYour private Telegram chat is connected to the control room.",
            });
            await deliver(d);
            break;
          case "telegram/disconnect":
            s.telegram = { ...defaults().telegram };
            s.pair = null;
            s.outbox = [];
            s.offset = 0;
            await store.save(d);
            break;
          default:
            throw new Error("Unknown integration operation.");
        }
        return publicState(s);
      });
    },
    tick,
    start() {
      if (started && !stopped) return;
      started = true;
      stopped = false;
      watchdog = setInterval(() => {
        if (now() > leaseUntil && tailnet.status().phase !== "disconnected")
          void tailnet.stop();
      }, 10_000);
      scheduleCycle(0);
    },
    async stop() {
      stopped = true;
      scheduler.clearTimeout(timer);
      clearInterval(watchdog);
      await tailnet.stop();
    },
  };
}
