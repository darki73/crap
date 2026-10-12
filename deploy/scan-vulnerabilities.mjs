// Download public advisories; scan local source and image archives without uploading them.
import { spawnSync } from "node:child_process";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseGoReport,
  imageFindings,
  evaluateRelease,
  securityPolicyHash,
} from "./vulnerability-policy.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = path.join(root, ".local-panel", "security-review");
const scanner =
  "aquasec/trivy:0.75.0@sha256:af6acf9a6b85dfe389a1941505c0ce9efef52a4719635e1a962f022a3d855daa";
await mkdir(out, { recursive: true });
// Remove the success marker first, so interrupted reruns cannot reuse a past pass.
await rm(path.join(out, "release-gate.json"), { force: true });
const run = (args, options = {}) => {
  const result = spawnSync("docker", args, {
    cwd: root,
    windowsHide: true,
    encoding: "utf8",
    maxBuffer: 64 << 20,
    ...options,
  });
  if (options.log) {
    // Per-command logs contain scanner/build diagnostics, never live service logs.
    return { ...result, log: options.log };
  }
  if (result.error || result.status !== 0)
    throw new Error(
      `docker ${args[0]} failed: ${result.error?.message || result.stderr || result.stdout}`,
    );
  return result.stdout;
};
const images = ["control", "gateway", "panel"].map((name) => ({
  name,
  ref: `crap-${name}:alpha-local`,
}));
const compose = JSON.parse(
  run(["compose", "-f", "deploy/compose.yaml", "config", "--format", "json"]),
);
images.unshift({ name: "proxy", ref: compose.services.proxy.image });
run(["pull", compose.services.proxy.image]);
images.push({ name: "postgres", ref: compose.services.postgres.image });
run(["pull", compose.services.postgres.image]);
const startingPolicyHash = await securityPolicyHash();
const evidence = { images: [] };
const manifest = { startedAt: new Date().toISOString(), scanner, images: [] };
for (const { name, ref } of images) {
  const info = JSON.parse(run(["image", "inspect", ref]))[0];
  console.log(`Scanning ${name} (${info.Id.slice(0, 19)})`);
  const archive = path.join(out, `${name}.tar`);
  try {
    run(["save", "-o", archive, info.Id]);
    const args = [
      "run",
      "--rm",
      "--mount",
      `type=bind,source=${out},target=/reports`,
      "--mount",
      "type=volume,source=crap-trivy-cache,target=/root/.cache/trivy",
      scanner,
    ];
    const log = run([
      ...args,
      "image",
      "--input",
      `/reports/${name}.tar`,
      "--scanners",
      "vuln",
      "--list-all-pkgs",
      "--format",
      "json",
      "--output",
      `/reports/${name}.json`,
      "--timeout",
      "15m",
      "--no-progress",
    ]);
    await writeFile(path.join(out, `${name}.scan.log`), log);
    const report = JSON.parse(
      await readFile(path.join(out, `${name}.json`), "utf8"),
    );
    const findings = imageFindings(report);
    manifest.images.push({
      name,
      ownership:
        name === "proxy"
          ? "external"
          : name === "postgres"
            ? "external-database"
            : "crap",
      ref,
      id: info.Id,
      platform: `${info.Os}/${info.Architecture}`,
      os: report.Metadata.OS,
      findings,
    });
    const probe = run([
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--entrypoint",
      "sh",
      "--mount",
      `type=bind,source=${path.join(root, "deploy/security-probe.sh")},target=/security-probe.sh,readonly`,
      info.Id,
      "/security-probe.sh",
    ]);
    const facts = Object.fromEntries(
      probe
        .trim()
        .split(/\r?\n/)
        .map((line) => line.split("=")),
    );
    if (
      ["systemdHomed", "archiveTar", "minizip", "infocmp"].some(
        (key) => !["absent", "present"].includes(facts[key]),
      )
    )
      throw new Error("Incomplete image applicability probe.");
    evidence.images.push({ name, id: info.Id, facts });
    await writeFile(
      path.join(out, "images-summary.json"),
      JSON.stringify(manifest, null, 2),
    );
    console.log(
      `${name}: ${findings.length} findings; ${findings.filter((v) => ["HIGH", "CRITICAL"].includes(v.severity)).length} high/critical`,
    );
  } finally {
    await rm(archive, { force: true });
  }
}
manifest.completedAt = new Date().toISOString();
await writeFile(
  path.join(out, "images-summary.json"),
  JSON.stringify(manifest, null, 2),
);
console.log(`Reports saved to ${out}`);

const goImage = "crap-vulnerability-check:local";
const build = run(
  [
    "build",
    "-f",
    "deploy/Dockerfile",
    "--target",
    "vulnerability-check",
    "-t",
    goImage,
    ".",
  ],
  { log: "scanner-build" },
);
await writeFile(
  path.join(out, "scanner-build.log"),
  `${build.stdout || ""}${build.stderr || ""}`,
);
if (build.error || build.status !== 0)
  throw new Error("Go scanner build failed; see scanner-build.log.");
const goImageID = JSON.parse(run(["image", "inspect", goImage]))[0].Id;
// Scan the independently installed official binary; no upstream source is vendored.
const proxyContainer = run(["create", compose.services.proxy.image]).trim();
try {
  run([
    "cp",
    proxyContainer + ":/CLIProxyAPI/CLIProxyAPI",
    path.join(out, "proxy-binary"),
  ]);
} finally {
  run(["rm", proxyContainer]);
}
const go = [];
for (const [name, directory, os] of [
  ["proxy", "/src", "linux"],
  ["affinity", "/src/affinity-router", "linux"],
  ["tailnet", "/src/control-panel/tailnet-gateway", "linux"],
  ["tailnet-windows", "/src/control-panel/tailnet-gateway", "windows"],
  ["tailnet-darwin", "/src/control-panel/tailnet-gateway", "darwin"],
]) {
  console.log(
    `Scanning Go ${name === "proxy" ? "external binary" : "source"}: ${name}`,
  );
  const result = run(
    [
      "run",
      "--rm",
      "-e",
      `GOOS=${os}`,
      "--mount",
      `type=bind,source=${out},target=/reports,readonly`,
      "-w",
      directory,
      goImageID,
      "-json",
      ...(name === "proxy"
        ? ["-mode=binary", "/reports/proxy-binary"]
        : ["./..."]),
    ],
    { log: name },
  );
  await writeFile(path.join(out, `go-${name}.json`), result.stdout || "");
  await writeFile(path.join(out, `go-${name}.stderr.log`), result.stderr || "");
  // JSON mode uses exit zero even for findings; always inspect the event stream.
  if (result.error || result.status !== 0)
    throw new Error(`Go scan failed: ${name}`);
  go.push({ name, ...parseGoReport(result.stdout) });
}
await writeFile(
  path.join(out, "go-summary.json"),
  JSON.stringify({ image: goImageID, reports: go }, null, 2),
);

// Audit an isolated copy of the exact lockfile, including development dependencies.
const nodeBase = (
  await readFile(path.join(root, "deploy/Dockerfile"), "utf8")
).match(/^FROM (node:\S+) AS ui-build$/m)?.[1];
if (!nodeBase) throw new Error("Pinned Node build image not found.");
const audit = run(
  [
    "run",
    "--rm",
    "--mount",
    `type=bind,source=${path.join(root, "control-panel/package-lock.json")},target=/input/package-lock.json,readonly`,
    "-w",
    "/tmp",
    nodeBase,
    "sh",
    "-c",
    "cp /input/package-lock.json ./package-lock.json && npm audit --json",
  ],
  { log: "npm" },
);
await writeFile(path.join(out, "npm-all.json"), audit.stdout || "");
await writeFile(path.join(out, "npm-audit.log"), audit.stderr || "");
if (audit.error || ![0, 1].includes(audit.status))
  throw new Error("npm audit failed.");
const npm = JSON.parse(audit.stdout);
if (npm.error) throw new Error("npm advisory lookup failed.");
const policy = JSON.parse(
  await readFile(
    new URL("./vulnerability-exceptions.json", import.meta.url),
    "utf8",
  ),
);
const { scope, blockers, externalFindings, exceptions } = evaluateRelease({
  images: manifest.images,
  go,
  npm,
  policy,
  evidence,
});
await writeFile(
  path.join(out, "applicability.json"),
  JSON.stringify({ evidence, policy, exceptions }, null, 2),
);
const policyHash = await securityPolicyHash();
if (policyHash !== startingPolicyHash)
  throw new Error("Security inputs changed during the scan; rerun it.");
const version = run([
  "run",
  "--rm",
  "--mount",
  "type=volume,source=crap-trivy-cache,target=/root/.cache/trivy",
  scanner,
  "version",
  "--format",
  "json",
]);
await writeFile(path.join(out, "scanner-version.json"), version);
await writeFile(
  path.join(out, "release-gate.json"),
  JSON.stringify(
    {
      scope,
      externalFindings,
      completedAt: new Date().toISOString(),
      passed: blockers.length === 0,
      images: manifest.images.map(({ name, ref, id }) => ({ name, ref, id })),
      goImage: goImageID,
      policyHash,
      exceptionExpiry: exceptions.some((e) =>
        ["control", "gateway", "panel"].includes(e.image),
      )
        ? policy.expiresAt
        : null,
      exceptions,
      blockers,
    },
    null,
    2,
  ),
);
console.log(
  `CRAP publication gate: ${blockers.length ? "BLOCKED" : "PASS"} (${blockers.length} CRAP blockers; ${externalFindings.length} informational external findings).`,
);
if (blockers.length) process.exitCode = 1;
