import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { Accounts, ITERATIONS, SESSION_SECONDS, tokenHash } from "../../src/accounts.ts";
import type { AdminApiToken, NewApiToken, NewClaim, NewSession, User, UserRole } from "../../src/accounts.ts";
import { createModule } from "../../src/control/account-routes.ts";
import type { ControlRequest } from "../../src/control/contracts.ts";
import { ServiceError } from "../../src/errors.ts";
import { SqliteStore } from "../../src/sqlite.ts";

const password = "disposable-test-password-😀";
const failure = (status: number) => (error: unknown) => error instanceof ServiceError && error.status === status;
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "canaveral-accounts-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let now = 80_000;
  const store = new SqliteStore(join(dir, "controller.sqlite"), () => now);
  const accounts = new Accounts(store), operator = randomBytes(32).toString("base64url");
  const module = createModule(store, { adminToken: operator, controllerId: randomUUID() });
  const request = async (method: string, path: string, token = "", body: Record<string, unknown> = {}) => {
    const req: ControlRequest = { method, path, parts: path.split("/").filter(Boolean), query: new URLSearchParams(), body, token,
      principal: () => token === operator ? { kind: "operator", user: null, scopes: [] } : accounts.principal(token) };
    return (await module.handle(req))?.body;
  };
  const activate = async (username: string, role: UserRole = "user") => {
    const user = accounts.createUser(operator, { id: randomUUID(), username, role }, true);
    const invite = accounts.issueClaim(operator, "invite", user.id, true);
    return await accounts.redeem({ token: invite.token, password });
  };
  return { accounts, store, operator, request, activate, advance: (seconds: number) => { now += seconds; }, now: () => now };
}
function mint(accounts: Accounts, session: NewSession, scopes = ["machines:read"], extra: Record<string, unknown> = {}): NewApiToken & { token: string } {
  const created = accounts.tokens(session.token, { id: randomUUID(), name: "fixture", scopes, ...extra });
  assert.equal(typeof created.token, "string");
  return created as NewApiToken & { token: string };
}

test("atomic setup retains salted PBKDF2, complete public identities, and bounded sessions", async t => {
  const { accounts, store, now } = fixture(t);
  assert.deepEqual(accounts.status(), { setupRequired: true });
  const attempts = await Promise.allSettled(["Admin", "OtherAdmin"].map(username => accounts.setup({ username, password })));
  assert.equal(attempts.filter(result => result.status === "fulfilled").length, 1);
  const winner = attempts.find(result => result.status === "fulfilled") as PromiseFulfilledResult<NewSession>;
  assert.equal((attempts.find(result => result.status === "rejected") as PromiseRejectedResult).reason.status, 409);
  const created = winner.value;
  assert.equal(created.expiresAt, now() + SESSION_SECONDS);
  assert.deepEqual(Object.keys(created.user).sort(), ["createdAt", "id", "role", "status", "username"]);
  assert.equal(created.user.role, "admin");
  assert.equal(accounts.authorized(created.token), true);
  const row = store.transaction(db => db.prepare("SELECT * FROM users").get()!);
  assert.equal(row.iterations, ITERATIONS);
  assert.equal((row.salt as string).length, 64);
  assert.notEqual(row.password_hash, password);
  assert.equal(store.transaction(db => db.prepare("SELECT token_hash FROM user_sessions").get()!.token_hash), tokenHash(created.token));
  assert.deepEqual(new Accounts(store).status(), { setupRequired: false });
  const login = await accounts.login({ username: created.user.username.toUpperCase(), password });
  assert.deepEqual(login.user, created.user);
  // Bound credentials per user, without evicting other users' sessions.
  store.transaction(db => {
    for (let i = 0; i < 70; i++) db.prepare("INSERT INTO user_sessions VALUES (?,?,?)").run(tokenHash(`fake-${i}`), created.user.id, now() + 100 + i);
  });
  await accounts.login({ username: created.user.username, password });
  assert.equal(store.transaction(db => db.prepare("SELECT count(*) AS n FROM user_sessions WHERE user=?").get(created.user.id)!.n), 64);
});

test("ordinary sessions are human principals, never administrators in identity-worker compatibility", async t => {
  const { accounts, activate } = fixture(t);
  const admin = await accounts.setup({ username: "admin", password }), alice = await activate("alice");
  const p = accounts.principal(alice.token);
  assert.equal(p.kind, "session");
  assert.equal(p.user.id, alice.user.id);
  assert.equal(p.user.status, "active");
  assert.equal(accounts.authorized(alice.token), false);
  assert.throws(() => accounts.users(alice.token), failure(403));
  assert.throws(() => accounts.createUser(alice.token, { id: randomUUID(), username: "attacker" }), failure(403));
  assert.deepEqual(accounts.session(alice.token), { user: alice.user, expiresAt: alice.expiresAt });
  const read = mint(accounts, admin);
  assert.equal(accounts.authorized(read.token), false);
  assert.equal(accounts.authorized(mint(accounts, admin, ["admin"]).token), true);
  assert.throws(() => accounts.principal("é".repeat(43)), failure(401));
});

test("pending users, username collisions, and request UUID replays preserve identity", async t => {
  const { accounts, operator, activate } = fixture(t);
  const id = randomUUID(), spec = { id, username: "Pending.User" };
  const user = accounts.createUser(operator, spec, true);
  assert.equal(user.username, "pending.user");
  assert.equal(user.status, "pending");
  assert.deepEqual(accounts.createUser(operator, { ...spec, username: "PENDING.USER" }, true), user);
  assert.throws(() => accounts.createUser(operator, { ...spec, role: "admin" }, true), failure(409));
  assert.throws(() => accounts.createUser(operator, { ...spec, id: randomUUID() }, true), failure(409));
  assert.throws(() => accounts.updateUser(operator, id, { status: "active" }, true), failure(409));
  assert.equal(accounts.status().setupRequired, true);
  const bootstrap = accounts.issueClaim(operator, "bootstrap", null, true);
  const admin = await accounts.redeem({ token: bootstrap.token, username: "firstadmin", password });
  assert.equal(admin.user.role, "admin");
  assert.throws(() => accounts.issueClaim(admin.token, "bootstrap"), failure(403));
  assert.throws(() => accounts.issueClaim(operator, "bootstrap", null, true), failure(409));
  await activate("otheruser");
  assert.equal(accounts.users(admin.token).users.length, 3);
});

test("invitations replace earlier claims, expire, reject username changes and redeem once under a race", async t => {
  const { accounts, operator, advance, now, store } = fixture(t);
  const user = accounts.createUser(operator, { id: randomUUID(), username: "invitee" }, true);
  const old = accounts.issueClaim(operator, "invite", user.id, true), claim = accounts.issueClaim(operator, "invite", user.id, true);
  assert.throws(() => accounts.claimInfo({ token: old.token }), failure(401));
  assert.deepEqual(accounts.claimInfo({ token: claim.token }), { kind: "invite", username: "invitee", expiresAt: now() + 86400 });
  assert.equal(store.transaction(db => db.prepare("SELECT token_hash FROM account_claims").get()!.token_hash), tokenHash(claim.token));
  await assert.rejects(accounts.redeem({ token: claim.token, username: "different", password }), failure(401));
  advance(86400);
  assert.throws(() => accounts.claimInfo({ token: claim.token }), failure(401));
  const replacement = accounts.issueClaim(operator, "invite", user.id, true);
  const attempts = await Promise.allSettled([0, 1].map(() => accounts.redeem({ token: replacement.token, password })));
  assert.equal(attempts.filter(result => result.status === "fulfilled").length, 1);
  assert.equal((attempts.find(result => result.status === "rejected") as PromiseRejectedResult).reason.status, 401);
  assert.equal(store.transaction(db => db.prepare("SELECT count(*) AS n FROM user_sessions").get()!.n), 1);
  assert.equal(store.transaction(db => db.prepare("SELECT count(*) AS n FROM account_claims").get()!.n), 0);
  assert.throws(() => accounts.issueClaim(operator, "invite", user.id, true), failure(409));
});

test("bootstrap claim expiry, replacement and first-admin race backfill only unowned non-leased machines", async t => {
  const { accounts, operator, store, advance } = fixture(t);
  const ordinary = randomUUID(), leased = randomUUID(), alreadyOwned = randomUUID();
  store.transaction(db => {
    db.exec("CREATE TABLE machines(id TEXT PRIMARY KEY,owner TEXT); CREATE TABLE lease_members(lease TEXT,name TEXT,machine TEXT);");
    db.prepare("INSERT INTO machines VALUES (?,NULL),(?,NULL),(?,'existing')").run(ordinary, leased, alreadyOwned);
    db.prepare("INSERT INTO lease_members VALUES (?,?,?)").run(randomUUID(), "primary", leased);
  });
  const expired = accounts.issueClaim(operator, "bootstrap", null, true);
  advance(900);
  await assert.rejects(accounts.redeem({ token: expired.token, username: "admin", password }), failure(401));
  const replaced = accounts.issueClaim(operator, "bootstrap", null, true), claim = accounts.issueClaim(operator, "bootstrap", null, true);
  assert.throws(() => accounts.claimInfo({ token: replaced.token }), failure(401));
  const results = await Promise.allSettled(["firstadmin", "secondadmin"].map(username => accounts.redeem({ token: claim.token, username, password })));
  const successful = results.filter(result => result.status === "fulfilled") as PromiseFulfilledResult<NewSession>[];
  assert.equal(successful.length, 1);
  assert.equal((results.find(result => result.status === "rejected") as PromiseRejectedResult).reason.status, 401);
  store.transaction(db => {
    assert.equal(db.prepare("SELECT owner FROM machines WHERE id=?").get(ordinary)!.owner, successful[0]!.value.user.id);
    assert.equal(db.prepare("SELECT owner FROM machines WHERE id=?").get(leased)!.owner, null);
    assert.equal(db.prepare("SELECT owner FROM machines WHERE id=?").get(alreadyOwned)!.owner, "existing");
  });
});

test("personal token scopes, bounds, expiry, last-use throttling and one-time secret replays", async t => {
  const { accounts, store, activate, advance, now } = fixture(t);
  await accounts.setup({ username: "admin", password });
  const alice = await activate("alice"), bob = await activate("bobby");
  const id = randomUUID(), spec = { id, name: "read only", scopes: ["machines:read", "machines:access"], expiresInSeconds: 120 };
  const made = accounts.tokens(alice.token, spec);
  assert.ok(made.token);
  const { token: secret, ...metadata } = made;
  assert.deepEqual(accounts.tokens(alice.token, { ...spec, scopes: [...spec.scopes].reverse() }), metadata);
  assert.equal(accounts.tokens(alice.token).tokens[0]!.id, made.id);
  assert.throws(() => accounts.tokens(alice.token, { ...spec, name: "changed" }), failure(409));
  assert.throws(() => accounts.tokens(bob.token, { ...spec, name: "foreign" }), failure(404));
  assert.throws(() => accounts.tokens(bob.token, undefined, id), failure(404));
  assert.throws(() => accounts.tokens(alice.token, { ...spec, id: randomUUID(), scopes: ["admin"] }), failure(403));
  const p = accounts.principal(made.token);
  assert.equal(p.kind, "token");
  assert.deepEqual(p.scopes, ["machines:access", "machines:read"]);
  assert.equal(p.user.id, alice.user.id);
  for (const action of [() => accounts.session(made.token!), () => accounts.logout(made.token!), () => accounts.tokens(made.token!), () => accounts.tokens(made.token!, { ...spec, id: randomUUID() })]) assert.throws(action, failure(401));
  const stored = store.transaction(db => db.prepare("SELECT * FROM api_tokens WHERE id=?").get(id)!);
  assert.equal(stored.token_hash, tokenHash(made.token));
  assert.equal(stored.last_used, now());
  assert.equal(stored.prefix, made.token.slice(0, 8));
  advance(30); accounts.principal(made.token);
  assert.equal(store.transaction(db => db.prepare("SELECT last_used FROM api_tokens WHERE id=?").get(id)!.last_used), stored.last_used);
  advance(30); accounts.principal(made.token);
  assert.equal(store.transaction(db => db.prepare("SELECT last_used FROM api_tokens WHERE id=?").get(id)!.last_used), now());
  advance(60); assert.throws(() => accounts.principal(made.token!), failure(401));
  for (const ttl of [null, true, 59, 31536001, 60.5, "60"]) assert.throws(() => accounts.tokens(alice.token, { ...spec, id: randomUUID(), expiresInSeconds: ttl }), failure(400));
  for (const scopes of [[], ["machines:read", "machines:read"], ["all"], [null]]) assert.throws(() => accounts.tokens(alice.token, { ...spec, id: randomUUID(), scopes }), failure(400));
  for (const ttl of [60, 31536000]) assert.equal(mint(accounts, alice, ["machines:read"], { expiresInSeconds: ttl }).expiresAt, now() + ttl);
  const defaults = mint(accounts, alice);
  assert.equal(defaults.expiresAt - defaults.createdAt, 2592000);
  const revoked = accounts.tokens(alice.token, undefined, defaults.id);
  advance(10);
  assert.deepEqual(accounts.tokens(alice.token, undefined, defaults.id), revoked);
  assert.throws(() => accounts.principal(defaults.token), failure(401));
  assert.equal(accounts.session(alice.token).user.id, alice.user.id);
});

test("current role, persisted scope reduction, disable and re-enable take effect on every credential check", async t => {
  const { accounts, operator, activate, store } = fixture(t);
  const first = await accounts.setup({ username: "admin", password }), second = await activate("otheradmin", "admin");
  const adminToken = mint(accounts, first, ["admin"]), reduced = mint(accounts, second, ["machines:read", "machines:access"]);
  accounts.updateUser(second.token, first.user.id, { role: "user" });
  assert.equal(accounts.principal(first.token).user.role, "user");
  assert.equal(accounts.authorized(first.token), false);
  assert.equal(accounts.authorized(adminToken.token), false);
  assert.throws(() => accounts.users(adminToken.token), failure(403));
  store.transaction(db => db.prepare("UPDATE api_tokens SET scopes=? WHERE id=?").run(JSON.stringify(["machines:access"]), reduced.id));
  assert.deepEqual(accounts.principal(reduced.token).scopes, ["machines:access"]);
  accounts.updateUser(second.token, first.user.id, { status: "disabled" });
  assert.throws(() => accounts.principal(first.token), failure(401));
  assert.throws(() => accounts.principal(adminToken.token), failure(401));
  assert.throws(() => accounts.updateUser(second.token, first.user.id, { status: "active" }), failure(409));
  accounts.updateUser(second.token, first.user.id, { status: "pending" });
  assert.throws(() => accounts.updateUser(second.token, first.user.id, { status: "active" }), failure(409));
  await assert.rejects(accounts.login({ username: "admin", password }), failure(401));
  const invitation = accounts.issueClaim(operator, "invite", first.user.id, true);
  accounts.updateUser(second.token, first.user.id, { status: "pending" });
  const restored = await accounts.redeem({ token: invitation.token, password: password + "changed" });
  assert.equal(restored.user.id, first.user.id);
  assert.throws(() => accounts.principal(adminToken.token), failure(401));
  await assert.rejects(accounts.login({ username: "admin", password }), failure(401));
});

test("last active administrator cannot be removed or reset except explicit operator recovery", async t => {
  const { accounts, activate, operator } = fixture(t);
  const first = await accounts.setup({ username: "admin", password });
  for (const body of [{ role: "user" }, { status: "disabled" }, { status: "pending" }]) assert.throws(() => accounts.updateUser(operator, first.user.id, body, true), failure(409));
  assert.throws(() => accounts.issueClaim(first.token, "reset", first.user.id), failure(409));
  const second = await activate("secondadmin", "admin");
  accounts.updateUser(operator, second.user.id, { status: "disabled" }, true);
  assert.throws(() => accounts.updateUser(operator, first.user.id, { status: "disabled" }, true), failure(409));
  const token = mint(accounts, first);
  const reset = accounts.issueClaim(operator, "reset", first.user.id, true);
  assert.throws(() => accounts.session(first.token), failure(401));
  assert.throws(() => accounts.principal(token.token), failure(401));
  await assert.rejects(accounts.login({ username: "admin", password }), failure(401));
  const restored = await accounts.redeem({ token: reset.token, password: password + "new" });
  assert.equal(restored.user.id, first.user.id);
  assert.equal(accounts.authorized(restored.token), true);
});

test("reset blocks old passwords immediately and password changes revoke every session/token", async t => {
  const { accounts, activate, operator } = fixture(t);
  const admin = await accounts.setup({ username: "admin", password }), alice = await activate("alice");
  const extraSession = await accounts.login({ username: "alice", password }), pat = mint(accounts, alice);
  const reset = accounts.issueClaim(admin.token, "reset", alice.user.id);
  for (const raw of [alice.token, extraSession.token, pat.token]) assert.throws(() => accounts.principal(raw), failure(401));
  await assert.rejects(accounts.login({ username: "alice", password }), failure(401));
  accounts.updateUser(admin.token, alice.user.id, { status: "disabled" });
  assert.throws(() => accounts.claimInfo({ token: reset.token }), failure(401));
  assert.throws(() => accounts.issueClaim(admin.token, "reset", alice.user.id), failure(409));
  const recovery = accounts.issueClaim(operator, "reset", alice.user.id, true);
  const restored = await accounts.redeem({ token: recovery.token, password });
  const newToken = mint(accounts, restored);
  await assert.rejects(accounts.changePassword(restored.token, { currentPassword: password + "wrong", password: password + "new" }), failure(401));
  assert.equal(accounts.session(restored.token).user.id, alice.user.id);
  await accounts.changePassword(restored.token, { currentPassword: password, password: password + "new" });
  assert.throws(() => accounts.session(restored.token), failure(401));
  assert.throws(() => accounts.principal(newToken.token), failure(401));
  await assert.rejects(accounts.login({ username: "alice", password }), failure(401));
});

test("login revalidation prevents reset/disable races while hashing outside the write lock", async t => {
  const { accounts, activate, operator } = fixture(t);
  await accounts.setup({ username: "admin", password });
  const alice = await activate("alice");
  const pendingLogin = accounts.login({ username: "alice", password });
  accounts.updateUser(operator, alice.user.id, { status: "disabled" }, true);
  await assert.rejects(pendingLogin, failure(401));
  const recovery = accounts.issueClaim(operator, "reset", alice.user.id, true);
  const restored = await accounts.redeem({ token: recovery.token, password });
  const resetRace = accounts.login({ username: "alice", password });
  accounts.issueClaim(operator, "reset", restored.user.id, true);
  await assert.rejects(resetRace, failure(401));
});

test("claim redemption revalidates revoked invitations and changed roles after hashing", async t => {
  const { accounts, operator, store } = fixture(t);
  const user = accounts.createUser(operator, { id: randomUUID(), username: "invitee" }, true);
  const claim = accounts.issueClaim(operator, "invite", user.id, true);
  const pending = accounts.redeem({ token: claim.token, password });
  accounts.revokeClaim(operator, user.id, true);
  await assert.rejects(pending, failure(401));
  const second = accounts.issueClaim(operator, "invite", user.id, true);
  const changedRole = accounts.redeem({ token: second.token, password });
  accounts.updateUser(operator, user.id, { role: "admin" }, true);
  await assert.rejects(changedRole, failure(401));
  assert.equal(store.transaction(db => db.prepare("SELECT count(*) AS n FROM user_sessions").get()!.n), 0);
});

test("sign-in and claim budget is shared, bounded and persistent across restarts", async t => {
  const { accounts, store, advance } = fixture(t);
  await accounts.setup({ username: "admin", password });
  for (let i = 0; i < 5; i++) {
    await assert.rejects(accounts.login({ username: "unknown", password: "bad" }), failure(401));
    assert.throws(() => accounts.claimInfo({ token: "invalid" }), failure(401));
  }
  const restarted = new Accounts(store);
  await assert.rejects(restarted.login({ username: "admin", password }), failure(429));
  await assert.rejects(restarted.redeem({ token: "invalid", password }), failure(429));
  assert.equal(store.transaction(db => db.prepare("SELECT attempts FROM auth_throttle").get()!.attempts), 10);
  advance(60);
  assert.equal((await restarted.login({ username: "ADMIN", password })).user.role, "admin");
});

test("account route module enforces operator-only setup/bootstrap and session-only token management", async t => {
  const { request, operator, accounts } = fixture(t);
  assert.deepEqual(await request("GET", "/v1/auth/status"), { setupRequired: true });
  await assert.rejects(request("POST", "/v1/auth/setup", "", { username: "admin", password }), failure(401));
  await assert.rejects(request("POST", "/v1/auth/bootstrap"), failure(403));
  const bootstrap = await request("POST", "/v1/auth/bootstrap", operator) as NewClaim;
  assert.equal(bootstrap.kind, "bootstrap");
  assert.equal((await request("POST", "/v1/auth/claim/info", "", { token: bootstrap.token }) as NewClaim).kind, "bootstrap");
  const admin = await request("POST", "/v1/auth/claim", "", { token: bootstrap.token, username: "admin", password }) as NewSession;
  const token = await request("POST", "/v1/auth/tokens", admin.token, { id: randomUUID(), name: "api", scopes: ["admin"] }) as Required<NewApiToken>;
  for (const raw of [operator, token.token]) {
    await assert.rejects(request("GET", "/v1/auth/session", raw), failure(401));
    await assert.rejects(request("POST", "/v1/auth/logout", raw), failure(401));
    await assert.rejects(request("GET", "/v1/auth/tokens", raw), failure(401));
    await assert.rejects(request("POST", "/v1/auth/password", raw, { currentPassword: password, password: password + "new" }), failure(401));
  }
  await assert.rejects(request("POST", "/v1/auth/bootstrap", admin.token), failure(403));
  await assert.rejects(request("POST", "/v1/auth/logout", admin.token, { extra: true }), failure(400));
  assert.equal((await request("GET", "/v1/auth/session", admin.token) as NewSession).user.id, admin.user.id);
  await request("POST", "/v1/auth/tokens/" + token.id + "/revoke", admin.token);
  await assert.rejects(request("GET", "/v1/admin/tokens", token.token), failure(401));
  await request("POST", "/v1/auth/logout", admin.token);
  assert.equal(accounts.authorized(admin.token), false);
  assert.equal(await request("GET", "/v1/machines", operator), undefined);
});

test("user management routes preserve pending/re-enable/reset/revoked invitation rules", async t => {
  const { request, operator, accounts } = fixture(t);
  const admin = await request("POST", "/v1/auth/setup", operator, { username: "admin", password }) as NewSession;
  const user = await request("POST", "/v1/users", admin.token, { id: randomUUID(), username: "invitee" }) as User;
  const path = "/v1/users/" + user.id;
  const invitation = await request("POST", path + "/invite", admin.token) as NewClaim;
  await request("POST", path + "/revoke-invite", admin.token);
  await assert.rejects(request("POST", "/v1/auth/claim/info", "", { token: invitation.token }), failure(401));
  const replacement = await request("POST", path + "/invite", operator) as NewClaim;
  const alice = await request("POST", "/v1/auth/claim", "", { token: replacement.token, password }) as NewSession;
  await assert.rejects(request("GET", "/v1/users", alice.token), failure(403));
  await request("POST", path + "/update", admin.token, { status: "disabled" });
  await assert.rejects(request("POST", path + "/update", admin.token, { status: "active" }), failure(409));
  await request("POST", path + "/update", admin.token, { status: "pending" });
  assert.throws(() => accounts.session(alice.token), failure(401));
  assert.equal((await request("POST", path + "/invite", admin.token) as NewClaim).username, user.username);
  const reset = await request("POST", path + "/reset-password", operator) as NewClaim;
  const restored = await request("POST", "/v1/auth/claim", "", { token: reset.token, password }) as NewSession;
  assert.equal(restored.user.id, user.id);
  await request("POST", "/v1/auth/password", restored.token, { currentPassword: password, password: password + "new" });
  assert.throws(() => accounts.session(restored.token), failure(401));
  assert.equal((await request("POST", "/v1/auth/login", "", { username: "invitee", password: password + "new" }) as NewSession).user.id, user.id);
});

test("admin token metadata includes terminal records, is safe and sorted, and revocation can revoke the caller", async t => {
  const { accounts, activate, request, operator, advance } = fixture(t);
  const admin = await accounts.setup({ username: "admin", password }), alice = await activate("alice");
  const target = mint(accounts, alice), expired = mint(accounts, alice, ["machines:read"], { expiresInSeconds: 60 });
  const revoked = mint(accounts, admin); accounts.tokens(admin.token, undefined, revoked.id);
  const administrative = mint(accounts, admin, ["admin"]), read = mint(accounts, admin);
  advance(61);
  const adminTokens = async (token: string) => (await request("GET", "/v1/admin/tokens", token) as { tokens: AdminApiToken[] }).tokens;
  for (const actor of [admin.token, administrative.token, operator]) {
    const list = await adminTokens(actor);
    assert.equal(list.length, 5);
    assert.deepEqual(list.map(t => t.id), [...list.map(t => t.id)].sort());
    assert.equal(list.find(t => t.id === target.id)!.userId, alice.user.id);
    assert.equal(list.find(t => t.id === expired.id)!.expiresAt, expired.expiresAt);
    assert.equal(list.find(t => t.id === revoked.id)!.revokedAt, revoked.createdAt);
    for (const row of list) assert.deepEqual(Object.keys(row).sort(), ["createdAt", "expiresAt", "id", "lastUsedAt", "name", "prefix", "revokedAt", "scopes", "userId"]);
  }
  for (const actor of [alice.token, target.token, read.token]) {
    await assert.rejects(adminTokens(actor), failure(403));
    await assert.rejects(request("POST", `/v1/admin/tokens/${target.id}/revoke`, actor), failure(403));
  }
  const result = await request("POST", `/v1/admin/tokens/${target.id}/revoke`, administrative.token) as AdminApiToken;
  advance(5);
  assert.deepEqual(await request("POST", `/v1/admin/tokens/${target.id}/revoke`, admin.token), result);
  assert.throws(() => accounts.principal(target.token), failure(401));
  assert.equal(accounts.session(alice.token).user.id, alice.user.id);
  await request("POST", `/v1/admin/tokens/${administrative.id}/revoke`, administrative.token);
  await assert.rejects(adminTokens(administrative.token), failure(401));
  assert.equal(accounts.session(admin.token).user.id, admin.user.id);
});

test("unknown fields and unsupported admin token/user routes cannot mutate or mint", async t => {
  const { accounts, request, operator } = fixture(t);
  const admin = await accounts.setup({ username: "admin", password }), token = mint(accounts, admin);
  await assert.rejects(request("POST", "/v1/auth/login", "", { username: "admin", password, role: "admin" }), failure(400));
  for (const path of ["/v1/auth/bootstrap", `/v1/auth/tokens/${token.id}/revoke`, `/v1/admin/tokens/${token.id}/revoke`]) {
    await assert.rejects(request("POST", path, path.endsWith("bootstrap") ? operator : admin.token, { userId: admin.user.id }), failure(400));
  }
  for (const [method, path] of [["POST", "/v1/admin/tokens"], ["GET", `/v1/admin/tokens/${token.id}`], ["GET", "/v1/auth/login"], ["POST", "/v1/auth/unknown"], ["POST", `/v1/users/${admin.user.id}/delete`]]) {
    await assert.rejects(request(method!, path!, admin.token), failure(404));
  }
  await assert.rejects(request("POST", "/v1/admin/tokens/not-a-uuid/revoke", admin.token), failure(400));
  await assert.rejects(request("POST", `/v1/admin/tokens/${randomUUID()}/revoke`, admin.token), failure(404));
  assert.equal(accounts.tokens(admin.token).tokens.length, 1);
  assert.equal(accounts.principal(token.token).kind, "token");
});

test("account administration authenticates inside the storage transaction even with a stale request principal", async t => {
  const { accounts, store, activate, operator } = fixture(t);
  const admin = await accounts.setup({ username: "admin", password });
  const second = await activate("secondadmin", "admin");
  const credential = mint(accounts, admin, ["admin"]), stale = accounts.principal(credential.token);
  const module = createModule(store, { adminToken: operator, controllerId: randomUUID() });
  const path = "/v1/admin/tokens";
  const request: ControlRequest = { method: "GET", path, parts: ["v1", "admin", "tokens"], query: new URLSearchParams(), body: {}, token: credential.token, principal: () => stale };
  accounts.updateUser(operator, admin.user.id, { role: "user" }, true);
  await assert.rejects(async () => await module.handle(request), failure(403));
  accounts.updateUser(operator, admin.user.id, { status: "disabled" }, true);
  await assert.rejects(async () => await module.handle(request), failure(401));
  // The nested account check must see uncommitted changes in the mutation owner.
  store.transaction(db => {
    db.prepare("UPDATE users SET status='disabled' WHERE id=?").run(second.user.id);
    assert.throws(() => accounts.principal(second.token), failure(401));
    db.prepare("UPDATE users SET status='active' WHERE id=?").run(second.user.id);
    assert.equal(accounts.principal(second.token).user.status, "active");
  });
});
