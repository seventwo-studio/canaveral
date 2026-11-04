"""Read-only observation of assigned native VM processes; never adopt or signal."""
import json
import math
import os
import platform
import stat
from pathlib import Path

from .model import Error,digest,identifier


def record(path):
    descriptor=os.open(path,os.O_RDONLY|getattr(os,'O_NOFOLLOW',0)|getattr(os,'O_NONBLOCK',0))
    try:
        info=os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_size>65536:raise Error('Runtime observation metadata is unavailable.')
        with os.fdopen(descriptor,'rb',closefd=False) as source:raw=source.read(65537)
        if len(raw)>65536:raise Error('Runtime observation metadata is unavailable.')
        value=json.loads(raw)
        if not isinstance(value,dict):raise Error('Runtime observation metadata is unavailable.')
        return value
    finally:os.close(descriptor)


def apple_processes(provider,machine,folder,psutil):
    """Return verified process objects/birth times, without touching runtime locks."""
    machine_id=identifier(machine['id'])
    storage=Path(provider.config['storage']).resolve()/machine_id;native=storage/machine_id.upper()
    if any(path.is_symlink() for path in (storage,native,Path(folder))):raise Error('Runtime observation ownership is unavailable.')
    expected=digest({key:machine[key] for key in ('id','template','resources')})
    for path in (Path(folder)/'assignment.json',storage/'canaveral-owner.json'):
        if record(path).get('fingerprint')!=expected:raise Error('Runtime observation ownership is unavailable.')
    definition=record(native/'machine.json')
    if identifier(definition.get('id'))!=machine_id:raise Error('Runtime observation identity is unavailable.')
    native_lease=definition.get('executionLeaseID');lease=machine.get('lease',{}).get('id')
    if (native_lease is None)!=(lease is None) or native_lease is not None and identifier(native_lease)!=identifier(lease):
        raise Error('Runtime observation lease identity is unavailable.')
    launch=record(native/'runner-launch.json');status=record(native/'status.json')
    pid,boot,updated=status.get('pid'),launch.get('attemptedAt'),status.get('updatedAt')
    if type(pid) is not int or pid<=0 or any(type(n) not in (int,float) or not math.isfinite(n) for n in (boot,updated)):
        raise Error('Runtime observation process identity is unavailable.')
    if updated+978307200<boot-1:raise Error('Runtime observation belongs to an earlier boot.')
    try:
        process=psutil.Process(pid);born=process.create_time()
        if (not boot-1<=born<=boot+10 or process.uids().real!=os.getuid() or
            Path(process.exe()).resolve()!=Path(provider.config['runner']).resolve() or
            process.cmdline()[1:]!=['run',str(native)]):
            raise Error('Runtime observation process identity is unavailable.')
        if psutil.Process(pid).create_time()!=born:raise Error('Runtime observation process identity changed.')
    except psutil.NoSuchProcess:return []
    return [(process,born,'virtualMachines')]


def child_birth(process, started):
    """Record only our unreaped child, never discover a launch by process name."""
    from .process_groups import unreaped_child
    try:
        if process.poll() is not None or not unreaped_child(process.pid):return None
        import psutil
        child=psutil.Process(process.pid);born=child.create_time()
        if (type(born) not in (int,float) or not math.isfinite(born)
                or not started-1<=born<=started+10 or child.uids().real!=os.getuid()
                or psutil.Process(process.pid).create_time()!=born):return None
        return born
    except Exception:
        # Telemetry failure cannot turn a successful spawn into a retry.
        return None


def android_executables(provider, image):
    sdk=Path(provider.config['androidSDK']).resolve()
    system={'Darwin':'darwin','Linux':'linux'}.get(platform.system())
    host={'arm64':'aarch64','aarch64':'aarch64','x86_64':'x86_64','amd64':'x86_64'}.get(platform.machine().lower())
    guest={'arm64':'aarch64','amd64':'x86_64'}.get(image.get('arch'))
    if not system or not host or not guest:raise Error('Android runtime observation platform is unavailable.')
    launcher=Path(provider.tool('emulator')).resolve()
    base=sdk/'emulator'/'qemu'/(system+'-'+host)/('qemu-system-'+guest)
    candidates={launcher,base.resolve(),Path(str(base)+'-headless').resolve()}
    if any(not path.is_relative_to(sdk) for path in candidates):
        raise Error('Android runtime observation executable is outside its configured SDK.')
    return candidates


def android_processes(provider, machine, image, folder, psutil):
    """Observe a pinned launch and its descendants without ADB, adoption or writes."""
    machine_id=identifier(machine['id']);storage=Path(provider.config['storage']).resolve()/machine_id
    if storage.is_symlink() or Path(folder).is_symlink():raise Error('Android observation ownership is unavailable.')
    expected=digest({key:machine[key] for key in ('id','template','resources')})
    for path in (Path(folder)/'assignment.json',storage/'canaveral-owner.json'):
        if record(path).get('fingerprint')!=expected:raise Error('Android observation ownership is unavailable.')
    launch_path=storage/'launch.json'
    if not launch_path.exists() and not launch_path.is_symlink() and machine.get('observed')=='stopped':return []
    launch=record(launch_path)
    required={'version','bootId','machineId','leaseId','fingerprint','argv','startedAt','pid','processStartedAt'}
    if set(launch)!=required or type(launch['version']) is not int or launch['version']!=2:
        raise Error('Android launch has no complete pinned process identity.')
    identifier(launch['bootId'])
    if launch['machineId']!=machine_id or launch['fingerprint']!=expected or launch['leaseId']!=machine.get('lease',{}).get('id'):
        raise Error('Android launch belongs to another assignment or lease.')
    pid,started,born=launch['pid'],launch['startedAt'],launch['processStartedAt']
    if (type(pid) is not int or pid<=1 or any(type(n) not in (int,float) or not math.isfinite(n) or n<=0 for n in (started,born))
            or not started-1<=born<=started+10):raise Error('Android launch process identity is unavailable.')
    if record(storage/'avd-created.json').get('name')!=provider.name(machine):raise Error('Android AVD identity is unavailable.')
    port=record(storage/'endpoint.json').get('port')
    if type(port) is not int or port%2 or not 5554<=port<5682:raise Error('Android endpoint identity is unavailable.')
    argv=provider.launch_arguments(machine,port)
    if launch['argv']!=argv:raise Error('Android launch arguments no longer match its assignment.')
    executables=android_executables(provider,image)
    try:
        process=psutil.Process(pid)
    except psutil.NoSuchProcess:
        if machine.get('observed')=='stopped':return []
        raise Error('Android runtime process disappeared before observation.')
    try:
        executable=Path(process.exe()).resolve();arguments=process.cmdline()
        if (process.create_time()!=born or process.uids().real!=os.getuid() or executable not in executables
                or not arguments or Path(arguments[0]).resolve()!=executable or arguments[1:]!=argv[1:]):
            raise Error('Android observation process identity differs from its launch.')
        children=process.children(recursive=True)
        result=[(process,born,'simulators')]
        for child in children:
            child_born=child.create_time()
            if (type(child_born) not in (int,float) or not math.isfinite(child_born) or child_born<born
                    or child.uids().real!=os.getuid() or psutil.Process(child.pid).create_time()!=child_born):
                raise Error('Android descendant identity is unavailable.')
            result.append((child,child_born,'simulators'))
        if psutil.Process(pid).create_time()!=born:raise Error('Android process identity changed during observation.')
    except psutil.NoSuchProcess:
        raise Error('Android runtime or descendant disappeared during observation.')
    return result
