import test from "node:test";
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
const root=fileURLToPath(new URL("../",import.meta.url));
test("existing-proxy overlay leaves upstream lifecycle external and configures both callers",async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),"crap-existing-"));t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,"connection.env");await writeFile(file,"MANAGEMENT_KEY=fixture-only\n");
 const c=JSON.parse(execFileSync("docker",["compose","-f","deploy/compose.yaml","-f","deploy/compose.existing.yaml","config","--format","json"],{cwd:root,encoding:"utf8",windowsHide:true,env:{...process.env,CLI_PROXY_URL:"http://existing:8317",CRAP_PROXY_NETWORK:"fixture-private",CRAP_PROXY_CONNECTION_FILE:file}}));
 assert.equal(c.networks["proxy-private"].external,true);
 assert.equal(c.networks["proxy-private"].name,"fixture-private");
 for(const name of ["panel","gateway"]){assert.equal(c.services[name].environment.PROXY_URL,"http://existing:8317");assert.equal(c.services[name].depends_on?.proxy,undefined);assert.ok(c.services[name].volumes.some(v=>v.target==="/run/crap-connection.env"&&v.read_only));}
 assert.ok(!c.services.proxy || c.services.proxy.profiles.includes("guided-proxy"));
 const services=execFileSync("docker",["compose","-f","deploy/compose.yaml","-f","deploy/compose.existing.yaml","config","--services"],{cwd:root,encoding:"utf8",windowsHide:true,env:{...process.env,CLI_PROXY_URL:"http://existing:8317",CRAP_PROXY_NETWORK:"fixture-private",CRAP_PROXY_CONNECTION_FILE:file}}).trim().split(/\r?\n/);
 assert.ok(!services.includes("proxy"));
});
test("private existing management credentials are loaded by the CRAP entrypoint",async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),"crap-connection-"));t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,"connection.env");await writeFile(file,"MANAGEMENT_KEY=fixture-only\n");
 execFileSync("docker",["run","--rm","--network","none","--mount","type=bind,source="+file+",target=/run/crap-connection.env,readonly","crap-control:alpha-local","sh","-c",'test "$MANAGEMENT_KEY" = fixture-only'],{cwd:root,windowsHide:true});
});
