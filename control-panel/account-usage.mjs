import { createHash } from "node:crypto";
import { createQuotaCache } from "./quota-cache.mjs";
import {
  mergeResponseQuota,
  mergeQuotaResults,
  completeFreshQuota,
} from "./quota-observations.mjs";

export const QUOTA_INTERVAL_MS = 5 * 60000;
const PROFILE_INTERVAL_MS = 24 * 60 * 60000;

function lookupError(provider, endpoint, result, now) {
  const error = new Error(
    `${provider} ${endpoint} lookup returned HTTP ${Number(result.status_code) || "error"}.`,
  );
  const header = Object.entries(result.header || {}).find(
    ([key]) => key.toLowerCase() === "retry-after",
  )?.[1];
  const value = Array.isArray(header) ? header[0] : header;
  const delay = /^\d+(\.\d+)?$/.test(value || "")
    ? Number(value) * 1000
    : Date.parse(value) - now;
  error.retryAfterMs = Number.isFinite(delay) && delay > 0 ? delay : 0;
  return error;
}

const numeric = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
const resetTime = (value) =>
  typeof value === "string" && Number.isFinite(Date.parse(value))
    ? Date.parse(value)
    : undefined;

// Return only display fields, never the raw profile, identity, or response headers.
export function normalizeClaudeUsage(usage, profile) {
  const windows = [];
  if (Array.isArray(usage?.limits) && usage.limits.length) {
    for (const limit of usage.limits.slice(0, 20)) {
      if (!limit || typeof limit !== "object") continue;
      const label =
        limit.kind === "session"
          ? "5-hour window"
          : limit.kind === "weekly_all"
            ? "Weekly window"
            : limit.kind === "weekly_scoped"
              ? `Weekly · ${String(limit.scope?.model?.display_name || "Model limit").slice(0, 60)}`
              : undefined;
      if (label)
        windows.push({
          label,
          used: numeric(limit.percent),
          resetAt: resetTime(limit.resets_at),
        });
    }
  }
  if (!windows.length) {
    for (const [key, label] of [
      ["five_hour", "5-hour window"],
      ["seven_day", "Weekly window"],
      ["seven_day_opus", "Weekly · Opus"],
      ["seven_day_sonnet", "Weekly · Sonnet"],
      ["seven_day_oauth_apps", "Weekly · OAuth apps"],
      ["seven_day_cowork", "Weekly · Cowork"],
    ]) {
      if (usage?.[key])
        windows.push({
          label,
          used: numeric(usage[key].utilization),
          resetAt: resetTime(usage[key].resets_at),
        });
    }
  }
  const org = profile?.organization;
  const plans = {
    claude_pro: "Pro",
    claude_max: "Max",
    claude_team: "Team",
    claude_enterprise: "Enterprise",
  };
  let plan = plans[org?.organization_type];
  if (org?.organization_type === "claude_max") {
    if (org.rate_limit_tier === "default_claude_max_5x") plan = "Max 5×";
    if (org.rate_limit_tier === "default_claude_max_20x") plan = "Max 20×";
  }
  if (!plan)
    plan =
      profile?.account?.has_claude_max === true
        ? "Max"
        : profile?.account?.has_claude_pro === true
          ? "Pro"
          : undefined;
  return {
    windows,
    plan,
    extraUsageEnabled:
      typeof usage?.extra_usage?.is_enabled === "boolean"
        ? usage.extra_usage.is_enabled
        : undefined,
  };
}

export function createAccountUsageReader({
  upstreamURL,
  managementKey,
  cacheFile,
  now = Date.now,
  fetcher = fetch,
  quotaAdmission,
}) {
  const cache = createQuotaCache(cacheFile);
  const pending = new Map();
  const management = async (path, body) => {
    const response = await fetcher(
      new URL(`/v8/management${path}`, upstreamURL),
      {
        method: body ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${managementKey}`,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: "error",
      },
    );
    if (!response.ok)
      throw new Error("The proxy could not read account details.");
    return response.json();
  };
  return async (authIndex, { refreshPlan = false } = {}) => {
    const credentials = await management("/credentials");
    const credential = credentials.files?.find(
      (item) => item.auth_index === authIndex,
    );
    if (!credential)
      throw new Error("Select a connected account to read usage.");
    if (pending.has(authIndex)) return pending.get(authIndex);
    const read = async () => {
      const key = createHash("sha256")
        .update(`${upstreamURL.origin}\0${credential.provider}\0${authIndex}`)
        .digest("hex");
      let existing = await cache.get(key);
      if (credential.provider === "claude") {
        const merged = mergeResponseQuota(
          existing?.result,
          credential.quota,
          now(),
        );
        if (merged && merged !== existing?.result) {
          if (completeFreshQuota(merged, now(), QUOTA_INTERVAL_MS))
            merged.usageError = undefined;
          existing = { ...existing, result: merged };
          await cache.set(key, existing);
        }
      }
      let profileState = existing?.profile;
      const callClaude = async (endpoint) => {
        const request = {
          auth_index: authIndex,
          method: "GET",
          url: `https://api.anthropic.com/api/oauth/${endpoint}`,
          header: {
            Authorization: "Bearer $TOKEN$",
            "anthropic-beta": "oauth-2025-04-20",
            Accept: "application/json",
          },
        };
        let result;
        if (process.env.CRAP_STRICT_INTERNAL_URL) {
          const response = await fetcher(
            new URL("/account-read", process.env.CRAP_STRICT_INTERNAL_URL),
            {
              method: "POST",
              redirect: "error",
              headers: {
                "Content-Type": "application/json",
                "X-Crap-Service": process.env.AFFINITY_CONTROL_TOKEN,
              },
              body: JSON.stringify({ authIndex, endpoint }),
            },
          );
          if (!response.ok)
            throw new Error("Strict account lookup is unavailable.");
          result = await response.json();
        } else result = await management("/requests/api-call", request);
        if (result.status_code !== 200)
          throw lookupError("Claude", endpoint, result, now());
        try {
          return JSON.parse(result.body);
        } catch {
          throw new Error(
            `Claude returned an unreadable ${endpoint} response.`,
          );
        }
      };
      const profileRefreshAllowed = () =>
        now() >=
        (profileState?.refreshAfter ??
          (existing?.result?.profileError ? profileState?.nextAttempt : 0) ??
          0);
      const refreshProfile = async () => {
        // Persist admission independently of quota, including across restarts.
        profileState = {
          ...profileState,
          refreshAfter: now() + QUOTA_INTERVAL_MS,
        };
        await cache.set(key, {
          ...(await cache.get(key)),
          profile: profileState,
        });
        try {
          const plan = normalizeClaudeUsage(
            undefined,
            await callClaude("profile"),
          ).plan;
          profileState = {
            plan,
            checkedAt: now(),
            nextAttempt: now() + PROFILE_INTERVAL_MS,
            refreshAfter: now() + QUOTA_INTERVAL_MS,
          };
        } catch (error) {
          const retryAt = now() + Math.max(30 * 60000, error.retryAfterMs || 0);
          profileState = {
            ...profileState,
            error: error.message,
            nextAttempt: retryAt,
            refreshAfter: retryAt,
          };
        }
      };
      if (
        existing &&
        (now() < existing.nextAttempt ||
          (credential.provider === "claude" &&
            existing.result.inventoryCheckedAt !== undefined &&
            now() - existing.result.inventoryCheckedAt < PROFILE_INTERVAL_MS &&
            completeFreshQuota(existing.result, now(), QUOTA_INTERVAL_MS)))
      ) {
        if (
          credential.provider !== "claude" ||
          (!refreshPlan && profileState && now() < profileState.nextAttempt) ||
          !profileRefreshAllowed() ||
          existing.result.usageError
        )
          return existing.result;
        await refreshProfile();
        const result = {
          ...existing.result,
          plan: profileState.plan,
          planCheckedAt: profileState.checkedAt,
          planRefreshAt: profileState.refreshAfter,
          profileError: profileState.error,
        };
        await cache.set(key, { ...existing, profile: profileState, result });
        return result;
      }
      const startedAt = now();
      const admission = quotaAdmission
        ? await quotaAdmission.begin(
            credential.id || credential.name || authIndex,
            credential.provider,
          )
        : null;
      if (admission && !admission.granted) {
        const result = {
          ...(mergeQuotaResults(admission.result, existing?.result) || {
            windows: [],
            checkedAt: startedAt,
            usageError:
              "Quota refresh reserved by another collector; waiting for its result.",
          }),
          nextAttemptAt: admission.nextAttemptAt,
        };
        const merged =
          credential.provider === "claude"
            ? mergeResponseQuota(result, credential.quota, now())
            : result;
        if (
          credential.provider === "claude" &&
          completeFreshQuota(merged, now(), QUOTA_INTERVAL_MS)
        )
          merged.usageError = undefined;
        // Revisit the shared result locally while the owner is completing its request.
        await cache.set(key, {
          ...existing,
          result: merged,
          nextAttempt: Math.min(admission.nextAttemptAt, now() + 15_000),
        });
        return merged;
      }
      const unavailable = {
        windows: [],
        checkedAt: startedAt,
        usageError:
          "Quota lookup pending; retry after the collection interval.",
        plan: existing?.profile?.plan,
      };
      // Persist admission before calling upstream so restarts cannot bypass the interval.
      await cache.set(key, {
        ...existing,
        nextAttempt: startedAt + QUOTA_INTERVAL_MS,
        result: unavailable,
      });
      let retryAfterMs = 0;
      const finish = async (result) => {
        if (!result.usageError) {
          result.inventoryCheckedAt = result.checkedAt;
          result.windows = result.windows.map((w) => ({
            ...w,
            observedAt: result.checkedAt,
            source: "poll",
          }));
          if (credential.provider === "claude")
            result = mergeResponseQuota(result, credential.quota, now());
        } else if (existing?.result?.windows?.length) {
          result.windows = existing.result.windows;
          // A polling failure never refreshes the age of retained measurements.
          result.checkedAt = existing.result.checkedAt;
        }
        const failures = result.usageError ? (existing?.failures || 0) + 1 : 0;
        const delay = failures
          ? Math.max(
              retryAfterMs,
              Math.min(
                30 * 60000,
                QUOTA_INTERVAL_MS * 2 ** Math.min(failures - 1, 3),
              ),
            )
          : QUOTA_INTERVAL_MS;
        result.nextAttemptAt = now() + delay;
        await cache.set(key, {
          result,
          profile: profileState,
          failures,
          nextAttempt: result.nextAttemptAt,
        });
        if (admission)
          await quotaAdmission.finish(admission, result.nextAttemptAt, result);
        return result;
      };
      try {
        if (credential.provider !== "claude") {
          let normalized;
          let source;
          if (credential.provider === "codex") {
            const result = await management("/requests/api-call", {
              auth_index: authIndex,
              method: "GET",
              url: "https://chatgpt.com/backend-api/wham/usage",
              header: {
                Authorization: "Bearer $TOKEN$",
                Accept: "application/json",
                ...(credential.id_token?.chatgpt_account_id
                  ? {
                      "Chatgpt-Account-Id":
                        credential.id_token.chatgpt_account_id,
                    }
                  : {}),
              },
            });
            if (result.status_code !== 200)
              throw lookupError("Codex", "usage", result, now());
            normalized = normalizeCodexUsage(JSON.parse(result.body));
            source = "Codex account usage";
          } else {
            const plugins = await management("/plugins");
            const plugin = plugins.plugins?.find(
              (item) =>
                item.supports_quota &&
                item.effective_enabled &&
                item.quota_provider ===
                  (credential.quota_provider || credential.provider),
            );
            if (!plugin)
              throw new Error(
                "No active quota plugin is available for this provider.",
              );
            normalized = normalizePluginUsage(
              await management(
                `/plugins/${encodeURIComponent(plugin.id)}/quota?auth_index=${encodeURIComponent(authIndex)}`,
              ),
            );
            source = `Plugin: ${plugin.id}`;
          }
          const result = {
            ...normalized,
            source,
            checkedAt: now(),
            usageError: normalized.windows.length
              ? undefined
              : "The provider did not return recognized usage windows.",
          };
          return finish(result);
        }
        // Fetch quota first; a rate-limited account must not immediately receive a profile call.
        const usage = await callClaude("usage");
        if (
          profileRefreshAllowed() &&
          (!profileState || now() >= profileState.nextAttempt || refreshPlan)
        )
          await refreshProfile();
        const result = {
          ...normalizeClaudeUsage(usage),
          plan: profileState?.plan,
          checkedAt: now(),
          source: "Claude account usage",
          profileError: profileState?.error,
          planCheckedAt: profileState?.checkedAt,
          planRefreshAt: profileState?.refreshAfter,
        };
        if (!result.usageError && !result.windows.length)
          result.usageError = "Claude did not return recognized usage windows.";
        return finish(result);
      } catch (error) {
        if (!["claude", "codex"].includes(credential.provider)) throw error;
        retryAfterMs = error.retryAfterMs || 0;
        return finish({
          ...unavailable,
          checkedAt: now(),
          usageError: error.message,
        });
      }
    };
    const task = read().finally(() => pending.delete(authIndex));
    pending.set(authIndex, task);
    return task;
  };
}

export function normalizeCodexUsage(data) {
  const windows = [];
  const groups = [
    ["", data?.rate_limit],
    ["Code review", data?.code_review_rate_limits],
  ];
  for (const limit of (Array.isArray(data?.additional_rate_limits)
    ? data.additional_rate_limits
    : []
  ).slice(0, 8)) {
    groups.push([
      String(limit?.limit_name || "Additional limit").slice(0, 60),
      limit?.rate_limit || limit,
    ]);
  }
  for (const [prefix, limits] of groups) {
    for (const [key, fallback] of [
      ["primary_window", "Primary window"],
      ["secondary_window", "Secondary window"],
    ]) {
      const window = limits?.[key];
      if (!window) continue;
      const duration = numeric(window.limit_window_seconds);
      const resetAt = numeric(window.reset_at);
      windows.push({
        label:
          (prefix ? `${prefix} · ` : "") +
          (duration === 18000
            ? "5-hour window"
            : duration === 604800
              ? "Weekly window"
              : fallback),
        used: numeric(window.used_percent),
        resetAt:
          resetAt && Number.isFinite(new Date(resetAt * 1000).getTime())
            ? resetAt * 1000
            : undefined,
      });
    }
  }
  return {
    windows,
    plan:
      typeof data?.plan_type === "string"
        ? data.plan_type.slice(0, 60)
        : undefined,
  };
}
export function normalizePluginUsage(data) {
  const windows = [];
  for (const group of (Array.isArray(data?.groups) ? data.groups : []).slice(
    0,
    30,
  )) {
    for (const bucket of (Array.isArray(group.buckets)
      ? group.buckets
      : []
    ).slice(0, 30)) {
      const remaining = numeric(
        bucket.remainingFraction ?? bucket.remaining_fraction,
      );
      windows.push({
        label: String(
          [
            group.displayName || group.display_name,
            bucket.window || bucket.description,
          ]
            .filter(Boolean)
            .join(" · ") || "Quota window",
        ).slice(0, 120),
        used:
          remaining === undefined
            ? undefined
            : Math.max(0, 100 * (1 - remaining)),
        resetAt: resetTime(bucket.resetTime || bucket.reset_time),
      });
    }
  }
  const plan = data?.subscription?.plan || data?.subscription?.tierName;
  return {
    windows,
    plan: typeof plan === "string" ? plan.slice(0, 60) : undefined,
  };
}
