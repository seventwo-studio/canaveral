"""Durable registry import intent; reserve actual bytes before downloading."""
import json
import math

from .image_registry import entry,validate_entry_source
from .model import Error,identifier,text


class RegistryStore:
    def create_registry_import(self,value):
        if not isinstance(value,dict) or set(value)-{'id','registryId','hostId','name','guestAccess'} or not {'id','registryId','hostId'}<=set(value):raise Error('Invalid registry import request.',400)
        task=identifier(value['id']);host_id=identifier(value['hostId']);item=entry(value['registryId'])
        if not item['resolver']:raise Error(item['note'],409)
        if 'guestAccess' in value and type(value['guestAccess']) is not bool:raise Error('Invalid guest access option.',400)
        metadata={key:item[key] for key in ('os','arch','mode','mediaType','format','minimum')}
        metadata.update(id=task,name=text(value.get('name',item['name']),'image name'))
        if value.get('guestAccess'):
            if item['os']!='linux' or item['mediaType']!='disk':raise Error('Automatic guest services require a Linux boot disk.',400)
            metadata['guestAccess']=True
        request={'kind':'registry','registryId':item['id'],'metadata':metadata}
        with self.transaction() as db:
            old=db.execute('SELECT * FROM image_tasks WHERE id=?',(task,)).fetchone()
            if old:
                original=json.loads(old['request']);original.pop('source',None);original.pop('bytes',None)
                if old['host']!=host_id or original!=request:raise Error('Image task ID already belongs to another request.',409)
                return self._image_task(old)
            host=db.execute('SELECT * FROM hosts WHERE id=?',(host_id,)).fetchone()
            if not host or self.clock()-host['seen']>=self.lease_seconds:raise Error('Select an online image host.',409)
            offer=json.loads(host['offer'])
            if offer['provider']=='kubevirt':raise Error('Registry imports currently require a direct host.',409)
            if item['os']=='macos' and offer['provider'] not in ('macos','apple'):raise Error('macOS restore images require a Mac host.',409)
            db.execute("INSERT INTO image_tasks VALUES (?,?,NULL,?,'queued',NULL,?,?,0)",(task,host_id,json.dumps(request),self.clock(),self.clock()))
            return self._image_task(db.execute('SELECT * FROM image_tasks WHERE id=?',(task,)).fetchone())

    def resolve_registry_import(self,host_id,credential,task_id,source):
        with self.transaction() as db:
            self._authenticate(db,host_id,credential)
            row=db.execute('SELECT * FROM image_tasks WHERE id=?',(identifier(task_id),)).fetchone()
            if not row or row['host']!=host_id:raise Error('Unknown owned image task.',404)
            request=json.loads(row['request'])
            if request['kind']!='registry' or row['state'] not in ('queued','running'):raise Error('Registry task is not awaiting a source.',409)
            source=validate_entry_source(entry(request['registryId']),source)
            if request.get('source'):
                if request['source']!=source:raise Error('Registry source was already pinned to another artifact.',409)
            else:
                cost=math.ceil(source['bytes']/1073741824)
                if cost>self._remaining_capacity(db,host_id)['diskGiB']:raise Error('Registry image exceeds available host storage limit.',409)
                request.update(source=source,bytes=source['bytes'])
                db.execute("UPDATE image_tasks SET request=?,reserved_disk=?,state='running',updated=? WHERE id=?",(json.dumps(request),cost,self.clock(),row['id']))
            return {'id':row['id'],**request}
