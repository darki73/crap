import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  ChevronRight,
  ExternalLink,
  Loader2,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CopyButton, ErrorNotice } from "@/components/shared";
import { api, errorMessage, write } from "@/lib/api";
import {
  oauthProviders,
  parseCallback,
  validateLogin,
  type OAuthLogin,
  type OAuthProvider,
  type OAuthStatus,
} from "@/lib/oauth";

type Session = { provider: OAuthProvider; login: OAuthLogin };
type Phase = "choose" | "starting" | "waiting" | "complete" | "failed";

export function OAuthConnect({
  onSaved,
  onDone,
  providers = oauthProviders,
}: {
  onSaved: (message: string) => Promise<void>;
  onDone: () => void;
  providers?: readonly OAuthProvider[];
}) {
  const [phase, setPhase] = useState<Phase>("choose");
  const [selected, setSelected] = useState<OAuthProvider | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState("");
  const [callback, setCallback] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const mounted = useRef(false);
  const generation = useRef(0);
  const pending = useRef<Session | null>(null);
  const savedCallback = useRef(onSaved);
  savedCallback.current = onSaved;

  const cancelSession = (state: string) =>
    api(`/oauth/session?state=${encodeURIComponent(state)}`, {
      method: "DELETE",
      keepalive: true,
    });
  useEffect(() => {
    mounted.current = true;
    const cancelPending = () => {
      generation.current++;
      const current = pending.current;
      pending.current = null;
      if (current) void cancelSession(current.login.state).catch(() => {});
    };
    window.addEventListener("pagehide", cancelPending);
    return () => {
      mounted.current = false;
      window.removeEventListener("pagehide", cancelPending);
      cancelPending();
    };
  }, []);

  async function start(provider: OAuthProvider) {
    const request = ++generation.current;
    setSelected(provider);
    setPhase("starting");
    setError("");
    setCallback("");
    setSubmitted(false);
    let login: OAuthLogin | undefined;
    try {
      login = await api<OAuthLogin>(
        `/oauth/auth-url?provider=${encodeURIComponent(provider.id)}&is_webui=true`,
      );
      if (!mounted.current || request !== generation.current) {
        if (login.state) await cancelSession(login.state);
        return;
      }
      validateLogin(login);
      const next = { provider, login };
      pending.current = next;
      setSession(next);
      setPhase("waiting");
    } catch (err) {
      if (login?.state) void cancelSession(login.state).catch(() => {});
      if (mounted.current && request === generation.current) {
        setError(errorMessage(err));
        setPhase("failed");
      }
    }
  }

  useEffect(() => {
    if (phase !== "waiting" || !session) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const request = generation.current;
    const poll = async () => {
      try {
        const result = await api<OAuthStatus>(
          `/oauth/status?state=${encodeURIComponent(session.login.state)}`,
        );
        if (stopped || request !== generation.current) return;
        if (result.status === "ok") {
          pending.current = null;
          setError("");
          setCallback("");
          setPhase("complete");
          await savedCallback.current(
            `${session.provider.name} account connected.`,
          );
          return;
        }
        if (result.status === "error") {
          pending.current = null;
          setPhase("failed");
          setError(
            result.error || "Sign-in failed. Start a new session to try again.",
          );
          return;
        }
        if (result.status !== "wait")
          throw new Error("The proxy returned an unexpected sign-in status.");
        setError((previous) =>
          previous.startsWith("Unable to check sign-in:") ? "" : previous,
        );
      } catch (err) {
        if (stopped || request !== generation.current) return;
        setError(
          `Unable to check sign-in: ${errorMessage(err)} Retrying automatically.`,
        );
      }
      if (!stopped) timer = setTimeout(poll, 2000);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [phase, session]);

  async function cancel() {
    generation.current++;
    setCancelling(true);
    setError("");
    try {
      if (pending.current) await cancelSession(pending.current.login.state);
      pending.current = null;
      setSession(null);
      setPhase("choose");
      setSelected(null);
      setCallback("");
    } catch (err) {
      setError(`Could not cancel sign-in: ${errorMessage(err)}`);
      setSession((current) => (current ? { ...current } : null));
    } finally {
      setCancelling(false);
    }
  }

  async function submitCallback(event: FormEvent) {
    event.preventDefault();
    if (!session) return;
    setError("");
    setSubmitting(true);
    const request = generation.current;
    try {
      const payload = parseCallback(
        callback,
        session.login.state,
        session.provider.id,
      );
      await write("/oauth/callback", "POST", payload);
      if (mounted.current && request === generation.current) {
        setSubmitted(true);
        setCallback("");
      }
    } catch (err) {
      if (mounted.current && request === generation.current)
        setError(errorMessage(err));
    } finally {
      if (mounted.current) setSubmitting(false);
    }
  }

  if (phase === "choose")
    return (
      <div className="space-y-4">
        <div className="flex items-start gap-2 rounded-lg border border-primary/15 bg-primary/5 p-3 text-xs leading-relaxed text-muted-foreground">
          <ShieldCheck className="mt-0.5 shrink-0 text-primary" size={16} />
          <span>
            Use an existing account. Sign in on the provider’s website; your
            account’s model access and usage limits still apply.
          </span>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {providers.map((provider) => (
            <button
              key={provider.id}
              aria-label={`Sign in with ${provider.name}`}
              onClick={() => void start(provider)}
              className="group flex items-center gap-3 rounded-lg border bg-background/40 p-3 text-left transition-colors hover:border-primary/40 hover:bg-primary/5"
            >
              <span
                className={`flex size-9 shrink-0 items-center justify-center rounded-lg text-lg font-semibold ${provider.color}`}
              >
                {provider.mark}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-medium">
                  {provider.name}
                </span>
                <span className="mt-1 block text-[10px] leading-relaxed text-muted-foreground">
                  {provider.description}
                </span>
              </span>
              <ChevronRight
                size={13}
                className="shrink-0 text-muted-foreground group-hover:text-primary"
              />
            </button>
          ))}
        </div>
      </div>
    );

  if (phase === "complete")
    return (
      <div className="py-6 text-center">
        <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Check size={26} />
        </div>
        <h3 className="text-lg font-medium">
          {session?.provider.name} is connected
        </h3>
        <p className="quiet mt-2 text-sm">
          The proxy saved your credentials. Your account is ready in Providers.
        </p>
        <Button className="mt-6" onClick={onDone}>
          Done
          <Check size={15} />
        </Button>
      </div>
    );

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 rounded-lg border bg-background/40 p-4">
        <span
          className={`flex size-10 shrink-0 items-center justify-center rounded-xl text-lg font-semibold ${selected?.color}`}
        >
          {selected?.mark}
        </span>
        <div>
          <p className="text-sm font-medium">{selected?.name}</p>
          <p className="quiet mt-1 text-xs">
            {phase === "starting"
              ? "Creating a secure sign-in session…"
              : phase === "failed"
                ? "Sign-in could not be completed"
                : "Complete sign-in in your browser"}
          </p>
        </div>
      </div>
      {error && <ErrorNotice message={error} />}
      {phase === "starting" && (
        <div
          role="status"
          className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground"
        >
          <Loader2 size={16} className="animate-spin" />
          Preparing sign-in…
        </div>
      )}
      {phase === "waiting" && session && (
        <>
          <Button asChild className="w-full">
            <a
              href={session.login.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open {session.provider.name} sign-in
              <ArrowUpRight size={16} />
            </a>
          </Button>
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>Opens the provider in a new tab.</span>
            <CopyButton value={session.login.url} label="Copy sign-in link" />
          </div>
          {session.provider.id === "claude" && (
            <p className="rounded-lg border border-primary/15 bg-primary/5 p-3 text-xs leading-relaxed text-muted-foreground">
              After signing in, paste the callback URL below to finish. The
              callback tab may show a connection error on this local setup.
            </p>
          )}
          {session.login.user_code && (
            <div className="rounded-lg border bg-background p-4">
              <p className="eyebrow mb-2">
                Enter this code on the provider’s website
              </p>
              <div className="flex items-center justify-between gap-2">
                <code className="text-xl tracking-widest text-primary">
                  {session.login.user_code}
                </code>
                <CopyButton value={session.login.user_code} label="Copy code" />
              </div>
            </div>
          )}
          <div
            role="status"
            className="flex items-start gap-3 rounded-lg bg-muted/50 p-3"
          >
            <Loader2
              size={15}
              className="mt-0.5 shrink-0 animate-spin text-primary"
            />
            <div>
              <p className="text-xs">
                {submitted
                  ? "Callback received. Finishing sign-in…"
                  : "Waiting for authorization…"}
              </p>
              <p className="quiet mt-1 text-[11px]">
                This panel updates when the proxy confirms your credentials are
                saved.
              </p>
            </div>
          </div>
          {session.login.flow !== "device" && (
            <details
              className="rounded-lg border p-3"
              open={session.provider.id === "claude" || undefined}
            >
              <summary className="cursor-pointer text-xs font-medium">
                Browser didn’t return? Paste the callback
              </summary>
              <p className="quiet mt-3 text-xs leading-relaxed">
                After signing in, copy the complete URL from the callback tab,
                even if it shows a connection error. You can also paste an
                authorization code shown by the provider.
              </p>
              <form onSubmit={submitCallback} className="mt-3 space-y-3">
                <label className="block text-xs" htmlFor="oauth-callback">
                  Callback URL or authorization code
                </label>
                <Input
                  id="oauth-callback"
                  value={callback}
                  onChange={(event) => setCallback(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="http://localhost:…/callback?code=…&state=…"
                  required
                  disabled={submitted || submitting}
                />
                <Button
                  type="submit"
                  variant="outline"
                  size="sm"
                  disabled={submitted || submitting}
                >
                  {submitting ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : (
                    <ExternalLink size={13} />
                  )}
                  Submit callback
                </Button>
              </form>
            </details>
          )}
          <p className="quiet text-[11px]">
            Keep this dialog open while signing in. Closing it cancels the
            pending session.
          </p>
        </>
      )}
      <div className="flex justify-between border-t pt-4">
        <Button
          variant="ghost"
          size="sm"
          onClick={cancel}
          disabled={cancelling || submitting}
        >
          <ArrowLeft size={14} />
          {cancelling
            ? "Cancelling…"
            : phase === "failed"
              ? "Choose another provider"
              : "Cancel sign-in"}
        </Button>
        {phase === "failed" && selected && (
          <Button size="sm" onClick={() => void start(selected)}>
            Try again
          </Button>
        )}
      </div>
    </div>
  );
}
