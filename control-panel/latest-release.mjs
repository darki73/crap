// Public release metadata belongs to the panel, not the inference proxy.
const endpoint =
  "https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/latest";

export function createLatestReleaseReader({
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  let cached;
  let pending;
  return async function readLatestRelease() {
    if (cached && now() < cached.expires) return { ...cached.value };
    if (!pending) {
      pending = (async () => {
        const response = await fetchImpl(endpoint, {
          method: "GET",
          redirect: "error",
          signal: AbortSignal.timeout(15000),
          headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": "CRAP-release-check",
          },
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(
            response.status === 403 || response.status === 429
              ? "GitHub denied or rate-limited the release check. Try again later."
              : "GitHub release information is unavailable. Try again later.",
          );
        }
        const release = await response.json();
        if (
          typeof release.tag_name !== "string" ||
          !/^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(release.tag_name) ||
          release.tag_name.length > 100
        )
          throw new Error("GitHub returned an invalid release version.");
        const value = { "latest-version": release.tag_name };
        cached = { value, expires: now() + 5 * 60 * 1000 };
        return value;
      })().finally(() => {
        pending = undefined;
      });
    }
    return { ...(await pending) };
  };
}
