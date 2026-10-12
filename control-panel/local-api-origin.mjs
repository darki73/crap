export function localAPIOrigin(value = "http://localhost:8317") {
  const u = new URL(value);
  if (
    u.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) ||
    u.username ||
    u.password ||
    u.pathname !== "/" ||
    u.search ||
    u.hash
  )
    throw new Error(
      "PANEL_LOCAL_API_ORIGIN must be a loopback HTTP origin without credentials or a path.",
    );
  return u.origin;
}
