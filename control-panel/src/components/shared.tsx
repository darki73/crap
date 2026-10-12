import { useState, type ReactNode } from "react";
import {
  Check,
  Copy,
  Loader2,
  AlertCircle,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { maskEmails } from "@/lib/accounts";

export function PageHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
      <div>
        <p className="eyebrow mb-2">{eyebrow}</p>
        <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
        <p className="quiet mt-2 text-sm">{description}</p>
      </div>
      {action}
    </div>
  );
}
export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
}: {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      <div className="mb-5 flex size-14 items-center justify-center rounded-2xl border bg-muted/40 text-muted-foreground">
        <Icon size={24} strokeWidth={1.4} />
      </div>
      <h3 className="text-base font-medium">{title}</h3>
      <p className="quiet mt-2 max-w-md text-sm leading-relaxed">{children}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
export function ErrorNotice({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-lg border border-red-400/20 bg-red-400/5 p-4 text-sm text-red-300"
    >
      <AlertCircle size={17} className="mt-0.5 shrink-0" />
      {maskEmails(message)}
    </div>
  );
}
export function Pending({ children = "Loading…" }: { children?: ReactNode }) {
  return (
    <div
      role="status"
      className="quiet flex items-center justify-center gap-2 py-12"
    >
      <Loader2 size={17} className="animate-spin" />
      {children}
    </div>
  );
}
export function CopyButton({
  value,
  label = "Copy",
}: {
  value: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setError(false);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setError(true);
    }
  }
  return (
    <Button variant="ghost" size="sm" aria-label={label} onClick={copy}>
      {copied ? <Check size={14} /> : <Copy size={14} />}
      {error ? "Copy failed" : copied ? "Copied" : label}
    </Button>
  );
}
export function SectionTitle({
  title,
  detail,
  action,
}: {
  title: string;
  detail?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b px-5 py-4">
      <div>
        <h2 className="font-medium">{title}</h2>
        {detail && <p className="quiet mt-1 text-xs">{detail}</p>}
      </div>
      {action}
    </div>
  );
}
