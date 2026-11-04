"""Public mobile device contracts. No host paths or global SDK commands cross the API."""
import base64
import binascii
import math
import re

from .model import Error, identifier, integer, text


TERMINAL = ("succeeded", "failed", "unknown")
MAX_RESULT = 6 * 1048576


def device_definition(value, system, arch):
    keys = {"systemImage", "profile"} if system == "android" else {"runtime", "deviceType"}
    if not isinstance(value, dict) or set(value) != keys:
        raise Error("Device definition requires " + ", ".join(sorted(keys)) + ".", 400)
    result = {key: text(value[key], key, 200) for key in keys}
    if any(not re.fullmatch(r"[A-Za-z0-9_.;:-]+", v) or v.startswith("-") for v in result.values()):
        raise Error("Invalid SDK runtime or device profile identifier.", 400)
    if system == "android":
        abi = "arm64-v8a" if arch == "arm64" else "x86_64"
        if not re.fullmatch(r"system-images;android-[0-9]+;[A-Za-z0-9_-]+;" + abi, result["systemImage"]):
            raise Error("Android system image must match the template architecture.", 400)
    elif not result["runtime"].startswith("com.apple.CoreSimulator.SimRuntime.iOS-") or not result["deviceType"].startswith("com.apple.CoreSimulator.SimDeviceType."):
        raise Error("Use full iOS runtime and simulator device-type identifiers.", 400)
    return result


def string(value, label, maximum=4096):
    value = text(value, label, maximum)
    if "\x00" in value or value.startswith("-"):
        raise Error("Invalid " + label + ".", 400)
    return value


def decode_data(value):
    if not isinstance(value, str) or len(value) > 700000:
        raise Error("File chunks must be at most 512 KiB of base64 data.", 400)
    try:
        result = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error):
        raise Error("Invalid base64 file data.", 400)
    if len(result) > 524288:
        raise Error("File chunk exceeds 512 KiB.", 400)
    return result


def operation_request(value):
    if not isinstance(value, dict) or set(value) - {"id", "action", "arguments"}:
        raise Error("Invalid device operation.", 400)
    action, args = value.get("action"), value.get("arguments", {})
    fields = {
        "screenshot": (), "hierarchy": (), "apps": (), "logs": (),
        "tap": ("x", "y"), "swipe": ("x", "y", "toX", "toY", "durationMs"),
        "text": ("text",), "key": ("key",), "install": ("artifact",),
        "uninstall": ("app",), "launch": ("app",), "terminate": ("app",),
        "open-url": ("url",), "location": ("latitude", "longitude"),
        "push": ("path", "data"), "pull": ("path",), "shell": ("argv",),
        "permission": ("app", "permission", "state"), "rotate": ("orientation",),
        "accessibility": (), "accessibility-action": ("snapshotId", "nodeId", "nativeAction"),
        "list-files": ("path",),
        "shell-open": ("session",), "shell-read": ("session", "offset"),
        "shell-write": ("session", "text"), "shell-close": ("session",),
        "shell-resize": ("session", "rows", "cols"),
    }
    if not isinstance(action, str) or action not in fields or not isinstance(args, dict):
        raise Error("Unsupported device action.", 400)
    optional = {"app"} if action in ("push", "pull", "list-files") else set()
    if set(args) - set(fields[action]) - optional or not set(fields[action]) <= set(args):
        raise Error("Invalid arguments for " + action + ".", 400)
    result = dict(args)
    for key, val in args.items():
        if key == "session":
            result[key] = identifier(val)
        elif key == "offset":
            if type(val) is not int or not 0 <= val <= 2**53:
                raise Error("Invalid shell offset.", 400)
        elif key in ("rows", "cols"):
            integer(val, key, 500)
        elif key in ("x", "y", "toX", "toY"):
            if type(val) is not int or not 0 <= val <= 32768:
                raise Error("Coordinates must be integers between 0 and 32768.", 400)
        elif key == "durationMs":
            integer(val, "swipe duration", 10000)
        elif key in ("latitude", "longitude"):
            limit = 90 if key == "latitude" else 180
            if type(val) not in (int, float) or not math.isfinite(val) or abs(val) > limit:
                raise Error("Invalid geographic coordinate.", 400)
        elif key == "data":
            decode_data(val)
        elif key == "argv":
            if not isinstance(val, list) or not 1 <= len(val) <= 100:
                raise Error("Shell requires a guest argument list.", 400)
            for item in val:
                if not isinstance(item, str) or "\x00" in item or len(item) > 4096:
                    raise Error("Invalid shell argument.", 400)
            string(val[0], "guest executable")
        elif key == "text":
            if not isinstance(val, str) or "\x00" in val or len(val) > 16000:
                raise Error("Invalid input text.", 400)
        else:
            string(val, key)
    if "app" in args and not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.]*(?:/[A-Za-z0-9_.$]+)?", args["app"]):
        raise Error("Invalid app identifier or Android component.", 400)
    if action == "permission" and args["state"] not in ("grant", "revoke", "reset"):
        raise Error("Permission state must be grant, revoke or reset.", 400)
    if action == "rotate" and args["orientation"] not in ("PORTRAIT", "PORTRAIT_UPSIDE_DOWN", "LANDSCAPE_LEFT", "LANDSCAPE_RIGHT"):
        raise Error("Invalid device orientation.", 400)
    return {"id": identifier(value.get("id")), "action": action, "arguments": result}
