import argparse
import base64
import contextlib
import getpass
import json
import logging
import os
import secrets
import signal
import sys
import uuid
from pathlib import Path

from .api import server
from .client import Client
from .host import Agent
from .model import Error, secret
from .store import Store


def token_file(path, required=True):
    if not path:
        if required:
            raise Error("Supply a credential file; credentials are never command-line values.", 400)
        return None
    return secret(Path(path).read_text().strip())


def parser():
    root = argparse.ArgumentParser(description="Canaveral machine and inference orchestration")
    root.add_argument("--url", default=os.getenv("CANAVERAL_URL", "http://127.0.0.1:8765"))
    root.add_argument("--token-file", default=os.getenv("CANAVERAL_TOKEN_FILE"))
    root.add_argument("--allow-http", action="store_true", default=os.getenv("CANAVERAL_ALLOW_HTTP") == "1")
    commands = root.add_subparsers(dest="command", required=True)
    local = commands.add_parser("local", help="Run an isolated local controller, dashboard and optional Android host")
    local.add_argument("--state", default="./state/local")
    local.add_argument("--api-port", type=int, default=8875)
    local.add_argument("--dashboard-port", type=int, default=8876)
    local.add_argument("--linux-image", help="Installed ARM64 Linux cloud disk for a local Apple desktop VM")
    local.add_argument("--apple-runner", help="Installed signed CanaveralVMRunner")
    local.add_argument("--android-sdk", help="Use installed SDK images; never downloads runtimes")
    init = commands.add_parser("init", help="Create private admin and enrollment credential files")
    init.add_argument("directory")
    serve = commands.add_parser("serve", help="Run the central orchestrator")
    serve.add_argument("--bind", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8765)
    serve.add_argument("--database", default="./state/orchestrator.sqlite3")
    serve.add_argument("--admin-token-file", default=os.getenv("CANAVERAL_ADMIN_TOKEN_FILE"))
    serve.add_argument("--enrollment-token-file", default=os.getenv("CANAVERAL_ENROLLMENT_TOKEN_FILE"))
    dashboard = commands.add_parser("dashboard", help="Run the optional web dashboard against an orchestrator")
    dashboard.add_argument("--bind", default="127.0.0.1")
    dashboard.add_argument("--port", type=int, default=8766)
    dashboard.add_argument("--bootstrap-token-file", default=os.getenv("CANAVERAL_ADMIN_TOKEN_FILE"),
                           help="Operator credential for localhost-only first-admin setup; defaults to ./secrets/admin.token when present")
    admin = commands.add_parser("admin", help="Create the first administrator without replacing an existing account")
    admin.add_argument("action", choices=["create", "setup-link", "recover"])
    admin.add_argument("--username", default="admin")
    admin.add_argument("--password-file", help="Read the initial password from a protected file instead of prompting")
    admin.add_argument("--user-id", help="Existing user UUID for operator recovery")
    admin.add_argument("--dashboard-url", help="Dashboard origin for a one-time setup/recovery link")
    admin.add_argument("--output-file", help="New private setup/recovery-link file")
    from .account_cli import add_commands
    add_commands(commands)
    host = commands.add_parser("host", help="Offer capacity through local machine and inference runners")
    host_config = host.add_mutually_exclusive_group(required=True)
    host_config.add_argument("--config")
    host_config.add_argument("--setup-file", help="Private connection setup JSON downloaded from the dashboard")
    host.add_argument("--check", action="store_true", help="Report environment checks without enrolling or starting machines")
    host.add_argument("--state", required=True)
    host.add_argument("--ca-file", help="PEM CA bundle for verified controller HTTPS and outbound sessions")
    host.add_argument("--enrollment-token-file", default=os.getenv("CANAVERAL_ENROLLMENT_TOKEN_FILE"))
    commands.add_parser("hosts")
    commands.add_parser("machines")
    commands.add_parser("templates", help="List offered template versions and defaults")
    commands.add_parser("models", help="List local models offered by Canaveral runners")
    commands.add_parser("jobs", help="List inference jobs")
    commands.add_parser("job", help="Read an inference job and its result").add_argument("id")
    commands.add_parser("cancel-job", help="Request inference cancellation").add_argument("id")
    generate = commands.add_parser("generate", help="Submit a local generation job to a Canaveral runner")
    generate.add_argument("--model", required=True)
    generate.add_argument("--prompt-file", required=True, help="UTF-8 prompt file; use - for stdin")
    generate.add_argument("--max-tokens", type=int, default=600)
    generate.add_argument("--digest")
    generate.add_argument("--host-id")
    generate.add_argument("--request-id", required=True, help="Stable UUID; reuse after a lost response")
    template = commands.add_parser("template", help="Validate a template or cache its verified base image")
    template.add_argument("action", choices=["validate", "prepare"])
    template.add_argument("file")
    template.add_argument("--cache", default="./state/images")
    create = commands.add_parser("create")
    create.add_argument("name")
    create.add_argument("--template", required=True)
    create.add_argument("--cpu", type=int)
    create.add_argument("--memory-mib", type=int)
    create.add_argument("--disk-gib", type=int)
    create.add_argument("--template-revision")
    create.add_argument("--arch", choices=["amd64", "arm64"])
    create.add_argument("--host-id")
    create.add_argument("--request-id", required=True, help="Stable UUID; reuse after a lost response")
    device = commands.add_parser("device", help="Submit a mobile UI, app, file or platform operation")
    device.add_argument("id", help="Machine UUID")
    device.add_argument("action", choices=["screenshot", "hierarchy", "apps", "logs", "tap", "swipe", "text", "key",
                                         "install", "uninstall", "launch", "terminate", "open-url", "location", "push", "pull", "shell", "permission", "rotate",
                                         "accessibility", "accessibility-action", "list-files", "shell-open", "shell-read", "shell-write", "shell-resize", "shell-close"])
    device.add_argument("--arguments-file", help="JSON arguments file; - reads stdin")
    device.add_argument("--request-id", required=True)
    operation = commands.add_parser("operation", help="Read a device operation receipt")
    operation.add_argument("id")
    operation.add_argument("--output", help="Save returned binary data (screenshots/files) to a new file")
    for name in ("start", "stop", "drain", "accept"):
        commands.add_parser(name).add_argument("id")
    return root


def main(argv=None):
    args = parser().parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    try:
        if args.command == "local":
            from .local import run
            run(args.state, args.api_port, args.dashboard_port, args.android_sdk, args.linux_image, args.apple_runner)
            return
        if args.command == "init":
            path = Path(args.directory)
            path.mkdir(mode=0o700, parents=True, exist_ok=True)
            if any((path / name).exists() for name in ("admin.token", "enrollment.token")):
                raise Error("Credential files already exist; initialization will not overwrite them.")
            for name in ("admin.token", "enrollment.token"):
                with open(path / name, "x", opener=lambda p, flags: os.open(p, flags, 0o600)) as handle:
                    handle.write(secrets.token_urlsafe(32) + "\n")
            print("Created credential files in " + str(path))
            return
        if args.command in ("serve", "dashboard"):
            if not 0 < args.port < 65536:
                raise Error("Invalid listen port.", 400)
            if args.command == "dashboard":
                from .dashboard import server as dashboard_server
                bootstrap = args.bootstrap_token_file
                if bootstrap is None and Path("./secrets/admin.token").is_file():
                    bootstrap = "./secrets/admin.token"
                service = dashboard_server((args.bind, args.port), args.url, args.allow_http,
                                           token_file(bootstrap, required=False))
            else:
                service = server(Store(args.database), (args.bind, args.port), token_file(args.admin_token_file), token_file(args.enrollment_token_file))
            logging.info("%s listening on %s:%s", args.command.title(), args.bind, args.port)
            try:
                service.serve_forever()
            finally:
                service.server_close()
            return
        if args.command == "host":
            from .templates import load_host
            enrollment = token_file(args.enrollment_token_file, required=False)
            if args.setup_file:
                setup_path = Path(args.setup_file).resolve()
                setup = json.loads(setup_path.read_text())
                if not isinstance(setup,dict) or setup.get('schemaVersion') != 1 or not all(key in setup for key in ('controllerUrl','config','enrollmentToken')):
                    raise Error('Unsupported connection setup file.',400)
                args.url = setup['controllerUrl']
                enrollment = secret(setup['enrollmentToken'])
                config = load_host(setup['config'], setup_path.parent)
                if not args.check:
                    from .files import save_json
                    saved = Path(args.state).resolve() / 'host-config.json'
                    if saved.exists() and json.loads(saved.read_text()) != setup['config']:
                        raise Error('State directory already contains a different runner config; choose another state directory.')
                    save_json(saved, setup['config'])
            else:
                config_path = Path(args.config).resolve()
                config = load_host(json.loads(config_path.read_text()),config_path.parent)
            agent = Agent(config, args.url, args.state, args.allow_http,ca_file=args.ca_file)
            if args.check:
                from .host_health import inspect
                report = inspect(config,agent.provider,agent.state_dir)
                print(json.dumps(report,indent=2))
                if report['status']=='failed':raise SystemExit(1)
                return
            for signum in (signal.SIGINT, signal.SIGTERM):
                signal.signal(signum, lambda *_: agent.stopping.set())
            agent.run(enrollment)
            return
        if args.command == "template":
            from .model import template as public_template
            from .templates import prepare_image
            value = json.loads(Path(args.file).read_text())
            result = public_template(value)
            if args.action == "prepare":
                if not value.get("source"):
                    raise Error("This template has no base image source to cache.")
                result["image"] = prepare_image(value["source"], args.cache)
            print(json.dumps(result, indent=2))
            return
        from .account_cli import handle as handle_account_command
        if handle_account_command(args):
            return
        client = Client(args.url, token_file(args.token_file), args.allow_http)
        if args.command == "admin":
            if not client.request("GET", "/v1/auth/status")["setupRequired"]:
                print("An administrator already exists; no changes made.")
                return
            if args.password_file:
                password = Path(args.password_file).read_text().rstrip("\r\n")
            else:
                password = getpass.getpass("New administrator password: ")
                if getpass.getpass("Confirm password: ") != password:
                    raise Error("Passwords do not match.", 400)
            result = client.request("POST", "/v1/auth/setup", {"username": args.username, "password": password})
            # The API issues a session, but a bootstrap CLI must not print it.
            Client(args.url, result["token"], args.allow_http).request("POST", "/v1/auth/logout", {})
            print("Created administrator " + result["user"]["username"] + ".")
            return
        if args.command in ("hosts", "machines", "templates", "models", "jobs"):
            result = client.request("GET", "/v1/" + args.command)
        elif args.command == "device":
            arguments = {}
            if args.arguments_file:
                with (contextlib.nullcontext(sys.stdin) if args.arguments_file == "-" else open(args.arguments_file)) as handle:
                    arguments = json.loads(handle.read(1048577))
            from .devices import operation_request
            value = operation_request({"id": args.request_id, "action": args.action, "arguments": arguments})
            result = client.request("POST", "/v1/machines/" + str(uuid.UUID(args.id)) + "/operations", value)
        elif args.command == "operation":
            result = client.request("GET", "/v1/operations/" + str(uuid.UUID(args.id)))
            if args.output:
                if result["state"] != "succeeded" or "data" not in result.get("result", {}):
                    raise Error("Operation has no successful binary result to save.")
                with open(args.output, "xb") as handle:
                    handle.write(base64.b64decode(result["result"]["data"], validate=True))
                result["result"] = {"output": args.output, "mediaType": result["result"].get("mediaType")}
        elif args.command == "generate":
            with (contextlib.nullcontext(sys.stdin.buffer) if args.prompt_file == "-" else open(args.prompt_file, "rb")) as handle:
                prompt = handle.read(65537).decode("utf-8")
            value = {"id": args.request_id, "model": args.model, "prompt": prompt, "maxTokens": args.max_tokens}
            if args.digest:
                value["digest"] = args.digest
            if args.host_id:
                value["hostId"] = args.host_id
            result = client.request("POST", "/v1/jobs", value)
        elif args.command == "job":
            result = client.request("GET", "/v1/jobs/" + str(uuid.UUID(args.id)))
        elif args.command == "cancel-job":
            result = client.request("POST", "/v1/jobs/" + str(uuid.UUID(args.id)) + "/cancel", {})
        elif args.command == "create":
            value = {"id": args.request_id, "name": args.name, "templateId": args.template,
                     "resources": {k: v for k, v in {"cpu": args.cpu, "memoryMiB": args.memory_mib, "diskGiB": args.disk_gib}.items() if v is not None}}
            if args.template_revision:
                value["templateRevision"] = args.template_revision
            if args.arch:
                value["arch"] = args.arch
            if args.host_id:
                value["hostId"] = args.host_id
            result = client.request("POST", "/v1/machines", value)
        elif args.command in ("start", "stop"):
            result = client.request("POST", "/v1/machines/" + str(uuid.UUID(args.id)) + "/desired", {"state": "running" if args.command == "start" else "stopped"})
        else:
            result = client.request("POST", "/v1/hosts/" + str(uuid.UUID(args.id)) + "/accepting", {"enabled": args.command == "accept"})
        print(json.dumps(result, indent=2))
    except (Error, OSError, ValueError, RuntimeError) as error:
        print("canaveral: " + str(error), file=sys.stderr)
        raise SystemExit(1)
    except KeyboardInterrupt:
        pass
