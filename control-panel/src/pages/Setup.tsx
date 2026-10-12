import { useEffect, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Bell,
  Boxes,
  Cable,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  Database,
  Globe2,
  Laptop,
  Network,
  Send,
  Server,
  ShieldCheck,
  Terminal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { DatabaseSetup } from "@/components/DatabaseSetup";
import {
  IntegrationsSetup,
  type IntegrationStatus,
} from "@/components/IntegrationsSetup";
import { LanAccessSetup } from "@/components/LanAccessSetup";
import { ClientEndpoints } from "@/components/ClientEndpoints";
import { PageHeading } from "@/components/shared";
import type { Page } from "@/lib/navigation";
import { api } from "@/lib/api";

const deployments = [
  {
    id: "local",
    label: "Local services",
    icon: Laptop,
    detail:
      "Run on the machine hosting CRAP, which may differ from the device running your browser.",
    hint: "Development setup",
    steps: [
      "Install the official proxy and CRAP plugin",
      "Connect the control room",
      "Keep configuration on this machine",
    ],
  },
  {
    id: "docker",
    label: "Docker Compose",
    icon: Boxes,
    detail: "Run the services together on a computer or home server.",
    hint: "One host",
    steps: [
      "Review the Compose configuration",
      "Choose persistent storage",
      "Start and check the services",
    ],
  },
  {
    id: "kubernetes",
    label: "Kubernetes",
    icon: Network,
    detail: "Use your cluster, existing database and deployment workflow.",
    hint: "Helm or manifests · single instance",
    steps: [
      "Choose your existing services",
      "Review deployment values",
      "Connect the deployed instance",
    ],
  },
  {
    id: "existing",
    label: "Existing proxy",
    icon: Cable,
    detail: "Bring a proxy that is already running. Connect it here.",
    hint: "Bring your own",
    steps: [
      "Enter the management endpoint",
      "Verify access and compatibility",
      "Discover connected accounts",
    ],
  },
] as const;
const steps = [
  { label: "Choose a home", detail: "Where everything runs", icon: Server },
  {
    label: "Configure storage",
    detail: "Database and workspace migration",
    icon: Database,
  },
  { label: "Connect proxy", detail: "The engine underneath", icon: Cable },
  {
    label: "Add your accounts",
    detail: "Subscriptions or API keys",
    icon: ShieldCheck,
  },
  {
    label: "Reach it anywhere",
    detail: "Private access with Tailscale",
    icon: Globe2,
  },
  { label: "Stay in the loop", detail: "Updates through Telegram", icon: Bell },
  {
    label: "Send a first request",
    detail: "Connect your favorite client",
    icon: Terminal,
  },
] as const;
export function Setup({
  connected,
  accountCount,
  navigate,
}: {
  connected: boolean;
  accountCount: number;
  navigate: (page: Page) => void;
}) {
  const [step, setStep] = useState(0);
  const [deployment, setDeployment] = useState<
    (typeof deployments)[number]["id"] | null
  >(null);
  const [runtime, setRuntime] = useState<"kubernetes" | "unknown" | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void api<{ deployment: "kubernetes" | "unknown" }>("/runtime", {
      signal: controller.signal,
    })
      .then(({ deployment: detected }) => {
        if (controller.signal.aborted) return;
        setRuntime(detected);
        if (detected === "kubernetes")
          setDeployment((selected) => selected ?? "kubernetes");
      })
      .catch(() => {
        if (!controller.signal.aborted) setRuntime("unknown");
      });
    return () => controller.abort();
  }, []);
  const [integration, setIntegration] = useState<
    "tailscale" | "telegram" | "database" | null
  >(null);
  const chosen = deployments.find((d) => d.id === deployment);
  const detected = Number(connected) + Number(accountCount > 0);
  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  const [statusError, setStatusError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function read() {
      if (!document.hidden) {
        try {
          const value = await api<IntegrationStatus>("/integrations", {
            signal: controller.signal,
          });
          if (active) {
            setStatus(value);
            setStatusError(false);
          }
        } catch {
          if (active) setStatusError(true);
        }
      }
      if (active) timer = setTimeout(read, 10000);
    }
    void read();
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [integration]);
  const tailStatus = statusError
    ? "Status unavailable"
    : !status
      ? "Checking…"
      : !status.tailscale.enabled
        ? "Not connected"
        : status.tailscale.phase === "online"
          ? "Connected"
          : "Needs attention";
  const telegramStatus = statusError
    ? "Status unavailable"
    : !status
      ? "Checking…"
      : !status.telegram.configured
        ? "Not connected"
        : !status.telegram.paired
          ? "Pair a chat"
          : status.telegram.enabled
            ? "Notifications on"
            : "Notifications paused";
  return (
    <>
      <PageHeading
        eyebrow="Your workspace, connected"
        title="Setup & Integrations"
        description="Connect your accounts, choose storage and reach your workspace from anywhere."
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-medium">Workspace integrations</h2>
          <p className="quiet mt-1 text-xs">
            Storage, private access and notifications
          </p>
        </div>
        <LanAccessSetup />
      </div>
      <div className="mb-8 grid gap-5 xl:grid-cols-3">
        <IntegrationCard
          kind="Workspace storage"
          title="Database"
          description="Keep your configuration, credentials and history ready for deployment."
          icon={Database}
          onClick={() => setIntegration("database")}
        >
          <Database size={14} className="text-primary" />
          <span>PostgreSQL</span>
          <span>/</span>
          <span>Both services</span>
        </IntegrationCard>
        <IntegrationCard
          kind="Private access"
          title="Tailscale"
          status={tailStatus}
          active={
            !statusError &&
            status?.tailscale.phase === "online" &&
            status?.tailscale.enabled
          }
          description="Open your control room from the couch, the office, or wherever you work."
          icon={Network}
          onClick={() => setIntegration("tailscale")}
        >
          <span>Your devices</span>
          <ArrowRight size={13} />
          <span className="rounded-md border border-primary/20 bg-primary/5 px-3 py-1.5 text-primary">
            Private network
          </span>
          <ArrowRight size={13} />
          <span>CRAP</span>
        </IntegrationCard>
        <IntegrationCard
          kind="Notifications"
          title="Telegram"
          status={telegramStatus}
          active={
            !statusError && status?.telegram.paired && status?.telegram.enabled
          }
          description="Get a heads-up when an account needs attention or your quota is running low."
          icon={Send}
          onClick={() => setIntegration("telegram")}
        >
          <Bell size={14} className="text-primary" />
          <span>Account alerts</span>
          <span className="text-border">/</span>
          <span>Quota updates</span>
          <span className="text-border">/</span>
          <span>Daily digest</span>
        </IntegrationCard>
      </div>

      <div className="surface mb-7 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-5 py-4">
          <h2 className="text-sm font-medium">Your Setup Guide</h2>
          <p className="quiet text-xs">
            Explore the steps · {detected} existing{" "}
            {detected === 1 ? "connection" : "connections"} detected
          </p>
        </div>
        <div className="grid lg:grid-cols-[225px_1fr]">
          <nav
            aria-label="Setup steps"
            className="grid gap-1 border-b bg-black/10 p-3 sm:grid-cols-2 lg:grid-cols-1 lg:border-r lg:border-b-0"
          >
            {steps.map(({ label, detail, icon: Icon }, index) => {
              const known =
                (index === 2 && connected) || (index === 3 && accountCount > 0);
              return (
                <button
                  key={label}
                  aria-current={step === index ? "step" : undefined}
                  onClick={() => setStep(index)}
                  className={`flex items-center gap-3 rounded-lg px-3 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${step === index ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-white/4"}`}
                >
                  <span
                    className={`flex size-7 shrink-0 items-center justify-center rounded-md border ${step === index ? "border-primary/25" : "border-transparent bg-white/4"}`}
                  >
                    {known ? <Check size={14} /> : <Icon size={14} />}
                  </span>
                  <span>
                    <span className="block text-xs font-medium">{label}</span>
                    <span className="mt-1 block text-[10px] text-muted-foreground">
                      {detail}
                    </span>
                  </span>
                </button>
              );
            })}
          </nav>
          <div className="flex min-w-0 flex-col p-5 sm:p-7">
            <div className="mb-5">
              <p className="eyebrow mb-2">
                Step {String(step + 1).padStart(2, "0")} /{" "}
                {String(steps.length).padStart(2, "0")}
              </p>
              <h3 className="text-xl font-medium tracking-tight">
                {step === 0 ? "Where should this live?" : steps[step].label}
              </h3>
              <p className="quiet mt-2 text-xs leading-relaxed">
                {step === 0
                  ? "Choose a deployment guide. Selecting an option does not move or reconfigure this workspace."
                  : steps[step].detail}
              </p>
            </div>
            {step === 0 ? (
              <>
                <p className="quiet mb-4 text-xs" role="status">
                  {runtime === "kubernetes"
                    ? "Current instance: Kubernetes. You can browse another guide without changing this deployment."
                    : runtime === null
                      ? "Checking where this instance runs…"
                      : "Runtime not detected. Select the guide that matches your host; a localhost browser address does not identify the deployment."}
                </p>
                <div
                  className="grid gap-3 sm:grid-cols-2"
                  role="group"
                  aria-label="Deployment options"
                >
                  {deployments.map(({ id, label, icon: Icon, hint }) => (
                    <button
                      key={id}
                      aria-pressed={deployment === id}
                      onClick={() => setDeployment(id)}
                      className={`flex items-start gap-3 rounded-lg border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${deployment === id ? "border-primary/50 bg-primary/5" : "hover:border-muted-foreground/40 hover:bg-white/2"}`}
                    >
                      <Icon
                        size={19}
                        className={
                          deployment === id
                            ? "text-primary"
                            : "text-muted-foreground"
                        }
                        strokeWidth={1.5}
                      />
                      <span className="flex-1">
                        <span className="block text-xs font-medium">
                          {label}
                        </span>
                        <span className="quiet mt-1.5 block text-[11px]">
                          {hint}
                        </span>
                      </span>
                      {deployment === id ? (
                        <CheckCircle2 size={15} className="text-primary" />
                      ) : (
                        <Circle
                          size={15}
                          className="text-muted-foreground/40"
                        />
                      )}
                    </button>
                  ))}
                </div>
                {chosen && (
                  <div className="mt-5 rounded-lg border border-dashed p-4">
                    <p className="text-xs">{chosen.detail}</p>
                    <div className="quiet mt-3 flex flex-wrap gap-x-5 gap-y-2 text-[11px]">
                      {chosen.steps.map((label, i) => (
                        <span key={label} className="flex items-center gap-2">
                          <span className="font-mono text-primary/70">
                            0{i + 1}
                          </span>
                          {label}
                        </span>
                      ))}
                    </div>
                    {deployment === "docker" && (
                      <p className="quiet mt-4 border-t pt-4 text-xs leading-relaxed">
                        Install the published CRAP images with the matching
                        release override. The official proxy and PostgreSQL are
                        installed separately by Compose. Existing accounts and
                        history require a migration.{" "}
                        <a
                          className="text-primary underline underline-offset-4"
                          href="https://github.com/darki73/crap/blob/main/doc/getting-started.md"
                          target="_blank"
                          rel="noreferrer"
                        >
                          Docker installation guide
                        </a>
                      </p>
                    )}
                    {deployment === "kubernetes" && (
                      <div className="quiet mt-4 space-y-3 border-t pt-4 text-xs leading-relaxed">
                        <p>
                          Deployment recipes are available for one owner and one
                          active proxy, using your existing PostgreSQL database.
                          Validate networking, storage and recovery in your
                          cluster. Multiple active replicas and zero-downtime
                          upgrades are not supported.
                        </p>
                        <a
                          className="inline-flex items-center gap-2 text-primary underline underline-offset-4"
                          href="https://github.com/darki73/crap/blob/main/k8s/README.md"
                          target="_blank"
                          rel="noreferrer"
                        >
                          Kubernetes deployment guide <ArrowUpRight size={13} />
                        </a>
                      </div>
                    )}
                  </div>
                )}
              </>
            ) : step === 1 ? (
              <StepDetail
                icon={Database}
                title="A lasting home for your workspace."
                description="Review storage for CRAP and your independently installed proxy. Preserve history, credentials and encryption keys together when migrating to another database."
              >
                <Button
                  variant="outline"
                  onClick={() => setIntegration("database")}
                >
                  Configure Database <ArrowRight size={14} />
                </Button>
              </StepDetail>
            ) : step === 2 ? (
              <StepDetail
                icon={Cable}
                title={
                  connected
                    ? "Your proxy is already connected."
                    : "Connect the engine to your control room."
                }
                description={
                  connected
                    ? "The workspace can reach your independently installed CLIProxyAPI. Keep its required CRAP plugin enabled; manage server options in Proxy Configuration."
                    : "Install the official plugin-enabled CLIProxyAPI distribution, add the CRAP plugin, and configure the private management connection on the panel server."
                }
              >
                <Button
                  variant="outline"
                  onClick={() => navigate("configuration")}
                >
                  Open Proxy Configuration <ArrowUpRight size={14} />
                </Button>
                <div className="max-w-2xl space-y-3 border-t pt-4">
                  <p className="quiet text-sm leading-relaxed">
                    CLIProxyAPI is maintained and updated separately. CRAP does
                    not bundle or publish its engine.
                  </p>
                  <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs">
                    <a
                      className="inline-flex items-center gap-1.5 text-primary underline underline-offset-4"
                      href="https://github.com/router-for-me/CLIProxyAPI/releases"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Official releases <ArrowUpRight size={13} />
                    </a>
                    <a
                      className="inline-flex items-center gap-1.5 text-primary underline underline-offset-4"
                      href="https://github.com/darki73/crap/blob/main/doc/connecting-cliproxy.md"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Connection guide <ArrowUpRight size={13} />
                    </a>
                  </div>
                </div>
              </StepDetail>
            ) : step === 3 ? (
              <StepDetail
                icon={ShieldCheck}
                title={
                  accountCount
                    ? `${accountCount} accounts already available.`
                    : "Bring your first account."
                }
                description="Connect an existing subscription through OAuth, or configure an API provider. Account details stay masked throughout the dashboard."
              >
                <Button variant="outline" onClick={() => navigate("providers")}>
                  Manage Accounts <ArrowUpRight size={14} />
                </Button>
              </StepDetail>
            ) : step === 4 ? (
              <StepDetail
                icon={Network}
                title="A private route back home."
                description="Connect Tailscale for private access to your dashboard and proxy. Choose which devices and users can connect."
              >
                <Button
                  variant="outline"
                  onClick={() => setIntegration("tailscale")}
                >
                  Configure Tailscale <ArrowRight size={14} />
                </Button>
              </StepDetail>
            ) : step === 5 ? (
              <StepDetail
                icon={Send}
                title="Let the important updates find you."
                description="Choose which events belong in Telegram. Account attention, low quota and service health can all lead back to the relevant dashboard page."
              >
                <Button
                  variant="outline"
                  onClick={() => setIntegration("telegram")}
                >
                  Configure Telegram <ArrowRight size={14} />
                </Button>
              </StepDetail>
            ) : (
              <StepDetail
                icon={Terminal}
                title="One endpoint. Your choice of client."
                description="Use the current connection address and a client API key to connect your app."
              >
                <ClientEndpoints />
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" onClick={() => navigate("keys")}>
                    Client API Keys <ArrowUpRight size={14} />
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => navigate("diagnostics")}
                  >
                    Open Diagnostics
                  </Button>
                </div>
              </StepDetail>
            )}
            <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t pt-4">
              <p className="quiet max-w-sm text-[11px]">
                Integration controls configure this workspace. Deployment guides
                explain installation; selecting one does not apply changes.
              </p>
              <Button
                size="sm"
                onClick={() =>
                  setStep(step === steps.length - 1 ? 0 : step + 1)
                }
              >
                {step === steps.length - 1 ? "Back to start" : "Next step"}
                <ChevronRight size={14} />
              </Button>
            </div>
          </div>
        </div>
      </div>

      {integration === "database" && (
        <DatabaseSetup onClose={() => setIntegration(null)} />
      )}
      {integration === "tailscale" && (
        <IntegrationsSetup
          kind="tailscale"
          onClose={() => setIntegration(null)}
        />
      )}
      {integration === "telegram" && (
        <IntegrationsSetup
          kind="telegram"
          onClose={() => setIntegration(null)}
        />
      )}
    </>
  );
}

function StepDetail({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: typeof Cable;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col items-start justify-center py-5">
      <div className="mb-5 flex size-12 items-center justify-center rounded-xl border bg-primary/5 text-primary">
        <Icon size={24} strokeWidth={1.5} />
      </div>
      <h4 className="text-lg font-medium">{title}</h4>
      <p className="quiet mt-2 max-w-xl text-sm leading-relaxed">
        {description}
      </p>
      <div className="mt-5 w-full min-w-0 max-w-2xl space-y-5">{children}</div>
    </div>
  );
}
function IntegrationCard({
  status,
  active,
  kind,
  title,
  description,
  icon: Icon,
  onClick,
  children,
}: {
  status?: string;
  active?: boolean;
  kind: string;
  title: string;
  description: string;
  icon: typeof Network;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="surface flex flex-col p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl border bg-muted/30">
            <Icon size={20} strokeWidth={1.5} />
          </div>
          <div>
            <p className="quiet text-[10px]">{kind}</p>
            <h3 className="mt-0.5 font-medium">{title}</h3>
          </div>
        </div>
        {status && (
          <span
            className={`shrink-0 rounded-full border px-2 py-1 text-[10px] ${active ? "border-primary/20 bg-primary/5 text-primary" : "text-muted-foreground"}`}
          >
            {status}
          </span>
        )}
      </div>
      <p className="quiet mt-4 text-xs leading-relaxed">{description}</p>
      <div className="my-5 flex min-h-10 flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
        {children}
      </div>
      <button
        onClick={onClick}
        className="mt-auto flex items-center justify-between border-t pt-4 text-xs font-medium text-primary hover:text-primary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        Manage {title}
        <ArrowRight size={15} />
      </button>
    </section>
  );
}
