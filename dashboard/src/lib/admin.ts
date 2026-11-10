import { record } from "./types";
import { user, type Machine, type User } from "./inventory";
import { tokenMetadata, type PersonalToken } from "./accounts";

export interface AdminToken extends PersonalToken {
  userId: string;
}
export function adminToken(value: unknown): AdminToken {
  const r = record(value);
  if (typeof r.userId !== "string" || !r.userId)
    throw new Error("Invalid API token owner.");
  return { ...tokenMetadata(r), userId: r.userId };
}
export function adminTokens(value: unknown): AdminToken[] {
  const r = record(value);
  if (!Array.isArray(r.tokens)) throw new Error("Invalid API access list.");
  return r.tokens.map(adminToken);
}
export function adminUsers(value: unknown): User[] {
  const r = record(value);
  if (!Array.isArray(r.users)) throw new Error("Invalid users list.");
  return r.users.map(user);
}
export function ownerLabel(machine: Machine, users: User[]) {
  return machine.ownerId
    ? users.find((u) => u.id === machine.ownerId)?.username || machine.ownerId
    : machine.ownerId === null
      ? "No user owner"
      : "Owner unavailable";
}
