import { createHash, timingSafeEqual } from "node:crypto";
import { parentPort, workerData } from "node:worker_threads";
import { RunnerEnrollment } from "./enrollment.ts";
import { Accounts } from "./accounts.ts";
import { ConsumerIdentities } from "./consumers.ts";
import { object, secret, ServiceError } from "./errors.ts";
import { mutates } from "./identity-protocol.ts";
import type { IdentityCommand, IdentityReply } from "./identity-protocol.ts";
import { SqliteStore } from "./sqlite.ts";

if (!parentPort) throw new Error("Identity persistence requires its owned worker channel.");
const port = parentPort;
const administrator = secret(workerData.adminToken);
const expected = createHash("sha256").update(administrator, "ascii").digest();
const store = new SqliteStore(workerData.path as string);
const accounts = new Accounts(store), applications = new ConsumerIdentities(store);
const runners = workerData.controllerId === undefined ? undefined : new RunnerEnrollment(store, workerData.controllerId as string);
function reply(value: IdentityReply): void { port.postMessage(value); }
function operator(token: string): boolean {
  try { secret(token); } catch { return false; }
  return timingSafeEqual(expected, createHash("sha256").update(token, "ascii").digest());
}
function requireAdministrator(token: string): void {
  if (!operator(token) && !accounts.authorized(token)) throw new ServiceError("Credential rejected.", 401);
}

async function dispatch(command: IdentityCommand): Promise<unknown> {
  if (command.type.startsWith("runner.")) {
    if (!runners) throw new ServiceError("Runner enrollment requires a configured controller identity.", 503, { retryable: false });
    if (command.type !== "runner.consume" && command.type !== "runner.authenticate" && "token" in command) requireAdministrator(command.token);
  }
  switch (command.type) {
    case "runner.issue": return runners!.issue(command.body);
    case "runner.consume": return runners!.consume(command.token, command.body);
    case "runner.authenticate": return runners!.authenticate(command.token, command.body);
    case "runner.rotate": return runners!.manage(command.body, false);
    case "runner.revoke": return runners!.manage(command.body, true);
    case "runner.inspect": return runners!.inspect(command.id);
    case "runner.revokeEnrollment": return runners!.revokeEnrollment(command.id);
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
    case "applications.list": requireAdministrator(command.token); return { consumers: applications.list() };
    case "applications.create": requireAdministrator(command.token); return applications.create(command.body);
    case "applications.rotate":
    case "applications.revoke":
      requireAdministrator(command.token);
      if (Object.keys(object(command.body)).length) throw new ServiceError("Credential rotation/revocation expects an empty object.", 400);
      return command.type === "applications.rotate" ? applications.rotate(command.id) : applications.revoke(command.id);
  }
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
