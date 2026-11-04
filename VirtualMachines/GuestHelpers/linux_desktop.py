#!/usr/bin/env python3
"""Canaveral guest desktop helper. Linux X11 only; run inside an isolated VM."""
import argparse
import base64
import ctypes as C
import ctypes.util
import hashlib
import hmac
import http.server
import json
import os
import pathlib
import platform
import secrets
import struct
import threading
import time
import uuid
import zlib

REFERENCE_EPOCH = 978307200


def atomic_json(path, value):
    temporary = path.with_suffix(".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as file:
        json.dump(value, file)
        file.flush()
        os.fsync(file.fileno())
    os.replace(temporary, path)


class XImage(C.Structure):
    _fields_ = [("width", C.c_int), ("height", C.c_int), ("xoffset", C.c_int),
                ("format", C.c_int), ("data", C.c_void_p), ("byte_order", C.c_int),
                ("bitmap_unit", C.c_int), ("bitmap_bit_order", C.c_int),
                ("bitmap_pad", C.c_int), ("depth", C.c_int), ("bytes_per_line", C.c_int),
                ("bits_per_pixel", C.c_int), ("red_mask", C.c_ulong),
                ("green_mask", C.c_ulong), ("blue_mask", C.c_ulong),
                ("obdata", C.c_void_p), ("functions", C.c_void_p * 6)]


class Desktop:
    def __init__(self):
        self.x = C.CDLL(ctypes.util.find_library("X11") or "libX11.so.6")
        self.xtest = C.CDLL(ctypes.util.find_library("Xtst") or "libXtst.so.6")
        def bind(lib, name, result, *args):
            f = getattr(lib, name); f.restype = result; f.argtypes = args; return f
        ptr = C.c_void_p; integer = C.c_int; ulong = C.c_ulong
        self.open_display = bind(self.x, "XOpenDisplay", ptr, C.c_char_p)
        self.root_window = bind(self.x, "XDefaultRootWindow", ulong, ptr)
        self.default_screen = bind(self.x, "XDefaultScreen", integer, ptr)
        self.display_width = bind(self.x, "XDisplayWidth", integer, ptr, integer)
        self.display_height = bind(self.x, "XDisplayHeight", integer, ptr, integer)
        self.get_image = bind(self.x, "XGetImage", C.POINTER(XImage), ptr, ulong, integer, integer, C.c_uint, C.c_uint, ulong, integer)
        self.destroy_image = bind(self.x, "XDestroyImage", integer, C.POINTER(XImage))
        self.keysym = bind(self.x, "XStringToKeysym", ulong, C.c_char_p)
        self.keycode = bind(self.x, "XKeysymToKeycode", C.c_ubyte, ptr, ulong)
        self.base_keysym = bind(self.x, "XKeycodeToKeysym", ulong, ptr, C.c_ubyte, integer)
        self.flush = bind(self.x, "XSync", integer, ptr, integer)
        self.move = bind(self.xtest, "XTestFakeMotionEvent", integer, ptr, integer, integer, integer, ulong)
        self.button = bind(self.xtest, "XTestFakeButtonEvent", integer, ptr, C.c_uint, integer, ulong)
        self.key_event = bind(self.xtest, "XTestFakeKeyEvent", integer, ptr, C.c_uint, integer, ulong)
        self.display = self.open_display(None)
        if not self.display:
            raise RuntimeError("No X11 display. Select an Xorg desktop session; Wayland is not supported.")
        self.screen = self.default_screen(self.display)

    def size(self):
        w = self.display_width(self.display, self.screen)
        h = self.display_height(self.display, self.screen)
        if not (0 < w <= 8192 and 0 < h <= 8192):
            raise ValueError("Unsupported guest display size")
        return w, h

    def capture(self):
        w, h = self.size()
        image = self.get_image(self.display, self.root_window(self.display), 0, 0, w, h, C.c_ulong(-1), 2)
        if not image:
            raise RuntimeError("X11 capture failed")
        try:
            im = image.contents
            if im.bits_per_pixel not in (16, 24, 32):
                raise ValueError("Unsupported X11 pixel layout")
            raw = C.string_at(im.data, im.bytes_per_line * h)
            scale = min(1, 1280 / w)
            ow, oh = max(1, int(w * scale)), max(1, int(h * scale))
            pixel_bytes = im.bits_per_pixel // 8
            order = "little" if im.byte_order == 0 else "big"
            masks = [im.red_mask, im.green_mask, im.blue_mask]
            shifts = [(m & -m).bit_length() - 1 for m in masks]
            maxima = [m >> s for m, s in zip(masks, shifts)]
            rows = bytearray()
            for y in range(oh):
                rows.append(0)
                row = int(y / scale) * im.bytes_per_line
                for x in range(ow):
                    start = row + int(x / scale) * pixel_bytes
                    value = int.from_bytes(raw[start:start + pixel_bytes], order)
                    rows.extend(((value & m) >> s) * 255 // maximum for m, s, maximum in zip(masks, shifts, maxima))
            def chunk(name, data):
                return struct.pack(">I", len(data)) + name + data + struct.pack(">I", zlib.crc32(name + data) & 0xffffffff)
            png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", ow, oh, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(rows, 3)) + chunk(b"IEND", b"")
            return {"id": str(uuid.uuid4()), "width": ow, "height": oh, "pngBase64": base64.b64encode(png).decode(), "capturedAt": time.time() - REFERENCE_EPOCH}
        finally:
            self.destroy_image(image)

    def code(self, name):
        sym = self.keysym(name.encode())
        code = self.keycode(self.display, sym)
        if not sym or not code:
            raise ValueError("Key is not available in this guest's keyboard layout: " + name)
        return code, sym

    def perform(self, action):
        kind = action.get("kind")
        if kind == "click":
            w, h = self.size()
            x, y = action.get("x"), action.get("y")
            if not all(isinstance(n, (int, float)) and 0 <= n <= 1 for n in (x, y)):
                raise ValueError("Invalid normalized coordinates")
            self.move(self.display, self.screen, int(x * (w - 1)), int(y * (h - 1)), 0)
            self.button(self.display, 1, 1, 0); self.button(self.display, 1, 0, 0)
        elif kind == "scroll":
            delta = action.get("delta")
            if not isinstance(delta, int) or not 0 < abs(delta) <= 20:
                raise ValueError("Invalid scroll amount")
            for _ in range(abs(delta)):
                button = 4 if delta > 0 else 5
                self.button(self.display, button, 1, 0); self.button(self.display, button, 0, 0)
        elif kind == "key":
            value = action.get("key", "")
            if not isinstance(value, str) or len(value) > 80:
                raise ValueError("Invalid shortcut")
            parts = value.lower().split("+")
            modifiers = {"ctrl": "Control_L", "alt": "Alt_L", "shift": "Shift_L", "super": "Super_L"}
            aliases = {"return": "Return", "tab": "Tab", "escape": "Escape", "delete": "BackSpace", "space": "space", "left": "Left", "right": "Right", "up": "Up", "down": "Down"}
            if any(p not in modifiers for p in parts[:-1]):
                raise ValueError("Unsupported shortcut modifier")
            codes = [self.code(modifiers[p])[0] for p in parts[:-1]] + [self.code(aliases.get(parts[-1], parts[-1]))[0]]
            for code in codes: self.key_event(self.display, code, 1, 0)
            for code in reversed(codes): self.key_event(self.display, code, 0, 0)
        elif kind == "typeText":
            text = action.get("text")
            if not isinstance(text, str) or not text or len(text.encode("utf-16-le")) // 2 > 2000:
                raise ValueError("Invalid text")
            # Validate every character before posting any events. Nonmapped Unicode fails explicitly.
            events = []
            for char in text:
                code, sym = self.code({" ": "space", "\n": "Return", "\t": "Tab"}.get(char, char))
                base = self.base_keysym(self.display, code, 0)
                shifted = self.base_keysym(self.display, code, 1)
                if sym != base and sym != shifted:
                    raise ValueError("Character needs an unsupported keyboard level")
                events.append((code, sym != base))
            shift = self.code("Shift_L")[0]
            for code, shifted in events:
                if shifted: self.key_event(self.display, shift, 1, 0)
                self.key_event(self.display, code, 1, 0); self.key_event(self.display, code, 0, 0)
                if shifted: self.key_event(self.display, shift, 0, 0)
        else:
            raise ValueError("Unknown desktop action")
        self.flush(self.display, 0)


class Bridge:
    def __init__(self, desktop, token, root):
        self.desktop, self.token, self.root = desktop, token, root
        self.lock = threading.Lock()
        self.frame = None
        self.frames = {}
        self.control_file = root / "control.json"
        self.user_control = json.loads(self.control_file.read_text())["userControl"] if self.control_file.exists() else False
        self.journal = root / "inputs.json"
        self.receipts = json.loads(self.journal.read_text()) if self.journal.exists() else {}

    def request(self, path, action=None):
        with self.lock:
            if path == "/v1/desktop/control" and action is not None:
                if type(action.get("userControl")) is not bool: raise ValueError("Invalid control request")
                atomic_json(self.control_file, {"userControl": action["userControl"]})
                self.user_control = action["userControl"]; self.frame = None; self.frames.clear()
                return {"userControl": self.user_control}
            if path in ("/v1/desktop", "/v1/desktop/session") and action is None:
                self.frame = self.desktop.capture()
                self.frames = {key: stamp for key, stamp in self.frames.items() if time.time() - REFERENCE_EPOCH - stamp < 180}
                if len(self.frames) >= 180: del self.frames[min(self.frames, key=self.frames.get)]
                self.frames[self.frame["id"]] = self.frame["capturedAt"]
                if path.endswith("/session"): return {"frame": self.frame, "userControl": self.user_control}
                return self.frame
            if path != "/v1/desktop/action" or action is None:
                raise ValueError("Unknown endpoint")
            identifier = str(uuid.UUID(action["id"]))
            if identifier in self.receipts:
                if self.receipts[identifier]["status"] != "posted":
                    raise ValueError("Uncertain action will not be replayed; inspect the desktop")
                return self.receipts[identifier]
            if (action.get("human") is True) != self.user_control:
                raise ValueError("Desktop is controlled by someone else")
            captured_at = self.frames.get(str(uuid.UUID(action["frameID"])))
            if captured_at is None or time.time() - REFERENCE_EPOCH - captured_at >= 180:
                raise ValueError("Capture a fresh guest frame before acting")
            self.receipts[identifier] = {"id": identifier, "status": "uncertain"}
            atomic_json(self.journal, self.receipts)
            self.desktop.perform(action)
            self.frame = None; self.frames.clear()
            self.receipts[identifier]["status"] = "posted"
            atomic_json(self.journal, self.receipts)
            return self.receipts[identifier]


def serve(bridge):
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self): self.handle_request(False)
        def do_POST(self): self.handle_request(True)
        def log_message(self, *args): pass
        def handle_request(self, post):
            self.connection.settimeout(20)
            if len(self.headers.get_all("Authorization", [])) != 1 or not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + bridge.token):
                return self.reply(401, {"message": "Guest credential rejected"})
            if "Origin" in self.headers:
                return self.reply(403, {"message": "Browser clients are not supported"})
            try:
                if "Transfer-Encoding" in self.headers or len(self.headers.get_all("Content-Length", [])) > 1:
                    raise ValueError("Ambiguous request framing")
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 <= length <= 32768: raise ValueError("Request too large")
                action = json.loads(self.rfile.read(length)) if post else None
                self.reply(200, bridge.request(self.path, action))
            except Exception:
                self.reply(409, {"message": "Guest request failed. Capture again and inspect before retrying input."})
        def reply(self, status, payload):
            data = json.dumps(payload).encode()
            self.send_response(status); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data))); self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close"); self.end_headers(); self.wfile.write(data)
            self.close_connection = True
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 8767), Handler)
    server.daemon_threads = True
    print("Canaveral guest helper listening on 127.0.0.1:8767", flush=True)
    server.serve_forever()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--guest-confirmed", action="store_true")
    parser.add_argument("--show-credential", action="store_true")
    args = parser.parse_args()
    if platform.system() != "Linux" or not args.guest_confirmed:
        parser.error("Run inside an isolated Linux VM with --guest-confirmed")
    if os.environ.get("XDG_SESSION_TYPE") == "wayland":
        parser.error("Choose an Xorg desktop session. Wayland control is not implemented.")
    root = pathlib.Path.home() / ".local/state/seven-guest"
    root.mkdir(parents=True, exist_ok=True); root.chmod(0o700)
    credential = root / "credential"
    if not credential.exists():
        fd = os.open(credential, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as file: file.write(secrets.token_urlsafe(32))
    token = credential.read_text().strip()
    if args.show_credential:
        print(token)
        return
    serve(Bridge(Desktop(), token, root))


if __name__ == "__main__": main()
