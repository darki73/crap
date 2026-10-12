import { useEffect, useState } from "react";
import { Puzzle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState, ErrorNotice, PageHeading } from "@/components/shared";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { OAuthConnect } from "@/components/OAuthConnect";
import {
  api,
  optionalConfig,
  errorMessage,
  write,
  type Credential,
} from "@/lib/api";
import { maskEmails } from "@/lib/accounts";
import {
  DataView,
  OperationDialog,
  parseObject,
  pretty,
  selectClass,
  type Operation,
} from "@/components/Management";
type Plugin = {
  id: string;
  name?: string;
  description?: string;
  version?: string;
  source_id?: string;
  source_name?: string;
  source_url?: string;
  installed?: boolean;
  installed_version?: string;
  enabled?: boolean;
  effective_enabled?: boolean;
  registered?: boolean;
  supports_oauth?: boolean;
  oauth_provider?: string;
  supports_quota?: boolean;
  quota_provider?: string;
  config_fields?: unknown[];
  metadata?: { name: string; version: string };
};
type PluginList = {
  plugins: Plugin[];
  plugins_enabled: boolean;
  source_errors?: { message: string }[];
};
export function Plugins({
  credentials,
  onSaved,
}: {
  credentials: Credential[];
  onSaved: (message: string) => Promise<void>;
}) {
  const [tab, setTab] = useState("installed");
  const [list, setList] = useState<PluginList>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [operation, setOperation] = useState<Operation>();
  const [quota, setQuota] = useState<unknown>();
  const [account, setAccount] = useState("");
  const [login, setLogin] = useState<Plugin>();
  const [outcome, setOutcome] = useState<unknown>();
  async function load() {
    setBusy(true);
    setError("");
    try {
      setList(
        await api<PluginList>(
          tab === "installed" ? "/plugins" : "/plugins/store",
        ),
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    let active = true;
    setBusy(true);
    setList(undefined);
    setError("");
    api<PluginList>(tab === "installed" ? "/plugins" : "/plugins/store")
      .then((value) => {
        if (active) setList(value);
      })
      .catch((err) => {
        if (active) setError(errorMessage(err));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [tab]);
  async function configure(plugin: Plugin) {
    setError("");
    try {
      const config = await optionalConfig<{
        configs?: Record<string, unknown>;
      }>("/config/plugins", {});
      const original = config.configs?.[plugin.id] ?? { enabled: false };
      setOperation({
        title: `Configure ${plugin.metadata?.name || plugin.name || plugin.id}`,
        description:
          "Edit plugin settings. Enabling a plugin can start its code in the proxy; loaded plugins may require a server restart for some changes.",
        initial: pretty(original),
        run: async (text) => {
          const value = parseObject(text);
          const latest = await optionalConfig<{
            configs?: Record<string, unknown>;
          }>("/config/plugins", {});
          if (
            pretty(latest.configs?.[plugin.id] ?? { enabled: false }) !==
            pretty(original)
          )
            throw new Error(
              "Plugin configuration changed. Reopen the editor before saving.",
            );
          await write(
            `/config/plugins/configs/${encodeURIComponent(plugin.id)}`,
            "PUT",
            value,
          );
          await load();
          await onSaved("Plugin configuration saved.");
        },
      });
    } catch (err) {
      setError(errorMessage(err));
    }
  }
  async function fetchQuota(plugin: Plugin) {
    setError("");
    if (!account) {
      setError("Select an account for the quota lookup.");
      return;
    }
    setBusy(true);
    try {
      setQuota(
        await api(
          `/plugins/${encodeURIComponent(plugin.id)}/quota?auth_index=${encodeURIComponent(account)}`,
        ),
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeading
        eyebrow="Extend your proxy"
        title="Plugins"
        description="Manage installed extensions, browse the store, and inspect provider quotas."
        action={
          <Button variant="outline" disabled={busy} onClick={() => void load()}>
            <RefreshCw size={14} />
            Refresh plugins
          </Button>
        }
      />
      <div className="mb-5 flex gap-2">
        {["installed", "store"].map((value) => (
          <Button
            key={value}
            disabled={busy}
            variant={tab === value ? "default" : "outline"}
            onClick={() => setTab(value)}
          >
            {value === "installed" ? "Installed" : "Plugin store"}
          </Button>
        ))}
      </div>
      {error && (
        <div className="mb-5">
          <ErrorNotice message={error} />
        </div>
      )}
      {list && (
        <div className="surface mb-5 flex flex-wrap items-center justify-between gap-4 p-5">
          <p className="text-xs">
            Plugin system:{" "}
            <span
              className={
                list.plugins_enabled ? "text-primary" : "text-muted-foreground"
              }
            >
              {list.plugins_enabled ? "Enabled" : "Disabled"}
            </span>
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              setOperation({
                title: list.plugins_enabled
                  ? "Disable plugin system"
                  : "Enable plugin system",
                description:
                  "Change whether configured plugins can run. A restart may be needed for plugins that cannot reload in place.",
                run: async () => {
                  await write(
                    "/config/plugins/enabled",
                    "PUT",
                    !list.plugins_enabled,
                  );
                  await load();
                  await onSaved("Plugin system updated.");
                },
              })
            }
          >
            {list.plugins_enabled ? "Disable system" : "Enable system"}
          </Button>
        </div>
      )}
      {list?.source_errors?.map((source, i) => (
        <div key={i} className="mb-3">
          <ErrorNotice message={source.message} />
        </div>
      ))}
      {tab === "installed" && list?.plugins.some((p) => p.supports_quota) && (
        <label className="mb-5 block max-w-lg space-y-2 text-xs">
          Account for plugin quota operations
          <select
            className={selectClass}
            value={account}
            onChange={(e) => setAccount(e.target.value)}
          >
            <option value="">Choose account</option>
            {credentials
              .filter((c) => c.auth_index)
              .map((c) => (
                <option key={c.id} value={c.auth_index}>
                  {c.provider} · {maskEmails(c.email || c.name)}
                </option>
              ))}
          </select>
        </label>
      )}
      <section className="surface divide-y">
        {busy && !list ? (
          <p className="p-8 text-sm text-muted-foreground">Loading plugins…</p>
        ) : !list?.plugins.length ? (
          <EmptyState
            icon={Puzzle}
            title={
              tab === "installed"
                ? "No plugins installed"
                : "No store entries available"
            }
          >
            Configure plugin sources and credentials under Configuration →
            plugins if needed.
          </EmptyState>
        ) : (
          list.plugins.map((plugin) => (
            <article
              key={`${plugin.source_id || ""}-${plugin.id}`}
              className="p-5"
            >
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <h2 className="text-sm font-medium">
                    {plugin.metadata?.name || plugin.name || plugin.id}
                  </h2>
                  <p className="quiet mt-1 text-xs">
                    {plugin.description || plugin.id}
                  </p>
                  <p className="quiet mt-2 font-mono text-[10px]">
                    {plugin.metadata?.version ||
                      plugin.installed_version ||
                      plugin.version ||
                      "Version not reported"}
                    {plugin.source_name ? ` · ${plugin.source_name}` : ""}
                  </p>
                </div>
                <Badge variant="outline">
                  {tab === "store"
                    ? plugin.installed
                      ? "Installed"
                      : "Available"
                    : plugin.effective_enabled
                      ? "Running"
                      : plugin.enabled
                        ? "Enabled"
                        : "Disabled"}
                </Badge>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                {tab === "store" ? (
                  <Button
                    size="sm"
                    onClick={() =>
                      setOperation({
                        title: plugin.installed
                          ? "Update plugin"
                          : "Install plugin",
                        description: `Download and enable ${plugin.name || plugin.id} from ${plugin.source_name || plugin.source_id || "the configured store"}. The plugin runs code in the proxy. Review the source before installing.`,
                        initial: pretty({ version: plugin.version || "" }),
                        label: "Requested version (empty uses latest)",
                        confirm: plugin.installed
                          ? "Update & enable"
                          : "Install & enable",
                        run: async (text) => {
                          const body = parseObject(text);
                          const result = await write(
                            `/plugins/store/${encodeURIComponent(plugin.id)}/install${plugin.source_id ? `?source=${encodeURIComponent(plugin.source_id)}` : ""}`,
                            "POST",
                            body,
                          );
                          setOutcome(result);
                          await load();
                          await onSaved(
                            "Plugin install request completed. Check its result for restart requirements.",
                          );
                        },
                      })
                    }
                  >
                    {plugin.installed ? "Update" : "Install"}
                  </Button>
                ) : (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void configure(plugin)}
                    >
                      Configure
                    </Button>
                    {plugin.supports_oauth && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setLogin(plugin)}
                      >
                        Sign in
                      </Button>
                    )}
                    {plugin.supports_quota && (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy || !account}
                          onClick={() => void fetchQuota(plugin)}
                        >
                          Fetch quota
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={!account}
                          onClick={() =>
                            setOperation({
                              title: "Reset plugin quota state",
                              description: `Ask ${plugin.id} to reset quota state for the selected account. The effect depends on the plugin; this does not guarantee a new provider allowance.`,
                              destructive: true,
                              confirm: "Reset state",
                              run: async () => {
                                setQuota(
                                  await api(
                                    `/plugins/${encodeURIComponent(plugin.id)}/quota?auth_index=${encodeURIComponent(account)}`,
                                    { method: "DELETE" },
                                  ),
                                );
                              },
                            })
                          }
                        >
                          Reset state
                        </Button>
                      </>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive"
                      onClick={() =>
                        setOperation({
                          title: "Delete plugin",
                          description: `Delete ${plugin.id} and its saved plugin configuration. Running plugins may require a restart before deletion is possible.`,
                          destructive: true,
                          confirm: "Delete plugin",
                          run: async () => {
                            setOutcome(
                              await api(
                                `/plugins/${encodeURIComponent(plugin.id)}`,
                                { method: "DELETE" },
                              ),
                            );
                            await load();
                            await onSaved("Plugin deleted.");
                          },
                        })
                      }
                    >
                      Delete
                    </Button>
                  </>
                )}
              </div>
              <details className="mt-3 text-xs">
                <summary className="cursor-pointer text-muted-foreground">
                  Metadata & configuration fields
                </summary>
                <div className="mt-3">
                  <DataView value={plugin} />
                </div>
              </details>
            </article>
          ))
        )}
      </section>
      {outcome !== undefined && (
        <section className="surface mt-5 p-5">
          <h2 className="mb-3 text-sm">Operation result</h2>
          <DataView value={outcome} />
        </section>
      )}
      {quota !== undefined && (
        <section className="surface mt-5 p-5">
          <h2 className="mb-3 text-sm">Plugin quota result</h2>
          <DataView value={quota} />
        </section>
      )}
      {operation && (
        <OperationDialog
          operation={operation}
          onClose={() => setOperation(undefined)}
        />
      )}
      {login && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setLogin(undefined);
          }}
        >
          <DialogContent className="max-h-[90dvh] overflow-auto sm:max-w-xl">
            <DialogHeader>
              <DialogTitle>Plugin sign-in</DialogTitle>
              <DialogDescription>
                Connect an account using the selected plugin.
              </DialogDescription>
            </DialogHeader>
            <OAuthConnect
              providers={[
                {
                  id: login.oauth_provider || login.id,
                  name: login.metadata?.name || login.id,
                  description: "Plugin account",
                  mark: "◇",
                  color: "text-primary",
                },
              ]}
              onSaved={onSaved}
              onDone={() => setLogin(undefined)}
            />
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
