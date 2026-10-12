import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  readFile,
  writeFile,
  chmod,
  open,
  stat,
  unlink,
  rename,
} from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
  scryptSync,
  createHash,
} from "node:crypto";
import path from "node:path";
import { runPrivate } from "./database.mjs";

const MAGIC = Buffer.from("CRAPDB01");
const SCHEMAS = ["affinity_router", "cliproxy"];
const parseEnv = (text) =>
  Object.fromEntries(
    text
      .split(/\r?\n/)
      .filter((x) => /^[A-Z_]+=/.test(x))
      .map((x) => [x.slice(0, x.indexOf("=")), x.slice(x.indexOf("=") + 1)]),
  );
const safe = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length < 4096 &&
  !/[\r\n\0]/.test(value);
const message =
  "Database transfer failed. Check connectivity, permissions, PostgreSQL version and destination state. Credentials were not logged.";

export function connection(input) {
  if (
    !input ||
    !["host", "database", "user", "password"].every((k) => safe(input[k])) ||
    !/^\d+$/.test(String(input.port)) ||
    +input.port < 1 ||
    +input.port > 65535 ||
    !["disable", "require", "verify-full"].includes(input.sslmode)
  )
    throw new Error(
      "Enter a valid host, port, database, user, password and TLS mode.",
    );
  if (
    !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(input.database) ||
    !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(input.user)
  )
    throw new Error(
      "Use simple PostgreSQL database and role names (letters, digits, underscores or hyphens).",
    );
  if (!/^[a-zA-Z0-9.:-]+$/.test(input.host))
    throw new Error("Enter a hostname or IP address without a URL or path.");
  if (
    input.sslmode === "verify-full" &&
    !(
      typeof input.ca === "string" &&
      input.ca.length < 65536 &&
      input.ca.includes("-----BEGIN CERTIFICATE-----")
    )
  )
    throw new Error("Provide the PostgreSQL CA certificate for verified TLS.");
  if (
    input.sslmode === "disable" &&
    !["localhost", "127.0.0.1", "host.docker.internal"].includes(input.host)
  )
    throw new Error(
      "Unencrypted connections are limited to local development or a local port-forward.",
    );
  return {
    host: input.host,
    port: String(input.port),
    database: input.database,
    user: input.user,
    password: input.password,
    sslmode: input.sslmode,
    ca: input.sslmode === "verify-full" ? input.ca : undefined,
  };
}
export function fromDSN(value) {
  const url = new URL(value);
  if (!["postgres:", "postgresql:"].includes(url.protocol))
    throw new Error("Invalid PostgreSQL configuration.");
  return connection({
    host: url.hostname,
    port: url.port || "5432",
    database: decodeURIComponent(url.pathname.slice(1)),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    sslmode: url.searchParams.get("sslmode") || "require",
  });
}
export async function privateDirectory(dir, run = runPrivate) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32")
    await run("icacls", [
      dir,
      "/inheritance:r",
      "/grant:r",
      `${process.env.USERDOMAIN}\\${process.env.USERNAME}:(OI)(CI)F`,
      "SYSTEM:(OI)(CI)F",
    ]);
  else await chmod(dir, 0o700);
}
function passwordKey(password, salt) {
  if (
    typeof password !== "string" ||
    password.length < 16 ||
    password.length > 1024
  )
    throw new Error("Use a backup passphrase of at least 16 characters.");
  return scryptSync(password, salt, 32, { N: 32768, maxmem: 64 * 1024 * 1024 });
}
export async function sealBundle(dump, destination, manifest, password) {
  const salt = randomBytes(16),
    iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", passwordKey(password, salt), iv);
  const header = Buffer.concat([MAGIC, salt, iv]);
  cipher.setAAD(header);
  const metadata = Buffer.from(JSON.stringify(manifest));
  if (metadata.length > 65536)
    throw new Error("Migration manifest is too large.");
  const size = Buffer.alloc(4);
  size.writeUInt32BE(metadata.length);
  await writeFile(destination, header, { mode: 0o600, flag: "wx" });
  await pipeline(
    Readable.from(
      (async function* () {
        yield size;
        yield metadata;
        yield* createReadStream(dump);
      })(),
    ),
    cipher,
    createWriteStream(destination, { flags: "a", mode: 0o600 }),
  );
  const file = await open(destination, "a");
  try {
    await file.write(cipher.getAuthTag());
  } finally {
    await file.close();
  }
}
export async function unsealBundle(source, directory, password) {
  const file = await open(source, "r");
  const clear = path.join(directory, "authenticated.payload");
  try {
    const { size } = await file.stat();
    if (size < 56) throw new Error("Invalid bundle.");
    const header = Buffer.alloc(36),
      tag = Buffer.alloc(16);
    await file.read(header, 0, 36, 0);
    await file.read(tag, 0, 16, size - 16);
    if (!header.subarray(0, 8).equals(MAGIC))
      throw new Error("Invalid bundle.");
    const cipher = createDecipheriv(
      "aes-256-gcm",
      passwordKey(password, header.subarray(8, 24)),
      header.subarray(24),
    );
    cipher.setAAD(header);
    cipher.setAuthTag(tag);
    await pipeline(
      createReadStream(source, { start: 36, end: size - 17 }),
      cipher,
      createWriteStream(clear, { flags: "wx", mode: 0o600 }),
    );
    const payload = await open(clear, "r");
    let manifest, offset;
    try {
      const length = Buffer.alloc(4);
      await payload.read(length, 0, 4, 0);
      const count = length.readUInt32BE();
      if (count > 65536 || count < 2) throw new Error("Invalid manifest.");
      const data = Buffer.alloc(count);
      await payload.read(data, 0, count, 4);
      manifest = JSON.parse(data.toString());
      offset = count + 4;
      if (
        manifest.version !== 1 ||
        manifest.schemas?.join(",") !== SCHEMAS.join(",") ||
        !manifest.counts ||
        !manifest.secrets ||
        !["rehearsal", "cutover"].includes(manifest.mode)
      )
        throw new Error("Invalid manifest.");
      for (const key of [
        "AFFINITY_ID_KEY",
        "AFFINITY_CONTROL_TOKEN",
        "PANEL_MANAGEMENT_KEY",
      ])
        if (!safe(manifest.secrets[key])) throw new Error("Invalid secrets.");
    } finally {
      await payload.close();
    }
    const dump = path.join(directory, "workspace.dump");
    await pipeline(
      createReadStream(clear, { start: offset }),
      createWriteStream(dump, { flags: "wx", mode: 0o600 }),
    );
    if ((await hashFile(dump)) !== manifest.sha256) {
      await unlink(dump);
      throw new Error("Archive integrity failed.");
    }
    return { manifest, dump };
  } catch {
    throw new Error(
      "Cannot unlock this backup. Check its passphrase and file integrity.",
    );
  } finally {
    await file.close();
    await unlink(clear).catch(() => {});
  }
}
async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

// PostgreSQL tools run without a shell. Credentials live in an ACL-protected
// temporary env-file; only its path appears in process arguments.
export function postgresTools(directory, run = runPrivate, native = false) {
  async function tool(target, command, args) {
    const config = connection(target),
      name = randomUUID();
    const envFile = path.join(directory, `${name}.env`),
      caFile = path.join(directory, `${name}.crt`);
    const env = {
      PGHOST:
        !native && ["localhost", "127.0.0.1"].includes(config.host)
          ? "host.docker.internal"
          : config.host,
      PGPORT: config.port,
      PGDATABASE: config.database,
      PGUSER: config.user,
      PGPASSWORD: config.password,
      PGSSLMODE: config.sslmode,
    };
    if (config.ca) {
      await writeFile(caFile, config.ca, { mode: 0o600 });
      env.PGSSLROOTCERT = native ? caFile : `/work/${name}.crt`;
    }
    await writeFile(
      envFile,
      Object.entries(env)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n") + "\n",
      { mode: 0o600 },
    );
    try {
      if (native)
        return await run(
          command,
          args.map((x) => x.replace("/work/", directory + path.sep)),
          { env: { ...process.env, ...env } },
        );
      return await run("docker", [
        "run",
        "--rm",
        "--add-host",
        "host.docker.internal:host-gateway",
        "--env-file",
        envFile,
        "--mount",
        `type=bind,source=${directory},target=/work`,
        "postgres:17",
        command,
        ...args,
      ]);
    } catch {
      throw new Error(message);
    } finally {
      await unlink(envFile).catch(() => {});
      await unlink(caFile).catch(() => {});
    }
  }
  const sql = (target, query) =>
    tool(target, "psql", [
      "-X",
      "-A",
      "-t",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      query,
    ]);
  async function inspect(target, empty = false) {
    const version = +(await sql(target, "SHOW server_version_num")).trim();
    if (version < 170000 || version >= 180000)
      throw new Error(
        "This transfer adapter requires PostgreSQL 17 on both ends.",
      );
    const names = JSON.parse(
      (
        await sql(
          target,
          "SELECT COALESCE(json_agg(nspname),'[]'::json) FROM pg_namespace WHERE nspname IN ('affinity_router','cliproxy')",
        )
      ).trim(),
    );
    if (empty) {
      if (names.length)
        throw new Error(
          "Destination already contains workspace schemas. Choose a fresh database; nothing was overwritten.",
        );
      return { ready: true, version: 17 };
    }
    if (names.length !== 2)
      throw new Error(
        "Both workspace schemas must exist before moving this workspace.",
      );
    // Quoted table names come from PostgreSQL, never from browser input.
    const tables = JSON.parse(
      (
        await sql(
          target,
          "SELECT json_agg(format('%I.%I',schemaname,tablename) ORDER BY schemaname,tablename) FROM pg_tables WHERE schemaname IN ('affinity_router','cliproxy')",
        )
      ).trim(),
    );
    const counts = {};
    for (const table of tables)
      counts[table] = (
        await sql(target, `SELECT count(*) FROM ${table}`)
      ).trim();
    return counts;
  }
  return {
    inspect,
    dump: (target) =>
      tool(target, "pg_dump", [
        "--format=custom",
        "--schema=affinity_router",
        "--schema=cliproxy",
        "--file=/work/workspace.dump",
      ]),
    async restore(target, expected) {
      await inspect(target, true);
      await tool(target, "pg_restore", [
        "--dbname=" + target.database,
        "--single-transaction",
        "--exit-on-error",
        "--no-owner",
        "--no-acl",
        "/work/workspace.dump",
      ]);
      const actual = await inspect(target);
      if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new Error(
          "Destination row-count verification failed. Keep the source paused and inspect both databases before activation.",
        );
      return { tables: Object.keys(actual).length, verified: true };
    },
  };
}

export async function writeDeployment(directory, target, secrets, manifest) {
  const url = new URL("postgresql://localhost");
  url.hostname = target.host;
  url.port = target.port;
  url.pathname = "/" + encodeURIComponent(target.database);
  url.username = target.user;
  url.password = target.password;
  url.searchParams.set("sslmode", target.sslmode);
  if (target.sslmode === "verify-full") {
    url.searchParams.set("sslrootcert", "/etc/crap/postgres-ca.crt");
    await writeFile(path.join(directory, "postgres-ca.crt"), target.ca, {
      mode: 0o600,
    });
  }
  const output = {
    AFFINITY_DATABASE_URL: url.toString(),
    PGSTORE_DSN: url.toString(),
    PGSTORE_SCHEMA: "cliproxy",
    PGSTORE_LOCAL_PATH: "/var/lib/cliproxy-pg",
    ...Object.fromEntries(
      ["AFFINITY_ID_KEY", "AFFINITY_CONTROL_TOKEN", "PANEL_MANAGEMENT_KEY"].map(
        (k) => [k, secrets[k]],
      ),
    ),
  };
  await writeFile(
    path.join(directory, "deployment.env"),
    Object.entries(output)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") + "\n",
    { mode: 0o600, flag: "wx" },
  );
  await writeFile(
    path.join(directory, "handoff.json"),
    JSON.stringify(
      {
        version: 1,
        mode: manifest.mode,
        createdAt: manifest.createdAt,
        schemas: SCHEMAS,
        counts: manifest.counts,
        activation:
          "Stop the source before starting the destination. Rehearsal copies must never serve traffic. Install the matching affinity plugin and configure its service URL and preserved keys. Use a fresh PGSTORE local spool. Reconfigure deployment-specific addresses in the restored proxy configuration. Neither service has been switched automatically.",
      },
      null,
      2,
    ),
    { mode: 0o600, flag: "wx" },
  );
}

export function createDatabaseTransfer({
  root,
  run = runPrivate,
  fetcher = fetch,
}) {
  const base = path.join(root, ".local-panel/database/transfers");
  const stateFile = path.join(base, "state.json"),
    lockFile = path.join(root, ".local-panel/database/migration.lock");
  let running = false,
    job = Promise.resolve();
  let state = { phase: "idle" };
  async function settings() {
    return parseEnv(
      await readFile(path.join(root, ".local-panel/affinity.env"), "utf8"),
    );
  }
  async function control(endpoint, body) {
    const env = await settings();
    const response = await fetcher(
      new URL(endpoint, env.AFFINITY_CONTROL_URL),
      {
        method: body ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${env.AFFINITY_CONTROL_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: "error",
      },
    );
    if (!response.ok)
      throw new Error(
        "Control service cannot enter or leave migration maintenance. Check that it is running the migration-capable version.",
      );
    return response.json();
  }
  async function save(value) {
    state = { ...state, ...value, updatedAt: new Date().toISOString() };
    const temp = stateFile + ".tmp";
    await writeFile(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
    await rename(temp, stateFile);
  }
  async function status() {
    if (!running) {
      try {
        state = JSON.parse(await readFile(stateFile, "utf8"));
      } catch (e) {
        if (e.code !== "ENOENT") throw new Error("Cannot read transfer state.");
      }
      if (!["idle", "complete", "failed", "attention"].includes(state.phase))
        state = {
          ...state,
          phase: "attention",
          error:
            "Transfer was interrupted. Source may be paused; inspect the saved job before resuming.",
        };
    }
    return { ...state, running };
  }
  async function inspectProxy() {
    const [info] = JSON.parse(
      await run("docker", ["inspect", "cliproxy-panel-proxy-1"]),
    );
    if (
      info.Config?.Labels?.["com.docker.compose.project"] !==
        "cliproxy-panel" ||
      !info.State?.Running
    )
      throw new Error("The managed source proxy must be running.");
    const dsn = info.Config.Env.find((x) =>
      x.startsWith("PGSTORE_DSN="),
    )?.slice(12);
    const source = fromDSN((await settings()).AFFINITY_DATABASE_URL);
    const proxy = fromDSN(dsn);
    if (
      proxy.host === "cliproxy-affinity-postgres-1" &&
      proxy.port === "5432"
    ) {
      proxy.host = "127.0.0.1";
      proxy.port = "55432";
    }
    if (proxy.host === "host.docker.internal") proxy.host = "127.0.0.1";
    if (source.host === "localhost") source.host = "127.0.0.1";
    if (JSON.stringify(source) !== JSON.stringify(proxy))
      throw new Error(
        "Both services must use the same PostgreSQL database before migration.",
      );
    return source;
  }
  async function start(input) {
    if (running) throw new Error("A transfer is already running.");
    const previous = await status();
    if (running) throw new Error("A transfer is already running.");
    if (
      (previous.sourcePaused && input.action !== "restore") ||
      previous.phase === "attention"
    )
      throw new Error("Resolve the previous transfer before starting another.");
    if (
      !["direct", "export", "restore"].includes(input.action) ||
      !["rehearsal", "cutover"].includes(input.mode) ||
      input.confirm !== "transfer-workspace"
    )
      throw new Error("Confirm the transfer mode first.");
    const target = input.action !== "export" ? connection(input.target) : null;
    passwordKey(input.passphrase, Buffer.alloc(16));
    if (
      input.action === "restore" &&
      !/^[0-9a-f-]{36}$/.test(input.upload || "")
    )
      throw new Error("Upload an encrypted workspace backup first.");
    running = true;
    let lock;
    try {
      await privateDirectory(base, run);
      lock = await open(lockFile, "wx", 0o600);
      state = {
        id: randomUUID(),
        phase: "checking",
        action: input.action,
        mode: input.mode,
        sourcePaused: Boolean(previous.sourcePaused),
      };
      await save({});
    } catch {
      running = false;
      if (lock) {
        await lock.close();
        await unlink(lockFile).catch(() => {});
      }
      throw new Error(
        "Database migration is locked or its state directory is unavailable.",
      );
    }
    const dir = path.join(base, state.id);
    job = (async () => {
      let sourceStopped = Boolean(previous.sourcePaused),
        maintenance = Boolean(previous.sourcePaused);
      try {
        await privateDirectory(dir, run);
        const pg = postgresTools(dir, run);
        if (target) await pg.inspect(target, true);
        let manifest;
        if (input.action === "restore") {
          await save({ phase: "unlocking" });
          ({ manifest } = await unsealBundle(
            path.join(base, `upload-${input.upload}.crapdb`),
            dir,
            input.passphrase,
          ));
        } else {
          const source = await inspectProxy();
          const pause = await control("/maintenance");
          if (pause.paused)
            throw new Error("Source control service is already paused.");
          await save({ phase: "pausing", sourcePaused: true });
          // No forced kill: let the server finish its graceful shutdown.
          sourceStopped = true;
          await run("docker", [
            "stop",
            "--timeout",
            "-1",
            "cliproxy-panel-proxy-1",
          ]);
          // Preserve and replay the plugin's durable outbox before snapshotting.
          const spool = path.join(dir, "outbox");
          await run("docker", [
            "cp",
            "cliproxy-panel-proxy-1:/CLIProxyAPI/plugins/affinity-spool",
            spool,
          ]);
          const { readdir } = await import("node:fs/promises");
          for (const entry of await readdir(spool, { withFileTypes: true })) {
            if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
            const file = path.join(spool, entry.name);
            if ((await stat(file)).size > 1024 * 1024)
              throw new Error(
                "A queued usage record needs inspection before migration.",
              );
            const event = JSON.parse(await readFile(file, "utf8"));
            if (
              !["/usage", "/journal", "/cache-observations"].includes(
                event.Path,
              )
            )
              throw new Error("Unknown usage outbox record.");
            await control(event.Path, event.Body);
          }
          maintenance = true;
          await control("/maintenance", { paused: true });
          await save({ phase: "copying" });
          const counts = await pg.inspect(source);
          await pg.dump(source);
          const env = await settings(),
            panel = parseEnv(
              await readFile(path.join(root, ".local-panel/.env"), "utf8"),
            );
          const secrets = {
            AFFINITY_ID_KEY: env.AFFINITY_ID_KEY,
            AFFINITY_CONTROL_TOKEN: env.AFFINITY_CONTROL_TOKEN,
            PANEL_MANAGEMENT_KEY: panel.PANEL_MANAGEMENT_KEY,
          };
          if (Object.values(secrets).some((x) => !safe(x)))
            throw new Error("Required workspace identity keys are missing.");
          manifest = {
            version: 1,
            schemas: SCHEMAS,
            createdAt: new Date().toISOString(),
            mode: input.mode,
            counts,
            secrets,
            sha256: await hashFile(path.join(dir, "workspace.dump")),
          };
          await sealBundle(
            path.join(dir, "workspace.dump"),
            path.join(dir, "workspace.crapdb"),
            manifest,
            input.passphrase,
          );
          await save({ backupReady: true, tables: Object.keys(counts).length });
        }
        if (target) {
          await save({ phase: "restoring" });
          const verified = await pg.restore(target, manifest.counts);
          await writeDeployment(dir, target, manifest.secrets, manifest);
          await save(verified);
        }
        if (
          sourceStopped &&
          input.action !== "restore" &&
          input.mode === "rehearsal"
        ) {
          await control("/maintenance", { paused: false });
          maintenance = false;
          await run("docker", ["start", "cliproxy-panel-proxy-1"]);
          sourceStopped = false;
        }
        await save({
          phase: "complete",
          sourcePaused: sourceStopped,
          mode: manifest.mode,
          artifactDirectory: `.local-panel/database/transfers/${state.id}`,
          error: null,
        });
      } catch (error) {
        // Never silently reactivate a source after a partial/final transfer.
        await save({
          phase: sourceStopped || maintenance ? "attention" : "failed",
          sourcePaused: sourceStopped || maintenance,
          error:
            error.message === message
              ? message
              : [
                    "Cannot unlock",
                    "Destination",
                    "Both services",
                    "Both workspace",
                    "This transfer",
                    "The managed",
                    "Source control",
                    "Control service",
                    "Required workspace",
                    "Unknown usage",
                    "A queued",
                  ].some((x) => error.message.startsWith(x))
                ? error.message
                : "Transfer did not complete. Source and any destination data were retained for inspection.",
        });
      } finally {
        await unlink(path.join(dir, "workspace.dump")).catch(() => {});
        await lock.close();
        await unlink(lockFile).catch(() => {});
        running = false;
      }
    })().catch(() => {
      state = {
        ...state,
        phase: "attention",
        error:
          "Transfer state could not be saved. Inspect both services before continuing.",
      };
      running = false;
    });
    return { ...state, running: true };
  }
  return {
    start,
    status,
    wait: () => job,
    async download() {
      const current = await status();
      if (
        !current.backupReady ||
        running ||
        !/^[0-9a-f-]{36}$/.test(current.id)
      )
        throw new Error("No completed encrypted backup is available.");
      return path.join(base, current.id, "workspace.crapdb");
    },
    async upload(stream) {
      if (running) throw new Error("A transfer is already running.");
      await privateDirectory(base, run);
      const id = randomUUID(),
        file = path.join(base, `upload-${id}.crapdb`);
      let size = 0;
      try {
        await pipeline(
          Readable.from(
            (async function* () {
              for await (const chunk of stream) {
                size += chunk.length;
                if (size > 2 * 1024 ** 3)
                  throw new Error(
                    "Backup exceeds the 2 GiB browser upload limit. Use the restore CLI.",
                  );
                yield chunk;
              }
            })(),
          ),
          createWriteStream(file, { flags: "wx", mode: 0o600 }),
        );
      } catch (error) {
        await unlink(file).catch(() => {});
        throw error;
      }
      return { upload: id };
    },
    async resume(confirm) {
      if (running || confirm !== "destination-is-stopped")
        throw new Error(
          "Confirm that the destination is stopped before resuming the source.",
        );
      const current = await status();
      if (running) throw new Error("A transfer is already running.");
      if (!current.sourcePaused)
        throw new Error("This transfer has no paused source.");
      running = true;
      let lock;
      try {
        lock = await open(lockFile, "wx", 0o600);
        await control("/maintenance", { paused: false });
        await run("docker", ["start", "cliproxy-panel-proxy-1"]);
        await save({
          phase: "complete",
          sourcePaused: false,
          mode: "rehearsal",
          error: null,
        });
      } finally {
        if (lock) {
          await lock.close();
          await unlink(lockFile).catch(() => {});
        }
        running = false;
      }
      return status();
    },
  };
}
