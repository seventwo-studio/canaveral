// Disposable portable bridge fixture. Never selected by nativeTransport().
import { stdin, stdout } from 'node:process';
const mode = process.argv[2] ?? 'normal';
let bytes = Buffer.alloc(0), invoked = false, next = 0;
const handles = new Map();
const identity = (directory, id) => ({ volume: '1', fileId: id.toString(16).padStart(32,'0'), size: directory ? 0 : 5, written:'1', changed:'1', links:1, directory, attributes:directory ? 16 : 128 });
function send(value) { const raw = Buffer.from(JSON.stringify(value)), head=Buffer.alloc(4);head.writeUInt32BE(raw.length);stdout.write(Buffer.concat([head,raw])); }
function reply(req) {
  if (mode === 'hang' || req.action === 'hang') return;
  if (mode === 'wrong-id') { send({id:'wrong',ok:true,result:{}});return; }
  if (mode === 'oversized') { const b=Buffer.alloc(4);b.writeUInt32BE(20*1048576);stdout.write(b);return; }
  let result;
  const a=req.arguments;
  if (req.action==='files.drive') { result=String(++next);handles.set(result,identity(true,1)); }
  else if(req.action==='files.open') { result=String(++next);handles.set(result,identity(false,2)); }
  else if(req.action==='files.info') result=handles.get(a.handle);
  else if(req.action==='files.read') result=Buffer.from('hello').subarray(a.offset,a.offset+a.count).toString('base64');
  else if(req.action==='files.close') {handles.delete(a.handle);result=true;}
  else if(req.action==='desktop.close'||req.action==='uia.clear') {invoked=false;result=true;}
  else if(req.action==='uia.root')result='root';
  else if(req.action==='uia.first')result=a.element==='root'?'button':null;
  else if(req.action==='uia.next')result=null;
  else if(req.action==='uia.same')result=a.a===a.b;
  else if(req.action==='uia.describe')result={role:'button',name:a.element,identifier:a.element,states:{enabled:true,offscreen:false,password:false},actions:['invoke'],bounds:{x:0,y:0,width:10,height:10},properties:{runtimeId:[1,a.element==='root'?1:2]}};
  else if(req.action==='uia.invoke') {if(invoked)throw new Error('replay');invoked=true;result=true;}
  else if(req.action==='delayed') { setTimeout(()=>send({id:req.id,ok:true,result:a}),100);return; }
  else result=a;
  send({id:req.id,ok:true,result});
}
stdin.on('data',chunk=>{bytes=Buffer.concat([bytes,chunk]);while(bytes.length>=4){const length=bytes.readUInt32BE();if(length<1||length>1000000)process.exit(1);if(bytes.length<length+4)break;const req=JSON.parse(bytes.subarray(4,length+4));bytes=bytes.subarray(length+4);reply(req);}});
stdin.on('end',()=>process.exit(0));
