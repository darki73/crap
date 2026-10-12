// Offline privacy review of exactly the files Git can publish. Never reads live credentials.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
export function reservedHost(host) {
  return /(^|\.)(example\.(com|net|org)|example|invalid|test)$/.test(host) || /\.example\.ts\.net$/.test(host);
}
const localIP = ip => /^127\./.test(ip) || ip === '0.0.0.0' || /^(192\.0\.2|198\.51\.100|203\.0\.113)\./.test(ip);
function privatePath(file) {
  return /(^|\/)(design|\.local-panel|\.kube|\.ssh|auths|node_modules|backups|release-artifacts)(\/|$)/i.test(file)
    || /\.(?:env|log|jsonl|har|pcap|pcapng|dmp|db|sqlite3?|pem|key|p12|pfx|kubeconfig|crap|crapdb|dump|backup)$/i.test(file)
    || /(^|\/)(?:\.env(?:\..+)?|kubeconfig(?:\..+)?|secrets\.(?:json|ya?ml)|identity\.json|handoff\.json)$/i.test(file)
    || /\.local\.(?:json|ya?ml)$/i.test(file);
}
export function inspectFile(file, bytes, policy) {
  const found = [];
  const add = (kind, line, content) => found.push({file, line, kind, fingerprint: hash(Buffer.concat([Buffer.from(kind + '\0'), Buffer.from(content)]))});
  if (/(^|\/)design(\/|$)/i.test(file) || (privatePath(file) && !/\.env(?:\..*)?\.example$/.test(file) && !file.endsWith('/.gitkeep'))) add('private-file', 0, file);
  if (/\.md$/i.test(file) && !policy.publicDocuments?.includes(file)) add('unreviewed-document', 0, file);
  if (bytes.includes(0) || /\.(?:png|jpe?g|webp|gif|pdf|zip|tar|gz|7z|mp4|mov|exe|so|dll|wasm)$/i.test(file)) {
    add('binary-or-attachment', 0, bytes);
    return found;
  }
  const publicHosts = new Set([...policy.publicHosts, ...policy.localHosts]);
  const hostOK = host => publicHosts.has(host) || reservedHost(host) || (isIP(host) && localIP(host));
  bytes.toString('utf8').split(/\r?\n/).forEach((line, index) => {
    const kinds = new Set();
    if (/(?:[a-z]:[\\/]+Users[\\/]+|\/(?:home|Users)\/)[a-z0-9_.-]+/i.test(line)) kinds.add('personal-home-path');
    for (const match of line.matchAll(/\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi)) {
      const domain = match[1].toLowerCase().replace(/\.json$/, '');
      const userinfo = /\b(?:https?|wss?|postgres(?:ql)?|ssh):\/\/[^\s"'`]*$/.test(line.slice(0, match.index));
      if (!userinfo && !reservedHost(domain)) kinds.add('non-example-email');
    }
    for (const match of line.matchAll(/\b(?:https?|wss?|postgres(?:ql)?|ssh):\/\/(?:[^\s/"'`@]+@)?([a-z0-9][a-z0-9.-]*)/gi)) {
      const host = match[1].toLowerCase().replace(/\.$/, '');
      if (!hostOK(host)) kinds.add('unreviewed-url-host');
    }
    for (const match of line.matchAll(/\b[a-z0-9][a-z0-9.-]*\.(?:ts\.net|svc\.cluster\.local|internal|lan|home|local)(?![a-z0-9.-])/gi)) {
      if (!hostOK(match[0].toLowerCase())) kinds.add('infrastructure-host');
    }
    for (const match of line.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) {
      if (isIP(match[0]) && !localIP(match[0])) kinds.add('non-example-ip');
    }
    for (const match of line.matchAll(/\bv1:([a-f0-9]{8})/gi)) {
      if (!['00000000','11111111','deadbeef','f00dcafe'].includes(match[1].toLowerCase())) kinds.add('account-id-literal');
    }
    for (const match of line.matchAll(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi)) {
      if (!/^00000000-0000-(?:0000-0000|4000-8000)-00000000000[1-9]$/.test(match[0])) kinds.add('identifier-literal');
    }
    for (const kind of kinds) add(kind, index + 1, line.trim());
  });
  return found;
}
export function isReviewed(finding, policy) {
  if (finding.kind === 'unreviewed-document' || /(^|\/)design(\/|$)/i.test(finding.file)) return false;
  return policy.reviewed.some(entry => entry.file === finding.file && entry.kind === finding.kind
    && entry.fingerprint === finding.fingerprint && typeof entry.reason === 'string' && entry.reason.trim().length > 15);
}
export async function audit(cwd = root) {
  const policy = JSON.parse(await readFile(path.join(cwd, 'deploy/privacy-policy.json'), 'utf8'));
  if (policy.version !== 1 || !Array.isArray(policy.reviewed) || !Array.isArray(policy.publicDocuments)) throw new Error('Invalid privacy policy');
  const files = [...new Set(execFileSync('git', ['ls-files','--cached','--others','--exclude-standard','-z'], {cwd}).toString().split('\0').filter(Boolean))];
  const findings = [];
  let bytes = 0;
  for (const file of files) {
    const full = path.resolve(cwd, file);
    if (!full.startsWith(path.resolve(cwd) + path.sep)) throw new Error('Unsafe source path');
    if (!(await lstat(full)).isFile()) {
      findings.push({file, line:0, kind:'non-regular-file', fingerprint:hash(file)});
      continue;
    }
    const content = await readFile(full);
    bytes += content.length;
    findings.push(...inspectFile(file, content, policy));
  }
  const unknown = findings.filter(f => !isReviewed(f, policy));
  const report = {version:1, files:files.length, bytes, reviewed:findings.length-unknown.length, unknown};
  await mkdir(path.join(cwd, '.local-panel'), {recursive:true});
  await writeFile(path.join(cwd, '.local-panel/privacy-scan-summary.json'), JSON.stringify(report,null,2)+'\n');
  return report;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await audit();
    if (report.unknown.length) {
      console.error(report.unknown.length + ' unreviewed privacy findings. Review .local-panel/privacy-scan-summary.json locally; no source contents printed.');
      process.exitCode = 1;
    } else console.log('PASS: ' + report.files + ' Git-visible files reviewed for privacy patterns; ' + report.reviewed + ' exact documented fixture/network examples, no unreviewed findings.');
  } catch {
    console.error('Privacy audit could not complete. No publication clearance was produced.');
    process.exitCode = 1;
  }
}
