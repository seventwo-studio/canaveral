"""Build per-instance NoCloud/ConfigDrive media using native ISO tools."""
import base64
import json
import os
import platform
import shutil
import tempfile
from pathlib import Path

from .model import Error, digest
from .files import save_json


WINDOWS_ISO = r'''
$ErrorActionPreference = 'Stop'
$p = $env:CANAVERAL_ISO | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
public static class CanaveralISO {
 public static void Write(object source, string path) {
  IStream stream = (IStream)source;
  IntPtr count = Marshal.AllocCoTaskMem(4);
  try {
   byte[] buffer = new byte[65536];
   using (FileStream file = new FileStream(path, FileMode.CreateNew)) {
    while (true) {
     stream.Read(buffer, buffer.Length, count);
     int size = Marshal.ReadInt32(count);
     if (size == 0) break;
     file.Write(buffer, 0, size);
    }
    file.Flush(true);
   }
  } finally { Marshal.FreeCoTaskMem(count); }
 }
}
'@
$image = New-Object -ComObject IMAPI2FS.MsftFileSystemImage
$image.FileSystemsToCreate = 3
$image.VolumeName = $p.label
$image.Root.AddTree($p.directory, $false)
$result = $image.CreateResultImage()
[CanaveralISO]::Write($result.ImageStream, $p.output)
'''


def ensure_seed(image, machine, directory):
    from .providers.base import run
    if not image.get("_userData"):
        return None
    directory = Path(directory)
    target, receipt = directory / "cloud-init.iso", directory / "seed.json"
    fingerprint = digest({"userData": image["_userData"], "id": machine["id"]})
    network=None
    if image.get('cloneIdentity')=='linux-cloud-init':
        mac='02:'+':'.join(machine['id'].replace('-','')[i:i+2] for i in range(0,10,2))
        network={'version':2,'ethernets':{'canaveral':{'match':{'macaddress':mac},'dhcp4':True,'dhcp-identifier':'mac'}}}
        fingerprint=digest({'userData':image['_userData'],'id':machine['id'],'network':network})
    if target.exists():
        if not receipt.exists() or json.loads(receipt.read_text()).get("fingerprint") != fingerprint:
            raise Error("Existing preparation seed does not match this assignment; it was not overwritten.")
        return str(target)
    with tempfile.TemporaryDirectory(prefix="seed-", dir=str(directory)) as temporary:
        content = Path(temporary) / "content"
        content.mkdir()
        windows = image["prepare"]["driver"] == "cloudbase-init"
        label = "CONFIG-2" if windows else "CIDATA"
        if windows:
            leaf = content / "openstack" / "latest"
            leaf.mkdir(parents=True)
            (leaf / "meta_data.json").write_text(json.dumps({"uuid": machine["id"], "hostname": "cvm-" + machine["id"][:8]}))
            (leaf / "user_data").write_text(image["_userData"])
        else:
            (content / "meta-data").write_text(json.dumps({"instance-id": machine["id"], "local-hostname": "cvm-" + machine["id"]}))
            (content / "user-data").write_text(image["_userData"])
            if network:(content/'network-config').write_text(json.dumps(network))
        output = Path(temporary) / "seed.iso"
        if platform.system() == "Darwin":
            run(["hdiutil", "makehybrid", "-iso", "-joliet", "-default-volume-name", label, "-o", output, content])
        elif platform.system() == "Windows":
            env = os.environ.copy()
            env["CANAVERAL_ISO"] = json.dumps({"directory": str(content), "output": str(output), "label": label})
            run(["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", base64.b64encode(WINDOWS_ISO.encode("utf-16le")).decode()], env=env)
        else:
            tool = shutil.which("genisoimage") or shutil.which("mkisofs")
            if not tool:
                raise Error("Guest preparation requires genisoimage/mkisofs on this host.")
            run([tool, "-quiet", "-V", label, "-J", "-r", "-o", output, content])
        if not output.is_file() or output.stat().st_size < 32768:
            raise Error("Preparation seed generation did not produce an ISO image.")
        save_json(receipt, {"fingerprint": fingerprint})
        os.chmod(output, 0o600)
        os.replace(output, target)
    return str(target)
