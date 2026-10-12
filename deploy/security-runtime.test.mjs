import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const image = "crap-control:alpha-local";
const run = (env = {}, args = ["CLIProxyAPI", "--local-model"], setup = "") =>
  spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--tmpfs",
      "/fixture:mode=1777",
      "-w",
      "/fixture",
      ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
      "--entrypoint",
      "sh",
      image,
      "-c",
      `set -eu\n${setup}\n. /usr/local/lib/crap/proxy-storage-guard.sh\nprintf guard-passed`,
      "guard-test",
      ...args,
    ],
    { cwd: root, encoding: "utf8", windowsHide: true },
  );
const pg = { PGSTORE_DSN: "postgres://fixture:never-real@postgres/crap" };
test("release storage guard accepts PostgreSQL and rejects alternate selectors without leaking values", () => {
  assert.equal(run(pg).status, 0);
  for (const env of [
    {},
    { PGSTORE_DSN: "  " },
    ...[
      "GITSTORE_GIT_URL",
      "gitstore_git_url",
      "OBJECTSTORE_ENDPOINT",
      "objectstore_endpoint",
      "HOME_JWT",
      "home_jwt",
      "pgstore_dsn",
    ].map((k) => ({ ...pg, [k]: "do-not-log-this" })),
  ]) {
    const r = run(env);
    assert.equal(r.status, 78, r.stderr);
    assert.doesNotMatch(r.stderr, /do-not-log-this|never-real/);
  }
});
test("release storage guard rejects dotenv overrides and alternative upstream CLI modes", () => {
  for (const setup of ["touch .env", "ln -s /nonexistent .env"])
    assert.equal(run(pg, undefined, setup).status, 78);
  for (const arg of [
    "--home-jwt=private",
    "--home-jwt",
    "--login",
    "--config=/tmp/other.yaml",
  ])
    assert.equal(run(pg, ["CLIProxyAPI", arg]).status, 78);
});
test("official proxy image can execute the CRAP guard and rejects missing PostgreSQL configuration", () => {
  const official = JSON.parse(readFileSync(new URL("cliproxy-release.json", import.meta.url))).image;
  const r = spawnSync("docker", ["run", "--rm", "--network", "none", "--entrypoint", "sh", "--mount", `type=bind,source=${root}deploy,target=/run/crap,readonly`, official, "-c", ". /run/crap/proxy-storage-guard.sh"], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(r.status, 78);
  assert.match(r.stderr, /PGSTORE_DSN is missing/);
});
test("supported release services drop capabilities and prohibit privilege escalation", () => {
  const c = JSON.parse(
    execFileSync(
      "docker",
      ["compose", "-f", "deploy/compose.yaml", "config", "--format", "json"],
      { cwd: root, encoding: "utf8", windowsHide: true },
    ),
  );
  for (const name of ["migrate", "control", "proxy", "gateway", "panel"]) {
    assert.deepEqual(c.services[name].cap_drop, ["ALL"]);
    assert.ok(c.services[name].security_opt.includes("no-new-privileges:true"));
  }
});

test("application images omit the vulnerable unused terminal comparator", () => {
  for (const role of ["control", "gateway", "panel"]) {
    const output = execFileSync(
      "docker",
      [
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
        "type=bind,source=" +
          fileURLToPath(new URL("security-probe.sh", import.meta.url)) +
          ",target=/probe.sh,readonly",
        "crap-" + role + ":alpha-local",
        "/probe.sh",
      ],
      { encoding: "utf8", windowsHide: true },
    );
    assert.match(output, /^infocmp=absent$/m, role);
  }
});


test("proxy adapter replaces a read-only persisted template across non-root restarts", () => {
  const official = JSON.parse(readFileSync(new URL("cliproxy-release.json", import.meta.url))).image;
  const script = `set -eu
cp /fixture/proxy-entrypoint.sh /fixture/proxy-storage-guard.sh /run/crap/
printf 'PGSTORE_DSN=fixture-only\n' > /run/crap/service.env
printf 'new-template\n' > /run/crap/config.example.yaml
chmod 400 /run/crap/config.example.yaml
printf 'old-template\n' > /data/config.example.yaml
chmod 400 /data/config.example.yaml
printf 'saved-runtime-config\n' > /data/config.yaml
printf '#!/bin/sh\nprintf server-started\n' > /tmp/CLIProxyAPI
chmod 500 /tmp/CLIProxyAPI
export PATH=/tmp:$PATH
for restart in 1 2; do
  test "$(sh /run/crap/proxy-entrypoint.sh CLIProxyAPI --local-model)" = server-started
  test "$(cat /data/config.example.yaml)" = new-template
  test "$(stat -c %a /data/config.example.yaml)" = 400
done
rm /run/crap/config.example.yaml
if sh /run/crap/proxy-entrypoint.sh CLIProxyAPI --local-model; then exit 1; fi
test "$(cat /data/config.example.yaml)" = new-template
test "$(cat /data/config.yaml)" = saved-runtime-config
test -z "$(find /data -name '.config.example.*')"
printf restart-fixture-passed
`;
  const r = spawnSync("docker", ["run", "--rm", "--network", "none", "--read-only",
    "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
    ...["/data", "/run/crap", "/tmp"].flatMap((dir) => ["--tmpfs", `${dir}:uid=1000,gid=1000,mode=0700${dir === "/tmp" ? ",exec" : ""}`]),
    "--mount", `type=bind,source=${root}deploy,target=/fixture,readonly`,
    "-w", "/data", "--entrypoint", "sh", official, "-c", script],
    { encoding: "utf8", windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /restart-fixture-passed/);
});
