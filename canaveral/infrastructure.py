"""Scoped infrastructure enrollment and persisted host health/resource reports."""
import json
import math
import secrets

from .model import Error, digest, identifier, resources, secret, text, template
from .capacity import CapacityStore
from .host_migration import HostMigrationStore


PROVIDERS = ('macos','linux','windows','apple', 'libvirt', 'hyperv', 'android', 'ios', 'kubevirt')


class InfrastructureStore(CapacityStore,HostMigrationStore):
    def authenticate_setup(self, token):
        with self.transaction() as db:
            row=db.execute('SELECT * FROM connection_setups WHERE token_hash=?',(digest(token),)).fetchone()
            if not row or row['revoked'] or (not row['claimed_host'] and row['expires']<=self.clock()):
                raise Error('Setup credential rejected.',401)

    def initialize_infrastructure(self, db):
        self.initialize_capacity(db)
        self.initialize_host_migration(db)
        db.execute('CREATE TABLE IF NOT EXISTS connection_setups (id TEXT PRIMARY KEY, specification TEXT NOT NULL, token_hash TEXT NOT NULL, expires REAL NOT NULL, claimed_host TEXT, revoked INTEGER NOT NULL DEFAULT 0)')
        db.execute('CREATE TABLE IF NOT EXISTS host_health (host TEXT PRIMARY KEY, report TEXT, received REAL, requested REAL NOT NULL DEFAULT 0)')
        db.execute('CREATE TABLE IF NOT EXISTS resource_samples (host TEXT NOT NULL, captured REAL NOT NULL, report TEXT NOT NULL, PRIMARY KEY(host,captured))')
        db.execute('CREATE TABLE IF NOT EXISTS host_image_inventory (host TEXT PRIMARY KEY, definitions TEXT NOT NULL, received REAL NOT NULL)')

    def _record_host_images(self,db,host_id,value):
        if value is None:return
        if not isinstance(value,list) or len(value)>1000:raise Error('Invalid installed image inventory.',400)
        definitions=[template(item) for item in value]
        keys={(item['id'],item['revision'],item['arch']) for item in definitions}
        if len(keys)!=len(definitions):raise Error('Duplicate installed image revision.',400)
        proposed={'templates':definitions}
        self._validate_catalogue_offer(db,host_id,proposed)
        self._register_templates(db,proposed)
        db.execute('INSERT OR REPLACE INTO host_image_inventory VALUES (?,?,?)',(host_id,json.dumps(definitions),self.clock()))

    def create_setup(self, value):
        setup_id = identifier(value.get('id'))
        provider = value.get('provider')
        if provider not in PROVIDERS:
            raise Error('Choose a VM, simulator or KubeVirt provider.',400)
        specification = {'name':text(value.get('name'),'connection name'), 'provider':provider,
                         'capacity':resources(value.get('capacity'))}
        token = secrets.token_urlsafe(32)
        with self.transaction() as db:
            if db.execute('SELECT 1 FROM connection_setups WHERE id=?',(setup_id,)).fetchone():
                raise Error('This setup was already issued. Its secret is returned once; revoke it before creating a replacement.',409)
            expires = self.clock()+1800
            db.execute('INSERT INTO connection_setups VALUES (?,?,?,?,NULL,0)',
                       (setup_id,json.dumps(specification),digest(token),expires))
        return {'id':setup_id, **specification, 'enrollmentToken':token,'expiresAt':expires}

    def setups(self):
        with self.transaction() as db:
            return [{'id':r['id'], **json.loads(r['specification']), 'expiresAt':r['expires'],
                     'hostId':r['claimed_host'], 'state':'revoked' if r['revoked'] else 'connected' if r['claimed_host'] else 'expired' if r['expires'] <= self.clock() else 'pending'}
                    for r in db.execute('SELECT * FROM connection_setups ORDER BY expires DESC LIMIT 100')]

    def revoke_setup(self, setup_id):
        with self.transaction() as db:
            if db.execute('UPDATE connection_setups SET revoked=1 WHERE id=?',(identifier(setup_id),)).rowcount != 1:
                raise Error('Unknown setup.',404)
        return {'id':setup_id,'state':'revoked'}

    def _claim_setup(self, db, token, host_id, proposed):
        row = db.execute('SELECT * FROM connection_setups WHERE token_hash=?',(digest(secret(token)),)).fetchone()
        if not row or row['revoked'] or row['claimed_host'] not in (None,host_id) or (not row['claimed_host'] and row['expires'] <= self.clock()):
            raise Error('Setup credential is expired, revoked or already used.',401)
        if json.loads(row['specification']) != {key:proposed[key] for key in ('name','provider','capacity')}:
            raise Error('Runner name, provider and capacity must match its setup.',403)
        # The surrounding enrollment transaction also checks the persistent host credential.
        db.execute('UPDATE connection_setups SET claimed_host=? WHERE id=?',(host_id,row['id']))

    def request_checks(self, host_id):
        host_id=identifier(host_id)
        with self.transaction() as db:
            if not db.execute('SELECT 1 FROM hosts WHERE id=?',(host_id,)).fetchone():raise Error('Unknown host.',404)
            db.execute('INSERT INTO host_health(host,requested) VALUES (?,?) ON CONFLICT(host) DO UPDATE SET requested=excluded.requested',(host_id,self.clock()))
        return {'id':host_id,'requested':True}

    def _health_ready(self, db, host_id):
        row=db.execute('SELECT report,received FROM host_health WHERE host=?',(host_id,)).fetchone()
        # Legacy agents are explicitly marked unreported, but remain compatible.
        if not row or not row['report']:return True
        return self.clock()-row['received'] < 120 and json.loads(row['report'])['status'] in ('passed','warning')

    def _record_infrastructure(self, db, host_id, value):
        report=value.get('health')
        if report is not None:
            report=validate_health(report)
            db.execute('INSERT INTO host_health(host,report,received) VALUES (?,?,?) ON CONFLICT(host) DO UPDATE SET report=excluded.report,received=CASE WHEN host_health.report=excluded.report THEN host_health.received ELSE excluded.received END',
                       (host_id,json.dumps(report),self.clock()))
        sample=value.get('resources')
        if sample is not None:
            sample=validate_sample(sample)
            previous=db.execute('SELECT captured,report FROM resource_samples WHERE host=? ORDER BY captured DESC LIMIT 1',(host_id,)).fetchone()
            if previous is None or (self.clock()-previous['captured']>=10 and json.loads(previous['report'])!=sample):
                db.execute('INSERT INTO resource_samples VALUES (?,?,?)',(host_id,self.clock(),json.dumps(sample)))
                db.execute('DELETE FROM resource_samples WHERE host=? AND captured<?',(host_id,self.clock()-21600))
        row=db.execute('SELECT requested FROM host_health WHERE host=?',(host_id,)).fetchone()
        return row['requested'] if row else 0

    def host_resources(self, host_id):
        host_id=identifier(host_id)
        with self.transaction() as db:
            host=db.execute('SELECT * FROM hosts WHERE id=?',(host_id,)).fetchone()
            if not host:raise Error('Unknown host.',404)
            return {'hostId':host_id,'capacity':json.loads(host['offer'])['capacity'],'limits':self._host_limits(db,host_id),'reserved':self._used(db,host_id),
                    'images':self._host_images(db,host),
                    'categories':self._resource_categories(db,host_id),
                    'available':self._remaining_capacity(db,host_id),
                    'samples':[{'receivedAt':r['captured'],**json.loads(r['report'])} for r in db.execute('SELECT * FROM resource_samples WHERE host=? ORDER BY captured DESC LIMIT 360',(host_id,))],
                    'allocations':[{'id':r['id'],'name':json.loads(r['request'])['name'],'resources':json.loads(r['request'])['resources'],
                                    'desired':r['desired'],'observed':r['observed'],
                                    'computeReserved':self._compute_reserved(db,r)}
                                   for r in db.execute('SELECT * FROM machines WHERE host=? ORDER BY id',(host_id,)) if not self._deleted(db,r['id'])]}

    def _host_images(self,db,host):
        records={row['id']:json.loads(row['metadata']) for row in db.execute('SELECT * FROM images WHERE host=?',(host['id'],))}
        offered=json.loads(host['offer'])['templates']
        inventory=db.execute('SELECT definitions FROM host_image_inventory WHERE host=?',(host['id'],)).fetchone()
        definitions={(image['id'],image['revision'],image['arch']):image for image in (json.loads(inventory[0]) if inventory else offered)}
        definitions.update({(image['id'],image['revision'],image['arch']):image for image in offered})
        offered_keys={(image['id'],image['revision'],image['arch']) for image in offered}
        result=[]
        for key,definition in definitions.items():
            artifact=records.get(definition.get('catalogueImageId',definition['id']))
            if artifact and (artifact['revision'],artifact['arch'])==(definition['revision'],definition['arch']):
                records.pop(artifact['id']);result.append({**definition,**artifact,'offered':key in offered_keys,'origin':'library'})
            else:result.append({**definition,'offered':key in offered_keys,'origin':'runtime'})
        return [*result,*[{**record,'offered':False,'origin':'library'} for record in records.values()]]

    def _resource_categories(self,db,host_id):
        groups={key:{'id':key,'label':label,'cpu':0,'memoryMiB':0,'diskGiB':0} for key,label in (
            ('virtualMachines','Virtual machines'),('simulators','Simulators'),
            ('retainedDisks','Stopped machine disks'),('images','Images'),
            ('imageTasks','Image imports and captures'),('inference','Inference'))}
        for row in db.execute('SELECT id,request,template,desired,observed FROM machines WHERE host=?',(host_id,)):
            if self._deleted(db,row['id']):continue
            request=json.loads(row['request']);size=request['resources']
            active=self._compute_reserved(db,row)
            category='simulators' if json.loads(row['template'])['os'] in ('android','ios','tvos','watchos') else 'virtualMachines'
            group=groups[category if active else 'retainedDisks']
            group['diskGiB']+=size['diskGiB']
            if active:
                for key in ('cpu','memoryMiB'):group[key]+=size[key]
        pending=db.execute("SELECT COALESCE(SUM(reserved_disk),0) FROM image_tasks WHERE host=? AND state IN ('queued','running','unknown')",(host_id,)).fetchone()[0]
        groups['imageTasks']['diskGiB']=pending
        groups['images']['diskGiB']=self._image_used(db,host_id)-pending
        groups['inference'].update(self._inference_used(db,host_id))
        return list(groups.values())


def validate_health(value):
    if not isinstance(value,dict) or set(value)-{'status','checkedAt','checks','capabilities','environment'} or value.get('status') not in ('checking','passed','warning','failed'):
        raise Error('Invalid host health report.',400)
    if len(json.dumps(value,allow_nan=False)) > 32768:raise Error('Host health report is too large.',400)
    checked=value.get('checkedAt')
    if type(checked) not in (int,float) or not math.isfinite(checked) or checked<0:raise Error('Invalid check timestamp.',400)
    capabilities=value.get('capabilities',{})
    environment=value.get('environment',{})
    if not isinstance(capabilities,dict) or len(capabilities)>30 or any(not isinstance(key,str) or len(key)>100 or type(flag) is not bool for key,flag in capabilities.items()):raise Error('Invalid host capabilities.',400)
    if not isinstance(environment,dict) or len(environment)>20 or any(not isinstance(key,str) or len(key)>100 or not isinstance(val,str) or len(val)>200 for key,val in environment.items()):raise Error('Invalid environment metadata.',400)
    checks=value.get('checks',[])
    if not isinstance(checks,list) or len(checks)>50:raise Error('Invalid environment checks.',400)
    for check in checks:
        if not isinstance(check,dict) or check.get('status') not in ('passed','warning','failed','skipped'):
            raise Error('Invalid environment check.',400)
        for key in ('id','label','detail'):text(check.get(key),key,1000)
    if any(c['status']=='failed' for c in checks) and value['status']!='failed':raise Error('Failed checks cannot report a ready host.',400)
    return value


def validate_sample(value):
    if not isinstance(value,dict) or value.get('scope') not in ('host','runner') or not isinstance(value.get('domain'),str) or len(value['domain'])>100:
        raise Error('Invalid resource sample.',400)
    fields={'scope','domain','sampledAt','cpuPercent','cpuCount','memoryTotalMiB','memoryAvailableMiB','diskTotalGiB','diskFreeGiB','cluster','canaveral'}
    if set(value)-fields:raise Error('Unknown resource metric.',400)
    for key,number in value.items():
        if key=='canaveral':
            if not isinstance(number,dict) or set(number)!={'scope','categories'} or number['scope'] not in ('runner-process-tree','runner-and-owned-processes') or not isinstance(number['categories'],list) or len(number['categories'])!=3:
                raise Error('Invalid Canaveral usage.',400)
            if {g.get('id') for g in number['categories'] if isinstance(g,dict)}!={'services','virtualMachines','simulators'}:raise Error('Invalid usage categories.',400)
            for group in number['categories']:
                if set(group)!={'id','cpuPercent','memoryMiB','processCount'}:raise Error('Invalid usage category.',400)
                for metric in ('cpuPercent','memoryMiB','processCount'):
                    n=group[metric]
                    if n is not None and (type(n) not in (int,float) or not math.isfinite(n) or not 0<=n<=2**53 or (metric=='cpuPercent' and n>100)):
                        raise Error('Invalid category metric.',400)
            continue
        if key=='cluster':
            from .cluster_resources import validate
            if not validate(number):raise Error('Invalid namespace resource report.',400)
            continue
        if key in ('scope','domain') or number is None:continue
        if type(number) not in (int,float) or not math.isfinite(number) or not 0 <= number <= 2**53 or (key=='cpuPercent' and number>100):
            raise Error('Invalid resource metric.',400)
    return value
