import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  writeFile,
  readFile,
  access,
  rm,
  rmdir,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const local = path.join(root, ".local-panel");
await mkdir(local, { recursive: true });
const temp = await mkdtemp(path.join(local, "context-audit-"));
const output = path.join(temp, "export");
const id = randomUUID();
const probes = [
  `design/context-audit-${id}.md`,
  `control-panel/.env.crap-audit-${id}`,
  `deploy/context-audit-${id}.env`,
  `deploy/context-audit-${id}.crap`,
  `deploy/context-audit-${id}.crapdb`,
  `deploy/context-audit-${id}.dump`,
  ...["log", "jsonl", "har", "sqlite", "pem", "key", "kubeconfig", "local.yaml"].map((ext) => `deploy/context-audit-${id}.${ext}`),
  `affinity-router/.crap-backup-${id}/workspace.dump`,
  ...["control-panel", "affinity-router"].flatMap((dir) => ["env", "log", "har", "key", "sqlite", "local.yaml"].map((ext) => dir + "/context-audit-" + id + "." + ext)),
];
const created = [];
try {
  for (const relative of probes) {
    const target = path.resolve(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "synthetic-build-context-probe", {
      flag: "wx",
      mode: 0o600,
    });
    created.push(target);
    assert.ok(
      execFileSync("git", ["check-ignore", relative], { cwd: root }).length,
      `Git must ignore ${relative}`,
    );
  }
  const result = spawnSync(
    "docker",
    [
      "build",
      "-f",
      "deploy/Dockerfile",
      "--target",
      "source-audit",
      "--output",
      `type=local,dest=${output}`,
      ".",
    ],
    { cwd: root, windowsHide: true, maxBuffer: 4 << 20 },
  );
  if (result.error || result.status !== 0)
    throw new Error(
      "Build context export failed; private build output withheld.",
    );
  for (const relative of [
    ...probes,
    "design",
    ".local-panel",
    ".git",
    "control-panel/node_modules",
    "cmd", "internal", "sdk", "go.mod", "go.sum",
  ])
    await assert.rejects(
      access(path.join(output, relative)),
      { code: "ENOENT" },
      `Build context must exclude ${relative}`,
    );
  for (const relative of ["LICENSE", "deploy/NOTICE.md"])
    assert.deepEqual(
      await readFile(path.join(output, relative)),
      await readFile(path.join(root, relative)),
    );
  for (const [directory, dockerfile, required] of [
    ["control-panel", "Dockerfile", ["package.json", "src/main.tsx", "scripts/start.mjs"]],
    ["affinity-router", "Dockerfile.plugin", ["go.mod", "go.sum", "plugin/runtime.go", "storage/migrations/001_usage.sql"]],
  ]) {
    const moduleOutput = path.join(temp, directory);
    const exported = spawnSync("docker", ["build", "-f", dockerfile, "--target", "source-audit", "--output", "type=local,dest=" + moduleOutput, "."], {
      cwd: path.join(root, directory), windowsHide: true, maxBuffer: 4 << 20,
    });
    if (exported.error || exported.status !== 0) throw new Error("Standalone build context export failed; private output withheld.");
    for (const relative of probes.filter(p => p.startsWith(directory + "/")))
      await assert.rejects(access(path.join(moduleOutput, relative.slice(directory.length + 1))), {code: "ENOENT"});
    for (const relative of ["node_modules", ".git", ".local-panel"])
      await assert.rejects(access(path.join(moduleOutput, relative)), {code: "ENOENT"});
    for (const relative of required) await access(path.join(moduleOutput, relative));
  }
  console.log(
    "PASS: release, standalone panel and plugin build contexts exclude private probes and dependencies; required source and attribution remain.",
  );
} finally {
  for (const target of created) {
    if (!target.startsWith(root) || !target.includes(id))
      throw new Error("Unsafe probe cleanup");
    await rm(target, { force: true });
  }
  const stagingProbe = path.join(root, "affinity-router", `.crap-backup-${id}`);
  await rmdir(stagingProbe).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (
    path.dirname(temp) !== local ||
    !path.basename(temp).startsWith("context-audit-")
  )
    throw new Error("Unsafe export cleanup");
  await rm(temp, { recursive: true, force: true });
}
