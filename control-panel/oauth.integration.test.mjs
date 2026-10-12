import test from "node:test";
import assert from "node:assert/strict";

const base = process.env.PANEL_TEST_URL ?? "http://127.0.0.1:5173";
const headers = { "X-Panel-Client": "cliproxy-panel" };
async function request(path, method = "GET") {
  const response = await fetch(base + "/api" + path, { headers, method });
  assert.equal(
    response.ok,
    true,
    `Unexpected status ${response.status} from ${path.split("?")[0]}`,
  );
  return response.json();
}

test("live Codex OAuth: create, poll, verify local redirect, and cancel without signing in", async () => {
  const before = (await request("/credentials")).files
    .map((file) => file.name)
    .sort();
  const login = await request("/oauth/auth-url?provider=codex&is_webui=true");
  assert.ok(login.state);
  try {
    assert.equal(new URL(login.url).hostname, "auth.openai.com");
    assert.equal(
      (await request(`/oauth/status?state=${encodeURIComponent(login.state)}`))
        .status,
      "wait",
    );
    // Inspect the loopback forwarder without following the redirect or submitting
    // an authorization code. This does not contact the provider or create tokens.
    const callback = new URL("http://127.0.0.1:1455/auth/callback");
    callback.searchParams.set("state", login.state);
    callback.searchParams.set("error", "access_denied");
    const redirect = await fetch(callback, { redirect: "manual" });
    assert.equal(redirect.status, 302);
    const location = new URL(redirect.headers.get("location"));
    assert.equal(location.pathname, "/codex/callback");
    assert.equal(location.port, "8317");
    assert.equal(location.searchParams.get("state"), login.state);
    await redirect.arrayBuffer();
  } finally {
    await request(
      `/oauth/session?state=${encodeURIComponent(login.state)}`,
      "DELETE",
    );
  }
  assert.equal(
    (await request(`/oauth/status?state=${encodeURIComponent(login.state)}`))
      .status,
    "error",
  );
  assert.deepEqual(
    (await request("/credentials")).files.map((file) => file.name).sort(),
    before,
  );
});
