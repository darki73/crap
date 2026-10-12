import test from "node:test";
import assert from "node:assert/strict";
import {separateFindings} from "./report-scan-ownership.mjs";
test("ownership reports retain every finding and never mutate gate status",()=>{
 const gate={completedAt:new Date().toISOString(),passed:false,blockers:["proxy: binary advisory","postgres: library advisory","panel: runtime advisory","affinity: reachable advisory","npm: dependency (high)"]};
 const before=JSON.stringify(gate),r=separateFindings(gate);
 assert.equal(r.external.length,2);assert.equal(r.crap.length,3);
 assert.deepEqual([...r.crap,...r.external].sort(),[...gate.blockers].sort());assert.equal(JSON.stringify(gate),before);
 assert.throws(()=>separateFindings({...gate,blockers:["unknown: issue"]}),/Unclassified/);
});
