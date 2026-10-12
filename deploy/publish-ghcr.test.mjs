import { PUBLICATION_SCOPE } from "./vulnerability-policy.mjs";
import { validateImageOverride } from "./deployment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  publicationPlan,
  assertPublicationContext,
  verifyArtifact,
  publishCandidate,
} from "./publish-ghcr.mjs";

const commit = "a".repeat(40),
  roles = ["control", "gateway", "panel"];
const manifest = {
  externalProxy: {
    image: "eceasy/cli-proxy-api:v8.0.24@sha256:" + "e".repeat(64),
  },
  format: 1,
  commit,
  platform: "linux/amd64",
  deployment: "strict",
  images: Object.fromEntries(
    roles.map((r, i) => [
      r,
      {
        image: `crap-${r}:candidate-${commit.slice(0, 12)}`,
        id: "sha256:" + String(i + 1).repeat(64),
      },
    ]),
  ),
};
const env = {
  GITHUB_ACTIONS: "true",
  GITHUB_REPOSITORY: "darki73/crap",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_SHA: commit,
  GITHUB_REF: "refs/tags/v0.1.0-alpha.1",
};
async function fixture(t, change = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "crap-publish-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const gate = {
    scope: PUBLICATION_SCOPE,
    externalFindings: [
      "proxy: external advisory",
      "postgres: external advisory",
    ],
    passed: true,
    blockers: [],
    completedAt: new Date().toISOString(),
    policyHash: "fixture",
    images: [
      {
        name: "proxy",
        ref: manifest.externalProxy.image,
        id: "sha256:" + "8".repeat(64),
      },
      ...roles.map((name) => ({
        name,
        ref: `crap-${name}:alpha-local`,
        id: manifest.images[name].id,
      })),
      {
        name: "postgres",
        ref: "postgres:fixture",
        id: "sha256:" + "9".repeat(64),
      },
    ],
    ...change,
  };
  const files = {
    "manifest.json": JSON.stringify(manifest),
    "images.tar": "synthetic-not-an-image",
    "security-release-gate.json": JSON.stringify(gate),
  };
  for (const [name, content] of Object.entries(files))
    await writeFile(path.join(directory, name), content);
  await writeFile(
    path.join(directory, "SHA256SUMS"),
    Object.entries(files)
      .map(([n, c]) => createHash("sha256").update(c).digest("hex") + "  " + n)
      .join("\n") + "\n",
  );
  return {
    directory,
    version: "v0.1.0-alpha.1",
    env,
    policyHash: async () => "fixture",
  };
}
test("publication targets exact GHCR repositories with version/full commit tags only", () => {
  const plan = publicationPlan(manifest, "v0.1.0-alpha.1", commit);
  assert.equal(plan.length, 3);
  assert.deepEqual(plan[0].tags, [
    "ghcr.io/darki73/crap-control:v0.1.0-alpha.1",
    "ghcr.io/darki73/crap-control:sha-" + commit,
  ]);
  for (const version of [
    "latest",
    "v1.2",
    "v01.2.3",
    "$(touch injected)",
    "v1.2.3\nextra",
  ])
    assert.throws(() => publicationPlan(manifest, version, commit));
  for (const altered of [
    { ...manifest, commit: "b".repeat(40) },
    { ...manifest, platform: "linux/arm64" },
    { ...manifest, deployment: "legacy" },
    { ...manifest, images: { proxy: manifest.images.proxy } },
  ])
    assert.throws(() => publicationPlan(altered, "v1.2.3", commit));
});
test("dry run validates evidence without Docker operations or publication", async (t) => {
  const f = await fixture(t);
  const result = await publishCandidate({
    ...f,
    run: () => assert.fail("Docker must not run"),
    inspectRemote: () => assert.fail("Registry must not be queried"),
  });
  assert.equal(result.published, false);
});
test("tampered or incomplete archives fail before loading", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.directory, "images.tar"), "tampered");
  await assert.rejects(verifyArtifact(f.directory), /checksum mismatch/);
  await writeFile(
    path.join(f.directory, "SHA256SUMS"),
    "a".repeat(64) + "  ../escape\n",
  );
  await assert.rejects(verifyArtifact(f.directory), /Malformed/);
});
test("failed/stale evidence and untagged or foreign runs never reach Docker", async (t) => {
  for (const change of [
    { passed: false },
    { blockers: ["finding"] },
    { completedAt: new Date(0).toISOString() },
    { policyHash: "changed" },
    { scope: undefined },
    { scope: "old-whole-stack-policy" },
    { externalFindings: undefined },
    { externalFindings: ["panel: critical advisory"] },
    { externalFindings: ["unknown: advisory"] },
  ]) {
    const f = await fixture(t, change);
    await assert.rejects(
      publishCandidate({
        ...f,
        publish: true,
        run: () => assert.fail("Docker must not run"),
      }),
    );
  }
  const f = await fixture(t);
  for (const changed of [
    { GITHUB_REPOSITORY: "someone/fork" },
    { GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main" },
    { GITHUB_REF: "refs/tags/v0.1.0-alpha.2" },
    { GITHUB_EVENT_NAME: "pull_request" },
    { GITHUB_ACTIONS: "false" },
    { GITHUB_SHA: "b".repeat(40) },
  ])
    await assert.rejects(
      publishCandidate({
        ...f,
        env: { ...env, ...changed },
        publish: true,
        run: () => assert.fail("Docker must not run"),
      }),
    );
});
function fakeDocker(calls, bad = false) {
  return (args) => {
    calls.push(args);
    if (args[0] === "image") {
      const role = roles.find((r) => args[2].includes("crap-" + r + ":"));
      return JSON.stringify([
        {
          Id: bad ? "wrong" : manifest.images[role].id,
          Os: "linux",
          Architecture: "amd64",
          Config: { Labels: { "org.opencontainers.image.revision": commit } },
          RepoDigests: [
            `ghcr.io/darki73/crap-${role}@sha256:${"d".repeat(64)}`,
          ],
        },
      ]);
    }
    return "";
  };
}
test("loaded mismatch, existing tags and ambiguous registry errors prevent all pushes", async (t) => {
  const f = await fixture(t);
  for (const [bad, remote] of [
    [true, { status: 1, stderr: "manifest unknown" }],
    [false, { status: 0 }],
    [false, { status: 1, stderr: "unauthorized" }],
    [false, { status: 1, stderr: "network timeout" }],
  ]) {
    const calls = [];
    await assert.rejects(
      publishCandidate({
        ...f,
        publish: true,
        run: fakeDocker(calls, bad),
        inspectRemote: () => remote,
      }),
    );
    assert.equal(calls.filter((c) => c[0] === "push").length, 0);
  }
});
test("mock publication reuses all checked images and emits digest-pinned topology override", async (t) => {
  const f = await fixture(t),
    calls = [];
  const result = await publishCandidate({
    ...f,
    publish: true,
    run: fakeDocker(calls),
    inspectRemote: () => ({ status: 1, stderr: "manifest unknown" }),
  });
  const registryChecksums = await readFile(
    path.join(f.directory, "GHCR-SHA256SUMS"),
    "utf8",
  );
  for (const line of registryChecksums.trim().split("\n")) {
    const [digest, file] = line.split("  ");
    assert.equal(
      digest,
      createHash("sha256")
        .update(await readFile(path.join(f.directory, file)))
        .digest("hex"),
    );
  }
  assert.equal(result.published, true);
  assert.equal(calls.filter((c) => c[0] === "push").length, 6);
  assert.equal(calls.filter((c) => c[0] === "build").length, 0);
  const compose = JSON.parse(
    await readFile(path.join(f.directory, "compose.ghcr.json")),
  );
  assert.equal(validateImageOverride(compose), compose.services.panel.image);
  assert.equal(compose.services.bootstrap.image, compose.services.panel.image);
  assert.equal(compose.services.migrate.image, compose.services.control.image);
  assert.match(compose.services.control.image, /@sha256:[a-f0-9]{64}$/);
});

test("publication accepts matching tag pushes and explicit tagged dispatches only", () => {
  for (const event of ["push", "workflow_dispatch"]) {
    assert.doesNotThrow(() =>
      assertPublicationContext("v0.1.0-alpha.1", commit, {
        ...env,
        GITHUB_EVENT_NAME: event,
      }),
    );
  }
  for (const ref of [
    "refs/heads/main",
    "refs/heads/v0.1.0-alpha.1",
    "refs/tags/v0.1.0-alpha.2",
    undefined,
  ]) {
    assert.throws(() =>
      assertPublicationContext("v0.1.0-alpha.1", commit, {
        ...env,
        GITHUB_REF: ref,
      }),
    );
  }
});
