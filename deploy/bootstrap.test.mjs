import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bootstrap } from "./bootstrap.mjs";

test("bootstrap preserves identities, isolates database roles, and refuses mismatched or lost state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "crap-bootstrap-"));
  try {
    await bootstrap(root, { ownership: false });
    const first = await readFile(path.join(root, "seed/keys.json"), "utf8");
    await bootstrap(root, { ownership: false });
    assert.equal(
      await readFile(path.join(root, "seed/keys.json"), "utf8"),
      first,
    );
    const control = await readFile(
      path.join(root, "control/service.env"),
      "utf8",
    );
    const proxy = await readFile(path.join(root, "proxy/service.env"), "utf8");
    const panel = await readFile(path.join(root, "panel/service.env"), "utf8");
    assert.match(control, /postgresql:\/\/crap_app:/);
    assert.match(proxy, /postgresql:\/\/cliproxy_app:/);
    assert.doesNotMatch(panel, /postgresql/);
    assert.doesNotMatch(control, /MANAGEMENT_KEY/);
    const config = JSON.parse(
      await readFile(path.join(root, "proxy/config.example.yaml"), "utf8"),
    );
    assert.equal(config.plugins.configs["affinity-router"].enabled, true);
    await writeFile(path.join(root, "panel/service.env"), "unexpected");
    await assert.rejects(bootstrap(root, { ownership: false }), /do not match/);
    assert.equal(
      await readFile(path.join(root, "panel/service.env"), "utf8"),
      "unexpected",
    );
    await unlink(path.join(root, "seed/keys.json"));
    await assert.rejects(
      bootstrap(root, { ownership: false }),
      /state is missing/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("strict bootstrap configures the execution gate and refuses silent conversion of legacy state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "crap-bootstrap-strict-"));
  const previous = process.env.CRAP_STRICT_ROUTING;
  try {
    delete process.env.CRAP_STRICT_ROUTING;
    await bootstrap(root, { ownership: false });
    const configPath = path.join(root, "proxy/config.example.yaml");
    const legacy = await readFile(configPath, "utf8");
    process.env.CRAP_STRICT_ROUTING = "1";
    await assert.rejects(bootstrap(root, { ownership: false }), /do not match/);
    assert.equal(await readFile(configPath, "utf8"), legacy);
    // A fresh config using the same fixture identity proves the strict defaults.
    await unlink(configPath);
    await bootstrap(root, { ownership: false });
    const config = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(config.requests["proxy-url"], "http://gateway:8321");
    assert.equal(config.routing.retry["request-retry"], 0);
    assert.equal(config.routing.retry["max-retry-interval"], 0);
    assert.equal(config.routing.cooldown["disable-cooling"], true);
    await bootstrap(root, { ownership: false });
  } finally {
    if (previous === undefined) delete process.env.CRAP_STRICT_ROUTING;
    else process.env.CRAP_STRICT_ROUTING = previous;
    await rm(root, { recursive: true, force: true });
  }
});
