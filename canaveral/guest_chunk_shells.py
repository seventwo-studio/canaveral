"""Internal native-helper PTY adapter; transport remains provider-owned.

The supplied request callable must authenticate and bind each request to the
owned guest assignment. This adapter selects no connection, enables no image or
lease, and never retries input or opens a replacement process after failure.
"""
import base64
import json
import uuid

from .model import Error

MAX_INTEGER = 2**53-1


class GuestChunkShells:
    def __init__(self, request):
        self.request = request

    def control(self, action, arguments):
        routes = {'shell-open': 'open', 'shell-read': 'read', 'shell-write': 'write',
                  'shell-resize': 'resize', 'shell-close': 'close'}
        if action not in routes or not isinstance(arguments, dict):
            raise Error('Unsupported native guest terminal operation.', 400)
        allowed = {'shell-open': {'session', 'cols', 'rows'}, 'shell-read': {'session', 'offset'},
                   'shell-write': {'session', 'text'}, 'shell-resize': {'session', 'cols', 'rows'},
                   'shell-close': {'session'}}
        if set(arguments)-allowed[action]: raise Error('Invalid guest terminal arguments.', 400)
        try: session = str(uuid.UUID(arguments['session']))
        except (KeyError, ValueError, TypeError, AttributeError):
            raise Error('Guest terminal requires a session UUID.', 400)
        value = {'session': session}
        if action in ('shell-open', 'shell-resize'):
            for key, default in (('cols', 80), ('rows', 24)):
                dimension = arguments.get(key, default) if action == 'shell-open' else arguments.get(key)
                if type(dimension) is not int or not 1 <= dimension <= 500:
                    raise Error('Guest terminal dimensions must be integers from 1 through 500.', 400)
                value[key] = dimension
        elif action == 'shell-write':
            text = arguments.get('text')
            if not isinstance(text, str) or '\0' in text or len(text) > 16000:
                raise Error('Invalid guest terminal text.', 400)
            try: data = text.encode('utf-8')
            except UnicodeEncodeError: raise Error('Invalid guest terminal Unicode.', 400)
            value['text'] = text
        elif action == 'shell-read':
            offset = arguments.get('offset', 0)
            if type(offset) is not int or not 0 <= offset <= MAX_INTEGER:
                raise Error('Invalid guest terminal offset.', 400)
            value['offset'] = offset
        if len(json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8')) > 16384:
            raise Error('Guest terminal input exceeds its bounded control envelope.', 400)
        result = self.request('/v1/shell/' + routes[action], value)
        if not isinstance(result, dict): raise Error('Malformed guest terminal response.', 409)
        if action in ('shell-open', 'shell-read'):
            try: matching = uuid.UUID(result.get('session')) == uuid.UUID(session)
            except (ValueError, TypeError, AttributeError): matching = False
            if not matching: raise Error('Guest terminal response identity differs.', 409)
        if action == 'shell-open': return {'session': session}
        if action == 'shell-close':
            if result.get('closed') is not True: raise Error('Guest terminal cleanup remains unconfirmed.', 409)
            return {'closed': True}
        if action == 'shell-resize':
            if result.get('resized') is not True: raise Error('Guest terminal resize remains unconfirmed.', 409)
            return {'resized': True}
        if action == 'shell-write':
            if type(result.get('written')) is not int or result['written'] != len(data):
                raise Error('Guest terminal input acknowledgement differs; inspect before retrying.', 409)
            return {'written': len(data)}
        encoded = result.get('data')
        try:
            if not isinstance(encoded, str) or len(encoded) > 87384: raise ValueError()
            data = base64.b64decode(encoded, validate=True)
        except (ValueError, TypeError): raise Error('Guest terminal output encoding differs.', 409)
        end, truncated, exited, code = (result.get(key) for key in ('offset', 'truncated', 'exited', 'exitCode'))
        if (type(end) is not int or not value['offset'] <= end <= MAX_INTEGER or len(data) > 65536
                or type(truncated) is not bool or type(exited) is not bool
                or (code is not None and (type(code) is not int or abs(code) > MAX_INTEGER))
                or (not truncated and end-value['offset'] != len(data))
                or (truncated and end-len(data) <= value['offset'])):
            raise Error('Guest terminal output cursor or metadata differs.', 409)
        return {'data': encoded, 'offset': end, 'truncated': truncated, 'exited': exited, 'exitCode': code}
