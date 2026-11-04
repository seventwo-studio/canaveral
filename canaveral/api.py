import json
import logging
import secrets
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, parse_qs

from .accounts import Accounts
from .model import Error, secret


def server(store, address, admin_token, enrollment_token):
    secret(admin_token)
    secret(enrollment_token)
    if secrets.compare_digest(admin_token, enrollment_token):
        raise Error("Admin and enrollment credentials must be different.", 400)
    accounts = Accounts(store)
    from .session_broker import SessionBroker
    broker=SessionBroker(store)

    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            self.request.settimeout(20)
            super().setup()

        def log_message(self, *args):
            pass  # Never log Authorization, enrollment bodies or credential responses.

        def do_GET(self):
            self.handle_request()

        def do_POST(self):
            self.handle_request()

        def handle_request(self):
            self.connection.settimeout(20)
            request_id=str(uuid.uuid4())
            response_status=200
            try:
                if self.headers.get("Origin") is not None:
                    raise Error("Browser origins are not supported.", 403)
                if len(self.headers.get_all("Authorization", [])) > 1:
                    raise Error("Ambiguous authorization.", 400)
                token = self.headers.get("Authorization", "")
                token = token[7:] if token.startswith("Bearer ") else ""
                parts = urlsplit(self.path).path.strip("/").split("/")
                if self.command == "GET" and parts == ["healthz"]:
                    self.respond({"ok": True})
                    return
                if self.command == "GET" and parts == ["v1", "auth", "status"]:
                    self.respond(accounts.status())
                    return
                login = self.command == "POST" and parts == ["v1", "auth", "login"]
                setup = self.command == "POST" and parts == ["v1", "auth", "setup"]
                enrollment = parts == ["v1", "hosts", "enroll"] and self.command == "POST"
                heartbeat = len(parts) == 4 and parts[:2] == ["v1", "hosts"] and parts[3] == "heartbeat" and self.command == "POST"
                prepared = len(parts) == 4 and parts[:2] == ["v1", "machines"] and parts[3] == "prepared" and self.command == "POST"
                consumer_catalogue=self.command=='GET' and parts==['v1','environments','templates']
                lease_route=parts[:2]==['v1','leases']
                session_socket=self.command=='GET' and len(parts)==6 and parts[3]=='sessions' and parts[:2] in (['v1','leases'],['v1','hosts'])
                registry_resolve=self.command=='POST' and len(parts)==6 and parts[:2]==['v1','hosts'] and parts[3]=='image-tasks' and parts[5]=='resolve'
                expected = enrollment_token if enrollment else admin_token
                if enrollment and not secrets.compare_digest(token,enrollment_token):
                    store.authenticate_setup(token)
                if setup and not secrets.compare_digest(token, admin_token):
                    raise Error("Administrator setup credential required.", 401)
                if not enrollment and not login and not setup and not heartbeat and not prepared and not consumer_catalogue and not lease_route and not registry_resolve and not session_socket and not (
                    secrets.compare_digest(token, expected) or (not enrollment and accounts.authorized(token))
                ):
                    raise Error("Credential rejected.", 401)
                if heartbeat and not token:
                    raise Error("Host credential required.", 401)
                if heartbeat:
                    # Authenticate before accepting the larger binary-result envelope.
                    store.authenticate_host(parts[2], token)
                if registry_resolve:store.authenticate_host(parts[2],token)
                if session_socket:
                    target=urlsplit(self.path)
                    if target.query or target.fragment or target.scheme or target.netloc or len(self.headers.get_all('Host',[]))!=1 or self.headers.get('Content-Length') or self.headers.get('Transfer-Encoding'):
                        raise Error('Invalid session upgrade target or headers.',400)
                    broker.serve(self,parts[4],parts[5],'host' if parts[1]=='hosts' else 'consumer',parts[2],token)
                    return
                value = {}
                if self.command == "POST":
                    lengths = self.headers.get_all("Content-Length", [])
                    if self.headers.get("Transfer-Encoding") or len(lengths) != 1:
                        raise Error("A single Content-Length is required.", 400)
                    try:
                        size = int(lengths[0])
                    except ValueError:
                        raise Error("Invalid body length.", 400)
                    maximum = 8 * 1048576 if heartbeat else 1048576
                    if not 0 < size <= maximum:
                        raise Error("Request body exceeds the endpoint's size limit.", 413)
                    body = self.rfile.read(size)
                    if len(body) != size:
                        raise Error("Incomplete request.", 400)
                    value = json.loads(body)
                    if not isinstance(value, dict):
                        raise Error("Expected a JSON object.", 400)
                if setup:
                    result = accounts.setup(value)
                elif consumer_catalogue:
                    result=store.consumer_catalogue(token)
                elif registry_resolve:
                    result=store.resolve_registry_import(parts[2],token,parts[4],value)
                elif self.command=='GET' and parts==['v1','image-registry']:
                    from .image_registry import catalogue
                    result={'entries':catalogue()}
                elif self.command=='POST' and parts==['v1','image-registry','imports']:
                    result=store.create_registry_import(value)
                elif self.command=='POST' and parts==['v1','leases']:
                    result,created=store.acquire_lease(token,value,with_status=True)
                    response_status=201 if created else 200
                elif self.command=='POST' and len(parts)==4 and parts[:2]==['v1','leases'] and parts[3]=='operations':
                    result,created=store.create_consumer_operation(parts[2],token,value,with_status=True)
                    response_status=201 if created else 200
                elif self.command=='GET' and len(parts)==5 and parts[:2]==['v1','leases'] and parts[3]=='operations':
                    result=store.get_consumer_operation(parts[2],parts[4],token)
                elif self.command=='POST' and len(parts)==4 and parts[:2]==['v1','leases'] and parts[3]=='sessions':
                    result,created=store.create_access_session(parts[2],token,value,with_status=True)
                    response_status=201 if created else 200
                elif self.command=='GET' and len(parts)==5 and parts[:2]==['v1','leases'] and parts[3]=='sessions':
                    result=store.get_access_session(parts[2],parts[4],token)
                elif self.command=='POST' and len(parts)==6 and parts[:2]==['v1','leases'] and parts[3]=='sessions' and parts[5]=='close':
                    if value:raise Error('Session close expects an empty object.',400)
                    result=store.close_access_session(parts[2],parts[4],token)
                elif self.command=='GET' and parts==['v1','leases']:
                    query=parse_qs(urlsplit(self.path).query,keep_blank_values=True)
                    if set(query)-{'after'} or any(len(v)!=1 for v in query.values()):raise Error('Invalid lease pagination.',400)
                    result=store.list_leases(token,query.get('after',[None])[0])
                elif self.command=='GET' and len(parts)==3 and parts[:2]==['v1','leases']:
                    result=store.get_lease(parts[2],token)
                elif self.command=='POST' and len(parts)==4 and parts[:2]==['v1','leases'] and parts[3]=='credential':
                    if value:raise Error('Credential exchange expects an empty object.',400)
                    result=store.lease_credential(parts[2],token)
                elif self.command=='POST' and len(parts)==4 and parts[:2]==['v1','leases'] and parts[3] in ('renew','release'):
                    result=store.mutate_lease(parts[2],token,parts[3],value)
                elif self.command=='POST' and parts==['v1','consumers']:
                    result=store.create_consumer(value)
                elif self.command=='GET' and parts==['v1','consumers']:
                    result={'consumers':store.consumers()}
                elif self.command=='POST' and len(parts)==4 and parts[:2]==['v1','consumers'] and parts[3] in ('credential','revoke'):
                    if value:raise Error('Credential rotation/revocation expects an empty object.',400)
                    result=store.consumer_credential(parts[2],revoke=parts[3]=='revoke')
                elif login:
                    result = accounts.login(value)
                elif self.command == "POST" and parts == ["v1", "auth", "logout"]:
                    result = accounts.logout(token)
                elif self.command == "POST" and parts == ["v1", "connection-setups"]:
                    result = store.create_setup(value)
                elif self.command == 'POST' and parts == ['v1','resource-budgets']:
                    result = store.save_resource_budget(value)
                elif self.command == 'GET' and parts == ['v1','resource-budgets']:
                    result = {'budgets':store.resource_budgets()}
                elif self.command=='GET' and parts==['v1','images']:
                    result={'images':store.images()}
                elif self.command=='POST' and parts==['v1','images','captures']:
                    result=store.create_image_capture(value)
                elif self.command=='GET' and len(parts)==3 and parts[:2]==['v1','image-tasks']:
                    result=store.image_task(parts[2])
                elif self.command=='GET' and parts==['v1','image-tasks']:
                    result={'tasks':store.image_tasks()}
                elif self.command == "GET" and parts == ["v1", "connection-setups"]:
                    result = {"setups":store.setups()}
                elif self.command == "POST" and len(parts)==4 and parts[:2]==["v1","connection-setups"] and parts[3]=="revoke":
                    result = store.revoke_setup(parts[2])
                elif self.command == "POST" and len(parts)==4 and parts[:2]==["v1","hosts"] and parts[3]=="checks":
                    result = store.request_checks(parts[2])
                elif self.command == "GET" and len(parts)==4 and parts[:2]==["v1","hosts"] and parts[3]=="resources":
                    result = store.host_resources(parts[2])
                elif self.command == "GET" and parts == ["v1", "auth", "session"]:
                    result = accounts.session(token)
                elif enrollment:
                    result = store.enroll(value, setup_token=None if secrets.compare_digest(token,enrollment_token) else token)
                elif heartbeat:
                    result = store.heartbeat(parts[2], token, value)
                elif prepared:
                    if value != {"state": "ready"}:
                        raise Error("Preparation receipts must report ready.", 400)
                    result = store.prepared(parts[2], token)
                elif self.command == "GET" and parts == ["v1", "templates"]:
                    result = {"templates": store.templates()}
                elif self.command == "GET" and parts == ["v1", "hosts"]:
                    result = {"hosts": store.hosts()}
                elif self.command == "GET" and parts == ["v1", "machines"]:
                    result = {"machines": store.machines()}
                elif self.command == "GET" and parts == ["v1", "models"]:
                    result = {"models": store.models()}
                elif self.command == "GET" and parts == ["v1", "jobs"]:
                    result = {"jobs": store.jobs()}
                elif self.command == "GET" and len(parts) == 3 and parts[:2] == ["v1", "jobs"]:
                    from .model import identifier
                    result = store.jobs(identifier(parts[2]))
                elif self.command == "POST" and parts == ["v1", "jobs"]:
                    result = store.create_job(value)
                elif self.command == "POST" and len(parts) == 4 and parts[:2] == ["v1", "jobs"] and parts[3] == "cancel":
                    if value:
                        raise Error("Cancellation expects an empty object.", 400)
                    result = store.cancel_job(parts[2])
                elif self.command == "POST" and parts == ["v1", "machines"]:
                    result = store.create(value)
                elif self.command=='POST' and len(parts)==4 and parts[:2]==['v1','machines'] and parts[3]=='power-off':
                    result=store.request_power_off(parts[2],value)
                elif self.command=='POST' and len(parts)==4 and parts[:2]==['v1','machines'] and parts[3]=='delete':
                    result=store.request_deletion(parts[2],value)
                elif self.command == "POST" and len(parts) == 4 and parts[:2] == ["v1", "machines"] and parts[3] == "operations":
                    result = store.create_device_operation(parts[2], value)
                elif self.command == "GET" and len(parts) == 3 and parts[:2] == ["v1", "operations"]:
                    result = store.device_operation(parts[2])
                elif self.command == "POST" and len(parts) == 4 and parts[:2] == ["v1", "machines"] and parts[3] == "desired":
                    result = store.desired(parts[2], value.get("state"))
                elif self.command == "POST" and len(parts) == 4 and parts[:2] == ["v1", "hosts"] and parts[3] == "accepting":
                    if type(value.get("enabled")) is not bool:
                        raise Error("enabled must be a boolean.", 400)
                    result = store.enable(parts[2], value["enabled"])
                else:
                    raise Error("Unknown endpoint.", 404)
                self.respond(result,response_status)
            except Error as error:
                self.respond({"error":str(error),'message':str(error),'code':error.code,'requestId':request_id,'retryable':error.status in (429,503)}, error.status)
            except (ValueError, TypeError, KeyError, AttributeError):
                self.respond({"error":"Malformed request.",'message':'Malformed request.','code':'invalid_request','requestId':request_id,'retryable':False},400)
            except (BrokenPipeError, ConnectionResetError, TimeoutError):
                self.close_connection = True
            except Exception:
                logging.exception("Orchestrator operation failed")
                self.respond({"error": "Orchestrator storage or service unavailable."}, 503)

        def respond(self, value, status=200):
            body = json.dumps(value).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            if status == 429:
                self.send_header("Retry-After", "60")
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)
            self.close_connection = True

    class Server(ThreadingHTTPServer):
        daemon_threads = True
        request_queue_size = 64

        def __init__(self, *args):
            self.slots = threading.BoundedSemaphore(64)
            self.slot_lock=threading.Lock();self.http_requests=set()
            super().__init__(*args)
            broker.start()

        def promote_session(self,request):
            # Authenticated streams stop occupying the ordinary HTTP pool.
            with self.slot_lock:
                owned=request in self.http_requests
                self.http_requests.discard(request)
            if owned:self.slots.release()

        def server_close(self):
            broker.close()
            super().server_close()

        def reject_unavailable(self,request):
            body=json.dumps({'error':'HTTP worker capacity is temporarily unavailable.','message':'HTTP worker capacity is temporarily unavailable.',
                             'code':'service_unavailable','requestId':str(uuid.uuid4()),'retryable':True}).encode()
            response=('HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\nContent-Length: '+str(len(body))+'\r\nRetry-After: 1\r\nConnection: close\r\n\r\n').encode()+body
            try:request.settimeout(.25);request.sendall(response)
            except OSError:pass
            finally:self.shutdown_request(request)

        def process_request(self, request, client_address):
            if not self.slots.acquire(blocking=False):
                self.reject_unavailable(request)
                return
            with self.slot_lock:self.http_requests.add(request)
            try:
                super().process_request(request, client_address)
            except RuntimeError:
                self.promote_session(request)
                self.reject_unavailable(request)
            except BaseException:
                self.promote_session(request)
                raise

        def process_request_thread(self, *args):
            try:
                super().process_request_thread(*args)
            finally:
                self.promote_session(args[0])

    return Server(address, Handler)
