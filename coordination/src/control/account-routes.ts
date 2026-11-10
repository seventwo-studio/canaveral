import { timingSafeEqual } from "node:crypto";
import { Accounts, fields } from "../accounts.ts";
import { ServiceError } from "../errors.ts";
import type { SqliteStore } from "../sqlite.ts";
import { requireAdmin } from "./contracts.ts";
import type { ControlModule, ControlOptions } from "./contracts.ts";

export function createModule(store: SqliteStore, options: ControlOptions): ControlModule {
  const accounts = new Accounts(store);
  function operator(token: string): boolean {
    const actual = Buffer.from(token), expected = Buffer.from(options.adminToken);
    return expected.length > 0 && actual.length === expected.length && timingSafeEqual(actual, expected);
  }
  return {
    async handle(req) {
      const { method, parts, body, token } = req;
      const auth = parts[0] === "v1" && parts[1] === "auth";
      const users = parts[0] === "v1" && parts[1] === "users";
      const adminTokens = parts[0] === "v1" && parts[1] === "admin" && parts[2] === "tokens";
      if (!auth && !users && !adminTokens) return undefined;
      const isOperator = operator(token);
      // Protected methods also authenticate inside the account storage transaction.
      const admin = () => { if (!isOperator) requireAdmin(req); };
      if (auth) {
        if (method === "GET" && parts.length === 3 && parts[2] === "status") return { body: accounts.status() };
        if (method === "POST" && parts.length === 3) {
          switch (parts[2]) {
            case "setup":
              if (!isOperator) throw new ServiceError("Administrator setup credential required.", 401);
              return { body: await accounts.setup(body) };
            case "login": return { body: await accounts.login(body) };
            case "logout": fields(body, []); return { body: accounts.logout(token) };
            case "password": return { body: await accounts.changePassword(token, body) };
            case "bootstrap":
              if (!isOperator) throw new ServiceError("Operator credential required.", 403);
              fields(body, []);
              return { body: accounts.issueClaim(token, "bootstrap", null, true) };
            case "claim": return { body: await accounts.redeem(body) };
            case "tokens": return { body: accounts.tokens(token, body) };
          }
        }
        if (method === "GET" && parts.length === 3 && parts[2] === "session") return { body: accounts.session(token) };
        if (method === "GET" && parts.length === 3 && parts[2] === "tokens") return { body: accounts.tokens(token) };
        if (method === "POST" && parts.length === 4 && parts[2] === "claim" && parts[3] === "info") return { body: accounts.claimInfo(body) };
        if (method === "POST" && parts.length === 5 && parts[2] === "tokens" && parts[4] === "revoke") {
          fields(body, []);
          return { body: accounts.tokens(token, undefined, parts[3]!) };
        }
      }
      if (users) {
        admin();
        if (parts.length === 2 && method === "GET") return { body: accounts.users(token, isOperator) };
        if (parts.length === 2 && method === "POST") return { body: accounts.createUser(token, body, isOperator) };
        if (parts.length === 4 && method === "POST") {
          const id = parts[2]!;
          switch (parts[3]) {
            case "update": return { body: accounts.updateUser(token, id, body, isOperator) };
            case "invite": fields(body, []); return { body: accounts.issueClaim(token, "invite", id, isOperator) };
            case "reset-password": fields(body, []); return { body: accounts.issueClaim(token, "reset", id, isOperator) };
            case "revoke-invite": fields(body, []); return { body: accounts.revokeClaim(token, id, isOperator) };
          }
        }
      }
      if (adminTokens) {
        admin();
        if (method === "GET" && parts.length === 3) return { body: accounts.adminTokens(token, undefined, isOperator) };
        if (method === "POST" && parts.length === 5 && parts[4] === "revoke") {
          fields(body, []);
          return { body: accounts.adminTokens(token, parts[3]!, isOperator) };
        }
      }
      throw new ServiceError("Unknown endpoint.", 404);
    },
  };
}
