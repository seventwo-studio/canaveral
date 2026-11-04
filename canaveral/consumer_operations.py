"""Lease-scoped durable commands backed by the existing runner receipt queue."""
import json

from .consumers import capabilities
from .devices import operation_request
from .lease_eligibility import lease_eligible
from .lease_store import ACTIVE, utc
from .model import Error, identifier


ACTION_CAPABILITIES = {
    'screenshot': 'screenshot', 'hierarchy': 'hierarchy',
    'accessibility': 'hierarchy', 'accessibility-action': 'hierarchy',
    'tap': 'input', 'swipe': 'input', 'text': 'input', 'key': 'input',
    'list-files': 'files', 'push': 'files', 'pull': 'files', 'shell': 'command',
    'shell-open': 'pty', 'shell-read': 'pty', 'shell-write': 'pty',
    'shell-close': 'pty', 'shell-resize': 'pty',
}


class ConsumerOperationStore:
    def initialize_consumer_operations(self, db):
        db.execute('CREATE TABLE IF NOT EXISTS consumer_operations '
                   '(id TEXT PRIMARY KEY,lease TEXT NOT NULL,member TEXT NOT NULL,'
                   'credential TEXT NOT NULL,dispatched INTEGER NOT NULL DEFAULT 0)')
        db.execute('CREATE INDEX IF NOT EXISTS consumer_operations_lease ON consumer_operations(lease)')

    def _consumer_operation_view(self, row):
        result = {'id': row['id'], 'leaseId': row['lease'], 'member': row['member'],
                  'state': row['state'], 'updatedAt': utc(row['updated'])}
        if row['result'] is not None:
            result['result'] = json.loads(row['result'])
        return result

    def _consumer_operation_row(self, db, operation_id):
        return db.execute('SELECT d.*,c.lease,c.member,c.credential,c.dispatched FROM '
                          'device_operations d JOIN consumer_operations c ON c.id=d.id WHERE d.id=?',
                          (operation_id,)).fetchone()

    def create_consumer_operation(self, lease_id, token, value, with_status=False):
        if not isinstance(value, dict) or set(value) != {'id', 'member', 'action', 'arguments'} or not isinstance(value['member'], str):
            raise Error('Operation requires id, explicit member, action and arguments.', 400)
        request = operation_request({key: value[key] for key in ('id', 'action', 'arguments')})
        with self.transaction() as db:
            lease = self._session_lease(db, lease_id, token)
            old = db.execute('SELECT * FROM device_operations WHERE id=?', (request['id'],)).fetchone()
            if old:
                scoped = self._consumer_operation_row(db, request['id'])
                if not scoped or scoped['lease'] != lease['id']:
                    raise Error('Unknown operation.', 404)
                if scoped['member'] != value['member'] or json.loads(old['request']) != request:
                    raise Error('Operation identity belongs to another request.', 409)
                result = self._consumer_operation_view(scoped)
                return (result, False) if with_status else result
            if lease['state'] not in ACTIVE:
                raise Error('Lease has ended.', 410)
            machine = db.execute('SELECT m.*,h.seen,h.enabled,h.offer AS host_offer FROM machines m '
                                 'JOIN hosts h ON h.id=m.host JOIN lease_members lm ON lm.machine=m.id '
                                 'WHERE lm.lease=? AND lm.name=?', (lease['id'], value['member'])).fetchone()
            if not machine:
                raise Error('Unknown environment member.', 404)
            capability = ACTION_CAPABILITIES.get(request['action'])
            if capability is None or not capabilities(json.loads(machine['template']))[capability]:
                raise Error('Requested operation capability is unsupported.', 409, code='capability_unsupported')
            if lease['state'] != 'ready' or not self._operation_member_ready(machine):
                raise Error('Environment member is not ready for access.', 409, code='member_not_ready')
            if db.execute("SELECT count(*) FROM device_operations WHERE host=? AND state='queued'", (machine['host'],)).fetchone()[0] >= 32:
                raise Error('Host device operation queue is full.', 429)
            now = self.clock()
            db.execute("INSERT INTO device_operations VALUES (?,?,?,?, 'queued',NULL,?,?)",
                       (request['id'], machine['id'], machine['host'], json.dumps(request), now, now))
            db.execute('INSERT INTO consumer_operations VALUES (?,?,?,?,0)',
                       (request['id'], lease['id'], value['member'], lease['credential']))
            result = self._consumer_operation_view(self._consumer_operation_row(db, request['id']))
            return (result, True) if with_status else result

    def get_consumer_operation(self, lease_id, operation_id, token):
        with self.transaction() as db:
            lease = self._session_lease(db, lease_id, token)
            row = self._consumer_operation_row(db, identifier(operation_id))
            if not row or row['lease'] != lease['id']:
                raise Error('Unknown operation.', 404)
            return self._consumer_operation_view(row)

    def _operation_member_ready(self, machine):
        return (machine['enabled'] and machine['desired'] == 'running'
                and lease_eligible(json.loads(machine['host_offer']), json.loads(machine['template']))
                and self._machine(machine, self.clock() - machine['seen'] < self.lease_seconds)['ready'])

    def _close_consumer_operations(self, db, lease_id=None):
        """Close invalid queues; dispatch without a receipt is an uncertain effect."""
        query = "SELECT d.*,c.lease,c.credential,c.dispatched FROM device_operations d JOIN consumer_operations c ON c.id=d.id WHERE d.state='queued'"
        if lease_id is not None:
            query += ' AND c.lease=?'
        for row in db.execute(query, (lease_id,) if lease_id else ()).fetchall():
            lease = db.execute('SELECT * FROM leases WHERE id=?', (row['lease'],)).fetchone()
            machine = db.execute('SELECT m.*,h.seen,h.enabled,h.offer AS host_offer FROM machines m JOIN hosts h ON h.id=m.host WHERE m.id=?', (row['machine'],)).fetchone()
            invalid = (lease_id is not None or not lease or lease['state'] != 'ready'
                       or lease['credential'] != row['credential'] or self.clock() >= row['created'] + 120
                       or not machine or machine['host'] != row['host'] or not self._operation_member_ready(machine))
            if invalid:
                state = 'unknown' if row['dispatched'] else 'failed'
                db.execute('UPDATE device_operations SET state=?,result=?,updated=? WHERE id=?',
                           (state, json.dumps({'detail': 'Operation authorization ended before a completed receipt. Inspect before issuing another effect.'}), self.clock(), row['id']))
