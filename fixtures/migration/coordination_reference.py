"""Isolated differential harness for the unchanged Python reference modules.

The caller supplies a disposable database and synthetic secrets over stdin.
This fixture is not a production dependency or a live-state conversion tool.
"""
import contextlib
import json
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from canaveral.accounts import Accounts
from canaveral.consumers import ConsumerStore


class FixtureStore(ConsumerStore):
    def __init__(self, path):
        self.path = path
        self.clock = lambda: 80000
        with self.transaction() as db:
            self.initialize_consumers(db)
            db.execute('CREATE TABLE IF NOT EXISTS templates (id TEXT NOT NULL,revision TEXT NOT NULL,arch TEXT NOT NULL,definition TEXT NOT NULL,PRIMARY KEY (id,revision,arch))')

    @contextlib.contextmanager
    def transaction(self):
        db = sqlite3.connect(self.path, timeout=15)
        db.row_factory = sqlite3.Row
        try:
            db.execute('BEGIN IMMEDIATE')
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()


value = json.load(sys.stdin)
store = FixtureStore(sys.argv[2])
accounts = Accounts(store)
action = sys.argv[1]
if action == 'setup': result = accounts.setup(value)
elif action == 'login': result = accounts.login(value)
elif action == 'session': result = accounts.session(value['token'])
elif action == 'logout': result = accounts.logout(value['token'])
elif action == 'create': result = store.create_consumer(value)
elif action == 'authenticate': result = store.authenticate_consumer(value['token'])
elif action == 'rotate': result = store.consumer_credential(value['id'])
elif action == 'revoke': result = store.consumer_credential(value['id'], revoke=True)
elif action == 'spec':
    from canaveral.consumers import consumer_spec
    result = consumer_spec(value)
else: raise ValueError('Unknown fixture action')
print(json.dumps(result))
