import { Paginated } from "@/components/Paginated";
import { useState, type FormEvent } from "react";
import {
  Eye,
  EyeOff,
  KeyRound,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field } from "@/components/ConnectDialog";
import {
  CopyButton,
  EmptyState,
  ErrorNotice,
  PageHeading,
  SectionTitle,
} from "@/components/shared";
import { api, errorMessage, write, type Config } from "@/lib/api";
import { useClientEndpoint } from "@/lib/client-endpoint";
import { ClientEndpointDetails } from "@/components/ClientEndpoints";
import { ClientDevices } from "@/components/ClientDevices";

function generateKey() {
  return (
    "cpa-" +
    Array.from(crypto.getRandomValues(new Uint8Array(24)), (value) =>
      value.toString(16).padStart(2, "0"),
    ).join("")
  );
}
export function Keys({
  config,
  onSaved,
}: {
  config: Config;
  onSaved: (message: string) => Promise<void>;
}) {
  const endpoint = useClientEndpoint();
  const keys = config.access["api-keys"] ?? [];
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [revealed, setRevealed] = useState<string[]>([]);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (value.trim().length < 16)
        throw new Error("Use an API key with at least 16 characters.");
      const latest = await api<Config>("/config");
      const existing = latest.access["api-keys"] ?? [];
      if (existing.includes(value.trim()))
        throw new Error("That key already exists.");
      await write("/config/access/api-keys", "PUT", [
        ...existing,
        value.trim(),
      ]);
      setOpen(false);
      setValue("");
      await onSaved("Client API key created.");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    setBusy(true);
    setError("");
    try {
      const latest = await api<Config>("/config");
      const next = (latest.access["api-keys"] ?? []).filter(
        (item) => item !== deleting,
      );
      if (!next.length)
        throw new Error(
          "Keep at least one client key so API authentication remains enabled.",
        );
      await write("/config/access/api-keys", "PUT", next);
      setDeleting(null);
      await onSaved("Client API key removed.");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeading
        eyebrow="Access control"
        title="Client API Keys"
        description="Give your tools access to the proxy with a client API key."
        action={
          <Button
            onClick={() => {
              setValue(generateKey());
              setError("");
              setOpen(true);
            }}
          >
            <Plus size={16} />
            Create API key
          </Button>
        }
      />
      <div className="mb-6 flex items-start gap-3 rounded-lg border border-primary/15 bg-primary/5 p-4">
        <ShieldCheck size={18} className="mt-0.5 shrink-0 text-primary" />
        <p className="text-xs leading-relaxed text-[#b8c0af]">
          Client keys authenticate requests to your proxy. Your provider
          credentials stay separate.{" "}
          {endpoint.openAI ? (
            <>
              Use a client key with{" "}
              <code className="break-all text-primary">{endpoint.openAI}</code>{" "}
              in your OpenAI-compatible apps.
            </>
          ) : (
            endpoint.detail
          )}
        </p>
      </div>
      <section className="surface mb-6">
        <SectionTitle
          title="Connect a client"
          detail="Choose the base URL for your client."
        />
        <div className="space-y-5 p-5">
          <ClientEndpointDetails endpoint={endpoint} />
          <div className="border-t pt-4">
            <p className="eyebrow mb-2">Authentication header</p>
            <code className="text-xs text-muted-foreground">
              Authorization: Bearer &lt;your-client-key&gt;
            </code>
          </div>
        </div>
      </section>
      <ClientDevices
        onChanged={() =>
          onSaved("Computer removed and its client key revoked.")
        }
      />
      <section className="surface">
        <SectionTitle
          title="Workspace keys"
          detail={`${keys.length} ${keys.length === 1 ? "key" : "keys"} configured`}
        />
        {keys.length ? (
          <Paginated items={keys} label="keys">
            {(pageRows, offset) => (
              <div className="divide-y">
                {pageRows.map((key, index) => (
                  <div
                    key={key}
                    className="flex flex-wrap items-center gap-4 p-5"
                  >
                    <div className="flex size-10 items-center justify-center rounded-lg border bg-background">
                      <KeyRound size={18} className="text-primary" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="mb-1 text-sm font-medium">
                        Client key {offset + index + 1}
                      </p>
                      <code className="break-all text-xs text-muted-foreground">
                        {revealed.includes(key)
                          ? key
                          : `${key.slice(0, 6)}${"•".repeat(20)}${key.slice(-4)}`}
                      </code>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        aria-label={`${revealed.includes(key) ? "Hide" : "Reveal"} key ${offset + index + 1}`}
                        size="icon"
                        variant="ghost"
                        onClick={() =>
                          setRevealed((old) =>
                            old.includes(key)
                              ? old.filter((item) => item !== key)
                              : [...old, key],
                          )
                        }
                      >
                        {revealed.includes(key) ? (
                          <EyeOff size={15} />
                        ) : (
                          <Eye size={15} />
                        )}
                      </Button>
                      <CopyButton
                        value={key}
                        label={`Copy key ${offset + index + 1}`}
                      />
                      <Button
                        aria-label={`Delete key ${offset + index + 1}`}
                        size="icon"
                        variant="ghost"
                        disabled={keys.length === 1}
                        onClick={() => {
                          setError("");
                          setDeleting(key);
                        }}
                      >
                        <Trash2 size={15} className="text-muted-foreground" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Paginated>
        ) : (
          <EmptyState icon={KeyRound} title="Create your first client key">
            Add a key before connecting a client application.
          </EmptyState>
        )}
      </section>
      <p className="quiet mt-3 text-xs">
        The last key is kept to preserve client authentication.
      </p>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!busy) setOpen(next);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create client API key</DialogTitle>
            <DialogDescription>
              A random key is ready. Save it, then copy it into your client.
            </DialogDescription>
          </DialogHeader>
          <form className="space-y-5" onSubmit={save}>
            <Field label="API key" id="new-key">
              <div className="flex gap-2">
                <Input
                  id="new-key"
                  autoComplete="off"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  required
                  minLength={16}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label="Generate another key"
                  onClick={() => setValue(generateKey())}
                >
                  <RefreshCw size={15} />
                </Button>
              </div>
            </Field>
            {error && <ErrorNotice message={error} />}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setOpen(false)}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? "Saving…" : "Save API key"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={deleting !== null}
        onOpenChange={(next) => {
          if (!next && !busy) setDeleting(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove this client key?</DialogTitle>
            <DialogDescription>
              Clients using the key ending in {deleting?.slice(-4)} will lose
              access to the proxy.
            </DialogDescription>
          </DialogHeader>
          {error && <ErrorNotice message={error} />}
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setDeleting(null)}
            >
              Cancel
            </Button>
            <Button variant="destructive" disabled={busy} onClick={remove}>
              {busy ? "Removing…" : "Remove key"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
