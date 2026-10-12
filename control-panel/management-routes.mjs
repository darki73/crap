const exact = new Map([
  ["/admin/config", ["GET", "PUT", "PATCH"]],
  ["/config.yaml", ["GET", "PUT"]],
  ["/credentials/download", ["GET"]],
  ["/credentials/models", ["GET"]],
  ["/credentials/status", ["PATCH"]],
  ["/credentials/fields", ["PATCH"]],
  ["/credentials/refresh", ["POST"]],
  ["/oauth/import", ["POST"]],
  ["/routing/cooldown/reset", ["POST"]],
  ["/server/latest-version", ["GET"]],
  ["/requests/api-call", ["POST"]],
  ["/observability/logs/errors", ["GET"]],
  ["/observability/usage/queue", ["GET"]],
  ["/plugins", ["GET"]],
  ["/plugins/store", ["GET"]],
]);
// Dynamic operations stay within the documented v8 route families.
export function allowsManagementRoute(endpoint, method) {
  let decoded;
  try {
    decoded = decodeURIComponent(endpoint);
  } catch {
    return false;
  }
  if (
    decoded.includes("\\") ||
    decoded.split("/").some((part) => part === "." || part === "..") ||
    decoded.split("/").length !== endpoint.split("/").length
  )
    return false;
  if (exact.get(endpoint)?.includes(method)) return true;
  if (/^\/config\/[^/]+(?:\/[^/]+)*$/.test(endpoint))
    return ["GET", "PUT", "PATCH", "DELETE"].includes(method);
  if (/^\/routing\/model-definitions\/[^/]+$/.test(endpoint))
    return method === "GET";
  if (/^\/observability\/logs\/(errors|requests)\/[^/]+$/.test(endpoint))
    return method === "GET";
  if (/^\/plugins\/[^/]+\/quota$/.test(endpoint))
    return ["GET", "POST", "DELETE"].includes(method);
  if (/^\/plugins\/store\/[^/]+\/install$/.test(endpoint))
    return method === "POST";
  if (/^\/plugins\/[^/]+$/.test(endpoint) && endpoint !== "/plugins/store")
    return method === "DELETE";
  return false;
}
