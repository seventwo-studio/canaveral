import hashlib
import json
import re
import uuid


class Error(Exception):
    def __init__(self, message, status=409, code=None, request_id=None, retryable=None, outcome=None):
        super().__init__(message)
        self.status = status
        self.code=code or {400:'invalid_request',401:'unauthenticated',403:'forbidden',404:'not_found',409:'conflict',410:'lease_ended',413:'payload_too_large',429:'limit_exceeded',503:'unavailable'}.get(status,'request_failed')
        self.request_id=request_id
        self.retryable=status in (429,503) if retryable is None else retryable
        self.outcome=outcome


def identifier(value):
    try:
        return str(uuid.UUID(value))
    except (ValueError, TypeError, AttributeError):
        raise Error("Expected a UUID.", 400)


def text(value, label, maximum=100):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise Error("Invalid " + label + ".", 400)
    return value


def integer(value, label, maximum=1048576):
    if type(value) is not int or not 1 <= value <= maximum:
        raise Error("Invalid " + label + ".", 400)
    return value


def resources(value):
    if not isinstance(value, dict):
        raise Error("Resources must specify cpu, memoryMiB and diskGiB.", 400)
    return {key: integer(value.get(key), key) for key in ("cpu", "memoryMiB", "diskGiB")}


def template(value):
    if not isinstance(value, dict):
        raise Error("Invalid template.", 400)
    result = {key: text(value.get(key), key) for key in ("id", "revision", "os", "arch", "mode")}
    if 'name' in value:result['name']=text(value['name'],'image name')
    if 'catalogueImageId' in value:
        result['catalogueImageId']=identifier(value['catalogueImageId'])
        if not isinstance(value.get('artifactSha256'),str) or not re.fullmatch('[a-f0-9]{64}',value['artifactSha256']):raise Error('A catalogue image requires its artifact checksum.',400)
        result['artifactSha256']=value['artifactSha256']
    if 'mediaType' in value:
        if value['mediaType'] not in ('disk','installer'):raise Error('Invalid image media type.',400)
        result['mediaType']=value['mediaType']
    if 'cloneIdentity' in value:
        if value['cloneIdentity']!='linux-cloud-init' or result['os']!='linux':raise Error('Unsupported clone identity provisioning.',400)
        result['cloneIdentity']=value['cloneIdentity']
    if 'imageKind' in value:
        if value['imageKind'] not in ('base','derived'):raise Error('Invalid image kind.',400)
        result['imageKind']=value['imageKind']
    if result["os"] not in ("linux", "macos", "windows", "android", "ios") or result["arch"] not in ("arm64", "amd64") or result["mode"] not in ("headless", "desktop", "device"):
        raise Error("Unsupported template operating system, architecture or mode.", 400)
    if (result["os"] in ("android", "ios")) != (result["mode"] == "device"):
        raise Error("Mobile templates require device mode; computer templates require headless or desktop mode.", 400)
    if result["mode"] == "device":
        from .devices import device_definition
        result["device"] = device_definition(value.get("device"), result["os"], result["arch"])
        if value.get("source") or value.get("prepare") or value.get("preparationDriver", "none") != "none":
            raise Error("Mobile devices use installed SDK runtimes, without VM sources or guest preparation.", 400)
    if "guestAccess" in value:
        if value["guestAccess"] is not True or result["os"] != "linux":
            raise Error("Guest access is currently supported for Linux only.", 400)
        result["guestAccess"] = True
    result["minimum"] = resources(value.get("minimum"))
    if 'runtime' in value:
        if value['runtime'] not in ('apple','libvirt','hyperv','android','ios','kubevirt'):raise Error('Unsupported image runtime.',400)
        result['runtime']=value['runtime']
    result["memoryStepMiB"] = integer(value.get("memoryStepMiB", 1), "memory step")
    from .templates import public_fields
    result.update(public_fields(value, result["minimum"], result["os"]))
    if result["defaults"]["memoryMiB"] % result["memoryStepMiB"]:
        raise Error("Default memory must match the template's memory granularity.", 400)
    return result


def offer(value):
    if not isinstance(value, dict):
        raise Error("Invalid host offer.", 400)
    result = {"name": text(value.get("name"), "host name"), "capacity": resources(value.get("capacity"))}
    result["provider"] = text(value.get("provider"), "provider")
    if 'leaseProtocol' in value:
        if type(value['leaseProtocol']) is not int or value['leaseProtocol']!=1:raise Error('Unsupported lease execution protocol.',400)
        result['leaseProtocol']=1
    if result["provider"] not in ("macos","linux","windows","libvirt", "hyperv", "apple", "kubevirt", "native", "android", "ios"):
        raise Error("Unsupported provider.", 400)
    if not isinstance(value.get("templates"), list) or not 0 <= len(value["templates"]) <= 100:
        raise Error("Offer at most 100 installed templates.", 400)
    result["templates"] = [template(t) for t in value["templates"]]
    physical=result['provider'] in ('macos','linux','windows')
    if physical:
        from .runtime_config import enabled_runtimes, runtime_for
        result['runtimes']=sorted(enabled_runtimes(value))
    for image in result["templates"]:
        if physical:
            runtime_for(value,image)
            continue
        mobile = image["os"] in ("android", "ios")
        if (mobile and image["os"] != result["provider"]) or (result["provider"] in ("android", "ios") and not mobile):
            raise Error("Mobile templates require their matching device provider.", 400)
    if len({(t["id"], t["revision"], t["arch"]) for t in result["templates"]}) != len(result["templates"]):
        raise Error("Template ID/revision/architecture combinations must be unique on a host.", 400)
    if 'leaseImages' in value or 'leaseProtocol' in result:
        from .lease_eligibility import normalize_lease_images
        result['leaseImages'] = normalize_lease_images(value.get('leaseImages', []), result)
    if "inference" in value:
        from .inference import inference_offer
        if result["provider"] not in ("native", "apple", "libvirt"):
            raise Error("Embedded inference currently requires a native Mac or Linux host.", 400)
        result["inference"] = inference_offer(value["inference"])
    if result["provider"] == "native" and result["templates"]:
        raise Error("The native inference provider does not offer VMs.", 400)
    return result


def machine_request(value):
    if not isinstance(value, dict):
        raise Error("Invalid machine request.", 400)
    overrides = value.get("resources", {})
    if not isinstance(overrides, dict) or set(overrides) - {"cpu", "memoryMiB", "diskGiB"}:
        raise Error("Invalid resource overrides.", 400)
    result = {"id": identifier(value.get("id")), "name": text(value.get("name"), "machine name"),
              "templateId": text(value.get("templateId"), "template id"), "resources": {k: integer(v, k) for k, v in overrides.items()}}
    if "templateRevision" in value:
        result["templateRevision"] = text(value["templateRevision"], "template revision")
    if value.get("hostId") is not None:
        result["hostId"] = identifier(value["hostId"])
    if value.get("arch") is not None:
        if value["arch"] not in ("arm64", "amd64"):
            raise Error("Invalid architecture.", 400)
        result["arch"] = value["arch"]
    return result


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def secret(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_\-]{43,128}", value):
        raise Error("Use a securely generated token with at least 43 URL-safe characters.", 400)
    return value
