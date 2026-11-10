"""Deny-by-default human policy, revalidated inside every storage transaction."""
from contextvars import ContextVar
from .model import Error, identifier

current = ContextVar('human_request', default=None)


def require_scope(principal, action):
    if principal['kind']=='operator':return
    scopes=principal['scopes']
    admin=principal['user']['role']=='admin'
    if action=='admin':
        if not admin or 'admin' not in scopes:raise Error('Administrator required.',403)
    elif 'machines:'+action not in scopes and not (admin and 'admin' in scopes):
        raise Error('Credential scope does not permit this action.',403)


def machine(db, principal, mid, optional=False):
    row=db.execute('SELECT owner FROM machines WHERE id=?',(identifier(mid),)).fetchone()
    if row is None:
        if optional:return
        raise Error('Unknown machine.',404)
    if principal['kind']!='operator' and principal['user']['role']!='admin' and row['owner']!=principal['user']['id']:
        raise Error('Unknown machine.',404)


class Policy:
    def __init__(self, accounts, token, operator, method, parts, value):
        self.accounts,self.token,self.operator=accounts,token,operator
        self.method,self.parts,self.value=method,parts,value
        self.principal=None

    def check(self, db):
        self.principal={'kind':'operator','user':None} if self.operator else self.accounts.principal_db(db,self.token)
        p=self.principal;parts=self.parts;method=self.method;value=self.value
        if parts[:2]==['v1','auth']:
            # Account methods enforce credential-type and role requirements themselves.
            return
        if parts[:2]==['v1','users']:
            require_scope(p,'admin');return
        if parts==['v1','templates'] and method=='GET':require_scope(p,'read');return
        if parts[:2]==['v1','machines']:
            if len(parts)==2:
                require_scope(p,'read' if method=='GET' else 'write')
                if method=='POST' and 'id' in value:machine(db,p,value['id'],optional=True)
                return
            suffix=parts[3] if len(parts)==4 else None
            action='read' if method=='GET' and len(parts)==3 else 'access' if suffix=='operations' else 'write'
            if suffix=='authorize':
                if set(value)!={'action'} or value['action'] not in ('read','write','access'):raise Error('Invalid authorization action.',400)
                action=value['action']
            require_scope(p,action)
            # A foreign receipt ID is hidden even when the requested target is absent.
            table={'operations':'device_operations','power-off':'machine_power_offs','delete':'machine_deletions'}.get(suffix)
            if table and 'id' in value:
                row=db.execute('SELECT machine FROM '+table+' WHERE id=?',(identifier(value['id']),)).fetchone()
                if row:machine(db,p,row['machine'])
            machine(db,p,parts[2]);return
        if method=='GET' and len(parts)==3 and parts[:2]==['v1','operations']:
            require_scope(p,'access')
            row=db.execute('SELECT machine FROM device_operations WHERE id=?',(identifier(parts[2]),)).fetchone()
            if not row:raise Error('Unknown device operation.',404)
            machine(db,p,row['machine']);return
        require_scope(p,'admin')
