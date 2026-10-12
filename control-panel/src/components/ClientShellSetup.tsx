import { useState } from "react";
import { Download, Terminal } from "lucide-react";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";
import { CopyButton } from "./shared";
import type { ClientEndpoint } from "@/lib/client-endpoint";
import { write, errorMessage } from "@/lib/api";
import { Input } from "./ui/input";

export function ClientShellSetup({ endpoint }: { endpoint: ClientEndpoint }) {
  const [open, setOpen] = useState(false);
  const [shell, setShell] = useState("powershell");
  const [personalized, setPersonalized] = useState(true);
  const [name, setName] = useState("");
  const [mode, setMode] = useState("proxy");
  const [cleanup, setCleanup] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  async function download() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await write<{
        content: string;
        filename: string;
        expiresAt: number;
      }>("/client-enrollment", "POST", { name, shell, mode, cleanup });
      const url = URL.createObjectURL(
        new Blob([result.content], { type: "text/plain;charset=utf-8" }),
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = result.filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      const revoke = URL.revokeObjectURL.bind(URL);
      setTimeout(() => revoke(url), 1000);
      setNotice(
        `Installer downloaded. Run it before ${new Date(result.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. One use only. If your browser adds a suffix to its filename, use that filename below.`,
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  const windows = shell === "powershell";
  const command = windows
    ? "Unblock-File -LiteralPath .\\crap.ps1\n. .\\crap.ps1 -Install"
    : `source ./crap.sh install ${shell}`;
  const guide = `${window.location.origin}/client-setup/guide.md`;
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Terminal size={14} />
        Set Up the crap Command
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Your clients. One connection menu.</DialogTitle>
            <DialogDescription>
              Install a small shell integration on the computer where you run
              your CLI. No additional application or background service.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-5 text-sm">
            <div className="rounded-lg border bg-primary/5 p-4">
              <p className="font-medium">
                Keep using <code>claude</code>. Use <code>crap</code> to switch
                connections.
              </p>
              <p className="quiet mt-2 text-xs">
                Your existing Claude profile, projects and chat history stay in
                place. Switching applies to new launches.
              </p>
            </div>
            <label className="block space-y-2">
              <span>1. Choose your shell</span>
              <select
                aria-label="Client shell"
                className="h-10 w-full rounded-md border bg-background px-3"
                value={shell}
                onChange={(e) => setShell(e.target.value)}
              >
                <option value="powershell">Windows · PowerShell</option>
                <option value="bash">Linux / macOS · Bash</option>
                <option value="zsh">macOS / Linux · Zsh</option>
              </select>
            </label>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={personalized}
                onChange={(e) => setPersonalized(e.target.checked)}
              />
              Configure this computer automatically
            </label>
            {personalized ? (
              <div className="space-y-3 rounded-lg border p-4">
                <p className="font-medium">
                  2. Prepare this computer’s installer
                </p>
                <label className="block space-y-2">
                  <span>Computer name</span>
                  <Input
                    aria-label="Computer name"
                    placeholder="Work laptop"
                    maxLength={60}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
                <label className="block space-y-2">
                  <span>Start Claude in</span>
                  <select
                    aria-label="Starting connection"
                    className="h-10 w-full rounded-md border bg-background px-3"
                    value={mode}
                    onChange={(e) => setMode(e.target.value)}
                  >
                    <option value="proxy">Proxy mode</option>
                    <option value="direct">
                      Direct mode · proxy ready when needed
                    </option>
                  </select>
                </label>
                <p className="quiet text-xs">
                  {endpoint.origin
                    ? `Proxy: ${endpoint.origin}`
                    : endpoint.detail}
                </p>
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={cleanup}
                    onChange={(e) => setCleanup(e.target.checked)}
                  />
                  Delete the downloaded installer after successful setup
                </label>
                <Button
                  disabled={busy || !name.trim() || !endpoint.origin}
                  onClick={download}
                >
                  <Download size={14} />
                  {busy ? "Preparing…" : "Download configured installer"}
                </Button>
                <p className="quiet text-xs">
                  Includes a one-use setup ticket, valid for 15 minutes.
                  Installation creates a dedicated client key. Provider
                  credentials stay on the server. Review the script before
                  running it. Other computers need Tailscale access; local URLs
                  work only on the proxy machine.
                </p>
                {notice && (
                  <p role="status" className="text-xs text-primary">
                    {notice}
                  </p>
                )}
                {error && (
                  <p role="alert" className="text-xs text-destructive">
                    {error}
                  </p>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                <p>2. Download and review the script</p>
                <a
                  className="inline-flex items-center gap-2 text-primary underline"
                  href={`/client-setup/${windows ? "crap.ps1" : "crap.sh"}`}
                  download
                >
                  <Download size={14} />
                  Download {windows ? "PowerShell" : "Bash / Zsh"} installer
                </a>
                <p className="quiet text-xs">
                  It adds one loader line to your shell profile and keeps a
                  backup. Conflicting aliases are left untouched. No client key
                  is included.
                </p>
              </div>
            )}
            <div className="space-y-2">
              <p>3. Open your terminal in the download folder</p>
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3">
                <code className="whitespace-pre-wrap break-all text-xs">
                  {command}
                </code>
                <CopyButton value={command} label="Copy install command" />
              </div>
              {windows && (
                <p className="quiet text-xs">
                  After review, Unblock-File allows this download under
                  RemoteSigned without changing your execution policy. The
                  leading dot loads the commands into this terminal. AllSigned
                  environments still require a signed script.
                </p>
              )}
              {shell === "bash" && (
                <p className="quiet text-xs">
                  On macOS, your Bash login profile must load .bashrc. Zsh uses
                  .zshrc.
                </p>
              )}
            </div>
            <div className="space-y-2">
              <p>
                4.{" "}
                {personalized ? (
                  "Keep using Claude"
                ) : (
                  <>
                    Run <code>crap</code> and configure Claude
                  </>
                )}
              </p>
              {endpoint.origin ? (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <code className="break-all text-xs">{endpoint.origin}</code>
                  <CopyButton
                    value={endpoint.origin}
                    label="Copy proxy origin"
                  />
                </div>
              ) : (
                <p className="quiet text-xs">
                  {endpoint.detail || "Checking your connection…"}
                </p>
              )}
              {personalized ? (
                <p className="quiet text-xs">
                  The installer saves the URL and your computer’s key, then
                  opens the connection menu. Keep using <code>claude</code>.
                  Manage or revoke this computer in Client API Keys. If
                  installation fails after redeeming the ticket, remove the
                  device there before downloading another installer.
                </p>
              ) : (
                <p className="quiet text-xs">
                  Paste a client API key at the hidden terminal prompt, then
                  choose proxy mode. Use “Check proxy connection” to verify
                  access without sending a query. Tailscale clients must be
                  connected with an allowed login.
                </p>
              )}
            </div>
            <pre className="overflow-x-auto rounded-md border bg-muted/30 p-3 text-xs">{`crap                         # Open the menu\nclaude --continue            # Keep working as usual\ncrap use claude direct       # Original Claude connection\ncrap uninstall               # Remove shell integration`}</pre>
            <p className="quiet text-xs">
              Claude is the first supported adapter. Codex and Gemini are
              detected but not configured yet. Fish, CMD, IDE extensions and
              managed Claude installations are not supported by this release.
            </p>
            <div className="border-t pt-4">
              <p className="mb-2 font-medium">Prefer your agent to help?</p>
              <div className="flex flex-wrap items-center gap-2">
                <a
                  className="text-xs text-primary underline"
                  href={guide}
                  target="_blank"
                  rel="noreferrer"
                >
                  Read the installation guide
                </a>
                <CopyButton
                  label="Copy agent instructions"
                  value={`Help me install the maintained CRAP shell integration using ${guide}. Review the script, preserve existing aliases and Claude history, and let me enter the client key privately in my terminal.`}
                />
              </div>
              <p className="quiet mt-2 text-xs">
                The agent needs access to this dashboard. Open the dashboard
                through Tailscale before copying the link for another computer.
              </p>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
