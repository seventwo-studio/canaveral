"""Explicit terminal-lease fencing and fresh native observation after reboot.

The original boot binding never changes. New kernel boot IDs are evidence that
old processes cannot survive, not evidence of domain stop or storage erasure.
No saved PID is queried or signalled and no old monotonic deadline is renewed.
"""
from .libvirt_execution import linux_boot_id, publish, read_binding, read_spec, valid_authorization
from .libvirt_supervision import MAX_INTEGER, SupervisorJournal, finite, matches_identity
from .model import Error, digest, identifier


def terminal(machine):
    lease = machine.get('lease', {}); intent = machine.get('leaseCleanup', {})
    if (machine.get('desired') != 'stopped' or lease.get('state') not in ('released', 'expired', 'failed')
            or intent.get('leaseId') != lease.get('id')):
        raise Error('Reboot recovery requires its terminal stopped cleanup intent.', 409)
    return identifier(intent.get('id'))


def _base(machine, journal, binding, spec):
    return {**binding.identity(), 'cleanupId': terminal(machine), 'specDigest': digest(spec),
            'launchDigest': digest(journal.read_named('libvirt-launch.json'))}


def _authority(value, binding):
    return (matches_identity(value, binding.identity()) and
        set(value) == set(binding.identity()) | {'revision', 'deadline', 'fenced'} and
        type(value.get('revision')) is int and 1 <= value['revision'] <= MAX_INTEGER and
        type(value.get('fenced')) is bool and finite(value.get('deadline')))


def _record(value, base):
    if (not matches_identity(value, base) or
            set(value) != set(base) | {'observedHostBootId', 'authorityDigest', 'phase'} or
            value.get('phase') not in ('fenced', 'stopped') or
            identifier(value.get('observedHostBootId')) != value['observedHostBootId'] or
            value['observedHostBootId'] == base['hostBootId'] or
            not isinstance(value.get('authorityDigest'), str) or len(value['authorityDigest']) != 64 or
            any(c not in '0123456789abcdef' for c in value['authorityDigest'])):
        raise Error('Libvirt reboot receipt is missing or belongs to another context.', 409)
    return value


def check_context(machine, journal, binding, spec, observed, stopped=False):
    """Validate a current reboot receipt; caller separately samples kernel ID."""
    observed = identifier(observed)
    record = journal.read_named('libvirt-reboot.json')
    if observed == binding.host_boot_id:
        if record is not None: raise Error('Original kernel boot cannot replace reboot history.', 409)
        return None
    value = _record(record, _base(machine, journal, binding, spec))
    authority = journal.read_named('libvirt-authorization.json')
    if (value['observedHostBootId'] != observed or
            not _authority(authority, binding) or authority['fenced'] is not True or authority['deadline'] != 0 or
            value['authorityDigest'] != digest(authority) or stopped and value['phase'] != 'stopped'):
        raise Error('Current reboot fencing or stop observation is unconfirmed.', 409)
    return value


def _fence_locked(machine, journal, binding, spec, observed, location_matches, host_boot, authorization=None):
    if observed == binding.host_boot_id: raise Error('Reboot fencing requires a different kernel boot.', 409)
    observed = identifier(observed); base = _base(machine, journal, binding, spec)
    previous_execution = journal.read(); launch = journal.read_named('libvirt-launch.json')
    if (not matches_identity(previous_execution, binding.identity()) or previous_execution.get('phase') not in
            ('prepared', 'starting', 'creating', 'resuming', 'running', 'fenced')):
        raise Error('Original libvirt execution history is unknown.', 409)
    if launch is not None and not matches_identity(launch, binding.identity()):
        raise Error('Original libvirt launch history differs.', 409)

    def unchanged():
        if (identifier(host_boot()) != observed or not location_matches(binding, spec) or
                read_binding(journal, machine) != (binding, spec) or journal.read() != previous_execution or
                journal.read_named('libvirt-launch.json') != launch):
            raise Error('Libvirt reboot context changed during fencing.', 409)

    reboot = SupervisorJournal(journal.folder, 'libvirt-reboot')
    authority = None
    try:
        old = reboot.read()
        if old is not None: _record(old, base)
        authority = SupervisorJournal(journal.folder, 'libvirt-authorization')
        previous = authority.read()
        if previous is not None and not _authority(previous, binding):
            raise Error('Original native authorization history is unknown.', 409)
        if authorization is None:
            if previous is None or previous['fenced'] is not True:
                raise Error('Teardown recovery requires an existing terminal fence.', 409)
            revision = previous['revision']
        else:
            value = authorization()
            if not valid_authorization(value, binding.lease_id) or value['fenced'] is not True:
                raise Error('Reboot fencing lacks current terminal authorization.', 409)
            revision = value['revision']
            if previous is not None and revision < previous['revision']:
                raise Error('Reboot authorization revision is older than durable history.', 409)
        result = {**binding.identity(), 'revision': revision, 'deadline': 0, 'fenced': True}
        unchanged()
        # Numerically equal JSON 0.0 and 0 have different digests. Persist the
        # canonical fence before binding its digest into the reboot receipt.
        if previous != result or type(previous['deadline']) is not int: authority.write(result)
        unchanged()
        # Retire an unused preparation before a delayed parent can spawn it.
        # This phase is a fence only; native stop evidence is published later.
        previous_execution = {**binding.identity(), 'phase': 'fenced', 'reason': 'host-reboot-observation-pending'}
        journal.write(previous_execution)
        unchanged()
        record = {**base, 'observedHostBootId': observed, 'authorityDigest': digest(result), 'phase': 'fenced'}
        reboot.write(record); unchanged()
        return record
    finally:
        if authority is not None: authority.close()
        reboot.close()


def fence_cleanup(machine, folder, authorization, location_matches, host_boot=linux_boot_id):
    terminal(machine)
    state = SupervisorJournal(folder, 'libvirt-binding')
    try:
        binding, spec = read_spec(state, machine); observed = identifier(host_boot())
        if observed == binding.host_boot_id:
            check_context(machine, state, binding, spec, observed)
            return publish(machine, folder, authorization, stopping=True, host_boot=host_boot)
    finally: state.close()
    execution = SupervisorJournal(folder)
    try:
        if read_spec(execution, machine) != (binding, spec): raise Error('Reboot storage ownership changed.', 409)
        result = _fence_locked(machine, execution, binding, spec, observed, location_matches, host_boot, authorization)
        if read_spec(execution, machine) != (binding, spec): raise Error('Reboot storage ownership changed.', 409)
        return result
    finally: execution.close()


def mark_stopped(machine, journal, binding, spec, observed, expected, host_boot):
    reboot = SupervisorJournal(journal.folder, 'libvirt-reboot')
    try:
        if reboot.read() != expected or identifier(host_boot()) != observed:
            raise Error('Reboot receipt changed during native stop observation.', 409)
        check_context(machine, journal, binding, spec, observed)
        journal.write({**binding.identity(), 'phase': 'fenced', 'stopEvidence': 'host-reboot',
                       'observedHostBootId': observed})
        result = {**expected, 'phase': 'stopped'}
        reboot.write(result)
        if identifier(host_boot()) != observed: raise Error('Kernel boot changed after stop publication.', 409)
        return result
    finally: reboot.close()


def recover_teardown(machine, journal, binding, spec, proof, location_matches, connection_factory, host_boot):
    """Refresh boot evidence for an already validated durable removal intent."""
    observed = identifier(host_boot())
    if observed == binding.host_boot_id:
        raise Error('Reboot recovery cannot restore the original kernel boot.', 409)
    if (proof.get('executionStopped') is not True or proof.get('id') != terminal(machine) or
            proof.get('specDigest') != digest(spec) or
            proof.get('launchDigest') != digest(journal.read_named('libvirt-launch.json'))):
        raise Error('Reboot recovery lacks the original stopped teardown intent.', 409)
    record = _fence_locked(machine, journal, binding, spec, observed, location_matches, host_boot)
    connection = connection_factory(spec['uri'], binding.machine_id)
    try:
        if proof['state'] == 'planned': connection.validate(binding, active=False)
        elif proof['state'] == 'quarantined':
            if connection.absent() is not True: connection.validate(binding, active=False)
        elif connection.absent() is not True:
            raise Error('A retired libvirt domain reappeared after reboot.', 409)
    finally: connection.close()
    if (identifier(host_boot()) != observed or not location_matches(binding, spec) or
            read_binding(journal, machine) != (binding, spec)):
        raise Error('Libvirt reboot context changed during observation.', 409)
    mark_stopped(machine, journal, binding, spec, observed, record, host_boot)
    return observed
