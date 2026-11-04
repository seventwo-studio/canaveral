import json
from pathlib import Path
import tempfile
import unittest

from script.publish_release import PACKAGE, SOURCE, bundle, check_identity, draft_release


class ReleaseTests(unittest.TestCase):
    def test_draft_discovery_requires_one_exact_reviewed_target(self):
        release = {"id": 1, "tag_name": "v0.1.1", "draft": True, "target_commitish": "c" * 40}
        self.assertEqual(draft_release([[], [release]], "v0.1.1", "c" * 40), release)
        for pages in [[], [[release, release]], [[dict(release, draft=False)]],
                      [[dict(release, target_commitish="d" * 40)]], [[dict(release, tag_name="v0.1.0")]]]:
            with self.assertRaises(ValueError):
                draft_release(pages, "v0.1.1", "c" * 40)

    def images(self):
        return {"orchestrator": PACKAGE + ":0.1.0@sha256:" + "a" * 64,
                "dashboard": PACKAGE + "-dashboard:0.1.0@sha256:" + "b" * 64,
                "kubevirt": PACKAGE + "-kubevirt:0.1.0@sha256:" + "d" * 64}

    def test_bundle_preserves_optional_stages_and_contains_no_namespace_or_secrets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            metadata = bundle("0.1.0", "c" * 40, self.images(), root)
            self.assertEqual(metadata["images"], self.images())
            self.assertEqual(metadata["source"], SOURCE)
            self.assertEqual({p.name for p in root.iterdir()}, {"orchestrator", "dashboard", "app-release.json"})
            for stage in ("orchestrator", "dashboard"):
                for path in (root / stage).glob("*.json"):
                    value = json.loads(path.read_text())
                    self.assertNotIn("namespace", value["metadata"])
                    self.assertNotIn(value["kind"], ("Secret", "Namespace"))
                    if value["kind"] == "Deployment":
                        pod = value["spec"]["template"]["spec"]
                        self.assertFalse(pod["automountServiceAccountToken"])
                        self.assertEqual(pod["containers"][0]["image"], self.images()[stage])
                        if stage == "dashboard":
                            self.assertFalse(pod.get("volumes"))
                    if value["kind"] == "PersistentVolumeClaim":
                        self.assertEqual(value["metadata"]["annotations"]["kustomize.toolkit.fluxcd.io/prune"], "disabled")

    def test_release_rejects_mutable_or_wrong_version_images_and_nonempty_output(self):
        for images in ({"orchestrator": PACKAGE + ":latest", "dashboard": self.images()["dashboard"]},
                       {**self.images(), "dashboard": PACKAGE + "-dashboard:0.2.0@sha256:" + "b" * 64},
                       {**self.images(), "kubevirt": PACKAGE + "-kubevirt:latest"},
                       {**self.images(), "kubevirt": PACKAGE + "-dashboard:0.1.0@sha256:" + "d" * 64}):
            with tempfile.TemporaryDirectory() as directory:
                with self.assertRaises(ValueError):
                    bundle("0.1.0", "c" * 40, images, Path(directory))
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / "unreviewed").touch()
            with self.assertRaises(ValueError):
                bundle("0.1.0", "c" * 40, self.images(), Path(directory))

    def test_existing_publication_cannot_be_reused_for_different_source(self):
        manifest = {"annotations": {"org.opencontainers.image.source": SOURCE,
                    "org.opencontainers.image.version": "0.1.0", "org.opencontainers.image.revision": "c" * 40},
                    "manifests": [{"platform": {"os": "linux", "architecture": arch}} for arch in ("amd64", "arm64")]}
        check_identity(manifest, "0.1.0", "c" * 40)
        with self.assertRaises(ValueError):
            check_identity(manifest, "0.1.0", "d" * 40)


if __name__ == "__main__":
    unittest.main()
