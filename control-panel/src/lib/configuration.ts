import generated from "./config-schema.json";

export type ConfigValue =
  | null
  | string
  | number
  | boolean
  | ConfigValue[]
  | { [key: string]: ConfigValue };
export type FormSchema = {
  kind: string;
  default?: ConfigValue;
  description?: string;
  properties?: Record<string, FormSchema>;
  item?: FormSchema;
  additional?: FormSchema;
  options?: { label: string; value: ConfigValue }[];
};
export const configSchema = generated as FormSchema;
const at = (path: string) =>
  path.split(".").reduce((node, part) => node.properties![part], configSchema);
// Runtime defaults applied after config parsing; empty values retain their automatic behavior.
at("routing.strategy").default = "round-robin";
at("routing.strategy").options = [
  { label: "Round robin", value: "round-robin" },
  { label: "Weighted round robin", value: "weighted-round-robin" },
  { label: "Fill first", value: "fill-first" },
];
at("routing.session-affinity-ttl").default = "1h";
at("routing.session-affinity-subagents").default = true;
at("oauth.auth-dir").default = "~/.cli-proxy-api";
at("oauth.providers.antigravity.signature-cache-enabled").default = true;
at("oauth.providers.antigravity.signature-bypass-strict").default = false;
at("server.discovery.auth-required").default = true;
at("multimedia.video-result-auth-cache-ttl").default = "3h";
at("multimedia.gpt-image-2-base-model").default = "gpt-5.4-mini";
at("multimedia.disable-image-generation").options = [
  { label: "Enabled everywhere", value: false },
  { label: "Disabled everywhere", value: true },
  { label: "Image endpoints only", value: "chat" },
  { label: "Pass through client requests", value: "passthrough" },
];

export const configSections = [
  [
    "routing",
    "Routing",
    "Choose credentials, session affinity, retries, and cooldowns.",
  ],
  ["requests", "Requests", "Configure proxies, streaming, and payload rules."],
  [
    "api-keys",
    "Providers",
    "Manage provider groups, keys, models, and per-key overrides.",
  ],
  [
    "oauth",
    "OAuth",
    "Configure credential storage, provider behavior, and model aliases.",
  ],
  [
    "upstream",
    "Upstream behavior",
    "Control provider request handling and headers.",
  ],
  [
    "client",
    "Client behavior",
    "Configure client-specific compatibility features.",
  ],
  [
    "multimedia",
    "Images & video",
    "Control image generation and video credential retention.",
  ],
  [
    "observability",
    "Logs & usage",
    "Configure logging, usage collection, and profiling.",
  ],
  [
    "server",
    "Network & server",
    "Configure listeners, TLS, trusted proxies, and discovery. Listener changes require a server restart.",
  ],
  [
    "management",
    "Management",
    "Configure management access and the bundled panel. Access changes may disconnect this panel.",
  ],
  [
    "access",
    "Client API keys",
    "Manage keys that clients use to access this proxy. An empty list can allow unauthenticated access.",
  ],
  [
    "models",
    "Model catalogs",
    "Choose remote or local catalogs. Empty sources use the server's default catalog behavior.",
  ],
  [
    "plugins",
    "Plugins",
    "Configure plugin loading, store sources, authentication, and extension settings.",
  ],
  [
    "credentials",
    "Credentials",
    "Configure concurrency and observation. Home-managed concurrency policies remain authoritative.",
  ],
  [
    "quota-exceeded",
    "Quota fallback",
    "Choose fallback behavior after a provider quota is exhausted.",
  ],
] as const;

const labels: Record<string, string> = {
  "api-keys": "API keys",
  "request-retry": "Request retries",
  "session-affinity": "Session affinity",
  "session-affinity-ttl": "Session retention",
  "max-retry-interval": "Maximum retry wait (seconds)",
  "max-retry-credentials": "Credentials per retry round",
  tls: "TLS",
  oauth: "OAuth",
  pprof: "Profiling",
  "proxy-url": "Proxy URL",
  "auth-dir": "Credential directory",
  strategy: "Routing strategy",
};
export const fieldLabel = (key: string) =>
  labels[key] ||
  key.charAt(0).toUpperCase() + key.slice(1).replaceAll("-", " ");
export const orderedFields = (keys: string[]) => {
  const first = [
    "strategy",
    "session-affinity",
    "session-affinity-ttl",
    "session-affinity-subagents",
    "force-model-prefix",
    "retry",
    "cooldown",
    "enabled",
    "name",
    "base-url",
    "api-key",
    "host",
    "port",
  ];
  return [...keys].sort(
    (a, b) =>
      (first.includes(a) ? first.indexOf(a) : 100) -
      (first.includes(b) ? first.indexOf(b) : 100),
  );
};
export const isCollection = (schema: FormSchema | undefined) =>
  ["object", "array", "any"].includes(schema?.kind || "");
export const isRecord = (
  value: unknown,
): value is Record<string, ConfigValue> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export const sameValue = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return (
      a.length === b.length &&
      a.every((value, index) => sameValue(value, b[index]))
    );
  if (isRecord(a) && isRecord(b))
    return (
      Object.keys(a).length === Object.keys(b).length &&
      Object.keys(a).every(
        (key) => Object.hasOwn(b, key) && sameValue(a[key], b[key]),
      )
    );
  return false;
};
export function replaceField(
  object: Record<string, ConfigValue>,
  key: string,
  value: ConfigValue | undefined,
) {
  const next = { ...object };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}
export const readOnlyField = (path: string) =>
  /(?:^|\.)(auth_index|auth-index)$/.test(path) ||
  [
    "plugins.auth-revision",
    "credentials.concurrency.lifecycle-config-revision",
    "credentials.concurrency.observation-barrier-revision",
  ].includes(path);
export const secretField = (path: string) =>
  /(?:^|\.)(api-key|secret-key|credential|password|token|authorization|proxy-url)$/i.test(
    path,
  ) ||
  /^access\.api-keys\./.test(path) ||
  /\.headers\./i.test(path);
