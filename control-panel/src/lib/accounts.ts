import type { Credential } from "./api";

// Mask addresses wherever they occur, including credential filenames and errors.
export function maskEmails(value: string): string {
  return value.replace(/[^\s<>/@]+@[^\s<>/@]+/g, (email) => {
    const [local, domain] = email.split("@");
    return `${local[0]}•••@${domain[0]}•••`;
  });
}

export type UsageWindow = {
  observedAt?: number;
  source?: string;
  label: string;
  used?: number;
  resetAt?: number;
  status?: string;
};
export type LiveUsage = {
  source?: string;
  windows: UsageWindow[];
  plan?: string;
  checkedAt: number;
  usageError?: string;
  profileError?: string;
  planCheckedAt?: number;
  planRefreshAt?: number;
  extraUsageEnabled?: boolean;
};

export function resolvedUsage(credential: Credential, live?: LiveUsage) {
  const observed = accountUsage(credential);
  const direct = Boolean(live && !live.usageError);
  const windows = direct ? live!.windows : observed.windows;
  return {
    ...observed,
    direct,
    windows,
    plan: live?.plan || observed.plan,
    hasData: direct ? windows.length > 0 : observed.hasData,
    observedAt: direct ? live!.checkedAt : observed.observedAt,
    limited: direct
      ? windows.some((window) => (window.used ?? 0) >= 100)
      : observed.limited,
  };
}

export function windowPercent(window: UsageWindow, remaining: boolean) {
  return window.used === undefined
    ? undefined
    : remaining
      ? Math.max(0, 100 - window.used)
      : window.used;
}

export function averageWindow(
  windows: (UsageWindow | undefined)[],
  remaining: boolean,
) {
  const values = windows.flatMap((window) =>
    window?.used === undefined ? [] : [windowPercent(window, remaining)!],
  );
  return {
    percent: values.length
      ? values.reduce((a, b) => a + b, 0) / values.length
      : undefined,
    count: values.length,
  };
}

function number(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function timestamp(value: string | undefined): number | undefined {
  const seconds = number(value);
  if (seconds === undefined || seconds === 0) return undefined;
  const millis = seconds * 1000;
  return Number.isFinite(new Date(millis).getTime()) ? millis : undefined;
}

export function accountUsage(credential: Credential) {
  const signals = Object.fromEntries(
    Object.entries(credential.quota?.signals ?? {}).map(([key, value]) => [
      key.toLowerCase(),
      value,
    ]),
  );
  const observed = Date.parse(credential.quota?.observed_at ?? "");
  const observedAt = Number.isFinite(observed) ? observed : undefined;
  const provider = credential.provider?.toLowerCase();
  const windows: UsageWindow[] = [];
  const add = (label: string, prefix: string, fraction: boolean) => {
    const rawUsed = number(
      signals[`${prefix}${fraction ? "utilization" : "used-percent"}`],
    );
    const resetAfter = number(signals[`${prefix}reset-after-seconds`]);
    const resetAt =
      timestamp(signals[`${prefix}${fraction ? "reset" : "reset-at"}`]) ??
      (resetAfter !== undefined && observedAt !== undefined
        ? observedAt + resetAfter * 1000
        : undefined);
    windows.push({
      label,
      used: rawUsed === undefined ? undefined : rawUsed * (fraction ? 100 : 1),
      resetAt,
      status: signals[`${prefix}status`],
    });
  };
  if (provider === "claude") {
    add("5-hour window", "anthropic-ratelimit-unified-5h-", true);
    add("Weekly window", "anthropic-ratelimit-unified-7d-", true);
  } else if (provider === "codex") {
    for (const [key, fallback] of [
      ["primary", "Primary window"],
      ["secondary", "Secondary window"],
    ]) {
      const minutes = number(signals[`x-codex-${key}-window-minutes`]);
      const label =
        minutes === 300
          ? "5-hour window"
          : minutes === 10080
            ? "Weekly window"
            : minutes
              ? `${minutes}-minute window`
              : fallback;
      add(label, `x-codex-${key}-`, false);
    }
  }
  return {
    windows,
    observedAt,
    hasData: windows.some(
      (window) =>
        window.used !== undefined ||
        window.resetAt !== undefined ||
        window.status,
    ),
    plan: provider === "codex" ? signals["x-codex-plan-type"] : undefined,
    limited:
      signals["anthropic-ratelimit-unified-status"] === "rejected" ||
      signals["x-codex-limit-reached"] === "true",
  };
}

export function resetCountdown(resetAt: number, now: number): string {
  if (resetAt <= now) return "Reset time passed · awaiting an update";
  const minutes = Math.ceil((resetAt - now) / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  return `Resets in ${days ? `${days}d ` : ""}${hours ? `${hours}h ` : ""}${minutes % 60}m`;
}
