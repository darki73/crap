import { useEffect, useState } from "react";
import { Tabs } from "radix-ui";
import {
  Code2,
  RefreshCw,
  Save,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ErrorNotice, PageHeading } from "@/components/shared";
import { ConfigField } from "@/components/ConfigFields";
import { OperationDialog, type Operation } from "@/components/Management";
import { api, APIError, errorMessage, write } from "@/lib/api";
import {
  configSchema,
  configSections,
  fieldLabel,
  orderedFields,
  isCollection,
  isRecord,
  replaceField,
  sameValue,
  type ConfigValue,
} from "@/lib/configuration";
import { AdvancedConfiguration } from "./AdvancedConfiguration";

async function readSection(
  section: string,
): Promise<Record<string, ConfigValue>> {
  try {
    const value = await api<ConfigValue>(`/config/${section}`);
    if (value === null) return {};
    if (!isRecord(value))
      throw new Error(
        "This section is not an object. Use the advanced editor to inspect it.",
      );
    return value;
  } catch (error) {
    if (error instanceof APIError && error.status === 404) return {};
    throw error;
  }
}

export function Configuration({
  onSaved,
}: {
  onSaved: (message: string) => Promise<void>;
}) {
  const [advanced, setAdvanced] = useState(false);
  const [section, setSection] = useState("routing");
  const [original, setOriginal] = useState<Record<string, ConfigValue>>();
  const [draft, setDraft] = useState<Record<string, ConfigValue>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [operation, setOperation] = useState<Operation>();
  const dirty = original !== undefined && !sameValue(original, draft);
  const info = configSections.find(([key]) => key === section)!;
  const properties = configSchema.properties![section].properties!;
  const visibleKeys = orderedFields([
    ...Object.keys(properties),
    ...Object.keys(draft).filter((key) => !Object.hasOwn(properties, key)),
  ]).filter((key) =>
    `${key} ${JSON.stringify(properties[key])}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );

  useEffect(() => {
    if (advanced) return;
    let cancelled = false;
    setBusy(true);
    setError("");
    setOriginal(undefined);
    readSection(section)
      .then((value) => {
        if (!cancelled) {
          setOriginal(value);
          setDraft(value);
        }
      })
      .catch((error) => {
        if (!cancelled) setError(errorMessage(error));
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [section, advanced]);

  async function reload() {
    setBusy(true);
    setError("");
    try {
      const value = await readSection(section);
      setOriginal(value);
      setDraft(value);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  function review() {
    const changed = [
      ...new Set([...Object.keys(original || {}), ...Object.keys(draft)]),
    ].filter((key) => !sameValue(original?.[key], draft[key]));
    setOperation({
      title: `Save ${info[1].toLowerCase()}`,
      description: `Update ${changed.map(fieldLabel).join(", ")}. ${["server", "management", "access"].includes(section) ? "These settings can change access or connectivity. Listener changes require restarting the server." : "Unedited values and settings outside this section are preserved."}`,
      confirm: "Save changes",
      run: async () => {
        const latest = await readSection(section);
        if (!sameValue(latest, original))
          throw new Error(
            "Configuration changed since loading. Discard edits and reload before saving to avoid overwriting another change.",
          );
        await write(`/config/${section}`, "PUT", draft);
        setOriginal(draft);
        await onSaved(`${info[1]} configuration saved.`);
      },
    });
  }

  return (
    <>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div
          className="inline-flex rounded-lg border bg-card p-1"
          aria-label="Configuration mode"
        >
          <Button
            size="sm"
            variant={!advanced ? "secondary" : "ghost"}
            aria-pressed={!advanced}
            onClick={() => setAdvanced(false)}
          >
            <SlidersHorizontal size={14} />
            Settings
          </Button>
          <Button
            size="sm"
            variant={advanced ? "secondary" : "ghost"}
            aria-pressed={advanced}
            disabled={dirty || busy}
            onClick={() => setAdvanced(true)}
          >
            <Code2 size={14} />
            Advanced editor
          </Button>
        </div>
        {!advanced && (
          <span className="text-xs text-muted-foreground">
            Defaults included · Changes stay local until saved
          </span>
        )}
      </div>
      <div hidden={!advanced}>
        <AdvancedConfiguration onSaved={onSaved} />
      </div>
      {!advanced && (
        <>
          <PageHeading
            eyebrow="Your proxy, configured"
            title="Proxy Configuration"
            description="Proxy engine settings, logging and server options. Strict routing policy is managed in Routing & Affinity."
          />
          {section === "routing" && (
            <p className="mb-5 rounded-lg border bg-card p-4 text-sm text-muted-foreground">
              These are CLIProxy’s built-in routing and retry settings. Manage
              the custom selection policy in{" "}
              <a
                href="#affinity"
                className="text-primary underline underline-offset-4"
              >
                Routing & Affinity
              </a>
              .
            </p>
          )}
          <Tabs.Root
            value={section}
            onValueChange={(value) => {
              setSection(value);
              setSearch("");
            }}
            orientation="vertical"
            className="grid items-start gap-5 lg:grid-cols-[200px_minmax(0,1fr)]"
          >
            <Tabs.List
              aria-label="Configuration sections"
              className="surface flex gap-1 overflow-auto p-2 lg:flex-col"
            >
              {configSections.map(([key, title]) => (
                <Tabs.Trigger
                  key={key}
                  value={key}
                  disabled={dirty || busy}
                  className="shrink-0 rounded-md px-3 py-2.5 text-left text-xs text-muted-foreground outline-none transition hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50 data-[state=active]:bg-primary/10 data-[state=active]:text-primary"
                >
                  {title}
                </Tabs.Trigger>
              ))}
            </Tabs.List>
            <Tabs.Content value={section} className="min-w-0 outline-none">
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  review();
                }}
                className="space-y-4"
              >
                <div className="surface p-5">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <h2 className="text-lg font-semibold">{info[1]}</h2>
                      <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
                        {info[2]}
                      </p>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={dirty || busy}
                      onClick={() => void reload()}
                    >
                      <RefreshCw size={13} />
                      Reload
                    </Button>
                  </div>
                  <div className="relative mt-4">
                    <Search
                      size={14}
                      className="absolute left-3 top-3 text-muted-foreground"
                    />
                    <Input
                      aria-label="Filter settings"
                      className="pl-9"
                      placeholder="Find a setting in this section…"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                    />
                  </div>
                </div>
                {error && <ErrorNotice message={error} />}
                {busy ? (
                  <div className="surface p-8 text-sm text-muted-foreground">
                    Loading settings…
                  </div>
                ) : (
                  original && (
                    <>
                      <div className="grid gap-4 xl:grid-cols-2">
                        {visibleKeys.map((key) => (
                          <div
                            key={`${section}.${key}`}
                            className={
                              isCollection(properties[key])
                                ? "col-span-full"
                                : "min-w-0"
                            }
                          >
                            <ConfigField
                              key={`${section}.${key}`}
                              path={`${section}.${key}`}
                              label={fieldLabel(key)}
                              schema={properties[key] || { kind: "any" }}
                              value={draft[key]}
                              onChange={(value) =>
                                setDraft((previous) =>
                                  replaceField(previous, key, value),
                                )
                              }
                            />
                          </div>
                        ))}
                      </div>
                      {visibleKeys.length === 0 && (
                        <p className="p-5 text-sm text-muted-foreground">
                          No matching settings in this section.
                        </p>
                      )}
                      <div className="sticky bottom-3 z-10 flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card/95 p-4 shadow-xl backdrop-blur">
                        <p
                          role="status"
                          className={`text-xs ${dirty ? "text-primary" : "text-muted-foreground"}`}
                        >
                          {dirty
                            ? "Unsaved changes · Save or discard before switching sections"
                            : "Up to date · Unconfigured fields use defaults"}
                        </p>
                        <div className="flex gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            disabled={!dirty}
                            onClick={() => setDraft(original)}
                          >
                            Discard edits
                          </Button>
                          <Button type="submit" disabled={!dirty}>
                            <Save size={14} />
                            Review & save
                          </Button>
                        </div>
                      </div>
                    </>
                  )
                )}
              </form>
            </Tabs.Content>
          </Tabs.Root>
        </>
      )}
      {operation && (
        <OperationDialog
          operation={operation}
          onClose={() => setOperation(undefined)}
        />
      )}
    </>
  );
}
