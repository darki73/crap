import { useEffect, useRef, useState } from "react";
import {
  Bot,
  CheckCircle2,
  ExternalLink,
  KeyRound,
  Loader2,
  Network,
  Send,
  ShieldCheck,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { api, errorMessage, write } from "@/lib/api";

export type IntegrationStatus = {
  tailscale: {
    enabled: boolean;
    installed?: boolean;
    hostname: string;
    allowedUsers: string[];
    dashboard: boolean;
    api: boolean;
    phase: string;
    authUrl?: string;
    dashboardUrl?: string;
    apiUrl?: string;
    error?: string;
  };
  telegram: {
    enabled: boolean;
    configured: boolean;
    username: string;
    paired: boolean;
    chatLabel: string;
    alerts: Record<string, boolean>;
    threshold: number;
    digestHour: number;
    pairing: { url: string; expires: number } | null;
  };
  dashboardAddress: string;
  notificationBase: string | null;
  workerError?: string;
  deliveries: {
    id: string;
    kind: string;
    status: string;
    createdAt: number;
    error?: string;
  }[];
};
type Status = IntegrationStatus;

export function IntegrationsSetup({
  kind,
  onClose,
}: {
  kind: "tailscale" | "telegram";
  onClose: () => void;
}) {
  const [status, setStatus] = useState<Status | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  const pairingActive = useRef(0);
  pairingActive.current = status?.telegram.pairing?.expires ?? 0;
  const [hostname, setHostname] = useState("crap"),
    [users, setUsers] = useState(""),
    [dashboard, setDashboard] = useState(true),
    [inference, setInference] = useState(false),
    [method, setMethod] = useState("browser"),
    [authKey, setAuthKey] = useState(""),
    [accessConfirmed, setAccessConfirmed] = useState(false);
  const [token, setToken] = useState(""),
    [enabled, setEnabled] = useState(false),
    [alerts, setAlerts] = useState<Record<string, boolean>>({
      account: true,
      quota: true,
      service: true,
      daily: false,
    }),
    [threshold, setThreshold] = useState(20),
    [hour, setHour] = useState(9),
    [address, setAddress] = useState("");
  useEffect(() => {
    let cancelled = false,
      timer: ReturnType<typeof setTimeout>;
    let initialized = false;
    async function refresh() {
      try {
        const data = await api<Status>("/integrations");
        if (cancelled) return;
        if (
          pairingActive.current > Date.now() &&
          !data.telegram.pairing &&
          data.telegram.paired
        )
          setNotice("Chat paired. You can send a test message now.");
        pairingActive.current = data.telegram.pairing?.expires ?? 0;
        setStatus(data);
        if (!initialized) {
          setHostname(data.tailscale.hostname);
          setUsers(data.tailscale.allowedUsers.join("\n"));
          setDashboard(data.tailscale.dashboard);
          setInference(data.tailscale.api);
          setEnabled(data.telegram.enabled);
          setAlerts(data.telegram.alerts);
          setThreshold(data.telegram.threshold);
          setHour(data.telegram.digestHour);
          setAddress(data.dashboardAddress);
          initialized = true;
        }
      } catch (e) {
        if (!cancelled) setError(errorMessage(e));
      }
      if (!cancelled)
        timer = setTimeout(refresh, pairingActive.current ? 1000 : 3000);
    }
    void refresh();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);
  async function action(
    name: string,
    input: unknown = {},
    message = "Settings saved.",
  ) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const data = await write<Status>(`/integrations/${name}`, "POST", input);
      setStatus(data);
      setNotice(message);
      if (name === "telegram/connect") setToken("");
      if (name === "tailscale/connect") setAuthKey("");
      if (name === "telegram/disconnect") setEnabled(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const tail = status?.tailscale,
    tg = status?.telegram;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="max-h-[90vh] overflow-y-auto p-0 sm:max-w-3xl"
      >
        <DialogHeader className="sticky top-0 z-10 border-b bg-background px-6 pb-5 pt-6 text-left">
          <Button
            size="icon"
            variant="ghost"
            aria-label="Close"
            className="absolute top-2 right-2"
            onClick={onClose}
          >
            <X size={16} />
          </Button>
          <div className="mb-3 flex items-center gap-2 text-xs text-primary">
            {kind === "tailscale" ? <Network size={16} /> : <Bot size={16} />}{" "}
            {kind.toUpperCase()}
            <span className="ml-2 rounded-full border px-2 py-0.5 text-[10px] text-muted-foreground">
              Live Integration
            </span>
          </div>
          <DialogTitle className="text-2xl font-medium tracking-tight">
            {kind === "tailscale"
              ? "Your control room. Wherever you are."
              : "Your workspace, in your pocket."}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {kind === "tailscale"
              ? "Join your private network with a dedicated CRAP device. Choose exactly who can reach it."
              : "Connect your own bot, pair a private chat and choose the updates you want."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-5 px-6 pb-6">
          {!status && (
            <p className="quiet flex items-center gap-2 text-xs">
              <Loader2 size={15} className="animate-spin" />
              Loading saved integration settings…
            </p>
          )}
          {error && (
            <p
              role="alert"
              className="rounded-lg border border-destructive/30 p-3 text-xs text-destructive"
            >
              {error}
            </p>
          )}
          {notice && (
            <p
              role="status"
              className="flex items-center gap-2 rounded-lg border border-primary/20 bg-primary/5 p-3 text-xs"
            >
              <CheckCircle2 size={15} />
              {notice}
            </p>
          )}
          {kind === "tailscale" && tail && (
            <>
              <section className="rounded-lg border bg-primary/5 p-4">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-medium">Private Access</p>
                  <span className="rounded-full border px-2 py-1 text-[11px]">
                    {tail.enabled ? tail.phase : "Disconnected"}
                  </span>
                </div>
                <p className="quiet mt-2 text-xs leading-relaxed">
                  A separate embedded Tailscale node. Your computer's VPN
                  settings stay independent. Only the login identities listed
                  below can open CRAP; tailnet access rules also apply.
                </p>
                {tail.error && (
                  <p className="mt-3 text-xs text-amber-400">{tail.error}</p>
                )}
                {tail.authUrl && (
                  <a
                    className="mt-4 inline-flex items-center gap-2 text-xs text-primary hover:underline"
                    href={tail.authUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Approve This Device in Tailscale <ExternalLink size={14} />
                  </a>
                )}
                {tail.dashboardUrl && (
                  <p className="mt-3 text-xs">
                    Dashboard:{" "}
                    <a
                      href={tail.dashboardUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary hover:underline"
                    >
                      {tail.dashboardUrl}
                    </a>
                  </p>
                )}
                {tail.apiUrl && (
                  <p className="mt-2 text-xs">
                    Inference API Origin:{" "}
                    <span className="font-mono text-primary">
                      {tail.apiUrl}
                    </span>
                  </p>
                )}
              </section>
              <fieldset disabled={busy} className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  {[
                    [
                      "browser",
                      "Sign in With Your Browser",
                      "Approve a device link. No key to copy.",
                    ],
                    [
                      "key",
                      "Use an Auth Key",
                      "Enroll with a device key from Tailscale.",
                    ],
                  ].map(([id, title, detail]) => (
                    <button
                      type="button"
                      key={id}
                      aria-pressed={method === id}
                      onClick={() => setMethod(id)}
                      className={`rounded-lg border p-4 text-left ${method === id ? "border-primary bg-primary/5" : ""}`}
                    >
                      <KeyRound size={17} className="mb-3 text-primary" />
                      <p className="text-xs font-medium">{title}</p>
                      <p className="quiet mt-2 text-[11px]">{detail}</p>
                    </button>
                  ))}
                </div>
                {method === "key" && (
                  <label className="block space-y-2 text-xs">
                    <span>Tailscale Device Auth Key</span>
                    <Input
                      type="password"
                      autoComplete="off"
                      placeholder="tskey-auth-…"
                      value={authKey}
                      onChange={(e) => setAuthKey(e.target.value)}
                    />
                    <span className="quiet block text-[11px]">
                      Used only for enrollment. It is not saved in the database.
                      API tokens and OAuth client secrets are different
                      credentials.
                    </span>
                  </label>
                )}
                <label className="block space-y-2 text-xs">
                  <span>Workspace Hostname</span>
                  <Input
                    value={hostname}
                    onChange={(e) => setHostname(e.target.value)}
                    maxLength={63}
                  />
                </label>
                <label className="block space-y-2 text-xs">
                  <span>Allowed Tailscale Logins</span>
                  <textarea
                    className="min-h-20 w-full rounded-md border bg-background p-3"
                    placeholder="Your Tailscale login email, one per line"
                    value={users}
                    onChange={(e) => setUsers(e.target.value)}
                  />
                  <span className="quiet block text-[11px]">
                    These users receive full dashboard access. Shared or tagged
                    devices are not automatically trusted. Enter your Tailscale
                    login email, which may differ from your provider account
                    email.
                  </span>
                </label>
                <div className="divide-y rounded-lg border px-4">
                  <Option
                    title="Control Room"
                    detail="Dashboard and management over private HTTPS."
                    checked={dashboard}
                    set={setDashboard}
                  />
                  <Option
                    title="Inference API"
                    detail="OpenAI and Claude endpoints on port 8443. Requires an allowed user device and a client API key."
                    checked={inference}
                    set={setInference}
                  />
                </div>
                <label className="flex items-start gap-3 rounded-lg border p-3 text-xs leading-relaxed">
                  <input
                    type="checkbox"
                    className="mt-0.5 accent-primary"
                    checked={accessConfirmed}
                    onChange={(e) => setAccessConfirmed(e.target.checked)}
                  />
                  Enable private network access for the listed Tailscale
                  identities. I have reviewed who will be able to manage this
                  workspace.
                </label>
                <div className="flex flex-wrap gap-3">
                  <Button
                    size="sm"
                    disabled={
                      !accessConfirmed ||
                      !users.trim() ||
                      (!dashboard && !inference) ||
                      (method === "key" && !authKey)
                    }
                    onClick={() =>
                      action(
                        "tailscale/connect",
                        {
                          hostname,
                          allowedUsers: users
                            .split(/[\n,]/)
                            .map((x) => x.trim())
                            .filter(Boolean),
                          dashboard,
                          api: inference,
                          authKey: method === "key" ? authKey : "",
                        },
                        "Connection started. Complete device approval if shown above.",
                      )
                    }
                  >
                    {busy ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Network size={14} />
                    )}{" "}
                    {tail.enabled
                      ? "Reconnect With These Settings"
                      : "Connect Tailscale"}
                  </Button>
                  {tail.enabled && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        action(
                          "tailscale/disconnect",
                          {},
                          "Private access disabled. Device identity is retained for reconnecting.",
                        )
                      }
                    >
                      Disconnect
                    </Button>
                  )}
                </div>
              </fieldset>
              <div className="rounded-lg border p-4 text-xs">
                <p className="flex items-center gap-2 font-medium">
                  <ShieldCheck size={16} className="text-primary" />A Private
                  Entry Point
                </p>
                <p className="quiet mt-2 leading-relaxed">
                  Enable MagicDNS and HTTPS certificates in your tailnet. CRAP
                  never enables public Funnel access. The dashboard uses the
                  built web app; local development continues on Vite.
                </p>
                <a
                  href="https://login.tailscale.com/admin/dns"
                  target="_blank"
                  rel="noreferrer"
                  className="mt-3 inline-flex items-center gap-1 text-primary hover:underline"
                >
                  Tailscale DNS & HTTPS Settings <ExternalLink size={12} />
                </a>
              </div>
            </>
          )}
          {kind === "telegram" && tg && (
            <>
              <section className="rounded-lg border bg-primary/5 p-4">
                <p className="flex items-center gap-2 text-sm font-medium">
                  <Bot size={17} className="text-primary" />
                  {tg.configured ? `@${tg.username}` : "Connect Your Bot"}
                </p>
                <p className="quiet mt-2 text-xs">
                  {tg.paired
                    ? tg.chatLabel
                    : "Use a dedicated bot created with BotFather. No public webhook or inbound port is required."}
                </p>
                <p className="mt-3 text-xs text-primary">
                  {tg.enabled
                    ? "Notifications enabled"
                    : tg.paired
                      ? "Chat paired · Notifications paused"
                      : tg.configured
                        ? "Bot verified · Pair a private chat next"
                        : "Waiting for your bot token"}
                </p>
              </section>
              <fieldset disabled={busy} className="space-y-4">
                <label className="block space-y-2 text-xs">
                  <span>Bot Token</span>
                  <Input
                    type="password"
                    autoComplete="off"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder={
                      tg.configured
                        ? "Enter a token to replace this bot"
                        : "Paste the token from @BotFather"
                    }
                  />
                  <span className="quiet block text-[11px]">
                    Encrypted before saving to PostgreSQL. Saved tokens are
                    never sent back to your browser. Replacing a bot clears its
                    pairing.
                  </span>
                </label>
                <div className="flex items-center gap-4">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!token}
                    onClick={() =>
                      action(
                        "telegram/connect",
                        { token },
                        "Bot verified. Pair your private chat next.",
                      )
                    }
                  >
                    Verify & Save Bot
                  </Button>
                  <a
                    href="https://t.me/BotFather"
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-primary"
                  >
                    Open BotFather <ExternalLink size={12} />
                  </a>
                </div>
                {tg.configured && (
                  <section className="space-y-3 rounded-lg border p-4">
                    <p className="text-xs font-medium">
                      Pair Your Private Chat
                    </p>
                    <p className="quiet text-xs leading-relaxed">
                      Generate a single-use link, open it in Telegram and press
                      Start. CRAP only accepts the matching code in a private
                      chat. Pairing expires after ten minutes.
                    </p>
                    {tg.pairing ? (
                      <>
                        <a
                          className="inline-flex items-center gap-2 text-xs text-primary hover:underline"
                          href={tg.pairing.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open Telegram & Press Start <ExternalLink size={13} />
                        </a>
                        <p
                          role="status"
                          className="flex items-center gap-2 text-xs text-muted-foreground"
                        >
                          <Loader2 size={13} className="animate-spin" />
                          Waiting for Start in Telegram. Checking every two
                          seconds.
                        </p>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            action(
                              "telegram/cancel-pair",
                              {},
                              "Pairing cancelled.",
                            )
                          }
                        >
                          Cancel Pairing
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          action(
                            "telegram/pair",
                            {},
                            "Pairing link ready. Open it in Telegram and press Start.",
                          )
                        }
                      >
                        {tg.paired
                          ? "Pair a Different Chat"
                          : "Generate Pairing Link"}
                      </Button>
                    )}
                    {tg.paired && (
                      <p className="text-xs text-primary">
                        Connected to {tg.chatLabel}
                      </p>
                    )}
                  </section>
                )}
                <div className="divide-y rounded-lg border px-4">
                  {[
                    [
                      "account",
                      "Account Needs Attention",
                      "An enabled account reports an error.",
                    ],
                    [
                      "quota",
                      "Quota Running Low",
                      "Uses existing quota observations; adds no provider quota requests.",
                    ],
                    [
                      "service",
                      "Proxy Unavailable",
                      "After consecutive failed local checks.",
                    ],
                    [
                      "daily",
                      "Daily Summary",
                      "Reported requests and tokens from the last 24 hours.",
                    ],
                  ].map(([key, title, detail]) => (
                    <Option
                      key={key}
                      title={title}
                      detail={detail}
                      checked={!!alerts[key]}
                      set={(value) => setAlerts({ ...alerts, [key]: value })}
                    />
                  ))}
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="space-y-2 text-xs">
                    <span>Alert Below Remaining Quota (%)</span>
                    <Input
                      type="number"
                      min={1}
                      max={99}
                      value={threshold}
                      onChange={(e) => setThreshold(Number(e.target.value))}
                    />
                  </label>
                  <label className="space-y-2 text-xs">
                    <span>Daily Summary Hour (UTC)</span>
                    <Input
                      type="number"
                      min={0}
                      max={23}
                      value={hour}
                      onChange={(e) => setHour(Number(e.target.value))}
                    />
                  </label>
                </div>
                <section className="space-y-3 rounded-lg border p-4">
                  <p className="text-xs font-medium">Dashboard Links</p>
                  <p className="quiet text-xs leading-relaxed">
                    {tail?.enabled && tail.dashboard
                      ? "Tailscale dashboard access is enabled. Notifications use its verified live address; links are omitted while it is disconnected."
                      : "Tailscale dashboard access is disabled. Set another reachable dashboard address, or receive notifications without a link."}
                  </p>
                  <label className="block space-y-2 text-xs">
                    <span>Fallback Dashboard Address</span>
                    <Input
                      value={address}
                      onChange={(e) => setAddress(e.target.value)}
                      placeholder="https://your-dashboard.example"
                    />
                  </label>
                  <p className="text-[11px] text-primary">
                    Current destination:{" "}
                    {status?.notificationBase ||
                      "No link · notification text only"}
                  </p>
                </section>
                <Option
                  title="Enable Notifications"
                  detail="Send the selected alerts to your paired private chat."
                  checked={enabled}
                  set={setEnabled}
                />
                <div className="flex flex-wrap gap-3">
                  <Button
                    size="sm"
                    onClick={() =>
                      action("telegram/preferences", {
                        enabled,
                        alerts,
                        threshold,
                        digestHour: hour,
                        dashboardAddress: address,
                      })
                    }
                  >
                    Save Preferences
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!tg.paired}
                    onClick={() =>
                      action(
                        "telegram/test",
                        {},
                        "Test processed. Check delivery status below.",
                      )
                    }
                  >
                    <Send size={14} />
                    Send Test Message
                  </Button>
                  {tg.configured && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        action(
                          "telegram/disconnect",
                          {},
                          "Bot token and chat pairing removed from this workspace.",
                        )
                      }
                    >
                      Disconnect Bot
                    </Button>
                  )}
                </div>
              </fieldset>
              {!!status?.deliveries.length && (
                <section className="rounded-lg border p-4">
                  <p className="mb-3 text-xs font-medium">Recent Deliveries</p>
                  <div className="space-y-3">
                    {status.deliveries.map((item) => (
                      <div key={item.id} className="border-t pt-2 text-xs">
                        <div className="flex justify-between gap-3">
                          <span>
                            {item.kind} ·{" "}
                            {new Date(item.createdAt).toLocaleString()}
                          </span>
                          <span
                            className={
                              item.status === "sent"
                                ? "text-primary"
                                : "text-muted-foreground"
                            }
                          >
                            {item.status}
                          </span>
                        </div>
                        {item.error && (
                          <p className="quiet mt-1 text-[11px]">{item.error}</p>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              )}
              <p className="quiet text-[11px] leading-relaxed">
                Messages contain health summaries and token totals. Raw prompts,
                provider credentials and full account emails are excluded.
                Pairing reads updates from this dedicated bot; it does not
                replace another bot's webhook.
              </p>
            </>
          )}
          {status?.workerError && (
            <p className="text-xs text-amber-400">{status.workerError}</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
function Option({
  title,
  detail,
  checked,
  set,
}: {
  title: string;
  detail: string;
  checked: boolean;
  set: (value: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-4 py-4">
      <span>
        <span className="block text-xs font-medium">{title}</span>
        <span className="quiet mt-1 block text-[11px] leading-relaxed">
          {detail}
        </span>
      </span>
      <Switch checked={checked} onCheckedChange={set} aria-label={title} />
    </label>
  );
}
