"""Observe a stopped owned libvirt boot without claiming storage reclamation.

Only a typed record of the original supervisor's exit, or an unused preparation
with no launch intent, permits observation. No recovered PID is signalled. A
native inactive-domain observation never establishes closed storage handles.
"""
from .libvirt_execution import linux_boot_id, read_spec
from .libvirt_supervision import NativeLibvirtConnection, SupervisorJournal, finite, matches_identity
from .model import identifier


def supervisor_gone(binding, launch):
    import psutil
    if (not matches_identity(launch, binding.identity()) or type(launch.get('pid')) is not int
            or launch['pid'] <= 0 or not finite(launch.get('createdAt'))):
        return False
    try:
        # Different birth means the original child is gone; its replacement is
        # never signalled or used as proof that any disk handle is closed.
        return psutil.Process(launch['pid']).create_time() != launch['createdAt']
    except psutil.NoSuchProcess: return True
    except psutil.AccessDenied: return False


def confirm_stopped_locked(machine, journal, location_matches, connection_factory, host_boot):
    """Observe while the caller retains the execution lock across teardown."""
    connection = None
    try:
        from .libvirt_reboot import check_context, mark_stopped
        binding, spec = read_spec(journal, machine)
        observed = identifier(host_boot())
        if not location_matches(binding, spec): return None
        reboot = check_context(machine, journal, binding, spec, observed)
        authority = journal.read_named('libvirt-authorization.json')
        if not matches_identity(authority, binding.identity()) or authority.get('fenced') is not True: return None
        execution = journal.read()
        if not matches_identity(execution, binding.identity()) or execution.get('phase') not in (
                'prepared', 'starting', 'creating', 'resuming', 'running', 'fenced'): return None
        launch = journal.read_named('libvirt-launch.json')
        never_launched = launch is None and (execution['phase'] == 'prepared' or
            execution['phase'] == 'fenced' and execution.get('stopEvidence') == 'never-launched')
        if reboot is None and not never_launched and not supervisor_gone(binding, launch): return None
        connection = connection_factory(spec['uri'], binding.machine_id)
        # Includes exact boot metadata, one owned disk, inactive/SHUTOFF and no
        # managed save, snapshot or checkpoint state. Unknown native replies fail.
        connection.validate(binding, active=False)
        if journal.read_named('libvirt-launch.json') != launch: return None
        if reboot is None and not never_launched and not supervisor_gone(binding, launch): return None
        if identifier(host_boot()) != observed or not location_matches(binding, spec): return None
        if check_context(machine, journal, binding, spec, observed) != reboot: return None
        binding_after, spec_after = read_spec(journal, machine)
        if binding_after != binding or spec_after != spec: return None
        connection.close(); connection = None
        # Retiring an unused prepared record prevents a delayed parent from
        # admitting this boot after the observer releases its lock.
        evidence = 'host-reboot' if reboot is not None else 'never-launched' if never_launched else 'supervisor-exited'
        if reboot is not None: mark_stopped(machine, journal, binding, spec, observed, reboot, host_boot)
        else: journal.write({**binding.identity(), 'phase': 'fenced', 'stopEvidence': evidence})
        return {**binding.identity(), 'executionStopped': True, 'evidence': evidence,
                'observedHostBootId': observed, 'storageHandles': 'unknown', 'storageRemoved': False}
    finally:
        if connection is not None:
            try: connection.close()
            except Exception: pass


def confirm_stopped(machine, folder, location_matches, connection_factory=NativeLibvirtConnection, host_boot=linux_boot_id):
    journal = None
    try:
        journal = SupervisorJournal(folder)
        return confirm_stopped_locked(machine, journal, location_matches, connection_factory, host_boot)
    except Exception:
        return None # Missing/foreign/unreadable history is not stop evidence.
    finally:
        if journal is not None: journal.close()
