import { fileURLToPath } from "node:url";

export function deploymentFile(deployment, project) {
  if (deployment === "strict")
    return fileURLToPath(new URL("compose.yaml", import.meta.url));
  if (
    deployment === "legacy-test" &&
    /^crap-(ci|release-rehearsal)(-[a-z0-9]+)*$/.test(project)
  )
    return fileURLToPath(new URL("compose.legacy-test.yaml", import.meta.url));
  throw new Error(
    "Unsupported deployment; legacy mode is reserved for disposable regression fixtures.",
  );
}

export function validateBackupDeployment(manifest, deployment) {
  const recorded = manifest.version === 1 ? "legacy-test" : manifest.deployment;
  if (![1, 2].includes(manifest.version) || recorded !== deployment)
    throw new Error(
      "Backup deployment does not match. Older non-strict archives require an explicit migration; they cannot be activated as a strict workspace.",
    );
}

export function validateImageOverride(value) {
  const names = [
    "proxy",
    "control",
    "gateway",
    "panel",
    "bootstrap",
    "migrate",
  ];
  if (
    !value ||
    Object.keys(value).join() !== "services" ||
    !value.services ||
    Object.keys(value.services).length !== names.length
  )
    throw new Error(
      "Use the image-only override from the matching release artifact.",
    );
  const remote = value.services.panel?.image?.startsWith("ghcr.io/");
  for (const name of names) {
    const entry = value.services[name];
    if (
      !entry ||
      Object.keys(entry).some((k) => !["image", "pull_policy"].includes(k)) ||
      typeof entry.image !== "string" ||
      !/^[a-z0-9][a-z0-9._/:@-]+$/.test(entry.image) ||
      (name === "proxy"
        ? !/^eceasy\/cli-proxy-api:[a-zA-Z0-9._-]+@sha256:[a-f0-9]{64}$/.test(entry.image) || !["always", "never"].includes(entry.pull_policy)
        : remote
        ? !new RegExp(
            "^ghcr\\.io/darki73/crap-" +
              ({ bootstrap: "panel", migrate: "control" }[name] || name) +
              "@sha256:[a-f0-9]{64}$",
          ).test(entry.image) ||
          !["always", "never"].includes(entry.pull_policy)
        : entry.pull_policy !== "never")
    )
      throw new Error(
        "Release override must contain only local image references with pull_policy: never, or exact CRAP GHCR digests with pull_policy: always/never.",
      );
  }
  if (
    value.services.bootstrap.image !== value.services.panel.image ||
    value.services.migrate.image !== value.services.control.image
  )
    throw new Error(
      "Bootstrap and migration images must match the application release.",
    );
  return value.services.panel.image;
}

export function validateStrictContainers(containers) {
  for (const service of ["gateway", "control"])
    if (!containers[service]?.Config?.Env?.includes("CRAP_STRICT_ROUTING=1"))
      throw new Error(
        "Source is not a strict deployment; back it up with its matching release before migrating.",
      );
  const proxy = containers.proxy;
  const networks = Object.values(proxy?.NetworkSettings?.Networks ?? {});
  if (
    networks.length !== 1 ||
    Object.values(proxy?.NetworkSettings?.Ports ?? {}).some(
      (ports) => ports?.length,
    ) ||
    !proxy?.Config?.Env?.includes("CRAP_STRICT_URL=http://gateway:8320")
  )
    throw new Error(
      "Source proxy isolation does not match the strict deployment.",
    );
  return networks[0].NetworkID;
}
