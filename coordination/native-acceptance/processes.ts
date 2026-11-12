import {dirname} from 'node:path';
export interface ProcessRow {pid:number; ppid:number; command:string}
export function processRows(ps:string):ProcessRow[] {
  return ps.split('\n').flatMap(line => {
    const m=line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    return m?[{pid:Number(m[1]),ppid:Number(m[2]),command:m[3]!}]:[];
  });
}
export function ownedProcesses(rows:ProcessRow[], helperPids:number[], machine:string, files:string, previous:number[]=[]):number[] {
  // Native disks and launch media sit beside the helper's machine directory.
  const workspace=dirname(machine);
  const owned=new Set([...helperPids,...previous]);
  let pid=0;
  for(const line of files.split('\n')) {
    if(line.startsWith('p')) pid=Number(line.slice(1));
    if(line.startsWith('n') && (line.slice(1)===workspace || line.slice(1).startsWith(workspace+'/'))) owned.add(pid);
  }
  let changed=true;
  while(changed) {
    changed=false;
    for(const row of rows) if(owned.has(row.ppid) && !owned.has(row.pid)) {owned.add(row.pid);changed=true;}
  }
  return [...owned];
}
export function vzPids(rows:ProcessRow[]):number[] {
  return rows.filter(r=>/^\S*com\.apple\.Virtualization\.VirtualMachine(?:\s|$)/.test(r.command)).map(r=>r.pid);
}
