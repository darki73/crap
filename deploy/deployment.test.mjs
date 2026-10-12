import test from "node:test";
import assert from "node:assert/strict";
import {
  deploymentFile,
  validateBackupDeployment,
  validateStrictContainers,
  validateImageOverride,
} from "./deployment.mjs";

test("public backups select strict deployment and cannot activate legacy archives", () => {
  assert.match(deploymentFile("strict", "crap"), /compose\.yaml$/);
  assert.throws(() => deploymentFile("legacy-test", "crap"), /disposable/);
  assert.match(deploymentFile("legacy-test", "crap-ci-backup"), /legacy-test/);
  validateBackupDeployment({ version: 2, deployment: "strict" }, "strict");
  assert.throws(
    () => validateBackupDeployment({ version: 1 }, "strict"),
    /does not match/,
  );
  assert.throws(
    () =>
      validateBackupDeployment(
        { version: 2, deployment: "legacy-test" },
        "strict",
      ),
    /does not match/,
  );
  assert.throws(
    () =>
      validateBackupDeployment({ version: 3, deployment: "strict" }, "strict"),
    /does not match/,
  );
  validateBackupDeployment({ version: 1 }, "legacy-test");
});

test("release image overrides cannot change deployment topology or inject runtime settings", () => {
  const services = Object.fromEntries(
    ["control", "gateway", "panel"].map((name) => [
      name,
      { image: `crap-${name}:candidate-fixture`, pull_policy: "never" },
    ]),
  );
  services.proxy = { image: "eceasy/cli-proxy-api:v8.0.24@sha256:" + "b".repeat(64), pull_policy: "always" };
  services.bootstrap = { ...services.panel };
  services.migrate = { ...services.control };
  assert.equal(validateImageOverride({ services }), services.panel.image);
  assert.throws(
    () => validateImageOverride({ services, networks: {} }),
    /image-only/,
  );
  assert.throws(
    () =>
      validateImageOverride({
        services: {
          ...services,
          proxy: { ...services.proxy, networks: ["public"] },
        },
      }),
    /only local image/,
  );
  assert.throws(
    () =>
      validateImageOverride({
        services: { ...services, bootstrap: services.control },
      }),
    /must match/,
  );
});

test("backup refuses a weakened execution boundary before stopping services", () => {
  const fixture = () => ({
    gateway: { Config: { Env: ["CRAP_STRICT_ROUTING=1"] } },
    control: { Config: { Env: ["CRAP_STRICT_ROUTING=1"] } },
    proxy: {
      Config: { Env: ["CRAP_STRICT_URL=http://gateway:8320"] },
      NetworkSettings: {
        Networks: { private: { NetworkID: "private-network" } },
        Ports: {},
      },
    },
  });
  assert.equal(validateStrictContainers(fixture()), "private-network");
  const missing = fixture();
  missing.gateway.Config.Env = [];
  assert.throws(() => validateStrictContainers(missing), /not a strict/);
  const exposed = fixture();
  exposed.proxy.NetworkSettings.Ports["8317/tcp"] = [{ HostPort: "8317" }];
  assert.throws(() => validateStrictContainers(exposed), /isolation/);
  const bypass = fixture();
  bypass.proxy.NetworkSettings.Networks.public = { NetworkID: "public" };
  assert.throws(() => validateStrictContainers(bypass), /isolation/);
});

test("GHCR recovery accepts exact role digests, never tags or arbitrary repositories", () => {
  const services = Object.fromEntries(
    ["control", "gateway", "panel"].map((name) => [
      name,
      {
        image: "ghcr.io/darki73/crap-" + name + "@sha256:" + "a".repeat(64),
        pull_policy: "always",
      },
    ]),
  );
  services.proxy = { image: "eceasy/cli-proxy-api:v8.0.24@sha256:" + "b".repeat(64), pull_policy: "always" };
  services.bootstrap = { ...services.panel };
  services.migrate = { ...services.control };
  assert.equal(validateImageOverride({ services }), services.panel.image);
  for (const image of [
    "ghcr.io/darki73/crap-proxy:latest",
    "ghcr.io/other/crap-proxy@sha256:" + "a".repeat(64),
    services.control.image,
  ])
    assert.throws(() =>
      validateImageOverride({
        services: { ...services, proxy: { image, pull_policy: "always" } },
      }),
    );
  assert.throws(() =>
    validateImageOverride({
      services: {
        ...services,
        proxy: { ...services.proxy, command: ["override"] },
      },
    }),
  );
});
