import { useEffect, useState } from "react";
import { FileJson, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api, errorMessage, type Credential } from "@/lib/api";
import {
  resolvedUsage,
  maskEmails,
  resetCountdown,
  type LiveUsage,
} from "@/lib/accounts";

export function AccountCard({ credential }: { credential: Credential }) {
  const [now, setNow] = useState(Date.now);
  const [live, setLive] = useState<LiveUsage>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const canFetch =
    (credential.provider === "claude" ||
      credential.provider === "codex" ||
      credential.supports_quota) &&
    Boolean(credential.auth_index);
  useEffect(() => {
    if (!canFetch) return;
    let active = true;
    const abort = new AbortController();
    setBusy(true);
    setError("");
    api<LiveUsage>(
      `/accounts/usage?auth_index=${encodeURIComponent(credential.auth_index!)}`,
      { signal: abort.signal },
    )
      .then((result) => {
        if (active) setLive(result);
      })
      .catch((err) => {
        if (active) setError(errorMessage(err));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
      abort.abort();
    };
  }, [credential, canFetch, revision]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);
  const usage = resolvedUsage(credential, live);
  const direct = usage.direct;
  return (
    <article className="min-w-0 p-5">
      <div className="flex flex-wrap items-center gap-3">
        <FileJson size={20} className="shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm">
            {maskEmails(credential.email || credential.name)}
          </p>
          <p className="quiet mt-1 text-xs">
            {credential.provider || credential.type}
          </p>
        </div>
        <Badge variant="outline" className="text-xs">
          {credential.disabled ? "Disabled" : credential.status || "Loaded"}
        </Badge>
      </div>
      {credential.status_message && (
        <p className="quiet mt-3 break-words text-xs">
          {maskEmails(credential.status_message)}
        </p>
      )}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="text-muted-foreground">
          Plan{" "}
          <span className="ml-1 text-foreground">
            {usage.plan ? maskEmails(usage.plan) : "Not reported"}
          </span>
        </span>
        {usage.limited && (
          <span className="text-amber-300">
            Limit reached at last observation
          </span>
        )}
        {canFetch && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            disabled={busy}
            onClick={() => setRevision((value) => value + 1)}
          >
            <RefreshCw size={12} className={busy ? "animate-spin" : ""} />
            {busy ? "Checking account…" : "Refresh usage"}
          </Button>
        )}
      </div>
      {(error || live?.usageError || live?.profileError) && (
        <p role="status" className="mt-3 text-xs text-amber-300">
          {maskEmails(
            error ||
              [live?.usageError, live?.profileError].filter(Boolean).join(" "),
          )}{" "}
          {live && error
            ? "Showing the last successful lookup."
            : "Available proxy observations are shown below."}
        </p>
      )}
      {live?.extraUsageEnabled !== undefined && (
        <p className="quiet mt-2 text-xs">
          Usage credits {live.extraUsageEnabled ? "enabled" : "disabled"}
        </p>
      )}
      {usage.windows.length > 0 ? (
        <>
          {!usage.hasData && (
            <p className="quiet mt-4 text-xs">
              {canFetch
                ? busy
                  ? "Fetching account usage…"
                  : "Account usage is unavailable. Try Refresh usage."
                : "No usage data yet. Usage appears after the provider reports it in a proxy response."}
            </p>
          )}
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {usage.windows.map((window) => {
              const expired =
                window.resetAt !== undefined && window.resetAt <= now;
              const percent =
                window.used === undefined
                  ? undefined
                  : Math.round(window.used * 10) / 10;
              return (
                <div
                  key={window.label}
                  className="rounded-lg border bg-background/40 p-3"
                >
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span>{maskEmails(window.label)}</span>
                    <span className="font-mono text-muted-foreground">
                      {percent === undefined ? "Unknown" : `${percent}% used`}
                    </span>
                  </div>
                  <div
                    role={percent === undefined ? undefined : "progressbar"}
                    aria-label={`${maskEmails(window.label)} usage at last observation`}
                    aria-valuemin={percent === undefined ? undefined : 0}
                    aria-valuemax={percent === undefined ? undefined : 100}
                    aria-valuenow={
                      percent === undefined ? undefined : Math.min(100, percent)
                    }
                    className="my-3 h-1.5 overflow-hidden rounded-full bg-muted"
                  >
                    {percent !== undefined && (
                      <div
                        className={`h-full rounded-full ${expired ? "bg-muted-foreground" : percent >= 90 ? "bg-amber-300" : "bg-primary"}`}
                        style={{ width: `${Math.min(100, percent)}%` }}
                      />
                    )}
                  </div>
                  <p className="quiet text-[11px]">
                    {window.resetAt === undefined
                      ? "Reset time not reported"
                      : resetCountdown(window.resetAt, now)}
                  </p>
                  {window.resetAt !== undefined && (
                    <time
                      dateTime={new Date(window.resetAt).toISOString()}
                      className="quiet mt-1 block text-[10px]"
                    >
                      {new Date(window.resetAt).toLocaleString()}
                    </time>
                  )}
                  {window.status && (
                    <p className="quiet mt-1 text-[10px]">
                      Last status: {maskEmails(window.status)}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
          <p className="quiet mt-3 text-[10px]">
            {usage.observedAt === undefined
              ? "No provider observation yet."
              : `Last observed ${new Date(usage.observedAt).toLocaleString()}.`}{" "}
            {direct
              ? `Source: ${live?.source || "Provider account usage"}, including activity outside this proxy. Quota lookups are limited to once every five minutes per account, with longer backoff after failures.`
              : "Source: proxy response observations. These may not include your latest account usage."}
          </p>
        </>
      ) : (
        <p className="quiet mt-3 text-xs">
          Usage windows aren’t available for this provider in the panel yet.
        </p>
      )}
    </article>
  );
}
