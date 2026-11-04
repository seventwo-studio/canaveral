import json
import re
import base64
from pathlib import Path

from .base import Provider, run
from ..model import Error


def manifest(machine, image, namespace):
    name = "cvm-" + machine["id"]
    size = machine["resources"]
    identity = machine["id"].replace("-", "")[:10]
    mac = "02:" + ":".join(identity[index:index + 2] for index in range(0, 10, 2))
    devices = {"disks": [{"name": "root", "disk": {"bus": "sata" if image["os"] == "windows" else "virtio"}}],
               "interfaces": [{"name": "default", "masquerade": {}, "macAddress": mac}], "autoattachGraphicsDevice": image["mode"] == "desktop"}
    domain = {"cpu": {"cores": size["cpu"]}, "resources": {"requests": {"cpu": str(size["cpu"]), "memory": str(size["memoryMiB"]) + "Mi"}}, "devices": devices}
    if image["os"] == "windows":
        domain["firmware"] = {"bootloader": {"efi": {"secureBoot": True}}}
        domain["features"] = {"smm": {"enabled": True}}
        devices["tpm"] = {"persistent": True}
    storage = {"accessModes": ["ReadWriteOnce"], "resources": {"requests": {"storage": str(size["diskGiB"]) + "Gi"}}}
    if image.get("storageClass"):
        storage["storageClassName"] = image["storageClass"]
    value = {"apiVersion": "kubevirt.io/v1", "kind": "VirtualMachine", "metadata": {"name": name, "namespace": namespace, "labels": {"canaveral.io/machine": machine["id"]}},
            "spec": {"runStrategy": "Always" if machine["desired"] == "running" else "Halted",
                     "dataVolumeTemplates": [{"metadata": {"name": name}, "spec": {"source": {"pvc": {"namespace": namespace, "name": image["pvc"]}}, "storage": storage}}],
                     "template": {"metadata": {"labels": {"canaveral.io/machine": machine["id"]}}, "spec": {
                         "architecture": image["arch"], "domain": domain, "networks": [{"name": "default", "pod": {}}],
                         "volumes": [{"name": "root", "dataVolume": {"name": name}}]}}}}
    if image.get("_userData"):
        devices["disks"].append({"name": "preparation", "disk": {"bus": "sata" if image["os"] == "windows" else "virtio"}})
        kind = "cloudInitConfigDrive" if image["prepare"]["driver"] == "cloudbase-init" else "cloudInitNoCloud"
        value["spec"]["template"]["spec"]["volumes"].append({"name": "preparation", kind: {"secretRef": {"name": name + "-preparation"}}})
    return value


class KubeVirt(Provider):
    def kubectl(self, *args, data=None, timeout=300):
        base = ["kubectl"]
        if self.config.get("context"):
            base += ["--context", self.config["context"]]
        return run(base + ["--cache-dir", self.state / "kubectl-cache", "--namespace", self.config["namespace"], *args], data=data, timeout=timeout)

    def resource_report(self,assignments=None):
        from ..cluster_resources import collect
        return collect(self,assignments)

    def check(self):
        for value in [self.config.get("namespace", "")] + [t.get("pvc", "") for t in self.config["templates"]]:
            if not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?", value):
                raise Error("KubeVirt requires an existing namespace and template PVC names.")
        for image in self.config["templates"]:
            if image["os"] == "macos":
                raise Error("macOS guests must run on Apple hosts through the Apple backend.")
            self.kubectl("get", "pvc", image["pvc"], "-o", "name")
        self.kubectl("get", "virtualmachines.kubevirt.io", "-o", "name")

    def reconcile(self, machine, image, folder):
        name = self.name(machine)
        raw = self.kubectl("get", "virtualmachine", name, "--ignore-not-found", "-o", "json")
        if not raw:
            if machine["desired"] == "stopped":
                pending=Path(folder)/'kubevirt-create.json';owner=Path(folder)/'kubevirt-owner.json'
                if (pending.exists() or pending.is_symlink()) and not owner.exists():
                    return {'state':'unknown','detail':'KubeVirt creation outcome is unconfirmed; inspect the owned request before recovery.'}
                instance=self.kubectl('get','virtualmachineinstance',name,'--ignore-not-found','-o','json')
                return {'state':'unknown' if instance else 'stopped'}
            from ..kubevirt_ownership import ensure_uncreated
            ensure_uncreated(folder)
            value = manifest(machine, image, self.config["namespace"])
            if image.get("_userData"):
                secret_name = name + "-preparation"
                existing = self.kubectl("get", "secret", secret_name, "--ignore-not-found", "-o", "json")
                payload = {"apiVersion": "v1", "kind": "Secret", "metadata": {"name": secret_name, "namespace": self.config["namespace"], "labels": {"canaveral.io/machine": machine["id"]}},
                           "type": "Opaque", "data": {"userdata": base64.b64encode(image["_userData"].encode()).decode()}}
                if existing:
                    previous = json.loads(existing)
                    if previous.get("metadata", {}).get("labels", {}).get("canaveral.io/machine") != machine["id"] or previous.get("data") != payload["data"]:
                        raise Error("Existing preparation Secret has different ownership/content.")
                else:
                    self.kubectl("create", "-f", "-", data=json.dumps(payload).encode())
            # create never overwrites a resource that appeared concurrently.
            from ..kubevirt_ownership import begin,annotations,remember
            identity=begin(machine,self.config['namespace'],folder)
            value['metadata']['annotations']=annotations(identity)
            created=self.kubectl("create", "-f", "-", "-o", "json", data=json.dumps(value).encode())
            remember(machine,self.config['namespace'],folder,json.loads(created))
            return {"state": "starting", "detail": "Cloning the template PVC and starting the guest."}
        vm = json.loads(raw)
        if vm.get("metadata", {}).get("labels", {}).get("canaveral.io/machine") != machine["id"]:
            raise Error("Existing Kubernetes VM is not owned by this assignment.")
        from ..kubevirt_ownership import verify_existing
        verify_existing(machine,self.config['namespace'],folder,vm)
        strategy = "Always" if machine["desired"] == "running" else "Halted"
        if vm["spec"].get("runStrategy") != strategy:
            self.kubectl("patch", "virtualmachine", name, "--type=merge", "-p", json.dumps({"spec": {"runStrategy": strategy}}))
        instance = self.kubectl("get", "virtualmachineinstance", name, "--ignore-not-found", "-o", "json")
        if machine["desired"] == "stopped":
            return {"state": "stopped" if not instance else "stopping"}
        phase = json.loads(instance).get("status", {}).get("phase") if instance else None
        state = "running" if phase == "Running" else "error" if phase == "Failed" else "starting"
        return {"state": state, "detail": "Use virtctl console/vnc " + name + " -n " + self.config["namespace"]}
