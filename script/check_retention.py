"""Compare saved reload evidence. Never connects to a service or changes state."""
import argparse
import json
import math
import os
from pathlib import Path
import re
import stat


SCHEMA = 'canaveral-retention-v1'
SECTIONS = ('machineAssignments', 'imageInventory', 'nativeBootReceipts',
            'hostBudgets', 'sharedBudgets', 'reservations', 'configurationHashes')
MAX_BYTES = 8 * 1048576  # Evidence metadata only, not a machine/file-transfer limit.


def unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError('Duplicate evidence field.')
        value[key] = item
    return value


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False)


def resource_shape(value, minimum):
    return (isinstance(value, dict) and set(value) == {'cpu', 'memoryMiB', 'diskGiB'} and
            all(type(amount) is int and amount >= minimum for amount in value.values()))


def validate(value):
    if not isinstance(value, dict) or set(value) != {'schema', 'capturedAt', 'stable', 'observations'}:
        raise ValueError('Incomplete retention evidence.')
    captured = value['capturedAt']
    try:
        valid_time = type(captured) in (int, float) and math.isfinite(captured) and captured > 0
    except OverflowError:
        valid_time = False
    if value['schema'] != SCHEMA or not valid_time:
        raise ValueError('Invalid retention evidence version or capture time.')
    stable = value['stable']
    if not isinstance(stable, dict) or set(stable) != set(SECTIONS):
        raise ValueError('Incomplete stable inventory.')
    for section in SECTIONS:
        items = stable[section]
        if not isinstance(items, dict) or any(not isinstance(key, str) or not key for key in items):
            raise ValueError('Invalid stable inventory.')
        if section != 'sharedBudgets' and not items:
            raise ValueError('Missing retained inventory.')
    for section in ('nativeBootReceipts', 'configurationHashes'):
        if any(not isinstance(digest, str) or not re.fullmatch('[a-f0-9]{64}', digest)
               for digest in stable[section].values()):
            raise ValueError('Missing evidence fingerprints.')
    if not set(stable['nativeBootReceipts']) <= set(stable['machineAssignments']):
        raise ValueError('Native receipt is not assigned to a retained machine.')
    if set(stable['hostBudgets']) != set(stable['reservations']):
        raise ValueError('Host reservation coverage differs from budgets.')
    for section in ('hostBudgets', 'reservations'):
        for resources in stable[section].values():
            if not resource_shape(resources, 1 if section == 'hostBudgets' else 0):
                raise ValueError('Invalid budget or reservation evidence.')
    for assignment in stable['machineAssignments'].values():
        if (not isinstance(assignment, dict) or
                not {'hostId', 'resources', 'template', 'desired'} <= set(assignment) or
                not isinstance(assignment['hostId'], str) or assignment['hostId'] not in stable['hostBudgets'] or
                not resource_shape(assignment['resources'], 1) or assignment['desired'] not in ('running', 'stopped') or
                not isinstance(assignment['template'], dict) or
                any(not isinstance(assignment['template'].get(key), str) or not assignment['template'][key]
                    for key in ('id', 'revision', 'arch'))):
            raise ValueError('Incomplete machine assignment.')
    for image in stable['imageInventory'].values():
        if (not isinstance(image, dict) or any(not isinstance(image.get(key), str) or not image[key]
                for key in ('hostId', 'id', 'revision', 'arch')) or image['hostId'] not in stable['hostBudgets']):
            raise ValueError('Incomplete image inventory.')
    for budget in stable['sharedBudgets'].values():
        if (not isinstance(budget, dict) or not resource_shape(budget.get('capacity'), 1) or
                not isinstance(budget.get('hostIds'), list) or not budget['hostIds'] or
                any(not isinstance(host, str) or host not in stable['hostBudgets'] for host in budget['hostIds']) or
                len(budget['hostIds']) != len(set(budget['hostIds']))):
            raise ValueError('Incomplete shared budget.')
    observations = value['observations']
    if (not isinstance(observations, dict) or set(observations) != {'consumerLeaseIds', 'liveCleanupIntentIds'} or
            any(not isinstance(items, list) or any(not isinstance(item, str) or not item for item in items)
                or len(items) != len(set(items)) for items in observations.values())):
        raise ValueError('Incomplete lease or cleanup observation.')
    canonical(value)  # Refuse nonfinite data anywhere, including caller-created dictionaries.
    return value


def load(path):
    path = Path(path)
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode) or before.st_size > MAX_BYTES:
        raise ValueError('Evidence must be a bounded regular file.')
    signature = lambda info: (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
    descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_NONBLOCK', 0) | getattr(os, 'O_NOFOLLOW', 0) |
                         getattr(os, 'O_BINARY', 0))
    with os.fdopen(descriptor, 'rb') as source:
        if signature(before) != signature(os.fstat(source.fileno())):
            raise ValueError('Evidence changed while opening.')
        data = source.read(MAX_BYTES + 1)
        if (len(data) > MAX_BYTES or signature(before) != signature(os.fstat(source.fileno())) or
                signature(before) != signature(path.lstat())):
            raise ValueError('Evidence changed while reading.')
    return validate(json.loads(data, object_pairs_hook=unique_object))


def compare(before, after):
    validate(before)
    validate(after)
    changed = [section for section in SECTIONS
               if canonical(before['stable'][section]) != canonical(after['stable'][section])]
    reasons = []
    if after['capturedAt'] <= before['capturedAt']:
        reasons.append('after_not_later_than_before')
    if any(snapshot['observations']['consumerLeaseIds'] for snapshot in (before, after)):
        reasons.append('consumer_leases_present')
    if any(snapshot['observations']['liveCleanupIntentIds'] for snapshot in (before, after)):
        reasons.append('live_cleanup_intents_present')
    return {'scope': 'offline-retention-comparison', 'retentionMatches': not changed and not reasons,
            'changedSections': changed, 'reasonCodes': reasons}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('before', help='Saved pre-reload evidence JSON')
    parser.add_argument('after', help='Saved post-reload evidence JSON')
    args = parser.parse_args(argv)
    try:
        result = compare(load(args.before), load(args.after))
    except (OSError, ValueError, TypeError, RecursionError):
        print(json.dumps({'scope': 'offline-retention-comparison', 'retentionMatches': False,
                          'reasonCodes': ['invalid_or_unreadable_evidence']}))
        return 2
    print(json.dumps(result))
    return 0 if result['retentionMatches'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
