"""Reusable template definitions and checksum-pinned base image preparation."""
import copy
import contextlib
import hashlib
import json
import os
import re
import stat
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path

from .model import Error, digest, resources, integer


def recipe(value, system):
    if value is None:
        return None
    if not isinstance(value, dict) or value.get("driver") not in ("cloud-init", "cloudbase-init", "ssh"):
        raise Error("Preparation driver must be cloud-init, cloudbase-init or ssh.", 400)
    if value["driver"] == "cloud-init" and system != "linux":
        raise Error("cloud-init preparation requires a Linux image.", 400)
    if value["driver"] == "cloudbase-init" and system != "windows":
        raise Error("Cloudbase-Init preparation requires a Windows image.", 400)
    allowed = {"driver", "packages", "files", "commands", "user", "sshAuthorizedKeys", "timeoutSeconds"}
    if set(value) - allowed:
        raise Error("Unknown preparation fields.", 400)
    result = copy.deepcopy(value)
    result["timeoutSeconds"] = integer(value.get("timeoutSeconds", 1800), "preparation timeout", 86400)
    for key in ("packages", "commands", "sshAuthorizedKeys"):
        values = result.setdefault(key, [])
        if not isinstance(values, list) or len(values) > 200 or any(not isinstance(v, str) or not v.strip() or len(v) > 16000 for v in values):
            raise Error("Invalid preparation " + key + ".", 400)
    if result["packages"] and system != "linux":
        raise Error("Use native preparation commands for non-Linux package installation.", 400)
    if any(not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9+_.:@/-]*", p) for p in result["packages"]):
        raise Error("Invalid Linux package name.", 400)
    if result.get("user") is not None:
        if system != "linux" or not re.fullmatch(r"[a-z_][a-z0-9_-]{0,30}", result["user"]):
            raise Error("Automatic user configuration requires a valid Linux username.", 400)
    if result["sshAuthorizedKeys"] and not result.get("user"):
        raise Error("SSH keys require a configured Linux user.", 400)
    files = result.setdefault("files", [])
    if not isinstance(files, list) or len(files) > 100:
        raise Error("Invalid preparation files.", 400)
    for item in files:
        if not isinstance(item, dict) or set(item) - {"path", "content", "mode"}:
            raise Error("Invalid preparation file.", 400)
        path, content = item.get("path"), item.get("content")
        if not isinstance(path, str) or not path or len(path) > 1000 or "\x00" in path or not isinstance(content, str) or len(content) > 65536:
            raise Error("Invalid preparation file path/content.", 400)
        if system != "windows" and not path.startswith("/"):
            raise Error("Guest file paths must be absolute.", 400)
        if system == "windows" and not re.match(r"^[A-Za-z]:[\\/]", path):
            raise Error("Windows guest file paths must be absolute.", 400)
        mode = item.setdefault("mode", "0600")
        if not isinstance(mode, str) or not re.fullmatch(r"0[0-7]{3}", mode):
            raise Error("File mode must use four octal digits.", 400)
    if len(json.dumps(result)) > 200000:
        raise Error("Preparation recipe is too large.", 400)
    return result


def source(value):
    if not isinstance(value, dict) or set(value) - {"url", "path", "sha256", "format"}:
        raise Error("Invalid image source.", 400)
    if ("url" in value) == ("path" in value) or value.get("format") not in ("raw", "qcow2", "vhdx", "ipsw", "iso"):
        raise Error("Image source needs exactly one URL/path and a supported format.", 400)
    if not isinstance(value.get("sha256"), str) or not re.fullmatch(r"[a-f0-9]{64}", value["sha256"]):
        raise Error("Image source requires a SHA-256 checksum.", 400)
    if "url" in value:
        if not isinstance(value["url"], str) or len(value["url"]) > 8000:
            raise Error("Invalid base image URL.", 400)
        parsed = urllib.parse.urlsplit(value["url"])
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
            raise Error("Base image URLs must use HTTPS without embedded credentials.", 400)
    elif not isinstance(value["path"], str) or not Path(value["path"]).is_absolute():
        raise Error("Local base image paths must be absolute.", 400)
    return dict(value)


def public_fields(value, minimum, system):
    defaults = resources(value.get("defaults", minimum))
    if any(defaults[key] < minimum[key] for key in minimum):
        raise Error("Template defaults cannot be smaller than its minimums.", 400)
    result = {"defaults": defaults}
    if "prepare" in value or "source" in value:
        prepared = recipe(value.get("prepare"), system)
        base = source(value["source"]) if "source" in value else None
        artifact = {"sha256": base["sha256"], "format": base["format"]} if base else None
        result["recipeDigest"] = digest({"prepare": prepared, "source": artifact})
        result["preparationDriver"] = prepared["driver"] if prepared else "none"
    elif "recipeDigest" in value:
        if not re.fullmatch(r"[a-f0-9]{64}", value["recipeDigest"]) or value.get("preparationDriver") not in ("none", "cloud-init", "cloudbase-init", "ssh"):
            raise Error("Invalid public template contract.", 400)
        result.update(recipeDigest=value["recipeDigest"], preparationDriver=value["preparationDriver"])
    return result


def load_host(config, directory):
    result = copy.deepcopy(config)
    templates = []
    for entry in result["templates"]:
        if "templateFile" not in entry:
            templates.append(entry)
            continue
        if set(entry) - {"templateFile", "bindings"}:
            raise Error("Template references accept templateFile and backend bindings only.", 400)
        definition = json.loads((Path(directory) / entry["templateFile"]).read_text())
        bindings = entry.get("bindings", {})
        if set(bindings) - {"image", "pvc", "storageClass", "network", "secureBoot", "tpm", "ssh", "macOSRestoreImage", "macOSAuxiliaryStorage", "macOSHardwareModel"}:
            raise Error("Bindings cannot replace the template's recipe or public contract.", 400)
        definition.update(bindings)
        templates.append(definition)
    result["templates"] = templates
    return result


class HTTPSRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, url):
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != "https" or parsed.username or parsed.password:
            raise Error("Base image redirects must stay on HTTPS without credentials.")
        return super().redirect_request(request, fp, code, message, headers, url)


def prepare_image(value, cache):
    # Imported lazily: image definitions also use this module's recipe helpers.
    from .image_library import checksum,artifact_signature
    spec=source(value);cache=Path(cache).resolve()
    cache.mkdir(mode=0o755,parents=True,exist_ok=True)
    target=cache/(spec['sha256']+'.'+spec['format'])
    def verified_existing():
        if checksum(target)!=spec['sha256']:
            raise Error('Cached image checksum failed; the cache entry was not overwritten.')
        return str(target)
    if os.path.lexists(target):return verified_existing()
    fd,temporary=tempfile.mkstemp(dir=str(cache),suffix='.partial')
    try:
        result=hashlib.sha256();copied=0
        with contextlib.ExitStack() as streams:
            output=streams.enter_context(os.fdopen(fd,'wb'))
            if 'url' in spec:
                stream=streams.enter_context(urllib.request.build_opener(HTTPSRedirect).open(spec['url'],timeout=60))
                remaining=None;unchanged=None
            else:
                # Owner-selected source links remain valid bindings. Resolve once
                # and pin that regular file; cache entries themselves cannot link.
                local=Path(spec['path']).resolve(strict=True);before=local.lstat()
                if not stat.S_ISREG(before.st_mode):raise Error('Local base image source must be a regular file.')
                descriptor=os.open(local,os.O_RDONLY|getattr(os,'O_NONBLOCK',0)|getattr(os,'O_NOFOLLOW',0)|getattr(os,'O_BINARY',0))
                stream=streams.enter_context(os.fdopen(descriptor,'rb'))
                def unchanged():
                    if (artifact_signature(before)!=artifact_signature(os.fstat(stream.fileno())) or
                        artifact_signature(before)!=artifact_signature(local.lstat())):
                        raise Error('Local base image source changed during preparation.')
                unchanged();remaining=before.st_size
            while remaining is None or remaining:
                limit=1048576 if remaining is None else min(1048576,remaining)
                chunk=stream.read(limit)
                if not isinstance(chunk,bytes) or len(chunk)>limit:raise Error('Base image source returned an invalid chunk.')
                if not chunk:
                    if remaining is not None:raise Error('Local base image source ended during preparation.')
                    break
                result.update(chunk)
                if chunk.count(0)==len(chunk):output.seek(len(chunk),1)
                else:output.write(chunk)
                copied+=len(chunk)
                if remaining is not None:remaining-=len(chunk)
            if unchanged is not None:unchanged()
            output.truncate(copied)
            output.flush()
            if hasattr(os,'fchmod'):os.fchmod(output.fileno(),0o644)
            else:os.chmod(temporary,0o644)
            os.fsync(output.fileno())
        if result.hexdigest()!=spec['sha256']:
            raise Error('Base image checksum failed; no image was published to the cache.')
        try:
            os.link(temporary,target)
        except FileExistsError:
            return verified_existing() # A competing publisher keeps its inode.
        except OSError as error:
            raise Error('Base image cache publication was not confirmed; inspect the cache before retrying.',409,
                        code='image_cache_publication_uncertain',retryable=False,outcome='unknown') from error
        if os.name!='nt':
            try:
                directory=os.open(cache,os.O_RDONLY|os.O_DIRECTORY)
                try:os.fsync(directory)
                finally:os.close(directory)
            except OSError as error:
                raise Error('Base image cache publication was not confirmed; inspect the cache before retrying.',409,
                            code='image_cache_publication_uncertain',retryable=False,outcome='unknown') from error
        return str(target)
    finally:
        try:os.unlink(temporary)
        except FileNotFoundError:pass
