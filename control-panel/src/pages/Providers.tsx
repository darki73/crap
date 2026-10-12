import { Paginated } from "@/components/Paginated";
import { useState, type ReactNode } from "react";
import {
  ArrowUpRight,
  Globe,
  KeyRound,
  Plus,
  Search,
  ShieldCheck,
  Upload,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { AccountDetails } from "@/components/AccountDetails";
import { maskEmails } from "@/lib/accounts";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  OperationDialog,
  parseObject,
  pretty,
  type Operation,
} from "@/components/Management";
import {
  api,
  errorMessage,
  write,
  type Config,
  type Credential,
} from "@/lib/api";
import { EmptyState, ErrorNotice, PageHeading } from "@/components/shared";

export function Providers({
  config,
  credentials,
  onConnect,
  onSaved,
}: {
  config: Config;
  credentials: Credential[];
  onConnect: (mode?: "oauth" | "api" | "file") => void;
  onSaved: (message: string) => Promise<void>;
}) {
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [selectedAccount, setSelectedAccount] = useState<string>();
  const [selectedProvider, setSelectedProvider] = useState<string>();
  const [operation, setOperation] = useState<Operation>();
  function editProvider(
    item: Config["api-keys"][string][number],
    type: string,
    index: number,
    remove = false,
  ) {
    setOperation({
      title: remove ? "Delete provider" : "Edit provider",
      description: remove
        ? `Remove ${item.name || type} and its configured keys and models.`
        : "Edit this provider’s settings, keys, headers, model aliases, and overrides. This editor contains API keys; preserve fields you do not intend to change.",
      destructive: remove,
      initial: remove ? undefined : pretty(item),
      run: async (text) => {
        const latest = await api<Config>("/config");
        const list = latest["api-keys"][type] ?? [];
        if (JSON.stringify(list[index]) !== JSON.stringify(item))
          throw new Error(
            "This provider changed since you opened it. Refresh and try again.",
          );
        const next = [...list];
        if (remove) next.splice(index, 1);
        else next[index] = parseObject(text) as typeof item;
        await write(
          `/config/api-keys/${encodeURIComponent(type)}`,
          "PUT",
          next,
        );
        await onSaved(remove ? "Provider removed." : "Provider updated.");
      },
    });
  }
  const groups = Object.entries(config["api-keys"])
    .filter(([, items]) => Array.isArray(items))
    .flatMap(([type, items]) =>
      items.map((item, index) => ({ item, type, index })),
    );
  const visible = groups.filter(({ item, type }) =>
    `${item.name ?? ""} ${type} ${item["base-url"] ?? ""}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const files = credentials.filter((item) =>
    `${item.email ?? ""} ${item.name} ${item.provider ?? ""}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  async function toggleProvider(name: string, disabled: boolean) {
    setBusy(true);
    setError("");
    try {
      const latest = await api<Config>("/config");
      const items = latest["api-keys"]["openai-compatibility"] ?? [];
      await write(
        "/config/api-keys/openai-compatibility",
        "PUT",
        items.map((item) =>
          item.name === name ? { ...item, disabled } : item,
        ),
      );
      await onSaved(disabled ? "Provider disabled." : "Provider enabled.");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  const account = credentials.find(
    (item) => (item.id || item.name) === selectedAccount,
  );
  const provider = groups.find(
    ({ type, index }) => `${type}:${index}` === selectedProvider,
  );
  return (
    <>
      <PageHeading
        eyebrow="Connections"
        title="Accounts & Providers"
        description="Connect with API credentials or sign in with an existing subscription."
      />
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="relative w-full max-w-sm">
          <Search
            size={15}
            className="absolute left-3 top-2.5 text-muted-foreground"
          />
          <Input
            aria-label="Search connections"
            className="pl-9"
            placeholder="Find an account or provider…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Account emails are always masked.
        </p>
      </div>
      {error && (
        <div className="mb-5">
          <ErrorNotice message={error} />
        </div>
      )}
      <div className="grid items-stretch gap-6 xl:grid-cols-2">
        <ConnectionPanel
          icon={KeyRound}
          title="API Credentials"
          description="Connect providers with your own API keys."
          count={groups.length}
          action={
            <Button
              size="sm"
              variant="outline"
              onClick={() => onConnect("api")}
            >
              <Plus size={14} />
              Add API
            </Button>
          }
          footer={<span>Native providers & OpenAI-compatible endpoints</span>}
        >
          {!groups.length ? (
            <div className="flex flex-1 items-center justify-center px-5 py-10">
              <div className="max-w-xs text-center">
                <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-xl border bg-muted/40">
                  <Globe size={22} className="text-muted-foreground" />
                </div>
                <h3 className="text-sm font-medium">Your APIs belong here</h3>
                <p className="mt-2 text-xs leading-6 text-muted-foreground">
                  Bring an API key to connect a hosted provider or your own
                  compatible endpoint.
                </p>
                <Button
                  className="mt-5"
                  size="sm"
                  variant="outline"
                  onClick={() => onConnect("api")}
                >
                  Add API credentials
                  <ArrowUpRight size={14} />
                </Button>
              </div>
            </div>
          ) : !visible.length ? (
            <EmptyState icon={Search} title="No matching APIs">
              Try a different name or endpoint.
            </EmptyState>
          ) : (
            <Paginated key={search} items={visible} label="API credentials">
              {(pageRows) => (
                <ul className="divide-y">
                  {pageRows.map(({ item, type, index }) => (
                    <li
                      key={`${type}-${index}`}
                      className="flex items-center gap-3 px-5 py-5"
                    >
                      <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border bg-background">
                        <Globe size={18} className="text-muted-foreground" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <h3 className="truncate text-sm font-medium">
                          {maskEmails(item.name || type)}
                        </h3>
                        <p className="mt-1 truncate text-xs text-muted-foreground">
                          {type} ·{" "}
                          {item.models?.length
                            ? `${item.models.length} models`
                            : "Provider defaults"}
                        </p>
                        <span
                          className={`mt-2 inline-flex items-center gap-1.5 text-[10px] ${item.disabled ? "text-muted-foreground" : "text-primary"}`}
                        >
                          <span className="size-1 rounded-full bg-current" />
                          {item.disabled ? "Disabled" : "Configured"}
                        </span>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={`Manage ${maskEmails(item.name || type)}`}
                        onClick={() => setSelectedProvider(`${type}:${index}`)}
                      >
                        Manage
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </Paginated>
          )}
        </ConnectionPanel>
        <ConnectionPanel
          icon={ShieldCheck}
          title="Subscriptions"
          description="Connect accounts through sign-in or import."
          count={credentials.length}
          action={
            <Button
              size="sm"
              variant="outline"
              onClick={() => onConnect("oauth")}
            >
              <Plus size={14} />
              Sign in
            </Button>
          }
          footer={
            <>
              <button
                onClick={() => onConnect("file")}
                className="flex items-center gap-1.5 hover:text-foreground"
              >
                <Upload size={12} />
                Import account
              </button>
              <a
                href="#usage"
                className="flex items-center gap-1 text-primary hover:underline"
              >
                Quota & Limits
                <ArrowUpRight size={12} />
              </a>
            </>
          }
        >
          {!credentials.length ? (
            <div className="flex flex-1 items-center justify-center px-5 py-10">
              <div className="max-w-xs text-center">
                <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-xl border bg-muted/40">
                  <ShieldCheck size={22} className="text-muted-foreground" />
                </div>
                <h3 className="text-sm font-medium">
                  Connect an existing account
                </h3>
                <p className="mt-2 text-xs leading-6 text-muted-foreground">
                  Sign in to a supported provider. Its available models will
                  appear automatically.
                </p>
                <Button
                  className="mt-5"
                  size="sm"
                  variant="outline"
                  onClick={() => onConnect("oauth")}
                >
                  Connect account
                  <ArrowUpRight size={14} />
                </Button>
              </div>
            </div>
          ) : !files.length ? (
            <EmptyState icon={Search} title="No matching accounts">
              Try a different account or provider.
            </EmptyState>
          ) : (
            <Paginated key={search} items={files} label="subscriptions">
              {(pageRows) => (
                <ul className="divide-y">
                  {pageRows.map((item) => (
                    <li
                      key={item.id || item.name}
                      className="flex items-center gap-3 px-5 py-5"
                    >
                      <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-primary/15 bg-primary/5 text-sm font-medium uppercase text-primary">
                        {(item.provider || item.type || "?").slice(0, 1)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <h3 className="truncate text-sm font-medium">
                          {maskEmails(item.email || item.name)}
                        </h3>
                        <p className="mt-1 text-xs capitalize text-muted-foreground">
                          {item.provider || item.type || "Account"}
                        </p>
                        <span
                          className={`mt-2 inline-flex items-center gap-1.5 text-[10px] capitalize ${item.disabled || item.status === "error" ? "text-muted-foreground" : "text-primary"}`}
                        >
                          <span className="size-1 rounded-full bg-current" />
                          {item.disabled ? "Disabled" : item.status || "Loaded"}
                        </span>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={`Manage ${maskEmails(item.email || item.name)}`}
                        onClick={() => setSelectedAccount(item.id || item.name)}
                      >
                        Manage
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </Paginated>
          )}
        </ConnectionPanel>
      </div>
      <p className="mt-5 text-xs leading-6 text-muted-foreground">
        Manage connections here. See subscription windows in{" "}
        <a
          href="#usage"
          className="text-foreground underline underline-offset-4"
        >
          Quota & Limits
        </a>{" "}
        and recorded requests in the{" "}
        <a
          href="#ledger"
          className="text-foreground underline underline-offset-4"
        >
          Token Ledger
        </a>
        .
      </p>
      {account && (
        <AccountDetails
          key={account.id || account.name}
          credential={account}
          onClose={() => setSelectedAccount(undefined)}
          onSaved={onSaved}
        />
      )}
      {provider && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setSelectedProvider(undefined);
          }}
        >
          <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
            <DialogHeader>
              <DialogTitle>
                {maskEmails(provider.item.name || provider.type)}
              </DialogTitle>
              <DialogDescription>
                API connection settings and available models.
              </DialogDescription>
            </DialogHeader>
            <dl className="space-y-4 rounded-lg border bg-muted/30 p-4 text-sm">
              <div>
                <dt className="quiet mb-1 text-xs">Provider type</dt>
                <dd>{provider.type}</dd>
              </div>
              <div>
                <dt className="quiet mb-1 text-xs">Endpoint</dt>
                <dd className="break-all font-mono text-xs">
                  {provider.item["base-url"] || "Default provider endpoint"}
                </dd>
              </div>
              <div>
                <dt className="quiet mb-2 text-xs">Models</dt>
                <dd className="flex flex-wrap gap-1.5">
                  {provider.item.models?.length
                    ? provider.item.models.map((model) => (
                        <Badge
                          key={model.name}
                          variant="secondary"
                          className="break-all text-[10px]"
                        >
                          {model.alias || model.name}
                        </Badge>
                      ))
                    : "Provider defaults"}
                </dd>
              </div>
            </dl>
            {provider.type === "openai-compatibility" && (
              <div className="flex items-center justify-between gap-3 text-sm">
                <label htmlFor="provider-enabled">Connection enabled</label>
                <Switch
                  id="provider-enabled"
                  checked={!provider.item.disabled}
                  disabled={busy}
                  onCheckedChange={(value) =>
                    toggleProvider(provider.item.name, !value)
                  }
                />
              </div>
            )}
            <div className="flex justify-between gap-3 border-t pt-4">
              <Button
                variant="ghost"
                className="text-destructive"
                onClick={() =>
                  editProvider(
                    provider.item,
                    provider.type,
                    provider.index,
                    true,
                  )
                }
              >
                Delete provider
              </Button>
              <Button
                variant="outline"
                onClick={() =>
                  editProvider(provider.item, provider.type, provider.index)
                }
              >
                Edit configuration
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
      {operation && (
        <OperationDialog
          operation={operation}
          onClose={() => setOperation(undefined)}
        />
      )}
    </>
  );
}

function ConnectionPanel({
  icon: Icon,
  title,
  description,
  count,
  action,
  footer,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  count: number;
  action: ReactNode;
  footer: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className="surface flex min-h-[350px] min-w-0 flex-col overflow-hidden"
    >
      <div className="flex flex-wrap items-center justify-between gap-4 border-b p-5">
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-lg border bg-background">
            <Icon size={18} className="text-primary" />
          </div>
          <div>
            <h2 className="flex items-center gap-2 text-sm font-medium">
              {title}
              <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                {count}
              </span>
            </h2>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {description}
            </p>
          </div>
        </div>
        {action}
      </div>
      <div className="flex flex-1 flex-col">{children}</div>
      <div className="flex min-h-12 flex-wrap items-center justify-between gap-3 border-t bg-muted/15 px-5 py-3 text-[11px] text-muted-foreground">
        {footer}
      </div>
    </section>
  );
}
