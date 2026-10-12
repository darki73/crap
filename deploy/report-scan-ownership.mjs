// Classification only: never changes or overrides the executable release gate.
import {readFile,writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
export function separateFindings(gate) {
 const crap=[],external=[];
 if(!Array.isArray(gate.blockers)||!gate.completedAt)throw new Error("Complete release gate evidence required.");
 for(const finding of gate.blockers){
  const role=finding.split(":")[0];
  if(["proxy","postgres"].includes(role))external.push(finding);
  else if(["control","gateway","panel","affinity","tailnet","tailnet-windows","tailnet-darwin","npm"].includes(role))crap.push(finding);
  else throw new Error("Unclassified finding: "+role);
 }
 return {crap,external};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const dir=fileURLToPath(new URL("../.local-panel/security-review/",import.meta.url));
 const gate=JSON.parse(await readFile(path.join(dir,"release-gate.json"),"utf8"));
 const groups=separateFindings(gate);
 for(const [ownership,findings] of Object.entries(groups))await writeFile(path.join(dir,ownership+"-findings.json"),JSON.stringify({ownership,completedAt:gate.completedAt,policyHash:gate.policyHash,overallGatePassed:gate.passed,findings},null,2)+"\n");
 console.log("CRAP artifacts: "+groups.crap.length+"; external proxy/database: "+groups.external.length+". Overall gate unchanged.");
}
