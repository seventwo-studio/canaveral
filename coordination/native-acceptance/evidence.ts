// Evidence is an allowlist. Operational configuration and raw output stay private.
import {createHash} from 'node:crypto';
export function signatureEvidence(raw: string, requirementSatisfied: boolean) {
  const identifier = raw.match(/^Identifier=([A-Za-z0-9.-]+)$/m)?.[1];
  return {signed: !/^Signature=adhoc$/m.test(raw) && !!identifier, requirementSatisfied,
    identifier, cdhash: raw.match(/^CDHash=([a-f0-9]{40,64})$/m)?.[1],
    virtualization: raw.includes('com.apple.security.virtualization')};
}
export function processEvidence(raw: string, roots: number[]) {
  const rows = raw.split('\n').flatMap(line => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+([A-Z+<NsTtWXZILEs-]+)\s+([\d:.-]+)(?:\s|$)/);
    return m ? [{pid: Number(m[1]), ppid: Number(m[2]), state: m[3], elapsed: m[4]}] : [];
  });
  const owned = new Set(roots);
  for (let changed = true; changed;) { changed = false; for (const row of rows) {
    if (owned.has(row.ppid) && !owned.has(row.pid)) { owned.add(row.pid); changed = true; }
  } }
  return rows.filter(row => owned.has(row.pid));
}
export function journalEvidence(j: Record<string, any>) {
  const result: Record<string, unknown> = {};
  for (const key of ['launchIntent','prepared','fenced','abandoned','stopped','terminal','cleaning','cleaned','released'])
    if (typeof j[key] === 'boolean') result[key] = j[key];
  for (const key of ['boot','deadline','revision','sequence','claimedAt'])
    if (typeof j[key] === 'number' && Number.isFinite(j[key])) result[key] = j[key];
  if (j.stopCause === null || ['deadline','runtime'].includes(j.stopCause)) result.stopCause = j.stopCause;
  const digest = j.direct?.bundleDigest;
  if (typeof digest === 'string' && /^(sha256:)?[a-f0-9]{64}$/.test(digest)) result.bundleDigest = digest;
  result.roles = {configuration: 'satellite-config', workspace: 'lease-machine', relay: 'agent-relay'};
  result.digest = createHash('sha256').update(JSON.stringify(j)).digest('hex');
  return result;
}

/** Raw console stays private; export only text with host/network identifiers removed. */
export function consoleEvidence(raw: string, identities: string[] = []) {
  let text = raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  // Paths may contain spaces; conservatively redact through the end of the line.
  text = text.replace(/(?:\/[A-Za-z0-9_.-]+)+(?:\/[^\r\n]*)?/g, '[path]');
  text = text.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]');
  text = text.replace(/[a-fA-F0-9]*:[a-fA-F0-9:.%]+/g, value =>
    value.includes('::') || value.split(':').length >= 3 ? '[ip]' : value);
  text = text.replace(/\b[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+/g, '[user]@[host]');
  text = text.replace(/\b(?:hostname|host|username|user|login)(\s*[:=]\s*)[^\s,;]+/gi, (_, separator) => 'identity' + separator + '[redacted]');
  text = text.replace(/\b(?:[A-Za-z0-9-]+\.)+[A-Za-z][A-Za-z0-9-]*\b/g, '[host]');
  for (const identity of identities.filter(Boolean).sort((a,b) => b.length-a.length))
    text = text.replaceAll(identity, '[identity]');
  return text;
}
