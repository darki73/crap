import { randomBytes } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  chown,
  chmod,
  copyFile,
  readdir,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Runs once before services, with access only to this deployment's secret volumes.
export async function bootstrap(root, { ownership = true } = {}) {
  const names = ["seed", "postgres", "proxy", "control", "panel"];
  for (const name of names) {
    const dir = path.join(root, name);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if (ownership && name !== "seed" && name !== "postgres")
      await chown(dir, 1000, 1000);
    await chmod(dir, name === "postgres" ? 0o755 : 0o700);
  }
  const seedPath = path.join(root, "seed", "keys.json");
  let keys;
  try {
    keys = JSON.parse(await readFile(seedPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT")
      throw new Error(
        "Existing bootstrap state is unreadable; restore it instead of rotating secrets.",
      );
    for (const name of names.filter((n) => n !== "seed"))
      if ((await readdir(path.join(root, name))).length)
        throw new Error(
          "Bootstrap state is missing from an existing deployment; restore it instead of generating new keys.",
        );
    keys = Object.fromEntries(
      [
        "postgres",
        "controlDB",
        "proxyDB",
        "management",
        "control",
        "identity",
        "client",
      ].map((k) => [k, randomBytes(32).toString("hex")]),
    );
    await writeFile(seedPath, JSON.stringify(keys), {
      flag: "wx",
      mode: 0o600,
    });
  }
  for (const name of [
    "postgres",
    "controlDB",
    "proxyDB",
    "management",
    "control",
    "identity",
    "client",
  ])
    if (!/^[a-f0-9]{64}$/.test(keys[name] || ""))
      throw new Error("Invalid bootstrap state; no secrets were replaced.");
  const dsn = (role, password) =>
    `postgresql://${role}:${password}@postgres:5432/crap?sslmode=disable`;
  const control = `AFFINITY_DATABASE_URL=${dsn("crap_app", keys.controlDB)}\nAFFINITY_ID_KEY=${keys.identity}\nAFFINITY_CONTROL_TOKEN=${keys.control}\n`;
  const proxy = `PGSTORE_DSN=${dsn("cliproxy_app", keys.proxyDB)}\nAFFINITY_ID_KEY=${keys.identity}\nAFFINITY_CONTROL_TOKEN=${keys.control}\nAFFINITY_CONTROL_URL=http://control:8318\n`;
  const panel = `MANAGEMENT_KEY=${keys.management}\nAFFINITY_ID_KEY=${keys.identity}\nAFFINITY_CONTROL_TOKEN=${keys.control}\nAFFINITY_CONTROL_URL=http://control:8318\n`;
  const config = {
    "config-version": 8,
    server: { host: "0.0.0.0", port: 8317 },
    management: {
      "allow-remote": true,
      "secret-key": keys.management,
      "disable-control-panel": true,
    },
    access: { "api-keys": [`crap-${keys.client}`] },
    ...(process.env.CRAP_STRICT_ROUTING === "1"
      ? {
          requests: { "proxy-url": "http://gateway:8321" },
          routing: {
            retry: { "request-retry": 0, "max-retry-interval": 0 },
            cooldown: { "disable-cooling": true },
          },
        }
      : {}),
    observability: {
      logs: { "logging-to-file": false, "logs-max-total-size-mb": 50 },
      usage: { "usage-statistics-enabled": true },
    },
    plugins: {
      enabled: true,
      dir: "/CLIProxyAPI/plugins",
      configs: { "affinity-router": { enabled: true, priority: 100 } },
    },
  };
  const files = {
    "postgres/password": keys.postgres,
    "postgres/10-crap.sql": `CREATE ROLE crap_app LOGIN PASSWORD '${keys.controlDB}';\nCREATE ROLE cliproxy_app LOGIN PASSWORD '${keys.proxyDB}';\nREVOKE CREATE ON SCHEMA public FROM PUBLIC;\nGRANT CREATE ON DATABASE crap TO crap_app, cliproxy_app;\nCREATE SCHEMA affinity_router AUTHORIZATION crap_app;\nCREATE SCHEMA cliproxy AUTHORIZATION cliproxy_app;\n`,
    "control/service.env": control,
    "proxy/service.env": proxy,
    "proxy/config.example.yaml": JSON.stringify(config, null, 2),
    "panel/service.env": panel,
  };
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, name);
    try {
      await writeFile(target, content, {
        flag: "wx",
        mode: name.endsWith(".sql") ? 0o644 : 0o600,
      });
    } catch (error) {
      if (
        error.code !== "EEXIST" ||
        (await readFile(target, "utf8")) !== content
      )
        throw new Error(
          "Bootstrap files do not match saved state. Restore the matching secret volumes; nothing was overwritten.",
        );
    }
    if (ownership && !name.startsWith("postgres/"))
      await chown(target, 1000, 1000);
  }
}
// CRAP installs its own plugin/adapter, never the upstream executable or sources.
export async function installProxyAdapter(destination) {
  for (const [source, name] of [
    ["/app/plugin/affinity-router.so", "affinity-router.so"],
    [new URL("proxy-entrypoint.sh", import.meta.url), "proxy-entrypoint.sh"],
    [new URL("proxy-storage-guard.sh", import.meta.url), "proxy-storage-guard.sh"],
  ]) {
    const target = path.join(destination, name);
    await copyFile(source, target);
    await chmod(target, 0o500);
    await chown(target, 1000, 1000);
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await bootstrap("/bootstrap");
    await installProxyAdapter("/bootstrap/proxy");
    await chown("/bootstrap/proxy-data", 1000, 1000);
    await chmod("/bootstrap/proxy-data", 0o700);
    console.log("CRAP bootstrap ready; existing secrets preserved.");
  } catch {
    console.error(
      "CRAP bootstrap failed. Inspect volume permissions and restore matching bootstrap state; secrets were not printed.",
    );
    process.exitCode = 1;
  }
}
