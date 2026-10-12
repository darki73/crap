// Operator tool for the packaged single-owner Compose deployment. No Docker
// socket is exposed to the dashboard. Secrets and command stderr stay private.
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { readFile, mkdir, mkdtemp, open, stat, rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { privateDirectory } from "../control-panel/database-transfer.mjs";
import { encryptArchive, decryptArchive } from "./archive.mjs";
import {
  deploymentFile,
  validateBackupDeployment,
  validateStrictContainers,
  validateImageOverride,
} from "./deployment.mjs";

const volumes = [
  "bootstrap-state",
  "postgres-secrets",
  "proxy-secrets",
  "control-secrets",
  "panel-secrets",
  "proxy-data",
  "control-data",
  "panel-data",
];
const names = ["workspace.dump", ...volumes.map((v) => `${v}.tar`)];
async function docker(args, { source, destination } = {}) {
  const child = spawn("docker", args, {
    windowsHide: true,
    stdio: [source ? "pipe" : "ignore", "pipe", "pipe"],
  });
  child.stderr.resume();
  const exited = new Promise((resolve, reject) => {
    child.on("error", () => reject(new Error("Docker could not start.")));
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              "Docker operation failed; inspect service state. Private command output was withheld.",
            ),
          ),
    );
  });
  let output = [];
  const outputTask = destination
    ? pipeline(
        child.stdout,
        createWriteStream(destination, { flags: "wx", mode: 0o600 }),
      )
    : (async () => {
        let size = 0;
        for await (const chunk of child.stdout) {
          size += chunk.length;
          if (size > 4 << 20) throw new Error("Unexpected Docker output size.");
          output.push(chunk);
        }
      })();
  const inputTask = source
    ? pipeline(createReadStream(source), child.stdin)
    : Promise.resolve();
  try {
    await Promise.all([exited, inputTask, outputTask]);
  } catch (error) {
    child.kill();
    throw error;
  }
  return Buffer.concat(output).toString();
}
async function digest(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
async function pack(dir, destination, project, deployment) {
  const files = [];
  for (const name of names)
    files.push({
      name,
      size: (await stat(path.join(dir, name))).size,
      sha256: await digest(path.join(dir, name)),
    });
  const manifest = Buffer.from(
    JSON.stringify({
      version: 2,
      deployment,
      project,
      createdAt: new Date().toISOString(),
      files,
    }),
  );
  const length = Buffer.alloc(4);
  length.writeUInt32BE(manifest.length);
  await pipeline(
    Readable.from(
      (async function* () {
        yield length;
        yield manifest;
        for (const name of names) yield* createReadStream(path.join(dir, name));
      })(),
    ),
    createWriteStream(destination, { flags: "wx", mode: 0o600 }),
  );
}
async function unpack(source, dir, deployment) {
  const input = await open(source, "r");
  let manifest, offset, total;
  try {
    total = (await input.stat()).size;
    const length = Buffer.alloc(4);
    await input.read(length, 0, 4, 0);
    const n = length.readUInt32BE();
    if (n < 2 || n > 65536 || n + 4 > total)
      throw new Error("Invalid workspace manifest.");
    const bytes = Buffer.alloc(n);
    await input.read(bytes, 0, n, 4);
    manifest = JSON.parse(bytes.toString());
    offset = n + 4;
  } finally {
    await input.close();
  }
  validateBackupDeployment(manifest, deployment);
  if (manifest.files?.length !== names.length)
    throw new Error("Unsupported workspace backup.");
  for (let i = 0; i < names.length; i++) {
    const f = manifest.files[i];
    if (
      f.name !== names[i] ||
      !Number.isSafeInteger(f.size) ||
      f.size <= 0 ||
      f.size > total - offset ||
      !/^[a-f0-9]{64}$/.test(f.sha256)
    )
      throw new Error("Invalid workspace contents.");
    const target = path.join(dir, names[i]);
    await pipeline(
      createReadStream(source, { start: offset, end: offset + f.size - 1 }),
      createWriteStream(target, { flags: "wx", mode: 0o600 }),
    );
    if ((await digest(target)) !== f.sha256)
      throw new Error("Workspace checksum mismatch.");
    offset += f.size;
  }
  if (offset !== total) throw new Error("Unexpected workspace data.");
  return manifest;
}
export async function workspaceBackup({
  action,
  project,
  file,
  password,
  keepStopped = false,
  deployment = "strict",
  imagesFile,
}) {
  const composeFile = deploymentFile(deployment, project);
  const imageOverride = imagesFile ? path.resolve(imagesFile) : null;
  const helper = imageOverride
    ? validateImageOverride(JSON.parse(await readFile(imageOverride, "utf8")))
    : "crap-panel:alpha-local";
  if (
    !["backup", "restore"].includes(action) ||
    !/^crap(?:-[a-z0-9]+)*$/.test(project)
  )
    throw new Error(
      "Use backup/restore and a CRAP Compose project name (crap or crap-…).",
    );
  if (typeof password !== "string" || password.length < 16)
    throw new Error("Use a passphrase of at least 16 characters.");
  file = path.resolve(file);
  // Stage on the same filesystem in an owner-only directory; never use a
  // directory supplied by the archive. Cleanup only this freshly created path.
  const parent = path.dirname(file);
  await mkdir(parent, { recursive: true });
  const temp = await mkdtemp(path.join(parent, ".crap-backup-"));
  await privateDirectory(temp);
  const compose = ["compose", "-p", project, "-f", composeFile];
  if (imageOverride) compose.push("-f", imageOverride);
  const running = [];
  const stopped = [];
  let restoreStarted = false;
  try {
    if (action === "backup") {
      try {
        await stat(file);
        throw new Error("Backup destination already exists.");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const containers = {};
      for (const service of ["gateway", "panel", "proxy", "control"]) {
        const [info] = JSON.parse(
          await docker(["inspect", `${project}-${service}-1`]),
        );
        if (info.Config.Labels?.["com.docker.compose.project"] !== project)
          throw new Error("Source is not the expected Compose deployment.");
        containers[service] = info;
        if (info.State.Running) running.push(service);
      }
      if (deployment === "strict") {
        const networkID = validateStrictContainers(containers);
        const [network] = JSON.parse(
          await docker(["network", "inspect", networkID]),
        );
        if (!network.Internal)
          throw new Error(
            "Source proxy network is not internal; backup refused before stopping services.",
          );
      }
      for (const v of volumes) {
        const [info] = JSON.parse(
          await docker(["volume", "inspect", `${project}_${v}`]),
        );
        if (info.Labels?.["com.docker.compose.project"] !== project)
          throw new Error("Source volume ownership mismatch.");
      }
      // Unlimited drain preserves long inference streams. Ctrl-C cancels the
      // operator command; inspect stopped services before resuming manually.
      for (const service of running) {
        await docker([...compose, "stop", "--timeout", "-1", service]);
        stopped.push(service);
      }
      await docker(
        [
          "exec",
          `${project}-postgres-1`,
          "pg_dump",
          "-U",
          "postgres",
          "-d",
          "crap",
          "-Fc",
          "--schema=affinity_router",
          "--schema=cliproxy",
        ],
        { destination: path.join(temp, "workspace.dump") },
      );
      for (const v of volumes)
        await docker(
          [
            "run",
            "--rm",
            "--network",
            "none",
            "--read-only",
            "--user",
            "0:0",
            "--mount",
            `type=volume,source=${project}_${v},target=/snapshot,readonly`,
            "--entrypoint",
            "tar",
            helper,
            "-C",
            "/snapshot",
            "-cf",
            "-",
            ".",
          ],
          { destination: path.join(temp, `${v}.tar`) },
        );
      await pack(temp, path.join(temp, "payload"), project, deployment);
      await encryptArchive(path.join(temp, "payload"), file, password);
      console.log(
        "Encrypted workspace backup complete: database, matching secrets, private-access identity and queued events.",
      );
    } else {
      // Refuse ALL existing target state, even if it looks empty. No destructive
      // restore flag exists. The source is never contacted by restore.
      const existing = await docker(["volume", "ls", "--format", "{{.Name}}"]);
      if (existing.split(/\r?\n/).some((v) => v.startsWith(`${project}_`)))
        throw new Error(
          "Restore requires a fresh project with no existing volumes.",
        );
      if (
        (
          await docker([
            "ps",
            "-aq",
            "--filter",
            `label=com.docker.compose.project=${project}`,
          ])
        ).trim()
      )
        throw new Error("Restore target already has containers.");
      await decryptArchive(file, path.join(temp, "payload"), password);
      await unpack(path.join(temp, "payload"), temp, deployment);
      restoreStarted = true;
      for (const v of volumes) {
        await docker([
          "volume",
          "create",
          "--label",
          `com.docker.compose.project=${project}`,
          "--label",
          `com.docker.compose.volume=${v}`,
          `${project}_${v}`,
        ]);
        await docker(
          [
            "run",
            "--rm",
            "-i",
            "--network",
            "none",
            "--read-only",
            "--user",
            "0:0",
            "--mount",
            `type=volume,source=${project}_${v},target=/snapshot`,
            "--entrypoint",
            "tar",
            helper,
            "-C",
            "/snapshot",
            "-xf",
            "-",
          ],
          { source: path.join(temp, `${v}.tar`) },
        );
      }
      await docker([...compose, "up", "-d", "--wait", "postgres"]);
      await docker(
        [
          "exec",
          "-i",
          `${project}-postgres-1`,
          "pg_restore",
          "-U",
          "postgres",
          "-d",
          "crap",
          "--clean",
          "--if-exists",
          "--exit-on-error",
        ],
        { source: path.join(temp, "workspace.dump") },
      );
      await docker([...compose, "stop", "postgres"]);
      console.log(
        "Workspace restored and left stopped. Stop the original owner before starting this project; never run duplicate OAuth or Tailscale identities.",
      );
    }
  } catch (error) {
    if (restoreStarted)
      console.error(
        "Restore is incomplete; target volumes were retained for inspection. Do not start the target.",
      );
    throw error;
  } finally {
    // This is the exact path returned by mkdtemp under the private backup dir.
    if (
      path.dirname(temp) !== parent ||
      !path.basename(temp).startsWith(".crap-backup-")
    )
      throw new Error("Unsafe staging cleanup path.");
    try {
      await rm(temp, { recursive: true, force: true });
    } finally {
      if (action === "backup" && !keepStopped && stopped.length)
        await docker([...compose, "start", ...stopped.toReversed()]);
    }
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [action, project, file, passwordFile, ...flags] = process.argv.slice(2);
  let imagesFile,
    keepStopped = false,
    invalid = false;
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === "--keep-stopped") keepStopped = true;
    else if (flags[i] === "--images" && flags[i + 1] && !imagesFile)
      imagesFile = flags[++i];
    else invalid = true;
  }
  if (!file || !passwordFile || invalid) {
    console.error(
      "Usage: node deploy/workspace-backup.mjs backup|restore crap-project backup-path passphrase-file [--keep-stopped] [--images compose.images.json]",
    );
    process.exitCode = 1;
  } else
    try {
      const password = (
        await readFile(path.resolve(passwordFile), "utf8")
      ).trimEnd();
      await workspaceBackup({
        action,
        project,
        file,
        password,
        keepStopped,
        imagesFile,
      });
    } catch {
      console.error(
        "Workspace transfer failed. Verify paths, passphrase, Docker access and deployment state. Secrets were not logged.",
      );
      process.exitCode = 1;
    }
}
