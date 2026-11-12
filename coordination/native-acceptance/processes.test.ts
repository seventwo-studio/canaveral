import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ownedProcesses,processRows,vzPids} from './processes.ts';
test('cleanup attributes descendants, reparented VZ and machine files, preserving unrelated VMs',()=>{
  const rows=processRows('10 1 /helper run /owned\n11 10 worker\n12 11 child\n20 1 /com.apple.Virtualization.VirtualMachine\n21 1 /com.apple.Virtualization.VirtualMachine\n22 1 /com.apple.Virtualization.VirtualMachine');
  assert.deepEqual(vzPids(rows),[20,21,22]);
  const owned=ownedProcesses(rows,[10],'/owned/machine','p20\nn/owned/workspace.raw\np21\nn/other/disk.img\np22\nn/owned-other/disk.img');
  assert.deepEqual(new Set(owned),new Set([10,11,12,20]));
  assert(ownedProcesses(rows,[],'/owned/machine','',owned).includes(20));
  assert(!owned.includes(21)); assert(!owned.includes(22));
});
