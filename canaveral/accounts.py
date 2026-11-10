"""Administrator identity and revocable sessions in the controller database."""

import hashlib
import re
import secrets
import json
import sqlite3
import uuid

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


SCOPES = {'machines:read', 'machines:write', 'machines:access', 'admin'}


def fields(value, allowed, required=()):
    if not isinstance(value, dict) or set(value) - set(allowed) or set(required) - set(value):
        raise Error('Invalid request fields.', 400)


def public(row):
    return {key: row[column] for key, column in [('id','id'), ('username','username'), ('role','role'), ('status','status'), ('createdAt','created')]}


class Accounts:
    def __init__(self, store):
        self.store = store
        self.dummy_salt = secrets.token_hex(32)
        with store.transaction() as db:
            db.execute('CREATE TABLE IF NOT EXISTS administrator (id INTEGER PRIMARY KEY CHECK(id=1),username TEXT UNIQUE NOT NULL,salt TEXT NOT NULL,password_hash TEXT NOT NULL,iterations INTEGER NOT NULL)')
            db.execute('CREATE TABLE IF NOT EXISTS admin_sessions (token_hash TEXT PRIMARY KEY,expires REAL NOT NULL)')
            db.execute('CREATE TABLE IF NOT EXISTS auth_throttle (id INTEGER PRIMARY KEY CHECK(id=1),started REAL NOT NULL,attempts INTEGER NOT NULL)')
            db.execute('CREATE TABLE IF NOT EXISTS account_migrations (id INTEGER PRIMARY KEY)')
            db.execute("CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY,username TEXT UNIQUE COLLATE NOCASE NOT NULL,role TEXT NOT NULL CHECK(role IN ('admin','user')),status TEXT NOT NULL CHECK(status IN ('active','pending','disabled')),created REAL NOT NULL,salt TEXT,password_hash TEXT,iterations INTEGER)")
            db.execute('CREATE TABLE IF NOT EXISTS user_sessions (token_hash TEXT PRIMARY KEY,user TEXT NOT NULL,expires REAL NOT NULL)')
            db.execute('CREATE TABLE IF NOT EXISTS account_claims (token_hash TEXT PRIMARY KEY,user TEXT,kind TEXT NOT NULL,expires REAL NOT NULL)')
            db.execute('CREATE TABLE IF NOT EXISTS api_tokens (id TEXT PRIMARY KEY,user TEXT NOT NULL,name TEXT NOT NULL,scopes TEXT NOT NULL,created REAL NOT NULL,expires REAL NOT NULL,last_used REAL,revoked REAL,prefix TEXT NOT NULL,token_hash TEXT UNIQUE NOT NULL)')
            if not db.execute('SELECT 1 FROM account_migrations WHERE id=1').fetchone():
                old = db.execute('SELECT * FROM administrator').fetchone()
                if old:
                    uid = str(uuid.uuid4())
                    db.execute("INSERT INTO users VALUES (?,?, 'admin','active',?,?,?,?)", (uid, old['username'], store.clock(), old['salt'], old['password_hash'], old['iterations']))
                    db.execute('INSERT INTO user_sessions SELECT token_hash,?,expires FROM admin_sessions WHERE expires>?', (uid,store.clock()))
                    self._backfill(db, uid)
                db.execute('INSERT INTO account_migrations VALUES (1)')
            # Keep empty compatibility tables; never accept them as authority again.
            db.execute('DELETE FROM administrator')
            db.execute('DELETE FROM admin_sessions')
            for table in ('administrator','admin_sessions'):
                db.execute("CREATE TRIGGER IF NOT EXISTS consumed_"+table+" BEFORE INSERT ON "+table+" WHEN EXISTS (SELECT 1 FROM account_migrations WHERE id=1) BEGIN SELECT RAISE(ABORT,'Legacy account authority has been consumed'); END")

    def _backfill(self, db, uid):
        db.execute('UPDATE machines SET owner=? WHERE owner IS NULL AND id NOT IN (SELECT machine FROM lease_members)', (uid,))

    def status(self):
        with self.store.transaction() as db:
            return {'setupRequired': not bool(db.execute("SELECT 1 FROM users WHERE role='admin'").fetchone())}

    def _session(self, db, row):
        token = secrets.token_urlsafe(32)
        expires = self.store.clock() + SESSION_SECONDS
        db.execute('DELETE FROM user_sessions WHERE expires<=?', (self.store.clock(),))
        db.execute('DELETE FROM user_sessions WHERE token_hash IN (SELECT token_hash FROM user_sessions WHERE user=? ORDER BY expires DESC LIMIT -1 OFFSET 63)', (row['id'],))
        db.execute('INSERT INTO user_sessions VALUES (?,?,?)', (token_hash(token),row['id'],expires))
        return {'token': token, 'expiresAt': expires, 'user': public(row)}

    def setup(self, value):
        fields(value, ('username','password'), ('username','password'))
        name = username(value['username']); salt = secrets.token_hex(32)
        encoded = password_hash(password_bytes(value['password']),salt)
        with self.store.transaction() as db:
            if db.execute("SELECT 1 FROM users WHERE role='admin'").fetchone():
                raise Error('An administrator already exists. Sign in with the existing account.',409)
            uid = str(uuid.uuid4())
            try:db.execute("INSERT INTO users VALUES (?,?,'admin','active',?,?,?,?)", (uid,name,self.store.clock(),salt,encoded,ITERATIONS))
            except sqlite3.IntegrityError:raise Error('Username already used.',409)
            self._backfill(db,uid)
            db.execute("DELETE FROM account_claims WHERE kind='bootstrap'")
            return self._session(db,db.execute('SELECT * FROM users WHERE id=?',(uid,)).fetchone())

    def _attempt(self):
        now = self.store.clock()
        with self.store.transaction() as db:
            row = db.execute('SELECT * FROM auth_throttle WHERE id=1').fetchone()
            if not row or now-row['started']>=60:
                db.execute('INSERT OR REPLACE INTO auth_throttle VALUES (1,?,1)', (now,))
            elif row['attempts']>=10:
                raise Error('Too many sign-in attempts. Try again in one minute.',429)
            else:
                db.execute('UPDATE auth_throttle SET attempts=attempts+1 WHERE id=1')

    def login(self, value):
        fields(value, ('username','password'), ('username','password'))
        self._attempt()
        try:name=username(value['username']); password=password_bytes(value['password'])
        except Error:raise Error('Username or password rejected.',401)
        with self.store.transaction() as db:
            row=db.execute('SELECT * FROM users WHERE username=?',(name,)).fetchone()
        encoded=password_hash(password,row['salt'] if row and row['salt'] else self.dummy_salt,row['iterations'] if row and row['iterations'] else ITERATIONS)
        if not row or row['status']!='active' or not secrets.compare_digest(encoded,row['password_hash'] or '0'*64):
            raise Error('Username or password rejected.',401)
        with self.store.transaction() as db:
            current=db.execute('SELECT * FROM users WHERE id=?',(row['id'],)).fetchone()
            if current['status']!='active' or current['password_hash']!=row['password_hash']:
                raise Error('Username or password rejected.',401)
            return self._session(db,current)

    def principal_db(self, db, token, session_only=False):
        try:hashed=token_hash(secret(token))
        except (Error, UnicodeError):raise Error('Credential rejected.',401)
        now=self.store.clock()
        row=db.execute('SELECT u.*,s.expires FROM user_sessions s JOIN users u ON u.id=s.user WHERE s.token_hash=? AND s.expires>?',(hashed,now)).fetchone()
        if row and row['status']=='active':
            return {'user':public(row),'expiresAt':row['expires'],'kind':'session','scopes':sorted(SCOPES)}
        if not session_only:
            row=db.execute('SELECT u.*,t.scopes,t.expires,t.id AS token_id,t.last_used FROM api_tokens t JOIN users u ON u.id=t.user WHERE t.token_hash=? AND t.revoked IS NULL AND t.expires>?',(hashed,now)).fetchone()
            if row and row['status']=='active':
                if row['last_used'] is None or now-row['last_used']>=60:
                    db.execute('UPDATE api_tokens SET last_used=? WHERE id=?',(now,row['token_id']))
                return {'user':public(row),'expiresAt':row['expires'],'kind':'token','scopes':json.loads(row['scopes'])}
        raise Error('Credential rejected.',401)

    def principal(self, token, session_only=False):
        with self.store.transaction() as db:return self.principal_db(db,token,session_only)

    def session(self, token):
        p=self.principal(token,True)
        return {'user':p['user'],'expiresAt':p['expiresAt']}

    def authorized(self, token):
        try:self.principal(token);return True
        except Error:return False

    def logout(self, token):
        with self.store.transaction() as db:
            self.principal_db(db,token,True)
            db.execute('DELETE FROM user_sessions WHERE token_hash=?',(token_hash(token),))
        return {'ok':True}

    def _invalidate(self, db, uid):
        db.execute('DELETE FROM user_sessions WHERE user=?',(uid,))
        db.execute('UPDATE api_tokens SET revoked=COALESCE(revoked,?) WHERE user=?',(self.store.clock(),uid))
        db.execute('DELETE FROM account_claims WHERE user=?',(uid,))

    def change_password(self, token, value):
        fields(value,('currentPassword','password'),('currentPassword','password'))
        p=self.principal(token,True)
        with self.store.transaction() as db:row=db.execute('SELECT * FROM users WHERE id=?',(p['user']['id'],)).fetchone()
        old=password_hash(password_bytes(value['currentPassword']),row['salt'],row['iterations'])
        salt=secrets.token_hex(32);encoded=password_hash(password_bytes(value['password']),salt)
        with self.store.transaction() as db:
            self.principal_db(db,token,True)
            current=db.execute('SELECT * FROM users WHERE id=?',(row['id'],)).fetchone()
            if current['password_hash']!=row['password_hash'] or not secrets.compare_digest(old,current['password_hash']):raise Error('Password rejected.',401)
            db.execute('UPDATE users SET salt=?,password_hash=?,iterations=? WHERE id=?',(salt,encoded,ITERATIONS,row['id']))
            self._invalidate(db,row['id'])
        return {'ok':True}

    def _admin(self, db, token, operator=False):
        if operator:return
        p=self.principal_db(db,token)
        if p['user']['role']!='admin' or p['kind']=='token' and 'admin' not in p['scopes']:raise Error('Administrator required.',403)

    def users(self, token, operator=False):
        with self.store.transaction() as db:
            self._admin(db,token,operator)
            return {'users':[public(r) for r in db.execute('SELECT * FROM users ORDER BY created,id')]}

    def create_user(self, token, value, operator=False):
        from .model import identifier
        fields(value,('id','username','role'),('id','username'))
        uid=identifier(value['id']);name=username(value['username']);role=value.get('role','user')
        if role not in ('admin','user'):raise Error('Invalid role.',400)
        with self.store.transaction() as db:
            self._admin(db,token,operator)
            old=db.execute('SELECT * FROM users WHERE id=?',(uid,)).fetchone()
            if old:
                if old['username']!=name or old['role']!=role:raise Error('User identity already used.',409)
                return public(old)
            try:db.execute("INSERT INTO users(id,username,role,status,created) VALUES (?,?,?,'pending',?)",(uid,name,role,self.store.clock()))
            except sqlite3.IntegrityError:raise Error('Username already used.',409)
            return public(db.execute('SELECT * FROM users WHERE id=?',(uid,)).fetchone())

    def update_user(self, token, uid, value, operator=False):
        fields(value,('role','status'))
        if not value or 'role' in value and value['role'] not in ('admin','user') or 'status' in value and value['status'] not in ('active','pending','disabled'):raise Error('Invalid account update.',400)
        with self.store.transaction() as db:
            self._admin(db,token,operator)
            row=db.execute('SELECT * FROM users WHERE id=?',(uid,)).fetchone()
            if not row:raise Error('Unknown user.',404)
            role=value.get('role',row['role']);status=value.get('status',row['status'])
            reenable=status=='pending' and row['status']=='disabled'
            if status=='pending' and row['status'] not in ('pending','disabled'):raise Error('Use password reset for an active account.',409)
            if status=='active' and row['status']=='disabled':raise Error('Enable this account to pending and issue a fresh invitation.',409)
            if status=='active' and not row['password_hash']:raise Error('Redeem an invitation before activation.',409)
            if row['role']=='admin' and row['status']=='active' and (role!='admin' or status!='active') and db.execute("SELECT count(*) FROM users WHERE role='admin' AND status='active'").fetchone()[0]<=1:raise Error('Cannot remove the last active administrator.',409)
            db.execute('UPDATE users SET role=?,status=? WHERE id=?',(role,status,uid))
            if reenable:db.execute('UPDATE users SET password_hash=NULL,salt=NULL,iterations=NULL WHERE id=?',(uid,))
            if status=='disabled' or reenable:self._invalidate(db,uid)
            elif role!=row['role']:db.execute('DELETE FROM account_claims WHERE user=?',(uid,))
            return public(db.execute('SELECT * FROM users WHERE id=?',(uid,)).fetchone())

    def issue_claim(self, token, kind, uid=None, operator=False):
        with self.store.transaction() as db:
            self._admin(db,token,operator)
            row=None
            if kind=='bootstrap':
                if db.execute("SELECT 1 FROM users WHERE role='admin'").fetchone():raise Error('Setup already completed.',409)
                db.execute("DELETE FROM account_claims WHERE kind='bootstrap'")
            else:
                row=db.execute('SELECT * FROM users WHERE id=?',(uid,)).fetchone()
                if not row:raise Error('Unknown user.',404)
                if kind=='invite' and row['status']!='pending':raise Error('Invitation requires a pending user.',409)
                if kind=='reset':
                    if row['status']=='disabled' and not operator:raise Error('Disabled account cannot reset.',409)
                    if row['role']=='admin' and row['status']=='active' and not operator and db.execute("SELECT count(*) FROM users WHERE role='admin' AND status='active'").fetchone()[0]<=1:
                        raise Error('Only operator recovery can reset the last active administrator.',409)
                    self._invalidate(db,uid)
                    db.execute("UPDATE users SET status='pending',password_hash=NULL,salt=NULL,iterations=NULL WHERE id=?",(uid,))
                db.execute('DELETE FROM account_claims WHERE user=?',(uid,))
            raw=secrets.token_urlsafe(32);expires=self.store.clock()+(900 if kind=='bootstrap' else 86400)
            db.execute('INSERT INTO account_claims VALUES (?,?,?,?)',(token_hash(raw),uid,kind,expires))
            return {'token':raw,'kind':kind,'username':row['username'] if row else None,'expiresAt':expires}

    def revoke_claim(self, token, uid, operator=False):
        with self.store.transaction() as db:
            self._admin(db,token,operator)
            if not db.execute('SELECT 1 FROM users WHERE id=?',(uid,)).fetchone():raise Error('Unknown user.',404)
            db.execute('DELETE FROM account_claims WHERE user=?',(uid,))
        return {'ok':True}

    def _claim(self, db, raw):
        try:hashed=token_hash(secret(raw))
        except (Error,UnicodeError):raise Error('Claim rejected.',401)
        row=db.execute('SELECT c.*,u.username,u.status FROM account_claims c LEFT JOIN users u ON u.id=c.user WHERE token_hash=? AND expires>?',(hashed,self.store.clock())).fetchone()
        if not row or row['status']=='disabled' or row['kind']=='bootstrap' and db.execute("SELECT 1 FROM users WHERE role='admin'").fetchone():raise Error('Claim rejected.',401)
        return row

    def claim_info(self,value):
        fields(value,('token',),('token',));self._attempt()
        with self.store.transaction() as db:
            row=self._claim(db,value['token'])
            return {'kind':row['kind'],'username':row['username'],'expiresAt':row['expires']}

    def redeem(self,value):
        fields(value,('token','username','password'),('token','password'));self._attempt()
        with self.store.transaction() as db:claim=dict(self._claim(db,value['token']))
        if claim['kind']=='bootstrap':name=username(value.get('username'))
        elif 'username' in value:raise Error('Claim rejected.',401)
        salt=secrets.token_hex(32);encoded=password_hash(password_bytes(value['password']),salt)
        with self.store.transaction() as db:
            current=self._claim(db,value['token'])
            uid=current['user']
            if current['kind']=='bootstrap':
                uid=str(uuid.uuid4())
                try:db.execute("INSERT INTO users VALUES (?,?,'admin','active',?,?,?,?)",(uid,name,self.store.clock(),salt,encoded,ITERATIONS))
                except sqlite3.IntegrityError:raise Error('Claim rejected.',401)
                self._backfill(db,uid)
            else:
                db.execute("UPDATE users SET salt=?,password_hash=?,iterations=?,status='active' WHERE id=?",(salt,encoded,ITERATIONS,uid))
            self._invalidate(db,uid)
            db.execute('DELETE FROM account_claims WHERE token_hash=?',(token_hash(value['token']),))
            return self._session(db,db.execute('SELECT * FROM users WHERE id=?',(uid,)).fetchone())

    def _token_public(self,row):
        return {'id':row['id'],'name':row['name'],'scopes':json.loads(row['scopes']),'createdAt':row['created'],'expiresAt':row['expires'],'lastUsedAt':row['last_used'],'revokedAt':row['revoked'],'prefix':row['prefix']}

    def tokens(self, token, value=None, revoke=None):
        from .model import identifier
        if value is not None and revoke is None:
            fields(value,('id','name','scopes','expiresInSeconds'),('id','name','scopes'))
            tid=identifier(value['id']);name=value['name'];scopes=value['scopes'];ttl=value.get('expiresInSeconds',2592000)
            if not isinstance(name,str) or not name.strip() or len(name)>100 or not isinstance(scopes,list) or not scopes or any(not isinstance(s,str) or s not in SCOPES for s in scopes) or len(set(scopes))!=len(scopes) or type(ttl) is not int or not 60<=ttl<=31536000:raise Error('Invalid token specification.',400)
        with self.store.transaction() as db:
            p=self.principal_db(db,token,True);uid=p['user']['id']
            if revoke is not None:
                row=db.execute('SELECT * FROM api_tokens WHERE id=? AND user=?',(identifier(revoke),uid)).fetchone()
                if not row:raise Error('Unknown token.',404)
                db.execute('UPDATE api_tokens SET revoked=COALESCE(revoked,?) WHERE id=?',(self.store.clock(),row['id']))
                return self._token_public(db.execute('SELECT * FROM api_tokens WHERE id=?',(row['id'],)).fetchone())
            if value is None:return {'tokens':[self._token_public(r) for r in db.execute('SELECT * FROM api_tokens WHERE user=? ORDER BY created,id',(uid,))]}
            old=db.execute('SELECT * FROM api_tokens WHERE id=?',(tid,)).fetchone()
            if old:
                if old['user']!=uid:raise Error('Unknown token.',404)
                if old['name']!=name or sorted(json.loads(old['scopes']))!=sorted(scopes) or old['expires']-old['created']!=ttl:raise Error('Token identity already used.',409)
                return self._token_public(old)
            if 'admin' in scopes and p['user']['role']!='admin':raise Error('Administrator scope requires an administrator.',403)
            raw=secrets.token_urlsafe(32);now=self.store.clock()
            db.execute('INSERT INTO api_tokens VALUES (?,?,?,?,?,?,NULL,NULL,?,?)',(tid,uid,name,json.dumps(sorted(scopes)),now,now+ttl,raw[:8],token_hash(raw)))
            return {**self._token_public(db.execute('SELECT * FROM api_tokens WHERE id=?',(tid,)).fetchone()),'token':raw}
