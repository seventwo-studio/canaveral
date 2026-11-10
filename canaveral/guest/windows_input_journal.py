"""Pinned existing-file held-input journal; no provisioning or guest admission.

The owner must supply an already durably provisioned private file and context.
Per-save writes change bounded slots, never filesystem names. Native storage/
hypervisor guarantees and production owner binding still need acceptance.
"""
import copy
import ctypes as c
import hashlib
import json
import struct
import threading
import uuid

from canaveral.guest_chunk_files import MAX_INTEGER
from canaveral.model import Error
from .windows_file_handles import component, H, UNICODE_STRING, OBJECT_ATTRIBUTES, IO_STATUS_BLOCK
from .windows_held_input import validate_state, _neutral, MAX_RECORD
from .windows_staging import Win32Staging

SLOT = 131072
FILE_BYTES = SLOT*2
MAGIC = b'CNVWINJ1'
PREFIX = struct.Struct('<8sQII16s')
HEADER_BYTES = PREFIX.size+32


class _Torn(Exception): pass


class Win32Journal(Win32Staging):
    def journal(self, parent, name):
        encoded = component(name)
        raw = c.create_string_buffer(encoded)
        text = UNICODE_STRING(len(encoded), len(encoded), c.cast(raw, H))
        attributes = OBJECT_ATTRIBUTES(c.sizeof(OBJECT_ATTRIBUTES), parent, c.pointer(text), 0x40, None, None)
        handle, status = H(), IO_STATUS_BLOCK()
        # FILE_OPEN, exclusive generic read/write + synchronize; no DELETE,
        # allocation, create, truncate, inheritance, rename or path fallback.
        code = self.nt.NtCreateFile(c.byref(handle), 0xC0100000, c.byref(attributes),
            c.byref(status), None, 0, 0, 1, 0x200062, None, 0)
        if code < 0 or not handle.value: raise OSError('Existing Windows journal cannot be opened')
        return handle.value


def _payload(state):
    return json.dumps(validate_state(state), sort_keys=True, separators=(',', ':'), allow_nan=False).encode('utf-8')


def _packed(context, sequence, state):
    payload = _payload(state)
    prefix = PREFIX.pack(MAGIC, sequence, len(payload), 1, context.bytes)
    raw = prefix+hashlib.sha256(prefix+payload).digest()+payload
    return raw+b'\0'*(SLOT-len(raw))


def _decode(raw, index, context):
    if raw == b'\0'*SLOT: return None
    if len(raw) != SLOT: raise _Torn()
    magic, sequence, length, version, owner = PREFIX.unpack_from(raw)
    if magic != MAGIC or not 0 < length <= MAX_RECORD or any(raw[HEADER_BYTES+length:]): raise _Torn()
    payload = raw[HEADER_BYTES:HEADER_BYTES+length]
    if hashlib.sha256(raw[:PREFIX.size]+payload).digest() != raw[PREFIX.size:HEADER_BYTES]: raise _Torn()
    if owner != context.bytes:
        raise Error('Windows journal belongs to another context.', 409, code='input_reset_uncertain')
    if version != 1 or not 1 <= sequence <= MAX_INTEGER or sequence % 2 != index:
        raise Error('Windows journal version or sequence is invalid.', 409, code='input_reset_uncertain')
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result: raise ValueError()
            result[key] = value
        return result
    try:
        def invalid(value): raise ValueError()
        state = validate_state(json.loads(payload.decode('utf-8'), object_pairs_hook=unique, parse_constant=invalid))
        if _payload(state) != payload: raise ValueError()
    except (ValueError, TypeError, UnicodeError, Error, RecursionError):
        raise Error('Windows journal payload is invalid.', 409, code='input_reset_uncertain') from None
    return sequence, state


def _covers(container, candidate):
    keys = {key['keysym']: key['codes'] for key in container['keys']}
    return (all(keys.get(key['keysym']) == key['codes'] for key in candidate['keys'])
        and container['buttons'] & candidate['buttons'] == candidate['buttons']
        and {tuple(code) for code in candidate['transient']} <= {tuple(code) for code in container['transient']})


def _transition(previous, following):
    if previous['blocked']:
        valid = (_covers(previous, following) and (not following['blocked'] or _covers(following, previous)))
    else:
        valid = following['blocked'] and _covers(following, previous)
    if not valid:
        raise Error('Windows journal transition would lose or invent held input.', 409, code='input_reset_uncertain')


class WindowsInputJournal:
    def __init__(self, root, context, expected, authorized):
        self.root, self.context, self.expected, self.authorized = root, context, expected, authorized
        self.io = threading.Lock()
        self.handles, self.parents = [], []
        self.handle = self.stamp = self._state = None
        self.sequence = 0
        self.fenced = self.closed = self.write_attempted = False

    @classmethod
    def open(cls, root, parts, context, expected, authorized, *, initialize=False):
        try: context = uuid.UUID(context)
        except (ValueError, TypeError, AttributeError): raise Error('Journal context must be an explicit UUID.', 400)
        if (not isinstance(expected, dict) or set(expected) != {'volume', 'fileId'}
                or type(expected['volume']) is not int or expected['volume'] < 0
                or not isinstance(expected['fileId'], str) or not expected['fileId']
                or not callable(authorized) or type(initialize) is not bool):
            raise Error('Journal requires an expected file identity and scoped I/O authority.', 400)
        if not isinstance(parts, (list, tuple)) or not parts or sum(len(component(name))+2 for name in parts) > 65532:
            raise Error('Journal requires bounded relative filename components.', 400)
        if any(not callable(getattr(root.api, method, None)) for method in ('journal', 'write', 'flush')):
            raise Error('Windows journal storage is unavailable for this binding.', 409, code='capability_unsupported')
        with root.lock:
            if root.fenced or not root.handles: raise Error('Windows journal root is fenced.', 410)
            journal = cls(root, context, dict(expected), authorized)
            journal.io.acquire()
            root.pins.add(journal)
            parent = root.handles[-1]
        try:
            journal._authorize()
            journal.parents.append((parent, journal._directory(root.api.info(parent))))
            if journal.parents[0][1] != journal._directory(root.identity):
                raise Error('Windows journal root identity changed.', 409)
            for name in parts[:-1]:
                journal._authorize()
                parent = root.api.open(parent, name, True)
                journal.handles.append(parent)
                journal.parents.append((parent, journal._directory(root.api.info(parent))))
            journal._check()
            journal.handle = root.api.journal(parent, parts[-1])
            journal.handles.append(journal.handle)
            journal.stamp = root.api.info(journal.handle)
            journal._regular(journal.stamp)
            journal._load(initialize)
            journal._check()
            journal.io.release()
            return journal
        except Exception as error:
            journal.fenced = True
            journal.io.release()
            confirmed = journal.close()
            raise Error('Windows journal setup/recovery was not confirmed.',
                410 if isinstance(error, Error) and error.status == 410 else 409,
                code='input_reset_uncertain', retryable=False,
                outcome='unknown' if journal.write_attempted or not confirmed else None) from error

    @property
    def recovered(self):
        if self.fenced or self.closed: raise Error('Reopen the fenced Windows journal explicitly.', 409)
        return copy.deepcopy(self._state)

    def _authorize(self):
        try: active = bool(self.authorized())
        except Exception: active = False
        if self.fenced or self.closed or self.root.fenced or not active:
            self.fenced = True
            raise Error('Windows journal I/O authorization ended.', 410, retryable=False)

    def _directory(self, info):
        if not info['directory'] or info['attributes'] & 0x400 or info['volume'] != self.root.identity['volume']:
            raise Error('Windows journal parent type or volume changed.', 409)
        return info['volume'], info['fileId'], info['attributes']

    def _regular(self, info):
        if (info['directory'] or info['attributes'] & (0x400 | 0x40 | 0x10) or info['links'] != 1
                or info['size'] != FILE_BYTES or info['volume'] != self.expected['volume']
                or info['fileId'] != self.expected['fileId'] or info['volume'] != self.root.identity['volume']):
            raise Error('Windows journal file differs from its provisioned identity/size.', 409)

    def _check(self):
        self._authorize()
        for handle, identity in self.parents:
            if self._directory(self.root.api.info(handle)) != identity: raise Error('Pinned journal parent changed.', 409)
        if self.handle is not None:
            info = self.root.api.info(self.handle)
            self._regular(info)
            if info != self.stamp: raise Error('Pinned journal metadata changed.', 409)
        self._authorize()

    def _read(self, index):
        self._check()
        raw = self.root.api.read(self.handle, index*SLOT, SLOT)
        if not isinstance(raw, bytes) or len(raw) != SLOT: raise Error('Windows journal read was truncated.', 409)
        self._check()
        return raw

    def _load(self, initialize):
        records, torn, blank = [], False, 0
        for index in range(2):
            try:
                record = _decode(self._read(index), index, self.context)
                if record is None: blank += 1
                else: records.append(record)
            except _Torn: torn = True
        if not records:
            if blank != 2 or not initialize:
                raise Error('Missing or corrupt Windows journal cannot initialize implicitly.', 409)
            self._write(1, _neutral())
            return
        records.sort(key=lambda record: record[0])
        if len(records) == 2:
            if records[1][0] != records[0][0]+1: raise Error('Windows journal sequence history is ambiguous.', 409)
            _transition(records[0][1], records[1][1])
        sequence, state = records[-1]
        if torn and not state['blocked']:
            # A damaged new pending write cannot be distinguished from lost
            # acknowledged input evidence by falling back to an old neutral row.
            raise Error('Torn Windows journal lacks conservative recovery evidence.', 409)
        if blank and sequence != 1: raise Error('Windows journal history disappeared.', 409)
        self.sequence, self._state = sequence, state

    def _write(self, sequence, state):
        self._check()
        raw, offset = _packed(self.context, sequence, state), (sequence % 2)*SLOT
        written = 0
        while written < SLOT:
            self._authorize()
            self.write_attempted = True
            count = self.root.api.write(self.handle, offset+written, raw[written:])
            if type(count) is not int or not 0 < count <= SLOT-written:
                raise Error('Windows journal write progress is unknown.', 409, outcome='unknown')
            written += count
        self._authorize()
        self.root.api.flush(self.handle)
        self.stamp = self.root.api.info(self.handle)
        self._regular(self.stamp)
        if self._read(sequence % 2) != raw: raise Error('Windows journal readback differs.', 409)
        self._check()
        self.sequence, self._state = sequence, copy.deepcopy(state)

    def __call__(self, state):
        state = validate_state(state)
        if not self.io.acquire(blocking=False):
            raise Error('Windows journal is busy.', 409, code='input_busy', retryable=False)
        attempted = False
        try:
            self._authorize()
            _transition(self._state, state)
            if self.sequence >= MAX_INTEGER: raise Error('Windows journal sequence is exhausted.', 409)
            attempted = True
            self._write(self.sequence+1, state)
            return True
        except Exception as error:
            if attempted: self.fenced = True
            raise Error('Windows journal save was not confirmed.',
                410 if isinstance(error, Error) and error.status == 410 else 409,
                code='input_reset_uncertain', retryable=False,
                outcome='unknown' if attempted else None) from error
        finally: self.io.release()

    def close(self):
        self.fenced = True
        if not self.io.acquire(blocking=False): return False
        try:
            while self.handles:
                handle = self.handles[-1]
                try: self.root.api.close(handle)
                except Exception: return False
                self.handles.pop()
                if handle == self.handle: self.handle = None
            self.closed = True
            with self.root.lock: self.root.pins.discard(self)
            return True
        finally: self.io.release()
