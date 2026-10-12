import { useEffect, useRef } from "react";
import { Dialog } from "radix-ui";
import { ArrowUpRight, Terminal, X } from "lucide-react";
import { navigation, navigationGroups, type Page } from "@/lib/navigation";

type Props = {
  page: Page;
  connected: boolean;
  accountCount: number;
  mobile: boolean;
  onMobileChange: (open: boolean) => void;
  navigate: (page: Page) => void;
};

function SidebarContent({
  page,
  connected,
  accountCount,
  navigate,
  close,
}: Omit<Props, "mobile" | "onMobileChange"> & { close?: () => void }) {
  return (
    <>
      <div className="flex h-20 shrink-0 items-center justify-between px-5">
        <a
          href="#overview"
          title="Control Room for Agentic Proxy"
          onClick={() => navigate("overview")}
          className="flex items-center gap-3 rounded-md"
        >
          <div className="flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <Terminal size={22} strokeWidth={2.5} />
          </div>
          <div>
            <span className="text-[17px] font-semibold tracking-tight">
              CRAP
            </span>
            <p className="text-[10px] tracking-[.16em] text-muted-foreground">
              CONTROL ROOM
            </p>
          </div>
        </a>
        {close && (
          <button
            type="button"
            aria-label="Close navigation"
            onClick={close}
            className="rounded-md p-2 text-muted-foreground hover:bg-muted"
          >
            <X size={17} />
          </button>
        )}
      </div>
      <div className="mx-4 mb-4 flex shrink-0 items-center gap-3 rounded-lg border bg-[#1a1c1f] px-3 py-2.5">
        <span className="flex size-7 items-center justify-center rounded border bg-muted font-mono text-[11px] text-primary">
          C
        </span>
        <div>
          <p className="text-xs font-medium">Your workspace</p>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            {import.meta.env.DEV ? "Development build" : "Control room"}
          </p>
        </div>
      </div>
      <nav
        className="min-h-0 flex-1 space-y-5 overflow-y-auto px-3 pb-5"
        aria-label="Main navigation"
      >
        {navigationGroups.map((group) => (
          <section key={group} aria-label={group}>
            <h2 className="eyebrow px-3 pb-2">{group}</h2>
            <ul className="space-y-0.5">
              {navigation
                .filter((item) => item.group === group)
                .map(({ id, label, icon: Icon, description }) => (
                  <li key={id}>
                    <a
                      href={`#${id}`}
                      title={description}
                      aria-current={page === id ? "page" : undefined}
                      onClick={() => navigate(id)}
                      className={`flex min-h-9 items-center gap-2.5 rounded-md px-3 py-2 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${page === id ? "nav-active" : "text-muted-foreground hover:bg-white/4 hover:text-foreground"}`}
                    >
                      <Icon size={16} strokeWidth={1.7} className="shrink-0" />
                      <span>{label}</span>
                      {id === "providers" && (
                        <span
                          aria-label={`${accountCount} credentials`}
                          className="ml-auto rounded bg-white/5 px-1.5 py-0.5 font-mono text-[10px]"
                        >
                          {accountCount}
                        </span>
                      )}
                    </a>
                  </li>
                ))}
            </ul>
          </section>
        ))}
      </nav>
      <div className="shrink-0 border-t px-5 py-4">
        <a
          href="https://github.com/router-for-me/CLIProxyAPI"
          target="_blank"
          rel="noreferrer"
          className="mb-3 flex items-center justify-between text-xs text-muted-foreground hover:text-foreground"
        >
          Proxy engine docs <ArrowUpRight size={13} />
        </a>
        <p className="flex items-center gap-2 text-[10px] text-muted-foreground">
          <span
            className={`size-1.5 rounded-full ${connected ? "bg-primary" : "bg-amber-400"}`}
          />
          {connected ? "Proxy connected" : "Proxy disconnected"}
        </p>
      </div>
    </>
  );
}

export function Sidebar(props: Props) {
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 1024px)");
    const resize = () => {
      if (media.matches) props.onMobileChange(false);
    };
    media.addEventListener("change", resize);
    return () => media.removeEventListener("change", resize);
  }, [props.onMobileChange]);
  return (
    <>
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[232px] flex-col border-r bg-[#141517] lg:flex">
        <SidebarContent {...props} />
      </aside>
      <Dialog.Root open={props.mobile} onOpenChange={props.onMobileChange}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
          <Dialog.Content
            aria-describedby={undefined}
            onOpenAutoFocus={() => {
              opener.current = document.activeElement as HTMLElement;
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              opener.current?.focus();
            }}
            className="fixed inset-y-0 left-0 z-50 flex w-[280px] max-w-[90vw] flex-col border-r bg-[#141517] shadow-xl outline-none"
          >
            <Dialog.Title className="sr-only">Navigation</Dialog.Title>
            <SidebarContent
              {...props}
              close={() => props.onMobileChange(false)}
            />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
