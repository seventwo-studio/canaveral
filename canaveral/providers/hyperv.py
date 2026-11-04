import base64
import json
import os
import platform

from .base import Provider, run
from ..model import Error
from ..seed import ensure_seed


HYPERV_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
$p = $env:CANAVERAL_OPERATION | ConvertFrom-Json
Import-Module Hyper-V
if ($p.operation -eq 'check') { Get-VMHost | Out-Null; exit }
$vm = Get-VM -Name $p.name -ErrorAction SilentlyContinue
if ($null -ne $vm -and $vm.Notes -ne ('Canaveral:' + $p.id)) { throw 'Existing VM is not owned by this assignment.' }
if ($null -eq $vm) {
    if ($p.desired -eq 'stopped') { @{state='stopped'} | ConvertTo-Json -Compress; exit }
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
    if ($p.os -eq 'windows') {
        Set-VMKeyProtector -VM $vm -NewLocalKeyProtector
        Enable-VMTPM -VM $vm
    }
}
if ($p.desired -eq 'stopped') {
    if ($vm.State -eq 'Off') { @{state='stopped'} | ConvertTo-Json -Compress }
    else { Stop-VM -VM $vm -Confirm:$false; @{state='stopping'} | ConvertTo-Json -Compress }
} elseif ($vm.State -eq 'Off') {
    Start-VM -VM $vm; @{state='starting'} | ConvertTo-Json -Compress
} elseif ($vm.State -eq 'Running') {
    @{state='running';detail=('Use VMConnect or guest SSH/RDP for ' + $p.name)} | ConvertTo-Json -Compress
} else { @{state='unknown';detail=[string]$vm.State} | ConvertTo-Json -Compress }
"""


class HyperV(Provider):
    def execute(self, value):
        env = os.environ.copy()
        env["CANAVERAL_OPERATION"] = json.dumps(value)
        encoded = base64.b64encode(HYPERV_SCRIPT.encode("utf-16le")).decode()
        return run(["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], env=env)

    def check(self):
        if platform.system() != "Windows":
            raise Error("The Hyper-V provider runs on Windows hosts with Hyper-V enabled.")
        self.local_templates({"linux", "windows"})
        if not self.config.get("switch"):
            raise Error("Choose an existing Hyper-V virtual switch.")
        self.execute({"operation": "check"})

    def reconcile(self, machine, image, folder):
        storage = self.storage(machine)
        seed = ensure_seed(image, machine, storage)
        value = {"operation": "reconcile", "id": machine["id"], "name": self.name(machine), "desired": machine["desired"],
                 "disk": str(storage / "disk.vhdx"), "image": image["image"], "switch": self.config["switch"], "os": image["os"],
                 "seed": seed, "secureBoot": image.get("secureBoot", True), "cpu": machine["resources"]["cpu"], "memoryBytes": machine["resources"]["memoryMiB"] * 1048576,
                 "diskBytes": machine["resources"]["diskGiB"] * 1073741824}
        return json.loads(self.execute(value))
