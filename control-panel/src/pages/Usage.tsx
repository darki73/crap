import { useEffect, useState } from "react";
import {
  ArrowUpRight,
  Gauge,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState, PageHeading } from "@/components/shared";
import { api, errorMessage, type Credential } from "@/lib/api";
import {
  averageWindow,
  maskEmails,
  resetCountdown,
  resolvedUsage,
  windowPercent,
  type LiveUsage,
  type UsageWindow,
} from "@/lib/accounts";

const names: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  antigravity: "Antigravity",
  xai: "xAI",
  kimi: "Kimi",
  "kimi-ai": "Kimi.ai",
};
const marks: Record<string, string> = {
  claude: "✳",
  codex: "O",
  antigravity: "A",
  xai: "x",
  kimi: "K",
};
const providerName = (provider: string) =>
  names[provider] || provider || "Other";
const pct = (value: number) => `${Math.round(value * 10) / 10}%`;
const sessionWindow = (windows: UsageWindow[]) =>
  windows.find((w) => /5-hour|Primary|300-minute/.test(w.label));
const weeklyWindow = (windows: UsageWindow[]) =>
  windows.find(
    (w) => w.label === "Weekly window" || w.label === "10080-minute window",
  );
const identity = (credential: Credential) => credential.id || credential.name;

export function UsagePage({
  credentials,
  onConnect,
  onRefresh,
  refreshing,
}: {
  credentials: Credential[];
  onConnect: () => void;
  onRefresh: () => Promise<void>;
  refreshing: boolean;
}) {
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [remaining, setRemaining] = useState(true);
  const [data, setData] = useState<Record<string, LiveUsage>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let running = false;
    async function read(initial = false) {
      if (running || (!initial && document.hidden)) return;
      running = true;
      const queue = credentials.filter(
        (c) =>
          (c.provider === "claude" ||
            c.provider === "codex" ||
            c.supports_quota) &&
          c.auth_index,
      );
      if (initial) setLoading(queue.length > 0);
      // Bound concurrent lookups when a workspace contains many accounts.
      async function worker() {
        while (active && queue.length) {
          const credential = queue.shift()!;
          try {
            const value = await api<LiveUsage>(
              `/accounts/usage?auth_index=${encodeURIComponent(credential.auth_index!)}`,
              { signal: controller.signal },
            );
            if (active) {
              setData((previous) => ({
                ...previous,
                [identity(credential)]: value,
              }));
              setErrors((previous) => ({
                ...previous,
                [identity(credential)]: "",
              }));
            }
          } catch (error) {
            if (active)
              setErrors((previous) => ({
                ...previous,
                [identity(credential)]: errorMessage(error),
              }));
          }
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(3, queue.length) }, worker),
      ).finally(() => {
        running = false;
        if (active) {
          setLoading(false);
          setNow(Date.now());
        }
      });
    }
    void read(true);
    // The server merges response observations and enforces provider backoff.
    // This interval never requests a forced quota or plan refresh.
    const timer = window.setInterval(() => void read(), 15000);
    const visible = () => {
      if (!document.hidden) void read();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      active = false;
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [credentials]);

  const rows = credentials.map((credential) => {
    const live = data[identity(credential)];
    return {
      credential,
      usage: resolvedUsage(credential, live),
      error:
        errors[identity(credential)] ||
        [live?.usageError, live?.profileError].filter(Boolean).join(" "),
    };
  });
  const providers = [...new Set(credentials.map((c) => c.provider))];
  const selected = providers.includes(filter) ? filter : "all";
  const summaryProviders = providers.filter(
    (p) => selected === "all" || p === selected,
  );
  const singleSummary = summaryProviders.length === 1;
  const visible = rows.filter(
    ({ credential: c }) =>
      (selected === "all" || c.provider === selected) &&
      `${c.email || ""} ${c.name} ${providerName(c.provider)}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const known = rows.filter((row) =>
    row.usage.windows.some((w) => w.used !== undefined),
  ).length;
  const busy = loading || refreshing;
  async function refreshPlans() {
    setLoading(true);
    const queue = credentials.filter(
      (c) => c.provider === "claude" && c.auth_index,
    );
    setErrors({});
    async function worker() {
      while (queue.length) {
        const credential = queue.shift()!;
        try {
          const value = await api<LiveUsage>(
            `/accounts/usage?auth_index=${encodeURIComponent(credential.auth_index!)}&refresh_plan=1`,
          );
          setData((previous) => ({
            ...previous,
            [identity(credential)]: value,
          }));
        } catch (error) {
          setErrors((previous) => ({
            ...previous,
            [identity(credential)]: errorMessage(error),
          }));
        }
      }
    }
    try {
      await Promise.all(
        Array.from({ length: Math.min(3, queue.length) }, worker),
      );
    } finally {
      setLoading(false);
    }
  }
  return (
    <>
      <PageHeading
        eyebrow="Allowance & availability"
        title="Quota & Limits"
        description="Account allowances, reset times and the latest observations from your requests."
        action={
          <div className="flex flex-wrap gap-2">
            {credentials.some((c) => c.provider === "claude") && (
              <Button
                variant="outline"
                onClick={() => void refreshPlans()}
                disabled={busy}
                title="Recheck subscription plans. Limited to once every five minutes per account, with longer backoff after errors."
              >
                Refresh plans
              </Button>
            )}
            <Button onClick={() => void onRefresh()} disabled={busy}>
              <RefreshCw size={15} className={busy ? "animate-spin" : ""} />
              {busy ? "Checking accounts…" : "Refresh usage"}
            </Button>
          </div>
        }
      />
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3 font-mono text-xs">
          <span className="h-4 w-0.5 bg-primary" />
          <span>{credentials.length} accounts</span>
          <span className="text-border">/</span>
          <span className="text-primary">{known} with usage data</span>
        </div>
        <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <ShieldCheck size={13} /> Account emails masked
        </span>
      </div>
      {!credentials.length ? (
        <section className="surface">
          <EmptyState
            icon={Gauge}
            title="Your allowances start here."
            action={
              <Button onClick={onConnect}>
                <Plus size={14} />
                Connect an account
              </Button>
            }
          >
            Connect a provider to see its usage windows and reset times.
          </EmptyState>
        </section>
      ) : (
        <>
          <div className="mb-5 flex flex-wrap items-center justify-between gap-4 border-b pb-3">
            <div
              className="flex flex-wrap gap-1"
              aria-label="Filter usage by provider"
            >
              {["all", ...providers].map((provider) => (
                <button
                  key={provider}
                  aria-pressed={selected === provider}
                  onClick={() => setFilter(provider)}
                  className={`flex items-center gap-2 rounded-md px-3 py-2 text-xs transition-colors ${selected === provider ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted"}`}
                >
                  <span>
                    {provider === "all"
                      ? "All providers"
                      : providerName(provider)}
                  </span>
                  <span className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[10px]">
                    {provider === "all"
                      ? credentials.length
                      : credentials.filter((c) => c.provider === provider)
                          .length}
                  </span>
                </button>
              ))}
            </div>
            <div
              className="flex rounded-lg border bg-background p-1"
              aria-label="Percentage display"
            >
              {[true, false].map((value) => (
                <button
                  key={String(value)}
                  aria-pressed={remaining === value}
                  onClick={() => setRemaining(value)}
                  className={`rounded-md px-3 py-1.5 text-[11px] ${remaining === value ? "bg-muted text-foreground" : "text-muted-foreground"}`}
                >
                  {value ? "Remaining" : "Used"}
                </button>
              ))}
            </div>
          </div>
          <div className="mb-6 grid grid-cols-[repeat(auto-fit,minmax(min(100%,280px),1fr))] gap-3">
            {summaryProviders.map((provider) => {
              const group = rows.filter(
                (r) => r.credential.provider === provider,
              );
              const eligible = group.filter(
                (r) => !r.credential.disabled && !r.error,
              );
              const weekly = averageWindow(
                eligible.map((r) => {
                  const w = weeklyWindow(r.usage.windows);
                  return w?.resetAt !== undefined && w.resetAt <= now
                    ? undefined
                    : w;
                }),
                remaining,
              );
              const session = averageWindow(
                eligible.map((r) => {
                  const w = sessionWindow(r.usage.windows);
                  return w?.resetAt !== undefined && w.resetAt <= now
                    ? undefined
                    : w;
                }),
                remaining,
              );
              return (
                <section
                  key={provider}
                  className={`surface overflow-hidden ${singleSummary ? "md:grid md:grid-cols-[1fr_2fr_1fr] md:items-center" : ""}`}
                >
                  <div
                    className={`flex items-center gap-3 border-b px-5 py-4 ${singleSummary ? "md:flex-wrap md:border-b-0" : ""}`}
                  >
                    <span
                      className={`flex size-8 items-center justify-center rounded-lg border bg-background text-lg ${provider === "claude" ? "text-orange-300" : "text-primary"}`}
                    >
                      {marks[provider] || "◇"}
                    </span>
                    <h2 className="text-sm font-medium">
                      {providerName(provider)}
                    </h2>
                    <span className="quiet ml-auto text-[11px]">
                      {group.length}{" "}
                      {group.length === 1 ? "account" : "accounts"}
                    </span>
                  </div>
                  <div
                    className={`px-5 py-4 ${singleSummary ? "md:border-x" : ""}`}
                  >
                    <p className="eyebrow">
                      Average weekly {remaining ? "remaining" : "used"}
                    </p>
                    <div className="my-3 text-3xl font-medium tracking-tight">
                      {weekly.percent === undefined ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        pct(weekly.percent)
                      )}
                    </div>
                    <div
                      className="flex gap-1.5"
                      aria-label="Weekly allowance by account"
                    >
                      {group.map((r) => {
                        const w = weeklyWindow(r.usage.windows);
                        const stale =
                          w?.resetAt !== undefined && w.resetAt <= now;
                        const valid =
                          !r.credential.disabled && !r.error && !stale;
                        return (
                          <div
                            key={identity(r.credential)}
                            className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
                          >
                            {valid && w?.used !== undefined && (
                              <div
                                className={`h-full ${w.used >= 90 ? "bg-amber-300" : "bg-primary"}`}
                                style={{
                                  width: `${Math.min(100, windowPercent(w, remaining)!)}%`,
                                }}
                              />
                            )}
                          </div>
                        );
                      })}
                    </div>
                    <p className="quiet mt-3 text-[10px]">
                      {weekly.count} of {group.length} accounts included · equal
                      account weighting
                    </p>
                  </div>
                  <div
                    className={`flex items-center justify-between gap-3 border-t bg-background/20 px-5 py-3 text-xs ${singleSummary ? "md:flex-col md:items-start md:border-t-0 md:bg-transparent" : ""}`}
                  >
                    <span className="quiet">
                      Session {remaining ? "remaining" : "used"} ·{" "}
                      {session.count} reporting
                    </span>
                    <span className="font-mono text-primary">
                      {session.percent === undefined
                        ? "—"
                        : pct(session.percent)}
                    </span>
                  </div>
                </section>
              );
            })}
          </div>
          <section className="surface overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-4 border-b px-5 py-4">
              <div>
                <h2 className="text-sm font-medium">Account allowances</h2>
                <p className="quiet mt-1 text-[11px]">
                  Updates every 15 seconds while this page is visible.
                </p>
              </div>
              <div className="relative w-full sm:w-64">
                <Search
                  size={14}
                  className="absolute left-3 top-3 text-muted-foreground"
                />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Find an account…"
                  aria-label="Search usage accounts"
                  className="pl-9"
                />
              </div>
            </div>
            {!visible.length ? (
              <EmptyState icon={Search} title="No matching accounts">
                Try a different provider or search.
              </EmptyState>
            ) : (
              <div className="divide-y">
                {providers.map((provider) => {
                  const group = visible.filter(
                    (r) => r.credential.provider === provider,
                  );
                  if (!group.length) return null;
                  return (
                    <section key={provider}>
                      <div className="flex items-center gap-2 bg-background/30 px-5 py-3 text-xs">
                        <span className="text-primary">
                          {marks[provider] || "◇"}
                        </span>
                        <h3 className="font-medium">
                          {providerName(provider)}
                        </h3>
                        <span className="quiet font-mono text-[10px]">
                          {group.length}
                        </span>
                      </div>
                      {group.map(({ credential, usage, error }) => (
                        <article
                          key={identity(credential)}
                          className="grid gap-5 border-t p-5 lg:grid-cols-[minmax(200px,1fr)_3fr]"
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <p className="truncate font-mono text-xs">
                                {maskEmails(
                                  credential.email || credential.name,
                                )}
                              </p>
                              {credential.disabled && (
                                <Badge variant="outline" className="text-[9px]">
                                  Disabled
                                </Badge>
                              )}
                            </div>
                            <p className="quiet mt-2 text-xs">
                              {maskEmails(usage.plan || "Plan not reported")}
                            </p>
                            <p className="quiet mt-3 flex items-center gap-1 text-[10px]">
                              <ArrowUpRight size={11} />
                              {usage.direct
                                ? "Account-wide usage"
                                : "Proxy observations"}
                            </p>
                            {usage.observedAt && (
                              <p className="quiet mt-1 text-[10px]">
                                Checked{" "}
                                {new Date(usage.observedAt).toLocaleTimeString(
                                  [],
                                  { hour: "2-digit", minute: "2-digit" },
                                )}
                              </p>
                            )}
                            {error && (
                              <p
                                role="status"
                                className="mt-2 text-[11px] text-amber-300"
                              >
                                {maskEmails(error)} Displayed values may be
                                stale.
                              </p>
                            )}
                          </div>
                          <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
                            {usage.windows.length ? (
                              usage.windows.map((window, index) => (
                                <Meter
                                  key={`${window.label}-${index}`}
                                  window={window}
                                  remaining={remaining}
                                  now={now}
                                />
                              ))
                            ) : (
                              <p className="quiet text-xs">
                                Usage windows aren’t available for this provider
                                yet.
                              </p>
                            )}
                          </div>
                        </article>
                      ))}
                    </section>
                  );
                })}
              </div>
            )}
          </section>
          <p className="quiet mt-4 max-w-3xl text-[11px] leading-relaxed">
            {remaining
              ? "Percentages show allowance remaining."
              : "Percentages show allowance used."}{" "}
            Provider summaries average reported values across enabled accounts,
            excluding failed lookups and elapsed reset windows. Accounts have
            separate limits; averages are not a shared quota. Claude account
            lookups run at most once every five minutes per account, with longer
            backoff after failures.
          </p>
        </>
      )}
    </>
  );
}

function Meter({
  window,
  remaining,
  now,
}: {
  window: UsageWindow;
  remaining: boolean;
  now: number;
}) {
  const value = windowPercent(window, remaining);
  const stale = window.resetAt !== undefined && window.resetAt <= now;
  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="text-muted-foreground">
          {maskEmails(window.label)}
        </span>
        <span className="shrink-0 font-mono">
          {value === undefined
            ? "Unknown"
            : `${pct(value)} ${remaining ? "left" : "used"}`}
        </span>
      </div>
      <div
        role={value === undefined ? undefined : "progressbar"}
        aria-label={`${maskEmails(window.label)} ${remaining ? "remaining" : "used"}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value === undefined ? undefined : Math.min(100, value)}
        className="my-2.5 h-1.5 overflow-hidden rounded-full bg-muted"
      >
        {value !== undefined && (
          <div
            className={`h-full rounded-full transition-all ${stale ? "bg-muted-foreground" : (window.used ?? 0) >= 90 ? "bg-amber-300" : "bg-primary"}`}
            style={{ width: `${Math.min(100, value)}%` }}
          />
        )}
      </div>
      <p className="quiet text-[10px]">
        {window.resetAt === undefined
          ? "Reset time not reported"
          : resetCountdown(window.resetAt, now)}
      </p>
      {window.observedAt !== undefined && (
        <p className="quiet mt-1 text-[10px]">
          {window.source === "response"
            ? "From request response"
            : "From quota check"}{" "}
          · {Math.max(0, Math.floor((now - window.observedAt) / 60000))}m ago
        </p>
      )}
      {window.resetAt !== undefined && (
        <p className="quiet mt-1 text-[10px]">
          {new Date(window.resetAt).toLocaleString([], {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </p>
      )}
    </div>
  );
}
