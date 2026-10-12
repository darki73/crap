import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// Install only into the existing local development proxy. The shared library is
// built separately; the upstream executable and credential storage stay intact.
const root = new URL('../../', import.meta.url);
const load = async (name) => Object.fromEntries((await readFile(new URL(`.local-panel/${name}`, root), 'utf8')).split(/\r?\n/).filter(line => line.includes('=')).map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
const env = await load('affinity.env');
const panel = await load('.env');
const file = new URL('.local-panel/affinity-plugin.env', root);
await writeFile(file, `AFFINITY_ID_KEY=${env.AFFINITY_ID_KEY}\nAFFINITY_CONTROL_TOKEN=${env.AFFINITY_CONTROL_TOKEN}\nAFFINITY_CONTROL_URL=http://host.docker.internal:8318\n`, { mode: 0o600 });
const run = (args) => { const result = spawnSync('docker', args, { stdio: 'inherit', windowsHide: true }); if (result.status !== 0) throw new Error('Docker plugin installation failed.'); };
const container = 'cliproxy-panel-proxy-1';
run(['exec', container, 'mkdir', '-p', '/CLIProxyAPI/plugins']);
run(['cp', fileURLToPath(file), `${container}:/CLIProxyAPI/plugins/affinity.env`]);
run(['exec', container, 'chmod', '600', '/CLIProxyAPI/plugins/affinity.env']);
const source = await readFile(new URL('affinity-router/plugin/runtime.go', root), 'utf8');
const version = source.match(/const Version = "([0-9.]+)"/)?.[1];
if (!version) throw new Error('Plugin build version is missing.');
const destination = `/CLIProxyAPI/plugins/affinity-router-v${version}.so`;
// Never overwrite a mapped shared library: use immutable versioned filenames.
const exists = spawnSync('docker', ['exec', container, 'test', '-f', destination], { windowsHide: true });
const artifact = new URL('.local-panel/affinity-build/affinity-router.so', root);
if (exists.status === 0) {
  const installed = spawnSync('docker', ['exec', container, 'sha256sum', destination], { encoding: 'utf8', windowsHide: true });
  const expected = createHash('sha256').update(await readFile(artifact)).digest('hex');
  if (installed.status !== 0 || installed.stdout.split(/\s+/)[0] !== expected) throw new Error('This version has different installed bytes. Bump Version before rebuilding.');
} else { run(['cp', fileURLToPath(artifact), `${container}:${destination}`]); }
const headers = { Authorization: `Bearer ${panel.PANEL_MANAGEMENT_KEY}`, 'Content-Type': 'application/json' };
const url = 'http://127.0.0.1:8317/v8/management/config/plugins';
const response = await fetch(url, { headers, redirect: 'error' });
if (!response.ok && response.status !== 404) throw new Error('Could not read plugin configuration.');
const current = response.status === 404 ? {} : await response.json();
await writeFile(new URL('.local-panel/plugins-before-affinity.json', root), JSON.stringify(current, null, 2), { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
const instance = { ...current.configs?.['affinity-router'], enabled: true, priority: 100, store: { ...current.configs?.['affinity-router']?.store, version } };
delete instance.version;
const next = { ...current, enabled: true, dir: '/CLIProxyAPI/plugins', configs: { ...current.configs, 'affinity-router': instance } };
const saved = await fetch(url, { method: 'PUT', headers, body: JSON.stringify(next), redirect: 'error' });
if (!saved.ok) throw new Error(`Could not enable plugin: HTTP ${saved.status}`);
console.log('Local affinity plugin installed and enabled. The database policy controls shadow/live mode.');
