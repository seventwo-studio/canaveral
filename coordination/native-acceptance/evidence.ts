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

/** Export fixed boot milestones only. Never copy arbitrary console fields. */
export function consoleEvidence(raw: string) {
  const milestones: string[] = [];
  let omitted = 0;
  for (const line of raw.split(/\r?\n/).filter(Boolean)) {
    // Kernel banners include build users and hosts after the numeric release.
    const kernel = line.match(/^(?:\[\s*\d+\.\d+\] )?Linux version (\d+\.\d+(?:\.\d+)?)(?=[\s-]|$)/);
    if (kernel) milestones.push('Linux version ' + kernel[1]);
    // These prefixes come from boot-bundle/bin/bootstrap and guest-agent/main,
    // boot.rs. Error/debug payloads are deliberately discarded in full.
    else if (line.startsWith('bootstrap refused: ')) milestones.push('bootstrap refused');
    else if (line.startsWith('guest agent fenced: ')) milestones.push('guest agent fenced');
    else if (line.startsWith('guest session closed: ') && line.endsWith('; native fence required'))
      milestones.push('guest session closed; native fence required');
    else omitted++;
  }
  if (omitted) milestones.push(omitted + ' lines omitted');
  return milestones.join('\n') + (milestones.length ? '\n' : '');
}

/** Keep raw receipts under private/; share only typed outcomes and digests. */
export function receiptEvidence(value: unknown): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return /^(?:[a-f0-9]{64}|sha256:[a-f0-9]{64}|[a-f0-9-]{36}|\d{4}-\d{2}-\d{2}T[0-9:.]+Z)$/.test(value) || ['ready','running','stopped','provisioning','released','expired','failed','unknown','succeeded','queued','created','writing','reading','committed','verified','pending','complete','notRequested','destination_denied','port_denied','route_denied','egress_denied','destination_exists','disk_full','authorization_lost','deadline','lease_ended','cases-completed','runtime','appleVirtualization','linux','arm64','primary','headless','public-https-v1'].includes(value) ? value : undefined;
  if (Array.isArray(value)) return value.map(receiptEvidence).filter(v=>v!==undefined);
  if (typeof value !== 'object') return undefined;
  const keys = new Set(('state nativeAcceptance caseFailures caseFailureCount lossReservationHeld lossCleanupRequiresOperatorReconciliation setupComplete artifactVerified signed requirementSatisfied virtualization identifier cdhash helper builder sha256 bytes offset step transferId operationId leaseId assignmentId memberId bootAttempt bundleDigest revision expiresAt controllerNow createdAt updatedAt dispatchedAt startBefore deadlineAt executionDeadlineAt durationMs result status signal timedOut stdoutBytes stderrBytes stdoutTruncated stderrTruncated terminationConfirmed error code durable transfer operation receipt upload download existingRegularFile helperPids helperPidsGone noOwnedVMProcess machineRemoved workspaceRemoved relayRemoved journal at lease domain runtimeState runtime cleanup cleanupState cleanupId ready command pty files workspaceRemoved dataPlaneClosed released reservations cpu memoryMiB diskGiB deadline boot sequence claimedAt launchIntent prepared fenced abandoned stopped terminal cleaning cleaned stopCause digest roles configuration workspace relay processes pids pid ppid elapsed stopOffsetMs lossDeadline killedAt lastAliveAt stoppedObservedAt checkedPastDeadlineAt autonomous reservationHeld cleanupProven renewedRevision originalExpiresAt renewedExpiresAt observedAt commandLease receipt failure observedRevision binding domainId image application1 application2 id os arch mode backend resources capabilities version canonicalManifestDigest failureCount').split(' '));
  return Object.fromEntries(Object.entries(value).flatMap(([key,v])=> {
    if (!keys.has(key)) return [];
    const clean=receiptEvidence(v); return clean===undefined?[]:[[key,clean]];
  }));
}
