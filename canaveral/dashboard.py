"""Optional browser gateway. The orchestrator and workers do not depend on it."""

import json
import ipaddress
import re
import secrets
import threading
import time
from http.cookies import SimpleCookie, CookieError
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.resources import files
from urllib.parse import urlsplit

from .accounts import SESSION_SECONDS
from .client import Client
from .lease_clock import execution_monotonic
from .model import Error, secret


def server(address, orchestrator_url, allow_http=False, bootstrap_token=None, reload_assets=False, desktop_connector=None, upload_connector=None, accessibility_connector=None, download_connector=None, shell_connector=None,image_import_connector=None):
    # Validate the fixed upstream at startup. Browser requests cannot choose it.
    Client(orchestrator_url, "", allow_http)
    if bootstrap_token is not None:
        secret(bootstrap_token)
    assets = {
        "/": ("index.html", "text/html; charset=utf-8"),
        "/app.js": ("app.js", "text/javascript; charset=utf-8"),
        "/style.css": ("style.css", "text/css; charset=utf-8"),
        "/favicon.svg": ("favicon.svg", "image/svg+xml"),
        "/launch.jpg": ("launch.jpg", "image/jpeg"),
        "/geist-mono.woff2": ("geist-mono.woff2", "font/woff2"),
        "/licenses.txt": ("licenses.txt", "text/plain; charset=utf-8"),
    }
    asset_names = dict(assets)
    assets = {path: (files("canaveral").joinpath("web").joinpath(name).read_bytes(), kind)
              for path, (name, kind) in assets.items()}

    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            self.request.settimeout(25)
            super().setup()

        def log_message(self, *args):
            pass  # Request bodies and authorization must never enter access logs.

        def do_GET(self):
            self.handle_request()

        def do_POST(self):
            self.handle_request()

        def handle_request(self):
            self.session_cookie = None
            try:
                path = urlsplit(self.path)
                if path.query or path.fragment or path.scheme or path.netloc:
                    raise Error("Use a dashboard path without a query.", 400)
                if self.command == "GET" and path.path in assets:
                    body, kind = assets[path.path]
                    if reload_assets:
                        body = files("canaveral").joinpath("web").joinpath(asset_names[path.path][0]).read_bytes()
                    self.respond(body, kind)
                    return
                if self.command == "GET" and path.path == "/healthz":
                    self.json({"ok": True})
                    return
                route = path.path
                download = self.command == "GET" and re.fullmatch(r"/api/v1/machines/([a-f0-9-]{36})/files/download/([A-Za-z0-9_-]+)", route)
                upload = self.command == "POST" and re.fullmatch(r"/api/v1/machines/([a-f0-9-]{36})/files/upload", route)
                image_upload=self.command=='POST' and re.fullmatch(r'/api/v1/hosts/([a-f0-9-]{36})/images/import',route)
                inspection = self.command == "GET" and re.fullmatch(r"/api/v1/machines/([a-f0-9-]{36})/accessibility", route)
                shell = self.command == "GET" and re.fullmatch(r"/api/v1/machines/([a-f0-9-]{36})/shells/([a-f0-9-]{36})/stream", route)
                desktop = self.command == "GET" and re.fullmatch(r"/api/v1/machines/([a-f0-9-]{36})/desktop", route)
                auth_status = self.command == "GET" and route == "/api/v1/auth/status"
                login = self.command == "POST" and route == "/api/v1/auth/login"
                setup = self.command == "POST" and route == "/api/v1/auth/setup"
                logout = self.command == "POST" and route == "/api/v1/auth/logout"
                readable = route in ("/api/v1/hosts", "/api/v1/machines", "/api/v1/templates", "/api/v1/connection-setups", "/api/v1/resource-budgets",'/api/v1/images','/api/v1/image-tasks','/api/v1/image-registry') or re.fullmatch(r'/api/v1/image-tasks/[a-f0-9-]{36}',route) or re.fullmatch(r"/api/v1/hosts/[a-f0-9-]{36}/resources",route) or re.fullmatch(r"/api/v1/operations/[a-f0-9-]{36}", route)
                writable = route in ("/api/v1/machines", "/api/v1/connection-setups", "/api/v1/resource-budgets",'/api/v1/images/captures','/api/v1/image-registry/imports') or re.fullmatch(
                    r"/api/v1/(?:machines/[a-f0-9-]{36}/(?:desired|operations|power-off)|hosts/[a-f0-9-]{36}/(?:accepting|checks)|connection-setups/[a-f0-9-]{36}/revoke)", route)
                if not (image_upload or shell or download or upload or inspection or desktop or auth_status or login or setup or logout or (self.command == "GET" and readable) or (self.command == "POST" and writable)):
                    raise Error("Unknown dashboard endpoint.", 404)
                # Cookie sessions are same-origin only; bearer clients remain supported.
                origins, hosts = self.headers.get_all("Origin", []), self.headers.get_all("Host", [])
                if len(origins) > 1 or len(hosts) != 1:
                    raise Error("Ambiguous browser origin.", 400)
                if origins and origins[0] not in ("http://" + hosts[0], "https://" + hosts[0]):
                    raise Error("Cross-origin requests are not supported.", 403)
                if self.headers.get("Sec-Fetch-Site") in ("cross-site", "same-site"):
                    raise Error("Cross-origin requests are not supported.", 403)
                # The file-backed operator token can only bootstrap an account
                # from a loopback peer using a loopback Host (also works with a
                # local Kubernetes/SSH port-forward). Never trust proxy headers.
                local_setup = (bootstrap_token is not None and ipaddress.ip_address(self.client_address[0]).is_loopback
                               and urlsplit("http://" + hosts[0]).hostname in ("127.0.0.1", "localhost", "::1"))
                tokens = self.headers.get_all("Authorization", [])
                if len(tokens) > 1:
                    raise Error("Ambiguous authorization.", 400)
                cookie = SimpleCookie()
                cookie.load(self.headers.get("Cookie", ""))
                cookie_token = cookie["canaveral_session"].value if "canaveral_session" in cookie else ""
                token = ""
                if setup:
                    if not local_setup:
                        raise Error("Create the first administrator from localhost with an operator credential file configured.", 403)
                    token = bootstrap_token
                elif not login:
                    if tokens:
                        if not tokens[0].startswith("Bearer "):
                            raise Error("Administrator credential required.", 401)
                        token = tokens[0][7:]
                    else:
                        token = cookie_token
                        if token and self.command == "POST" and not origins:
                            raise Error("Same-origin Origin is required for cookie requests.", 403)
                    if token or not auth_status:
                        try:
                            token = secret(token)
                        except Error:
                            raise Error("Administrator credential rejected.", 401)
                if logout:
                    self.set_session_cookie("", clear=True)
                if image_upload:
                    if not image_import_connector:raise Error('Image imports require an attached host.',409)
                    from urllib.parse import unquote
                    client=Client(orchestrator_url,token,allow_http)
                    client.request('GET','/v1/hosts')
                    if self.headers.get_content_type()!='application/octet-stream':raise Error('Image imports require a raw file body.',415)
                    lengths=self.headers.get_all('Content-Length',[])
                    if self.headers.get('Transfer-Encoding') or len(lengths)!=1:raise Error('A single image Content-Length is required.',400)
                    try:size=int(lengths[0])
                    except ValueError:raise Error('Invalid image Content-Length.',400)
                    if not 512<=size<=2**53:raise Error('Invalid image Content-Length.',400)
                    headers=self.headers.get_all('X-Canaveral-Image',[])
                    if len(headers)!=1 or len(headers[0])>16384:raise Error('Supply bounded image metadata.',400)
                    metadata=json.loads(unquote(headers[0]))
                    host_id=image_upload.group(1)
                    image_import_connector(host_id,check_only=True)
                    last_check=[0]
                    def image_authorized():
                        try:
                            if not last_check[0] or execution_monotonic()-last_check[0]>=1:
                                client.request('GET','/v1/hosts');last_check[0]=execution_monotonic()
                            return image_import_connector(host_id,check_only=True)
                        except Error:return False
                    result=image_import_connector(host_id,metadata,self.rfile,size,image_authorized)
                    self.json(result)
                    return
                if download:
                    if not download_connector:raise Error("Streaming downloads are not attached.",409)
                    import base64
                    from urllib.parse import quote
                    from pathlib import PurePosixPath
                    payload=download.group(2)
                    if len(payload)>8192:raise Error("Invalid download path.",400)
                    options=json.loads(base64.urlsafe_b64decode(payload+'='*(-len(payload)%4)))
                    target=options.get("path")
                    if not isinstance(target,str) or not target or "\x00" in target:raise Error("Invalid guest path.",400)
                    client=Client(orchestrator_url,token,allow_http)
                    client.request("GET","/v1/machines")
                    source=download_connector(download.group(1),target,options.get("app"))
                    self.close_connection=True
                    try:
                        # Check before headers, including empty files. Hold the final
                        # block until verification so a failed transfer ends short.
                        source.verify()
                        if not download_connector(download.group(1),check_only=True):raise Error('Download authorization ended.',401)
                        self.streaming = True
                        self.send_response(200)
                        self.send_header("Content-Type","application/octet-stream")
                        self.send_header("Content-Length",str(source.size))
                        self.send_header("Content-Disposition","attachment; filename*=UTF-8''"+quote(PurePosixPath(target).name,safe=''))
                        self.send_header("Cache-Control","no-store")
                        self.send_header("X-Content-Type-Options","nosniff")
                        self.send_header("Connection","close")
                        self.end_headers()
                        remaining=source.size
                        while remaining:
                            client.request("GET","/v1/machines")
                            if not download_connector(download.group(1),check_only=True):break
                            data=source.read(min(1048576,remaining))
                            if not data:break
                            if len(data)>min(1048576,remaining):raise Error('Download source exceeded its declared length.',409)
                            if len(data)==remaining:source.verify()
                            if not download_connector(download.group(1),check_only=True):break
                            self.wfile.write(data);remaining-=len(data)
                    finally:source.close()
                    return
                if upload or inspection:
                    client = Client(orchestrator_url, token, allow_http)
                    client.request("GET", "/v1/machines")
                    if inspection:
                        if not accessibility_connector:
                            raise Error("Live inspection is not attached to this dashboard.", 409)
                        self.json(accessibility_connector(inspection.group(1)))
                        return
                    if not upload_connector:
                        raise Error("Streaming uploads are not attached to this dashboard.", 409)
                    lengths = self.headers.get_all("Content-Length", [])
                    if self.headers.get("Transfer-Encoding") or len(lengths) != 1:
                        raise Error("A single file length is required.", 400)
                    size = int(lengths[0])
                    if size < 0:
                        raise Error("Invalid file length.", 400)
                    from urllib.parse import unquote
                    target = unquote(self.headers.get("X-Canaveral-Path", ""))
                    app = self.headers.get("X-Canaveral-App")
                    if not target or len(target) > 4096 or "\x00" in target:
                        raise Error("Choose a guest destination path.", 400)
                    checked = [0.0]
                    def authorized():
                        if not checked[0] or execution_monotonic() - checked[0] >= 1:
                            client.request("GET", "/v1/machines")
                            checked[0] = execution_monotonic()
                        return bool(upload_connector(upload.group(1), check_only=True))
                    self.json(upload_connector(upload.group(1), target, app, self.rfile, size, authorized))
                    return
                if shell:
                    if not shell_connector:raise Error('No interactive shell runner is attached.',409)
                    if not origins or self.headers.get('Upgrade','').lower()!='websocket':raise Error('A same-origin terminal WebSocket is required.',403)
                    client=Client(orchestrator_url,token,allow_http)
                    client.request('GET','/v1/auth/session')
                    machine_id,session_id=shell.groups()
                    shell_connector(machine_id,check_only=True)
                    def shell_authorized():
                        try:
                            client.request('GET','/v1/auth/session')
                            return shell_connector(machine_id,check_only=True)
                        except Error:return False
                    # Established streams do not consume the short-request pool or
                    # impose a shell count cap. OS resources remain the limit.
                    self.server.release_slot(self.connection)
                    from .shell_socket import relay as shell_relay
                    shell_relay(self,session_id,lambda request:shell_connector(machine_id,request=request),shell_authorized)
                    return
                if desktop:
                    if not desktop_connector:
                        raise Error("This dashboard has no attached desktop runner.", 409)
                    if not origins or self.headers.get("Upgrade", "").lower() != "websocket":
                        raise Error("A same-origin desktop WebSocket is required.", 403)
                    client = Client(orchestrator_url, token, allow_http)
                    client.request("GET", "/v1/auth/session")
                    machine_id = desktop.group(1)
                    def authorized():
                        try:
                            client.request("GET", "/v1/auth/session")
                            return desktop_connector(machine_id, check_only=True)
                        except Error:
                            return False
                    # A screen stream has the same lifetime as a shell stream:
                    # release short-request capacity after authentication and
                    # let the operator and available OS resources set the count.
                    self.server.release_slot(self.connection)
                    remote = desktop_connector(machine_id)
                    from .desktop_socket import relay
                    relay(self, remote, authorized)
                    return
                value = None
                if self.command == "POST":
                    if self.headers.get_content_type() != "application/json":
                        raise Error("Expected application/json.", 415)
                    lengths = self.headers.get_all("Content-Length", [])
                    if self.headers.get("Transfer-Encoding") or len(lengths) != 1:
                        raise Error("A single Content-Length is required.", 400)
                    try:
                        size = int(lengths[0])
                    except ValueError:
                        raise Error("Invalid body length.", 400)
                    if not 0 < size <= 1048576:
                        raise Error("Body must be between 1 byte and 1 MiB.", 413)
                    body = self.rfile.read(size)
                    if len(body) != size:
                        raise Error("Incomplete request.", 400)
                    value = json.loads(body)
                    if not isinstance(value, dict):
                        raise Error("Expected a JSON object.", 400)
                result = Client(orchestrator_url, token, allow_http).request(self.command, route[4:], value)
                if route == '/api/v1/connection-setups':
                    result['controllerUrl'] = orchestrator_url
                if login or setup:
                    self.set_session_cookie(secret(result.pop("token")))
                if auth_status:
                    result["setupAllowed"] = local_setup
                    if token:
                        try:
                            result.update(Client(orchestrator_url, token, allow_http).request("GET", "/v1/auth/session"))
                        except Error as error:
                            if error.status != 401:
                                raise
                            self.set_session_cookie("", clear=True)
                self.json(result)
            except Error as error:
                if getattr(self,"streaming",False):
                    self.close_connection = True
                    return
                if error.status == 401:
                    self.set_session_cookie("", clear=True)
                self.json({"error": str(error)}, error.status)
            except (ValueError, TypeError, KeyError, AttributeError, CookieError):
                self.json({"error": "Malformed request or orchestrator response."}, 400)
            except (BrokenPipeError, ConnectionResetError, TimeoutError, OSError):
                self.close_connection = True

        def set_session_cookie(self, token, clear=False):
            cookie = SimpleCookie()
            cookie["canaveral_session"] = token
            item = cookie["canaveral_session"]
            item["path"] = "/"
            item["httponly"] = True
            item["samesite"] = "Strict"
            item["max-age"] = 0 if clear else SESSION_SECONDS
            # HTTPS is required remotely. Loopback HTTP is the development exception;
            # proxy-supplied headers never decide whether a credential is secure.
            host = urlsplit("http://" + self.headers.get("Host", "")).hostname
            if host not in ("localhost", "127.0.0.1", "::1"):
                item["secure"] = True
            self.session_cookie = item.OutputString()

        def json(self, value, status=200):
            self.respond(json.dumps(value).encode(), "application/json", status)

        def respond(self, body, kind, status=200):
            nonce = secrets.token_urlsafe(24)
            if kind.startswith("text/html"):
                body = body.replace(b"CANAVERAL_CSP_NONCE", nonce.encode())
            self.send_response(status)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            if self.session_cookie is not None:
                self.send_header("Set-Cookie", self.session_cookie)
            if status == 429:
                self.send_header("Retry-After", "60")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("X-Frame-Options", "DENY")
            # Radix positions menus with style attributes. Its scroll/focus
            # stylesheets use this response's nonce; script policy stays strict.
            self.send_header("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self' 'nonce-" + nonce + "'; style-src-attr 'unsafe-inline'; font-src 'self'; img-src 'self' blob: data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'")
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)
            self.close_connection = True

    class Server(ThreadingHTTPServer):
        daemon_threads = True
        request_queue_size = 32

        def __init__(self, *args):
            self.slots = threading.BoundedSemaphore(32)
            self.slot_lock = threading.Lock()
            self.slot_owners = set()
            super().__init__(*args)

        def process_request(self, request, client_address):
            if not self.slots.acquire(blocking=False):
                self.shutdown_request(request)
                return
            with self.slot_lock:self.slot_owners.add(request)
            try:
                super().process_request(request, client_address)
            except BaseException:
                self.release_slot(request)
                raise

        def release_slot(self, request):
            with self.slot_lock:
                if request in self.slot_owners:
                    self.slot_owners.remove(request)
                    self.slots.release()

        def process_request_thread(self, *args):
            try:
                super().process_request_thread(*args)
            finally:
                self.release_slot(args[0])

    return Server(address, Handler)
