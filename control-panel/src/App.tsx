import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import {
  BookOpen,
  Check,
  ChevronRight,
  Menu,
  RefreshCw,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, errorMessage, type Config, type Credential } from "@/lib/api";
import { ErrorNotice, Pending } from "@/components/shared";
import { Overview } from "@/pages/Overview";
import { Setup } from "@/pages/Setup";
import { Providers } from "@/pages/Providers";
import { UsagePage } from "@/pages/Usage";
import { Affinity } from "@/pages/Affinity";
import { Models } from "@/pages/Models";
import { Plugins } from "@/pages/Plugins";
import { Diagnostics } from "@/pages/Diagnostics";
import { Keys } from "@/pages/Keys";
import { Logs } from "@/pages/Logs";
import { Sidebar } from "@/components/Sidebar";
import { navigation, pageFromHash, type Page } from "@/lib/navigation";
export type { Page } from "@/lib/navigation";
import { ConnectDialog } from "@/components/ConnectDialog";
import {
  PersonalUseGuide,
  hasReadPersonalUseGuide,
  rememberPersonalUseGuide,
} from "@/components/PersonalUseGuide";

const Configuration = lazy(() =>
  import("@/pages/Configuration").then((module) => ({
    default: module.Configuration,
  })),
);

function currentPage(): Page {
  return pageFromHash(location.hash);
}

export default function App() {
  const [acknowledged, setAcknowledged] = useState(hasReadPersonalUseGuide);
  const [guideOpen, setGuideOpen] = useState(false);
  if (!acknowledged || guideOpen) {
    return (
      <PersonalUseGuide
        returning={acknowledged}
        onComplete={() => {
          if (!acknowledged) rememberPersonalUseGuide();
          setAcknowledged(true);
          setGuideOpen(false);
        }}
      />
    );
  }
  return <Workspace onOpenGuide={() => setGuideOpen(true)} />;
}

function Workspace({ onOpenGuide }: { onOpenGuide: () => void }) {
  const [page, setPage] = useState<Page>(currentPage);
  const [mobile, setMobile] = useState(false);
  const [config, setConfig] = useState<Config | null>(null);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [connected, setConnected] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [connectMode, setConnectMode] = useState<"oauth" | "api" | "file">(
    "oauth",
  );
  const openConnect = (mode: "oauth" | "api" | "file" = "oauth") => {
    setConnectMode(mode);
    setConnectOpen(true);
  };
  const [updated, setUpdated] = useState<Date | null>(null);
  const [toast, setToast] = useState("");
  const notify = useCallback((message: string) => setToast(message), []);
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const [nextConfig, nextCredentials] = await Promise.all([
        api<Config>("/config"),
        api<{ files: Credential[] }>("/credentials"),
        api("/health"),
      ]);
      setConfig(nextConfig);
      setCredentials(nextCredentials.files ?? []);
      setConnected(true);
      setError("");
      setUpdated(new Date());
    } catch (err) {
      setError(errorMessage(err));
      setConnected(false);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    document
      .getElementById("workspace-content")
      ?.focus({ preventScroll: true });
    document.title = `${navigation.find((n) => n.id === page)?.label ?? "Control Room"} · CRAP`;
  }, [page]);
  useEffect(() => {
    const handle = () => {
      const next = currentPage();
      if (location.hash === "#settings")
        history.replaceState(null, "", "#configuration");
      setPage(next);
      setMobile(false);
    };
    handle();
    window.addEventListener("hashchange", handle);
    return () => window.removeEventListener("hashchange", handle);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(""), 4000);
    return () => clearTimeout(id);
  }, [toast]);
  const navigate = (value: Page) => {
    location.hash = value;
    setPage(value);
    setMobile(false);
  };
  const onSaved = async (message: string) => {
    notify(message);
    await refresh();
  };
  return (
    <div className="min-h-screen">
      <Sidebar
        page={page}
        connected={connected}
        accountCount={credentials.length}
        mobile={mobile}
        onMobileChange={setMobile}
        navigate={navigate}
      />
      <div className="lg:pl-[232px]">
        <header className="sticky top-0 z-20 flex h-[65px] items-center justify-between border-b bg-background/95 px-5 backdrop-blur-md sm:px-9">
          <div className="flex items-center gap-3 text-xs">
            <Button
              size="icon"
              variant="ghost"
              className="lg:hidden"
              aria-label="Open navigation"
              onClick={() => setMobile(true)}
            >
              <Menu size={18} />
            </Button>
            <span className="quiet hidden sm:inline">
              {navigation.find((n) => n.id === page)?.group}
            </span>
            <ChevronRight className="quiet hidden sm:inline" size={13} />
            <span>{navigation.find((n) => n.id === page)?.label}</span>
          </div>
          <div className="flex items-center gap-2">
            <span
              title={
                updated
                  ? `Last successful connection check: ${updated.toLocaleTimeString()}`
                  : undefined
              }
              className="hidden items-center gap-2 text-[11px] text-muted-foreground sm:flex"
            >
              <span
                className={`size-1.5 rounded-full ${connected ? "bg-primary" : "bg-amber-400"}`}
              />
              {loading
                ? "Connecting…"
                : connected
                  ? "Proxy connected"
                  : "Proxy unavailable"}
            </span>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Refresh workspace"
              title="Refresh connection, accounts and configuration"
              onClick={() => void refresh()}
              disabled={refreshing}
            >
              <RefreshCw
                size={15}
                className={refreshing ? "animate-spin" : ""}
              />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Open setup guide"
              title="Setup guide"
              onClick={() => navigate("setup")}
            >
              <BookOpen size={16} />
            </Button>
          </div>
        </header>
        <main
          id="workspace-content"
          tabIndex={-1}
          className="mx-auto max-w-[1500px] px-5 py-8 outline-none sm:px-9 sm:py-9"
        >
          {error && (
            <div className="mb-6">
              <ErrorNotice message={error} />
            </div>
          )}
          {page === "setup" ? (
            <Setup
              connected={connected}
              accountCount={credentials.length}
              navigate={navigate}
            />
          ) : loading ? (
            <Pending>Connecting to your workspace…</Pending>
          ) : config ? (
            <div key={page} className="animate-enter">
              {page === "overview" && (
                <Overview
                  config={config}
                  credentials={credentials}
                  connected={connected}
                  onConnect={() => openConnect()}
                  navigate={navigate}
                />
              )}
              {page === "providers" && (
                <Providers
                  config={config}
                  credentials={credentials}
                  onConnect={openConnect}
                  onSaved={onSaved}
                />
              )}
              {page === "keys" && <Keys config={config} onSaved={onSaved} />}
              {page === "models" && <Models credentials={credentials} />}
              {page === "configuration" && (
                <Suspense
                  fallback={
                    <div className="surface p-6 text-sm text-muted-foreground">
                      Loading configuration…
                    </div>
                  }
                >
                  <Configuration onSaved={onSaved} />
                </Suspense>
              )}
              {page === "plugins" && (
                <Plugins credentials={credentials} onSaved={onSaved} />
              )}
              {page === "diagnostics" && (
                <Diagnostics credentials={credentials} />
              )}
              {page === "usage" && (
                <UsagePage
                  credentials={credentials}
                  onConnect={() => openConnect()}
                  onRefresh={refresh}
                  refreshing={refreshing}
                />
              )}
              {(page === "affinity" || page === "ledger") && (
                <Affinity
                  view={page === "ledger" ? "ledger" : "routing"}
                  onViewChange={(view) =>
                    navigate(view === "ledger" ? "ledger" : "affinity")
                  }
                />
              )}
              {page === "logs" && (
                <Logs
                  enabled={
                    config.observability.logs?.["logging-to-file"] ?? false
                  }
                />
              )}
            </div>
          ) : (
            <div className="surface p-8">
              <h1 className="text-xl font-semibold">Let’s get connected.</h1>
              <p className="quiet mt-3">
                Check that the proxy and control services are running, then try
                again. The setup guide explains how the services connect.
              </p>
              <Button className="mt-5" onClick={refresh}>
                Try again
              </Button>
              <Button
                variant="ghost"
                className="mt-5 ml-2"
                onClick={() => navigate("setup")}
              >
                Open setup guide
              </Button>
            </div>
          )}
          <footer className="mt-9 flex flex-wrap justify-between gap-3 border-t pt-5 text-[10px] tracking-wide text-muted-foreground">
            <span>
              CRAP <span className="mx-2 text-border">/</span> Control Room for
              Agentic Proxy
            </span>
            <button className="hover:text-foreground" onClick={onOpenGuide}>
              Personal Use Guide
            </button>
            <a
              className="hover:text-foreground"
              href="https://github.com/router-for-me/CLIProxyAPI"
              target="_blank"
              rel="noreferrer"
            >
              Powered by CLIProxyAPI ↗
            </a>
          </footer>
        </main>
      </div>
      {config && (
        <ConnectDialog
          open={connectOpen}
          initialMode={connectMode}
          onOpenChange={setConnectOpen}
          config={config}
          onSaved={onSaved}
        />
      )}
      {toast && (
        <div
          role="status"
          className="fixed bottom-6 right-6 z-50 flex max-w-[calc(100vw-3rem)] items-center gap-3 rounded-xl border border-primary/30 bg-card px-4 py-3 shadow-xl"
        >
          <Check size={16} className="text-primary" />
          <span className="text-sm">{toast}</span>
          <button
            aria-label="Dismiss notification"
            onClick={() => setToast("")}
          >
            <X size={14} className="quiet" />
          </button>
        </div>
      )}
    </div>
  );
}
