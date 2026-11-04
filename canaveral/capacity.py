"""Operator-owned overlapping budgets shared by runner identities.

Membership is controller state, never a value an agent can change in a heartbeat.
Admission evaluates every applicable budget inside the placement transaction.
"""
import json

from .model import Error, identifier, resources, text


class CapacityStore:
    def initialize_capacity(self, db):
        db.execute('CREATE TABLE IF NOT EXISTS resource_budgets (id TEXT PRIMARY KEY, name TEXT NOT NULL, capacity TEXT NOT NULL)')
        db.execute('CREATE TABLE IF NOT EXISTS resource_budget_members (budget TEXT NOT NULL, host TEXT NOT NULL, PRIMARY KEY(budget,host))')
        db.execute('CREATE INDEX IF NOT EXISTS resource_budget_host ON resource_budget_members(host,budget)')

    def save_resource_budget(self, value):
        if not isinstance(value,dict) or set(value)-{'id','name','capacity','hostIds'}:
            raise Error('Invalid shared resource budget.',400)
        budget_id=identifier(value.get('id'))
        name=text(value.get('name'),'budget name')
        capacity=resources(value.get('capacity'))
        members=value.get('hostIds')
        if not isinstance(members,list) or len(members)>1000:
            raise Error('Specify at most 1000 runner IDs.',400)
        members=[identifier(item) for item in members]
        if len(members)!=len(set(members)):
            raise Error('Budget membership must not contain duplicates.',400)
        with self.transaction() as db:
            for host_id in members:
                if not db.execute('SELECT 1 FROM hosts WHERE id=?',(host_id,)).fetchone():
                    raise Error('A budget member is not an enrolled runner.',404)
            db.execute('INSERT INTO resource_budgets VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,capacity=excluded.capacity',
                       (budget_id,name,json.dumps(capacity)))
            db.execute('DELETE FROM resource_budget_members WHERE budget=?',(budget_id,))
            db.executemany('INSERT INTO resource_budget_members VALUES (?,?)',[(budget_id,host_id) for host_id in members])
            return self._resource_budget(db,budget_id)

    def _resource_budget(self, db, budget_id, exclude=None):
        row=db.execute('SELECT * FROM resource_budgets WHERE id=?',(budget_id,)).fetchone()
        members=[r[0] for r in db.execute('SELECT host FROM resource_budget_members WHERE budget=? ORDER BY host',(budget_id,))]
        capacity=json.loads(row['capacity'])
        used={key:0 for key in capacity}
        for host_id in members:
            for key,amount in self._used(db,host_id,exclude=exclude).items():used[key]+=amount
        return {'id':row['id'],'name':row['name'],'capacity':capacity,'hostIds':members,'reserved':used,
                'available':{key:max(0,capacity[key]-used[key]) for key in capacity},
                'overcommitted':any(used[key]>capacity[key] for key in capacity)}

    def resource_budgets(self):
        with self.transaction() as db:
            return [self._resource_budget(db,row[0]) for row in db.execute('SELECT id FROM resource_budgets ORDER BY name,id')]

    def _host_budgets(self, db, host_id, exclude=None):
        return [self._resource_budget(db,row[0],exclude=exclude) for row in
                db.execute('SELECT budget FROM resource_budget_members WHERE host=? ORDER BY budget',(host_id,))]

    def _remaining_capacity(self, db, host_id, exclude=None):
        capacity=json.loads(db.execute('SELECT offer FROM hosts WHERE id=?',(host_id,)).fetchone()[0])['capacity']
        used=self._used(db,host_id,exclude=exclude)
        remaining={key:max(0,capacity[key]-used[key]) for key in capacity}
        for shared in self._host_budgets(db,host_id,exclude=exclude):
            remaining={key:min(remaining[key],shared['available'][key]) for key in remaining}
        return remaining
