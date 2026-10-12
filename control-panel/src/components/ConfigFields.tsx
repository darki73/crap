import { useId, useState } from "react";
import { ChevronDown, Plus, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { selectClass } from "@/components/Management";
import {
  fieldLabel,
  orderedFields,
  isCollection,
  isRecord,
  readOnlyField,
  replaceField,
  secretField,
  type ConfigValue,
  type FormSchema,
} from "@/lib/configuration";

type Props = {
  schema: FormSchema;
  value: ConfigValue | undefined;
  onChange: (value: ConfigValue | undefined) => void;
  path: string;
  label: string;
  depth?: number;
  disabled?: boolean;
};
const empty = (schema: FormSchema): ConfigValue =>
  schema.kind === "object"
    ? {}
    : schema.kind === "array"
      ? []
      : (schema.default ??
        (schema.kind === "number"
          ? 0
          : schema.kind === "boolean"
            ? false
            : ""));

export function ConfigField({
  schema,
  value,
  onChange,
  path,
  label,
  depth = 0,
  disabled = false,
}: Props) {
  const id = useId();
  const [newKey, setNewKey] = useState("");
  const [keyError, setKeyError] = useState("");
  const locked = disabled || readOnlyField(path);
  const current =
    schema.kind === "any" && value === null ? null : (value ?? schema.default);
  const inferred =
    current === null
      ? "null"
      : Array.isArray(current)
        ? "array"
        : isRecord(current)
          ? "object"
          : typeof current;
  const kind =
    schema.kind === "any"
      ? current === undefined
        ? "string"
        : inferred
      : schema.kind;
  const collection = kind === "object" || kind === "array";
  const description = schema.description?.replace(/^\w+\s+/, "");
  const inherited = value === undefined || value === null;
  const defaultText =
    schema.default === null || schema.default === undefined
      ? "Automatic / inherited"
      : schema.default === ""
        ? "Empty (automatic where supported)"
        : typeof schema.default === "boolean"
          ? schema.default
            ? "On"
            : "Off"
          : Array.isArray(schema.default)
            ? `${schema.default.length} entries`
            : String(schema.default);
  const reset = !locked && value !== undefined && (
    <button
      type="button"
      title={`Use default for ${label}`}
      aria-label={`Use default for ${path}`}
      className="text-muted-foreground hover:text-primary"
      onClick={() => onChange(undefined)}
    >
      <RotateCcw size={13} />
    </button>
  );
  const typePicker = schema.kind === "any" && (
    <select
      aria-label={`Value type for ${path}`}
      className={`${selectClass} max-w-40`}
      disabled={locked}
      value={kind}
      onChange={(event) => {
        const initial: Record<string, ConfigValue> = {
          string: "",
          number: 0,
          boolean: false,
          object: {},
          array: [],
          null: null,
        };
        onChange(initial[event.target.value]);
      }}
    >
      {["string", "number", "boolean", "object", "array", "null"].map(
        (type) => (
          <option key={type}>{type}</option>
        ),
      )}
    </select>
  );

  if (collection) {
    const object = isRecord(current) ? current : {};
    const items = Array.isArray(current) ? current : [];
    const properties = schema.properties || {};
    const extraKeys = Object.keys(object).filter(
      (key) => !Object.hasOwn(properties, key),
    );
    const additional =
      schema.additional ||
      (schema.kind === "any" ? { kind: "any" } : undefined);
    return (
      <details
        className={
          depth === 0
            ? "surface overflow-hidden"
            : "rounded-lg border bg-background/30"
        }
        open={depth === 0 ? true : undefined}
      >
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-4 [&::-webkit-details-marker]:hidden">
          <span>
            <span className="block text-sm font-medium">{label}</span>
            <span className="mt-1 block text-[11px] text-muted-foreground">
              {kind === "array"
                ? `${items.length} entries`
                : `${Object.keys(properties).length + extraKeys.length} fields`}
              {inherited ? " · Default" : " · Configured"}
            </span>
          </span>
          <ChevronDown size={15} className="shrink-0 text-muted-foreground" />
        </summary>
        <div className="space-y-4 border-t p-4">
          {description && (
            <p className="max-w-3xl text-xs leading-relaxed text-muted-foreground">
              {description}
            </p>
          )}
          <div className="flex items-center gap-3">
            {typePicker}
            {reset}
          </div>
          {kind === "object" ? (
            <>
              <div
                className={`grid min-w-0 gap-4 ${depth < 2 ? "xl:grid-cols-2" : ""}`}
              >
                {orderedFields([...Object.keys(properties), ...extraKeys]).map(
                  (key) => (
                    <div
                      key={key}
                      className={`min-w-0 ${isCollection(properties[key] || additional) ? "col-span-full" : ""}`}
                    >
                      <ConfigField
                        schema={
                          properties[key] || additional || { kind: "any" }
                        }
                        path={`${path}.${key}`}
                        label={fieldLabel(key)}
                        value={object[key]}
                        depth={depth + 1}
                        disabled={locked}
                        onChange={(next) =>
                          onChange(replaceField(object, key, next))
                        }
                      />
                    </div>
                  ),
                )}
              </div>
              {additional && !locked && (
                <div className="space-y-2">
                  <div className="flex gap-2">
                    <Input
                      aria-label={`New entry name for ${path}`}
                      placeholder={
                        path.includes("params")
                          ? "Parameter path"
                          : "New entry name"
                      }
                      value={newKey}
                      onChange={(event) => setNewKey(event.target.value)}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        const key = newKey.trim();
                        if (
                          !key ||
                          ["__proto__", "prototype", "constructor"].includes(
                            key,
                          ) ||
                          Object.hasOwn(object, key) ||
                          Object.hasOwn(properties, key)
                        ) {
                          setKeyError("Enter a unique entry name.");
                          return;
                        }
                        onChange(replaceField(object, key, empty(additional)));
                        setNewKey("");
                        setKeyError("");
                      }}
                    >
                      <Plus size={14} />
                      Add entry
                    </Button>
                  </div>
                  {keyError && (
                    <p role="alert" className="text-xs text-destructive">
                      {keyError}
                    </p>
                  )}
                </div>
              )}
            </>
          ) : (
            <>
              {items.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  No entries. Add one to configure this list.
                </p>
              )}
              {items.map((item, index) => (
                <div key={index} className="flex min-w-0 items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <ConfigField
                      schema={schema.item || { kind: "any" }}
                      value={item}
                      path={`${path}.${index}`}
                      label={`Entry ${index + 1}`}
                      depth={depth + 1}
                      disabled={locked}
                      onChange={(next) =>
                        onChange(
                          items.map((previous, i) =>
                            i === index
                              ? next === undefined
                                ? empty(schema.item || { kind: "any" })
                                : next
                              : previous,
                          ),
                        )
                      }
                    />
                  </div>
                  {!locked && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove ${path} entry ${index + 1}`}
                      onClick={() =>
                        onChange(items.filter((_, i) => i !== index))
                      }
                    >
                      <Trash2 size={14} />
                    </Button>
                  )}
                </div>
              ))}
              {!locked && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    onChange([...items, empty(schema.item || { kind: "any" })])
                  }
                >
                  <Plus size={14} />
                  Add {label.toLowerCase()} entry
                </Button>
              )}
            </>
          )}
        </div>
      </details>
    );
  }

  return (
    <div className="min-w-0 rounded-lg border bg-background/20 p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        <div className="flex shrink-0 items-center gap-2">
          <span
            className={`text-[10px] uppercase tracking-wide ${inherited ? "text-muted-foreground" : "text-primary"}`}
          >
            {readOnlyField(path)
              ? "Managed"
              : inherited
                ? "Default"
                : "Configured"}
          </span>
          {reset}
        </div>
      </div>
      {typePicker && <div className="mb-3">{typePicker}</div>}
      {schema.options ? (
        <select
          id={id}
          className={selectClass}
          disabled={locked}
          value={JSON.stringify(current ?? "")}
          onChange={(event) => onChange(JSON.parse(event.target.value))}
        >
          {!schema.options.some((option) =>
            Object.is(option.value, current),
          ) && (
            <option value={JSON.stringify(current ?? "")}>
              {String(current ?? "Automatic") || "Automatic"}
            </option>
          )}
          {schema.options.map((option) => (
            <option
              key={JSON.stringify(option.value)}
              value={JSON.stringify(option.value)}
            >
              {option.label}
            </option>
          ))}
        </select>
      ) : kind === "boolean" ? (
        <div className="flex items-center gap-3">
          <Switch
            id={id}
            checked={current === true}
            disabled={locked}
            onCheckedChange={onChange}
          />
          <span className="text-xs text-muted-foreground">
            {current === true
              ? "On"
              : current === false
                ? "Off"
                : "Automatic / inherited"}
          </span>
        </div>
      ) : kind === "null" ? (
        <p className="text-xs text-muted-foreground">Null value</p>
      ) : (
        <Input
          id={id}
          type={
            kind === "number"
              ? "number"
              : secretField(path)
                ? "password"
                : "text"
          }
          autoComplete="off"
          step={
            kind === "number" ? (schema.kind === "any" ? "any" : 1) : undefined
          }
          disabled={locked}
          value={
            typeof current === "string" || typeof current === "number"
              ? current
              : ""
          }
          placeholder={inherited ? "Automatic / inherited" : ""}
          onChange={(event) =>
            onChange(
              kind === "number"
                ? event.target.value === ""
                  ? undefined
                  : Number(event.target.value)
                : event.target.value,
            )
          }
        />
      )}
      <p className="mt-2 break-words text-[11px] text-muted-foreground">
        {readOnlyField(path)
          ? "Managed by the server; cannot be changed here."
          : `Default: ${secretField(path) && schema.default ? "Hidden" : defaultText}`}
      </p>
      {description && (
        <details className="mt-2 text-xs text-muted-foreground">
          <summary className="cursor-pointer text-[11px]">
            About this setting
          </summary>
          <p className="mt-2 whitespace-pre-line leading-relaxed">
            {description}
          </p>
        </details>
      )}
    </div>
  );
}
