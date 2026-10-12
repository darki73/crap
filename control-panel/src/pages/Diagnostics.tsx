import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeading, ErrorNotice, SectionTitle } from "@/components/shared";
import {
  api,
  apiResponse,
  write,
  errorMessage,
  type Credential,
} from "@/lib/api";
import { maskEmails } from "@/lib/accounts";
import {
  DataView,
  OperationDialog,
  downloadFile,
  editorClass,
  parseObject,
  pretty,
  selectClass,
  saveFile,
  type Operation,
} from "@/components/Management";
type ErrorFile = { name: string; size: number; modified: number };
export function Diagnostics({ credentials }: { credentials: Credential[] }) {
  const [files, setFiles] = useState<ErrorFile[]>([]);
  const [requestId, setRequestId] = useState("");
  const [log, setLog] = useState<string>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<unknown>();
  const [queue, setQueue] = useState<unknown>();
  const [release, setRelease] = useState<unknown>();
  const [count, setCount] = useState(20);
  const [operation, setOperation] = useState<Operation>();
  const [account, setAccount] = useState("");
  const [request, setRequest] = useState(
    pretty({
      method: "GET",
      url: "https://api.anthropic.com/api/oauth/usage",
      header: {
        Authorization: "Bearer $TOKEN$",
        "anthropic-beta": "oauth-2025-04-20",
      },
    }),
  );
  async function perform(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (err) {
      setError(maskEmails(errorMessage(err)));
    } finally {
      setBusy(false);
    }
  }
  async function loadErrors() {
    const data = await api<{ files: ErrorFile[] }>(
      "/observability/logs/errors",
    );
    setFiles(data.files ?? []);
  }
  useEffect(() => {
    void perform(loadErrors);
  }, []);
  function prepareRequest() {
    try {
      const body = parseObject(request);
      const url = new URL(String(body.url));
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new Error("Use an HTTP(S) URL without embedded credentials.");
      if (!body.method || typeof body.method !== "string")
        throw new Error("A request method is required.");
      if (!account && request.includes("$TOKEN$"))
        throw new Error("Choose the account whose token should be used.");
      delete body.auth_index;
      delete body.authIndex;
      delete body.AuthIndex;
      if (account) body.auth_index = account;
      setOperation({
        title: "Send upstream request",
        description: `${String(body.method).toUpperCase()} ${url.origin}${url.pathname}. ${account && request.includes("$TOKEN$") ? "The selected account token will be sent to this destination." : "This sends the supplied headers and body to this destination."} The response may include sensitive data.`,
        confirm: "Send request",
        run: async () => {
          setResult(await write("/requests/api-call", "POST", body));
        },
      });
    } catch (err) {
      setError(errorMessage(err));
    }
  }
  return (
    <>
      <PageHeading
        eyebrow="Inspect & troubleshoot"
        title="Diagnostics"
        description="Inspect requests, error logs, usage events, and upstream responses."
      />
      {error && (
        <div className="mb-5">
          <ErrorNotice message={error} />
        </div>
      )}
      <div className="grid items-start gap-5 xl:grid-cols-2">
        <section className="surface">
          <SectionTitle
            title="Request logs"
            detail="Read a request by its ID, or inspect a recorded error."
            action={
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void perform(loadErrors)}
              >
                Refresh list
              </Button>
            }
          />
          <div className="space-y-4 p-5">
            <div className="flex gap-2">
              <Input
                aria-label="Request ID"
                placeholder="Request ID"
                value={requestId}
                onChange={(e) => setRequestId(e.target.value)}
              />
              <Button
                disabled={busy || !requestId.trim()}
                onClick={() =>
                  void perform(async () =>
                    setLog(
                      await (
                        await apiResponse(
                          `/observability/logs/requests/${encodeURIComponent(requestId.trim())}`,
                        )
                      ).text(),
                    ),
                  )
                }
              >
                Inspect
              </Button>
            </div>
            <p className="quiet text-xs">
              Enable request logging in Configuration → observability/logs to
              capture successful requests. A request ID without a stored log
              returns not found.
            </p>
            {!files.length ? (
              <p className="quiet text-xs">No error-log files are listed.</p>
            ) : (
              <div className="max-h-72 divide-y overflow-auto">
                {files.map((file) => (
                  <div
                    key={file.name}
                    className="flex items-center justify-between gap-2 py-3"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-mono text-[11px]">
                        {maskEmails(file.name)}
                      </p>
                      <p className="quiet text-[10px]">
                        {file.size.toLocaleString()} bytes ·{" "}
                        {new Date(file.modified * 1000).toLocaleString()}
                      </p>
                    </div>
                    <div className="flex">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          void perform(async () =>
                            setLog(
                              await (
                                await apiResponse(
                                  `/observability/logs/errors/${encodeURIComponent(file.name)}`,
                                )
                              ).text(),
                            ),
                          )
                        }
                      >
                        View
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          void perform(() =>
                            downloadFile(
                              `/observability/logs/errors/${encodeURIComponent(file.name)}`,
                              "proxy-error.log",
                            ),
                          )
                        }
                      >
                        Download
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {log !== undefined && (
              <>
                <DataView value={log} />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => saveFile(log, "proxy-request.log")}
                >
                  Download request log
                </Button>
              </>
            )}
          </div>
        </section>
        <div className="space-y-5">
          <section className="surface">
            <SectionTitle
              title="Usage event queue"
              detail="Read and remove the oldest events from the queue."
            />
            <div className="space-y-4 p-5">
              <p className="quiet text-xs">
                Consuming events removes them for other consumers. Export the
                result if you need a record.
              </p>
              <label className="block space-y-2 text-xs">
                Event count
                <Input
                  type="number"
                  min={1}
                  max={1000}
                  value={count}
                  onChange={(e) => setCount(e.target.valueAsNumber)}
                />
              </label>
              <Button
                variant="outline"
                disabled={!Number.isInteger(count) || count < 1 || count > 1000}
                onClick={() =>
                  setOperation({
                    title: "Consume usage events",
                    description: `Remove up to ${count} oldest usage events from the shared queue and display them here.`,
                    destructive: true,
                    confirm: "Consume events",
                    run: async () => {
                      setQueue(
                        await api(`/observability/usage/queue?count=${count}`),
                      );
                    },
                  })
                }
              >
                Read & consume events
              </Button>
              {queue !== undefined && (
                <>
                  <DataView value={queue} />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => saveFile(pretty(queue), "usage-events.json")}
                  >
                    Export events
                  </Button>
                </>
              )}
            </div>
          </section>
          <section className="surface">
            <SectionTitle
              title="Server release"
              detail="Check available release information without installing anything."
            />
            <div className="space-y-3 p-5">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void perform(async () =>
                    setRelease(await api("/server/latest-version")),
                  )
                }
              >
                Check latest version
              </Button>
              {release !== undefined && <DataView value={release} />}
            </div>
          </section>
        </div>
      </div>
      <section className="surface mt-5">
        <SectionTitle
          title="Upstream request tool"
          detail="Run an explicit authenticated HTTP request through the proxy."
        />
        <div className="space-y-4 p-5">
          <label className="block max-w-lg space-y-2 text-xs">
            Credential
            <select
              className={selectClass}
              value={account}
              onChange={(e) => setAccount(e.target.value)}
            >
              <option value="">No account token</option>
              {credentials
                .filter((c) => c.auth_index)
                .map((c) => (
                  <option key={c.id} value={c.auth_index}>
                    {c.provider} · {maskEmails(c.email || c.name)}
                  </option>
                ))}
            </select>
          </label>
          <label className="block space-y-2 text-xs">
            Request JSON
            <textarea
              spellCheck={false}
              className={editorClass}
              value={request}
              onChange={(e) => setRequest(e.target.value)}
            />
          </label>
          <p className="quiet text-xs">
            Fields: method, url, header, data (string), optional proxy_url.
            $TOKEN$ is resolved by the proxy for the selected account. Requests
            can consume quota or change upstream data.
          </p>
          <Button onClick={prepareRequest}>Review & send</Button>
          {result !== undefined && <DataView value={result} />}
        </div>
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
