import { Paginated } from "@/components/Paginated";
import { useCallback, useEffect, useState } from "react";
import { ChevronDown, Database, RefreshCw, Route, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  EmptyState,
  ErrorNotice,
  PageHeading,
  Pending,
} from "@/components/shared";
import { api, errorMessage } from "@/lib/api";
import { PriceCatalog, type PriceVersion } from "@/components/PriceCatalog";
import { maskEmails } from "@/lib/accounts";

type Policy = {
  version: number;
  mode: "shadow" | "live";
  minimumRemaining: number;
  freshnessSeconds: number;
  affinitySeconds: number;
};
type State = {
  strictRouting?: boolean;
  accountLabels?: Record<string, string>;
  clients: {
    id: string;
    attempts: number;
    tokens: string | null;
    known_totals: number;
  }[];
  sessions: {
    id: string;
    attempts: number;
    tokens: string | null;
    known_totals: number;
  }[];
  pluginRegistered?: boolean;
  prices: PriceVersion[];
  costs: {
    kind: string;
    pricing_basis?: string;
    attempts: number;
    usd: string;
  }[];
  cache?: {
    fiveMinute: string | null;
    oneHour: string | null;
    unknownTokens: string | null;
    unknownRequests: number;
  };
  policy: Policy;
  summary: {
    inputUncached: string | null;
    output: string | null;
    reasoning: string | null;
    events: number;
    reportedTokens: string | null;
    knownTotals: number;
    complete: number;
    failed: number;
    cacheRead: string | null;
    cacheWrite: string | null;
  };
  journal: { admitted: number; unresolved: number; completed: number };
  coverage?: {
    matchedTraces: number;
    completedWithoutUsage: number;
    unlinkedJournal: number;
    unlinkedUsage: number;
  };
  plugins: {
    replica_id: string;
    seen_at: string;
    pending_events: number;
    rejected_events: number;
  }[];
  quotas: {
    account_id: string;
    provider: string;
    plan: string;
    observed_at: string;
    error: boolean;
    windows: {
      label: string;
      used?: number;
      resetAt?: number;
      observedAt?: number;
      source?: string;
    }[];
  }[];
  groups: {
    service_tier: string;
    provider: string;
    model: string;
    account_id: string;
    attempts: number;
    tokens: string | null;
    known_totals: number;
  }[];
  recent: {
    event_id: string;
    provider: string;
    model: string;
    account_id: string;
    started_at: string;
    outcome: string;
    quality: string;
    reported_total: string | null;
    cache_write?: string | null;
    cache_write_5m?: string | null;
    cache_write_1h?: string | null;
  }[];
  decisions: {
    id: number;
    decided_at: string;
    mode: string;
    model: string;
    account_id: string;
    reason: string;
    candidate_count: number;
  }[];
};
const count = (v: string | number | null | undefined) =>
  v == null ? "—" : BigInt(v).toLocaleString();
const fallbackAccount = (v: string) =>
  v ? `Account ${v.replace(/^v1:/, "").slice(0, 8)}` : "No eligible account";
const time = (v: string) => new Date(v).toLocaleString();
const pricingBasis: Record<string, string> = {
  observed_duration: "Verified cache durations",
  no_cache_writes: "No cache writes",
  aggregate_rate: "Aggregate cache rate",
  legacy_assumed: "Legacy rate assumption",
};

export function Affinity({
  view,
  onViewChange,
}: {
  view?: "routing" | "ledger";
  onViewChange?: (view: "routing" | "ledger") => void;
} = {}) {
  const [data, setData] = useState<State>();
  const [draft, setDraft] = useState<Policy>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [localTab, setLocalTab] = useState<"routing" | "ledger">("routing");
  const tab = view ?? localTab;
  const setTab = onViewChange ?? setLocalTab;
  const account = (id: string) =>
    maskEmails(data?.accountLabels?.[id] || fallbackAccount(id));
  const load = useCallback(async () => {
    setBusy(true);
    try {
      const next = await api<State>("/affinity/state");
      setData(next);
      setDraft((previous) => previous ?? next.policy);
      setError("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 15000);
    return () => window.clearInterval(timer);
  }, [load]);
  async function save() {
    if (!draft) return;
    setBusy(true);
    setMessage("");
    try {
      await api("/affinity/policy", {
        method: "PUT",
        body: JSON.stringify(draft),
        headers: { "Content-Type": "application/json" },
      });
      const next = await api<State>("/affinity/state");
      setData(next);
      setDraft(next.policy);
      setError("");
      setMessage("Routing policy saved.");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeading
        eyebrow={tab === "ledger" ? "Usage & cost" : "Account selection"}
        title={tab === "ledger" ? "Token Ledger" : "Routing & Affinity"}
        description={
          tab === "ledger"
            ? "Upstream requests, token breakdowns and cost estimates across your accounts."
            : "Keep conversations together. Make every account decision explainable."
        }
        action={
          <Button disabled={busy} onClick={() => void load()}>
            <RefreshCw size={15} className={busy ? "animate-spin" : ""} />
            {tab === "ledger" ? "Refresh ledger" : "Refresh routing"}
          </Button>
        }
      />
      {error && (
        <div className="mb-5">
          <ErrorNotice message={error} />
        </div>
      )}
      {!data ? (
        busy ? (
          <Pending />
        ) : (
          <section className="surface">
            <EmptyState icon={Database} title="Control service unavailable">
              Start the affinity control service to see routing and durable
              usage.
            </EmptyState>
          </section>
        )
      ) : (
        <>
          <div className="mb-6 grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
            {[
              ["Upstream requests", count(data.summary.events)],
              ["Reported tokens", count(data.summary.reportedTokens)],
              tab === "routing"
                ? [
                    "Routing mode",
                    data.strictRouting
                      ? "Strict affinity"
                      : data.policy.mode === "shadow"
                        ? "Observe only"
                        : "Live selection",
                  ]
                : ["Failed requests", count(data.summary.failed)],
              ["Unresolved requests", count(data.journal.unresolved)],
            ].map(([label, value]) => (
              <div className="surface p-4 sm:p-5" key={label}>
                <p className="quiet text-xs">{label}</p>
                <p className="mt-3 break-words text-xl font-semibold tracking-tight sm:text-2xl">
                  {value}
                </p>
              </div>
            ))}
          </div>
          <div className="mb-5 flex flex-wrap items-center gap-3 border-b pb-4">
            {!view &&
              (["routing", "ledger"] as const).map((value) => (
                <Button
                  key={value}
                  variant={tab === value ? "default" : "ghost"}
                  onClick={() => setTab(value)}
                >
                  {value === "routing" ? "Routing & headroom" : "Token Ledger"}
                </Button>
              ))}
            <span className="text-xs text-muted-foreground">
              {data.pluginRegistered &&
              data.plugins.some(
                (p) => Date.now() - Date.parse(p.seen_at) < 30000,
              )
                ? "Plugin connected"
                : "No recent plugin heartbeat"}
            </span>
            <span className="ml-auto text-xs text-muted-foreground">
              Updates every 15 seconds
            </span>
          </div>
          {data.plugins.some(
            (p) => p.rejected_events > 0 || p.pending_events > 0,
          ) && (
            <p className="mb-4 text-sm text-amber-300">
              Delivery queue:{" "}
              {data.plugins.reduce((n, p) => n + p.pending_events, 0)} pending ·{" "}
              {data.plugins.reduce((n, p) => n + p.rejected_events, 0)}{" "}
              rejected. Rejected events are retained for inspection.
            </p>
          )}
          {tab === "routing" && draft ? (
            <>
              {data.strictRouting ? (
                <section className="surface mb-6 p-6">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h2 className="font-medium">
                      Stay together. Switch only when needed.
                    </h2>
                    <Badge>Claude Code · Subscriptions</Badge>
                  </div>
                  <p className="quiet mt-3 max-w-3xl text-sm leading-relaxed">
                    Conversations and their subagents keep the same account
                    across restarts and model changes. A usable account stays
                    selected while every applicable quota window meets the
                    reserve, unless access is lost, or the requested model is
                    unavailable.
                  </p>
                  <div className="mt-5 grid gap-5 md:grid-cols-3">
                    {[
                      [
                        "Fill one account",
                        "New and existing conversations use the current account only while it meets the reserve. When another is needed, prefer the lowest remaining weekly allowance, then the five-hour allowance.",
                      ],
                      [
                        "Learn as requests complete",
                        "Use quota observations from provider responses. Older observations remain useful; missing headers do not erase them. A reset allows the next request to learn the new window.",
                      ],
                      [
                        "One request, one attempt",
                        "Return provider errors without replaying the request. Temporary overload does not move a conversation. If no account meets the reserve, return an error with the next known reset.",
                      ],
                    ].map(([title, description]) => (
                      <div key={title} className="rounded-lg border p-4">
                        <h3 className="text-sm font-medium">{title}</h3>
                        <p className="quiet mt-2 text-xs leading-relaxed">
                          {description}
                        </p>
                      </div>
                    ))}
                  </div>
                  <div className="mt-5 rounded-lg border p-4">
                    <label className="text-xs" htmlFor="strict-quota-reserve">
                      Quota reserve (%)
                    </label>
                    <div className="mt-2 flex flex-wrap items-center gap-3">
                      <Input
                        id="strict-quota-reserve"
                        className="w-28"
                        type="number"
                        min={0}
                        max={100}
                        step="0.1"
                        value={draft.minimumRemaining}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            minimumRemaining: Number(e.target.value),
                          })
                        }
                      />
                      <Button disabled={busy} onClick={() => void save()}>
                        <Save size={14} />
                        Save reserve
                      </Button>
                      <span role="status" className="text-xs text-primary">
                        {message}
                      </span>
                    </div>
                    <p className="quiet mt-3 text-xs leading-relaxed">
                      Checked before every request, including existing
                      conversations and subagents. If the five-hour, weekly, or
                      an applicable model-specific window has less than the
                      reserve remaining, the conversation moves to a usable
                      account. A generation already in progress is not
                      interrupted. This reduces risk but cannot guarantee that a
                      long request fits within the remaining quota.
                    </p>
                  </div>
                  <p className="quiet mt-5 text-xs">
                    The routing plugin and private proxy boundary are required.
                    This release supports one active gateway and proxy.
                  </p>
                </section>
              ) : (
                <section className="surface mb-6 p-6">
                  <div className="mb-5 flex items-center justify-between">
                    <div>
                      <h2 className="font-medium">Selection policy</h2>
                      <p className="quiet mt-1 text-xs">
                        Healthy affinity takes precedence; new assignments use
                        the tightest remaining window.
                      </p>
                    </div>
                    <Badge>Version {data.policy.version}</Badge>
                  </div>
                  <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-4">
                    <label className="text-xs">
                      Mode
                      <select
                        aria-label="Routing mode"
                        className="mt-2 h-10 w-full rounded-md border bg-background px-3"
                        value={draft.mode}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            mode: e.target.value as Policy["mode"],
                          })
                        }
                      >
                        <option value="shadow">
                          Shadow — record proposals
                        </option>
                        <option value="live">Live — choose accounts</option>
                      </select>
                    </label>
                    <label className="text-xs">
                      Minimum remaining (%)
                      <Input
                        aria-label="Minimum remaining"
                        className="mt-2"
                        type="number"
                        min={0}
                        max={100}
                        value={draft.minimumRemaining}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            minimumRemaining: Number(e.target.value),
                          })
                        }
                      />
                    </label>
                    <label className="text-xs">
                      Quota freshness (seconds)
                      <Input
                        aria-label="Quota freshness"
                        title="Applied per usage window, with 60 seconds of collection grace. Explicit rejections and expired resets remain ineligible."
                        className="mt-2"
                        type="number"
                        min={30}
                        max={3600}
                        value={draft.freshnessSeconds}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            freshnessSeconds: Number(e.target.value),
                          })
                        }
                      />
                    </label>
                    <label className="text-xs">
                      Affinity lifetime (seconds)
                      <Input
                        aria-label="Affinity lifetime"
                        className="mt-2"
                        type="number"
                        min={60}
                        max={86400}
                        value={draft.affinitySeconds}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            affinitySeconds: Number(e.target.value),
                          })
                        }
                      />
                    </label>
                  </div>
                  <p className="quiet mt-5 max-w-3xl text-xs leading-relaxed">
                    Live mode rejects selection when every candidate has stale,
                    unknown or insufficient quota. Session affinity requires an
                    explicit session ID and client identity. Accounts without
                    supported quota observations are excluded. Multiple active
                    proxy replicas and exact concurrency reservations are not
                    validated yet.
                  </p>
                  <div className="mt-5 flex items-center gap-4">
                    <Button onClick={() => void save()} disabled={busy}>
                      <Save size={14} />
                      Save policy
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => setDraft(data.policy)}
                    >
                      Discard edits
                    </Button>
                    <span role="status" className="text-xs text-primary">
                      {message}
                    </span>
                  </div>
                </section>
              )}
              <section className="surface mb-6">
                <div className="border-b p-5">
                  <h2 className="font-medium">Collected quota windows</h2>
                  <p className="quiet mt-1 text-xs">
                    Quota checks run every five minutes per account, with longer
                    backoff after failures.{" "}
                    {data.strictRouting
                      ? "Responses can update these windows between checks. Reset windows may be learned by the next request."
                      : "Reset windows need a new observation before they become eligible."}
                  </p>
                </div>
                {!data.quotas.length ? (
                  <EmptyState
                    icon={Database}
                    title="Waiting for quota observations"
                  >
                    Connected Claude and Codex accounts are collected
                    automatically.
                  </EmptyState>
                ) : (
                  <Paginated items={data.quotas} label="quota accounts">
                    {(pageRows) =>
                      pageRows.map((q) => (
                        <div
                          key={q.account_id}
                          className="flex flex-wrap items-center gap-6 border-b p-5 last:border-0"
                        >
                          <div className="min-w-44">
                            <p className="text-sm font-medium">
                              {account(q.account_id)}
                            </p>
                            <p className="quiet mt-1 text-xs">
                              {q.provider} · {q.plan || "Plan unknown"}
                            </p>
                          </div>
                          <div className="flex flex-1 flex-wrap gap-6">
                            {q.windows.map((w, i) => (
                              <div key={i} className="min-w-36">
                                <p className="quiet text-xs">{w.label}</p>
                                <p className="quiet text-[10px]">
                                  {w.source === "response"
                                    ? "Response headers"
                                    : "Quota check"}{" "}
                                  ·{" "}
                                  {time(
                                    new Date(
                                      w.observedAt ?? Date.parse(q.observed_at),
                                    ).toISOString(),
                                  )}
                                </p>
                                <p className="mt-1 text-sm">
                                  {w.used == null
                                    ? "Unknown"
                                    : `${Math.max(0, 100 - w.used).toFixed(1)}% remaining`}
                                </p>
                                <div className="mt-2 h-1 rounded bg-muted">
                                  <div
                                    className="h-1 rounded bg-primary"
                                    style={{
                                      width: `${Math.max(0, Math.min(100, 100 - (w.used ?? 100)))}%`,
                                    }}
                                  />
                                </div>
                              </div>
                            ))}
                          </div>
                          <div className="text-right text-xs text-muted-foreground">
                            <Badge>
                              {q.error
                                ? "Lookup failed"
                                : q.windows.some(
                                      (w) =>
                                        Date.now() -
                                          (w.observedAt ??
                                            Date.parse(q.observed_at)) >
                                        (data.policy.freshnessSeconds + 60) *
                                          1000,
                                    )
                                  ? "Some windows stale"
                                  : "Fresh"}
                            </Badge>
                            <p className="mt-2">{time(q.observed_at)}</p>
                          </div>
                        </div>
                      ))
                    }
                  </Paginated>
                )}
              </section>
              <section className="surface">
                <div className="border-b p-5">
                  <h2 className="font-medium">Decision history</h2>
                  <p className="quiet mt-1 text-xs">
                    Latest 50 routing decisions.
                  </p>
                </div>
                {!data.decisions.length ? (
                  <EmptyState icon={Route} title="Ready to observe routing">
                    Decisions appear when a client sends a model request through
                    the proxy. No test inference is sent automatically.
                  </EmptyState>
                ) : (
                  <Paginated
                    items={data.decisions}
                    label="decisions"
                    loadedOnly
                    snapshot
                  >
                    {(pageRows) => (
                      <div className="overflow-x-auto">
                        <table className="w-full text-left text-xs">
                          <thead className="quiet">
                            <tr>
                              {[
                                "Time",
                                "Mode",
                                "Model",
                                "Account",
                                "Reason",
                              ].map((h) => (
                                <th key={h} className="p-4 font-normal">
                                  {h}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {pageRows.map((d) => (
                              <tr key={d.id} className="border-t">
                                <td className="p-4">{time(d.decided_at)}</td>
                                <td className="p-4">{d.mode}</td>
                                <td className="p-4">{d.model}</td>
                                <td className="p-4">{account(d.account_id)}</td>
                                <td className="p-4 text-muted-foreground">
                                  {d.reason}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </Paginated>
                )}
              </section>
            </>
          ) : (
            <>
              <section className="surface mb-6 overflow-hidden">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b p-5">
                  <h2 className="font-medium">Token breakdown</h2>
                  <span className="quiet text-xs">
                    {data.summary.knownTotals} / {data.summary.events} totals
                    reported · {data.summary.complete} token breakdowns balanced
                  </span>
                </div>
                <dl className="grid grid-cols-2 gap-5 p-5 sm:grid-cols-3 xl:grid-cols-5">
                  {[
                    ["Uncached input", data.summary.inputUncached],
                    ["Cache reads", data.summary.cacheRead],
                    ["Cache writes", data.summary.cacheWrite],
                    ["Output (non-reasoning)", data.summary.output],
                    ["Reasoning", data.summary.reasoning],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <dt className="quiet text-xs">{label}</dt>
                      <dd className="mt-2 font-mono text-lg">{count(value)}</dd>
                    </div>
                  ))}
                </dl>
                <details className="border-t px-5 py-4 text-xs">
                  <summary className="cursor-pointer text-muted-foreground">
                    How these numbers are counted
                  </summary>
                  <p className="quiet mt-3 leading-relaxed">
                    Unknown counts stay unknown. Retries and account fallbacks
                    are separate upstream requests. Subscription fees and
                    provider-wide quotas are separate from this ledger.
                  </p>
                  <p className="quiet mt-3 leading-relaxed">
                    Native Claude and Codex counts are reconciled against their
                    reported totals; ambiguous records remain unpriced. OAuth
                    tokens are not a per-token subscription bill. Host crashes
                    can lose usage before it reaches the plugin; unresolved
                    journal entries remain visible.
                  </p>
                </details>
              </section>
              {data.coverage && (
                <section className="surface mb-6 p-5">
                  <h2 className="font-medium">Delivery coverage</h2>
                  <dl className="mt-4 grid grid-cols-2 gap-5 lg:grid-cols-4">
                    {[
                      ["Matched request traces", data.coverage.matchedTraces],
                      [
                        "Completed without usage",
                        data.coverage.completedWithoutUsage,
                      ],
                      [
                        "Journal entries without a trace",
                        data.coverage.unlinkedJournal,
                      ],
                      [
                        "Usage records without a trace",
                        data.coverage.unlinkedUsage,
                      ],
                    ].map(([label, value]) => (
                      <div key={label}>
                        <dt className="quiet text-xs">{label}</dt>
                        <dd className="mt-2 font-mono text-lg">
                          {count(value)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  <p className="quiet mt-4 text-xs leading-relaxed">
                    Matched by the exact request trace. Retries can produce
                    several usage records for one trace. Completed requests get
                    30 seconds for delivery before appearing here without usage.
                    This flags missing observations; it cannot prove that every
                    token was captured. Older records without a full trace stay
                    unlinked.
                  </p>
                </section>
              )}
              <section className="surface mb-6 p-5">
                <h2 className="font-medium">Estimated value</h2>
                <p className="quiet mt-1 text-xs">
                  USD at your catalog rates. Subscription usage is an
                  API-equivalent comparison, not an invoice.
                </p>
                {!data.costs?.length ? (
                  <p className="quiet mt-4 text-sm">
                    No priced requests yet. Add matching rates in the price
                    catalog below.
                  </p>
                ) : (
                  <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                    {data.costs.map((c) => (
                      <div
                        key={`${c.kind}:${c.pricing_basis}`}
                        className="rounded-lg border bg-background/40 p-4"
                      >
                        <p className="quiet text-xs">
                          {c.kind === "api_equivalent"
                            ? "API-equivalent value"
                            : "Estimated API charges"}
                        </p>
                        <p className="mt-2 font-mono text-xl">
                          ${Number(c.usd).toFixed(6)}
                        </p>
                        <p className="mt-3 text-xs">
                          {pricingBasis[c.pricing_basis ?? ""] ??
                            "Unspecified pricing basis"}
                        </p>
                        <p className="quiet mt-1 text-[11px]">
                          {c.attempts} priced{" "}
                          {c.attempts === 1 ? "request" : "requests"}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </section>
              <details className="group surface mb-6">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary [&::-webkit-details-marker]:hidden">
                  <span>
                    <span className="block font-medium">Price catalog</span>
                    <span className="quiet mt-1 block text-xs">
                      {data.prices?.length ?? 0} saved rate versions · View
                      rates or add a version
                    </span>
                  </span>
                  <ChevronDown
                    size={17}
                    className="quiet transition-transform group-open:rotate-180"
                  />
                </summary>
                <div className="border-t p-4">
                  <PriceCatalog prices={data.prices ?? []} onSaved={load} />
                </div>
              </details>
              {!!data.recent.length && (
                <section className="surface mb-6">
                  <div className="border-b p-5">
                    <h2 className="font-medium">Recent upstream requests</h2>
                    <p className="quiet mt-1 text-xs">
                      Latest 50 requests. Totals above cover all recorded usage.
                    </p>
                  </div>
                  <Paginated
                    items={data.recent}
                    label="requests"
                    snapshot
                    loadedOnly
                  >
                    {(pageRows) =>
                      pageRows.map((e) => (
                        <div
                          key={e.event_id}
                          className="grid grid-cols-2 items-center gap-3 border-b p-4 text-xs last:border-0 xl:grid-cols-[150px_minmax(140px,1fr)_minmax(220px,1.5fr)_auto]"
                        >
                          <span className="quiet col-span-2 text-[11px] xl:col-span-1">
                            {time(e.started_at)}
                          </span>
                          <div className="min-w-0">
                            <p className="break-words">{e.model}</p>
                            <p className="quiet mt-1">
                              {account(e.account_id)}
                            </p>
                          </div>
                          <div className="min-w-0 text-right">
                            <span className="font-mono">
                              {count(e.reported_total)} tokens
                            </span>
                            {e.provider === "claude" &&
                              e.cache_write != null &&
                              BigInt(e.cache_write) > 0n && (
                                <span className="quiet mt-1 block text-[10px]">
                                  {e.cache_write_5m == null
                                    ? "Cache duration unknown"
                                    : `Cache writes: ${count(e.cache_write_5m)} at 5m · ${count(e.cache_write_1h)} at 1h`}
                                </span>
                              )}
                          </div>
                          <div className="col-span-2 flex flex-wrap items-center gap-2 xl:col-span-1 xl:justify-end">
                            <Badge
                              variant="outline"
                              className={
                                e.outcome === "succeeded"
                                  ? "border-primary/20 bg-primary/5 text-primary"
                                  : "border-amber-300/20 text-amber-300"
                              }
                            >
                              {e.outcome}
                            </Badge>
                            <Badge
                              variant="outline"
                              title="Token accounting quality"
                              className="text-muted-foreground"
                            >
                              {e.quality}
                            </Badge>
                          </div>
                        </div>
                      ))
                    }
                  </Paginated>
                </section>
              )}
              {data.cache && (
                <section className="surface mb-6 p-5">
                  <h2 className="font-medium">Claude Cache Writes</h2>
                  <div className="mt-4 grid gap-4 sm:grid-cols-3">
                    {[
                      ["5-minute writes", data.cache.fiveMinute],
                      ["1-hour writes", data.cache.oneHour],
                      ["Duration unknown", data.cache.unknownTokens],
                    ].map(([label, value]) => (
                      <div key={label}>
                        <p className="quiet text-xs">{label}</p>
                        <p className="mt-2 font-mono">{count(value)} tokens</p>
                      </div>
                    ))}
                  </div>
                  <p className="quiet mt-4 text-xs">
                    {data.cache.unknownRequests} requests have cache writes
                    without a verified duration split. New estimates for these
                    requests stay unpriced. Historical estimates retain their
                    original assumptions. Durations come from provider usage,
                    not the price settings.
                  </p>
                </section>
              )}
              <div className="mb-6 grid gap-5 md:grid-cols-2">
                {(
                  [
                    ["Clients", data.clients],
                    ["Sessions", data.sessions],
                  ] as const
                ).map(([label, rows]) => (
                  <section key={label} className="surface p-5">
                    <h2 className="font-medium">{label}</h2>
                    {!rows?.length ? (
                      <p className="quiet mt-3 text-xs">
                        No recorded {label.toLowerCase()} yet.
                      </p>
                    ) : (
                      <Paginated
                        items={rows}
                        label={label.toLowerCase()}
                        loadedOnly
                      >
                        {(pageRows) =>
                          pageRows.map((row) => (
                            <div
                              key={row.id}
                              className="mt-3 flex justify-between gap-4 border-t pt-3 text-xs"
                            >
                              <span className="font-mono">
                                {row.id.replace(/^v1:/, "").slice(0, 12)}
                              </span>
                              <span className="quiet">
                                {row.attempts} requests
                              </span>
                              <span>{count(row.tokens)} tokens</span>
                            </div>
                          ))
                        }
                      </Paginated>
                    )}
                  </section>
                ))}
              </div>
              <section className="surface mb-6">
                <div className="border-b p-5">
                  <h2 className="font-medium">Tokens by account and model</h2>
                </div>
                {!data.groups.length ? (
                  <EmptyState icon={Database} title="The ledger is ready">
                    Your next proxy requests will appear here once usage is
                    delivered by the plugin.
                  </EmptyState>
                ) : (
                  <Paginated
                    items={data.groups}
                    label="account and model totals"
                    loadedOnly
                  >
                    {(pageRows) => (
                      <div className="overflow-x-auto">
                        <table className="w-full text-left text-xs">
                          <thead className="quiet">
                            <tr>
                              {[
                                "Account",
                                "Provider / model",
                                "Upstream requests",
                                "Reported tokens",
                                "Totals known",
                              ].map((h) => (
                                <th key={h} className="p-4 font-normal">
                                  {h}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {pageRows.map((g, i) => (
                              <tr key={i} className="border-t">
                                <td className="p-4">{account(g.account_id)}</td>
                                <td className="p-4">
                                  {g.provider} / {g.model}
                                  {g.service_tier ? ` · ${g.service_tier}` : ""}
                                </td>
                                <td className="p-4">{g.attempts}</td>
                                <td className="p-4 font-mono">
                                  {count(g.tokens)}
                                </td>
                                <td className="p-4">
                                  {g.known_totals} / {g.attempts}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </Paginated>
                )}
              </section>
            </>
          )}
        </>
      )}
    </>
  );
}
