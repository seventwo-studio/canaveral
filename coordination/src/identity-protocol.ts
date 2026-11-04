export type IdentityCommand =
  | { type: "runner.issue" | "runner.consume" | "runner.authenticate" | "runner.rotate" | "runner.revoke"; token: string; body: unknown }
  | { type: "runner.inspect" | "runner.revokeEnrollment"; token: string; id: string }
  | { type: "status" }
  | { type: "authorize"; token: string; setup: boolean }
  | { type: "setup"; token: string; body: unknown }
  | { type: "login"; body: unknown }
  | { type: "session"; token: string }
  | { type: "logout"; token: string }
  | { type: "applications.list"; token: string }
  | { type: "applications.create"; token: string; body: unknown }
  | { type: "applications.rotate" | "applications.revoke"; token: string; id: string; body: unknown }
  | { type: "models.catalog" | "models.domain" | "models.grant" | "models.grantRevoke" | "models.approve" | "models.approvalRevoke"; token: string; body: unknown }
  | { type: "models.domainInspect" | "models.inspect"; token: string; id: string }
  | { type: "models.submit" | "models.claim" | "models.assignments" | "models.report"; token: string; body: unknown }
  | { type: "models.cancel"; token: string; id: string; body: unknown };

export function mutates(command: IdentityCommand): boolean {
  return !["status", "authorize", "session", "applications.list", "runner.inspect", "runner.authenticate",
    "models.domainInspect", "models.inspect", "models.assignments"].includes(command.type);
}

export type IdentityReply =
  | { kind: "ready" }
  | { kind: "accepted"; id: number }
  | { kind: "result"; id: number; value: unknown }
  | { kind: "error"; id: number; error: {
      message: string; status: number; code: string; retryable: boolean; outcome?: "unknown";
    } };
