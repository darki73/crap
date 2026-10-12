import { useCallback, useEffect, useState } from "react";
import { Download, RefreshCw, Search, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  EmptyState,
  ErrorNotice,
  PageHeading,
  Pending,
} from "@/components/shared";
import { api, errorMessage } from "@/lib/api";
import { OperationDialog, type Operation } from "@/components/Management";
import { maskEmails } from "@/lib/accounts";

export function Logs({ enabled }: { enabled: boolean }) {
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [auto, setAuto] = useState(false);
  const [search, setSearch] = useState("");
  const [operation, setOperation] = useState<Operation>();
  const load = useCallback(async () => {
    try {
      const result = await api<{ lines: string[] }>(
        "/observability/logs?limit=200",
      );
      setLines(result.lines ?? []);
      setError("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (enabled) void load();
    else setLoading(false);
  }, [enabled, load]);
  useEffect(() => {
    if (!auto || !enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await load();
      if (!cancelled) timer = setTimeout(poll, 5000);
    };
    timer = setTimeout(poll, 5000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [auto, enabled, load]);
  const filtered = lines.filter((line) =>
    line.toLowerCase().includes(search.toLowerCase()),
  );
  function download() {
    const url = URL.createObjectURL(
      new Blob([filtered.join("\n")], { type: "text/plain" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "cliproxy-logs.txt";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <>
      <PageHeading
        eyebrow="Observability"
        title="Logs"
        description="A window into what your proxy is doing."
        action={
          <div className="flex gap-2">
            <Button
              variant="ghost"
              className="text-destructive"
              onClick={() =>
                setOperation({
                  title: "Clear application logs",
                  description:
                    "Delete stored application logs from the proxy. Export any logs you need first.",
                  destructive: true,
                  confirm: "Clear logs",
                  run: async () => {
                    await api("/observability/logs", { method: "DELETE" });
                    setLines([]);
                    await load();
                  },
                })
              }
            >
              Clear logs
            </Button>
            <Button
              variant="outline"
              disabled={!lines.length}
              onClick={download}
            >
              <Download size={15} />
              Export view
            </Button>
          </div>
        }
      />
      <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
        <div className="relative w-full max-w-sm">
          <Search
            size={15}
            className="absolute left-3 top-2.5 text-muted-foreground"
          />
          <Input
            aria-label="Search logs"
            className="pl-9"
            placeholder="Filter log messages…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-4">
          <label
            className="flex items-center gap-2 text-xs text-muted-foreground"
            htmlFor="live-logs"
          >
            <Switch
              id="live-logs"
              checked={auto}
              onCheckedChange={setAuto}
              disabled={!enabled}
            />
            Auto-refresh · 5s
          </label>
          <Button
            variant="outline"
            size="sm"
            disabled={!enabled || loading}
            onClick={() => {
              setLoading(true);
              void load();
            }}
          >
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
            Refresh logs
          </Button>
        </div>
      </div>
      {error && (
        <div className="mb-5">
          <ErrorNotice message={error} />
        </div>
      )}
      <section className="surface overflow-hidden">
        <div className="flex items-center justify-between border-b px-5 py-3">
          <span className="flex items-center gap-2 font-mono text-xs">
            <Terminal size={14} className="text-primary" />
            proxy / main.log
          </span>
          <span className="quiet text-[10px]">
            Last 200 lines · {filtered.length} shown
          </span>
        </div>
        {!enabled ? (
          <EmptyState icon={Terminal} title="File logging is turned off">
            Enable file logging in Settings to see server logs here.
          </EmptyState>
        ) : loading && !lines.length ? (
          <Pending>Reading logs…</Pending>
        ) : !filtered.length ? (
          <EmptyState
            icon={Terminal}
            title={search ? "No matching logs" : "Nothing to report yet"}
          >
            {search
              ? "Try a different search."
              : "Server messages will appear as your proxy runs."}
          </EmptyState>
        ) : (
          <div className="max-h-[560px] min-h-[280px] overflow-auto bg-[#121416] py-3 font-mono text-[11px] leading-6">
            {filtered.map((line, index) => (
              <div key={index} className="flex gap-4 px-4 hover:bg-white/3">
                <span className="w-7 shrink-0 select-none text-right text-[#53595e]">
                  {index + 1}
                </span>
                <span
                  className={`whitespace-pre-wrap break-all ${/\[(error|fatal)\]|level=error/i.test(line) ? "text-red-300" : /\[warn\]|level=warning/i.test(line) ? "text-amber-300" : "text-[#acb4b9]"}`}
                >
                  {maskEmails(line)}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
      {operation && (
        <OperationDialog
          operation={operation}
          onClose={() => setOperation(undefined)}
        />
      )}
    </>
  );
}
