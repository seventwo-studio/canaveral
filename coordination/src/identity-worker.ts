import { createHash, timingSafeEqual } from "node:crypto";
import { parentPort, workerData } from "node:worker_threads";
import { RunnerEnrollment } from "./enrollment.ts";
import { Accounts } from "./accounts.ts";
import { ConsumerIdentities } from "./consumers.ts";
import { object, secret, ServiceError } from "./errors.ts";
import { mutates } from "./identity-protocol.ts";
import { LinuxLeases } from "./linux-leases.ts";
import { ModelJobs } from "./model-jobs.ts";
import type { IdentityCommand, IdentityReply } from "./identity-protocol.ts";
import { SqliteStore } from "./sqlite.ts";

if (!parentPort) throw new Error("Identity persistence requires its owned worker channel.");
const port = parentPort;
const administrator = secret(workerData.adminToken);
const expected = createHash("sha256").update(administrator, "ascii").digest();
const store = new SqliteStore(workerData.path as string);
const accounts = new Accounts(store), applications = new ConsumerIdentities(store);
const runners = workerData.controllerId === undefined ? undefined : new RunnerEnrollment(store, workerData.controllerId as string);
const jobs = new ModelJobs(store, applications, runners);
const leases = new LinuxLeases(store, applications, runners);
function reply(value: IdentityReply): void { port.postMessage(value); }
function operator(token: string): boolean {
  try { secret(token); } catch { return false; }
  return timingSafeEqual(expected, createHash("sha256").update(token, "ascii").digest());
}
function requireAdministrator(token: string): void {
  if (!operator(token) && !accounts.authorized(token)) throw new ServiceError("Credential rejected.", 401);
}
function administratorTransaction<T>(token: string, operation: () => T): T {
  return store.transaction(() => { requireAdministrator(token); return operation(); });
}

async function dispatch(command: IdentityCommand): Promise<unknown> {
  if (['leases.createTransfer','leases.createTransferStep','leases.transfer'].includes(command.type) && 'token' in command && (operator(command.token) || accounts.authorized(command.token))) throw new ServiceError('Only the current lease key may access transfers.',403,{code:'credential_role'});
  if (command.type.startsWith("runner.")) {
    const runnerProof = command.type === "runner.consume" || command.type === "runner.authenticate";
    if (!runnerProof && "token" in command) requireAdministrator(command.token);
    if (!runners) {
      if (runnerProof) throw new ServiceError("Runner credential or enrollment rejected.", 401);
      throw new ServiceError("Runner enrollment requires a configured controller identity.", 503, { retryable: false });
    }
  }
  if (isModel(command)) return model(command);
  if (isLease(command)) return lease(command);
  switch (command.type) {
    case "runner.issue": return administratorTransaction(command.token, () => runners!.issue(command.body));
    case "runner.consume": return runners!.consume(command.token, command.body);
    case "runner.authenticate": return runners!.authenticate(command.token, command.body);
    case "runner.rotate": return administratorTransaction(command.token, () => runners!.manage(command.body, false));
    case "runner.revoke": return administratorTransaction(command.token, () => runners!.manage(command.body, true));
    case "runner.inspect": return administratorTransaction(command.token, () => runners!.inspect(command.id));
    case "runner.revokeEnrollment": return administratorTransaction(command.token, () => runners!.revokeEnrollment(command.id));
    case "status": return accounts.status();
    case "authorize":
      if (command.setup) {
        if (!operator(command.token)) throw new ServiceError("Administrator setup credential required.", 401);
      } else requireAdministrator(command.token);
      return { authorized: true };
    case "setup":
      if (!operator(command.token)) throw new ServiceError("Administrator setup credential required.", 401);
      return await accounts.setup(command.body);
    case "login": return await accounts.login(command.body);
    case "session": return accounts.session(command.token);
    case "logout": requireAdministrator(command.token); return accounts.logout(command.token);
    case "applications.list": return administratorTransaction(command.token, () => ({ consumers: applications.list() }));
    case "applications.create": return administratorTransaction(command.token, () => applications.create(command.body));
    case "applications.rotate":
    case "applications.revoke":
      if (Object.keys(object(command.body)).length) throw new ServiceError("Credential rotation/revocation expects an empty object.", 400);
      return administratorTransaction(command.token, () => command.type === "applications.rotate" ? applications.rotate(command.id) : applications.revoke(command.id));
  }
}

function isModel(command: IdentityCommand): command is Extract<IdentityCommand, { type: `models.${string}` }> {
  return command.type.startsWith("models.");
}
function model(command: Extract<IdentityCommand, { type: `models.${string}` }>): unknown {
  switch (command.type) {
    case "models.submit": return jobs.submit(command.token, command.body);
    case "models.inspect": return jobs.inspect(command.token, command.id);
    case "models.cancel": return jobs.cancel(command.token, command.id, command.body);
    case "models.claim": return jobs.claim(command.token, command.body);
    case "models.assignments": return jobs.assignments(command.token, command.body);
    case "models.report": return jobs.report(command.token, command.body);
    default: break;
  }
  return administratorTransaction(command.token, () => { switch (command.type) {
    case "models.catalog": return jobs.catalog(command.body);
    case "models.domain": return jobs.defineDomain(command.body);
    case "models.domainInspect": return jobs.inspectDomain(command.id);
    case "models.grant": return jobs.grant(command.body);
    case "models.grantRevoke": return jobs.revokeGrant(command.body);
    case "models.approve": return jobs.approve(command.body);
    case "models.approvalRevoke": return jobs.revokeApproval(command.body);
    default: throw new ServiceError("Unknown endpoint.", 404);
  } });
}

function isLease(command: IdentityCommand): command is Extract<IdentityCommand, { type: `leases.${string}` }> {
  return command.type.startsWith("leases.");
}
function lease(command: Extract<IdentityCommand, { type: `leases.${string}` }>): unknown {
  switch (command.type) {
    case "leases.createTransfer": return leases.createTransfer(command.token,command.id,command.body);
    case "leases.createTransferStep": return leases.createTransferStep(command.token,command.id,command.transferId!,command.body);
    case "leases.transfer": return leases.transfer(command.token,command.id,command.transferId,command.step);
    case "leases.pollTransfer": return leases.pollTransfer(command.token,command.body);
    case "leases.reportTransfer": return leases.reportTransfer(command.token,command.body);
    case "leases.operation": return leases.operation(command.token, command.id, command.operationId);
    case "leases.createOperation": return leases.createOperation(command.token, command.id, command.body);
    case "leases.pollOperation": return leases.pollOperation(command.token, command.body);
    case "leases.reportOperation": return leases.reportOperation(command.token, command.body);
    case "leases.catalogue": return leases.catalogue(command.token);
    case "leases.list": return leases.list(command.token, command.after);
    case "leases.inspect": return leases.inspect(command.token, command.id);
    case "leases.acquire": return leases.acquire(command.token, command.body);
    case "leases.credential": return leases.credential(command.token, command.id, command.body);
    case "leases.renew": return leases.mutate(command.token, command.id, "renew", command.body);
    case "leases.release": return leases.mutate(command.token, command.id, "release", command.body);
    case "leases.claim": return leases.claim(command.token, command.body);
    case "leases.assignments": return leases.assignments(command.token, command.body);
    case "leases.report": return leases.report(command.token, command.body);
    default: break;
  }
  return administratorTransaction(command.token, () => { switch (command.type) {
    case "leases.image": return leases.image(command.body);
    case "leases.grant": return leases.grant(command.body);
    case "leases.grantRevoke": return leases.grant(command.body, true);
    case "leases.approve": return leases.approve(command.body);
    case "leases.approvalRevoke": return leases.revokeApproval(command.body);
    default: throw new ServiceError("Unknown endpoint.", 404);
  } });
}

port.on("message", (message: { id: number; command: IdentityCommand }) => {
  reply({ kind: "accepted", id: message.id });
  void dispatch(message.command).then(value => reply({ kind: "result", id: message.id, value }), error => {
    const known = error instanceof ServiceError ? error : new ServiceError("Orchestrator storage or service unavailable.", 503, {
      retryable: false, ...(mutates(message.command) ? { outcome: "unknown" as const } : {}),
    });
    reply({ kind: "error", id: message.id, error: {
      message: known.message, status: known.status, code: known.code, retryable: known.retryable,
      ...(known.outcome ? { outcome: known.outcome } : {}),
    } });
  });
});
reply({ kind: "ready" });
