// Reproducible, mock-only rehearsal. Never targets the development Compose project.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../../", import.meta.url));
const log = path.join(root, ".local-panel", "strict-proof-rehearsal.log");
mkdirSync(path.dirname(log), { recursive: true });
writeFileSync(log, "");
const compose = [
  "compose",
  "-p",
  "crap-strict-proof",
  "-f",
  "deploy/strict-proof/compose.yaml",
];
async function run(args, { show = false, onLine } = {}) {
  const child = spawn("docker", args, {
    cwd: root,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "",
    carry = "";
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    output += text;
    appendFileSync(log, text);
    if (show) process.stdout.write(text);
    carry += text;
    const lines = carry.split("\n");
    carry = lines.pop();
    for (const line of lines) onLine?.(line);
  });
  child.stderr.on("data", (chunk) => appendFileSync(log, chunk));
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(Error(`Disposable command failed (${code}); see ${log}`)),
    );
  });
  return output.trim();
}
const dc = (args, options) => run([...compose, ...args], options);
if (await dc(["ps", "-aq"]))
  throw Error(
    "The disposable crap-strict-proof project already exists. Stop/remove that proof before running a fresh rehearsal.",
  );
let created = false;
try {
  console.log(
    "Testing the official upstream distribution with disposable CRAP fixture images...",
  );
  created = true;
  await dc(["up", "-d", "--build"]);
  const proxy = await dc(["ps", "-q", "proxy"]),
    provider = await dc(["ps", "-q", "provider"]);
  const inspect = async (id) => JSON.parse(await run(["inspect", id]))[0];
  const p = await inspect(proxy),
    u = await inspect(provider);
  assert.equal(
    Object.keys(p.NetworkSettings.Ports || {}).length,
    0,
    "proof publishes no proxy port",
  );
  const proxyNetworks = Object.values(p.NetworkSettings.Networks),
    providerNetworks = Object.values(u.NetworkSettings.Networks);
  assert.equal(proxyNetworks.length, 1);
  for (const network of proxyNetworks) {
    const n = JSON.parse(
      await run(["network", "inspect", network.NetworkID]),
    )[0];
    assert.equal(n.Internal, true);
    assert.ok(
      providerNetworks.every((other) => other.NetworkID !== network.NetworkID),
    );
  }
  await dc([
    "exec",
    "-T",
    "proxy",
    "/proof/fixture",
    "probe",
    `${providerNetworks[0].IPAddress}:8443`,
  ]);
  console.log(
    "PASS: private internal network; direct TCP to the provider IP is blocked",
  );
  await dc(["exec", "-T", "boundary", "node", "test.mjs"], { show: true });
  let killPromise;
  await dc(["exec", "-T", "boundary", "node", "crash.mjs"], {
    show: true,
    onLine: (line) => {
      if (line === "READY_TO_KILL_DISPOSABLE_PROXY" && !killPromise) {
        killPromise = dc(["kill", "-s", "SIGKILL", "proxy"]);
        // Keep the rejection handled while crash.mjs observes the killed process.
        killPromise.catch(() => {});
      }
    },
  });
  assert.ok(killPromise);
  await killPromise;
  console.log(
    "PASS: strict-routing architecture proof complete. Live services were not targeted.",
  );
} finally {
  if (created) {
    try {
      await dc(["logs", "--no-color"]);
    } finally {
      await dc(["down", "--remove-orphans", "--volumes"]);
    }
    console.log("Disposable proof containers and networks removed.");
  }
}
