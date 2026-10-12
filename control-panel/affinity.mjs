import { createAccountUsageReader } from "./account-usage.mjs";

// Only normalized quota fields are sent to the control service. Provider tokens
// remain in CLIProxy; its authenticated API-call facility supplies them upstream.
export function startQuotaCollector({
  upstream,
  managementKey,
  controlURL,
  token,
  readUsage,
  fetcher = fetch,
  now = Date.now,
  schedule = setTimeout,
  cancel = clearTimeout,
}) {
  const reader =
    readUsage ||
    createAccountUsageReader({
      upstreamURL: new URL(upstream),
      managementKey,
    });
  let stopped = false;
  let timer;
  async function collect() {
    // Inspect the local passive snapshot frequently; the shared reader alone
    // admits provider calls and persists its five-minute / Retry-After limits.
    let nextDelay = 15_000;
    try {
      const response = await fetcher(
        new URL("/v8/management/credentials", upstream),
        {
          headers: { Authorization: `Bearer ${managementKey}` },
          redirect: "error",
        },
      );
      if (!response.ok) throw new Error("credential lookup failed");
      const { files = [] } = await response.json();
      for (const account of files) {
        if (stopped) break;
        if (
          account.disabled ||
          !account.auth_index ||
          !["claude", "codex"].includes(account.provider)
        )
          continue;
        let snapshot;
        try {
          const usage = await reader(account.auth_index);
          if (usage.nextAttemptAt > now())
            nextDelay = Math.min(nextDelay, usage.nextAttemptAt - now());
          snapshot = {
            plan: usage.plan || "",
            checkedAt: usage.checkedAt,
            windows: usage.windows || [],
            error:
              !!usage.usageError &&
              !["5-hour window", "Weekly window"].every((label) =>
                usage.windows?.some(
                  (w) =>
                    w.label === label &&
                    w.source === "response" &&
                    Number.isFinite(w.used) &&
                    now() - w.observedAt <= 300_000,
                ),
              ),
          };
        } catch {
          snapshot = {
            plan: "",
            checkedAt: now(),
            windows: [],
            error: true,
          };
        }
        const saved = await fetcher(new URL("/quotas", controlURL), {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            accountId: account.id || account.name,
            provider: account.provider,
            ...snapshot,
          }),
          redirect: "error",
        });
        if (!saved.ok) throw new Error("quota persistence failed");
      }
    } catch {
      console.warn(
        "Affinity quota collection unavailable; previous observations will age out.",
      );
    } finally {
      if (!stopped) {
        timer = schedule(collect, Math.max(1000, nextDelay));
        timer.unref?.();
      }
    }
  }
  void collect();
  return () => {
    stopped = true;
    cancel(timer);
  };
}
