import { useEffect, useState } from "react";
import { ArrowUpRight, ShieldCheck } from "lucide-react";
import { AccountActions } from "@/components/AccountActions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api, errorMessage, type Credential } from "@/lib/api";
import { maskEmails, resolvedUsage, type LiveUsage } from "@/lib/accounts";

export function AccountDetails({
  credential,
  onClose,
  onSaved,
}: {
  credential: Credential;
  onClose: () => void;
  onSaved: (message: string) => Promise<void>;
}) {
  const [live, setLive] = useState<LiveUsage>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (
      !credential.auth_index ||
      !(
        ["claude", "codex"].includes(credential.provider) ||
        credential.supports_quota
      )
    )
      return;
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    api<LiveUsage>(
      `/accounts/usage?auth_index=${encodeURIComponent(credential.auth_index)}`,
      { signal: controller.signal },
    )
      .then((data) => {
        if (active) setLive(data);
      })
      .catch((err) => {
        if (active) setError(maskEmails(errorMessage(err)));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [credential.auth_index, credential.provider, credential.supports_quota]);
  const plan = resolvedUsage(credential, live).plan;
  async function refreshPlan() {
    setLoading(true);
    setError("");
    try {
      setLive(
        await api<LiveUsage>(
          `/accounts/usage?auth_index=${encodeURIComponent(credential.auth_index!)}&refresh_plan=1`,
        ),
      );
    } catch (err) {
      setError(maskEmails(errorMessage(err)));
    } finally {
      setLoading(false);
    }
  }
  const planError =
    error || live?.profileError || (!plan && live?.usageError) || "";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <div className="mb-2 flex size-11 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
            <ShieldCheck size={22} />
          </div>
          <DialogTitle>
            {maskEmails(credential.email || credential.name)}
          </DialogTitle>
          <DialogDescription>
            Account details and connection controls.
          </DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-2 gap-5 rounded-lg border bg-muted/30 p-4 text-sm">
          <div>
            <dt className="quiet mb-1 text-xs">Provider</dt>
            <dd className="capitalize">
              {credential.provider || credential.type || "Unknown"}
            </dd>
          </div>
          <div>
            <dt className="quiet mb-1 text-xs">Status</dt>
            <dd className="capitalize">
              {credential.disabled ? "Disabled" : credential.status || "Loaded"}
            </dd>
          </div>
          <div>
            <dt className="quiet mb-1 text-xs">Plan</dt>
            <dd>
              {plan
                ? maskEmails(plan)
                : loading
                  ? "Checking plan…"
                  : "Not reported"}
            </dd>
          </div>
          <div>
            <dt className="quiet mb-1 text-xs">Credential storage</dt>
            <dd>
              {credential.runtime_only
                ? "Managed at runtime"
                : "Saved in CLIProxy"}
            </dd>
          </div>
        </dl>
        {credential.provider === "claude" && credential.auth_index && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="quiet text-xs">
              {live?.planCheckedAt
                ? `Plan checked ${new Date(live.planCheckedAt).toLocaleString()}. `
                : "Plans are cached for up to 24 hours. "}
              Manual checks are limited to once every five minutes.
            </p>
            <Button
              variant="outline"
              size="sm"
              disabled={loading}
              onClick={() => void refreshPlan()}
            >
              Refresh plan
            </Button>
          </div>
        )}
        {planError && (
          <p role="status" className="text-xs text-amber-300">
            {maskEmails(planError)}
          </p>
        )}
        {credential.status_message && (
          <p className="quiet break-words text-xs">
            {maskEmails(credential.status_message)}
          </p>
        )}
        <a
          href="#usage"
          onClick={onClose}
          className="flex items-center justify-between rounded-lg border p-3 text-sm hover:bg-muted"
        >
          <span>View Quota & Limits</span>
          <ArrowUpRight size={16} className="text-primary" />
        </a>
        <div className="-mx-6 -mb-6 mt-1">
          <div className="px-5 pb-3">
            <h3 className="text-xs font-medium">Account actions</h3>
            <p className="quiet mt-1 text-xs">
              Manage availability, refresh credentials or edit account fields.
            </p>
          </div>
          <AccountActions credential={credential} onSaved={onSaved} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
