import { Paginated } from "@/components/Paginated";
import { useCallback, useEffect, useState } from "react";
import { Boxes, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  CopyButton,
  EmptyState,
  ErrorNotice,
  PageHeading,
  Pending,
} from "@/components/shared";
import { api, errorMessage, type Credential } from "@/lib/api";
import { maskEmails } from "@/lib/accounts";
import { DataView, selectClass } from "@/components/Management";
type Model = {
  id: string;
  display_name?: string;
  owned_by?: string;
  [key: string]: unknown;
};
export function Models({ credentials }: { credentials: Credential[] }) {
  const [source, setSource] = useState("account");
  const [account, setAccount] = useState("");
  const [channel, setChannel] = useState("claude");
  const [models, setModels] = useState<Model[]>([]);
  const [search, setSearch] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selectedAccount = credentials.some((c) => c.name === account)
    ? account
    : credentials[0]?.name;
  const load = useCallback(
    async (signal?: AbortSignal) => {
      setBusy(true);
      setError("");
      try {
        const name = selectedAccount;
        if (source === "account" && !name)
          throw new Error("Connect an account first.");
        const result = await api<{ models: Model[] }>(
          source === "account"
            ? `/credentials/models?name=${encodeURIComponent(name!)}`
            : `/routing/model-definitions/${encodeURIComponent(channel.trim())}`,
          { signal },
        );
        if (signal?.aborted) return;
        setModels(result.models ?? []);
        setLoaded(true);
      } catch (err) {
        if (signal?.aborted) return;
        setError(errorMessage(err));
        setModels([]);
        setLoaded(false);
      } finally {
        if (!signal?.aborted) setBusy(false);
      }
    },
    [source, selectedAccount, channel],
  );
  useEffect(() => {
    if (source !== "account" || !selectedAccount) return;
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, source, selectedAccount]);
  const visible = models.filter((m) =>
    `${m.id} ${m.display_name || ""}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  return (
    <>
      <PageHeading
        eyebrow="Model catalog"
        title="Models"
        description="Explore models registered to each account and the proxy’s static definitions."
      />
      <div className="surface mb-5 grid gap-4 p-5 sm:grid-cols-[1fr_1fr_auto]">
        <label className="space-y-2 text-xs">
          Source
          <select
            className={selectClass}
            value={source}
            disabled={busy}
            onChange={(e) => {
              setSource(e.target.value);
              setLoaded(false);
              setModels([]);
            }}
          >
            <option value="account">Account models</option>
            <option value="definitions">Static definitions</option>
          </select>
        </label>
        {source === "account" ? (
          <label className="space-y-2 text-xs">
            Account
            <select
              className={selectClass}
              value={selectedAccount || ""}
              disabled={busy}
              onChange={(e) => {
                setAccount(e.target.value);
                setLoaded(false);
                setModels([]);
              }}
            >
              {!credentials.length && <option value="">No accounts</option>}
              {credentials.map((c) => (
                <option key={c.id || c.name} value={c.name}>
                  {c.provider} · {maskEmails(c.email || c.name)}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label className="space-y-2 text-xs">
            Provider channel
            <Input
              value={channel}
              disabled={busy}
              onChange={(e) => {
                setChannel(e.target.value);
                setLoaded(false);
                setModels([]);
              }}
              placeholder="claude"
            />
          </label>
        )}
        <Button
          className="self-end"
          disabled={busy}
          onClick={() => void load()}
        >
          {busy ? "Loading…" : loaded ? "Refresh models" : "Load models"}
        </Button>
      </div>
      {error && <ErrorNotice message={error} />}
      <div className="relative my-5 max-w-sm">
        <Search
          size={14}
          className="absolute left-3 top-3 text-muted-foreground"
        />
        <Input
          className="pl-9"
          aria-label="Search models"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search model IDs…"
        />
      </div>
      <section className="surface divide-y">
        {busy ? (
          <Pending>Loading model catalog…</Pending>
        ) : !models.length ? (
          <EmptyState
            icon={Boxes}
            title={loaded ? "No registered models" : "Choose a model source"}
          >
            {loaded
              ? "This account has no models registered. Static definitions do not guarantee account access."
              : "Load an account or provider catalog to explore its models."}
          </EmptyState>
        ) : !visible.length ? (
          <EmptyState icon={Search} title="No matching models">
            Try another model name or clear your search.
          </EmptyState>
        ) : (
          <Paginated
            key={`${source}:${selectedAccount}:${channel}:${search}`}
            items={visible}
            label="models"
          >
            {(pageRows) =>
              pageRows.map((m) => (
                <div key={m.id} className="p-5">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h2 className="font-mono text-sm">{m.id}</h2>
                      <p className="quiet mt-1 text-xs">
                        {m.display_name || m.owned_by || "Registered model"}
                      </p>
                    </div>
                    <CopyButton value={m.id} label="Copy model ID" />
                  </div>
                  <details className="mt-3 text-xs">
                    <summary className="cursor-pointer text-muted-foreground">
                      Model details
                    </summary>
                    <div className="mt-3">
                      <DataView value={m} />
                    </div>
                  </details>
                </div>
              ))
            }
          </Paginated>
        )}
      </section>
    </>
  );
}
