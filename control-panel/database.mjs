import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  writeFile,
  copyFile,
  chmod,
  open,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const execute = promisify(execFile);
export async function runPrivate(command, args, options = {}) {
  try {
    const { stdout } = await execute(command, args, {
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      ...options,
    });
    return stdout;
  } catch {
    throw new Error(
      "Managed service operation failed. No credentials were logged.",
    );
  }
}

export function localDatabaseURL(value, docker = false) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid local database configuration.");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    url.port !== "55432" ||
    url.pathname !== "/affinity" ||
    !url.username ||
    !url.password ||
    url.searchParams.get("sslmode") !== "disable"
  ) {
    throw new Error(
      "This adapter supports the existing local PostgreSQL on port 55432 only.",
    );
  }
  if (docker) url.hostname = "host.docker.internal";
  return url.toString();
}

const parseEnv = (text) =>
  Object.fromEntries(
    text
      .split(/\r?\n/)
      .filter((line) => /^[A-Z_]+=/.test(line))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );

// This adapter is deliberately opt-in and local. It does not accept a browser
// supplied DSN, command, filesystem path, container name or database target.
export function createLocalDatabaseManager({
  root,
  managementKey,
  run = runPrivate,
  fetcher = fetch,
  databaseHelper,
}) {
  const local = path.join(root, ".local-panel");
  const directory = path.join(local, "database");
  const stateFile = path.join(directory, "state.json");
  const override = path.join(directory, "compose.json");
  const container = "cliproxy-panel-proxy-1";
  let running = false;
  let job = Promise.resolve();
  let current = { phase: "idle" };
  let lock;
  async function env() {
    return parseEnv(await readFile(path.join(local, "affinity.env"), "utf8"));
  }
  async function privateDirectory(dir) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if (process.platform === "win32") {
      const account = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
      await run("icacls", [
        dir,
        "/inheritance:r",
        "/grant:r",
        `${account}:(OI)(CI)F`,
        "SYSTEM:(OI)(CI)F",
      ]);
    } else await chmod(dir, 0o700);
  }
  async function save(value) {
    current = { ...current, ...value, updatedAt: new Date().toISOString() };
    await writeFile(stateFile, JSON.stringify(current, null, 2), {
      mode: 0o600,
    });
  }
  async function helper(action, backup) {
    if (databaseHelper) return databaseHelper(action, backup);
    const settings = await env();
    const input = JSON.stringify({
      action,
      dsn: localDatabaseURL(settings.AFFINITY_DATABASE_URL),
      directory: backup || directory,
    });
    // execFile's input is streamed via a separate stdin pipe, never shell text.
    const executable = path.join(
      local,
      process.platform === "win32" ? "database-helper.exe" : "database-helper",
    );
    return new Promise((resolve, reject) => {
      const child = execFile(
        executable,
        [],
        { cwd: root, windowsHide: true, maxBuffer: 65536 },
        (error, stdout) => {
          if (error)
            return reject(
              new Error(
                "Database operation failed. Check database availability, permissions and migration state.",
              ),
            );
          try {
            resolve(JSON.parse(stdout));
          } catch {
            reject(new Error("Invalid database helper response."));
          }
        },
      );
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    });
  }
  async function inspect() {
    let info;
    try {
      [info] = JSON.parse(await run("docker", ["inspect", container]));
    } catch {
      throw new Error("The managed local proxy could not be inspected.");
    }
    if (
      info.Config?.Labels?.["com.docker.compose.project"] !==
        "cliproxy-panel" ||
      info.Config?.Labels?.["com.docker.compose.service"] !== "proxy" ||
      !info.Mounts?.some(
        (m) => m.Destination === "/root/.cli-proxy-api" && m.Type === "volume",
      )
    )
      throw new Error("The managed local proxy could not be verified.");
    return info;
  }
  async function proxy(route) {
    const response = await fetcher(
      `${process.env.PROXY_URL || "http://127.0.0.1:8317"}/v8/management/${route}`,
      {
        headers: { Authorization: `Bearer ${managementKey}` },
        redirect: "error",
      },
    );
    if (!response.ok)
      throw new Error("The proxy management connection could not be verified.");
    return response.json();
  }
  async function status() {
    if (running) return { ...current, running: true, available: true };
    try {
      current = JSON.parse(await readFile(stateFile, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT")
        current = {
          phase: "attention",
          error: "Stored setup state could not be read.",
        };
    }
    // An interrupted migration must not be reported as complete or retried.
    if (!["idle", "active", "failed", "attention"].includes(current.phase))
      return {
        ...current,
        phase: "attention",
        running: false,
        available: true,
        error:
          "Setup was interrupted. Inspect the backup and service state before retrying.",
      };
    return { ...current, running: false, available: true };
  }
  async function check(internal = false) {
    if (running && !internal)
      throw new Error("Database setup is already running.");
    const settings = await env();
    localDatabaseURL(settings.AFFINITY_DATABASE_URL);
    const [info, database, credentials, control] = await Promise.all([
      inspect(),
      helper("check"),
      proxy("credentials"),
      fetcher(new URL("/healthz", settings.AFFINITY_CONTROL_URL), {
        redirect: "error",
      }),
    ]);
    if (!control.ok)
      throw new Error("CRAP's database connection is not healthy.");
    const active = info.Config.Env?.some((value) =>
      value.startsWith("PGSTORE_DSN="),
    );
    const files = (credentials.files || []).filter(
      (file) => !file.runtime_only,
    );
    return {
      available: true,
      database: database.database,
      history: database.history,
      accounts: files.length,
      crap: "connected",
      proxy: active ? "postgresql" : "files",
      canApply: !active && !database.proxySchema,
      conflict: database.proxySchema && !active,
      endpoint: "127.0.0.1:55432",
      schema: "cliproxy",
      tls: "Local development connection (TLS disabled)",
    };
  }
  const compose = (withDatabase) => [
    "compose",
    "--project-directory",
    root,
    "--env-file",
    path.join(local, ".env"),
    "-f",
    path.join(root, "docker-compose.panel.yml"),
    ...(withDatabase ? ["-f", override] : []),
    ...(existsSync(path.join(local, "strict/active.json"))
      ? ["-f", path.join(root, "deploy/local.strict.yaml")]
      : []),
    ...(existsSync(path.join(local, "strict/images.json"))
      ? ["-f", path.join(local, "strict/images.json")]
      : []),
    "up",
    "-d",
    "--no-deps",
    "--no-build",
    "--force-recreate",
    "proxy",
  ];
  async function waitForAccounts(expected) {
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const { files = [] } = await proxy("credentials");
        if (expected.every((name) => files.some((file) => file.name === name)))
          return files;
      } catch {
        /* Startup is not complete yet. */
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(
      "The restarted proxy did not restore all account registrations.",
    );
  }
  async function migrate() {
    let stopped = false;
    let restarted = false;
    let expected = [];
    try {
      const preflight = await checkInternal();
      if (!preflight.canApply)
        throw new Error(
          "Proxy storage is already configured or the destination schema is occupied.",
        );
      const before = await proxy("credentials");
      expected = (before.files || [])
        .filter((file) => !file.runtime_only)
        .map((file) => file.name);
      const backup = path.join(directory, `backup-${randomUUID()}`);
      await privateDirectory(backup);
      await save({
        phase: "backing-up",
        backup: path.basename(backup),
        accounts: expected.length,
      });
      await run("docker", ["stop", container]);
      stopped = true;
      await run("docker", [
        "cp",
        `${container}:/root/.cli-proxy-api/.`,
        path.join(backup, "auths"),
      ]);
      await copyFile(
        path.join(local, "runtime", "config.yaml"),
        path.join(backup, "config.yaml"),
      );
      await chmod(path.join(backup, "config.yaml"), 0o600);
      await save({ phase: "importing" });
      const imported = await helper("import", backup);
      if (imported.credentials < expected.length)
        throw new Error(
          "The imported credential count does not match the source.",
        );
      const settings = await env();
      await writeFile(
        path.join(directory, "proxy.env"),
        `PGSTORE_DSN=${localDatabaseURL(settings.AFFINITY_DATABASE_URL, true)}\nPGSTORE_SCHEMA=cliproxy\nPGSTORE_LOCAL_PATH=/var/lib/cliproxy-pg\n`,
        { mode: 0o600 },
      );
      await writeFile(
        override,
        JSON.stringify(
          {
            services: {
              proxy: {
                env_file: [path.join(directory, "proxy.env")],
                volumes: ["panel-pgstore:/var/lib/cliproxy-pg"],
              },
            },
            volumes: { "panel-pgstore": {} },
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      await save({ phase: "restarting" });
      restarted = true;
      await run("docker", compose(true));
      const files = await waitForAccounts(expected);
      if (
        expected.some(
          (name) =>
            !files
              .find((file) => file.name === name)
              ?.path?.includes("/var/lib/cliproxy-pg/"),
        )
      )
        throw new Error(
          "Proxy credential paths do not match PostgreSQL storage.",
        );
      const verified = await helper("verify");
      if (
        verified.credentials < expected.length ||
        verified.history < preflight.history
      )
        throw new Error("Stored data verification failed.");
      // Record both services as a single deployment configuration. CRAP keeps
      // its existing DSN and identity keys, so history references do not change.
      await save({
        phase: "active",
        crap: "postgresql",
        proxy: "postgresql",
        history: verified.history,
        accounts: expected.length,
        error: null,
      });
    } catch (error) {
      let recovered = !stopped;
      if (stopped) {
        try {
          // If the PG instance ever ran it may have rotated tokens. Never fall
          // back to stale files automatically after that point.
          if (!restarted) {
            await run("docker", compose(false));
            await waitForAccounts(expected);
            recovered = true;
          }
        } catch {
          recovered = false;
        }
      }
      await save({
        phase: recovered ? "failed" : "attention",
        error: error.message,
        recovery: recovered
          ? "Original file-backed proxy restored. Database imports, if any, are retained for inspection."
          : "Automatic rollback stopped to avoid restoring stale OAuth tokens. Preserve the database and backup; inspect the running proxy before recovery.",
      });
    } finally {
      if (lock) {
        await lock.close();
        lock = null;
        await unlink(path.join(directory, "migration.lock")).catch(() => {});
      }
      running = false;
    }
  }
  async function checkInternal() {
    return check(true);
  }
  return {
    status,
    check,
    wait: () => job,
    async apply() {
      if (running) throw new Error("Database setup is already running.");
      const previous = await status();
      if (previous.phase === "active" || previous.phase === "attention")
        throw new Error(
          "Database setup is already active or requires recovery. No new migration was started.",
        );
      if (running) throw new Error("Database setup is already running.");
      running = true;
      try {
        await privateDirectory(directory);
        lock = await open(path.join(directory, "migration.lock"), "wx", 0o600);
        await save({ phase: "checking", error: null, recovery: null });
      } catch {
        running = false;
        if (lock) {
          await lock.close();
          lock = null;
          await unlink(path.join(directory, "migration.lock")).catch(() => {});
        }
        throw new Error(
          "Database setup is locked or its private state directory is unavailable.",
        );
      }
      job = migrate().catch(() => {
        running = false;
        current = {
          phase: "attention",
          error:
            "Setup state could not be saved. Inspect the backup and services before recovery.",
        };
      });
      return { phase: "checking", running: true, available: true };
    },
  };
}
