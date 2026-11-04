"""Publish reviewed images and a portable, immutable Flux bundle to GHCR."""

import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
SOURCE = "https://github.com/example/canaveral-public"
PACKAGE = "ghcr.io/example/canaveral-public"
DIGEST = r"sha256:[a-f0-9]{64}"
IMAGES = {"orchestrator": PACKAGE, "dashboard": PACKAGE + "-dashboard",
          "kubevirt": PACKAGE + "-kubevirt"}


def run(argv):
    subprocess.run(argv, cwd=ROOT, check=True)


class Registry:
    def __init__(self, package):
        self.package = package.removeprefix("ghcr.io/")
        basic = base64.b64encode((os.environ["GITHUB_ACTOR"] + ":" + os.environ["GITHUB_TOKEN"]).encode()).decode()
        body, _ = self.get("https://ghcr.io/token?service=ghcr.io&scope=repository:" + self.package + ":pull", "Basic " + basic)
        self.authorization = "Bearer " + json.loads(body)["token"]

    @staticmethod
    def get(url, auth):
        request = urllib.request.Request(url, headers={"Authorization": auth,
            "Accept": "application/vnd.oci.image.index.v1+json,application/vnd.oci.image.manifest.v1+json",
            "User-Agent": "canaveral-release"})
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read(2 * 1048576 + 1)
            if len(raw) > 2 * 1048576:
                raise ValueError("Oversized registry manifest")
            return raw, response.headers

    def manifest(self, tag):
        try:
            raw, headers = self.get("https://ghcr.io/v2/" + self.package + "/manifests/" + tag, self.authorization)
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return None
            raise
        digest = "sha256:" + hashlib.sha256(raw).hexdigest()
        if headers.get("Docker-Content-Digest") != digest:
            raise ValueError("Registry manifest digest differs")
        return json.loads(raw), digest


def check_identity(manifest, version, revision, artifact=False):
    labels = manifest.get("annotations", {})
    expected = {"org.opencontainers.image.source": SOURCE,
                "org.opencontainers.image.version": version,
                "org.opencontainers.image.revision": revision}
    if any(labels.get(key) != value for key, value in expected.items()):
        raise ValueError("Published version belongs to different source; refusing to overwrite")
    if artifact:
        if [layer.get("mediaType") for layer in manifest.get("layers", [])] != ["application/vnd.cncf.flux.content.v1.tar+gzip"]:
            raise ValueError("A single Flux content layer is required")
    else:
        platforms = {(entry.get("platform", {}).get("os"), entry.get("platform", {}).get("architecture"))
                     for entry in manifest.get("manifests", [])}
        if not {("linux", "amd64"), ("linux", "arm64")}.issubset(platforms):
            raise ValueError("Both Linux architectures must be published")


def bundle(version, revision, images, output):
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version) or not re.fullmatch(r"[a-f0-9]{40}", revision):
        raise ValueError("Semantic version and full source revision required")
    if set(images) != set(IMAGES):
        raise ValueError("Controller, dashboard and KubeVirt worker images are required")
    for stage, package in IMAGES.items():
        if not re.fullmatch(re.escape(package + ":" + version + "@") + DIGEST, images[stage]):
            raise ValueError("Images must pin their own version and digest")
    if output.exists() and any(output.iterdir()):
        raise ValueError("Release output must be empty")
    output.mkdir(parents=True, exist_ok=True)
    for stage in ("orchestrator", "dashboard"):
        image = images[stage]
        directory = output / stage
        directory.mkdir()
        source = ROOT / "deploy" / stage
        expected = {"deployment.json", "service.json", "kustomization.yaml"}
        if stage == "orchestrator":
            expected.add("persistentvolumeclaim.json")
        if {path.name for path in source.iterdir()} != expected or any(path.is_symlink() for path in source.iterdir()):
            raise ValueError("Only declared deployment sources may enter the artifact")
        for name in sorted(expected):
            text = (source / name).read_text()
            if name == "deployment.json":
                data = json.loads(text)
                containers = data["spec"]["template"]["spec"]["containers"]
                if len(containers) != 1:
                    raise ValueError("Expected one runtime per stage")
                containers[0]["image"] = image
                data["spec"]["template"]["metadata"].setdefault("labels", {})["app.kubernetes.io/version"] = version
                text = json.dumps(data, indent=2) + "\n"
            (directory / name).write_text(text)
    result = {"schemaVersion": 1, "version": version, "source": SOURCE, "revision": revision, "images": images}
    (output / "app-release.json").write_text(json.dumps(result, indent=2) + "\n")
    return result


def draft_release(pages, tag, revision):
    # GitHub's releases-by-tag endpoint excludes drafts, even for their owner.
    matches = [release for page in pages for release in page if release.get("tag_name") == tag]
    if (len(matches) != 1 or not matches[0].get("draft")
            or matches[0].get("target_commitish") != revision):
        raise ValueError("One unfinished draft targeting the exact source commit is required")
    return matches[0]


def main():
    tag = os.environ["RELEASE_TAG"]
    if not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+", tag):
        raise ValueError("Stable release tag required")
    version = tag[1:]
    configured = re.search(r'^version = "([^"]+)"$', (ROOT / "pyproject.toml").read_text(), re.MULTILINE)
    if configured is None or configured[1] != version:
        raise ValueError("Release tag differs from the package version")
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    # Tags must identify a reviewed commit that has reached main.
    run(["git", "merge-base", "--is-ancestor", revision, "origin/main"])
    if subprocess.check_output(["git", "rev-parse", tag + "^{commit}"], cwd=ROOT, text=True).strip() != revision:
        raise ValueError("Checked-out release identity differs")
    pages = json.loads(subprocess.check_output(["gh", "api", "--paginate", "--slurp",
        "repos/example/canaveral-public/releases?per_page=100"], text=True))
    draft_release(pages, tag, revision)
    dist = ROOT / "dist"
    dist.mkdir(exist_ok=True)
    images = {}
    for stage, package in IMAGES.items():
        registry = Registry(package)
        found = registry.manifest(version)
        if found is None:
            run(["docker", "buildx", "build", ".", "--target", stage, "--platform", "linux/amd64,linux/arm64",
                 "--push", "--tag", package + ":" + version,
                 "--label", "org.opencontainers.image.source=" + SOURCE,
                 "--label", "org.opencontainers.image.version=" + version,
                 "--label", "org.opencontainers.image.revision=" + revision,
                 "--annotation", "index:org.opencontainers.image.source=" + SOURCE,
                 "--annotation", "index:org.opencontainers.image.version=" + version,
                 "--annotation", "index:org.opencontainers.image.revision=" + revision])
            registry = Registry(package)
            found = registry.manifest(version)
        if found is None:
            raise ValueError("Image publication did not complete")
        check_identity(found[0], version, revision)
        images[stage] = package + ":" + version + "@" + found[1]
    with tempfile.TemporaryDirectory(prefix="canaveral-release-") as temporary:
        output = Path(temporary) / "bundle"
        result = bundle(version, revision, images, output)
        for stage in ("orchestrator", "dashboard"):
            run(["kubectl", "kustomize", str(output / stage)])
        registry = Registry(PACKAGE)
        artifact = registry.manifest("deploy-" + version)
        source_revision = tag + "@sha1:" + revision
        if artifact is None:
            run(["flux", "push", "artifact", "oci://" + PACKAGE + ":deploy-" + version,
                 "--path", str(output), "--source", SOURCE, "--revision", source_revision, "--reproducible",
                 "--annotations", "org.opencontainers.image.version=" + version])
            artifact = registry.manifest("deploy-" + version)
        if artifact is None:
            raise ValueError("Deployment publication did not complete")
        check_identity(artifact[0], version, source_revision, artifact=True)
        result["deployment"] = {"url": "oci://" + PACKAGE, "tag": "deploy-" + version, "digest": artifact[1]}
        metadata = dist / "release.json"
        metadata.write_text(json.dumps(result, indent=2) + "\n")
    run(["gh", "release", "upload", tag, str(metadata), "--clobber"])
    run(["gh", "release", "edit", tag, "--draft=false"])
    print("Published Canaveral " + version + " at " + revision)


if __name__ == "__main__":
    main()
