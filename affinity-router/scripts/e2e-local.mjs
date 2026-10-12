import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

// Uses only synthetic credentials, a local fake Anthropic endpoint, a disposable
// proxy container and affinity_test. No real provider request is possible here.
const root = new URL('../../', import.meta.url);
const dir = new URL('.local-panel/affinity-e2e/', root);
const plugins = new URL('plugins/', dir);
await mkdir(plugins, { recursive: true });
const settings = Object.fromEntries((await readFile(new URL('.local-panel/affinity.env', root), 'utf8')).split(/\r?\n/).filter(x => x.includes('=')).map(x => { const p = x.indexOf('='); return [x.slice(0,p),x.slice(p+1)]; }));
const testDSN = new URL(settings.AFFINITY_DATABASE_URL); testDSN.pathname = '/affinity_test';
const key = randomBytes(32).toString('hex');
const token = randomBytes(32).toString('hex');
await writeFile(new URL('affinity.env', plugins), `AFFINITY_ID_KEY=${key}\nAFFINITY_CONTROL_TOKEN=${token}\nAFFINITY_CONTROL_URL=http://host.docker.internal:18318\nAFFINITY_SPOOL=/CLIProxyAPI/plugins/test-spool\n`);
await copyFile(new URL('.local-panel/affinity-build/affinity-router.so', root), new URL('affinity-router.so', plugins));
const configuration = {
  'config-version': 8, server: { host: '', port: 8317 },
  management: { 'allow-remote': true, 'secret-key': 'fixture-management', 'disable-control-panel': true },
  access: { 'api-keys': ['fixture-client'] }, credentials: { 'auth-dir': '/tmp/affinity-auth' },
  'api-keys': { claude: [{ name: 'fixture', 'base-url': 'http://host.docker.internal:18319', keys: [{ 'api-key': 'fixture-a' }, { 'api-key': 'fixture-b' }], models: [{ name: 'claude-fixture', alias: 'claude-fixture' }] }] },
  plugins: { enabled: true, dir: '/CLIProxyAPI/plugins', configs: { 'affinity-router': { enabled: true, priority: 100 } } },
};
await writeFile(new URL('config.yaml', dir), JSON.stringify(configuration));
const control = spawn(fileURLToPath(new URL('.local-panel/affinity-control-next.exe', root)), [], {
  env: { ...process.env, AFFINITY_DATABASE_URL: testDSN.toString(), AFFINITY_ID_KEY: key, AFFINITY_CONTROL_TOKEN: token, AFFINITY_LISTEN: '127.0.0.1:18318' }, windowsHide: true, stdio: 'ignore',
});
let calls = [];
const mock = http.createServer(async (req,res) => {
  const chunks=[]; for await (const chunk of req) chunks.push(chunk);
  const body=JSON.parse(Buffer.concat(chunks).toString()||'{}');
  calls.push(req.headers['x-api-key'] || req.headers.authorization);
  res.setHeader('request-id', 'req_'+randomBytes(16).toString('hex'));
  const message={id:'msg_fixture',type:'message',role:'assistant',model:'claude-fixture',content:[{type:'text',text:'fixture response'}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:10,cache_read_input_tokens:20,cache_creation_input_tokens:5,cache_creation:{ephemeral_5m_input_tokens:3,ephemeral_1h_input_tokens:2},output_tokens:7}};
  if(body.stream){
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    const emit=(type,data)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`);
    emit('message_start',{message:{...message,content:[],stop_reason:null,usage:{...message.usage,output_tokens:0}}});
    emit('content_block_start',{index:0,content_block:{type:'text',text:''}});
    emit('content_block_delta',{index:0,delta:{type:'text_delta',text:'fixture response'}});
    emit('content_block_stop',{index:0});
    emit('message_delta',{delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:7}});
    emit('message_stop',{});res.end();
  } else {res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(message));}
});
await new Promise(resolve=>mock.listen(18319,'0.0.0.0',resolve));
const container=`cliproxy-affinity-e2e-${Date.now()}`;
const docker=(args)=>{const result=spawnSync('docker',args,{encoding:'utf8',windowsHide:true});if(result.status!==0)throw new Error(`Docker test operation failed: ${result.stderr}`);return result.stdout;};
const controlCall=async(path,body,method=body?'POST':'GET')=>{
  const response=await fetch(`http://127.0.0.1:18318${path}`,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
  assert.equal(response.status,200,await response.clone().text());return response.json();
};
async function until(check){for(let i=0;i<40;i++){try{const result=await check();if(result)return result;}catch{}await delay(250);}throw new Error('Local integration condition did not become ready');}
try {
  await until(async()=> (await fetch('http://127.0.0.1:18318/healthz')).ok);
  docker(['run','-d','--name',container,'-p','127.0.0.1:18317:8317','--mount',`type=bind,source=${fileURLToPath(dir)},target=/fixture`,'--mount',`type=bind,source=${fileURLToPath(plugins)},target=/CLIProxyAPI/plugins`,'cliproxy-panel-api:local','./CLIProxyAPI','--config','/fixture/config.yaml','--local-model']);
  const management=async(path)=>fetch(`http://127.0.0.1:18317/v8/management${path}`,{headers:{Authorization:'Bearer fixture-management'}}).then(r=>r.json());
  await until(async()=>{const p=await management('/plugins');return p.plugins?.some(x=>x.id==='affinity-router'&&x.registered&&x.effective_enabled);});
  // API-key runtime entries are not returned by the auth-file listing. Mirror
  // the upstream stable-ID fixture contract; a change makes this test fail.
  const accounts=['fixture-a','fixture-b'].map(apiKey=>({id:'claude:apikey:'+createHash('sha256').update(['claude:apikey',apiKey,'http://host.docker.internal:18319','','',''].join('\0')).digest('hex').slice(0,12)}));
  for(let i=0;i<accounts.length;i++) await controlCall('/quotas',{accountId:accounts[i].id,provider:'claude',plan:'Fixture',checkedAt:Date.now(),windows:[{label:'Weekly window',used:i?10:20}]});
  let state=await controlCall('/state');const beforeEvents=state.summary.events;
  await controlCall('/policy',{...state.policy,mode:'live',minimumRemaining:5},'PUT');
  async function request(stream=false){const response=await fetch('http://127.0.0.1:18317/v1/messages',{method:'POST',headers:{'x-api-key':'fixture-client','anthropic-version':'2023-06-01','Content-Type':'application/json','x-session-id':`fixture-${container}`},body:JSON.stringify({model:'claude-fixture',max_tokens:16,messages:[{role:'user',content:'synthetic test'}],stream})});const body=await response.text();assert.equal(response.status,200,body);assert.match(body,/fixture response/);}
  await request();await request(true);assert.equal(calls.length,2);assert.equal(calls[0],calls[1],'healthy session must stay on its account');
  // Exhaust the currently selected account's observed weekly window.
  state=await controlCall('/state');const selected=state.decisions.find(d=>d.model==='claude-fixture').account_id;
  const {createHmac}=await import('node:crypto');
  const ref=raw=>'v1:'+createHmac('sha256',Buffer.from(key,'hex')).update(JSON.stringify(['v1','local','account',raw])).digest('hex');
  const exhausted=accounts.find(a=>ref(a.id)===selected);assert.ok(exhausted);
  await controlCall('/quotas',{accountId:exhausted.id,provider:'claude',checkedAt:Date.now(),windows:[{label:'Weekly window',used:99}]});
  await request();assert.notEqual(calls[2],calls[1],'exhausted account must fail over');
  await until(async()=>{const s=await controlCall('/state');return s.summary.events>=beforeEvents+3&&s.recent.filter(e=>e.model==='claude-fixture').length>=3;});
  state=await controlCall('/state');const usage=state.recent.filter(e=>e.model==='claude-fixture').slice(0,3);
  assert.ok(usage.every(e=>e.quality==='complete'&&e.reported_total==='42'),'stream and nonstream native usage must reconcile to 42 tokens');
  await until(async()=>{const s=await controlCall('/state');return s.recent.filter(e=>usage.some(u=>u.event_id===e.event_id)).every(e=>e.cache_write_5m==='3'&&e.cache_write_1h==='2');});
  await controlCall('/prices',{provider:'claude',model:'claude-fixture',serviceTier:'auto',effectiveFrom:new Date(Date.now()-86400000).toISOString(),inputRate:'4',cacheReadRate:'0.2',cacheWrite5mRate:'5',cacheWrite1hRate:'8',outputRate:'20',reasoningRate:'20',note:'Local mock fixture only'});
  state=await controlCall('/state');
  assert.ok(state.costs.some(c=>c.pricing_basis==='observed_duration'&&c.attempts>=3),'observed cache splits must be priced');
  console.log('PASS: mixed 5m/1h counters observed and priced; real plugin loaded; sticky selection; streaming; quota failover; durable usage; native token reconciliation. Only a local mock upstream was contacted.');
} finally {
  spawnSync('docker',['rm','-f',container],{windowsHide:true,stdio:'ignore'});
  mock.closeAllConnections();await new Promise(resolve=>mock.close(resolve));control.kill();
}
