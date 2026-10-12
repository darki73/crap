// Prepares the owner's already-authorized local cutover. No inference is sent.
// Run before stopping the original services. Secrets/backups stay in .local-panel.
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { privateDirectory } from "../control-panel/database-transfer.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = path.join(root, ".local-panel/strict");
const backup = path.join(directory, "before");
const parse = (s) =>
  Object.fromEntries(
    s
      .split(/\r?\n/)
      .filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i), l.slice(i + 1)];
      }),
  );
const readEnv = async (f) => parse(await readFile(path.join(root, f), "utf8"));
function docker(args) {
  const r = spawnSync("docker", args, {
    cwd: root,
    windowsHide: true,
    maxBuffer: 128 << 20,
  });
  if (r.status !== 0)
    throw Error("Docker cutover preparation failed; private output withheld");
  return r.stdout;
}
await privateDirectory(directory);
await privateDirectory(backup);
try {
  await readFile(path.join(backup, "ready.json"));
  throw Error("A cutover backup already exists; inspect before running again");
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
const local = await readEnv(".local-panel/.env"),
  affinity = await readEnv(".local-panel/affinity.env"),
  pg = await readEnv(".local-panel/database/proxy.env");
async function management(route, body, method = body === undefined ? "GET" : "PUT") {
  const r = await fetch("http://127.0.0.1:8317/v8/management" + route, {
    method,
    headers: {
      Authorization: `Bearer ${local.PANEL_MANAGEMENT_KEY}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw Error("Management preparation failed");
  return r;
}
const config = await (await management("/config.yaml")).text();
try { await writeFile(path.join(backup, "config.yaml"), config, {mode:0o600,flag:"wx"}); }
catch(error) { if(error.code!=="EEXIST" || await readFile(path.join(backup,"config.yaml"),"utf8")!==config)throw Error("Existing backup does not match the source configuration"); }
const accounts = (await (await management("/credentials")).json()).files;
await writeFile(
  path.join(backup, "accounts.json"),
  JSON.stringify(accounts.map((a) => ({ id: a.id, name: a.name }))),
  { mode: 0o600 },
);
const original = JSON.parse(docker(["inspect", "cliproxy-panel-proxy-1"]))[0];
if (original.Config.Labels["com.docker.compose.project"] !== "cliproxy-panel")
  throw Error("Unexpected source container");
await writeFile(
  path.join(backup, "proxy-inspect.json"),
  JSON.stringify(original),
  { mode: 0o600 },
);
const originalDSN = new URL(affinity.AFFINITY_DATABASE_URL);
await writeFile(
  path.join(backup, "database.dump"),
  docker([
    "exec",
    "cliproxy-affinity-postgres-1",
    "pg_dump",
    "-U",
    decodeURIComponent(originalDSN.username),
    "-d",
    originalDSN.pathname.slice(1),
    "-Fc",
  ]),
  { mode: 0o600 },
);
const pluginNames=docker(["exec","cliproxy-panel-proxy-1","ls","/CLIProxyAPI/plugins"]).toString().trim().split(/\r?\n/).filter(n=>/^affinity-router(?:-v[0-9.]+)?\.so$/.test(n));
if(pluginNames.length!==1)throw Error("Expected exactly one installed affinity plugin");
await writeFile(path.join(backup,"plugin-name.json"),JSON.stringify(pluginNames[0]));
docker([
  "cp",
  `cliproxy-panel-proxy-1:/CLIProxyAPI/plugins/${pluginNames[0]}`,
  path.join(backup, "affinity-router.so"),
]);
for (const f of [".env", "affinity.env", "affinity-plugin.env"])
  await copyFile(path.join(root, ".local-panel", f), path.join(backup, f));
const db = new URL(pg.PGSTORE_DSN);
db.hostname = "cliproxy-affinity-postgres-1";
db.port = "5432";
const common = {
  AFFINITY_ID_KEY: affinity.AFFINITY_ID_KEY,
  AFFINITY_CONTROL_TOKEN: affinity.AFFINITY_CONTROL_TOKEN,
  AFFINITY_CONTROL_URL: "http://control:8318",
};
const envWrite = async (name, values) =>
  writeFile(
    path.join(directory, name),
    Object.entries(values)
      .map(([k, v]) => `${k}=${v}\n`)
      .join(""),
    { mode: 0o600 },
  );
await envWrite("proxy.env", {
  ...pg,
  ...common,
  PGSTORE_DSN: db.toString(),
  CRAP_STRICT_URL: "http://gateway:8320",
  AFFINITY_SPOOL: "/CLIProxyAPI/plugins/affinity-spool",
});
await envWrite("control.env", {
  ...common,
  AFFINITY_DATABASE_URL: db.toString(),
  CRAP_STRICT_ROUTING: "1",
});
await envWrite("gateway.env", {
  ...common,
  MANAGEMENT_KEY: local.PANEL_MANAGEMENT_KEY,
  PROXY_URL: "http://proxy:8317",
  CRAP_STRICT_ROUTING: "1",
  CRAP_INTERNAL_LISTEN: "0.0.0.0:8320",
  CRAP_EGRESS_LISTEN: "0.0.0.0:8321",
  CRAP_OUTBOUND_URL: "http://gateway:8321",
});
await envWrite("dev.env.prepared", {
  PROXY_URL: "http://127.0.0.1:18318",
  CRAP_STRICT_INTERNAL_URL: "http://127.0.0.1:8320",
});
await mkdir(path.join(directory, "control-data"), { recursive: true });
// These supported management mutations preserve unrelated configuration.
await management("/config/routing/retry/request-retry", 0);
await management("/config/routing/retry/max-retry-interval", 0);
await management("/config/routing/cooldown/disable-cooling", true);
await management("/config/requests/proxy-url", "http://gateway:8321");
const plugins=await(await management("/config/plugins")).json();
if(plugins.configs?.["affinity-router"]?.store) {
  await management("/config/plugins/configs/affinity-router/store",undefined,"DELETE");
}
await writeFile(
  path.join(backup, "ready.json"),
  JSON.stringify({
    createdAt: new Date().toISOString(),
    accounts: accounts.length,
    proxyImage: original.Image,
  }),
  { mode: 0o600 },
);
console.log(
  `Local cutover prepared; ${accounts.length} account registrations and the database backed up privately. No inference sent.`,
);
