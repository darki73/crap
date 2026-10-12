import { useEffect, useState } from "react";
import { CheckCircle2, Database, Loader2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api, errorMessage, write } from "@/lib/api";
import { DatabaseTransfer } from "./DatabaseTransfer";

type Status = {
  phase: string;
  running?: boolean;
  available?: boolean;
  error?: string;
  recovery?: string;
  accounts?: number;
  history?: number;
  backup?: string;
};
type Check = {
  database: string;
  endpoint: string;
  schema: string;
  accounts: number;
  history: number;
  crap: string;
  proxy: string;
  canApply: boolean;
  conflict: boolean;
  tls: string;
};
const phases: Record<string, string> = {
  checking: "Checking both services",
  "backing-up": "Stopping CLIProxy and backing up credentials",
  importing: "Importing with CLIProxy's PostgreSQL store",
  restarting: "Restarting and verifying account registrations",
  active: "Both services configured",
  failed: "Setup did not complete",
  attention: "Recovery needs attention",
};

export function DatabaseSetup({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState("setup");
  const [status, setStatus] = useState<Status>({ phase: "loading" });
  const [check, setCheck] = useState<Check | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const value = await api<Status>("/database");
        if (!stopped) {
          setStatus(value);
          if (value.running) timer = setTimeout(refresh, 1000);
        }
      } catch (reason) {
        if (!stopped) {
          setError(errorMessage(reason));
          setStatus({ phase: "unavailable" });
        }
      }
    };
    void refresh();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [busy]);
  async function inspect() {
    setBusy(true);
    setError("");
    setConfirmed(false);
    try {
      setCheck(await write<Check>("/database/check", "POST", {}));
    } catch (reason) {
      setCheck(null);
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }
  async function apply() {
    setBusy(true);
    setError("");
    try {
      setStatus(
        await write<Status>("/database/apply", "POST", {
          confirm: "migrate-local-proxy",
        }),
      );
      setCheck(null);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }
  const running = Boolean(status.running);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto p-0 sm:max-w-3xl">
        <DialogHeader className="border-b px-6 pt-6 pb-5 text-left">
          <div className="mb-3 flex items-center gap-2 text-xs text-primary">
            <Database size={16} /> POSTGRESQL{" "}
            <span className="ml-2 rounded-full border px-2 py-0.5 text-[10px] text-muted-foreground">
              Storage & Migration
            </span>
          </div>
          <DialogTitle className="text-2xl font-medium tracking-tight">
            One database. Both services.
          </DialogTitle>
          <DialogDescription className="text-xs leading-relaxed">
            Configure storage for both services or move your workspace to
            another PostgreSQL server.
          </DialogDescription>
        </DialogHeader>
        <div
          className="flex gap-2 px-6"
          role="tablist"
          aria-label="Database workflow"
        >
          <Button
            role="tab"
            aria-selected={tab === "setup"}
            variant={tab === "setup" ? "default" : "outline"}
            size="sm"
            onClick={() => setTab("setup")}
          >
            Current Database
          </Button>
          <Button
            role="tab"
            aria-selected={tab === "transfer"}
            variant={tab === "transfer" ? "default" : "outline"}
            size="sm"
            disabled={running}
            onClick={() => setTab("transfer")}
          >
            Move Workspace
          </Button>
        </div>
        {tab === "transfer" ? (
          <div className="px-6 pb-6">
            <DatabaseTransfer />
          </div>
        ) : (
          <>
            <div className="space-y-5 px-6">
              <div className="grid gap-4 sm:grid-cols-2">
                <section className="rounded-lg border bg-primary/5 p-4">
                  <h3 className="text-sm font-medium">CRAP</h3>
                  <p className="quiet mt-2 text-xs leading-relaxed">
                    Keeps its existing database connection, token ledger,
                    routing policy and identity keys.
                  </p>
                  <p className="mt-3 text-xs text-primary">
                    Schema: affinity_router
                  </p>
                </section>
                <section className="rounded-lg border p-4">
                  <h3 className="text-sm font-medium">CLIProxy</h3>
                  <p className="quiet mt-2 text-xs leading-relaxed">
                    Moves configuration and OAuth credentials into its supported
                    PostgreSQL store. Local working files remain part of
                    CLIProxy's runtime.
                  </p>
                  <p className="mt-3 text-xs text-primary">Schema: cliproxy</p>
                </section>
              </div>
              <div className="rounded-lg border p-4">
                <p className="text-xs font-medium">Existing Local PostgreSQL</p>
                <p className="quiet mt-2 text-xs leading-relaxed">
                  127.0.0.1:55432 · Credentials come from the backend's existing
                  configuration and are never returned to this page. The proxy
                  uses Docker's host address to reach the same database.
                </p>
                <p className="quiet mt-2 text-[11px]">
                  This local adapter uses the existing database role and non-TLS
                  development connection. Move Workspace supports transfers to
                  PostgreSQL or CNPG; deployment addresses and runtime roles are
                  reviewed separately before activation.
                </p>
              </div>
              {error && (
                <p
                  role="alert"
                  className="rounded-lg border border-destructive/30 p-3 text-xs text-destructive"
                >
                  {error}
                </p>
              )}
              {status.phase !== "idle" &&
                status.phase !== "loading" &&
                status.phase !== "unavailable" && (
                  <div
                    role="status"
                    className="rounded-lg border border-primary/20 bg-primary/5 p-4"
                  >
                    <p className="flex items-center gap-2 text-sm font-medium">
                      {running ? (
                        <Loader2 size={17} className="animate-spin" />
                      ) : status.phase === "active" ? (
                        <CheckCircle2 size={17} className="text-primary" />
                      ) : (
                        <ShieldCheck size={17} />
                      )}
                      {phases[status.phase] || status.phase}
                    </p>
                    {status.error && (
                      <p className="mt-2 text-xs text-destructive">
                        {status.error}
                      </p>
                    )}
                    {status.recovery && (
                      <p className="quiet mt-2 text-xs leading-relaxed">
                        {status.recovery}
                      </p>
                    )}
                    {status.phase === "active" && (
                      <p className="quiet mt-2 text-xs">
                        {status.accounts} account registrations verified. CRAP
                        history preserved. No provider inference request was
                        sent.
                      </p>
                    )}
                    {status.backup && (
                      <p className="quiet mt-2 break-all text-[11px]">
                        Protected local backup: .local-panel/database/
                        {status.backup}
                      </p>
                    )}
                  </div>
                )}
              {check && (
                <div className="rounded-lg border p-4">
                  <p className="mb-3 text-xs font-medium">Connection Check</p>
                  <dl className="grid gap-3 text-xs sm:grid-cols-2">
                    {[
                      ["Database", check.database],
                      ["CRAP", check.crap],
                      ["CLIProxy storage", check.proxy],
                      ["Account registrations", check.accounts],
                      ["Usage records", check.history],
                    ].map(([label, value]) => (
                      <div key={label}>
                        <dt className="quiet text-[11px]">{label}</dt>
                        <dd className="mt-1">{value}</dd>
                      </div>
                    ))}
                  </dl>
                  {check.conflict && (
                    <p className="mt-3 text-xs text-destructive">
                      The destination schema is occupied. Existing data will not
                      be overwritten. Inspect the previous migration before
                      retrying.
                    </p>
                  )}
                </div>
              )}
              {check?.canApply && !running && status.phase !== "attention" && (
                <div className="rounded-lg border p-4">
                  <h3 className="text-sm font-medium">
                    Migrate This Workspace
                  </h3>
                  <ol className="quiet mt-3 list-decimal space-y-2 pl-4 text-xs leading-relaxed">
                    <li>
                      Stop the managed local proxy so it cannot refresh tokens
                      during the copy.
                    </li>
                    <li>
                      Keep a protected backup of its configuration and
                      credentials.
                    </li>
                    <li>
                      Import into an empty CLIProxy schema and save its
                      PostgreSQL startup settings.
                    </li>
                    <li>
                      Restart CLIProxy and verify the accounts and CRAP history.
                    </li>
                  </ol>
                  <label className="mt-4 flex items-start gap-3 text-xs leading-relaxed">
                    <input
                      type="checkbox"
                      className="mt-0.5 accent-primary"
                      checked={confirmed}
                      onChange={(event) => setConfirmed(event.target.checked)}
                    />
                    I understand proxy requests will be briefly unavailable
                    during the migration.
                  </label>
                </div>
              )}
              <p className="quiet text-[11px] leading-relaxed">
                The existing file-backed proxy is restored automatically if
                import fails before the PostgreSQL instance starts. After
                startup, recovery requires inspection to avoid restoring stale
                OAuth tokens.
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t bg-muted/10 px-6 py-4">
              <Button size="sm" variant="ghost" onClick={onClose}>
                {running ? "Close (Setup Continues)" : "Close"}
              </Button>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || running || status.phase === "unavailable"}
                  onClick={inspect}
                >
                  Check Both Connections
                </Button>
                {check?.canApply && status.phase !== "attention" && (
                  <Button
                    size="sm"
                    disabled={!confirmed || busy || running}
                    onClick={apply}
                  >
                    Configure Both Services
                  </Button>
                )}
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
