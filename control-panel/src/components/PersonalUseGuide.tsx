import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ShieldCheck,
  Terminal,
} from "lucide-react";
import { Button } from "@/components/ui/button";

export const PERSONAL_USE_GUIDE_KEY = "crap.personal-use-guide";
export const PERSONAL_USE_GUIDE_VERSION = "3";

export function hasReadPersonalUseGuide() {
  try {
    return (
      localStorage.getItem(PERSONAL_USE_GUIDE_KEY) ===
      PERSONAL_USE_GUIDE_VERSION
    );
  } catch {
    return false;
  }
}

export function rememberPersonalUseGuide() {
  try {
    localStorage.setItem(PERSONAL_USE_GUIDE_KEY, PERSONAL_USE_GUIDE_VERSION);
  } catch {
    // Reading the guide still works when browser storage is unavailable.
  }
}

const chapters = [
  {
    label: "The purpose",
    title: "Your accounts. Your workspace.",
    intro:
      "A personal control room for the AI accounts you already own. Less manual switching, more visibility into how you use them.",
    sections: [
      {
        title: "Why CRAP exists",
        text: "If you use more than one of your own accounts, repeatedly changing logins, endpoints and client settings gets in the way. CRAP brings those connections into one workspace so your tools can use the proxy while you manage your accounts, routing and usage in one place.",
      },
      {
        title: "One operator, their own accounts",
        text: "The person running this workspace should also be the person who owns and uses every account connected to it. Connect your own subscriptions or API credentials for your own use. Having access to someone else’s login, a shared subscription or an account bought from a reseller does not make it your personal account.",
      },
      {
        title: "When it is useful",
        text: "Use it when you want to move between your own accounts without repeatedly reconfiguring a client, keep a conversation on a suitable account where possible, or understand which accounts and models handled your requests. You can also reach your workspace privately from your own devices.",
      },
    ],
    note: "The project’s position is explicit: CRAP is for personal use. We do not condone reselling accounts, subscriptions or access to them.",
  },
  {
    label: "The boundaries",
    title: "Personal access stays personal.",
    intro:
      "A proxy changes how your tools connect. It does not change who an account belongs to or give you permission to redistribute its access.",
    sections: [
      {
        title: "No resale, rental or paid access",
        text: "Do not sell or rent accounts, OAuth sessions, subscription access, proxy API keys or portions of your quota. Do not use your subscriptions behind a paid inference endpoint, a reseller service or a service that sells other people access to your accounts. Calling that access credits, seats or a shared pool does not change the intent.",
      },
      {
        title: "No account sharing or pooled subscriptions",
        text: "This workspace is not intended to give friends, customers, a team or the public access to your subscriptions, whether money changes hands or not. Do not connect borrowed, purchased-from-others, shared or stolen credentials, or collect other people’s subscriptions into a common pool.",
      },
      {
        title: "Personal use can still breach provider terms",
        text: "Using subscription credentials through a third-party proxy such as CRAP may violate a provider’s terms or authentication rules, even when every account is yours, you pay for each subscription and nobody else uses it. A successful login or a working request does not establish permission. Providers may restrict or suspend access; CRAP cannot guarantee that your account will remain available.",
      },
      {
        title: "Our intended use is not provider approval",
        text: "The personal-use and no-resale boundaries are this project’s position. They are not a claim that subscription proxying or account rotation complies with provider rules, and they do not create an exception to those rules. Subscription sign-in and API-key access can have different permissions. Where a provider prohibits this access method, owning the account does not remove that prohibition. CRAP does not grant permission, prevent enforcement or endorse evading restrictions.",
      },
      {
        title: "Account enforcement is your risk",
        text: "You use CRAP’s subscription integrations at your own risk. To the extent permitted by applicable law, CRAP and its developers accept no responsibility for account bans, suspensions, restrictions or loss of access imposed by a provider as a result of using CRAP. Decisions about account enforcement belong to the provider; CRAP and its developers cannot guarantee prevention or reversal of those decisions.",
      },
    ],
    note: "If your goal is to distribute or monetize subscription access for other people, this is not the intended use of CRAP.",
  },
  {
    label: "The workflow",
    title: "Know what happens to a request.",
    intro:
      "Your client sends a request to the proxy, an account handles it, and the control room helps you see the result. Start with a small request before moving a long conversation.",
    sections: [
      {
        title: "01 · Set up your workspace",
        text: "Start in Setup & Integrations to connect the services and configure storage. In Accounts & Providers, connect only your own subscriptions or API credentials. Keep backups and the credentials needed to restore them private; they can contain account access material.",
      },
      {
        title: "02 · Connect your own client",
        text: "Use Client API Keys for your own tools and devices. The client setup helper can configure supported clients to use your proxy. Check the selected endpoint and mode before starting work, especially when switching between direct provider access and the proxy. Treat every proxy key as a secret, not an invitation link.",
      },
      {
        title: "03 · Choose routing deliberately",
        text: "Review Routing & Affinity before enabling live routing. Shadow mode records proposed decisions while the proxy’s existing selection still applies; live mode applies the affinity router’s decisions. Affinity tries to preserve account continuity while considering capacity. It cannot guarantee cache hits, unlimited capacity or an uninterrupted conversation.",
      },
      {
        title: "04 · Read quotas and tokens together",
        text: "Quota & Limits shows reported subscription windows and their freshness. Token Ledger records reported tokens, cache usage and price estimates. A long conversation can send a large prompt again; cache reads and new processing are different categories. A catalog-based estimate is not your subscription bill, and missing usage data must not be treated as zero usage.",
      },
      {
        title: "05 · Investigate instead of forcing retries",
        text: "If a request fails, check the routing decision, account availability, quota freshness and Logs. A stale observation is not proof of unused capacity. If no eligible account can handle the request, wait for a reset or resolve the underlying connection issue; repeated retries do not create headroom.",
      },
    ],
    note: "Routing can reduce manual switching. It cannot promise that every request will succeed or that every provider will report complete usage information.",
  },
  {
    label: "Your responsibility",
    title: "Keep the door yours to open.",
    intro:
      "Run the workspace for yourself, protect the accounts behind it, and understand what you are making reachable.",
    sections: [
      {
        title: "Private access, including away from home",
        text: "Use Tailscale for private access from your own authorized devices, and check who can reach the service in your tailnet. A private network is not automatically a single-person network. Keep the dashboard, management endpoints and client keys away from public or shared access. Do not publish them as an open proxy.",
      },
      {
        title: "Notifications and data deserve care too",
        text: "Pair Telegram with your own private chat. Notifications may reveal account status and usage, and dashboard links must point to an address you can reach privately. Masked emails in the UI do not mean the underlying credentials, database, exports or logs are anonymized. Secure those separately.",
      },
      {
        title: "Stay in control over time",
        text: "Remove accounts you no longer own or use, revoke exposed keys, review remote access and protect database backups. Before migrating the workspace, decide where its secrets will live and who can access the destination. Moving the deployment does not change these personal-use boundaries.",
      },
    ],
    note: "This acknowledgement is a reminder of the project’s intended use, not identity verification, access control or a grant of permission from a provider.",
  },
];

export function PersonalUseGuide({
  returning = false,
  onComplete,
}: {
  returning?: boolean;
  onComplete: () => void;
}) {
  const [step, setStep] = useState(0);
  const [ownsAccounts, setOwnsAccounts] = useState(false);
  const [personalOnly, setPersonalOnly] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const chapter = chapters[step];
  const last = step === chapters.length - 1;

  useEffect(() => {
    document.title = "Personal Use Guide · CRAP";
    heading.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }, [step]);

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b px-6 py-5 sm:px-10">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              <Terminal size={24} />
            </span>
            <div>
              <p className="text-lg font-semibold tracking-tight">CRAP</p>
              <p className="eyebrow">Personal Use Guide</p>
            </div>
          </div>
          {returning ? (
            <Button variant="outline" onClick={onComplete}>
              Back to workspace
            </Button>
          ) : (
            <span className="text-xs text-muted-foreground">
              Before you begin
            </span>
          )}
        </div>
      </header>
      <main className="mx-auto grid max-w-6xl gap-8 px-6 py-8 sm:px-10 sm:py-12 lg:grid-cols-[240px_minmax(0,1fr)] lg:gap-16">
        <aside>
          <div className="lg:sticky lg:top-10">
            <p className="eyebrow mb-4">A few things to know</p>
            <ol
              aria-label="Guide chapters"
              className="grid grid-cols-2 gap-2 lg:grid-cols-1 lg:gap-3"
            >
              {chapters.map((item, index) => (
                <li
                  key={item.label}
                  aria-current={step === index ? "step" : undefined}
                  className={`flex items-center gap-3 rounded-lg p-3 text-xs ${step === index ? "bg-primary/8 text-primary" : "text-muted-foreground"}`}
                >
                  <span
                    className={`flex size-6 shrink-0 items-center justify-center rounded-full border font-mono text-[10px] ${step === index ? "border-primary/40" : "border-border"}`}
                  >
                    {index < step ? <Check size={12} /> : `0${index + 1}`}
                  </span>
                  {item.label}
                </li>
              ))}
            </ol>
            <p className="mt-6 hidden text-xs leading-relaxed text-muted-foreground lg:block">
              Own your accounts.
              <br />
              Keep your access private.
              <br />
              Use the workspace for yourself.
            </p>
          </div>
        </aside>
        <div className="min-w-0">
          <p className="eyebrow mb-3">
            {step + 1} / {chapters.length} · {chapter.label}
          </p>
          <h1
            ref={heading}
            tabIndex={-1}
            className="text-3xl font-semibold tracking-tight outline-none sm:text-4xl"
          >
            {chapter.title}
          </h1>
          <p className="mt-4 max-w-2xl text-base leading-relaxed text-muted-foreground">
            {chapter.intro}
          </p>
          <div className="mt-8 divide-y rounded-xl border bg-card px-5 sm:px-7">
            {chapter.sections.map((section) => (
              <section key={section.title} className="py-5">
                <h2 className="font-semibold">{section.title}</h2>
                <p className="mt-2 text-sm leading-7 text-muted-foreground">
                  {section.text}
                </p>
              </section>
            ))}
          </div>
          <div className="mt-5 flex items-start gap-3 rounded-lg border border-primary/20 bg-primary/5 p-4 text-sm leading-relaxed">
            <ShieldCheck size={19} className="mt-0.5 shrink-0 text-primary" />
            <p>{chapter.note}</p>
          </div>
          {last && !returning && (
            <fieldset className="mt-7 space-y-4">
              <legend className="mb-4 font-semibold">
                Before entering the workspace
              </legend>
              <label className="flex cursor-pointer items-start gap-3 text-sm leading-relaxed">
                <input
                  type="checkbox"
                  className="mt-1 size-4 shrink-0 accent-primary"
                  checked={ownsAccounts}
                  onChange={(event) => setOwnsAccounts(event.target.checked)}
                />
                <span>
                  I will connect only accounts I personally own and use. I
                  understand that subscription proxying may still violate
                  provider rules and put my account access at risk, even for
                  personal use. I understand that, to the extent permitted by
                  applicable law, CRAP and its developers accept no
                  responsibility for resulting provider-imposed bans,
                  suspensions, restrictions or loss of access.
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-3 text-sm leading-relaxed">
                <input
                  type="checkbox"
                  className="mt-1 size-4 shrink-0 accent-primary"
                  checked={personalOnly}
                  onChange={(event) => setPersonalOnly(event.target.checked)}
                />
                <span>
                  I understand CRAP is for my personal use. I will not resell,
                  rent, share or provide other people access to these accounts,
                  subscriptions or their quota through this workspace.
                </span>
              </label>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Remembered only in this browser. Clearing browser data or an
                update to this guide will show it again. If browser storage is
                unavailable, it will reappear next time. You can reopen it from
                Personal Use Guide in the dashboard footer.
              </p>
            </fieldset>
          )}
          <div className="mt-8 flex items-center justify-between gap-3 border-t pt-6">
            <Button
              variant="ghost"
              disabled={step === 0}
              onClick={() => setStep(step - 1)}
            >
              <ArrowLeft />
              Back
            </Button>
            {last ? (
              <Button
                disabled={!returning && (!ownsAccounts || !personalOnly)}
                onClick={onComplete}
              >
                {returning ? "Back to workspace" : "Enter my workspace"}
                <ArrowRight />
              </Button>
            ) : (
              <Button onClick={() => setStep(step + 1)}>
                Continue
                <ArrowRight />
              </Button>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
