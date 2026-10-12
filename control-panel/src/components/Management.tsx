import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { ErrorNotice } from "@/components/shared";
import { errorMessage, apiResponse } from "@/lib/api";
import { maskEmails } from "@/lib/accounts";

export const editorClass =
  "min-h-60 w-full rounded-lg border bg-background p-3 font-mono text-xs leading-6 outline-none focus:border-primary/50";
export const selectClass =
  "h-10 w-full rounded-md border bg-background px-3 text-sm";
export const pretty = (value: unknown) => JSON.stringify(value, null, 2);
export function parseObject(text: string): Record<string, unknown> {
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Enter a JSON object.");
  return value;
}
export function saveFile(data: Blob | string, filename: string) {
  const url = URL.createObjectURL(
    typeof data === "string" ? new Blob([data], { type: "text/plain" }) : data,
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function downloadFile(path: string, filename: string) {
  saveFile(await (await apiResponse(path)).blob(), filename);
}
export type Operation = {
  title: string;
  description: string;
  initial?: string;
  label?: string;
  destructive?: boolean;
  confirm?: string;
  run: (text: string) => Promise<void>;
};
export function OperationDialog({
  operation,
  onClose,
}: {
  operation: Operation;
  onClose: () => void;
}) {
  const [value, setValue] = useState(operation.initial ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await operation.run(value);
      onClose();
    } catch (err) {
      setError(maskEmails(errorMessage(err)));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        className="max-h-[90dvh] overflow-auto sm:max-w-2xl"
        showCloseButton={!busy}
      >
        <DialogHeader>
          <DialogTitle>{operation.title}</DialogTitle>
          <DialogDescription>{operation.description}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          {error && <ErrorNotice message={error} />}
          {operation.initial !== undefined && (
            <label className="block space-y-2 text-xs">
              <span>{operation.label || "JSON changes"}</span>
              <textarea
                spellCheck={false}
                className={editorClass}
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </label>
          )}
          {operation.destructive && (
            <label className="flex items-start gap-2 text-xs">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
                className="mt-0.5"
              />
              I understand this action cannot be undone from the panel.
            </label>
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button
              variant={operation.destructive ? "destructive" : "default"}
              disabled={busy || (operation.destructive && !acknowledged)}
            >
              {busy ? "Working…" : operation.confirm || "Apply changes"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
export function DataView({ value }: { value: unknown }) {
  return (
    <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-lg border bg-background p-4 font-mono text-[11px] leading-6">
      {maskEmails(typeof value === "string" ? value : pretty(value))}
    </pre>
  );
}
