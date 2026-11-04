"""Read-only Windows key resolution; no posting, service or admission."""
import ctypes as c
from contextlib import contextmanager
import sys
import threading

from canaveral.model import Error

H, U32, U8 = c.c_void_p, c.c_uint32, c.c_ubyte
# RFB keysyms use the same named-key definitions as the common guest viewer.
NAMED = {0xff08: 0x08, 0xff09: 0x09, 0xff0d: 0x0d, 0xff1b: 0x1b,
    0xffff: 0x2e, 0xff50: 0x24, 0xff57: 0x23, 0xff55: 0x21, 0xff56: 0x22,
    0xff51: 0x25, 0xff52: 0x26, 0xff53: 0x27, 0xff54: 0x28, 0xff63: 0x2d,
    0xffe1: 0xa0, 0xffe2: 0xa1, 0xffe3: 0xa2, 0xffe4: 0xa3,
    0xffe9: 0xa4, 0xffea: 0xa5, 0xffe7: 0x5b, 0xffe8: 0x5c,
    0xffeb: 0x5b, 0xffec: 0x5c, 0xff8d: 0x0d, 0xff67: 0x5d}
NAMED.update({0xffbe+i: 0x70+i for i in range(24)})
RIGHT_ALT = 16  # Internal modifier-side observation, not a native event flag.


def _unsupported():
    return Error('This Windows key cannot be resolved without guessing.', 409, code='capability_unsupported', retryable=False)


class WindowsKeys:
    def __init__(self, authorized, *, api=None):
        if not callable(authorized): raise Error('Windows key resolution requires authorization.', 400)
        if api is None:
            if sys.platform != 'win32' or c.sizeof(H) != 8:
                raise Error('Native key resolution requires a 64-bit Windows guest worker.', 409, code='capability_unsupported')
            version = sys.getwindowsversion()
            if version.major < 10 or version.major == 10 and version.build < 14393:
                raise Error('Read-only key translation requires Windows 10 version 1607 or newer.', 409, code='capability_unsupported')
            api = c.WinDLL('user32', use_last_error=True)
        self.api, self.authorized = api, authorized
        signatures = {'GetForegroundWindow': ([], H), 'GetWindowThreadProcessId': ([H, c.POINTER(U32)], U32),
            'GetKeyboardLayout': ([U32], H), 'VkKeyScanExW': ([c.c_wchar, H], c.c_int16),
            'MapVirtualKeyExW': ([U32, U32, H], U32),
            'ToUnicodeEx': ([U32, U32, c.POINTER(U8), c.c_wchar_p, c.c_int32, U32, H], c.c_int32)}
        for name, (arguments, result) in signatures.items():
            function = getattr(api, name)
            function.argtypes, function.restype = arguments, result
        self.lock, self.thread = threading.Lock(), None
        self.closed = self.prepared = False
        self.last = None

    def _authorize(self):
        try: active = bool(self.authorized())
        except Exception: active = False
        if not active: self.closed = True
        if self.closed: raise Error('Windows key resolution authorization ended.', 410, retryable=False)

    @contextmanager
    def _guard(self):
        if not self.lock.acquire(blocking=False):
            raise Error('Windows key resolution is busy.', 409, code='input_busy', retryable=False)
        try:
            current = threading.get_ident()
            if self.thread is not None and self.thread != current:
                raise Error('Windows key resolution requires its retained worker thread.', 409)
            self.thread = current
            self._authorize()
            yield
            self._authorize()
        except Error: raise
        except Exception as error:
            raise Error('Windows keyboard layout observation failed.', 409, retryable=False) from error
        finally: self.lock.release()

    def _layout(self):
        window = self.api.GetForegroundWindow()
        thread = self.api.GetWindowThreadProcessId(window, None) if window else 0
        layout = self.api.GetKeyboardLayout(thread) if thread else 0
        if not window or not thread or not layout:
            raise Error('Windows foreground keyboard layout is unavailable.', 409, code='input_stale', retryable=False)
        return window, thread, layout

    def _scan(self, vk, layout, keypad_enter=False):
        scan = self.api.MapVirtualKeyExW(vk, 4, layout)
        if type(scan) is not int or not 0 < scan <= 0xffff or not scan & 255 or scan >> 8 not in (0, 0xe0):
            raise _unsupported()
        return [0, scan & 255, 8 | int(keypad_enter or scan >> 8 == 0xe0)]

    def __call__(self, keysym, modifiers):
        if (type(keysym) is not int or not 0 <= keysym <= 0xffffffff
                or type(modifiers) is not int or not 0 <= modifiers <= 31
                or modifiers & RIGHT_ALT and not modifiers & 4):
            raise Error('Invalid Windows keysym/modifier state.', 400)
        with self._guard():
            self.prepared = False
            if keysym in NAMED:
                token = self._layout()
                result = [self._scan(NAMED[keysym], token[2], keysym == 0xff8d)]
            else:
                if 0x20 <= keysym <= 0x7e or 0xa0 <= keysym <= 0xff: value = keysym
                elif keysym & 0xff000000 == 0x01000000: value = keysym & 0xffffff
                else: raise _unsupported()
                if not 0 < value <= 0x10ffff or 0xd800 <= value <= 0xdfff: raise _unsupported()
                text = chr(value)
                if not modifiers & 14:
                    encoded = text.encode('utf-16-le')
                    result = [[0, int.from_bytes(encoded[i:i+2], 'little'), 4] for i in range(0, len(encoded), 2)]
                    token = None
                else:
                    if value > 0xffff: raise _unsupported()
                    token = self._layout()
                    mapped = self.api.VkKeyScanExW(text, token[2])
                    if type(mapped) is not int or not 0 <= mapped <= 0x7fff: raise _unsupported()
                    vk, required = mapped & 255, mapped >> 8
                    active = modifiers & 7
                    if required & 6 == 6 and modifiers & RIGHT_ALT: active |= 2
                    if not 1 <= vk <= 254 or required & ~7 or required & 6 & ~active:
                        raise _unsupported()
                    descriptor = self._scan(vk, token[2])
                    state, buffer = (U8*256)(), c.create_unicode_buffer(8)
                    # Extra Ctrl/Alt/Win define the requested shortcut rather
                    # than its character. Validate the producing modifiers plus
                    # actual Shift without changing the native dead-key buffer.
                    flags = required & 6 | modifiers & 1
                    for bit, key in ((1, 0x10), (2, 0x11), (4, 0x12)):
                        if flags & bit: state[key] = 0x80
                    count = self.api.ToUnicodeEx(vk, descriptor[1], state, buffer, len(buffer), 4, token[2])
                    produced = buffer[0] if type(count) is int and count == 1 else ''
                    if (produced != text and not (produced.isalpha() and text.isalpha()
                            and produced.casefold() == text.casefold())):
                        raise _unsupported()
                    result = [descriptor]
            if token is not None and self._layout() != token:
                raise Error('Windows foreground keyboard layout changed during resolution.', 409, code='input_stale')
            self.last, self.prepared = token, True
        return result

    def validation(self):
        """Capture the resolution's observations for the pre-dispatch barrier."""
        if not self.prepared: raise Error('No Windows key resolution is prepared.', 409)
        token = self.last
        def validate():
            with self._guard():
                if token is not None and self._layout() != token:
                    raise Error('Windows keyboard layout changed before native input.', 409, code='input_stale')
            return True
        return validate

    def close(self):
        self.closed = True  # HWND/HKL/thread values are observations, not owned handles.
