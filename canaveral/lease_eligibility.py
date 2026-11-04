"""Explicit runtime/image lease support, separate from installed inventory.

Declarations are runner contracts, not native-acceptance certificates. Ordinary
runners remain gated until execution fencing and owned cleanup are proven.
"""
from .model import Error, text


PHYSICAL_HOSTS = ('macos', 'linux', 'windows')
RUNTIMES = ('apple', 'libvirt', 'hyperv', 'kubevirt', 'android', 'ios')


def image_runtime(host, image):
    if host['provider'] in PHYSICAL_HOSTS:
        from .runtime_config import runtime_for
        return runtime_for(host, image)
    runtime = host['provider']
    if runtime not in RUNTIMES or image.get('runtime', runtime) != runtime:
        raise Error('Lease image runtime differs from its host adapter.', 400)
    return runtime


def image_reference(host, image):
    return {**{key: image[key] for key in ('id', 'revision', 'arch')},
            'runtime': image_runtime(host, image)}


def normalize_lease_images(value, host):
    if not isinstance(value, list) or len(value) > 100:
        raise Error('Lease images must explicitly list at most 100 installed image/runtime identities.', 400)
    installed = {(image['id'], image['revision'], image['arch']): image for image in host['templates']}
    result = []
    seen = set()
    for item in value:
        if not isinstance(item, dict) or set(item) != {'id', 'revision', 'arch', 'runtime'}:
            raise Error('Lease images must pin id, revision, architecture and runtime.', 400)
        entry = {key: text(item[key], 'lease image '+key) for key in ('id', 'revision', 'arch', 'runtime')}
        key = tuple(entry[field] for field in ('id', 'revision', 'arch'))
        image = installed.get(key)
        if key in seen or image is None or entry != image_reference(host, image):
            raise Error('Lease image must uniquely match an installed image and its configured runtime.', 400)
        seen.add(key)
        result.append(entry)
    return sorted(result, key=lambda entry: tuple(entry[key] for key in ('id', 'revision', 'arch', 'runtime')))


def lease_eligible(host, image):
    """Fail closed for legacy host-wide declarations and stale pinned images."""
    if not isinstance(host, dict) or not isinstance(image, dict):
        return False
    if type(host.get('leaseProtocol')) is not int or host['leaseProtocol'] != 1:
        return False
    if image not in host.get('templates', []):
        return False
    try:
        reference = image_reference(host, image)
    except (Error, KeyError, TypeError):
        return False
    return isinstance(host.get('leaseImages'), list) and reference in host['leaseImages']
