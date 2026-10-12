// Offline preparation only. Never reads kubeconfig, connects to PG or applies resources.
import { prepareExternal } from '../deploy/external-database.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const [file, output, namespace = 'crap', ...extra] = process.argv.slice(2);
try {
  if (!file || !output || extra.length || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(namespace)) throw new Error('arguments');
  const config = JSON.parse(await readFile(file, 'utf8'));
  process.env.CRAP_STRICT_ROUTING = '1';
  await prepareExternal(config, output);
  const items = [];
  for (const role of ['control', 'migrate', 'panel', 'proxy']) {
    const files = ['service.env', ...(role === 'panel' ? [] : ['ca.crt']), ...(role === 'proxy' ? ['config.example.yaml'] : [])];
    const data = {};
    for (const name of files) data[name] = (await readFile(path.join(output, role, name))).toString('base64');
    items.push({apiVersion: 'v1', kind: 'Secret', metadata: {name: 'crap-' + role, namespace}, type: 'Opaque', data});
  }
  await writeFile(path.join(output, 'secrets.json'), JSON.stringify({apiVersion: 'v1', kind: 'List', items}, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  console.log('Private Kubernetes secrets and provisioning SQL prepared. Nothing applied. Keep this directory outside Git.');
} catch {
  console.error('Preparation failed. Check the destination, public CA, namespace and fresh output directory. Private partial files may remain; do not apply them. No credentials were printed.');
  process.exitCode = 1;
}
