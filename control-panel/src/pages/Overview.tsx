import { useEffect, useState } from "react";
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  Cable,
  Check,
  Circle,
  KeyRound,
  Layers3,
  Plus,
  Radio,
  Terminal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { AccountCard } from "@/components/AccountCard";
import { RoutingStatus } from "@/components/RoutingStatus";
import {
  api,
  errorMessage,
  type Config,
  type Credential,
  type Usage,
} from "@/lib/api";
import {
  CopyButton,
  ErrorNotice,
  PageHeading,
  SectionTitle,
} from "@/components/shared";
import type { Page } from "@/App";
import { useClientEndpoint } from "@/lib/client-endpoint";

export function Overview({
  config,
  credentials,
  connected,
  onConnect,
  navigate,
}: {
  config: Config;
  credentials: Credential[];
  connected: boolean;
  onConnect: () => void;
  navigate: (page: Page) => void;
}) {
  const endpoint = useClientEndpoint();
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    api<Usage>("/observability/usage/api-keys")
      .then((data) => {
        if (active) setUsage(data);
      })
      .catch((err) => {
        if (active) setError(errorMessage(err));
      });
    return () => {
      active = false;
    };
  }, [config]);
  const entries = Object.values(usage ?? {}).flatMap(Object.values);
  const total = entries.reduce(
    (sum, entry) => sum + entry.success + entry.failed,
    0,
  );
  const active = credentials.filter((item) => !item.disabled).length;
  const keys = config.access["api-keys"]?.length ?? 0;
  const groups = Object.values(config["api-keys"]).filter(Array.isArray).flat();
  const hasProviders = credentials.length > 0 || groups.length > 0;
  const metrics = [
    {
      label: "PROXY STATUS",
      value: connected ? "Online" : "Offline",
      detail: connected
        ? "Ready to accept connections"
        : "Refresh to reconnect",
      icon: Radio,
      green: connected,
    },
    {
      label: "ENABLED CREDENTIALS",
      value: String(active).padStart(2, "0"),
      detail: hasProviders
        ? `${credentials.length} credentials in your workspace`
        : "Connect your first provider",
      icon: Cable,
    },
    {
      label: "CLIENT API KEYS",
      value: String(keys).padStart(2, "0"),
      detail: "Keys for your apps and tools",
      icon: KeyRound,
    },
    {
      label: "API-KEY REQUESTS",
      value: usage ? total.toLocaleString() : "—",
      detail: "Upstream API-key traffic this session",
      icon: Activity,
    },
  ];
  return (
    <>
      <PageHeading
        eyebrow="Your infrastructure, at a glance"
        title="Overview"
        description="A little clarity for everything flowing through your proxy."
        action={
          <Button onClick={onConnect}>
            <Plus size={16} />
            Connect provider
          </Button>
        }
      />
      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {metrics.map(({ label, value, detail, icon: Icon, green }) => (
          <div className="surface px-5 py-5" key={label}>
            <div className="flex justify-between">
              <p className="eyebrow">{label}</p>
              <Icon size={15} className="text-muted-foreground" />
            </div>
            <div
              className={`mt-4 flex items-center gap-2 text-[28px] font-medium tracking-tight ${green ? "text-primary" : ""}`}
            >
              {green && <span className="size-2 rounded-full bg-primary" />}
              {value}
            </div>
            <p className="quiet mt-2 text-[11px]">{detail}</p>
          </div>
        ))}
      </div>
      {error && (
        <div className="mb-5">
          <ErrorNotice message={error} />
        </div>
      )}
      {connected && !hasProviders && (
        <div className="surface relative mb-6 overflow-hidden bg-[#1b2018]">
          <div className="absolute -right-10 -top-16 size-64 rounded-full bg-primary/5 blur-3xl" />
          <div className="relative flex flex-col gap-6 p-6 sm:flex-row sm:items-center sm:p-8">
            <div className="flex size-14 shrink-0 items-center justify-center rounded-2xl border border-primary/20 bg-primary/5 text-primary">
              <Layers3 size={27} strokeWidth={1.4} />
            </div>
            <div className="max-w-lg flex-1">
              <p className="mb-2 text-[10px] font-semibold tracking-[.15em] text-primary">
                ALL SET. JUST ADD INTELLIGENCE.
              </p>
              <h2 className="text-xl font-medium tracking-tight">
                Your gateway is ready.
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-[#a5ada0]">
                The proxy is running. Connect an AI provider when you’re ready,
                and give all your tools one place to call home.
              </p>
            </div>
            <Button
              onClick={onConnect}
              variant="outline"
              className="self-start border-primary/25 bg-transparent text-primary sm:ml-auto sm:self-center"
            >
              Add a provider
              <ArrowUpRight size={15} />
            </Button>
          </div>
        </div>
      )}
      <div className="grid gap-6 xl:grid-cols-[1.55fr_1fr]">
        <section className="surface overflow-hidden">
          <SectionTitle
            title="Connection flow"
            detail="One endpoint. Your choice of providers."
            action={
              <span className="rounded border px-2 py-1 font-mono text-[9px] text-muted-foreground">
                LIVE CONFIG
              </span>
            }
          />
          <div className="grid-paper px-5 pb-7 pt-10">
            <div className="flex items-center justify-center">
              <FlowNode
                icon={Terminal}
                title="Your tools"
                subtitle="Apps & coding clients"
              />
              <div className="h-px flex-1 bg-gradient-to-r from-border to-primary/40" />
              <FlowNode
                icon={Layers3}
                title="CRAP"
                subtitle={endpoint.label}
                primary
              />
              <div
                className={`h-px flex-1 ${hasProviders ? "bg-primary/40" : "border-t border-dashed border-[#474a40]"}`}
              />
              <FlowNode
                icon={Cable}
                title={hasProviders ? "Providers" : "No provider"}
                subtitle={
                  hasProviders
                    ? `${active} active credentials`
                    : "Waiting to connect"
                }
              />
            </div>
            <RoutingStatus
              fallback={config.routing.strategy ?? "round-robin"}
              connected={connected}
              onOpen={() => navigate("affinity")}
            />
          </div>
          <div className="space-y-2 border-t px-5 py-3 text-xs">
            <span className="quiet">
              Client API endpoint · {endpoint.label}
            </span>
            {endpoint.openAI && (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <code className="break-all text-[11px]">{endpoint.openAI}</code>
                <CopyButton value={endpoint.openAI} label="Copy URL" />
              </div>
            )}
            <p className="quiet text-[11px]">{endpoint.detail}</p>
          </div>
        </section>
        <section className="surface">
          <SectionTitle
            title="Getting started"
            detail={`${Number(connected) + Number(keys > 0) + Number(hasProviders)} of 3 steps complete`}
          />
          <div className="p-5">
            {[
              {
                title: "Start your proxy",
                text: connected
                  ? "Your proxy is connected and responding."
                  : "Check the proxy connection in setup.",
                done: connected,
                action: () => navigate("configuration"),
              },
              {
                title: "Create a client key",
                text: "Authenticate your apps to the proxy.",
                done: keys > 0,
                action: () => navigate("keys"),
              },
              {
                title: "Connect a provider",
                text: "Sign in to an account or add an API key.",
                done: hasProviders,
                action: onConnect,
              },
            ].map((step, i) => (
              <button
                key={step.title}
                onClick={step.action}
                className="group flex w-full items-start gap-3 py-3 text-left"
              >
                <span
                  className={`flex size-6 shrink-0 items-center justify-center rounded-full border text-xs ${step.done ? "border-primary/20 bg-primary/10 text-primary" : "border-[#4c5045] text-muted-foreground"}`}
                >
                  {step.done ? <Check size={12} /> : i + 1}
                </span>
                <span className="flex-1">
                  <span
                    className={`block text-xs font-medium ${step.done ? "text-[#b9bdb8]" : ""}`}
                  >
                    {step.title}
                  </span>
                  <span className="quiet mt-1 block text-[11px]">
                    {step.text}
                  </span>
                </span>
                <ArrowRight
                  size={13}
                  className="mt-1 text-muted-foreground transition-transform group-hover:translate-x-1"
                />
              </button>
            ))}
          </div>
        </section>
      </div>
      <section className="surface mt-6">
        <SectionTitle
          title="Account usage"
          detail="Latest usage windows reported by your providers."
          action={
            <Button
              variant="ghost"
              size="sm"
              className="text-xs"
              onClick={() => navigate("usage")}
            >
              View usage
              <ArrowRight size={13} />
            </Button>
          }
        />
        {credentials.length ? (
          <div className="divide-y">
            {credentials.slice(0, 4).map((item) => (
              <AccountCard key={item.id || item.name} credential={item} />
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
            <Circle
              size={20}
              strokeWidth={1.3}
              className="mb-1 text-[#636b5a]"
            />
            <p className="text-sm">A quiet workspace, for now.</p>
            <p className="quiet text-xs">
              There’s no provider traffic to show yet.
            </p>
          </div>
        )}
      </section>
    </>
  );
}
function FlowNode({
  icon: Icon,
  title,
  subtitle,
  primary,
}: {
  icon: typeof Terminal;
  title: string;
  subtitle: string;
  primary?: boolean;
}) {
  return (
    <div className="flex w-[112px] flex-col items-center text-center">
      <div
        className={`mb-3 flex size-12 items-center justify-center rounded-xl border ${primary ? "border-primary/40 bg-primary/10 text-primary shadow-[0_0_30px_#c3f2790a]" : "bg-card text-muted-foreground"}`}
      >
        <Icon size={22} strokeWidth={1.5} />
      </div>
      <span className="text-xs font-medium">{title}</span>
      <span className="quiet mt-1 max-w-full break-all text-[9px]">
        {subtitle}
      </span>
    </div>
  );
}
