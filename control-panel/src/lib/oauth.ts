export const oauthProviders = [
  {
    id: "codex",
    name: "ChatGPT / Codex",
    description: "Sign in with your OpenAI account",
    mark: "O",
    color: "bg-emerald-300/10 text-emerald-200",
  },
  {
    id: "claude",
    name: "Claude",
    description: "Connect your Claude Code account",
    mark: "✳",
    color: "bg-orange-300/10 text-orange-200",
  },
  {
    id: "antigravity",
    name: "Antigravity",
    description: "Sign in with your Google account",
    mark: "G",
    color: "bg-blue-300/10 text-blue-200",
  },
  {
    id: "kimi",
    name: "Kimi",
    description: "Kimi.com account · device code",
    mark: "K",
    color: "bg-indigo-300/10 text-indigo-200",
  },
  {
    id: "kimi-ai",
    name: "Kimi.ai",
    description: "Global Kimi account · device code",
    mark: "K",
    color: "bg-violet-300/10 text-violet-200",
  },
  {
    id: "xai",
    name: "xAI / Grok",
    description: "Connect with a device code",
    mark: "x",
    color: "bg-zinc-300/10 text-zinc-200",
  },
  {
    id: "meta",
    name: "Meta",
    description: "Connect with a device code",
    mark: "M",
    color: "bg-sky-300/10 text-sky-200",
  },
  {
    id: "devin",
    name: "Devin",
    description: "Sign in with your Devin account",
    mark: "D",
    color: "bg-amber-300/10 text-amber-200",
  },
] as const;

export type OAuthProvider = {
  id: string;
  name: string;
  description: string;
  mark: string;
  color: string;
};
export type OAuthLogin = {
  status: string;
  state: string;
  url: string;
  flow?: string;
  user_code?: string;
  expires_in?: number;
};
export type OAuthStatus = { status: "wait" | "ok" | "error"; error?: string };

export function validateLogin(login: OAuthLogin): OAuthLogin {
  if (login.status !== "ok" || !login.state?.trim())
    throw new Error("The proxy did not return a valid sign-in session.");
  const url = new URL(login.url);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("The proxy returned an invalid sign-in URL.");
  return login;
}

export function parseCallback(value: string, state: string, provider: string) {
  const raw = value.trim();
  if (!raw)
    throw new Error("Paste the complete callback URL or authorization code.");
  if (/^https?:\/\//i.test(raw)) {
    const url = new URL(raw);
    if (url.searchParams.get("state") !== state)
      throw new Error(
        "This callback belongs to a different sign-in. Use the URL from this session.",
      );
    if (!url.searchParams.get("code") && !url.searchParams.get("error"))
      throw new Error("The callback URL has no authorization code or error.");
    return { provider, state, redirect_url: raw };
  }
  // Claude can display an authorization code suffixed with #state.
  if (!/^[A-Za-z0-9._~+/=-]+(?:#[A-Za-z0-9._~-]+)?$/.test(raw))
    throw new Error(
      "Paste a callback URL or authorization code, without additional text.",
    );
  const [code, embeddedState] = raw.split("#");
  if (embeddedState && embeddedState !== state)
    throw new Error("This code belongs to a different sign-in session.");
  return { provider, state, code };
}
