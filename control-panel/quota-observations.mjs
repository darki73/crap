// Only validated per-window observations leave the passive header snapshot.
export function claudeResponseWindows(quota, now) {
  const observedAt = Date.parse(quota?.observed_at);
  if (!Number.isFinite(observedAt) || observedAt > now + 60_000) return [];
  const headers = Object.fromEntries(
    Object.entries(quota?.signals || {}).map(([k, v]) => [
      k.toLowerCase(),
      String(v),
    ]),
  );
  const windows = [];
  for (const [scope, label] of [
    ["5h", "5-hour window"],
    ["7d", "Weekly window"],
    ["7d_oi", "Weekly · Fable"],
  ]) {
    const prefix = `anthropic-ratelimit-unified-${scope}-`;
    const raw = headers[prefix + "utilization"],
      status = headers[prefix + "status"];
    const fraction = raw?.trim() ? Number(raw) : NaN;
    if (status !== "rejected" && (!Number.isFinite(fraction) || fraction < 0))
      continue;
    const reset = Number(headers[prefix + "reset"]);
    windows.push({
      label,
      used: status === "rejected" ? 100 : fraction * 100,
      ...(Number.isFinite(reset) && reset > 0 ? { resetAt: reset * 1000 } : {}),
      observedAt,
      source: "response",
      ...(status ? { status } : {}),
    });
  }
  return windows;
}
export function mergeResponseQuota(result, quota, now) {
  const updates = claudeResponseWindows(quota, now);
  if (!updates.length) return result;
  const windows = (result?.windows || []).map((w) => ({
    ...w,
    observedAt: w.observedAt ?? result.checkedAt,
    source: w.source || "poll",
  }));
  let changed = false;
  for (const update of updates) {
    const index = windows.findIndex((w) => w.label === update.label);
    if (index !== -1 && windows[index].observedAt >= update.observedAt)
      continue;
    if (index === -1) windows.push(update);
    else windows[index] = update;
    changed = true;
  }
  if (!changed) return result;
  return {
    ...result,
    windows,
    checkedAt: Math.max(...windows.map((w) => w.observedAt || 0)),
    source: "Response headers + quota polling",
  };
}
// Shared polling results can lag a replica's own response observations.
export function mergeQuotaResults(shared, local) {
  if (!shared) return local;
  if (!local) return shared;
  const windows = new Map();
  for (const result of [shared, local]) {
    for (const window of result.windows || []) {
      const incoming = {
        ...window,
        observedAt: window.observedAt ?? result.checkedAt,
        source: window.source || "poll",
      };
      const current = windows.get(window.label);
      if (!current || incoming.observedAt > current.observedAt)
        windows.set(window.label, incoming);
    }
  }
  return {
    ...shared,
    windows: [...windows.values()],
    checkedAt: Math.max(shared.checkedAt || 0, local.checkedAt || 0),
  };
}
export function completeFreshQuota(result, now, age) {
  const windows = result?.windows || [];
  return (
    ["5-hour window", "Weekly window"].every((label) =>
      windows.some((w) => w.label === label),
    ) &&
    windows.every(
      (w) =>
        Number.isFinite(w.used) &&
        w.used >= 0 &&
        Number.isFinite(w.observedAt) &&
        now - w.observedAt < age &&
        w.observedAt <= now + 60_000 &&
        (!w.resetAt || w.resetAt > now),
    )
  );
}
