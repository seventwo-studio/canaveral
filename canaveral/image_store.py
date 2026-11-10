"""Image metadata and owned build receipts; payloads stay on the assigned host."""
import json
import math

from .image_library import specification
from .model import Error, identifier, text


class ImageStore:
    def initialize_images(self,db):
        db.execute('CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, host TEXT NOT NULL, metadata TEXT NOT NULL)')
        db.execute('CREATE TABLE IF NOT EXISTS image_tasks (id TEXT PRIMARY KEY, host TEXT NOT NULL, machine TEXT, request TEXT NOT NULL, state TEXT NOT NULL, result TEXT, created REAL NOT NULL, updated REAL NOT NULL, reserved_disk INTEGER NOT NULL)')

    def images(self):
        with self.transaction() as db:
            return [dict(hostId=row['host'],**json.loads(row['metadata'])) for row in db.execute('SELECT * FROM images ORDER BY rowid DESC')]

    def _image_used(self,db,host_id):
        # Each immutable artifact is charged once per host even if several names reference it.
        artifacts={}
        for row in db.execute('SELECT metadata FROM images WHERE host=?',(host_id,)):
            value=json.loads(row[0]);artifacts[(value['sha256'],value['format'])]=value['bytes']
        used=sum(math.ceil(size/1073741824) for size in artifacts.values())
        used+=db.execute("SELECT COALESCE(SUM(reserved_disk),0) FROM image_tasks WHERE host=? AND state IN ('queued','running','unknown')",(host_id,)).fetchone()[0]
        return used

    def _image_task(self,row):
        request=json.loads(row['request'])
        return {'id':row['id'],'hostId':row['host'],'machineId':row['machine'],'state':row['state'],
                'kind':request['kind'],'name':request.get('name',request.get('metadata',{}).get('name','Image')),
                'updatedAt':row['updated'],'result':json.loads(row['result']) if row['result'] else None}

    def image_tasks(self):
        with self.transaction() as db:return [self._image_task(row) for row in db.execute('SELECT * FROM image_tasks ORDER BY rowid DESC LIMIT 100')]

    def image_task(self,task_id):
        with self.transaction() as db:
            row=db.execute('SELECT * FROM image_tasks WHERE id=?',(identifier(task_id),)).fetchone()
            if not row:raise Error('Unknown image task.',404)
            return self._image_task(row)

    def reserve_image_import(self,host_id,value,size):
        host_id=identifier(host_id);metadata=specification(value)
        if type(size) is not int or not 512<=size<=2**53:raise Error('Invalid image content length.',400)
        request={'kind':'import','metadata':metadata,'bytes':size}
        with self.transaction() as db:
            old=db.execute('SELECT * FROM image_tasks WHERE id=?',(metadata['id'],)).fetchone()
            if old:
                if old['host']!=host_id or json.loads(old['request'])!=request:raise Error('Image task ID belongs to another specification.')
                if old['state']=='failed':raise Error('This import failed. Create a new import ID after inspecting its result.')
                return self._image_task(old)
            host=db.execute('SELECT * FROM hosts WHERE id=?',(host_id,)).fetchone()
            if not host or self.clock()-host['seen']>=self.lease_seconds:raise Error('Image host must be online.',409)
            disk=math.ceil(size/1073741824)
            if disk>self._remaining_capacity(db,host_id)['diskGiB']:raise Error('Image exceeds the available host storage limit.',409)
            db.execute("INSERT INTO image_tasks VALUES (?,?,NULL,?,'running',NULL,?,?,?)",(metadata['id'],host_id,json.dumps(request),self.clock(),self.clock(),disk))
            return self._image_task(db.execute('SELECT * FROM image_tasks WHERE id=?',(metadata['id'],)).fetchone())

    def create_image_capture(self,value):
        if not isinstance(value,dict) or set(value)!={'id','machineId','name'}:raise Error('Capture requires id, machineId and name.',400)
        task_id=identifier(value['id']);machine_id=identifier(value['machineId']);name=text(value['name'],'image name')
        request={'kind':'capture','machineId':machine_id,'name':name}
        with self.transaction() as db:
            old=db.execute('SELECT * FROM image_tasks WHERE id=?',(task_id,)).fetchone()
            if old:
                if json.loads(old['request'])!=request:raise Error('Capture ID belongs to another specification.')
                return self._image_task(old)
            machine=db.execute('SELECT m.*,h.seen FROM machines m JOIN hosts h ON h.id=m.host WHERE m.id=?',(machine_id,)).fetchone()
            if not machine:raise Error('Unknown machine.',404)
            if self._deletion(db,machine_id):raise Error('A source with a deletion intent cannot be captured.',409)
            if db.execute("SELECT 1 FROM machine_power_offs WHERE machine=? AND state!='succeeded'",(machine_id,)).fetchone():raise Error('Resolve the source power-off intent before capture.',409)
            if machine['desired']!='stopped' or machine['observed']!='stopped' or self.clock()-machine['seen']>=self.lease_seconds:
                raise Error('Stop the machine and wait for its online host to confirm shutdown before capture.',409)
            if json.loads(machine['template'])['os'] in ('android','ios'):raise Error('Simulator image capture is not supported by this VM operation.',409)
            if json.loads(machine['template']).get('guestAccess') and not machine['prepared_at']:
                raise Error('Finish guest-access preparation before capturing an automatically provisioned image.',409)
            if db.execute("SELECT 1 FROM image_tasks WHERE machine=? AND state IN ('queued','running','unknown')",(machine_id,)).fetchone():raise Error('This machine already has an unresolved image capture.',409)
            disk=json.loads(machine['request'])['resources']['diskGiB']+1
            if disk>self._remaining_capacity(db,machine['host'])['diskGiB']:raise Error('Capture exceeds the available host storage limit.',409)
            db.execute("INSERT INTO image_tasks VALUES (?,?,?,?,'queued',NULL,?,?,?)",(task_id,machine['host'],machine_id,json.dumps(request),self.clock(),self.clock(),disk))
            return self._image_task(db.execute('SELECT * FROM image_tasks WHERE id=?',(task_id,)).fetchone())

    def _register_image(self,db,host_id,value):
        validate_image(value)
        old=db.execute('SELECT * FROM images WHERE id=?',(value['id'],)).fetchone()
        if old:
            if old['host']!=host_id or json.loads(old['metadata'])!=value:raise Error('Image identity already has another owner or immutable artifact.')
            return
        db.execute('INSERT INTO images VALUES (?,?,?)',(value['id'],host_id,json.dumps(value)))

    def finish_image_import(self,task_id,host_id,result=None,failed=False):
        with self.transaction() as db:
            row=db.execute('SELECT * FROM image_tasks WHERE id=?',(identifier(task_id),)).fetchone()
            if not row or row['host']!=host_id or json.loads(row['request'])['kind']!='import':raise Error('Image import ownership mismatch.',403)
            if row['state'] in ('succeeded','failed'):return self._image_task(row)
            if failed:
                db.execute("UPDATE image_tasks SET state='failed',updated=? WHERE id=?",(self.clock(),task_id))
            else:
                self._validate_import_result(row,result)
                self._register_image(db,host_id,result)
                db.execute("UPDATE image_tasks SET state='succeeded',result=?,updated=? WHERE id=?",(json.dumps(result),self.clock(),task_id))
            return self._image_task(db.execute('SELECT * FROM image_tasks WHERE id=?',(task_id,)).fetchone())

    def _assigned_image_tasks(self,db,host_id):
        tasks=[]
        for row in db.execute("SELECT * FROM image_tasks WHERE host=? AND state IN ('queued','running') ORDER BY rowid",(host_id,)):
            if json.loads(row['request'])['kind'] in ('import','registry'):
                tasks.append({'id':row['id'],**json.loads(row['request'])})
                if len(tasks)>=8:break
                continue
            machine=db.execute('SELECT * FROM machines WHERE id=?',(row['machine'],)).fetchone()
            tasks.append({'id':row['id'],**json.loads(row['request']),'machine':self._machine(machine,True)})
            if len(tasks)>=8:break
        return tasks

    def _report_image_tasks(self,db,host_id,reports):
        if not isinstance(reports,dict) or len(reports)>1:raise Error('Report at most one image task per heartbeat.',400)
        for task_id,report in reports.items():
            row=db.execute('SELECT * FROM image_tasks WHERE id=?',(identifier(task_id),)).fetchone()
            if not row or row['host']!=host_id:raise Error('Cannot report another host image task.',403)
            if not isinstance(report,dict) or report.get('state') not in ('running','succeeded','failed','unknown'):raise Error('Invalid image build report.',400)
            if row['state'] in ('succeeded','failed','unknown'):continue
            result=report.get('result',{})
            if len(json.dumps(result))>20000:raise Error('Image build metadata is too large.',400)
            if report['state']=='succeeded':
                if result.get('id')!=task_id or result.get('sourceMachineId')!=row['machine']:raise Error('Capture provenance does not match its task.')
                if json.loads(row['request'])['kind'] in ('import','registry'):self._validate_import_result(row,result)
                elif result.get('kind')!='derived':raise Error('Capture must publish a derived image.')
                if result.get('bytes',0)>row['reserved_disk']*1073741824:raise Error('Capture exceeds its storage reservation.')
                self._register_image(db,host_id,result)
            db.execute('UPDATE image_tasks SET state=?,result=?,updated=? WHERE id=?',(report['state'],json.dumps(result),self.clock(),task_id))

    def _validate_import_result(self,row,result):
        request=json.loads(row['request'])
        if result.get('id')!=row['id'] or result.get('bytes')!=request['bytes'] or result.get('kind')!='base':raise Error('Imported artifact differs from its reservation.')
        if {key:result.get(key) for key in request['metadata']}!=request['metadata']:raise Error('Imported metadata differs from its reservation.')
        if request['kind']=='registry':
            source=request['source']
            if source['sha256'] and result['sha256']!=source['sha256']:raise Error('Registry checksum differs from the pinned publisher identity.')
            expected={'id':request['registryId'],'version':source['version'],'url':source['url'],'publisherSha256':source['sha256']}
            if result.get('registry')!=expected:raise Error('Registry provenance differs from the resolved task.')

    def _acknowledged_images(self,db,host_id):
        return {row['id']:json.loads(row['metadata'])['sha256'] for row in db.execute('SELECT * FROM images WHERE host=?',(host_id,))}

    def _validate_catalogue_offer(self,db,host_id,proposed):
        for definition in proposed['templates']:
            image_id=definition.get('catalogueImageId')
            if image_id is None:continue
            row=db.execute('SELECT * FROM images WHERE id=?',(image_id,)).fetchone()
            if not row or row['host']!=host_id:raise Error('Catalogue artifact has not been registered to this host.')
            public=json.loads(row['metadata'])
            if public['sha256']!=definition['artifactSha256'] or any(public[key]!=definition[key] for key in ('id','name','os','arch','mode','mediaType','minimum')):
                raise Error('Offered image differs from its registered artifact.')


def validate_image(value):
    import re
    if not isinstance(value,dict) or set(value)-{'id','name','os','arch','mode','mediaType','format','minimum','guestAccess','sha256','bytes','kind','revision','sourceMachineId','baseImageId','identityPolicy','registry','consistency'}:raise Error('Invalid image metadata.',400)
    spec={key:value[key] for key in ('id','name','os','arch','mode','mediaType','format','minimum')}
    if 'guestAccess' in value:spec['guestAccess']=value['guestAccess']
    specification(spec)
    if not isinstance(value.get('sha256'),str) or not re.fullmatch('[0-9a-f]{64}',value['sha256']) or type(value.get('bytes')) is not int or not 512<=value['bytes']<=2**53:raise Error('Invalid image artifact identity.',400)
    if value.get('kind') not in ('base','derived') or value.get('revision')!='1':raise Error('Invalid image provenance.',400)
    if value['kind']=='derived':identifier(value.get('sourceMachineId'))
    elif value.get('sourceMachineId') is not None:raise Error('Base images cannot claim capture provenance.',400)
    if value.get('identityPolicy') not in (None,'fresh-broker-credentials','linux-cloud-init','preserve-configured-os-state'):raise Error('Unsupported clone identity policy.',400)
    if value.get('consistency') not in (None,'stopped-disk','guest-shutdown','crash-consistent'):raise Error('Invalid capture consistency.',400)
    if 'registry' in value:
        from .image_registry import entry,validate_entry_source
        provenance=value['registry']
        if not isinstance(provenance,dict) or set(provenance)!={'id','version','url','publisherSha256'}:raise Error('Invalid registry provenance.',400)
        validate_entry_source(entry(provenance['id']),{'url':provenance['url'],'version':provenance['version'],'sha256':provenance['publisherSha256'],'bytes':value['bytes']})
        if provenance['publisherSha256'] and provenance['publisherSha256']!=value['sha256']:raise Error('Image failed its publisher checksum.',400)
