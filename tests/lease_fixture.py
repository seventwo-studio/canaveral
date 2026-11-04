"""Explicit fake-runner declarations. Never used to configure a live Agent."""
import copy
from canaveral.model import offer


def lease_offer(value):
    result = copy.deepcopy(value)
    if result['provider'] in ('macos', 'linux', 'windows'):
        raise ValueError('Mixed-host fixtures must specify eligible runtime/image identities explicitly.')
    result['leaseProtocol'] = 1
    result['leaseImages'] = [{**{key: image[key] for key in ('id', 'revision', 'arch')},
                             'runtime': result['provider']} for image in result['templates']]
    return offer(result)
