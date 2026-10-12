import { useEffect, useState, type FormEvent } from "react";
import { Cable, FileJson, Loader2, LogIn, Plus, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ErrorNotice } from "@/components/shared";
import { api, errorMessage, write, type Config } from "@/lib/api";
import { OAuthConnect } from "@/components/OAuthConnect";

export function ConnectDialog({
  open,
  onOpenChange,
  onSaved,
  initialMode = "oauth",
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  config: Config;
  initialMode?: "oauth" | "api" | "file";
  onSaved: (message: string) => Promise<void>;
}) {
  const [mode, setMode] = useState<"oauth" | "api" | "file">("oauth");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [fileKind, setFileKind] = useState("credential");
  const [name, setName] = useState("");
  const [apiKind, setApiKind] = useState("openai-compatibility");
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [models, setModels] = useState("");
  useEffect(() => {
    if (open) {
      setMode(initialMode);
      setError("");
    }
  }, [open, initialMode]);
  async function save(event: FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (mode === "file") {
        if (!file) throw new Error("Choose a credential JSON file first.");
        if (file.size > 2 * 1024 * 1024)
          throw new Error("Credential files must be smaller than 2 MB.");
        if (!file.name.toLowerCase().endsWith(".json"))
          throw new Error("Choose a .json credential file.");
        const contents: unknown = JSON.parse(await file.text());
        if (
          !contents ||
          Array.isArray(contents) ||
          typeof contents !== "object"
        )
          throw new Error("A credential file must contain a JSON object.");
        if (fileKind === "vertex") {
          const form = new FormData();
          form.append("file", file);
          await api("/oauth/import?provider=vertex", {
            method: "POST",
            body: form,
          });
        } else {
          const existing = await api<{ files: { name: string }[] }>(
            "/credentials",
          );
          if (existing.files.some((item) => item.name === file.name))
            throw new Error(
              "A credential with that filename already exists. Rename the file before importing.",
            );
          await write(
            `/credentials?name=${encodeURIComponent(file.name)}`,
            "POST",
            contents,
          );
        }
      } else {
        const endpoint = url.trim() ? new URL(url.trim()) : undefined;
        if (
          endpoint &&
          (!["https:", "http:"].includes(endpoint.protocol) ||
            endpoint.username ||
            endpoint.password)
        )
          throw new Error(
            "Enter an HTTP or HTTPS base URL without embedded credentials.",
          );
        const modelNames = [
          ...new Set(
            models
              .split(/[\n,]/)
              .map((value) => value.trim())
              .filter(Boolean),
          ),
        ];
        if (
          !name.trim() ||
          !key.trim() ||
          (apiKind === "openai-compatibility" &&
            (!modelNames.length || !endpoint))
        )
          throw new Error(
            "Add a provider name, API key, and at least one model ID.",
          );
        const latest = await api<Config>("/config");
        const providers = latest["api-keys"][apiKind] ?? [];
        if (
          providers.some(
            (provider) =>
              provider.name.toLowerCase() === name.trim().toLowerCase(),
          )
        )
          throw new Error(
            "A provider with this name already exists. Choose a unique name.",
          );
        await write(`/config/api-keys/${apiKind}`, "PUT", [
          ...providers,
          {
            name: name.trim(),
            ...(url.trim()
              ? { "base-url": url.trim().replace(/\/$/, "") }
              : {}),
            keys: [{ "api-key": key.trim() }],
            ...(modelNames.length
              ? { models: modelNames.map((id) => ({ name: id, alias: id })) }
              : {}),
          },
        ]);
      }
      onOpenChange(false);
      setKey("");
      setName("");
      setUrl("");
      setModels("");
      setFile(null);
      await onSaved(
        mode === "file"
          ? "Credential imported."
          : "Provider saved. Its models are now configured.",
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!busy) {
          setError("");
          onOpenChange(value);
        }
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-[560px]">
        <DialogHeader>
          <div className="mb-3 flex size-10 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
            <Cable size={20} />
          </div>
          <DialogTitle>Connect a provider</DialogTitle>
          <DialogDescription>
            Bring your own access. Everything is saved to your local proxy.
          </DialogDescription>
        </DialogHeader>
        <div className="my-2 grid grid-cols-3 rounded-lg border bg-background p-1">
          {(
            [
              { id: "oauth", label: "Account sign-in", icon: LogIn },
              { id: "api", label: "API key", icon: Cable },
              { id: "file", label: "Import file", icon: FileJson },
            ] as const
          ).map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              aria-pressed={mode === id}
              disabled={busy}
              onClick={() => {
                setMode(id);
                setError("");
              }}
              className={`flex items-center justify-center gap-1.5 rounded-md px-2 py-2 text-[11px] sm:text-xs ${mode === id ? "bg-muted text-foreground" : "text-muted-foreground"}`}
            >
              <Icon size={14} />
              {label}
            </button>
          ))}
        </div>
        {mode === "oauth" ? (
          open && (
            <OAuthConnect
              onSaved={onSaved}
              onDone={() => onOpenChange(false)}
            />
          )
        ) : (
          <form onSubmit={save} className="space-y-4">
            {mode === "api" ? (
              <>
                <Field label="Provider type" id="provider-type">
                  <select
                    id="provider-type"
                    className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                    value={apiKind}
                    onChange={(e) => setApiKind(e.target.value)}
                  >
                    {[
                      "openai-compatibility",
                      "claude",
                      "codex",
                      "gemini",
                      "interactions",
                      "vertex",
                      "xai",
                      "meta",
                    ].map((type) => (
                      <option key={type} value={type}>
                        {type}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Provider name" id="provider-name">
                  <Input
                    id="provider-name"
                    placeholder="e.g. My provider"
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </Field>
                <Field label="Base URL" id="provider-url">
                  <Input
                    id="provider-url"
                    type="url"
                    placeholder="https://api.example.com/v1"
                    required={apiKind === "openai-compatibility"}
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                  />
                  <p className="quiet text-[11px]">
                    {apiKind === "openai-compatibility"
                      ? "An OpenAI-compatible API endpoint, including /v1 if required."
                      : "Optional. Leave blank to use the provider’s default endpoint."}
                  </p>
                </Field>
                <Field label="Provider API key" id="provider-key">
                  <Input
                    id="provider-key"
                    type="password"
                    autoComplete="off"
                    placeholder="sk-…"
                    required
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                  />
                </Field>
                <Field label="Model IDs" id="provider-models">
                  <textarea
                    id="provider-models"
                    rows={3}
                    className="w-full rounded-md border bg-transparent px-3 py-2 font-mono text-xs placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
                    placeholder="One model ID per line"
                    required={apiKind === "openai-compatibility"}
                    value={models}
                    onChange={(e) => setModels(e.target.value)}
                  />
                  <p className="quiet text-[11px]">
                    {apiKind === "openai-compatibility"
                      ? "Use the exact model IDs supplied by your provider."
                      : "Optional. Leave blank to use the native model catalog."}{" "}
                    Saving does not test inference.
                  </p>
                </Field>
              </>
            ) : (
              <div className="space-y-4">
                <Field label="Import format" id="import-format">
                  <select
                    id="import-format"
                    value={fileKind}
                    onChange={(e) => setFileKind(e.target.value)}
                    className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                  >
                    <option value="credential">CLIProxy credential JSON</option>
                    <option value="vertex">Vertex service account JSON</option>
                  </select>
                </Field>
                <label
                  htmlFor="credential-file"
                  className="flex cursor-pointer flex-col items-center gap-3 rounded-lg border border-dashed bg-background/50 px-4 py-8"
                >
                  <Upload size={24} className="text-primary" />
                  <span className="text-sm">
                    {file ? file.name : "Choose a credential file"}
                  </span>
                  <span className="quiet text-xs">
                    CLIProxyAPI credential JSON · up to 2 MB
                  </span>
                  <Input
                    id="credential-file"
                    type="file"
                    accept=".json,application/json"
                    className="mt-1 max-w-xs"
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  />
                </label>
                <p className="quiet text-xs leading-relaxed">
                  Import an existing CLIProxyAPI credential export, or use
                  Account sign-in to connect a provider directly.
                </p>
              </div>
            )}
            {error && <ErrorNotice message={error} />}
            <div className="flex justify-end gap-2 border-t pt-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? (
                  <Loader2 className="animate-spin" size={15} />
                ) : (
                  <Plus size={15} />
                )}{" "}
                {mode === "api" ? "Save provider" : "Import credential"}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
export function Field({
  label,
  id,
  children,
}: {
  label: string;
  id: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="block text-xs font-medium">
        {label}
      </label>
      {children}
    </div>
  );
}
