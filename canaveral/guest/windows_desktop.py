"""Assigned-guest native desktop primitives; no listener or provider admission.

Use only in a supervised, serialized guest worker. Stream ownership, fresh-frame
identities and persistent held-state recovery belong to the owning service.
"""
import ctypes as c
from contextlib import contextmanager
import struct
import sys
import threading
import zlib

from canaveral.model import Error

U16, U32, I32, H, SIZE = c.c_uint16, c.c_uint32, c.c_int32, c.c_void_p, c.c_size_t
MAX_PIXELS, MAX_PNG, MAX_EVENTS = 4096, 4194304, 4096


class BITMAPINFOHEADER(c.Structure):
    _fields_ = [('size', U32), ('width', I32), ('height', I32), ('planes', U16),
        ('bits', U16), ('compression', U32), ('imageSize', U32), ('xppm', I32),
        ('yppm', I32), ('used', U32), ('important', U32)]


class BITMAPINFO(c.Structure):
    _fields_ = [('header', BITMAPINFOHEADER), ('color', U32)]


class MOUSEINPUT(c.Structure):
    _fields_ = [('dx', I32), ('dy', I32), ('data', U32), ('flags', U32), ('time', U32), ('extra', SIZE)]


class KEYBDINPUT(c.Structure):
    _fields_ = [('vk', U16), ('scan', U16), ('flags', U32), ('time', U32), ('extra', SIZE)]


class HARDWAREINPUT(c.Structure):
    _fields_ = [('message', U32), ('low', U16), ('high', U16)]


class INPUT_UNION(c.Union):
    _fields_ = [('mouse', MOUSEINPUT), ('key', KEYBDINPUT), ('hardware', HARDWAREINPUT)]


class INPUT(c.Structure):
    _anonymous_ = ('value',)
    _fields_ = [('kind', U32), ('value', INPUT_UNION)]


def key_input(vk=0, scan=0, flags=0):
    if any(type(v) is not int for v in (vk, scan, flags)) or not 0 <= vk <= 254 or not 0 <= scan <= 65535:
        raise Error('Invalid native keyboard event.', 400)
    if flags & 4:
        valid = vk == 0 and flags in (4, 6)
    elif flags & 8:
        valid = vk == 0 and scan > 0 and flags in (8, 9, 10, 11)
    else:
        valid = vk > 0 and scan == 0 and flags in (0, 1, 2, 3)
    if not valid: raise Error('Invalid native keyboard flags.', 400)
    return INPUT(1, INPUT_UNION(key=KEYBDINPUT(vk, scan, flags, 0, 0)))


def mouse_input(flags, data=0, x=0, y=0):
    if (any(type(v) is not int for v in (flags, data, x, y)) or not 0 < flags <= 0xFFFF
            or flags & ~0xD9FF or not -(2**31) <= data < 2**32
            or not 0 <= x <= 65535 or not 0 <= y <= 65535
            or bool(flags & 0x8000) != bool(flags & 0x4000)
            or flags & 1 and flags & 0xC000 != 0xC000
            or flags & 0xC000 and not flags & 1
            or flags & 0x1800 and flags & 0x180
            or flags & 0x1800 == 0x1800
            or any(flags & pair == pair for pair in (6, 0x18, 0x60, 0x180))
            or flags & 0x180 and data not in (1, 2, 3)
            or not flags & 1 and (x or y)
            or data and not flags & 0x1980):
        raise Error('Invalid native mouse event.', 400)
    return INPUT(0, INPUT_UNION(mouse=MOUSEINPUT(x, y, data & 0xFFFFFFFF, flags, 0, 0)))


def pointer_input(x, y, bounds):
    if (not isinstance(bounds, (tuple, list)) or len(bounds) != 4
            or any(type(v) is not int for v in bounds)
            or not 0 < bounds[2] <= MAX_PIXELS or not 0 < bounds[3] <= MAX_PIXELS):
        raise Error('Invalid captured virtual-desktop geometry.', 400)
    _, _, width, height = bounds
    if (type(x) is not int or type(y) is not int or not 0 <= x < width or not 0 <= y < height):
        raise Error('Pointer is outside the captured virtual desktop.', 400)
    return mouse_input(0xC001, x=0 if width == 1 else x*65535//(width-1),
                       y=0 if height == 1 else y*65535//(height-1))


def png_bgra(width, height, pixels):
    if (type(width) is not int or type(height) is not int or not 0 < width <= MAX_PIXELS
            or not 0 < height <= MAX_PIXELS or not isinstance(pixels, bytes) or len(pixels) != width*height*4):
        raise Error('Windows pixel buffer differs from its display envelope.', 409)
    compressor, parts, length = zlib.compressobj(3), [], 0
    for row in range(height):
        source = pixels[row*width*4:(row+1)*width*4]
        rgb = bytearray(width*3)
        rgb[0::3], rgb[1::3], rgb[2::3] = source[2::4], source[1::4], source[0::4]
        part = compressor.compress(b'\0'+rgb)
        parts.append(part)
        length += len(part)
        if length+57 >= MAX_PNG: raise Error('Windows frame exceeds the common TightPNG envelope.', 409)
    parts.append(compressor.flush())
    def chunk(kind, data):
        return struct.pack('!I', len(data))+kind+data+struct.pack('!I', zlib.crc32(kind+data) & 0xFFFFFFFF)
    result = (b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR', struct.pack('!IIBBBBB', width, height, 8, 2, 0, 0, 0))
              +chunk(b'IDAT', b''.join(parts))+chunk(b'IEND', b''))
    if len(result) >= MAX_PNG: raise Error('Windows frame exceeds the common TightPNG envelope.', 409)
    return result


class Win32Desktop:
    def __init__(self, authorized, cleanup_authorized=None, *, libraries=None):
        if not callable(authorized) or cleanup_authorized is not None and not callable(cleanup_authorized):
            raise Error('Windows desktop requires explicit authorization.', 400)
        if libraries is None:
            if sys.platform != 'win32' or c.sizeof(H) != 8:
                raise Error('Native desktop requires a 64-bit Windows guest worker.', 409, code='capability_unsupported')
            libraries = tuple(c.WinDLL(name, use_last_error=True) for name in ('user32', 'gdi32', 'kernel32'))
        self.user, self.gdi, self.kernel = libraries
        self.authorized = authorized
        self.cleanup_authorized = authorized if cleanup_authorized is None else cleanup_authorized
        signatures = [(self.user, {'SetThreadDpiAwarenessContext': ([H], H), 'GetSystemMetrics': ([I32], I32),
            'GetDC': ([H], H), 'ReleaseDC': ([H, H], I32), 'GetProcessWindowStation': ([], H),
            'GetThreadDesktop': ([U32], H), 'OpenInputDesktop': ([U32, I32, U32], H),
            'CloseDesktop': ([H], I32), 'GetUserObjectInformationW': ([H, I32, H, U32, c.POINTER(U32)], I32),
            'SendInput': ([U32, c.POINTER(INPUT), I32], U32)}),
            (self.gdi, {'CreateCompatibleDC': ([H], H), 'DeleteDC': ([H], I32),
            'CreateDIBSection': ([H, c.POINTER(BITMAPINFO), U32, c.POINTER(H), H, U32], H),
            'SelectObject': ([H, H], H), 'DeleteObject': ([H], I32),
            'BitBlt': ([H, I32, I32, I32, I32, H, I32, I32, U32], I32), 'GdiFlush': ([], I32)}),
            (self.kernel, {'GetCurrentThreadId': ([], U32)})]
        for library, functions in signatures:
            for name, (args, result) in functions.items():
                function = getattr(library, name)
                function.argtypes, function.restype = args, result
        self.lock, self.thread = threading.Lock(), None
        self.desktop = self.dc = self.memory = self.bitmap = self.previous = self.old_dpi = None
        self.fenced = self.input_fenced = False
        self.revoked = False
        self.gdi_pending = False

    @staticmethod
    def _check(result):
        if not result: raise Error('Windows desktop native operation failed.', 409)
        return result

    def _allowed(self, cleanup=False):
        try: return bool((self.cleanup_authorized if cleanup else self.authorized)())
        except Exception: return False

    def _authorize(self, cleanup=False):
        active = self._allowed()
        if not active: self.revoked = self.input_fenced = True
        allowed = self._allowed(cleanup=True) if cleanup else active
        if self.fenced or not cleanup and self.revoked or not allowed:
            raise Error('Windows desktop authorization ended.', 410)

    def _name(self, handle):
        buffer, needed = c.create_unicode_buffer(512), U32()
        self._check(handle)
        self._check(self.user.GetUserObjectInformationW(handle, 2, buffer, c.sizeof(buffer), c.byref(needed)))
        if not 0 < needed.value <= c.sizeof(buffer): raise Error('Invalid Windows desktop identity.', 409)
        return buffer.value.casefold()

    def _active(self):
        flag, needed = I32(), U32()
        self._check(self.user.GetUserObjectInformationW(self.desktop, 6, c.byref(flag), c.sizeof(flag), c.byref(needed)))
        if needed.value != c.sizeof(flag) or not flag.value:
            raise Error('Windows input desktop is inactive.', 409, code='input_stale')

    def _geometry(self):
        result = tuple(self.user.GetSystemMetrics(index) for index in (76, 77, 78, 79))
        if not 0 < result[2] <= MAX_PIXELS or not 0 < result[3] <= MAX_PIXELS:
            raise Error('Windows virtual desktop exceeds the common display envelope.', 409)
        return result

    @contextmanager
    def _context(self, cleanup=False):
        if not self.lock.acquire(blocking=False):
            raise Error('Windows desktop is busy.', 409, code='input_busy', retryable=False)
        entered = False
        try:
            current = threading.get_ident()
            if self.thread is not None and current != self.thread:
                raise Error('Windows desktop requires its retained worker thread.', 409)
            self.thread = current
            self._authorize(cleanup)
            entered = True
            self.old_dpi = self._check(self.user.SetThreadDpiAwarenessContext(H(-4)))
            if (self._name(self.user.GetProcessWindowStation()) != 'winsta0'
                    or self._name(self.user.GetThreadDesktop(self.kernel.GetCurrentThreadId())) != 'default'):
                raise Error('Windows worker has no supported interactive desktop.', 409, code='capability_unsupported')
            self.desktop = self._check(self.user.OpenInputDesktop(0, 0, 1))
            if self._name(self.desktop) != 'default':
                raise Error('Windows secure or alternate desktop is unsupported.', 409, code='capability_unsupported')
            self._active()
            yield
            self._active()
            self._authorize(cleanup)
        except Error:
            raise
        except Exception as error:
            raise Error('Windows desktop native operation was not confirmed.', 409) from error
        finally:
            try:
                if entered and not self._cleanup():
                    self.fenced = True
                    raise Error('Windows desktop resource cleanup is unconfirmed.', 409,
                                code='display_cleanup_uncertain', retryable=False)
            finally: self.lock.release()

    def capture(self):
        with self._context():
            bounds = self._geometry()
            x, y, width, height = bounds
            self.dc = self._check(self.user.GetDC(None))
            self.memory = self._check(self.gdi.CreateCompatibleDC(self.dc))
            info = BITMAPINFO(BITMAPINFOHEADER(c.sizeof(BITMAPINFOHEADER), width, -height, 1, 32, 0, 0, 0, 0, 0, 0), 0)
            bits = H()
            self.bitmap = self._check(self.gdi.CreateDIBSection(self.dc, c.byref(info), 0, c.byref(bits), None, 0))
            self._check(bits.value)
            self.previous = self.gdi.SelectObject(self.memory, self.bitmap)
            if not self.previous or self.previous == H(-1).value:
                self.previous = None
                raise Error('Windows capture bitmap selection failed.', 409)
            self.gdi_pending = True
            self._check(self.gdi.BitBlt(self.memory, 0, 0, width, height, self.dc, x, y, 0x40CC0020))
            self._check(self.gdi.GdiFlush())
            self.gdi_pending = False
            if self._geometry() != bounds: raise Error('Windows display changed during capture.', 409, code='input_stale')
            pixels = c.string_at(bits.value, width*height*4)
        png = png_bgra(width, height, pixels)
        self._authorize()
        return {'bounds': bounds, 'png': png}

    def post(self, events, bounds, *, cleanup=False):
        if type(cleanup) is not bool or not isinstance(events, list) or not 0 < len(events) <= MAX_EVENTS or any(type(e) is not INPUT for e in events):
            raise Error('Use a bounded native input batch.', 400)
        copied = [INPUT.from_buffer_copy(bytes(e)) for e in events]
        for event in copied:
            if event.kind == 1:
                key_input(event.key.vk, event.key.scan, event.key.flags)
                release = bool(event.key.flags & 2)
            elif event.kind == 0:
                mouse_input(event.mouse.flags, event.mouse.data, event.mouse.dx, event.mouse.dy)
                release = bool(event.mouse.flags) and not event.mouse.flags & ~0x154
            else: raise Error('Native hardware input is unsupported.', 400)
            if cleanup and not release: raise Error('Cleanup may only release held input.', 400)
        dispatched = False
        try:
            with self._context(cleanup):
                if self.input_fenced and not cleanup: raise Error('Windows input is fenced pending owned reset.', 409)
                if not cleanup and self._geometry() != bounds:
                    raise Error('Windows input frame geometry is stale.', 409, code='input_stale')
                array = (INPUT*len(copied))(*copied)
                dispatched = True
                count = self.user.SendInput(len(copied), array, c.sizeof(INPUT))
                if type(count) is not int or count != len(copied):
                    raise Error('Windows input insertion was not confirmed.', 409)
                if not cleanup and self._geometry() != bounds:
                    raise Error('Windows display changed during input.', 409)
            self._authorize(cleanup)
            return {'posted': True}
        except Exception as error:
            if dispatched:
                self.input_fenced = True
                raise Error('Windows input outcome is unknown; it will not be replayed.', 409,
                            retryable=False, outcome='unknown') from error
            if not isinstance(error, Error): raise Error('Windows input validation failed.', 409) from error
            raise

    def _cleanup(self):
        try:
            if self.gdi_pending:
                if not self.gdi.GdiFlush(): return False
                self.gdi_pending = False
            if self.previous is not None:
                result = self.gdi.SelectObject(self.memory, self.previous)
                if not result or result == H(-1).value: return False
                self.previous = None
            if self.bitmap is not None:
                if not self.gdi.DeleteObject(self.bitmap): return False
                self.bitmap = None
            if self.memory is not None:
                if not self.gdi.DeleteDC(self.memory): return False
                self.memory = None
            if self.dc is not None:
                if not self.user.ReleaseDC(None, self.dc): return False
                self.dc = None
            if self.desktop is not None:
                if not self.user.CloseDesktop(self.desktop): return False
                self.desktop = None
            if self.old_dpi is not None:
                if not self.user.SetThreadDpiAwarenessContext(self.old_dpi): return False
                self.old_dpi = None
            return True
        except Exception: return False

    def close(self):
        self.fenced = True
        if not self.lock.acquire(blocking=False): return False
        try:
            if self.thread is not None and self.thread != threading.get_ident(): return False
            return self._cleanup()
        finally: self.lock.release()
