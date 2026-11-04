"""Application identities and operator-owned admission policy; no plaintext credentials."""
import json
import secrets

from .model import Error, digest, identifier, integer, resources, secret, text
from .lease_eligibility import lease_eligible


def policy(value):
    if not isinstance(value,dict) or set(value)-{'resources','activeLeases','defaultTTLSeconds','maxTTLSeconds','maxLifetimeSeconds','provisioningTimeoutSeconds'}:
        raise Error('Invalid application limits.',400)
    if not isinstance(value.get('resources'),dict) or set(value['resources'])!={'cpu','memoryMiB','diskGiB'}:raise Error('Invalid application resource limits.',400)
    result={'resources':resources(value.get('resources')),'activeLeases':integer(value.get('activeLeases'),'active lease limit',2**31-1)}
    for key,default in [('defaultTTLSeconds',1800),('maxTTLSeconds',3600),('maxLifetimeSeconds',86400),('provisioningTimeoutSeconds',900)]:
        result[key]=integer(value.get(key,default),key,2**31-1)
    if not result['defaultTTLSeconds']<=result['maxTTLSeconds']<=result['maxLifetimeSeconds']:
        raise Error('Default TTL must fit maximum TTL and total lifetime.',400)
    return result


def consumer_spec(value):
    if not isinstance(value,dict) or set(value)!={'id','name','templates','limits'}:
        raise Error('Application requires id, name, templates and limits.',400)
    allowed=value['templates']
    if not isinstance(allowed,list) or len(allowed)>1000:raise Error('Invalid application image allowlist.',400)
    normalized=[]
    for item in allowed:
        if not isinstance(item,dict) or set(item)!={'id','revision','arch'} or item.get('arch') not in ('arm64','amd64'):
            raise Error('Image permissions must pin id, revision and architecture.',400)
        normalized.append({'id':text(item['id'],'image id'),'revision':text(item['revision'],'image revision'),'arch':item['arch']})
    if len({(i['id'],i['revision'],i['arch']) for i in normalized})!=len(normalized):raise Error('Duplicate image permission.',400)
    normalized.sort(key=lambda i:(i['id'],i['revision'],i['arch']))
    return {'id':identifier(value['id']),'name':text(value['name'],'application name'),'templates':normalized,'limits':policy(value['limits'])}


def capabilities(image):
    system=image['os'];mobile=system in ('android','ios');guest=bool(image.get('guestAccess'))
    shell=system=='android' or guest
    display=(mobile or guest) and image['mode']!='headless'
    # These describe adapters, not whether a particular guest is ready now.
    return {'command':shell,'pty':shell,'files':mobile or guest,'screenshot':display,
            'displayStream':display,'input':display,'hierarchy':display}


class ConsumerStore:
    def initialize_consumers(self,db):
        db.execute('CREATE TABLE IF NOT EXISTS consumers (id TEXT PRIMARY KEY,specification TEXT NOT NULL,credential TEXT NOT NULL UNIQUE,revoked INTEGER NOT NULL DEFAULT 0,created REAL NOT NULL)')

    def _consumer(self,row):
        return {**json.loads(row['specification']),'revoked':bool(row['revoked']),'createdAt':row['created']}

    def create_consumer(self,value):
        spec=consumer_spec(value);token=secrets.token_urlsafe(32)
        with self.transaction() as db:
            if db.execute('SELECT 1 FROM consumers WHERE id=?',(spec['id'],)).fetchone():
                raise Error('Application ID already exists. Inspect it and rotate its credential after a lost creation response.',409)
            for image in spec['templates']:
                if not db.execute('SELECT 1 FROM templates WHERE id=? AND revision=? AND arch=?',(image['id'],image['revision'],image['arch'])).fetchone():
                    raise Error('Application permission references an unknown image revision.',400)
            db.execute('INSERT INTO consumers VALUES (?,?,?,0,?)',(spec['id'],json.dumps(spec),digest(token),self.clock()))
            result=self._consumer(db.execute('SELECT * FROM consumers WHERE id=?',(spec['id'],)).fetchone())
        return {**result,'credential':token}

    def consumers(self):
        with self.transaction() as db:return [self._consumer(row) for row in db.execute('SELECT * FROM consumers ORDER BY created,id')]

    def consumer_credential(self,consumer_id,revoke=False):
        consumer_id=identifier(consumer_id);token=secrets.token_urlsafe(32)
        with self.transaction() as db:
            row=db.execute('SELECT * FROM consumers WHERE id=?',(consumer_id,)).fetchone()
            if not row:raise Error('Unknown application.',404)
            if revoke:
                db.execute('UPDATE consumers SET revoked=1 WHERE id=?',(consumer_id,))
                return {'id':consumer_id,'revoked':True}
            if row['revoked']:raise Error('Revoked applications cannot be reactivated by credential rotation.',409)
            db.execute('UPDATE consumers SET credential=? WHERE id=?',(digest(token),consumer_id))
        return {'id':consumer_id,'credential':token}

    def _authenticate_consumer(self,db,token):
        try:token=secret(token)
        except Error:raise Error('Application credential rejected.',401)
        row=db.execute('SELECT * FROM consumers WHERE credential=? AND revoked=0',(digest(token),)).fetchone()
        if not row:raise Error('Application credential rejected.',401)
        return row

    def authenticate_consumer(self,token):
        with self.transaction() as db:return self._consumer(self._authenticate_consumer(db,token))

    def consumer_catalogue(self,token):
        with self.transaction() as db:
            consumer=self._authenticate_consumer(db,token);spec=json.loads(consumer['specification'])
            result=[]
            for allowed in spec['templates']:
                row=db.execute('SELECT definition FROM templates WHERE id=? AND revision=? AND arch=?',(allowed['id'],allowed['revision'],allowed['arch'])).fetchone()
                if not row:continue
                image=json.loads(row['definition']);available=False
                for host in db.execute('SELECT * FROM hosts WHERE enabled=1'):
                    if self.clock()-host['seen']>=self.lease_seconds or not self._health_ready(db,host['id']):continue
                    offer=json.loads(host['offer'])
                    if lease_eligible(offer,image):available=True;break
                result.append({**image,'available':available,'capabilities':capabilities(image)})
            return {'templates':result,'limits':spec['limits']}
