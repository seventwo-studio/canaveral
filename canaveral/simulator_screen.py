"""Adapt owned simulator displays and input to the same RFB connection as VMs.

TightPNG avoids decoding/re-encoding native PNGs. Captures are demand driven,
bounded to four per second, and never create durable operation receipts.
"""
import base64
import json
import math
import socket
import struct
import threading
import time
import uuid

from .model import Error


def dimensions(png):
    if len(png) < 24 or png[:8] != b'\x89PNG\r\n\x1a\n' or png[12:16] != b'IHDR':
        raise Error('Simulator did not return a PNG display.')
    width, height = struct.unpack('!II', png[16:24])
    if not 0 < width <= 32768 or not 0 < height <= 32768:
        raise Error('Unsupported simulator display dimensions.')
    return width, height


def compact_length(size):
    if not 0 <= size < 4194304:
        raise Error('Simulator frame exceeds the TightPNG envelope.')
    parts = [size & 127]
    size >>= 7
    if size:
        parts[0] |= 128
        parts.append(size & 127)
        size >>= 7
        if size:
            parts[1] |= 128
            parts.append(size)
    return bytes(parts)


class SimulatorScreen:
    def __init__(self, provider, machine, image, folder, authorized):
        self.provider, self.machine, self.image, self.folder = provider, machine, image, folder
        self.authorized = authorized
        self.size = None
        self.pressed = None
        self.last_frame = 0
        self.encodings = set()
        self.reset_lock = threading.Lock()
        self.resets = {}

    def action(self, action, arguments):
        if not self.authorized():
            raise Error('Simulator connection is no longer authorized.')
        return self.provider.control(self.machine, self.image, self.folder,
            {'id': str(uuid.uuid4()), 'action': action, 'arguments': arguments})

    def capture(self):
        # Bound memory and use each provider's ownership checks for every capture.
        value = self.action('screenshot', {})
        png = base64.b64decode(value['data'], validate=True)
        dimensions(png)
        return png

    def points(self, *coordinates):
        width, height = self.size
        density = 1
        if self.image['os'] == 'ios':
            # idb reports the scale; never guess a Retina factor from model names.
            device = self.provider.owned(self.machine, self.image, self.provider.storage(self.machine))
            info = json.loads(self.provider.idb(device['udid'], 'describe', '--json'))
            screen = info.get('screen_dimensions') or {}
            density = screen.get('density')
            try:valid = type(density) in (int,float) and math.isfinite(density) and density>0
            except OverflowError:valid = False
            if not valid:
                raise Error('iOS display scale is unavailable; refusing imprecise input.')
        # A gesture uses one metadata observation for both endpoints. Separate
        # reads can apply different scales within a single native swipe.
        try:
            return tuple({'x':int(min(x,width-1)/density),'y':int(min(y,height-1)/density)}
                         for x,y in coordinates)
        except (OverflowError,ValueError) as error:
            raise Error('Simulator display scale cannot represent these input coordinates.') from error

    def point(self, x, y):
        return self.points((x,y))[0]

    def pointer(self, mask, x, y):
        if mask & 1 and self.pressed is None:
            self.pressed = (x, y, time.monotonic())
        elif not mask & 1 and self.pressed is not None:
            start_x, start_y, started = self.pressed
            self.pressed = None
            if abs(x-start_x) + abs(y-start_y) < 6:
                self.action('tap', self.point(x,y))
            else:
                start, end = self.points((start_x,start_y),(x,y))
                self.action('swipe', {**start, 'toX': end['x'], 'toY': end['y'],
                    'durationMs': max(100, min(2000, int((time.monotonic()-started)*1000)))})
        if mask & (8 | 16):
            end_y = max(0, min(self.size[1]-1, y + (200 if mask & 8 else -200)))
            start, end = self.points((x,y),(x,end_y))
            self.action('swipe', {**start, 'toX': end['x'], 'toY': end['y'], 'durationMs': 200})

    def key(self, down, keysym):
        if not down:
            return
        android = {0xff08: 'DEL', 0xff09: 'TAB', 0xff0d: 'ENTER', 0xff1b: 'BACK',
                   0xff51: 'DPAD_LEFT', 0xff52: 'DPAD_UP', 0xff53: 'DPAD_RIGHT',
                   0xff54: 'DPAD_DOWN', 0xffff: 'FORWARD_DEL', 0x1008ff18: 'HOME'}
        ios = {0xff08: '42', 0xff09: '43', 0xff0d: '40', 0xff1b: '41',
               0xff51: '80', 0xff52: '82', 0xff53: '79', 0xff54: '81',
               0xffff: '76', 0x1008ff18: 'HOME'}
        key = (android if self.image['os'] == 'android' else ios).get(keysym)
        if key:
            self.action('key', {'key': key})
        elif 32 <= keysym < 127:
            self.action('text', {'text': chr(keysym)})
        # SDK input is discrete: modifiers and unsupported keys have no effect.

    def reset_input(self):
        self.pressed = None
        return True

    def close_input(self):
        pass

    def serve(self, connection):
        def read(size):
            value = bytearray()
            while len(value) < size:
                chunk = connection.recv(size-len(value))
                if not chunk:
                    raise EOFError()
                value.extend(chunk)
            return bytes(value)
        connection.settimeout(30)
        try:
            png = self.capture()
            self.size = dimensions(png)
            connection.sendall(b'RFB 003.008\n')
            if read(12) != b'RFB 003.008\n':
                raise Error('RFB 3.8 is required.')
            # Authentication is supplied by the dashboard before this private socket exists.
            connection.sendall(b'\x01\x01')
            if read(1) != b'\x01':
                raise Error('Invalid RFB security selection.')
            connection.sendall(b'\0\0\0\0')
            read(1)
            name = b'Canaveral display'
            pixel_format = struct.pack('!BBBBHHHBBB3x', 32, 24, 0, 1, 255, 255, 255, 16, 8, 0)
            connection.sendall(struct.pack('!HH', *self.size) + pixel_format + struct.pack('!I', len(name)) + name)
            while self.authorized():
                kind = read(1)[0]
                if kind == 0:
                    read(19)  # TightPNG carries its own colour representation.
                elif kind == 2:
                    _, count = struct.unpack('!BH', read(3))
                    if count > 256:
                        raise Error('Too many display encodings.')
                    self.encodings = set(struct.unpack('!'+str(count)+'i', read(count*4)))
                elif kind == 3:
                    read(9)
                    if -260 not in self.encodings:
                        raise Error('This simulator requires TightPNG display encoding.')
                    delay = .25 - (time.monotonic()-self.last_frame)
                    if delay > 0:
                        time.sleep(delay)
                    # The handshake capture only establishes dimensions. Input
                    # or app state may change before the first demand request.
                    png = self.capture()
                    self.last_frame = time.monotonic()
                    size = dimensions(png)
                    rectangles = b''
                    if size != self.size:
                        if -223 not in self.encodings:
                            raise Error('Client cannot resize the rotated display.')
                        self.size = size
                        self.pressed = None
                        rectangles = struct.pack('!HHHHi', 0, 0, *size, -223)
                    frame = struct.pack('!HHHHi', 0, 0, *size, -260) + b'\xa0' + compact_length(len(png)) + png
                    connection.sendall(struct.pack('!BBH', 0, 0, 2 if rectangles else 1) + rectangles + frame)
                elif kind == 4:
                    down, keysym = struct.unpack('!B2xI', read(7))
                    self.key(down, keysym)
                elif kind == 5:
                    self.pointer(*struct.unpack('!BHH', read(5)))
                elif kind == 6:
                    size = struct.unpack('!3xI', read(7))[0]
                    if size > 16000:
                        raise Error('Clipboard input exceeds the control envelope.')
                    self.action('text', {'text': read(size).decode('utf-8')})
                elif kind in (249,250):
                    # Private ordered barrier: cancelling a partial gesture must
                    # not turn its pending mouse-down into a tap on release.
                    token = read(16)
                    with self.reset_lock:
                        event = self.resets.pop(token, None)
                    if event is None:
                        raise Error('Unknown simulator input reset.')
                    if kind == 249 and self.reset_input() is not True:
                        raise Error('Native input reset was not confirmed.')
                    event.set()
                else:
                    raise Error('Unsupported RFB client message.')
        except (OSError, EOFError, Error, ValueError, KeyError):
            pass
        finally:
            try:self.close_input()
            finally:connection.close()


class ScreenConnection:
    def __init__(self, connection, screen):
        self.connection, self.screen = connection, screen

    def __getattr__(self, name):
        return getattr(self.connection, name)

    def barrier(self,reset=True):
        token, event = uuid.uuid4().bytes, threading.Event()
        with self.screen.reset_lock:
            self.screen.resets[token] = event
        try:
            self.connection.sendall((b'\xf9' if reset else b'\xfa') + token)
            return event.wait(2)
        finally:
            with self.screen.reset_lock:
                self.screen.resets.pop(token, None)

    def cancel_input(self):return self.barrier(reset=True)


def connect(provider, machine, image, folder, authorized):
    client, worker = socket.socketpair()
    screen = SimulatorScreen(provider, machine, image, folder, authorized)
    threading.Thread(target=screen.serve, args=(worker,), daemon=True).start()
    return ScreenConnection(client, screen)
