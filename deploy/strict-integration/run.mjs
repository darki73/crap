import { spawn } from "node:child_process";
import { mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { recovery } from "./recovery.mjs";
const root = fileURLToPath(new URL("../../", import.meta.url));
mkdirSync(new URL("../../.local-panel", import.meta.url), { recursive: true });
const log = new URL(
  "../../.local-panel/strict-integration.log",
  import.meta.url,
);
writeFileSync(log, "");
const compose = [
  "compose",
  "-p",
  "crap-strict-integration",
  "-f",
  "deploy/compose.yaml",
  "-f",
  "deploy/strict-integration/compose.yaml",
];
async function run(args, show = false) {
  const child = spawn("docker", args, {
    cwd: root,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (b) => {
      out += b;
      appendFileSync(log, b);
      if (show) process.stdout.write(b);
    });
  await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (n) =>
      n === 0
        ? resolve()
        : reject(
            Error(
              "Fixture command failed; see .local-panel/strict-integration.log",
            ),
          ),
    );
  });
  return out;
}
const dc = (args, show) => run([...compose, ...args], show);
if ((await dc(["ps", "-aq"])).trim())
  throw Error(
    "Disposable test project already exists; inspect it before removing.",
  );
try {
  console.log(
    "Building and starting the production gateway, plugin and control against a synthetic HTTPS provider...",
  );
  await dc(["up", "-d", "--build", "gateway", "certificates", "provider"]);
  const id = (await dc(["ps", "-q", "proxy"])).trim();
  const info = JSON.parse(await run(["inspect", id]))[0];
  if (
    Object.keys(info.NetworkSettings.Networks).length !== 1 ||
    Object.values(info.NetworkSettings.Ports ?? {}).some((ports) => ports?.length)
  )
    throw Error("Proxy isolation changed");
  const net = Object.values(info.NetworkSettings.Networks)[0].NetworkID;
  if (!JSON.parse(await run(["network", "inspect", net]))[0].Internal)
    throw Error("Proxy network must be internal");
  // A migrated workspace can retain a live legacy policy. It must never veto
  // strict admission, including unknown quota or an account below 5% remaining.
  await dc([
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "postgres",
    "-d",
    "crap",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    "UPDATE affinity_router.routing_policy SET mode='live',minimum_remaining=5,freshness_seconds=300 WHERE singleton",
  ]);
  await dc(["run", "--rm", "--no-deps", "test"], true);
  await recovery(run, compose);
} finally {
  await dc(["logs", "--no-color"]);
  await dc(["down", "--volumes", "--remove-orphans"]);
}
