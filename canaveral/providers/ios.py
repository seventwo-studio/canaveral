"""Xcode simulator lifecycle and idb UI control, always scoped to an owned UDID."""
import json
import platform
import shutil
from pathlib import Path, PurePosixPath

from .mobile import Mobile, encoded
from ..devices import decode_data
from ..files import save_json
from ..model import Error, identifier


class IOS(Mobile):
    def simctl(self, *args, **kwargs):
        return self.run([self.config.get("xcrun", "xcrun"), "simctl", *args], env=self.environment(), **kwargs)

    def idb(self, udid, *args):
        env = self.environment()
        # Do not inherit a companion/target selected by an interactive user.
        for key in list(env):
            if key.startswith("IDB_"):
                del env[key]
        return self.run([self.config.get("idb", "idb"), *args, "--udid", udid], env=env)

    def inventory(self):
        value = json.loads(self.simctl("list", "devices", "--json"))
        return [(runtime, device) for runtime, devices in value["devices"].items() for device in devices]

    def check(self):
        if platform.system() != "Darwin":
            raise Error("iOS simulators require a native macOS host with Xcode.")
        self.check_templates("ios")
        if not shutil.which(self.config.get("idb", "idb")) or not shutil.which("idb_companion"):
            raise Error("iOS UI control requires idb and idb_companion on the host PATH.")
        runtimes = json.loads(self.simctl("list", "runtimes", "--json"))["runtimes"]
        types = json.loads(self.simctl("list", "devicetypes", "--json"))["devicetypes"]
        available = {item["identifier"] for item in runtimes if item.get("isAvailable")}
        device_types = {item["identifier"] for item in types}
        for image in self.config["templates"]:
            if image["device"]["runtime"] not in available or image["device"]["deviceType"] not in device_types:
                raise Error("Install every offered iOS runtime and device type in Xcode before offering it.")

    def owned(self, machine, image, storage):
        record = storage / "simulator.json"
        if not record.exists():
            return None
        udid = identifier(json.loads(record.read_text())["udid"])
        found = [(runtime, item) for runtime, item in self.inventory() if item["udid"].lower() == udid]
        if len(found) != 1:
            raise Error("Owned simulator is missing; it was not recreated.")
        runtime, item = found[0]
        if (item["name"] != self.name(machine) or runtime != image["device"]["runtime"] or
                item.get("deviceTypeIdentifier") != image["device"]["deviceType"] or not item.get("isAvailable")):
            raise Error("Simulator identity/runtime differs from its assignment; refusing control.")
        return item

    def reconcile(self, machine, image, folder):
        storage = self.storage(machine)
        device = self.owned(machine, image, storage)
        if not device:
            if machine["desired"] == "stopped":
                return {"state": "stopped"}
            intent = storage / "create-started.json"
            if intent.exists():
                raise Error("Simulator creation outcome is uncertain; inspect create-started.json before recovery.")
            if any(item["name"] == self.name(machine) for _, item in self.inventory()):
                raise Error("A simulator with this assignment name already exists without an owner receipt.")
            save_json(intent, {"name": self.name(machine)})
            udid = identifier(self.simctl("create", self.name(machine), image["device"]["deviceType"], image["device"]["runtime"]).lower())
            save_json(storage / "simulator.json", {"udid": udid})
            device = self.owned(machine, image, storage)
        udid = device["udid"]
        state = device["state"]
        if machine["desired"] == "stopped":
            if state == "Shutdown":
                return {"state": "stopped"}
            if state == "Booted":
                self.simctl("shutdown", udid)
            return {"state": "stopping"}
        if state == "Shutdown":
            self.simctl("boot", udid)
        elif state not in ("Booted", "Booting"):
            return {"state": "unknown", "detail": "Simulator is in unsupported state " + state}
        self.simctl("bootstatus", udid, "-b", timeout=120)
        return {"state": "running"}

    def app_file(self, udid, args):
        if not args.get("app") or "/" in args["app"]:
            raise Error("iOS file operations require an app bundle ID.")
        relative = PurePosixPath(args["path"])
        if relative.is_absolute() or ".." in relative.parts:
            raise Error("iOS file paths must be relative to the app data container.")
        root = Path(self.simctl("get_app_container", udid, args["app"], "data")).resolve(strict=True)
        destination = (root / str(relative)).resolve()
        if root not in destination.parents and not (destination == root and args.get("path") == "."):
            raise Error("File path escapes the app container.")
        return destination

    def control(self, machine, image, folder, request):
        device = self.owned(machine, image, self.storage(machine))
        if not device or device["state"] != "Booted":
            raise Error("iOS simulator is not booted.")
        udid, action, args = device["udid"], request["action"], request["arguments"]
        if action == "list-files":
            root = self.app_file(udid, args)
            entries = []
            for item in sorted(root.iterdir(), key=lambda p: p.name)[:2001]:
                entries.append({"name": item.name, "kind": "directory" if item.is_dir() and not item.is_symlink() else "file"})
            return {"entries": entries[:2000], "truncated": len(entries) > 2000}
        if action == "screenshot":
            path = folder / (request["id"] + ".png")
            try:
                self.simctl("io", udid, "screenshot", "--type=png", str(path))
                with path.open("rb") as handle:
                    data = handle.read(4 * 1048576 + 1)
                if len(data) > 4 * 1048576:
                    raise Error("Screenshot exceeds 4 MiB.")
                return encoded(data, "image/png")
            finally:
                path.unlink(missing_ok=True)
        if action in ("tap", "swipe"):
            keys = ("x", "y") if action == "tap" else ("x", "y", "toX", "toY")
            argv = ["ui", action, *[str(args[k]) for k in keys]]
            if action == "swipe":
                argv += ["--duration", str(args["durationMs"] / 1000)]
        elif action == "text":
            argv = ["ui", "text", "--", args["text"]]
            # --udid must precede -- so it cannot become text.
            env = self.environment()
            for key in list(env):
                if key.startswith("IDB_"):
                    del env[key]
            return {"output": self.run([self.config.get("idb", "idb"), "ui", "text", "--udid", udid, "--", args["text"]], env=env)}
        elif action == "key":
            argv = ["ui", "key" if args["key"].isdigit() else "button", args["key"]]
        elif action == "hierarchy":
            argv = ["ui", "describe-all", "--json"]
        elif action == "rotate":
            argv = ["ui", "rotate", args["orientation"]]
        elif action == "permission":
            return {"output": self.simctl("privacy", udid, args["state"], args["permission"], args["app"])}
        elif action == "apps":
            return {"output": self.simctl("listapps", udid)}
        elif action == "install":
            return {"output": self.simctl("install", udid, self.artifact(args["artifact"]))}
        elif action in ("uninstall", "launch", "terminate"):
            if "/" in args["app"]:
                raise Error("iOS operations require a bundle ID, without an Android component.")
            return {"output": self.simctl(action, udid, args["app"])}
        elif action == "open-url":
            return {"output": self.simctl("openurl", udid, args["url"])}
        elif action == "location":
            return {"output": self.simctl("location", udid, "set", str(args["latitude"]) + "," + str(args["longitude"]))}
        elif action == "logs":
            return {"output": self.simctl("spawn", udid, "log", "show", "--last", "1m", "--style", "compact")}
        elif action in ("push", "pull"):
            path = self.app_file(udid, args)
            if action == "push":
                # Existing parent only; the request cannot create arbitrary host directories.
                path.write_bytes(decode_data(args["data"]))
                return {"output": "File written to app data container."}
            with path.open("rb") as handle:
                data = handle.read(4 * 1048576 + 1)
            if len(data) > 4 * 1048576:
                raise Error("File exceeds 4 MiB.")
            return encoded(data)
        else:
            raise Error("Guest shell is Android-only; use app, file and UI actions on iOS.")
        return {"output": self.idb(udid, *argv)}

    def stream_upload(self,machine,image,folder,path,app,reader,size,authorized):
        from ..transfers import confined_file, atomic_upload
        import os
        import re
        if not app or not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.]*",app):
            raise Error("Choose an app bundle ID for this upload.",400)
        device=self.owned(machine,image,self.storage(machine))
        if not device or device["state"]!="Booted":raise Error("Simulator is not booted.")
        root=Path(self.simctl("get_app_container",device["udid"],app,"data")).resolve(strict=True)
        parent,name=confined_file(root,path)
        try:return atomic_upload(parent,name,reader,size,authorized)
        finally:os.close(parent)

    def stream_download(self,machine,image,folder,path,app):
        from ..transfers import confined_file, Download
        import os,stat,re
        if not app or not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.]*",app):raise Error("Choose an app bundle ID.",400)
        device=self.owned(machine,image,self.storage(machine))
        if not device or device["state"]!="Booted":raise Error("Simulator is not booted.")
        root=Path(self.simctl("get_app_container",device["udid"],app,"data")).resolve(strict=True)
        parent,name=confined_file(root,path)
        try:fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=parent)
        finally:os.close(parent)
        metadata=os.fstat(fd)
        if not stat.S_ISREG(metadata.st_mode):os.close(fd);raise Error("Downloads require a regular file.")
        return Download(os.fdopen(fd,'rb'),metadata.st_size)
