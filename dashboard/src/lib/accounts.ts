import { record } from "./types";
export interface PersonalToken {
  id: string;
  name: string;
  scopes: string[];
  prefix: string;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}
export function tokenMetadata(value: unknown): PersonalToken {
  const t = record(value);
  if (
    ["id", "name", "prefix"].some((k) => typeof t[k] !== "string") ||
    !Array.isArray(t.scopes) ||
    t.scopes.some(
      (s) =>
        ![
          "machines:read",
          "machines:write",
          "machines:access",
          "admin",
        ].includes(String(s)),
    ) ||
    ["createdAt", "expiresAt"].some(
      (k) => typeof t[k] !== "number" || !Number.isFinite(t[k]),
    ) ||
    ["lastUsedAt", "revokedAt"].some(
      (k) =>
        t[k] !== null && (typeof t[k] !== "number" || !Number.isFinite(t[k])),
    )
  )
    throw new Error("Invalid API token information.");
  return t as unknown as PersonalToken;
}
export function tokenList(value: unknown): PersonalToken[] {
  const r = record(value);
  if (!Array.isArray(r.tokens)) throw new Error("Invalid API token list.");
  return r.tokens.map(tokenMetadata);
}
export function tokenState(t: PersonalToken): string {
  return t.revokedAt !== null
    ? "Revoked"
    : t.expiresAt <= Date.now() / 1000
      ? "Expired"
      : "Active";
}
export const tokenScopes = (preset: string, admin: boolean): string[] =>
  preset === "admin" && admin
    ? ["admin"]
    : preset === "manage"
      ? ["machines:read", "machines:write", "machines:access"]
      : ["machines:read"];
export function timestamp(t: number | null) {
  return t === null ? "Never" : new Date(t * 1000).toLocaleString();
}
