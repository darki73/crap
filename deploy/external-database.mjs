// Offline provisioning: no database administrator password enters the dashboard.
import { X509Certificate, randomBytes } from "node:crypto";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrap } from "./bootstrap.mjs";
import { privateDirectory } from "../control-panel/database-transfer.mjs";

export function validateDestination(value, ca) {
  const { host, port = 5432, database } = value || {};
  if (
    typeof host !== "string" ||
    host.length > 253 ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host) ||
    host.includes("..") ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !/^[a-z][a-z0-9_]{0,62}$/.test(database || "")
  )
    throw new Error(
      "Use a DNS hostname, valid port and simple PostgreSQL database name.",
    );
  if (typeof ca !== "string" || ca.length > 65536 || /PRIVATE KEY/.test(ca))
    throw new Error("Provide only the public PostgreSQL CA certificate.");
  const certificate = new X509Certificate(ca);
  if (
    !certificate.ca ||
    Date.parse(certificate.validTo) <= Date.now() ||
    Date.parse(certificate.validFrom) > Date.now()
  )
    throw new Error("A currently valid PostgreSQL CA certificate is required.");
  return { host, port, database, sslmode: "verify-full" };
}

export async function prepareExternal(config, output) {
  const ca = await readFile(path.resolve(config.caFile), "utf8");
  const destination = validateDestination(config, ca);
  output = path.resolve(output);
  // Never repurpose an existing deployment or replace its identity keys.
  await mkdir(output, { mode: 0o700 });
  await privateDirectory(output);
  const base = path.join(output, "bootstrap");
  await bootstrap(base, { ownership: false });
  const keys = JSON.parse(
    await readFile(path.join(base, "seed/keys.json"), "utf8"),
  );
  let imported;
  if (config.importDirectory) {
    const source = path.resolve(config.importDirectory);
    imported = JSON.parse(
      await readFile(path.join(source, "handoff.json"), "utf8"),
    );
    if (
      imported.version !== 1 ||
      JSON.stringify(imported.schemas) !==
        JSON.stringify(["affinity_router", "cliproxy"]) ||
      !imported.counts ||
      Object.keys(imported.counts).length > 100 ||
      ![
        "affinity_router.schema_migrations",
        "cliproxy.config_store",
        "cliproxy.auth_store",
      ].every((name) => Object.hasOwn(imported.counts, name))
    )
      throw new Error("Invalid restored workspace handoff.");
    for (const [table, count] of Object.entries(imported.counts))
      if (
        !/^(affinity_router|cliproxy)\.[a-z_]+$/.test(table) ||
        !/^\d+$/.test(String(count))
      )
        throw new Error("Invalid restored table counts.");
    const values = Object.fromEntries(
      (await readFile(path.join(source, "deployment.env"), "utf8"))
        .split(/\r?\n/)
        .filter((x) => x.includes("="))
        .map((x) => [x.slice(0, x.indexOf("=")), x.slice(x.indexOf("=") + 1)]),
    );
    if (
      !/^[a-f0-9]{64}$/i.test(values.AFFINITY_ID_KEY || "") ||
      !/^[a-zA-Z0-9_-]{32,256}$/.test(values.AFFINITY_CONTROL_TOKEN || "") ||
      !/^[a-zA-Z0-9_-]{16,256}$/.test(values.PANEL_MANAGEMENT_KEY || "")
    )
      throw new Error("Unsupported restored key format.");
    keys.identity = values.AFFINITY_ID_KEY;
    keys.control = values.AFFINITY_CONTROL_TOKEN;
    keys.management = values.PANEL_MANAGEMENT_KEY;
  }
  const id = randomBytes(6).toString("hex");
  const roles = {
    migrate: `crap_${id}_migrate`,
    control: `crap_${id}_app`,
    proxy: `crap_${id}_proxy`,
  };
  const migrationPassword = randomBytes(32).toString("hex");
  const dsn = (role, password) =>
    `postgresql://${role}:${password}@${destination.host}:${destination.port}/${destination.database}?sslmode=verify-full&sslrootcert=/run/crap/ca.crt`;
  const env = (values) =>
    Object.entries(values)
      .map(([k, v]) => `${k}='${v}'\n`)
      .join("");
  const shared = {
    AFFINITY_ID_KEY: keys.identity,
    AFFINITY_CONTROL_TOKEN: keys.control,
  };
  const files = {
    "control/service.env": env({
      ...shared,
      AFFINITY_DATABASE_URL: dsn(roles.control, keys.controlDB),
    }),
    "migrate/service.env": env({
      AFFINITY_DATABASE_URL: dsn(roles.migrate, migrationPassword),
      AFFINITY_RUNTIME_ROLE: roles.control,
      ...(imported ? { AFFINITY_IMPORT_ID: id } : {}),
    }),
    "proxy/service.env": env({
      ...shared,
      PGSTORE_DSN: dsn(roles.proxy, keys.proxyDB),
      AFFINITY_CONTROL_URL: "http://control:8318",
    }),
    "proxy/config.example.yaml": await readFile(
      path.join(base, "proxy/config.example.yaml"),
      "utf8",
    ),
    "panel/service.env": `MANAGEMENT_KEY=${keys.management}\nAFFINITY_ID_KEY=${keys.identity}\nAFFINITY_CONTROL_TOKEN=${keys.control}\nAFFINITY_CONTROL_URL=http://control:8318\n${imported ? `PANEL_IMPORT_ID=${id}\n` : ""}`,
    "destination.json": JSON.stringify(
      { version: 1, ...destination, roles, imported: Boolean(imported) },
      null,
      2,
    ),
    "identity.json": JSON.stringify(keys),
    ".gitignore": "*\n",
  };
  // The target database must be dedicated and empty. A transaction refuses any
  // occupied schema; nothing is dropped or granted to PUBLIC.
  files["provision.sql"] = `\\set ON_ERROR_STOP on
BEGIN;
DO $$ BEGIN
 IF current_database() <> '${destination.database}' THEN RAISE EXCEPTION 'Wrong destination database'; END IF;
 IF EXISTS(SELECT 1 FROM pg_namespace WHERE nspname IN ('affinity_router','cliproxy')) THEN RAISE EXCEPTION 'Destination already contains workspace schemas'; END IF;
END $$;
CREATE ROLE ${roles.migrate} LOGIN PASSWORD '${migrationPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE ${roles.control} LOGIN PASSWORD '${keys.controlDB}' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE ${roles.proxy} LOGIN PASSWORD '${keys.proxyDB}' NOSUPERUSER NOCREATEDB NOCREATEROLE;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON DATABASE ${destination.database} FROM PUBLIC;
GRANT CONNECT ON DATABASE ${destination.database} TO ${roles.migrate}, ${roles.control}, ${roles.proxy};
GRANT CREATE ON DATABASE ${destination.database} TO ${roles.migrate}, ${roles.proxy};
CREATE SCHEMA affinity_router AUTHORIZATION ${roles.migrate};
CREATE SCHEMA cliproxy AUTHORIZATION ${roles.migrate};
GRANT USAGE ON SCHEMA affinity_router TO ${roles.control};
GRANT USAGE, CREATE ON SCHEMA cliproxy TO ${roles.proxy};
SET ROLE ${roles.migrate};
ALTER DEFAULT PRIVILEGES IN SCHEMA affinity_router GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${roles.control};
ALTER DEFAULT PRIVILEGES IN SCHEMA affinity_router GRANT USAGE, SELECT ON SEQUENCES TO ${roles.control};
CREATE TABLE cliproxy.config_store(id TEXT PRIMARY KEY, content TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE cliproxy.auth_store(id TEXT PRIMARY KEY, content JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE cliproxy.cooldown_store(auth_id TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', content JSONB NOT NULL, deleted BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(auth_id,model));
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA cliproxy TO ${roles.proxy};
COMMIT;
`;
  if (imported) {
    const checks = Object.entries(imported.counts)
      .map(
        ([table, count]) =>
          `IF (SELECT count(*) FROM ${table}) <> ${count} THEN RAISE EXCEPTION 'Restored row count differs'; END IF;`,
      )
      .join("\n");
    files["provision.sql"] = files["provision.sql"]
      .replace(
        "IF EXISTS(SELECT 1 FROM pg_namespace WHERE nspname IN ('affinity_router','cliproxy')) THEN RAISE EXCEPTION 'Destination already contains workspace schemas'; END IF;",
        checks,
      )
      .replace(
        `CREATE SCHEMA affinity_router AUTHORIZATION ${roles.migrate};\nCREATE SCHEMA cliproxy AUTHORIZATION ${roles.migrate};`,
        () => `ALTER SCHEMA affinity_router OWNER TO ${roles.migrate};\nALTER SCHEMA cliproxy OWNER TO ${roles.migrate};
DO $$ DECLARE item record; BEGIN
 FOR item IN SELECT n.nspname,c.relname,c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('affinity_router','cliproxy') AND c.relkind IN ('r','p','S','v','m') ORDER BY CASE WHEN c.relkind IN ('r','p') THEN 0 WHEN c.relkind='S' THEN 1 ELSE 2 END LOOP
 EXECUTE format('ALTER %s %I.%I OWNER TO ${roles.migrate}',CASE item.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END,item.nspname,item.relname);
 END LOOP;
END $$;`,
      )
      .replace(/CREATE TABLE cliproxy\.[^\n]+\n/g, "")
      .replace(
        "COMMIT;",
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA affinity_router TO ${roles.control};\nGRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA affinity_router TO ${roles.control};\nCOMMIT;`,
      );
  }
  for (const role of ["control", "migrate", "proxy"])
    files[`${role}/ca.crt`] = ca;
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(output, name);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, content, { flag: "wx", mode: 0o600 });
  }
  if (path.dirname(base) !== output || path.basename(base) !== "bootstrap")
    throw new Error("Unsafe preparation cleanup path.");
  await rm(base, { recursive: true });
  await writeFile(
    path.join(output, "READY"),
    "External workspace provisioning files complete.\n",
    { flag: "wx", mode: 0o600 },
  );
  return destination;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const [file, output, ...extra] = process.argv.slice(2);
    if (!file || !output || extra.length) throw new Error("arguments");
    await prepareExternal(JSON.parse(await readFile(file, "utf8")), output);
    console.log(
      "Private provisioning files created. Apply provision.sql to the empty destination, then start the external Compose deployment. Existing workspaces were not changed.",
    );
  } catch {
    console.error(
      "External preparation failed. Check the destination, CA, permissions and fresh output path. Partial files are retained; do not use them without READY. No credentials were logged.",
    );
    process.exitCode = 1;
  }
}
