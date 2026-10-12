import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectFile, isReviewed } from './scan-privacy.mjs';
const policy = {publicHosts:['github.com'], localHosts:['localhost'], reviewed:[]};
const inspect = (text, file='fixture.txt') => inspectFile(file, Buffer.from(text), policy);

test('reserved examples and standard loopback are safe, unknown addresses need review', () => {
  assert.deepEqual(inspect('alice@example.com https://api.example.test http://127.0.0.1:3000 https://github.com/darki73/crap'), []);
  assert.ok(inspect('person@' + 'github.com').some(f=>f.kind==='non-example-email'));
  const host = ['unreviewed', 'domain', 'com'].join('.');
  assert.ok(inspect('owner@'+host).some(f=>f.kind==='non-example-email'));
  assert.ok(inspect('https://'+host).some(f=>f.kind==='unreviewed-url-host'));
  assert.ok(inspect('machine.'+['tail123','ts','net'].join('.')).some(f=>f.kind==='infrastructure-host'));
});
test('local identity paths and copied account identifiers require review without echoing values', () => {
  const home = ['C:', 'Users', 'fixture-owner', 'Documents'].join('\\');
  const id = 'v1:' + ['abcd','5678'].join('');
  for(const [value,kind] of [[home,'personal-home-path'], [id,'account-id-literal']]) {
    const findings=inspect(value);
    assert.ok(findings.some(f=>f.kind===kind));
    assert.ok(!JSON.stringify(findings).includes(value));
  }
});
test('review applies only to the exact file, kind and content fingerprint', () => {
  const item=inspect('https://' + ['internal-system','corp','com'].join('.'))[0];
  const reviewed={...policy,reviewed:[{...item,reason:'Synthetic isolated privacy scanner regression example.'}]};
  assert.equal(isReviewed(item,reviewed),true);
  assert.equal(isReviewed({...item,file:'other.txt'},reviewed),false);
  assert.equal(isReviewed({...item,fingerprint:'changed'},reviewed),false);
  assert.equal(isReviewed({...item,kind:'other'},reviewed),false);
});
test('force-added private files and attachments are not implicitly safe', () => {
  assert.ok(inspect('{}','k8s/secrets.json').some(f=>f.kind==='private-file'));
  assert.ok(inspect('{}','.local-panel/config.json').some(f=>f.kind==='private-file'));
  assert.ok(inspect('image','doc/example.png').some(f=>f.kind==='binary-or-attachment'));
  const first=inspectFile('data.bin',Buffer.from([0,255]),policy)[0];
  const second=inspectFile('data.bin',Buffer.from([0,254]),policy)[0];
  assert.notEqual(first.fingerprint,second.fingerprint);
  assert.deepEqual(inspect('HOST=localhost','.env.example'),[]);
});


test('private design records cannot be approved as public documentation', () => {
  for (const file of ['design/routing-decisions.md', 'design/notes.txt', 'design/.gitkeep', 'design/.env.example', 'nested/design/plan.md']) {
    const findings = inspect('Private planning record', file);
    assert.ok(findings.some(f => f.kind === 'private-file'));
    const attempted = {...policy, publicDocuments: [file], reviewed: findings.map(f => ({...f, reason: 'An accidental attempt to approve private planning material.'}))};
    for (const item of findings) assert.equal(isReviewed(item, attempted), false);
  }
});

test('new Markdown documents require an explicit publication review', () => {
  const file = 'doc/new-guide.md';
  const findings = inspect('Ordinary text with no credential patterns', file);
  assert.ok(findings.some(f => f.kind === 'unreviewed-document'));
  assert.deepEqual(inspectFile(file, Buffer.from('Public user guide'), {...policy, publicDocuments: [file]}), []);
  const attempted = {...policy, reviewed: findings.map(f => ({...f, reason: 'Exact fingerprints cannot bypass document publication review.'}))};
  assert.equal(isReviewed(findings[0], attempted), false);
});
