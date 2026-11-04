"""Native Android SDK AVDs; each assignment owns a private AVD and explicit serial."""
import json
import os
import platform
import shlex
import socket
import subprocess
import time
import uuid
from pathlib import Path

from .mobile import Mobile, encoded
from ..devices import decode_data
from ..assignment_process import assignment_popen
from ..files import HostLock, save_json
from ..model import Error


class Android(Mobile):
    def resource_processes(self,machine,image,folder,psutil):
        from ..owned_usage import android_processes
        return android_processes(self,machine,image,folder,psutil)

    def launch_arguments(self,machine,port):
        return [self.tool('emulator'),'-avd',self.name(machine),'-port',str(port),
                '-cores',str(machine['resources']['cpu']),'-memory',str(machine['resources']['memoryMiB']),
                '-no-window','-no-audio','-no-snapshot','-no-boot-anim']

    def display_epoch(self,machine,image,folder):
        from ..model import digest
        path=self.storage(machine)/'launch.json'
        if not path.is_file():return None
        launch=json.loads(path.read_text())
        return {'startedAt':launch['startedAt'],'identity':digest(launch)}

    def __init__(self, config, state):
        super().__init__(config, state)
        self.processes = {}
        from ..shell_sessions import ShellSessions
        self.shells = ShellSessions(popen=assignment_popen)

    def tool(self, name):
        sdk = Path(self.config["androidSDK"])
        relative = {"adb": "platform-tools/adb", "emulator": "emulator/emulator",
                    "avdmanager": "cmdline-tools/latest/bin/avdmanager"}[name]
        return str(sdk / (relative + (".exe" if name != "avdmanager" else ".bat") if os.name == "nt" else relative))

    def environment(self):
        env = super().environment()
        env.update(ANDROID_HOME=self.config["androidSDK"], ANDROID_SDK_ROOT=self.config["androidSDK"],
                   ANDROID_AVD_HOME=str(Path(self.config["storage"]).resolve() / "avds"))
        # Never inherit a remote adb server or another agent's emulator selection.
        for key in ("ANDROID_SERIAL", "ADB_SERVER_SOCKET", "ANDROID_ADB_SERVER_PORT"):
            env.pop(key, None)
        return env

    def adb(self, serial, *args, **kwargs):
        return self.run([self.tool("adb"), "-s", serial, *args], env=self.environment(), **kwargs)

    def check(self):
        if platform.system() not in ("Darwin", "Linux"):
            raise Error("Android hosts currently support native macOS and Linux.")
        self.check_templates("android")
        sdk = Path(self.config["androidSDK"])
        if not sdk.is_absolute():
            raise Error("androidSDK must be an absolute SDK path.")
        for name in ("adb", "emulator", "avdmanager"):
            if not Path(self.tool(name)).is_file():
                raise Error("Install Android SDK platform-tools, emulator and command-line tools first.")
        for image in self.config["templates"]:
            if not (sdk / Path(*image["device"]["systemImage"].split(";"))).is_dir():
                raise Error("Install every offered Android system image before starting the host.")
            if self.config.get('transferHelperManifest') is not None:
                from ..android_transfer import load_helper
                load_helper(self.config,image)
        self.run([self.tool("adb"), "start-server"], env=self.environment())

    def devices(self):
        output = self.run([self.tool("adb"), "devices"], env=self.environment())
        return {line.split()[0]: line.split()[1] for line in output.splitlines()[1:] if len(line.split()) >= 2}

    def owned(self, machine, serial):
        if self.adb(serial, "emu", "avd", "name").splitlines()[0] != self.name(machine):
            raise Error("Android serial belongs to another AVD; refusing device control.")

    def provision(self, machine, image, storage):
        avds = Path(self.environment()["ANDROID_AVD_HOME"])
        avds.mkdir(mode=0o700, parents=True, exist_ok=True)
        avd = storage / "device.avd"
        receipt = storage / "avd-created.json"
        if not receipt.exists():
            if avd.exists() or (avds / (self.name(machine) + ".ini")).exists():
                raise Error("Partial or foreign AVD exists; inspect before provisioning again.")
            self.run([self.tool("avdmanager"), "create", "avd", "--name", self.name(machine),
                      "--package", image["device"]["systemImage"], "--device", image["device"]["profile"],
                      "--path", avd], env=self.environment(), data=b"no\n", timeout=120)
            config = avd / "config.ini"
            config.write_text(config.read_text() + "\ndisk.dataPartition.size=" + str(machine["resources"]["diskGiB"]) + "G\n")
            save_json(receipt, {"name": self.name(machine)})
        if not avd.is_dir():
            raise Error("Owned AVD data is missing; it was not recreated.")
        return avd

    def endpoint(self, machine, storage, authorized=None):
        def check():
            if authorized is not None and not authorized():raise Error('Android upload authorization ended during device lookup.',401)
        check()
        record = storage / "endpoint.json"
        if not record.exists():
            return None
        port = json.loads(record.read_text())["port"]
        serial = "emulator-" + str(port)
        check()
        state = self.devices().get(serial)
        check()
        if state:
            # Even offline/unauthorized devices occupy their port and cannot be replaced.
            if state != "device":
                raise Error("Reserved Android serial is offline or unauthorized; inspect the emulator.")
            self.owned(machine, serial)
            check()
            return serial
        return None

    def reconcile(self, machine, image, folder):
        if machine["desired"] != "running":
            self.shells.sweep(active={m for m, _ in self.shells.sessions if m != machine["id"]})
        storage = self.storage(machine)
        endpoint = self.endpoint(machine, storage)
        launch = storage / "launch.json"
        stop = storage / "stop.json"
        if endpoint:
            if machine["desired"] == "stopped":
                if not stop.exists() or not json.loads(stop.read_text()).get("acknowledged"):
                    save_json(stop, {"requested": True})
                    self.adb(endpoint, "emu", "kill")
                    save_json(stop, {"requested": True, "acknowledged": True})
                return {"state": "stopping"}
            if self.adb(endpoint, "shell", "getprop", "sys.boot_completed") != "1":
                return {"state": "starting"}
            return {"state": "running"}
        if stop.exists():
            # A missing adb serial can mean an adb outage, not a stopped VM.
            if not json.loads(stop.read_text()).get("acknowledged"):
                return {"state": "unknown", "detail": "Emulator shutdown request was not acknowledged; inspect its process and receipts."}
            if not self.process_stopped(machine, storage):
                return {"state": "stopping", "detail": "Waiting for the owned emulator process to exit."}
            for path in (launch, stop, storage / "endpoint.json"):
                path.unlink(missing_ok=True)
            self.processes.pop(machine["id"], None)
            if machine["desired"] == "stopped":
                return {"state": "stopped"}
        if launch.exists():
            started = json.loads(launch.read_text()).get("startedAt", 0)
            if time.time() - started < 120:
                return {"state": "starting"}
            return {"state": "unknown", "detail": "Emulator launch outcome is uncertain; inspect launch.json and emulator.log before recovery."}
        if machine["desired"] == "stopped":
            return {"state": "stopped"}
        self.provision(machine, image, storage)
        root = Path(self.config["storage"]).resolve()
        with HostLock(root / "ports.lock"):
            occupied = self.devices()
            reserved = {json.loads(p.read_text())["port"] for p in root.glob("*/endpoint.json")}
            port = None
            for candidate in range(5554, 5682, 2):
                if candidate in reserved or "emulator-" + str(candidate) in occupied:
                    continue
                try:
                    with socket.socket() as first, socket.socket() as second:
                        first.bind(("127.0.0.1", candidate))
                        second.bind(("127.0.0.1", candidate + 1))
                    port = candidate
                    break
                except OSError:
                    continue
            if port is None:
                raise Error("No free Android emulator console/adb port pair.")
            save_json(storage / "endpoint.json", {"port": port})
            argv = self.launch_arguments(machine,port)
            started = time.time()
            from ..model import digest
            identity={'version':2,'bootId':str(uuid.uuid4()),'machineId':machine['id'],
                      'leaseId':machine.get('lease',{}).get('id'),
                      'fingerprint':digest({key:machine[key] for key in ('id','template','resources')}),
                      'argv':argv,'startedAt':started}
            save_json(launch, identity)
            with (storage / "emulator.log").open("ab") as log:
                try:
                    process = subprocess.Popen(argv, stdout=log, stderr=log, stdin=subprocess.DEVNULL,
                                               env=self.environment(), start_new_session=True)
                except OSError as error:
                    raise Error("Emulator launch failed; inspect its receipt before retrying.") from error
            self.processes[machine["id"]] = process
            from ..owned_usage import child_birth
            born=child_birth(process,started)
            save_json(launch, {**identity,'pid':process.pid,**({'processStartedAt':born} if born is not None else {})})
        return {"state": "starting"}

    def process_stopped(self, machine, storage):
        process = self.processes.get(machine["id"])
        if process is not None:
            # Reap our child as well as checking it; signal 0 alone sees zombies.
            return process.poll() is not None
        launch = storage / "launch.json"
        pid = json.loads(launch.read_text()).get("pid") if launch.exists() else None
        if type(pid) is not int or pid <= 0:
            return False
        try:
            os.kill(pid, 0)  # Existence probe only; never signal a possibly reused PID.
        except ProcessLookupError:
            return True
        except PermissionError:
            pass
        return False

    def control(self, machine, image, folder, request):
        storage = self.storage(machine)
        serial = self.endpoint(machine, storage)
        if not serial or self.adb(serial, "shell", "getprop", "sys.boot_completed") != "1":
            raise Error("Android device is not ready.")
        action, args = request["action"], request["arguments"]
        if action == "shell-open":
            return self.shells.open(machine["id"], args["session"],
                                    [self.tool("adb"), "-s", serial, "shell", "-tt"], self.environment())
        if action.startswith("shell-"):
            return self.shells.control(machine["id"], action, args)
        if action == "list-files":
            if "app" in args or not args["path"].startswith("/"):
                raise Error("Android browsing requires an absolute guest path without app.")
            script = 'cd ' + shlex.quote(args["path"]) + ' || exit; for entry in ./* ./.[!.]* ./..?*; do [ -e "$entry" ] || [ -L "$entry" ] || continue; if [ -d "$entry" ]; then kind=directory; else kind=file; fi; printf "%s\\000%s\\000" "$kind" "${entry##*/}"; done'
            raw = self.adb(serial, "exec-out", "sh", "-c", script, binary=True)
            parts = raw.decode("utf-8", errors="replace").split("\0")
            if raw and (not raw.endswith(b"\0") or len(parts) % 2 != 1 or any(parts[i] not in ("directory", "file") for i in range(0, len(parts)-1, 2))):
                raise Error("Directory could not be listed; verify the guest path and permissions.")
            return {"entries": [{"kind": parts[i], "name": parts[i+1]} for i in range(0, len(parts)-1, 2)][:2000],
                    "truncated": len(parts) > 4001}
        if action == "screenshot":
            return encoded(self.adb(serial, "exec-out", "screencap", "-p", binary=True), "image/png")
        if action == "hierarchy":
            path = "/data/local/tmp/canaveral-" + request["id"] + ".xml"
            self.adb(serial, "shell", "uiautomator", "dump", path)
            try:
                return {"output": self.adb(serial, "shell", "cat", path)}
            finally:
                self.adb(serial, "shell", "rm", "-f", path)
        if action == "install":
            argv = ["install", "-r", self.artifact(args["artifact"])]
        elif action == "uninstall":
            argv = ["uninstall", args["app"]]
        elif action == "apps":
            argv = ["shell", "pm", "list", "packages"]
        elif action == "launch":
            argv = ["shell", "am", "start", "-n", args["app"]]
        elif action == "terminate":
            argv = ["shell", "am", "force-stop", args["app"]]
        elif action == "open-url":
            argv = ["shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", args["url"]]
        elif action in ("tap", "swipe"):
            keys = ("x", "y") if action == "tap" else ("x", "y", "toX", "toY", "durationMs")
            argv = ["shell", "input", action, *[str(args[k]) for k in keys]]
        elif action == "text":
            if any(ord(c) > 127 or c in "\r\n" for c in args["text"]):
                raise Error("Android input text supports single-line ASCII; use guest shell/IME for Unicode.")
            # input text interprets %s as a space. Send literal %s pairs separately.
            chunks = args["text"].split("%s")
            commands = []
            for index, chunk in enumerate(chunks):
                if index:
                    commands += ["input text %", "input text s"]
                if chunk:
                    commands.append("input text " + shlex.quote(chunk.replace(" ", "%s")))
            return {"output": self.adb(serial, "shell", " && ".join(commands)) if commands else ""}
        elif action == "key":
            argv = ["shell", "input", "keyevent", args["key"]]
        elif action == "location":
            argv = ["emu", "geo", "fix", str(args["longitude"]), str(args["latitude"])]
        elif action == "logs":
            argv = ["logcat", "-d", "-t", "200"]
        elif action == "shell":
            argv = ["shell", *args["argv"]]
        elif action == "permission":
            if args["state"] == "reset":
                raise Error("Android permissions support grant/revoke; reset is iOS-only.")
            argv = ["shell", "pm", args["state"], args["app"], args["permission"]]
        elif action == "rotate":
            orientation = {"PORTRAIT": "0", "LANDSCAPE_LEFT": "1", "PORTRAIT_UPSIDE_DOWN": "2", "LANDSCAPE_RIGHT": "3"}[args["orientation"]]
            argv = ["shell", "wm", "user-rotation", "lock", orientation]
        elif action in ("push", "pull"):
            if "app" in args:
                raise Error("Android file operations use absolute guest paths, without an app argument.")
            if not args["path"].startswith("/"):
                raise Error("Android file paths must be absolute guest paths.")
            temporary = folder / ("transfer-" + request["id"])
            try:
                if action == "push":
                    temporary.write_bytes(decode_data(args["data"]))
                    return {"output": self.adb(serial, "push", str(temporary), args["path"])}
                # exec-out avoids an unbounded host-side adb pull.
                return encoded(self.adb(serial, "exec-out", "cat", args["path"], binary=True))
            finally:
                temporary.unlink(missing_ok=True)
        else:
            raise Error("Unsupported Android action.")
        if argv[0] == "shell":
            # adb joins shell arguments; quote each to keep text/URLs literal.
            argv = ["shell", " ".join(shlex.quote(x) for x in argv[1:])]
        return {"output": self.adb(serial, *argv)}

    def require_durable_upload(self,image):
        if self.config.get('transferHelperManifest') is None:
            raise Error('Android consumer uploads require a configured native transfer helper.',409,code='capability_unsupported')
        from ..android_transfer import load_helper
        load_helper(self.config,image)

    def stream_upload(self,machine,image,folder,path,app,reader,size,authorized):
        if app or not isinstance(path,str) or not path.startswith('/') or '\x00' in path:
            raise Error('Android uploads require an absolute guest path.',400)
        if self.config.get('transferHelperManifest') is not None:
            from ..android_transfer import upload
            return upload(self,machine,image,folder,path,reader,size,authorized)
        from ..transfers import copy_upload
        import tempfile
        import uuid
        from pathlib import PurePosixPath
        storage=self.storage(machine)
        serial=self.endpoint(machine,storage)
        if not serial:raise Error("Android device is not connected.")
        destination=PurePosixPath(path)
        temporary=str(destination.parent / (".canaveral-upload-"+str(uuid.uuid4())))
        with tempfile.TemporaryFile() as log:
            process=assignment_popen([self.tool("adb"),"-s",serial,"shell","-T","umask 077; set -C; cat > "+shlex.quote(temporary)],
                                     stdin=subprocess.PIPE,stdout=log,stderr=log,env=self.environment())
            committed=False
            try:
                copy_upload(reader,process.stdin,size,authorized)
                process.stdin.close()
                if process.wait(timeout=30)!=0:raise Error("Guest drive could not accept the upload.")
                if not authorized():raise Error("Upload authorization ended.",401)
                self.owned(machine,serial)
                self.adb(serial,"shell","mv -f -- "+shlex.quote(temporary)+" "+shlex.quote(path))
                committed=True
                return {"uploaded":size,"durable":False}
            finally:
                if process.poll() is None:
                    process.terminate()
                    try:process.wait(timeout=2)
                    except subprocess.TimeoutExpired:process.kill();process.wait(timeout=2)
                if not committed:
                    try:self.adb(serial,"shell","rm -f -- "+shlex.quote(temporary))
                    except Exception:pass

    def stream_download(self,machine,image,folder,path,app):
        from ..transfers import Download
        import tempfile,stat,secrets,re
        if app or not path.startswith("/") or "\x00" in path:raise Error("Use an absolute Android guest path.",400)
        serial=self.endpoint(machine,self.storage(machine))
        if not serial:raise Error("Device is not connected.")
        self.owned(machine,serial)
        # Include nanosecond timestamps, not the second-resolution %Y/%Z.
        command="stat -L -c '%d|%i|%f|%s|%y|%z' -- "
        info=self.adb(serial,"shell",command+shlex.quote(path)).strip()
        fields=info.split('|')
        try:
            if len(info)>1024 or len(fields)!=6 or '\n' in info or not all(fields):raise ValueError()
            if not all(fields[i].isdigit() for i in (0,1,3)) or not stat.S_ISREG(int(fields[2],16)):raise ValueError()
            if not all(re.fullmatch(r'\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{9} [+-]\d{4}',fields[i]) for i in (4,5)):raise ValueError()
            size=int(fields[3])
        except (ValueError,IndexError):raise Error('Android download requires verifiable regular-file metadata.',409)
        marker=('\ncanaveral-download-complete-'+secrets.token_hex(16)+'\n').encode()
        expected=shlex.quote(info)
        # adb exec-out does not propagate remote exit status. The marker is sent
        # only after both descriptor and path checks; it is never file payload.
        script=('exec 3< '+shlex.quote(path)+' || exit 1\n'
                'check_fd() { current=$('+command+'/proc/self/fd/3) && [ "$current" = '+expected+' ]; }\n'
                'check_fd || exit 1\ncat <&3 || exit 1\ncheck_fd || exit 1\n'
                'current=$('+command+shlex.quote(path)+') || exit 1\n'
                '[ "$current" = '+expected+' ] || exit 1\n'
                "printf '%s' "+shlex.quote(marker.decode()))
        log=tempfile.TemporaryFile()
        try:
            process=assignment_popen([self.tool("adb"),"-s",serial,"exec-out","sh","-c",script],stdout=subprocess.PIPE,stderr=log,env=self.environment())
        except Exception:
            log.close();raise
        remaining=[size];completed=[False]
        class Reader:
            def read(self,count):
                data=process.stdout.read(min(count,remaining[0]))
                remaining[0]-=len(data)
                return data
            def close(self):process.stdout.close()
        def verify():
            self.owned(machine,serial)
            if remaining[0]==0 and not completed[0]:
                try:status=process.wait(timeout=30)
                except subprocess.TimeoutExpired:raise Error('Android download completion is uncertain.',409)
                if status!=0 or process.stdout.read(len(marker)+1)!=marker:raise Error('Android download source changed or completion was not verified.',409)
                completed[0]=True
            if self.adb(serial,'shell',command+shlex.quote(path)).strip()!=info:raise Error('Android download source identity changed.',409)
            return True
        def close():
            if process.poll() is None:
                process.terminate()
                try:process.wait(timeout=2)
                except subprocess.TimeoutExpired:process.kill();process.wait(timeout=2)
            log.close()
        return Download(Reader(),size,close,verify)
