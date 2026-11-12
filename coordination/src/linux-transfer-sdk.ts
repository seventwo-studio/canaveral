import { createHash } from 'node:crypto';
export type FileRequest =
  | {action:'beginUpload';path:string;bytes:number;sha256:string;replace:boolean}
  | {action:'beginDownload';path:string}
  | {action:'write';offset:number;data:string}
  | {action:'read';offset:number;maxBytes:number}
  | {action:'finish';bytes:number;sha256:string}
  | {action:'abort'};
export type TransferIntent = {id:string;member:'primary'} & (
  {direction:'upload';path:string;bytes:number;sha256:string;replace:boolean} | {direction:'download';path:string});
export interface FileTransfer {id:string;leaseId:string;member:'primary';direction:'upload'|'download';state:string;offset:number;bytes:number|null;sha256:string|null;durable:boolean;updatedAt:string;error:{code:string;outcome:'failed'|'unknown'}|null}
export interface FileStep {id:string;step:number;state:string;receipt:Record<string,unknown>|null;updatedAt:string}
export interface TransferClient {
  createTransfer(intent:TransferIntent):Promise<FileTransfer>;
  createTransferStep(id:string,step:number,request:FileRequest):Promise<FileStep>;
  transferStep(id:string,step:number):Promise<FileStep>;
  transfer(id:string):Promise<FileTransfer>;
}
/** Must durably save intent/steps before resolving; download sink must persist bytes before resolving. */
export interface TransferJournal {save(value:TransferIntent|{id:string;step:number;request:FileRequest}):Promise<void>}
export interface TransferWait {wait():Promise<void>; signal?:AbortSignal}
async function execute(client:TransferClient,id:string,step:number,request:FileRequest,journal:TransferJournal,wait:TransferWait):Promise<Record<string,unknown>> {
  wait.signal?.throwIfAborted(); await journal.save({id,step,request});
  let s=await client.createTransferStep(id,step,request);
  while(s.state==='queued'||s.state==='dispatched') { wait.signal?.throwIfAborted(); await wait.wait(); s=await client.transferStep(id,step); }
  if(s.state!=='succeeded'||!s.receipt) throw new Error(`Transfer ${id} step ${step}: ${s.state}; inspect before further action`);
  return s.receipt;
}
/** Caller supplies and persists UUID; transport/unknown errors stop, never allocate replacement work. */
export async function uploadWorkspaceFile(client:TransferClient,intent:Extract<TransferIntent,{direction:'upload'}>,source:AsyncIterable<Uint8Array>,journal:TransferJournal,wait:TransferWait):Promise<FileTransfer> {
  await journal.save(intent); await client.createTransfer(intent);
  let step=1,offset=0; const h=createHash('sha256');
  await execute(client,intent.id,step++,{action:'beginUpload',path:intent.path,bytes:intent.bytes,sha256:intent.sha256,replace:intent.replace},journal,wait);
  for await(const block of source) for(let i=0;i<block.length;i+=65536) {
    const chunk=Buffer.from(block.subarray(i,i+65536));
    if(offset+chunk.length>intent.bytes) throw new Error('Upload size mismatch');
    const r=await execute(client,intent.id,step++,{action:'write',offset,data:chunk.toString('base64')},journal,wait);
    offset+=chunk.length; if(r.offset!==offset) throw new Error('Upload cursor mismatch'); h.update(chunk);
  }
  if(offset!==intent.bytes||h.digest('hex')!==intent.sha256) throw new Error('Upload digest mismatch');
  await execute(client,intent.id,step,{action:'finish',bytes:offset,sha256:intent.sha256},journal,wait);
  const t=await client.transfer(intent.id);
  if(t.state!=='committed'||!t.durable||t.bytes!==offset||t.sha256!==intent.sha256) throw new Error('Upload publication unconfirmed');
  return t;
}
export async function downloadWorkspaceFile(client:TransferClient,intent:Extract<TransferIntent,{direction:'download'}>,persist:(chunk:Uint8Array)=>Promise<void>,journal:TransferJournal,wait:TransferWait):Promise<FileTransfer> {
  await journal.save(intent); await client.createTransfer(intent); let step=1,offset=0;
  const begin=await execute(client,intent.id,step++,{action:'beginDownload',path:intent.path},journal,wait),bytes=begin.bytes;
  if(typeof bytes!=='number'||!Number.isSafeInteger(bytes)||bytes<0) throw new Error('Invalid download size');
  const h=createHash('sha256');
  while(offset<bytes) {
    const r=await execute(client,intent.id,step++,{action:'read',offset,maxBytes:65536},journal,wait);
    if(typeof r.data!=='string') throw new Error('Missing download chunk');
    const chunk=Buffer.from(r.data,'base64');
    if(chunk.toString('base64')!==r.data||!chunk.length||chunk.length>65536||offset+chunk.length>bytes||r.offset!==offset+chunk.length) throw new Error('Invalid download cursor');
    await persist(chunk); h.update(chunk); offset+=chunk.length;
  }
  const sha256=h.digest('hex');
  await execute(client,intent.id,step,{action:'finish',bytes,sha256},journal,wait);
  const t=await client.transfer(intent.id); if(t.state!=='verified'||t.bytes!==bytes||t.sha256!==sha256) throw new Error('Download verification failed'); return t;
}
