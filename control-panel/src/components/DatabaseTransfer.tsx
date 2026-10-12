import { useEffect, useState } from "react";
import {
  ArrowRight,
  Download,
  Loader2,
  LockKeyhole,
  MoveRight,
  PackageCheck,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, apiResponse, errorMessage, write } from "@/lib/api";

type Transfer = {
  phase: string;
  running?: boolean;
  sourcePaused?: boolean;
  backupReady?: boolean;
  error?: string;
  verified?: boolean;
  tables?: number;
  artifactDirectory?: string;
  mode?: string;
};
const labels: Record<string, string> = {
  checking: "Checking destination",
  pausing: "Pausing the source",
  copying: "Copying both database schemas",
  unlocking: "Unlocking the backup",
  restoring: "Restoring and verifying",
  complete: "Transfer complete",
  attention: "Transfer needs attention",
  failed: "Transfer did not complete",
};

export function DatabaseTransfer() {
  const [action, setAction] = useState("direct");
  const [mode, setMode] = useState("rehearsal");
  const [target, setTarget] = useState({
    host: "",
    port: "5432",
    database: "crap",
    user: "crap",
    password: "",
    sslmode: "verify-full",
    ca: "",
  });
  const [passphrase, setPassphrase] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [resumeConfirmed, setResumeConfirmed] = useState(false);
  const [state, setState] = useState<Transfer>({ phase: "idle" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const value = await api<Transfer>("/database/transfer");
        if (!stopped) {
          setState(value);
          if (value.running) timer = setTimeout(refresh, 1500);
        }
      } catch (e) {
        if (!stopped) setError(errorMessage(e));
      }
    }
    void refresh();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [busy]);
  async function start() {
    setBusy(true);
    setError("");
    try {
      let upload;
      if (action === "restore") {
        if (!file) throw new Error("Select an encrypted workspace backup.");
        const response = await apiResponse("/database/transfer/upload", {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: file,
        });
        upload = (await response.json()).upload;
      }
      setState(
        await write<Transfer>("/database/transfer/start", "POST", {
          action,
          mode,
          target,
          passphrase,
          upload,
          confirm: "transfer-workspace",
        }),
      );
      setPassphrase("");
      setTarget((t) => ({ ...t, password: "" }));
      setConfirmed(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function download() {
    setBusy(true);
    try {
      const response = await apiResponse("/database/transfer/download");
      const url = URL.createObjectURL(await response.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = "workspace.crapdb";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function resume() {
    setBusy(true);
    try {
      setState(
        await write<Transfer>("/database/transfer/resume", "POST", {
          confirm: "destination-is-stopped",
        }),
      );
      setResumeConfirmed(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const disabled = busy || state.running;
  return (
    <div className="space-y-5">
      <div className="rounded-lg border bg-primary/5 p-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <MoveRight size={17} className="text-primary" />
          Take Your Workspace With You
        </div>
        <p className="quiet mt-2 text-xs leading-relaxed">
          Move the token ledger, routing policy, price catalog, account labels,
          proxy configuration and OAuth credentials together. Your identity keys
          travel in an encrypted backup.
        </p>
        <div className="mt-4 flex items-center gap-3 text-xs">
          <span className="rounded border bg-background px-3 py-2">
            Local PostgreSQL
          </span>
          <ArrowRight size={16} />
          <span className="rounded border bg-background px-3 py-2">
            PostgreSQL / CNPG
          </span>
        </div>
      </div>
      <fieldset disabled={disabled} className="space-y-5 disabled:opacity-60">
        <div className="grid gap-2 sm:grid-cols-3">
          {[
            ["direct", "Direct Transfer", "Copy to a reachable database"],
            ["export", "Export Backup", "Carry an encrypted file"],
            ["restore", "Restore Backup", "Import into an empty database"],
          ].map(([id, title, description]) => (
            <button
              key={id}
              type="button"
              aria-pressed={action === id}
              className={`rounded-lg border p-3 text-left ${action === id ? "border-primary bg-primary/5" : "hover:bg-muted/30"}`}
              onClick={() => {
                setAction(id);
                setConfirmed(false);
              }}
            >
              <p className="text-xs font-medium">{title}</p>
              <p className="quiet mt-1 text-[11px]">{description}</p>
            </button>
          ))}
        </div>
        {action !== "restore" && (
          <div>
            <p className="mb-2 text-xs font-medium">Purpose</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {[
                [
                  "rehearsal",
                  "Rehearse the Move",
                  "Resume the source after copying. This copy must not serve traffic.",
                ],
                [
                  "cutover",
                  "Prepare Final Cutover",
                  "Leave the source paused. Activate the destination separately after verification.",
                ],
              ].map(([id, title, description]) => (
                <label
                  key={id}
                  className="flex items-start gap-3 rounded-lg border p-3 text-xs"
                >
                  <input
                    type="radio"
                    name="migration-mode"
                    className="mt-0.5 accent-primary"
                    checked={mode === id}
                    onChange={() => {
                      setMode(id);
                      setConfirmed(false);
                    }}
                  />
                  <span>
                    {title}
                    <span className="quiet mt-1 block text-[11px] leading-relaxed">
                      {description}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        )}
        {action !== "export" && (
          <section className="space-y-3 rounded-lg border p-4">
            <p className="text-xs font-medium">Destination Connection</p>
            <p className="quiet text-[11px] leading-relaxed">
              Use a fresh PostgreSQL 17 database. For CNPG, use a reachable
              address or a local port-forward, or restore from inside the
              cluster with the CLI. Existing workspace schemas are never
              overwritten.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              {(
                [
                  ["host", "Host"],
                  ["port", "Port"],
                  ["database", "Database"],
                  ["user", "Database User"],
                  ["password", "Database Password"],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="space-y-1 text-xs">
                  <span>{label}</span>
                  <Input
                    value={target[key]}
                    type={key === "password" ? "password" : "text"}
                    autoComplete="off"
                    onChange={(e) =>
                      setTarget({ ...target, [key]: e.target.value })
                    }
                  />
                </label>
              ))}
              <label className="space-y-1 text-xs">
                <span>TLS</span>
                <select
                  className="h-9 w-full rounded-md border bg-background px-2"
                  value={target.sslmode}
                  onChange={(e) =>
                    setTarget({ ...target, sslmode: e.target.value })
                  }
                >
                  <option value="verify-full">Verify Server & CA</option>
                  <option value="require">Encryption Only</option>
                  <option value="disable">Local / Port-forward (No TLS)</option>
                </select>
              </label>
            </div>
            {target.sslmode === "verify-full" && (
              <label className="block space-y-1 text-xs">
                <span>CA Certificate (PEM)</span>
                <textarea
                  className="min-h-20 w-full rounded-md border bg-background p-2 font-mono text-xs"
                  value={target.ca}
                  onChange={(e) => setTarget({ ...target, ca: e.target.value })}
                />
              </label>
            )}
            {target.sslmode === "require" && (
              <p className="text-xs text-amber-400">
                Encryption Only does not verify the server identity. Prefer a
                verified CA for deployment.
              </p>
            )}
          </section>
        )}
        {action === "restore" && (
          <label className="block space-y-2 text-xs">
            <span className="flex items-center gap-2">
              <Upload size={15} />
              Encrypted Workspace Backup
            </span>
            <Input
              type="file"
              accept=".crapdb"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
            />
            <span className="quiet block text-[11px]">
              Up to 2 GiB through the browser. Larger archives can use the
              restore CLI.
            </span>
          </label>
        )}
        <label className="block space-y-2 text-xs">
          <span className="flex items-center gap-2">
            <LockKeyhole size={15} />
            Backup Passphrase
          </span>
          <Input
            type="password"
            autoComplete="new-password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder="At least 16 characters"
          />
          <span className="quiet block text-[11px]">
            {action === "restore"
              ? "Use the passphrase set during export."
              : "Keep this separately from the backup. It cannot be recovered. Direct transfers also create an encrypted backup."}{" "}
            Secrets are not saved in browser storage.
          </span>
        </label>
        <label className="flex items-start gap-3 rounded-lg border p-3 text-xs leading-relaxed">
          <input
            type="checkbox"
            className="mt-0.5 accent-primary"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          <span>
            {action === "restore"
              ? "I trust this backup and will keep destination services stopped until the source is stopped and deployment settings are reviewed."
              : `I have stopped sending requests. Both services will briefly pause. ${mode === "cutover" ? "The source will stay paused until I finish the handoff or explicitly resume it." : "This is a rehearsal; the destination will remain inactive."}`}
          </span>
        </label>
        <Button
          size="sm"
          onClick={start}
          disabled={
            !confirmed ||
            passphrase.length < 16 ||
            disabled ||
            (state.sourcePaused && action !== "restore") ||
            state.phase === "attention"
          }
        >
          {disabled ? (
            <Loader2 size={15} className="animate-spin" />
          ) : (
            <MoveRight size={15} />
          )}{" "}
          {action === "direct"
            ? "Transfer Workspace"
            : action === "export"
              ? "Create Encrypted Backup"
              : "Restore Workspace"}
        </Button>
      </fieldset>
      {(error || state.error) && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 p-3 text-xs text-destructive"
        >
          {error || state.error}
        </p>
      )}
      {state.phase !== "idle" && (
        <section
          role="status"
          className="space-y-3 rounded-lg border border-primary/25 bg-primary/5 p-4"
        >
          <p className="flex items-center gap-2 text-sm font-medium">
            {state.running ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <PackageCheck size={16} />
            )}{" "}
            {labels[state.phase] || state.phase}
          </p>
          {state.verified && (
            <p className="text-xs">
              Both schemas restored; {state.tables} table row counts verified.
              Destination services have not been started.
            </p>
          )}
          {state.sourcePaused && (
            <p className="text-xs text-amber-400">
              Source paused. Keep it stopped when activating the destination to
              prevent competing OAuth refreshes.
            </p>
          )}
          {state.artifactDirectory && (
            <p className="quiet break-all text-[11px]">
              Protected files: {state.artifactDirectory}. Read handoff.json and
              use deployment.env as a secret when present. Update service
              addresses and install the matching plugin before activation.
            </p>
          )}
          {state.backupReady && !state.running && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={download}
            >
              <Download size={14} />
              Download Encrypted Backup
            </Button>
          )}
          {state.sourcePaused && !state.running && (
            <div className="space-y-3 border-t pt-3">
              <label className="flex items-start gap-2 text-xs">
                <input
                  type="checkbox"
                  className="accent-primary"
                  checked={resumeConfirmed}
                  onChange={(e) => setResumeConfirmed(e.target.checked)}
                />
                The destination is stopped. Resume this source and treat the
                copy as a rehearsal.
              </label>
              <Button
                size="sm"
                variant="outline"
                disabled={!resumeConfirmed || busy}
                onClick={resume}
              >
                Resume Source
              </Button>
            </div>
          )}
        </section>
      )}
      <p className="quiet text-[11px] leading-relaxed">
        Transfers include database data and workspace keys. Container images,
        plugin binaries, logs, database roles and Kubernetes manifests are
        separate deployment steps. Use one active proxy during this first
        migration flow.
      </p>
    </div>
  );
}
