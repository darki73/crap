import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, readFile, appendFile } from 'node:fs/promises';

// Resolve from scripts/ to the repository's ignored local state directory.
const target = new URL('../../.local-panel/', import.meta.url);
await mkdir(target, { recursive: true });
const password = randomBytes(32).toString('hex');
const contents = `AFFINITY_DB_PASSWORD=${password}\nAFFINITY_DATABASE_URL=postgres://affinity:${password}@127.0.0.1:55432/affinity?sslmode=disable\nAFFINITY_ID_KEY=${randomBytes(32).toString('hex')}\n`;
try {
  await writeFile(new URL('affinity.env', target), contents, { flag: 'wx', mode: 0o600 });
  console.log('Created .local-panel/affinity.env. Existing proxy credentials were not changed.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('Existing .local-panel/affinity.env preserved.');
}
const envPath = new URL('affinity.env', target);
const existing = await readFile(envPath, 'utf8');
if (!/^AFFINITY_CONTROL_TOKEN=/m.test(existing)) {
  await appendFile(envPath, `AFFINITY_CONTROL_TOKEN=${randomBytes(32).toString('hex')}\nAFFINITY_CONTROL_URL=http://127.0.0.1:8318\n`);
  console.log('Added the control service token.');
}
