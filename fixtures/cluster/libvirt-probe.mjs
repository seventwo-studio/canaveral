// Read-only replay of the administrative libvirt reconcile checks, run inside
// the canaverald pod as its own UID with the daemon's compiled code:
//   kubectl -n canaverald exec -i daemonset/canaverald -- node --input-type=module - < libvirt-probe.mjs
// The daemon reports any refusal only as "Assignment reconciliation requires
// inspection", so this prints which check refuses. It opens no journal locks,
// changes no file and issues only libvirt read calls.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { join } from 'node:path';

const dist = 'file:///app/coordination/dist/src/providers/';
const ownership = await import(dist + 'libvirt-ownership.js');
const provider = await import(dist + 'libvirt.js');
const config = JSON.parse(fs.readFileSync('/etc/canaverald/host.json', 'utf8'));
const machines = '/var/lib/canaverald/machines';
const machinesReport = [];
let results;
const check = async (name, task) => {
  try { results.push({ check: name, ok: true, value: await task() }); }
  catch (error) { results.push({ check: name, ok: false, error: String(error?.message ?? error).slice(0, 400) }); }
};
// The daemon runs the same argv through runProcess, which hides stderr.
const virsh = (uri, ...args) => {
  try {
    return execFileSync('virsh', ['--connect', uri, ...args], { encoding: 'utf8', timeout: 30000, maxBuffer: 1048576,
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) { throw new Error(`virsh ${args[0]} failed (${error.status ?? error.signal}): ${String(error.stderr).trim().slice(-300)}`); }
};
const json = path => JSON.parse(fs.readFileSync(path, 'utf8'));

for (const id of fs.existsSync(machines) ? fs.readdirSync(machines) : []) {
  const folder = join(machines, id);
  if (!fs.existsSync(join(folder, 'libvirt-binding.json'))) continue;
  results = [];
  machinesReport.push({ machineId: id, checks: results });
  const spec = json(join(folder, 'libvirt-binding.json'));
  const binding = new ownership.LibvirtLeaseBinding(spec.binding);
  const access = provider.vmStorageAccess(config);
  const root = join(config.storage, binding.machine_id);
  await check('process', () => ({ uid: process.getuid(), gid: process.getgid(), groups: process.getgroups() }));
  await check('private folder', () => { ownership.owned(fs.lstatSync(folder), true); return 'owned 0700'; });
  await check('execution phase', () => json(join(folder, 'libvirt-execution.json')).phase);
  await check('execution identity', () => {
    if (!ownership.matches(json(join(folder, 'libvirt-execution.json')), binding.identity())) throw new Error('execution history is foreign');
    return 'matches';
  });
  await check('assignment receipt', () => {
    const receipt = json(join(folder, 'assignment.json'));
    if (receipt.fingerprint !== binding.fingerprint) throw new Error('assignment fingerprint differs from the binding');
    return 'matches';
  });
  await check('location', () => {
    const uri = provider.localLibvirtUri(config);
    const facts = { uri: spec.uri === uri, disk: binding.disk === join(root, 'disk.qcow2'),
      access: spec.storageAccess === undefined || ownership.canonical(spec.storageAccess) === ownership.canonical(access) };
    if (!Object.values(facts).every(Boolean)) throw new Error('location differs: ' + JSON.stringify({ ...facts, saved: spec.uri, expected: uri }));
    return facts;
  });
  await check('owned storage', () => {
    ownership.noSymlinks(root);
    const directory = fs.lstatSync(root);
    provider.vmEntry(directory, spec.storageAccess, 'directory');
    if (!ownership.sameInode(directory, spec.storageIdentity)) throw new Error('storage directory identity differs');
    const disk = fs.lstatSync(binding.disk);
    provider.vmEntry(disk, spec.storageAccess, 'disk');
    if (!ownership.sameInode(disk, spec.diskIdentity)) throw new Error('disk identity differs');
    if (ownership.readPrivate(join(root, 'canaveral-owner.json'))?.fingerprint !== binding.fingerprint) throw new Error('owner marker differs');
    return 'unchanged';
  });
  // The daemon calls domuuid with the UUID; virsh resolves domuuid only by name or ID.
  for (const args of [['list', '--all', '--uuid'], ['domuuid', binding.machine_id], ['domuuid', 'cvm-' + binding.machine_id],
    ['domname', binding.machine_id], ['domstate', binding.machine_id]]) {
    await check('virsh ' + args.join(' ').replaceAll(binding.machine_id, '<uuid>'), () => virsh(spec.uri, ...args).slice(0, 200));
  }
  await check('domain XML', () => {
    ownership.validateDomainXML(virsh(spec.uri, 'dumpxml', binding.machine_id), binding, spec.storageAccess?.label);
    return 'valid';
  });
}
console.log(JSON.stringify(machinesReport, null, 2));
