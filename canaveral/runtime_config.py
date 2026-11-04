"""Physical host platforms and the execution runtimes they can enable."""
from .model import Error

HOST_RUNTIMES={'macos':('apple','android','ios'),'linux':('libvirt','android'),'windows':('hyperv',)}


def enabled_runtimes(config):
    platform=config['provider']
    runtimes=config.get('runtimes')
    if isinstance(runtimes,list):
        if any(not isinstance(name,str) for name in runtimes) or len(runtimes)!=len(set(runtimes)):
            raise Error('Invalid runtime catalogue.',400)
        runtimes={name:{} for name in runtimes}
    if platform not in HOST_RUNTIMES or not isinstance(runtimes,dict) or not runtimes:
        raise Error('A physical host requires at least one configured runtime.',400)
    if any(name not in HOST_RUNTIMES[platform] or not isinstance(options,dict) for name,options in runtimes.items()):
        raise Error('A runtime is incompatible with this host operating system.',400)
    return runtimes


def runtime_for(config,image):
    runtimes=enabled_runtimes(config)
    name=image.get('runtime')
    if name is None:
        name=image['os'] if image['os'] in ('android','ios') else next((key for key in runtimes if key in ('apple','libvirt','hyperv')),None)
    if name not in runtimes:
        raise Error('This image requires a runtime that is not enabled on the host.',400)
    systems={'apple':('linux','macos'),'libvirt':('linux','windows'),'hyperv':('linux','windows'),'android':('android',),'ios':('ios',)}
    if image['os'] not in systems[name]:raise Error('Image operating system is incompatible with its runtime.',400)
    return name
