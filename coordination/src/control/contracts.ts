import type { SqliteStore } from "../sqlite.ts";
import { ServiceError } from "../errors.ts";

export interface Principal {
  kind: "operator" | "session" | "token";
  user: { id: string; username: string; role: "admin" | "user"; status: string } | null;
  scopes: string[];
}
export interface ControlRequest {
  method: string;
  path: string;
  parts: string[];
  query: URLSearchParams;
  token: string;
  body: Record<string, unknown>;
  /** Resolve current credential status immediately before protected work. */
  principal(): Principal;
}
export interface ControlResponse { status?: number; body: unknown }
export interface ControlModule {
  handle(request: ControlRequest): ControlResponse | undefined | Promise<ControlResponse | undefined>;
}
export interface ControlOptions { adminToken: string; enrollmentToken?: string; controllerId: string; updatePublicKeys?: Record<string, string> }
export type ModuleFactory = (store: SqliteStore, options: ControlOptions) => ControlModule;

export function requireScope(request: ControlRequest, action: "read" | "write" | "access" | "admin"): Principal {
  const principal = request.principal();
  if (principal.kind === "operator") return principal;
  if (principal.user?.role === "admin" && principal.scopes.includes("admin")) return principal;
  if (action === "admin" || !principal.scopes.includes(`machines:${action}`)) throw new ServiceError("Credential scope does not permit this action.", 403);
  return principal;
}
export function requireAdmin(request: ControlRequest): Principal { return requireScope(request, "admin"); }
export function owns(principal: Principal, owner: unknown): boolean {
  return principal.kind === "operator" || principal.user?.role === "admin" || (principal.user !== null && principal.user.id === owner);
}
