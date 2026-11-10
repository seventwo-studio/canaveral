"""Controller-owned limits on Canaveral allocations for each host."""
import json

from .model import Error, identifier, resources


class CapacityStore:
    def initialize_capacity(self, db):
        db.execute('CREATE TABLE IF NOT EXISTS host_limits (host TEXT PRIMARY KEY, limits TEXT NOT NULL)')

    def save_host_limits(self, host_id, value):
        host_id=identifier(host_id)
        if not isinstance(value,dict) or set(value)!={'limits'}:
            raise Error('Specify CPU, memory and disk limits for this host.',400)
        limits=resources(value['limits'])
        with self.transaction() as db:
            self._host_limits(db,host_id)
            db.execute('INSERT INTO host_limits VALUES (?,?) ON CONFLICT(host) DO UPDATE SET limits=excluded.limits',
                       (host_id,json.dumps(limits)))
            return {'hostId':host_id,'limits':limits}

    def _host_limits(self, db, host_id):
        host=db.execute('SELECT offer FROM hosts WHERE id=? AND id NOT IN (SELECT id FROM retired_runners)',(host_id,)).fetchone()
        if not host:raise Error('Unknown host.',404)
        row=db.execute('SELECT limits FROM host_limits WHERE host=?',(host_id,)).fetchone()
        return json.loads(row[0]) if row else json.loads(host[0])['capacity']

    def _remaining_capacity(self, db, host_id, exclude=None):
        limits=self._host_limits(db,host_id)
        capacity=json.loads(db.execute('SELECT offer FROM hosts WHERE id=?',(host_id,)).fetchone()[0])['capacity']
        used=self._used(db,host_id,exclude=exclude)
        return {key:max(0,min(capacity[key],limits[key])-used[key]) for key in capacity}
