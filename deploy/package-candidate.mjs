// Run only after the checks on a clean, committed checkout. Never publishes.
import { execFileSync } from "node:child_process";
import {
  mkdir,
  writeFile,
  copyFile,
  readdir,
  readFile,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertReleaseEvidence,
  securityPolicyHash,
} from "./vulnerability-policy.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const out = path.join(root, "release-artifacts");
const run = (cmd, args, options = {}) =>
  (
    execFileSync(cmd, args, {
      cwd: root,
      windowsHide: true,
      maxBuffer: 8 << 20,
      ...options,
    }) ?? ""
  )
    .toString()
    .trim();
if (run("git", ["status", "--porcelain", "--untracked-files=normal"]))
  throw new Error(
    "Candidate packaging requires a clean committed checkout; private working files are never archived.",
  );
// Recheck publication-visible content locally even when packaging outside CI.
run(process.execPath, ["deploy/scan-privacy.mjs"], { stdio: "inherit" });
run(process.execPath, ["deploy/scan-secrets.mjs"], { stdio: "inherit" });
const commit = run("git", ["rev-parse", "HEAD"]);
const securityDir = path.join(root, ".local-panel", "security-review");
const securityGate = JSON.parse(
  await readFile(path.join(securityDir, "release-gate.json"), "utf8"),
);
const releaseCompose = JSON.parse(
  run("docker", [
    "compose",
    "-f",
    "deploy/compose.yaml",
    "config",
    "--format",
    "json",
  ]),
);
assertReleaseEvidence(
  securityGate,
  ["proxy", "control", "gateway", "panel", "postgres"].map((name) => {
    const ref = releaseCompose.services[name].image;
    return {
      name,
      ref,
      id: run("docker", ["image", "inspect", "--format", "{{.Id}}", ref]),
    };
  }),
  Date.now(),
  await securityPolicyHash(),
);
await mkdir(out); // Refuse to overwrite any previous artifact set.
const tag = `candidate-${commit.slice(0, 12)}`;
const services = {},
  images = {};
for (const name of ["control", "gateway", "panel"]) {
  const built = JSON.parse(
    run("docker", ["image", "inspect", `crap-${name}:alpha-local`]),
  )[0];
  if (built.Config.Labels?.["org.opencontainers.image.revision"] !== commit)
    throw new Error(
      `Image ${name} was not built for this source revision. Rebuild with CRAP_REVISION before packaging.`,
    );
  if (built.Os !== "linux" || built.Architecture !== "amd64")
    throw new Error(
      "This candidate workflow currently supports Linux amd64 images only.",
    );
  const image = `crap-${name}:${tag}`;
  run("docker", ["tag", `crap-${name}:alpha-local`, image]);
  images[name] = {
    image,
    id: run("docker", ["image", "inspect", "--format", "{{.Id}}", image]),
  };
  services[name] = { image, pull_policy: "never" };
}
services.proxy = { image: releaseCompose.services.proxy.image, pull_policy: "always" };
services.bootstrap = services.panel;
services.migrate = services.control;
run(
  "docker",
  [
    "save",
    "--output",
    path.join(out, "images.tar"),
    ...Object.values(images).map((i) => i.image),
  ],
  { stdio: "inherit" },
);
// git archive includes committed source only, not ignored backups or credentials.
run("git", [
  "archive",
  "--format=tar",
  "--output=" + path.join(out, "source.tar"),
  commit,
]);
await writeFile(
  path.join(out, "compose.images.json"),
  JSON.stringify({ services }, null, 2),
);
await writeFile(
  path.join(out, "manifest.json"),
  JSON.stringify(
    {
      format: 1,
      commit,
      tag,
      platform: "linux/amd64",
      deployment: "strict",
      externalProxy: { repository: "https://github.com/router-for-me/CLIProxyAPI", image: releaseCompose.services.proxy.image },
      images,
      createdAt: new Date().toISOString(),
    },
    null,
    2,
  ),
);
for (const file of ["LICENSE", "deploy/NOTICE.md", "deploy/CANDIDATES.md"])
  await copyFile(path.join(root, file), path.join(out, path.basename(file)));
// Inventories are generated from the installed lockfiles/module graphs in CI.
for (const file of [
  "panel-sbom.json",
  "affinity-modules.json",
  "tailnet-modules.json",
])
  await copyFile(
    path.join(root, ".local-panel", "candidate-inventory", file),
    path.join(out, file),
  );
const hashes = [];
for (const name of [
  "release-gate.json",
  "crap-findings.json",
  "external-findings.json",
  "images-summary.json",
  "go-summary.json",
  "npm-all.json",
  "scanner-version.json",
  "applicability.json",
  "proxy.json",
  "control.json",
  "gateway.json",
  "panel.json",
  "postgres.json",
])
  await copyFile(
    path.join(securityDir, name),
    path.join(out, `security-${name}`),
  );
for (const name of (await readdir(out)).sort()) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path.join(out, name)))
    hash.update(chunk);
  hashes.push(`${hash.digest("hex")}  ${name}`);
}
await writeFile(path.join(out, "SHA256SUMS"), hashes.join("\n") + "\n");
console.log(
  `Candidate ${tag}: images, committed source, inventories and checksums prepared. Nothing published.`,
);
