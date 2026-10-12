import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

const origin = "http://127.0.0.1:3000";
async function request(path, method = "GET", body) {
  const response = await fetch(origin + "/api" + path, {
    method,
    headers: {
      "X-Panel-Client": "cliproxy-panel",
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  assert.equal(
    response.ok,
    true,
    `Unexpected status ${response.status} from ${path}`,
  );
  return data;
}
test("running Docker stack: reads and reversible v8 configuration writes", async () => {
  assert.equal((await request("/health")).status, "ok");
  const original = await request("/config");
  assert.equal(original.management, undefined);
  assert.ok(Array.isArray((await request("/credentials")).files));
  assert.ok(
    Array.isArray((await request("/observability/logs?limit=10")).lines),
  );
  await request("/observability/usage/api-keys");
  const testKey = "panel-test-" + randomBytes(20).toString("hex");
  const testName = "panel-smoke-" + randomBytes(6).toString("hex");
  try {
    await request("/config/access/api-keys", "PUT", [
      ...(original.access["api-keys"] ?? []),
      testKey,
    ]);
    assert.ok((await request("/config")).access["api-keys"].includes(testKey));
    // A disabled .invalid provider exercises persistence without making model calls.
    const providers = original["api-keys"]["openai-compatibility"] ?? [];
    await request("/config/api-keys/openai-compatibility", "PUT", [
      ...providers,
      {
        name: testName,
        "base-url": "https://provider.invalid/v1",
        disabled: true,
        keys: [{ "api-key": "disposable-test-value" }],
        models: [{ name: "test-model", alias: "test-model" }],
      },
    ]);
    assert.ok(
      (await request("/config"))["api-keys"]["openai-compatibility"].some(
        (item) => item.name === testName && item.disabled,
      ),
    );
    await request("/config/routing", "PATCH", {
      strategy: original.routing.strategy ?? "round-robin",
    });
  } finally {
    const current = await request("/config");
    await request(
      "/config/access/api-keys",
      "PUT",
      current.access["api-keys"].filter((key) => key !== testKey),
    );
    await request(
      "/config/api-keys/openai-compatibility",
      "PUT",
      (current["api-keys"]["openai-compatibility"] ?? []).filter(
        (provider) => provider.name !== testName,
      ),
    );
  }
  const final = await request("/config");
  assert.deepEqual(final.access["api-keys"], original.access["api-keys"]);
  assert.equal(
    final["api-keys"]["openai-compatibility"].some(
      (item) => item.name === testName,
    ),
    false,
  );
});
