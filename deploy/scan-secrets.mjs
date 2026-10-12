// Pinned, offline scanner. Export only Git-visible files; never scan live state.
import { spawnSync, execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  copyFile,
  lstat,
  rm,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const local = path.join(root, ".local-panel");
const image =
  "ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f";
const baseline = JSON.parse(
  await readFile(new URL("secret-baseline.json", import.meta.url), "utf8"),
);
await mkdir(local, { recursive: true });
const temp = await mkdtemp(path.join(local, "secret-scan-"));
const source = path.join(temp, "source");
const reports = path.join(temp, "reports");
try {
  await mkdir(source);
  await mkdir(reports);
  const files = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root },
  )
    .toString()
    .split("\0")
    .filter(Boolean);
  for (const file of new Set(files)) {
    const original = path.resolve(root, file),
      target = path.resolve(source, file);
    if (!target.startsWith(source + path.sep) || !original.startsWith(root))
      throw new Error("Unsafe source path");
    const info = await lstat(original);
    if (!info.isFile())
      throw new Error("Review source symlinks before packaging");
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(original, target);
  }
  const unknown = [];
  let accepted = 0;
  for (const scope of ["source", "history"]) {
    const result = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--mount",
        `type=bind,source=${scope === "source" ? source : root},target=${scope === "source" ? "/src" : "/repo"},readonly`,
        "--mount",
        `type=bind,source=${reports},target=/reports`,
        image,
        ...(scope === "source"
          ? ["dir", "/src"]
          : ["git", "/repo", "--log-opts=--all"]),
        "--redact",
        "--no-banner",
        "--log-level",
        "error",
        "--report-format",
        "json",
        "--report-path",
        `/reports/${scope}.json`,
      ],
      { cwd: root, windowsHide: true, maxBuffer: 4 << 20 },
    );
    if (result.error || ![0, 1].includes(result.status))
      throw new Error(
        "Secret scanner failed; verify Docker/image availability. Private output withheld.",
      );
    const findings = JSON.parse(
      await readFile(path.join(reports, `${scope}.json`), "utf8"),
    );
    for (const finding of findings) {
      let known;
      if (scope === "history")
        known = baseline.entries.some(
          (e) => e.scope === scope && e.fingerprint === finding.Fingerprint,
        );
      else {
        const file = finding.File.replace(/^\/src\//, "");
        const line = (await readFile(path.join(source, file), "utf8")).split(
          /\r?\n/,
        )[finding.StartLine - 1];
        const hash = createHash("sha256").update(line).digest("hex");
        known = baseline.entries.some(
          (e) =>
            e.scope === scope &&
            e.file === file &&
            e.rule === finding.RuleID &&
            e.line === finding.StartLine &&
            e.lineSHA256 === hash,
        );
      }
      if (known) accepted++;
      else
        unknown.push({
          scope,
          file: finding.File,
          line: finding.StartLine,
          rule: finding.RuleID,
          fingerprint: finding.Fingerprint,
        });
    }
  }
  await writeFile(
    path.join(local, "secret-scan-summary.json"),
    JSON.stringify({ accepted, unknown }, null, 2),
  );
  if (unknown.length) {
    console.error(
      `${unknown.length} unreviewed secret-scanner findings. Inspect .local-panel/secret-scan-summary.json privately; no secret values were printed.`,
    );
    process.exitCode = 1;
  } else
    console.log(
      `PASS: Git-visible source and reachable history scanned offline; ${accepted} exact reviewed upstream constants/fixtures, no unreviewed findings.`,
    );
} finally {
  if (
    path.dirname(temp) !== local ||
    !path.basename(temp).startsWith("secret-scan-")
  )
    throw new Error("Unsafe scanner cleanup");
  await rm(temp, { recursive: true, force: true });
}
