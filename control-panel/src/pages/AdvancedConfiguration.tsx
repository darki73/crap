import { useState } from "react";
import { Download, FileCode2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeading, ErrorNotice } from "@/components/shared";
import { apiResponse, APIError, errorMessage } from "@/lib/api";
import {
  OperationDialog,
  editorClass,
  pretty,
  saveFile,
  selectClass,
  type Operation,
} from "@/components/Management";

export function AdvancedConfiguration({
  onSaved,
}: {
  onSaved: (message: string) => Promise<void>;
}) {
  const [section, setSection] = useState("routing");
  const [custom, setCustom] = useState("");
  const [format, setFormat] = useState("json");
  const [loaded, setLoaded] = useState<{
    path: string;
    original: string;
    missing?: boolean;
    format: string;
  }>();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [operation, setOperation] = useState<Operation>();
  function targetPath() {
    if (section === "all")
      return format === "yaml" ? "/config.yaml" : "/admin/config";
    const path = section === "custom" ? custom.trim() : section;
    if (
      !path ||
      path.split("/").some((part) => !part || part === "." || part === "..")
    )
      throw new Error("Enter a configuration path, such as routing/retry.");
    return `/config/${path.split("/").map(encodeURIComponent).join("/")}`;
  }
  async function load() {
    setBusy(true);
    setError("");
    try {
      const path = targetPath();
      const response = await apiResponse(path);
      const value =
        section === "all" && format === "yaml"
          ? await response.text()
          : pretty(await response.json());
      setLoaded({
        path,
        original: value,
        format: section === "all" ? format : "json",
      });
      setText(value);
    } catch (err) {
      if (err instanceof APIError && err.status === 404 && section !== "all") {
        setLoaded({
          path: targetPath(),
          original: "{}",
          missing: true,
          format: "json",
        });
        setText("{}");
      } else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  function save(remove = false) {
    if (!loaded) return;
    setOperation({
      title: remove ? "Remove configuration field" : "Save configuration",
      description: `${remove ? "Remove" : "Replace"} ${decodeURIComponent(loaded.path)}. Changes may affect routing, authentication, or connectivity. JSON lists are replaced in full.`,
      destructive: remove,
      confirm: remove ? "Remove field" : "Save changes",
      run: async () => {
        if (!remove && loaded.format === "json") JSON.parse(text);
        let current: string | undefined;
        try {
          const response = await apiResponse(loaded.path);
          current =
            loaded.format === "yaml"
              ? await response.text()
              : pretty(await response.json());
        } catch (err) {
          if (!(
            err instanceof APIError &&
            err.status === 404 &&
            loaded.missing
          ))
            throw err;
        }
        if (
          loaded.missing ? current !== undefined : current !== loaded.original
        )
          throw new Error(
            "Configuration changed since loading. Reload before saving to avoid overwriting another change.",
          );
        await apiResponse(
          loaded.path,
          remove
            ? { method: "DELETE" }
            : {
                method: "PUT",
                headers: {
                  "Content-Type":
                    loaded.format === "yaml"
                      ? "application/yaml"
                      : "application/json",
                },
                body: text,
              },
        );
        if (remove) {
          setLoaded(undefined);
          setText("");
        } else setLoaded({ ...loaded, original: text, missing: false });
        await onSaved(
          remove ? "Configuration field removed." : "Configuration saved.",
        );
      },
    });
  }
  return (
    <>
      <PageHeading
        eyebrow="Advanced controls"
        title="Proxy Configuration"
        description="Edit provider settings, routing rules, and the complete proxy configuration."
      />
      <div className="surface p-5">
        {loaded?.missing && (
          <p className="mb-4 text-xs text-amber-300">
            This section is not configured yet. Enter its value to create it.
          </p>
        )}
        <p className="mb-5 text-xs text-muted-foreground">
          Configuration can contain API keys and transport secrets. Load only
          the section you need. Full YAML includes secret fields omitted from
          some JSON responses.
        </p>
        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
          <label className="space-y-2 text-xs">
            <span>Section</span>
            <select
              className={selectClass}
              value={section}
              onChange={(e) => setSection(e.target.value)}
            >
              {[
                "routing",
                "requests",
                "multimedia",
                "quota-exceeded",
                "api-keys",
                "upstream",
                "oauth",
                "client",
                "transport",
                "credentials",
                "observability",
                "plugins",
                "access",
                "server",
                "management",
                "models",
                "all",
                "custom",
              ].map((key) => (
                <option key={key} value={key}>
                  {key === "all"
                    ? "Complete configuration"
                    : key === "custom"
                      ? "Custom field path"
                      : key}
                </option>
              ))}
            </select>
          </label>
          {section === "custom" ? (
            <label className="space-y-2 text-xs">
              <span>Field path</span>
              <Input
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                placeholder="routing/retry"
              />
            </label>
          ) : (
            <label className="space-y-2 text-xs">
              <span>Format</span>
              <select
                className={selectClass}
                disabled={section !== "all"}
                value={section === "all" ? format : "json"}
                onChange={(e) => setFormat(e.target.value)}
              >
                <option value="json">JSON</option>
                <option value="yaml">YAML</option>
              </select>
            </label>
          )}
          <Button
            className="self-end"
            disabled={busy || Boolean(loaded && text !== loaded.original)}
            onClick={() => void load()}
          >
            <FileCode2 size={15} />
            {busy ? "Loading…" : "Load configuration"}
          </Button>
        </div>
        {loaded && text !== loaded.original && (
          <p className="mt-3 text-xs text-amber-300">
            Unsaved changes. Save or discard them before loading another
            section.
          </p>
        )}
        {error && (
          <div className="mt-4">
            <ErrorNotice message={error} />
          </div>
        )}
        {loaded && (
          <div className="mt-5 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="font-mono text-xs">
                {decodeURIComponent(loaded.path)}
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  saveFile(text, `cliproxy-config.${loaded.format}`)
                }
              >
                <Download size={13} />
                Export
              </Button>
            </div>
            <label className="block">
              <span className="sr-only">Configuration editor</span>
              <textarea
                spellCheck={false}
                className={`${editorClass} min-h-[440px]`}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            </label>
            <div className="flex flex-wrap justify-end gap-2">
              {loaded.path.startsWith("/config/") && !loaded.missing && (
                <Button
                  variant="ghost"
                  className="mr-auto text-destructive"
                  onClick={() => save(true)}
                >
                  Remove field
                </Button>
              )}
              <Button
                variant="outline"
                onClick={() => setText(loaded.original)}
              >
                Discard edits
              </Button>
              <Button
                disabled={text === loaded.original}
                onClick={() => save()}
              >
                <Save size={14} />
                Review & save
              </Button>
            </div>
          </div>
        )}
      </div>
      {operation && (
        <OperationDialog
          operation={operation}
          onClose={() => setOperation(undefined)}
        />
      )}
    </>
  );
}
