import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
if (process.env.CRAP_REHEARSAL !== "1")
  throw new Error("Disposable rehearsal only.");
const env = Object.fromEntries(
  (await readFile("/run/crap/service.env", "utf8"))
    .trim()
    .split("\n")
    .map((line) => [
      line.slice(0, line.indexOf("=")),
      line.slice(line.indexOf("=") + 1),
    ]),
);
const mode = process.argv[2];
async function request(path, options = {}) {
  return fetch("http://gateway:8319" + path, { ...options, redirect: "error" });
}
async function checkBlocked() {
  const res = await request("/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-fixture",
      messages: [{ role: "user", content: "never forward" }],
    }),
  });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, "crap_not_ready");
  assert.equal((await request("/v8/management/config")).status, 404);
}
if (mode === "blocked") {
  await checkBlocked();
  console.log(
    "PASS: unavailable dependencies block inference with 503; management is private.",
  );
} else if (mode === "plugin") {
  const endpoint = "http://proxy:8317/v8/management/config/plugins/enabled";
  async function enable(enabled) {
    const r = await fetch(endpoint, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${env.MANAGEMENT_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(enabled),
    });
    assert.equal(r.status, 200);
  }
  try {
    await enable(false);
    let blocked = false;
    for (let i = 0; i < 40; i++) {
      if ((await request("/readyz")).status === 503) {
        blocked = true;
        break;
      }
      await delay(250);
    }
    assert.ok(blocked);
    await checkBlocked();
  } finally {
    await enable(true);
  }
  console.log(
    "PASS: disabling the actual plugin blocks the public inference API.",
  );
} else if (mode === "ready") {
  let ready = false;
  for (let i = 0; i < 90; i++) {
    if ((await request("/readyz")).ok) {
      ready = true;
      break;
    }
    await delay(500);
  }
  assert.ok(ready, "gateway did not recover");
  console.log("PASS: checked API readiness recovered.");
} else throw new Error("Unknown probe.");
