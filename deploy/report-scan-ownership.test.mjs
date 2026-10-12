import test from "node:test";
import assert from "node:assert/strict";
import { separateFindings } from "./report-scan-ownership.mjs";
import { PUBLICATION_SCOPE } from "./vulnerability-policy.mjs";
test("ownership reports retain every finding and never mutate gate status", () => {
  const gate = {
    scope: PUBLICATION_SCOPE,
    completedAt: new Date().toISOString(),
    passed: false,
    externalFindings: ["proxy: binary advisory", "postgres: library advisory"],
    blockers: [
      "panel: runtime advisory",
      "affinity: reachable advisory",
      "npm: dependency (high)",
    ],
  };
  const before = JSON.stringify(gate),
    r = separateFindings(gate);
  assert.deepEqual(r.external, gate.externalFindings);
  assert.deepEqual(r.crap, gate.blockers);
  assert.equal(JSON.stringify(gate), before);
  for (const changed of [
    { blockers: ["unknown: issue"] },
    { blockers: ["proxy: issue"] },
    { externalFindings: ["panel: issue"] },
    { externalFindings: [null] },
  ])
    assert.throws(
      () => separateFindings({ ...gate, ...changed }),
      /Unclassified or misplaced/,
    );
  for (const changed of [
    { scope: undefined },
    { externalFindings: undefined },
    { blockers: undefined },
  ])
    assert.throws(
      () => separateFindings({ ...gate, ...changed }),
      /scope evidence/,
    );
});
