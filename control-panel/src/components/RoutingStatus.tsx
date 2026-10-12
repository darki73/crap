import { useEffect, useState } from "react";
import { api } from "@/lib/api";

type RoutingState = {
  strictRouting?: boolean;
  policy: { mode: "live" | "shadow"; minimumRemaining?: number };
  pluginRegistered?: boolean;
  plugins: { seen_at: string }[];
};

export function RoutingStatus({
  fallback,
  connected,
  onOpen,
}: {
  fallback: string;
  connected: boolean;
  onOpen: () => void;
}) {
  const [state, setState] = useState<RoutingState | null>();
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const next = await api<RoutingState>("/affinity/state");
        if (active) setState(next);
      } catch {
        if (active) setState(null);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 15000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [connected]);

  const healthy =
    state?.pluginRegistered &&
    state.plugins?.some((plugin) => {
      const age = Date.now() - Date.parse(plugin.seen_at);
      return age >= 0 && age < 30000;
    });
  let title = "Checking routing…";
  let detail = `Configured strategy: ${fallback}`;
  if (!connected) title = "Proxy offline";
  else if (state === null) title = "Routing status unavailable";
  else if (state) {
    if (state.strictRouting) {
      title = healthy
        ? "Strict affinity · Claude Code"
        : "Strict routing unavailable";
      detail = `Subscription accounts · ${state.policy.minimumRemaining ?? 5}% quota reserve · No automatic retries`;
    } else if (!state.pluginRegistered) {
      title = `${fallback} routing`;
      detail = "Affinity plugin inactive";
    } else if (!healthy) {
      title = "Affinity health unconfirmed";
      detail = `Configured fallback: ${fallback}`;
    } else if (state.policy.mode === "live") {
      title = "Affinity routing · Live";
      detail = `Sticky sessions + quota headroom · Fallback: ${fallback}`;
    } else {
      title = `${fallback} routing`;
      detail = "Affinity in shadow mode · Observing only";
    }
  }
  return (
    <div className="mt-8 flex flex-col items-center gap-2 text-center">
      <button
        type="button"
        onClick={onOpen}
        className="flex items-center gap-2 rounded-full border bg-background/70 px-3 py-1.5 text-[10px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span
          className={`size-1 rounded-full ${connected && healthy ? "bg-primary" : "bg-muted-foreground"}`}
        />
        {title}
      </button>
      <p className="text-[10px] text-muted-foreground">{detail}</p>
    </div>
  );
}
