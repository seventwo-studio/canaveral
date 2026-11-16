// Pure orchestration seams: importing this module never starts a native process.
import assert from 'node:assert/strict';
export const reconciliationMode = 'native-reconciliation-v1';
export function validateReconciliation(cfg: Record<string, any>, env: NodeJS.ProcessEnv) {
  assert(!env.CI && env.CANAVERAL_NATIVE_ACCEPTANCE === 'operator-authorized');
  assert.equal(cfg.mode, reconciliationMode);
  assert.equal(cfg.setupOnly, false);
  assert.equal(cfg.workspaceIOVersion, 1);
  assert.deepEqual([cfg.cpu,cfg.memoryMiB,cfg.diskGiB], [2,4096,8]);
  assert(Array.isArray(cfg.physicalStateRoots) && cfg.physicalStateRoots.length > 0);
  assert(cfg.physicalStateRoots.includes(cfg.stateRoot));
}
export function requireQuiescent(rows: {command:string}[], held: number, ambiguous: boolean) {
  assert.equal(held, 0);
  assert.equal(ambiguous, false);
  assert(!rows.some(r => /com\.apple\.Virtualization\.VirtualMachine|CanaveralVMRunner|canaveral-apple-satellite|canaveral-runner-client|coordination\/dist\/src\/main\.js/.test(r.command)));
}
export function reconciliationRequest(j: any, mutationUUID: string) {
  assert.equal(j.workerOwnershipProtocol, 1);
  assert.equal(j.launchIntent, true);
  const a = j.assignment;
  const uuid = (v: unknown) => {assert.equal(typeof v, 'string'); assert.match(v as string, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i);return v as string;};
  const binding = j.config.binding;
  for (const key of ['controllerId','runnerId','incarnationId']) uuid(binding[key]);
  assert(Number.isSafeInteger(binding.generation) && binding.generation > 0);
  assert.match(a.image.digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(j.direct.bundleDigest, a.image.digest);
  assert(j.direct.workspaceDisk && j.direct.ready);
  return {version:1,mutationUUID:uuid(mutationUUID),binding,claimId:uuid(j.claimId),assignmentId:uuid(a.id),leaseId:uuid(a.leaseId),memberId:uuid(a.memberId),domainId:uuid(a.domainId),imageDigest:a.image.digest,bootAttempt:uuid(j.direct.bootAttempt)};
}
export interface ReconciliationSeams {
  journal(): any;
  persist(name:string, value:unknown):void;
  dispatch(name:string):Promise<{code:unknown;output:string;diagnostic:string}>;
  reports():any[];
  reservations():Promise<number>;
  removed():boolean;
}
export async function reconcileCase(s:ReconciliationSeams, mutationUUID:string) {
  const request = reconciliationRequest(s.journal(), mutationUUID);
  s.persist('reconcile-request.json',request);
  const before = s.reports().length;
  let reply = await s.dispatch('reconcile-request.json');
  // Unknown replies retry once with the original saved identity and body.
  if(reply.code !== 0) reply = await s.dispatch('reconcile-request.json');
  assert.equal(reply.code,0);
  const outcome = JSON.parse(reply.output);
  assert.deepEqual(outcome,{version:1,mutationUUID,assignmentId:request.assignmentId,released:true});
  const j = s.journal();
  for(const flag of ['stopped','cleaned','released']) assert.equal(j[flag],true);
  assert.equal(j.direct.dataClosed,true);
  assert.equal(j.direct.workspaceDisk.removed,true);
  assert(s.removed());
  assert.equal(await s.reservations(),0);
  const reports = s.reports().slice(before);
  const ack = reports.find(r=>r.response.released === true);
  assert(ack);
  assert.equal(ack.response.assignmentId,request.assignmentId);
  assert.equal(ack.body.assignmentId,request.assignmentId);
  assert.equal(ack.body.receipt.cleanup,'complete');
  assert.equal(ack.body.receipt.executionStopped,true);
  assert.equal(ack.body.receipt.workspaceRemoved,true);
  assert.equal(ack.body.receipt.dataPlaneClosed,true);
  assert.equal(ack.before.body.reservations,1);
  assert.equal(ack.after.body.reservations,0);
  const count = s.reports().length;
  const stable = JSON.stringify(j);
  const replay = await s.dispatch('reconcile-request.json');
  assert.equal(replay.code,0);assert.deepEqual(JSON.parse(replay.output),outcome);
  s.persist('reconcile-conflict.json',{...request,imageDigest:'sha256:'+ (request.imageDigest[7] === '0' ? '1' : '0') + request.imageDigest.slice(8)});
  const conflict = await s.dispatch('reconcile-conflict.json');
  assert.equal(conflict.code,1);
  assert.match(conflict.diagnostic,/^reconciliation mutation conflicts\s*$/);
  assert.equal(s.reports().length,count);
  assert.equal(JSON.stringify(s.journal()),stable);
  assert.equal(await s.reservations(),0);
  return {reconciliationPassed:true, released:true, replayPassed:true, conflictPassed:true};
}

export async function proveOrphanExclusion(s:{journalBytes():string; secondOwner():Promise<{code:unknown;diagnostic:string}>; helpersAlive():boolean; reservations():Promise<number>; capacityRefused():Promise<boolean>}) {
  const before = s.journalBytes();
  assert(s.helpersAlive());
  const r = await s.secondOwner();
  assert.equal(r.code,1);assert.match(r.diagnostic,/executor already owned/);
  assert.equal(s.journalBytes(),before);
  assert(s.helpersAlive());
  assert.equal(await s.reservations(),1);
  assert(await s.capacityRefused());
}
export function fenceTiming(deadline:number,lastAlive:number,stopped:number) {
  assert(Number.isFinite(deadline));
  assert(lastAlive >= deadline-3000);
  assert(stopped >= deadline-2500 && stopped <= deadline+5000);
}
