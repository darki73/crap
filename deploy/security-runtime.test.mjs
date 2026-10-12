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
