from ..model import Error


def provider_for(config, state):
    if config.get('provider') in ('macos','linux','windows'):
        from .machine import Machine
        return Machine(config,state)
    from .apple import Apple
    from .hyperv import HyperV
    from .kubevirt import KubeVirt
    from .libvirt import Libvirt
    from .native import Native
    from .android import Android
    from .ios import IOS
    choices = {"apple": Apple, "hyperv": HyperV, "kubevirt": KubeVirt, "libvirt": Libvirt, "native": Native,
               "android": Android, "ios": IOS}
    if config.get("provider") not in choices:
        raise Error("Unknown host provider.")
    return choices[config["provider"]](config, state)
