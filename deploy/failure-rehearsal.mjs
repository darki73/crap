import { spawnSync } from "node:child_process";
const project = process.argv[2];
if (!/^crap-(ci|release-rehearsal)(-[a-z0-9]+)*$/.test(project || ""))
  throw new Error("Disposable project required.");
const compose = [
  "compose",
  "-p",
  project,
  "-f",
  "deploy/compose.legacy-test.yaml",
];
function run(args) {
  const r = spawnSync("docker", [...compose, ...args], {
    windowsHide: true,
    maxBuffer: 4 << 20,
  });
  if (r.status !== 0)
    throw new Error("Failure rehearsal failed; private output withheld.");
  if (args.includes("failure-probe.mjs")) process.stdout.write(r.stdout);
}
const probe = (mode) =>
  run([
    "exec",
    "-T",
    "-e",
    "CRAP_REHEARSAL=1",
    "panel",
    "node",
    "deploy/failure-probe.mjs",
    mode,
  ]);
const inspection = spawnSync(
  "docker",
  [
    ...compose,
    "exec",
    "-T",
    "postgres",
    "psql",
    "-X",
    "-U",
    "postgres",
    "-d",
    "crap",
    "-At",
    "-c",
    "SELECT (SELECT count(*) FROM cliproxy.auth_store)+(SELECT count(*) FROM affinity_router.usage_events WHERE model <> 'claude-fixture')",
  ],
  { windowsHide: true },
);
if (inspection.status !== 0 || inspection.stdout.toString().trim() !== "0")
  throw new Error("Failure rehearsal refuses real account/history data.");
probe("plugin");
probe("ready");
for (const service of ["control", "postgres"]) {
  try {
    run(["stop", service]);
    probe("blocked");
  } finally {
    run(["start", service]);
  }
  probe("ready");
}
console.log(
  "PASS: actual control/database outages and plugin disablement reject inference; readiness recovers.",
);
