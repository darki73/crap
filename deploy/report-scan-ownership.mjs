// Classification only: never changes or overrides the executable release gate.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { separateFindings } from "./vulnerability-policy.mjs";
export { separateFindings };
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const dir = fileURLToPath(
    new URL("../.local-panel/security-review/", import.meta.url),
  );
  const gate = JSON.parse(
    await readFile(path.join(dir, "release-gate.json"), "utf8"),
  );
  const groups = separateFindings(gate);
  for (const [ownership, findings] of Object.entries(groups))
    await writeFile(
      path.join(dir, ownership + "-findings.json"),
      JSON.stringify(
        {
          ownership,
          scope: gate.scope,
          publicationBlocking: ownership === "crap",
          completedAt: gate.completedAt,
          policyHash: gate.policyHash,
          overallGatePassed: gate.passed,
          findings,
        },
        null,
        2,
      ) + "\n",
    );
  console.log(
    "CRAP artifacts: " +
      groups.crap.length +
      "; external proxy/database: " +
      groups.external.length +
      ". Overall gate unchanged.",
  );
}
