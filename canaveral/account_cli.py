"""Account commands that keep passwords and issued credentials out of stdout."""
import contextlib
import getpass
import json
import os
import stat
from pathlib import Path
from urllib.parse import quote

from .client import Client
from .model import Error, identifier, secret


def add_commands(commands):
    login = commands.add_parser("login", help="Save a user login session to a new private credential file")
    login.add_argument("--username", required=True)
    login.add_argument("--password-file", help="Protected password file; otherwise prompt privately")
    login.add_argument("--output-file", required=True, help="New credential file; never overwritten")
    commands.add_parser("logout", help="Revoke the login session and remove its credential file")

    account = commands.add_parser("account", help="Manage your Canaveral account")
    actions = account.add_subparsers(dest="account_action", required=True)
    password = actions.add_parser("password", help="Change password and revoke all sessions and personal tokens")
    password.add_argument("--current-password-file")
    password.add_argument("--password-file", help="New password in a protected file; otherwise prompt privately")

    users = commands.add_parser("users", help="Administrator user management")
    actions = users.add_subparsers(dest="user_action")
    users.set_defaults(user_action="list")
    actions.add_parser("list")
    create = actions.add_parser("create", help="Create a pending user; issue an invitation separately")
    create.add_argument("--username", required=True)
    create.add_argument("--role", choices=("admin", "user"), default="user")
    create.add_argument("--request-id", required=True)
    update = actions.add_parser("update")
    update.add_argument("id")
    update.add_argument("--role", choices=("admin", "user"))
    update.add_argument("--status", choices=("active", "pending", "disabled"), help="Re-enable disabled accounts to pending, then issue a fresh invitation")
    for action in ("invite", "reset-password", "revoke-invite"):
        command = actions.add_parser(action)
        command.add_argument("id")
        if action != "revoke-invite":
            command.add_argument("--dashboard-url", required=True)
            command.add_argument("--output-file", required=True, help="New private invitation-link file")

    tokens = commands.add_parser("tokens", help="Create, list and revoke your personal API tokens")
    actions = tokens.add_subparsers(dest="token_action")
    tokens.set_defaults(token_action="list")
    actions.add_parser("list")
    create = actions.add_parser("create", help="Save a one-time token secret to a new private file")
    create.add_argument("--name", required=True)
    create.add_argument("--scope", action="append", choices=("machines:read", "machines:write", "machines:access", "admin"), required=True)
    create.add_argument("--expires-in", type=int, default=30 * 24 * 60 * 60, metavar="SECONDS")
    create.add_argument("--request-id", required=True)
    create.add_argument("--output-file", required=True)
    revoke = actions.add_parser("revoke")
    revoke.add_argument("id")


def _password(path, prompt, confirm=False):
    if path:
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
        fd = os.open(Path(path).expanduser(), flags)
        with os.fdopen(fd, "r", encoding="utf-8") as handle:
            info = os.fstat(handle.fileno())
            if not stat.S_ISREG(info.st_mode) or (os.name != "nt" and (info.st_uid != os.getuid() or info.st_mode & 0o077)):
                raise Error("Use a password file owned by you with mode 0600.", 400)
            value = handle.read(4098)
            if len(value) > 4096:
                raise Error("Password file is too large.", 400)
            return value.rstrip("\r\n")
    value = getpass.getpass(prompt)
    if confirm and value != getpass.getpass("Confirm new Canaveral password: "):
        raise Error("Passwords do not match.", 400)
    return value


def _same_file(path, info):
    try:
        current = path.lstat()
        return stat.S_ISREG(current.st_mode) and (current.st_dev, current.st_ino) == (info.st_dev, info.st_ino)
    except FileNotFoundError:
        return False


@contextlib.contextmanager
def _output(path):
    """Reserve before dispatch so existing files never cause an unseen mint."""
    destination = Path(path).expanduser()
    fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    info = os.fstat(fd)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            yield handle, destination
            handle.flush()
            os.fsync(handle.fileno())
    except BaseException:
        if _same_file(destination, info):
            destination.unlink()
        raise


def _metadata(value):
    if not isinstance(value, dict):
        raise Error("Unexpected credential response. Inspect server state before retrying.", 502)
    return {key: item for key, item in value.items() if key != "token"}


def _issued_token(value):
    _metadata(value)
    return secret(value.get("token"))


def _print(value):
    print(json.dumps(value, indent=2))


def _client(args):
    from .cli import token_file
    return Client(args.url, token_file(args.token_file), args.allow_http)


def _link(client, route, dashboard_url, output_file):
    if not dashboard_url or not output_file:
        raise Error("Supply --dashboard-url and a new --output-file for the private setup link.", 400)
    # Claim recipients must use HTTPS outside loopback, even when the operator
    # deliberately permits HTTP for the controller's private upstream.
    origin = Client(dashboard_url, "").url
    with _output(output_file) as (handle, path):
        result = client.request("POST", route, {})
        value = _issued_token(result)
        handle.write(origin + "/#claim=" + quote(value, safe="") + "\n")
    _print({**_metadata(result), "linkFile": str(path)})


def _login(args):
    password = _password(args.password_file, "Canaveral password: ")
    session = None
    client = Client(args.url, "", args.allow_http)
    try:
        with _output(args.output_file) as (handle, path):
            result = client.request("POST", "/v1/auth/login", {"username": args.username, "password": password})
            session = _issued_token(result)
            handle.write(session + "\n")
    except BaseException:
        if session:
            try:
                Client(args.url, session, args.allow_http).request("POST", "/v1/auth/logout", {})
            except Exception:
                pass  # The credential was never printed; server expiry still bounds it.
        raise
    _print({**_metadata(result), "credentialFile": str(path)})


def _logout(args, client):
    # Do not remove an operator or API credential mistakenly passed to logout.
    client.request("GET", "/v1/auth/session")
    path = Path(args.token_file).expanduser()
    info = path.lstat()
    client.request("POST", "/v1/auth/logout", {})
    if _same_file(path, info):
        path.unlink()
    print("Signed out. The login session is revoked.")


def _token(args, client):
    if args.token_action == "list":
        _print(client.request("GET", "/v1/auth/tokens"))
    elif args.token_action == "revoke":
        _print(client.request("POST", "/v1/auth/tokens/" + identifier(args.id) + "/revoke", {}))
    else:
        request_id = identifier(args.request_id)
        if not 60 <= args.expires_in <= 365 * 24 * 60 * 60:
            raise Error("Token expiry must be 60–31536000 seconds.", 400)
        result = None
        try:
            with _output(args.output_file) as (handle, path):
                result = client.request("POST", "/v1/auth/tokens", {
                    "id": request_id, "name": args.name,
                    "scopes": sorted(set(args.scope)), "expiresInSeconds": args.expires_in,
                })
                _metadata(result)
                if result.get("id") != request_id:
                    raise Error("Token creation was not confirmed for this request. Inspect your token list before retrying.", 502)
                if not result.get("token"):
                    raise Error("This token's secret was already issued. Revoke it, then create a replacement with a new request ID.", 409)
                handle.write(secret(result["token"]) + "\n")
        except (OSError, UnicodeError):
            if result and result.get("token") and result.get("id") == request_id:
                try:
                    client.request("POST", "/v1/auth/tokens/" + request_id + "/revoke", {})
                except Exception:
                    raise Error("Token file could not be saved. Inspect and revoke token " + request_id + " before creating another.", 503) from None
            raise
        _print({**_metadata(result), "credentialFile": str(path)})


def handle(args):
    """Return False for existing CLI commands, retaining their original behavior."""
    if args.command == "login":
        _login(args)
        return True
    if args.command not in ("logout", "account", "users", "tokens") and not (args.command == "admin" and args.action != "create"):
        return False
    client = _client(args)
    if args.command == "logout":
        _logout(args, client)
    elif args.command == "account":
        current = _password(args.current_password_file, "Current Canaveral password: ")
        password = _password(args.password_file, "New Canaveral password: ", confirm=True)
        path = Path(args.token_file).expanduser()
        info = path.lstat()
        client.request("POST", "/v1/auth/password", {"currentPassword": current, "password": password})
        if _same_file(path, info):
            path.unlink()
        print("Password changed. Sign in again; previous sessions and personal API tokens are revoked.")
    elif args.command == "tokens":
        _token(args, client)
    elif args.command == "admin":
        if args.action == "setup-link":
            route = "/v1/auth/bootstrap"
        else:
            if not args.user_id:
                raise Error("Supply --user-id; recovery preserves that user and their machines.", 400)
            route = "/v1/users/" + identifier(args.user_id) + "/reset-password"
        _link(client, route, args.dashboard_url, args.output_file)
    elif args.user_action == "list":
        _print(client.request("GET", "/v1/users"))
    elif args.user_action == "create":
        request_id = identifier(args.request_id)
        result = client.request("POST", "/v1/users", {"id": request_id, "username": args.username, "role": args.role})
        if result.get("id") != request_id:
            raise Error("User creation was not confirmed for this request. Inspect the user list before retrying.", 502)
        _print(result)
    else:
        route = "/v1/users/" + identifier(args.id)
        if args.user_action == "update":
            value = {key: val for key, val in {"role": args.role, "status": args.status}.items() if val is not None}
            if not value:
                raise Error("Supply --role or --status.", 400)
            _print(client.request("POST", route + "/update", value))
        elif args.user_action == "revoke-invite":
            _print(client.request("POST", route + "/revoke-invite", {}))
        else:
            _link(client, route + "/" + args.user_action, args.dashboard_url, args.output_file)
    return True
