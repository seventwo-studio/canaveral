"""Windows held-input state; ownership, frame freshness and storage are external.

The persistence callback must acknowledge a durable assignment-scoped record.
This module chooses no journal path or credentials and enables no guest service.
"""
import copy
import json
import threading

from canaveral.model import Error
from .windows_desktop import key_input, mouse_input, pointer_input

MODIFIERS = {0xffe1: 1, 0xffe2: 1, 0xffe3: 2, 0xffe4: 2,
    0xffe9: 4, 0xffea: 20, 0xffe7: 8, 0xffe8: 8, 0xffeb: 8, 0xffec: 8}
BUTTONS = ((1, 2, 4, 0), (2, 0x20, 0x40, 0), (4, 8, 0x10, 0), (128, 0x80, 0x100, 1))
MAX_KEYS, MAX_TRANSIENT, MAX_RECORD = 256, 2048, 65536


def _neutral():
    return {'version': 1, 'blocked': False, 'keys': [], 'buttons': 0, 'transient': []}


def _code(value):
    if not isinstance(value, list) or len(value) != 3:
        raise Error('Malformed held Windows key descriptor.', 400)
    event = key_input(*value)
    if event.key.flags & 2: raise Error('Held keys require down descriptors.', 400)
    return list(value)


def _codes(value):
    if not isinstance(value, list) or not 1 <= len(value) <= 2:
        raise Error('Malformed Windows key resolution.', 400)
    result = [_code(code) for code in value]
    if len(result) == 2:
        if not (all(code[0] == 0 and code[2] == 4 for code in result)
                and 0xD800 <= result[0][1] <= 0xDBFF and 0xDC00 <= result[1][1] <= 0xDFFF):
            raise Error('A composite Windows key must be one Unicode scalar.', 400)
    elif result[0][2] == 4 and 0xD800 <= result[0][1] <= 0xDFFF:
        raise Error('A held Unicode surrogate must retain its pair.', 400)
    return result


def validate_state(value):
    if (not isinstance(value, dict) or set(value) != {'version', 'blocked', 'keys', 'buttons', 'transient'}
            or type(value['version']) is not int or value['version'] != 1 or type(value['blocked']) is not bool
            or not isinstance(value['keys'], list) or len(value['keys']) > MAX_KEYS
            or type(value['buttons']) is not int or value['buttons'] & ~0x87
            or not isinstance(value['transient'], list) or len(value['transient']) > MAX_TRANSIENT):
        raise Error('Invalid Windows held-input record.', 400)
    seen, native = set(), set()
    result = _neutral()
    result.update(blocked=value['blocked'], buttons=value['buttons'])
    for key in value['keys']:
        if (not isinstance(key, dict) or set(key) != {'keysym', 'codes'} or type(key['keysym']) is not int
                or not 0 <= key['keysym'] <= 0xFFFFFFFF or key['keysym'] in seen):
            raise Error('Duplicate or invalid held Windows keysym.', 400)
        codes = _codes(key['codes'])
        if key['keysym'] in MODIFIERS and any(code[2] == 4 for code in codes):
            raise Error('A Windows modifier cannot be a Unicode packet.', 400)
        if any(tuple(code) in native for code in codes):
            raise Error('Different keysyms cannot own the same native key.', 400)
        seen.add(key['keysym'])
        native.update(tuple(code) for code in codes)
        result['keys'].append({'keysym': key['keysym'], 'codes': codes})
    result['keys'].sort(key=lambda key: key['keysym'])
    transient = set()
    for raw in value['transient']:
        code = _code(raw)
        if code[2] != 4 or tuple(code) in transient:
            raise Error('Invalid transient Unicode release record.', 400)
        transient.add(tuple(code))
        result['transient'].append(code)
    if result['transient'] and (not result['blocked'] or result['keys'] or result['buttons']):
        raise Error('Transient Windows text recovery requires an otherwise neutral blocked state.', 400)
    try: size = len(json.dumps(result, allow_nan=False, separators=(',', ':')).encode('utf-8'))
    except (ValueError, TypeError, UnicodeError, RecursionError):
        raise Error('Windows held-input record is not encodable.', 400) from None
    if size > MAX_RECORD: raise Error('Windows held-input record exceeds its metadata envelope.', 400)
    return result


class WindowsHeldInput:
    def __init__(self, backend, resolve, save, authorized, cleanup_authorized=None, *, recovered=None):
        if (not callable(getattr(backend, 'post', None)) or not all(callable(v) for v in (resolve, save, authorized))
                or cleanup_authorized is not None and not callable(cleanup_authorized)):
            raise Error('Held input requires a backend, resolver, persistence and authorization.', 400)
        self.backend, self.resolve, self.save, self.authorized = backend, resolve, save, authorized
        self.cleanup_authorized = authorized if cleanup_authorized is None else cleanup_authorized
        self._state = validate_state(_neutral() if recovered is None else recovered)
        if recovered is not None: self._state['blocked'] = True
        self.lock, self.revoked = threading.Lock(), False

    @property
    def state(self): return copy.deepcopy(self._state)

    @property
    def modifiers(self):
        result = 0
        for key in self._state['keys']: result |= MODIFIERS.get(key['keysym'], 0)
        return result

    @staticmethod
    def _allowed(predicate):
        try: return bool(predicate())
        except Exception: return False

    def _authorize(self, cleanup=False):
        active = self._allowed(self.authorized)
        if not active: self.revoked = True
        if (not cleanup and (self.revoked or self._state['blocked'])
                or not (self._allowed(self.cleanup_authorized) if cleanup else active)):
            raise Error('Windows held input ended or requires explicit reset.', 410 if self.revoked and not cleanup else 409,
                        code='input_reset_uncertain', retryable=False)

    def _persist(self, state):
        value = validate_state(state)
        try: confirmed = self.save(copy.deepcopy(value)) is True
        except Exception: confirmed = False
        if not confirmed:
            raise Error('Windows held-input persistence is unconfirmed.', 409, code='input_reset_uncertain', retryable=False)

    def _resolve(self, keysym):
        try:
            value = self.resolve(keysym, self.modifiers)
            factory = getattr(self.resolve, 'validation', None)
            validation = factory() if callable(factory) else None
            if validation is not None and not callable(validation):
                raise Error('Invalid native key validation callback.', 400)
        except Exception as error:
            raise Error('Windows native key resolution was refused.',
                        error.status if isinstance(error, Error) and error.status in (400, 409, 410) else 409,
                        code=error.code if isinstance(error, Error) and error.code in (
                            'capability_unsupported', 'input_stale', 'input_busy', 'lease_ended')
                        else 'input_rejected', retryable=False) from error
        return _codes(value), validation

    def _dispatch(self, events, next_state, bounds, *, cleanup=False, transient=(), before_post=None):
        next_state = validate_state(next_state)
        pending = copy.deepcopy(next_state)
        keys = {key['keysym']: key for key in self._state['keys']}
        for key in next_state['keys']:
            if key['keysym'] in keys and keys[key['keysym']] != key:
                raise Error('A held Windows native key cannot change identity.', 409)
            keys[key['keysym']] = key
        pending['keys'] = list(keys.values())
        pending['buttons'] |= self._state['buttons']
        pending['transient'] = [list(code) for code in sorted({tuple(code) for code in
            self._state['transient']+next_state['transient']+list(transient)})]
        pending['blocked'] = True
        pending = validate_state(pending)
        self._state = pending
        dispatched = False
        try:
            self._persist(pending)
            # Pending state intentionally blocks ordinary callers. This dispatch
            # alone may continue; authorization is still checked independently.
            active = self._allowed(self.authorized)
            if not active: self.revoked = True
            if not (self._allowed(self.cleanup_authorized) if cleanup else active and not self.revoked):
                raise Error('Windows input authorization ended before dispatch.', 410)
            if events:
                if before_post is not None and before_post() is not True:
                    raise Error('Windows key resolution changed before posting.', 409, code='input_stale')
                dispatched = True
                result = self.backend.post(events, bounds, cleanup=cleanup)
                if not isinstance(result, dict) or set(result) != {'posted'} or result['posted'] is not True:
                    raise Error('Windows held-input native acknowledgement differs.', 409)
            active = self._allowed(self.authorized)
            if not active: self.revoked = True
            if not (self._allowed(self.cleanup_authorized) if cleanup else active and not self.revoked):
                raise Error('Windows input authorization ended before persistence.', 410)
            self._persist(next_state)
            active = self._allowed(self.authorized)
            if not active: self.revoked = True
            if not (self._allowed(self.cleanup_authorized) if cleanup else active and not self.revoked):
                raise Error('Windows input authorization ended before acknowledgement.', 410)
            self._state = next_state
        except Exception as error:
            raise Error('Windows held input remains blocked pending explicit release.',
                410 if isinstance(error, Error) and error.status == 410 else 409,
                code='input_reset_uncertain', retryable=False, outcome='unknown' if dispatched else None) from error

    def _enter(self, cleanup=False):
        if not self.lock.acquire(blocking=False):
            raise Error('Windows held input is busy.', 409, code='input_busy', retryable=False)
        try: self._authorize(cleanup)
        except Exception:
            self.lock.release()
            raise

    def key(self, keysym, down, bounds):
        if type(keysym) is not int or not 0 <= keysym <= 0xFFFFFFFF or type(down) is not bool:
            raise Error('Invalid Windows held-key operation.', 400)
        self._enter()
        try:
            held = next((key for key in self._state['keys'] if key['keysym'] == keysym), None)
            if not down and held is None: return {'posted': False}
            validation = None
            if held is not None: key = held
            else:
                codes, validation = self._resolve(keysym)
                key = {'keysym': keysym, 'codes': codes}
            next_state = self.state
            if down and held is None: next_state['keys'].append(key)
            if not down: next_state['keys'] = [key for key in next_state['keys'] if key['keysym'] != keysym]
            next_state = validate_state(next_state)
            events = [key_input(vk, scan, flags | (0 if down else 2)) for vk, scan, flags in key['codes']]
            self._dispatch(events, next_state, bounds, before_post=validation)
            return {'posted': True}
        finally: self.lock.release()

    def pointer(self, x, y, mask, bounds):
        if type(mask) is not int or not 0 <= mask <= 255 or mask & 24 == 24 or mask & 96 == 96:
            raise Error('Invalid Windows pointer mask.', 400)
        move = pointer_input(x, y, bounds)
        self._enter()
        try:
            next_state = self.state
            next_state['buttons'] = mask & 0x87
            events = [move]
            for bit, down, up, data in BUTTONS:
                if self._state['buttons'] & bit and not mask & bit: events.append(mouse_input(up, data))
            for bit, down, up, data in BUTTONS:
                if mask & bit and not self._state['buttons'] & bit: events.append(mouse_input(down, data))
            for bit, flags, delta in ((8, 0x800, 120), (16, 0x800, -120), (32, 0x1000, -120), (64, 0x1000, 120)):
                if mask & bit: events.append(mouse_input(flags, delta))
            self._dispatch(events, next_state, bounds)
            return {'posted': True}
        finally: self.lock.release()

    def text(self, text, bounds):
        if not isinstance(text, str) or '\0' in text: raise Error('Invalid Windows text.', 400)
        try:
            if len(text.encode('utf-8')) > 16000: raise ValueError()
            encoded = text.encode('utf-16-le')
        except (UnicodeError, ValueError): raise Error('Windows text exceeds its Unicode/control envelope.', 400) from None
        self._enter()
        try:
            if self._state['keys'] or self._state['buttons']:
                raise Error('Release held input before Windows text insertion.', 409)
            if not encoded: return {'posted': False}
            # Keep surrogate pairs together; a batch has at most 1024 UTF-16
            # units and 2048 input events. The total text retains its wire bound.
            batches, units = [], []
            for character in text:
                raw = character.encode('utf-16-le')
                values = [int.from_bytes(raw[i:i+2], 'little') for i in range(0, len(raw), 2)]
                if len(units)+len(values) > 1024: batches.append(units); units = []
                units.extend(values)
            if units: batches.append(units)
            for units in batches:
                transient = [[0, value, 4] for value in sorted(set(units))]
                # Candidate Unicode releases must be saved before this batch;
                # successful text does not leave them held in the next state.
                events = [event for value in units for event in (key_input(scan=value, flags=4), key_input(scan=value, flags=6))]
                self._dispatch(events, self.state, bounds, transient=transient)
            return {'posted': True}
        finally: self.lock.release()

    def reset(self):
        self._enter(cleanup=True)
        try:
            keys = sorted(self._state['keys'], key=lambda key: (bool(MODIFIERS.get(key['keysym'])), key['keysym']))
            events = [key_input(vk, scan, flags | 2) for key in keys for vk, scan, flags in key['codes']]
            events.extend(key_input(vk, scan, flags | 2) for vk, scan, flags in self._state['transient'])
            events.extend(mouse_input(up, data) for bit, down, up, data in BUTTONS if self._state['buttons'] & bit)
            self._dispatch(events, _neutral(), None, cleanup=True)
            return {'released': True}
        finally: self.lock.release()
