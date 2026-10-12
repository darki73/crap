export type Provider = {
  name: string;
  "base-url": string;
  disabled?: boolean;
  keys: { "api-key": string; [key: string]: unknown }[];
  models?: { name: string; alias?: string }[];
  [key: string]: unknown;
};
export type QuotaObservation = {
  observed_at?: string;
  signals?: Record<string, string>;
};
export type Credential = {
  id: string;
  auth_index?: string;
  name: string;
  provider: string;
  type?: string;
  email?: string;
  disabled: boolean;
  status?: string;
  status_message?: string;
  quota?: QuotaObservation;
  runtime_only?: boolean;
  supports_quota?: boolean;
  quota_provider?: string;
};
export type Config = {
  access: { "api-keys"?: string[] };
  "api-keys": Record<string, Provider[]>;
  routing: { strategy?: string; retry?: { "request-retry"?: number } };
  observability: {
    logs?: { debug?: boolean; "logging-to-file"?: boolean };
    usage?: { "usage-statistics-enabled"?: boolean };
  };
};
export type Usage = Record<
  string,
  Record<string, { success: number; failed: number }>
>;
export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await apiResponse(path, options);
  return (await response.json().catch(() => null)) as T;
}
export async function apiResponse(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  headers.set("X-Panel-Client", "cliproxy-panel");
  if (
    options.body &&
    !(options.body instanceof FormData) &&
    !headers.has("Content-Type")
  )
    headers.set("Content-Type", "application/json");
  const response = await fetch(`/api${path}`, { ...options, headers });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new APIError(
      response.status,
      body?.message || body?.error || `Request failed (${response.status})`,
    );
  }
  return response;
}
export class APIError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function optionalConfig<T>(path: string, fallback: T): Promise<T> {
  try {
    return await api<T>(path);
  } catch (error) {
    if (error instanceof APIError && error.status === 404) return fallback;
    throw error;
  }
}
export const write = <T>(path: string, method: string, value: unknown) =>
  api<T>(path, { method, body: JSON.stringify(value) });
export const errorMessage = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
