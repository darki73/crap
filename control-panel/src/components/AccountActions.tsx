import { useState } from "react";
import { Button } from "@/components/ui/button";
import { api, write, type Credential } from "@/lib/api";
import { maskEmails } from "@/lib/accounts";
import {
  OperationDialog,
  downloadFile,
  parseObject,
  pretty,
  type Operation,
} from "@/components/Management";

export function AccountActions({
  credential,
  onSaved,
}: {
  credential: Credential;
  onSaved: (message: string) => Promise<void>;
}) {
  const [operation, setOperation] = useState<Operation>();
  const label = maskEmails(credential.email || credential.name);
  const target = { name: credential.name, auth_index: credential.auth_index };
  const perform = (
    title: string,
    description: string,
    action: () => Promise<unknown>,
    destructive = false,
  ) =>
    setOperation({
      title,
      description,
      destructive,
      confirm: title,
      run: async () => {
        await action();
        await onSaved(`${title} completed.`);
      },
    });
  return (
    <div className="border-t px-5 py-3">
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            perform(
              credential.disabled ? "Enable account" : "Disable account",
              `${label} will ${credential.disabled ? "resume" : "stop"} receiving routed requests.`,
              () =>
                write("/credentials/status", "PATCH", {
                  ...target,
                  disabled: !credential.disabled,
                }),
            )
          }
        >
          {credential.disabled ? "Enable" : "Disable"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            perform(
              "Refresh credential",
              `Ask the provider to refresh the saved token for ${label}.`,
              () => write("/credentials/refresh", "POST", target),
            )
          }
        >
          Refresh token
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!credential.auth_index}
          onClick={() =>
            perform(
              "Clear cooldown",
              `Clear local routing cooldown for ${label}. This does not reset the provider’s usage allowance.`,
              () =>
                write("/routing/cooldown/reset", "POST", {
                  auth_index: credential.auth_index,
                }),
            )
          }
        >
          Clear cooldown
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            setOperation({
              title: "Edit account fields",
              description: `Patch fields for ${label}. Only supplied fields change. Use null to remove an override.`,
              initial: "{}",
              run: async (text) => {
                const patch = parseObject(text);
                if ("name" in patch || "auth_index" in patch)
                  throw new Error("Account identity cannot be changed here.");
                await write("/credentials/fields", "PATCH", {
                  ...patch,
                  name: credential.name,
                });
                await onSaved("Account fields updated.");
              },
            })
          }
        >
          Edit fields
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={credential.runtime_only}
          onClick={() =>
            setOperation({
              title: "Export credential",
              description: `Download the full credential for ${label}. The JSON contains the unmasked identity and secret tokens.`,
              confirm: "Download credential",
              run: async () =>
                downloadFile(
                  `/credentials/download?name=${encodeURIComponent(credential.name)}`,
                  "credential-backup.json",
                ),
            })
          }
        >
          Export
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive"
          disabled={credential.runtime_only}
          onClick={() =>
            perform(
              "Delete credential",
              `Permanently remove the saved credential for ${label}. You will need to sign in again or import a backup.`,
              () =>
                api(
                  `/credentials?name=${encodeURIComponent(credential.name)}`,
                  { method: "DELETE" },
                ),
              true,
            )
          }
        >
          Delete
        </Button>
      </div>
      {operation && (
        <OperationDialog
          operation={operation}
          onClose={() => setOperation(undefined)}
        />
      )}
    </div>
  );
}
