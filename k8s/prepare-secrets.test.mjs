import test from 'node:test';
import assert from 'node:assert/strict';
import { rootCertificates } from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
test('offline preparation preserves strict configuration, scoped credentials and existing files', async () => {
  const base = path.join(root, '.local-panel');
  await mkdir(base, {recursive:true});
  const temp = await mkdtemp(path.join(base, 'k8s-secrets-test-'));
  try {
    const ca = rootCertificates.find(pem => {const c=new X509Certificate(pem); return c.ca && Date.parse(c.validFrom)<Date.now() && Date.parse(c.validTo)>Date.now();});
    assert.ok(ca);
    await writeFile(path.join(temp, 'ca.crt'), ca);
    const config = path.join(temp, 'database.json');
    await writeFile(config, JSON.stringify({host:'postgres-rw.database.svc.cluster.local',database:'crap_fixture',caFile:path.join(temp,'ca.crt')}));
    const output = path.join(temp, 'prepared');
    const args = ['k8s/prepare-secrets.mjs',config,output,'personal'];
    const stdout = execFileSync(process.execPath,args,{cwd:root,encoding:'utf8'});
    const secrets = JSON.parse(await readFile(path.join(output,'secrets.json'),'utf8'));
    assert.equal(secrets.items.length,4);
    assert.ok(secrets.items.every(s=>s.metadata.namespace==='personal'));
    const byRole=Object.fromEntries(secrets.items.map(s=>[s.metadata.name,Object.fromEntries(Object.entries(s.data).map(([k,v])=>[k,Buffer.from(v,'base64').toString()]))]));
    const proxyConfig=JSON.parse(byRole['crap-proxy']['config.example.yaml']);
    assert.equal(proxyConfig.requests['proxy-url'],'http://gateway:8321');
    assert.equal(proxyConfig.routing.retry['request-retry'],0);
    assert.equal(proxyConfig.plugins.configs['affinity-router'].enabled,true);
    for(const role of ['control','proxy','migrate']) assert.match(byRole['crap-'+role]['service.env'], /sslmode=verify-full&sslrootcert=\/run\/crap\/ca.crt/);
    const identity=JSON.parse(await readFile(path.join(output,'identity.json'),'utf8'));
    assert.ok(!stdout.includes(identity.management));
    assert.ok(!stdout.includes(identity.identity));
    assert.match(byRole['crap-panel']['service.env'],new RegExp(identity.management));
    assert.ok(!byRole['crap-panel']['service.env'].includes('DATABASE_URL'));
    const before=await readFile(path.join(output,'secrets.json'),'utf8');
    assert.notEqual(spawnSync(process.execPath,args,{cwd:root}).status,0);
    assert.equal(await readFile(path.join(output,'secrets.json'),'utf8'),before);
  } finally {
    assert.equal(path.dirname(temp),base);
    assert.ok(path.basename(temp).startsWith('k8s-secrets-test-'));
    await rm(temp,{recursive:true,force:true});
  }
});
