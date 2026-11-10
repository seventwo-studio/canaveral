import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { ServiceError, object } from "../errors.ts";
import { assignmentFingerprint, command, ensureSeed, localTemplates, ownedStorage, present, readRecord, safePath, saveRecord, string, syncDirectory, uuid } from "./apple.ts";
import type { Data } from "./apple.ts";

// Data travels only through JSON in the environment, never interpolated into script.
export const HYPERV_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$p = $env:CANAVERAL_OPERATION | ConvertFrom-Json
Import-Module Hyper-V
if ($p.operation -eq 'check') { Get-VMHost | Out-Null; exit }
$vm = Get-VM -Name $p.name -ErrorAction SilentlyContinue
if ($null -ne $vm) {
    if ($vm.Notes -ne ('Canaveral:' + $p.id)) { throw 'Existing VM is not owned by this assignment.' }
    if (-not $p.vmId -or [string]$vm.Id -ne $p.vmId) { throw 'VM incarnation differs from its pinned ownership receipt.' }
    $disks = @(Get-VMHardDiskDrive -VM $vm)
    if ($disks.Count -ne 1 -or [IO.Path]::GetFullPath($disks[0].Path) -ne [IO.Path]::GetFullPath($p.disk)) { throw 'VM disk binding differs from this assignment.' }
}
if ($p.operation -eq 'inspect') {
    if ($null -eq $vm) { @{state='absent'} | ConvertTo-Json -Compress; exit }
    @{state=[string]$vm.State;vmId=[string]$vm.Id;disk=$disks[0].Path} | ConvertTo-Json -Compress; exit
}
if ($null -eq $vm) {
    if ($p.desired -eq 'stopped') { @{state='stopped'} | ConvertTo-Json -Compress; exit }
    if ($p.vmId) { throw 'Pinned VM is missing; automatic recreation is blocked.' }
    if (Test-Path -LiteralPath $p.disk) { throw 'Partial VM disk exists without its VM; inspect before retrying.' }
    if ((Get-VHD -Path $p.image).Size -gt $p.diskBytes) { throw 'Requested disk is smaller than the template.' }
    Convert-VHD -Path $p.image -DestinationPath $p.disk -VHDType Dynamic
    Resize-VHD -Path $p.disk -SizeBytes $p.diskBytes
    $vm = New-VM -Name $p.name -Generation 2 -MemoryStartupBytes $p.memoryBytes -VHDPath $p.disk -SwitchName $p.switch
    Set-VM -VM $vm -Notes ('Canaveral:' + $p.id) -AutomaticStartAction Nothing -AutomaticStopAction ShutDown
    Set-VMProcessor -VM $vm -Count $p.cpu
    if ($p.seed) { Add-VMDvdDrive -VM $vm -Path $p.seed | Out-Null }
    if ($p.secureBoot) {
        $secureTemplate = if ($p.os -eq 'windows') { 'MicrosoftWindows' } else { 'MicrosoftUEFICertificateAuthority' }
        Set-VMFirmware -VM $vm -EnableSecureBoot On -SecureBootTemplate $secureTemplate
    } else { Set-VMFirmware -VM $vm -EnableSecureBoot Off }
    if ($p.os -eq 'windows') { Set-VMKeyProtector -VM $vm -NewLocalKeyProtector; Enable-VMTPM -VM $vm }
    # Creation returns before boot. Its UID receipt must be durable before Start-VM.
    @{state='prepared';vmId=[string]$vm.Id;disk=$p.disk} | ConvertTo-Json -Compress; exit
}
if ($p.desired -eq 'stopped') {
    if ($vm.State -eq 'Off') { @{state='stopped';vmId=[string]$vm.Id;disk=$p.disk} | ConvertTo-Json -Compress }
    else { Stop-VM -VM $vm -Confirm:$false; @{state='stopping';vmId=[string]$vm.Id;disk=$p.disk} | ConvertTo-Json -Compress }
} elseif ($vm.State -eq 'Off') {
    Start-VM -VM $vm; @{state='starting';vmId=[string]$vm.Id;disk=$p.disk} | ConvertTo-Json -Compress
} elseif ($vm.State -eq 'Running') {
    @{state='running';vmId=[string]$vm.Id;disk=$p.disk;detail=('Use VMConnect or guest SSH/RDP for ' + $p.name)} | ConvertTo-Json -Compress
} else { @{state='unknown';vmId=[string]$vm.Id;disk=$p.disk;detail=[string]$vm.State} | ConvertTo-Json -Compress }
`;

export class HypervProvider {
  readonly kind = "hyperv";
  constructor(readonly config: Data, readonly state: string) {}
  name(machine: Data): string { return `cvm-${uuid(machine.id)}`; }
  storage(machine: Data): string { return ownedStorage(this.config, machine); }
  async execute(value: Data): Promise<string> {
    return command(this.config, ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(HYPERV_SCRIPT, "utf16le").toString("base64")], { env: { ...process.env, CANAVERAL_OPERATION: JSON.stringify(value) } });
  }
  async check(): Promise<unknown> {
    if ((this.config.platform ?? process.platform) !== "win32") throw new ServiceError("The Hyper-V provider runs on Windows hosts with Hyper-V enabled.");
    localTemplates(this.config, ["linux", "windows"]); if (!this.config.switch) throw new ServiceError("Choose an existing Hyper-V virtual switch.");
    return this.execute({ operation: "check" });
  }
  async reconcile(machine: Data, image: Data, folder: string): Promise<Data> {
    safePath(folder); if (present(join(folder, "deletion.json"))) throw new ServiceError("Deletion intent blocks Hyper-V reconciliation.");
    if (!["running", "stopped"].includes(string(machine.desired))) throw new ServiceError("Invalid desired state.", 400);
    if (machine.lease) throw new ServiceError("Hyper-V lease execution requires independent native deadline fencing; creation is disabled.", 503);
    const storage = this.storage(machine); const disk = safePath(join(storage, "disk.vhdx"));
    const receipt = join(folder, "hyperv-owner.json"); const intent = join(folder, "hyperv-operation.json"); const fingerprint = assignmentFingerprint(machine);
    const owner = present(receipt) ? readRecord(receipt) : null;
    if (owner && (owner.machineId !== uuid(machine.id) || owner.fingerprint !== fingerprint || owner.disk !== disk)) throw new ServiceError("Hyper-V ownership receipt differs from this assignment.");
    if (owner) uuid(owner.vmId);
    const resources = object(machine.resources);
    for (const key of ["cpu", "memoryMiB", "diskGiB"]) if (!Number.isSafeInteger(resources[key]) || Number(resources[key]) <= 0) throw new ServiceError("Invalid Hyper-V resources.", 400);
    const value: Data = { operation: "reconcile", id: uuid(machine.id), name: this.name(machine), desired: machine.desired, disk, image: image.image, switch: string(this.config.switch), os: image.os,
      seed: null, secureBoot: image.secureBoot ?? true, cpu: resources.cpu, memoryBytes: Number(resources.memoryMiB) * 1048576, diskBytes: Number(resources.diskGiB) * 1073741824, vmId: owner?.vmId ?? null };
    if (!Number.isSafeInteger(value.memoryBytes) || !Number.isSafeInteger(value.diskBytes)) throw new ServiceError("Hyper-V resources exceed exact numeric limits.");
    if (present(intent)) {
      const pending = readRecord(intent);
      if (pending.fingerprint !== fingerprint || pending.machineId !== machine.id) throw new ServiceError("Hyper-V pending operation belongs to another assignment.");
      // Inspect-only after response loss. Never repeat Start-VM or Stop-VM.
      if (!owner) return { state: "unknown", detail: "Hyper-V creation outcome is uncertain; no automatic creation or adoption is permitted." };
      const seen = object(JSON.parse(await this.execute({ ...value, operation: "inspect" })));
      if (seen.vmId !== owner.vmId || seen.disk !== disk) return { state: "unknown", detail: "Pinned Hyper-V VM or disk is unavailable; reservations remain held." };
      if (!(pending.desired === "running" && seen.state === "Running" || pending.desired === "stopped" && seen.state === "Off")) return { state: "unknown", detail: "Hyper-V operation outcome is uncertain; inspect the retained request before recovery." };
      saveRecord(intent, { ...pending, confirmed: true });
      if (pending.desired === machine.desired) return { state: seen.state === "Off" ? "stopped" : "running" };
      unlinkSync(intent); syncDirectory(folder);
    }
    // A no-VM stop must not leave a creation intent that could later count as a VM.
    if (machine.desired === "stopped" && !owner) {
      const seen = object(JSON.parse(await this.execute({ ...value, operation: "inspect" })));
      return { state: seen.state === "absent" && !present(disk) ? "stopped" : "unknown" };
    }
    if (machine.desired === "running") value.seed = await ensureSeed(this.config, image, machine, storage);
    const pending = { machineId: uuid(machine.id), fingerprint, desired: machine.desired, requestId: randomUUID() };
    saveRecord(intent, pending, true);
    let result = object(JSON.parse(await this.execute(value)));
    if (result.state === "prepared") {
      if (owner || result.disk !== disk) throw new ServiceError("Hyper-V creation response differs from the requested disk.");
      const vmId = uuid(result.vmId); saveRecord(receipt, { machineId: uuid(machine.id), fingerprint, vmId, disk }, true);
      // Retain intent across the second command so a lost boot response is inspect-only.
      result = object(JSON.parse(await this.execute({ ...value, vmId })));
      if (result.vmId !== vmId || result.disk !== disk) throw new ServiceError("Hyper-V runtime response differs from its newly pinned identity.");
    }
    if (owner && (result.vmId !== owner.vmId || result.disk !== disk)) throw new ServiceError("Hyper-V runtime response differs from its pinned identity.");
    if (!["starting", "running", "stopping", "stopped", "unknown"].includes(String(result.state))) throw new ServiceError("Hyper-V runtime returned an invalid state.");
    saveRecord(intent, { ...pending, confirmed: result.state === "running" || result.state === "stopped" });
    return result;
  }
}
