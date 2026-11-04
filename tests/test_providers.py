import copy
import json
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path
from unittest.mock import patch

from canaveral.model import Error
from canaveral.providers.kubevirt import KubeVirt, manifest
from canaveral.providers.libvirt import Libvirt, domain_xml
from test_orchestration import image, request


class ProviderTests(unittest.TestCase):
    def machine(self):
        return {**request(), "template": image(), "desired": "running"}

    def test_desktop_and_serial_guests_get_distinct_devices_and_xml_escapes_paths(self):
        vm = self.machine()
        path = '/var/disks/a&b/disk.qcow2'
        headless = ET.fromstring(domain_xml(vm, image(), path))
        self.assertIsNone(headless.find("devices/graphics"))
        self.assertIsNotNone(headless.find("devices/console"))
        self.assertEqual(headless.find("devices/disk/source").get("file"), path)
        desktop = ET.fromstring(domain_xml(vm, image("desktop"), path))
        self.assertEqual(desktop.find("devices/graphics").get("listen"), "127.0.0.1")
        self.assertEqual(desktop.find("uuid").text, vm["id"])

    def test_kubevirt_clones_each_root_disk_and_tracks_desired_state(self):
        vm = self.machine()
        template = {**image(), "pvc": "base-image"}
        definition = manifest(vm, template, "guests")
        spec = definition["spec"]
        self.assertEqual(spec["dataVolumeTemplates"][0]["spec"]["source"]["pvc"], {"namespace": "guests", "name": "base-image"})
        self.assertEqual(spec["runStrategy"], "Always")
        interface = spec["template"]["spec"]["domain"]["devices"]["interfaces"][0]
        self.assertRegex(interface["macAddress"], r"^02(?::[0-9a-f]{2}){5}$")
        self.assertFalse(spec["template"]["spec"]["domain"]["devices"]["autoattachGraphicsDevice"])
        vm["desired"] = "stopped"
        self.assertEqual(manifest(vm, template, "guests")["spec"]["runStrategy"], "Halted")
        restarted = manifest(vm, template, "guests")["spec"]["template"]["spec"]["domain"]["devices"]["interfaces"][0]
        self.assertEqual(restarted["macAddress"], interface["macAddress"])

    def test_kubevirt_adopts_only_owned_resources_and_reports_stop_after_vmi_disappears(self):
        provider = KubeVirt({"namespace": "guests"}, Path("/tmp"))
        vm = self.machine()
        existing = manifest(vm, {**image(), "pvc": "base"}, "guests")
        with patch.object(provider, "kubectl", return_value=json.dumps(existing)) as command:
            hostile = copy.deepcopy(existing)
            hostile["metadata"]["labels"] = {}
            command.return_value = json.dumps(hostile)
            with self.assertRaises(Error):
                provider.reconcile(vm, image(), Path("/tmp"))
        vm["desired"] = "stopped"
        with tempfile.TemporaryDirectory() as directory, patch.object(provider, "kubectl", side_effect=[json.dumps(existing), "", ""]):
            self.assertEqual(provider.reconcile(vm, image(), Path(directory))["state"], "stopped")

    def test_libvirt_refuses_foreign_domain_instead_of_starting_it(self):
        provider = Libvirt({}, Path("/tmp"))
        vm = self.machine()
        with patch.object(provider, "virsh", side_effect=[provider.name(vm), "different-domain-uuid"]) as command:
            with self.assertRaises(Error):
                provider.reconcile(vm, image(), Path("/tmp"))
            self.assertEqual(command.call_count, 2)

    def test_partial_disk_is_preserved_for_review_instead_of_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            provider = Libvirt({"storage": directory}, Path(directory))
            vm = self.machine()
            disk = provider.storage(vm) / "disk.qcow2"
            disk.write_bytes(b"previous incomplete creation")
            with patch.object(provider, "virsh", return_value=""):
                with self.assertRaises(Error):
                    provider.reconcile(vm, image(), Path(directory))
            self.assertEqual(disk.read_bytes(), b"previous incomplete creation")


if __name__ == "__main__":
    unittest.main()
