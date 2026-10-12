import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertReleaseEvidence,
  securityPolicyHash,
} from "./vulnerability-policy.mjs";

const roles = ["control", "gateway", "panel"];
export function publicationPlan(manifest, version, commit) {
  if (
    !/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[a-z0-9]+(?:[.-][a-z0-9]+)*)?$/.test(
      version || "",
    ) ||
    version.length > 100
  )
    throw new Error(
      "Use a version such as v0.1.0-alpha.1; latest and arbitrary tags are not allowed.",
    );
  if (
    manifest.format !== 1 ||
    manifest.platform !== "linux/amd64" ||
    manifest.deployment !== "strict" ||
    !/^[a-f0-9]{40}$/.test(manifest.commit || "") ||
    manifest.commit !== commit
  )
    throw new Error(
      "Candidate must be strict linux/amd64 from this exact source commit.",
    );
  if (
    Object.keys(manifest.images || {})
      .sort()
      .join() !== [...roles].sort().join()
  )
    throw new Error(
      "Candidate must contain exactly the three CRAP application images.",
    );
  return roles.map((role) => {
    const image = manifest.images[role];
    if (
      !/^sha256:[a-f0-9]{64}$/.test(image.id || "") ||
      image.image !== `crap-${role}:candidate-${commit.slice(0, 12)}`
    )
      throw new Error("Invalid candidate image identity.");
    const repository = `ghcr.io/darki73/crap-${role}`;
    return {
      role,
      id: image.id,
      local: image.image,
      repository,
      tags: [`${repository}:${version}`, `${repository}:sha-${commit}`],
    };
  });
}

export async function verifyArtifact(directory) {
  const content = await readFile(path.join(directory, "SHA256SUMS"), "utf8");
  const seen = new Set();
  for (const line of content.trim().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(line);
    if (!match || seen.has(match[2]) || match[2] === "SHA256SUMS")
      throw new Error("Malformed or duplicate artifact checksum.");
    seen.add(match[2]);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path.join(directory, match[2])))
      hash.update(chunk);
    if (hash.digest("hex") !== match[1])
      throw new Error(`Artifact checksum mismatch: ${match[2]}`);
  }
  for (const name of [
    "images.tar",
    "manifest.json",
    "security-release-gate.json",
  ])
    if (!seen.has(name)) throw new Error(`Missing required checksum: ${name}`);
}

export async function publishCandidate({
  directory,
  version,
  publish = false,
  env = process.env,
  run = (args) =>
    execFileSync("docker", args, {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 8 << 20,
    }).trim(),
  inspectRemote = (tag) =>
    spawnSync("docker", ["manifest", "inspect", tag], {
      encoding: "utf8",
      windowsHide: true,
    }),
  policyHash = securityPolicyHash,
}) {
  await verifyArtifact(directory);
  const manifest = JSON.parse(
    await readFile(path.join(directory, "manifest.json"), "utf8"),
  );
  if (!/^eceasy\/cli-proxy-api:[a-zA-Z0-9._-]+@sha256:[a-f0-9]{64}$/.test(manifest.externalProxy?.image || ""))
    throw new Error("Candidate must identify the exact official external proxy image.");
  const plan = publicationPlan(
    manifest,
    version,
    env.GITHUB_SHA || manifest.commit,
  );
  const gate = JSON.parse(
    await readFile(path.join(directory, "security-release-gate.json"), "utf8"),
  );
  if (gate.images?.find((i) => i.name === "proxy")?.ref !== manifest.externalProxy.image)
    throw new Error("External proxy does not match scanned evidence.");
  // Recheck freshness and policy after artifact transfer, before any Docker operation.
  assertReleaseEvidence(
    gate,
    [
      ...plan.map((p) => ({
        name: p.role,
        ref: `crap-${p.role}:alpha-local`,
        id: p.id,
      })),
      ...gate.images.filter((i) => i.name === "postgres" || i.name === "proxy"),
    ],
    Date.now(),
    await policyHash(),
  );
  if (!publish) return { published: false, plan };
  if (
    env.GITHUB_ACTIONS !== "true" ||
    env.GITHUB_REPOSITORY !== "darki73/crap" ||
    env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    env.GITHUB_SHA !== manifest.commit
  )
    throw new Error(
      "Publishing is restricted to a manual workflow in darki73/crap at the candidate commit.",
    );
  run(["load", "--input", path.join(directory, "images.tar")]);
  for (const p of plan) {
    const image = JSON.parse(run(["image", "inspect", p.local]))[0];
    if (
      image.Id !== p.id ||
      image.Config.Labels?.["org.opencontainers.image.revision"] !==
        manifest.commit ||
      image.Os !== "linux" ||
      image.Architecture !== "amd64"
    )
      throw new Error(`Loaded image mismatch: ${p.role}`);
  }
  // Refuse replacement. Authentication/network failures are not proof of absence.
  for (const tag of plan.flatMap((p) => p.tags)) {
    const result = inspectRemote(tag);
    if (result.status === 0)
      throw new Error(`Tag already exists; refusing to replace ${tag}`);
    if (
      result.error ||
      !/manifest unknown|no such manifest/i.test(result.stderr || "")
    )
      throw new Error(`Could not verify tag absence: ${tag}`);
  }
  const services = {},
    published = [];
  for (const p of plan) {
    for (const tag of p.tags) {
      run(["tag", p.id, tag]);
      run(["push", tag]);
    }
    const remote = JSON.parse(run(["image", "inspect", p.tags[0]]))[0];
    const digest = remote.RepoDigests?.find((d) =>
      d.startsWith(p.repository + "@sha256:"),
    );
    if (!digest || !/@sha256:[a-f0-9]{64}$/.test(digest))
      throw new Error(`Missing registry digest: ${p.role}`);
    services[p.role] = { image: digest, pull_policy: "always" };
    published.push({ ...p, digest });
  }
  services.proxy = { image: manifest.externalProxy.image, pull_policy: "always" };
  services.bootstrap = services.panel;
  services.migrate = services.control;
  await writeFile(
    path.join(directory, "compose.ghcr.json"),
    JSON.stringify({ services }, null, 2) + "\n",
  );
  await writeFile(
    path.join(directory, "published-images.json"),
    JSON.stringify(
      { version, commit: manifest.commit, images: published },
      null,
      2,
    ) + "\n",
  );
  const registryChecksums = [];
  for (const file of ["compose.ghcr.json", "published-images.json"]) {
    const digest = createHash("sha256")
      .update(await readFile(path.join(directory, file)))
      .digest("hex");
    registryChecksums.push(digest + "  " + file);
  }
  await writeFile(path.join(directory, "GHCR-SHA256SUMS"), registryChecksums.join("\n") + "\n");
  return { published: true, plan: published };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [directory, version, flag, ...extra] = process.argv.slice(2);
  if (!directory || !version || (flag && flag !== "--publish") || extra.length)
    throw new Error(
      "Usage: node deploy/publish-ghcr.mjs ARTIFACT_DIRECTORY VERSION [--publish]",
    );
  console.log(
    JSON.stringify(
      await publishCandidate({
        directory: path.resolve(directory),
        version,
        publish: flag === "--publish",
      }),
      null,
      2,
    ),
  );
}
