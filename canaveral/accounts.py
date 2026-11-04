"""Administrator identity and revocable sessions in the controller database."""

import hashlib
import re
import secrets

from .model import Error, secret


ITERATIONS = 600000
SESSION_SECONDS = 30 * 24 * 60 * 60


def username(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.@+-]{2,99}", value):
        raise Error("Use a username of 3–100 letters, numbers, dots, underscores, @, + or -.", 400)
    return value.lower()


def password_bytes(value):
    if not isinstance(value, str) or not 12 <= len(value) <= 1024:
        raise Error("Use a password of 12–1024 characters.", 400)
    encoded = value.encode("utf-8")
    if len(encoded) > 4096:
        raise Error("Password is too long.", 400)
    return encoded


def password_hash(password, salt, iterations=ITERATIONS):
    return hashlib.pbkdf2_hmac("sha256", password, bytes.fromhex(salt), iterations).hex()


def token_hash(token):
    return hashlib.sha256(token.encode("ascii")).hexdigest()


class Accounts:
    def __init__(self, store):
        self.store = store
        self.dummy_salt = secrets.token_hex(32)
        with store.transaction() as db:
            db.execute("CREATE TABLE IF NOT EXISTS administrator (id INTEGER PRIMARY KEY CHECK (id=1), username TEXT NOT NULL UNIQUE, salt TEXT NOT NULL, password_hash TEXT NOT NULL, iterations INTEGER NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS admin_sessions (token_hash TEXT PRIMARY KEY, expires REAL NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS auth_throttle (id INTEGER PRIMARY KEY CHECK (id=1), started REAL NOT NULL, attempts INTEGER NOT NULL)")

    def status(self):
        with self.store.transaction() as db:
            return {"setupRequired": db.execute("SELECT 1 FROM administrator").fetchone() is None}

    def _session(self, db, name):
        token = secrets.token_urlsafe(32)
        expires = self.store.clock() + SESSION_SECONDS
        db.execute("DELETE FROM admin_sessions WHERE expires<=?", (self.store.clock(),))
        # Bound live sessions as well as expired rows, even with repeated logins.
        db.execute("DELETE FROM admin_sessions WHERE token_hash IN (SELECT token_hash FROM admin_sessions ORDER BY expires DESC LIMIT -1 OFFSET 63)")
        db.execute("INSERT INTO admin_sessions VALUES (?,?)", (token_hash(token), expires))
        return {"token": token, "expiresAt": expires, "user": {"username": name}}

    def setup(self, value):
        name = username(value.get("username"))
        password = password_bytes(value.get("password"))
        # The transaction is the guard against concurrent first-run requests.
        with self.store.transaction() as db:
            if db.execute("SELECT 1 FROM administrator").fetchone():
                raise Error("An administrator already exists. Sign in with the existing account.", 409)
            salt = secrets.token_hex(32)
            encoded = password_hash(password, salt)
            db.execute("INSERT INTO administrator VALUES (1,?,?,?,?)", (name, salt, encoded, ITERATIONS))
            return self._session(db, name)

    def _attempt(self):
        # A persistent global budget also bounds guesses with random usernames
        # and concurrent requests through multiple dashboard replicas.
        now = self.store.clock()
        with self.store.transaction() as db:
            row = db.execute("SELECT started,attempts FROM auth_throttle WHERE id=1").fetchone()
            if not row or now - row["started"] >= 60:
                db.execute("INSERT OR REPLACE INTO auth_throttle VALUES (1,?,1)", (now,))
            else:
                if row["attempts"] >= 10:
                    raise Error("Too many sign-in attempts. Try again in one minute.", 429)
                db.execute("UPDATE auth_throttle SET attempts=attempts+1 WHERE id=1")

    def login(self, value):
        self._attempt()
        try:
            name = username(value.get("username"))
            password = password_bytes(value.get("password"))
        except Error:
            raise Error("Username or password rejected.", 401)
        with self.store.transaction() as db:
            account = db.execute("SELECT * FROM administrator WHERE username=?", (name,)).fetchone()
        # Do the same expensive derivation for an unknown user. Never store or
        # return a plaintext password, and keep credential errors indistinct.
        encoded = password_hash(password, account["salt"] if account else self.dummy_salt,
                                account["iterations"] if account else ITERATIONS)
        expected = account["password_hash"] if account else "0" * 64
        if not secrets.compare_digest(encoded, expected) or account is None:
            raise Error("Username or password rejected.", 401)
        with self.store.transaction() as db:
            return self._session(db, name)

    def session(self, token):
        try:
            secret(token)
        except Error:
            raise Error("Session credential rejected.", 401)
        with self.store.transaction() as db:
            row = db.execute("SELECT expires FROM admin_sessions WHERE token_hash=?", (token_hash(token),)).fetchone()
            if row is None or row["expires"] <= self.store.clock():
                raise Error("Session credential rejected.", 401)
            name = db.execute("SELECT username FROM administrator WHERE id=1").fetchone()[0]
            return {"user": {"username": name}, "expiresAt": row["expires"]}

    def authorized(self, token):
        try:
            self.session(token)
            return True
        except Error:
            return False

    def logout(self, token):
        try:
            secret(token)
        except Error:
            raise Error("Session credential rejected.", 401)
        with self.store.transaction() as db:
            db.execute("DELETE FROM admin_sessions WHERE token_hash=?", (token_hash(token),))
        return {"ok": True}
