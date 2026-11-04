"""Volatile, bounded PTYs. Session IDs never resume a process after runner restart."""
import os
import base64
import signal
import struct
import subprocess
import threading
import time

from .model import Error


class ShellSessions:
    def __init__(self,popen=None):
        self.popen=popen or subprocess.Popen
        self.sessions = {}
        self.lock = threading.RLock()
        self.revoked = set()
        self.closing = {}

    def open(self, machine, session, argv, env=None):
        import pty
        self.sweep()
        with self.lock:
            if machine in self.revoked:
                raise Error('Shell assignment is permanently fenced.',410)
            key = (machine, session)
            if key in self.sessions or key in self.closing:
                raise Error("Shell session already exists.")
            master, slave = pty.openpty()
            try:
                process = self.popen(argv, stdin=slave, stdout=slave, stderr=slave,
                                           env=env, start_new_session=True, close_fds=True)
            except Exception:
                os.close(master)
                raise
            finally:
                os.close(slave)
            entry = {"process": process, "fd": master, "data": bytearray(), "base": 0,
                     "seen": time.monotonic(), "ended": False}
            os.set_blocking(master, False)
            self.sessions[key] = entry
            threading.Thread(target=self._read, args=(entry,), daemon=True).start()
            return {"session": session}

    def _read(self, entry):
        try:
            while True:
                with self.lock:
                    if entry["ended"]:
                        break
                    try:
                        data = os.read(entry["fd"], 4096)
                    except BlockingIOError:
                        data = None
                    if data == b"":
                        break
                    if data is None:
                        continue_read = True
                    else:
                        continue_read = False
                        entry["data"].extend(data)
                    excess = max(0, len(entry["data"]) - 65536)
                    del entry["data"][:excess]
                    entry["base"] += excess
                if continue_read:
                    time.sleep(0.03)
        except OSError:
            pass
        finally:
            with self.lock:
                entry["ended"] = True

    def control(self, machine, action, args):
        import fcntl
        import termios
        key = (machine, args["session"])
        self.sweep()
        if action == 'shell-close':
            with self.lock:
                if key not in self.sessions:
                    raise Error('Shell is closed or its runner restarted. Open a new session.',404)
                entry=self._detach(key)
            if not self._terminate([entry]):
                raise Error('Shell termination is uncertain; its process remains tracked for cleanup.',409)
            return {'closed':True}
        with self.lock:
            if machine in self.revoked:
                raise Error('Shell assignment is permanently fenced.',410)
            entry = self.sessions.get(key)
            if entry is None:
                raise Error("Shell is closed or its runner restarted. Open a new session.", 404)
            entry["seen"] = time.monotonic()
            if action == "shell-write":
                if entry["ended"]:
                    raise Error("Shell has exited.")
                pending = memoryview(args["text"].encode())
                deadline = time.monotonic() + 1
                while pending:
                    try:
                        pending = pending[os.write(entry["fd"], pending):]
                    except BlockingIOError:
                        if time.monotonic() >= deadline:
                            raise Error("Shell input blocked; some bytes may have been sent. Inspect before retrying.")
                        time.sleep(0.01)
            elif action == "shell-resize":
                fcntl.ioctl(entry["fd"], termios.TIOCSWINSZ,
                            struct.pack("HHHH", args["rows"], args["cols"], 0, 0))
            offset = max(args.get("offset", entry["base"]), entry["base"])
            end = entry["base"] + len(entry["data"])
            return {"data": base64.b64encode(bytes(entry["data"][max(0, offset-entry["base"]):])).decode(),
                    "offset": end, "truncated": args.get("offset", offset) < entry["base"],
                    "exited": entry["ended"], "exitCode": entry["process"].poll()}

    def _detach(self, key):
        """Called under the manager lock; never waits for process termination."""
        entry = self.sessions.pop(key)
        entry["ended"] = True
        entry['key']=key
        self.closing[key]=entry
        return entry

    def _terminate(self, entries):
        requested=list(entries)
        with self.lock:
            entries=[entry for entry in entries if self.closing.get(entry['key']) is entry and not entry.get('terminating')]
            for entry in entries:entry['terminating']=True
        try:self._terminate_processes([entry['process'] for entry in entries])
        finally:
            with self.lock:
                for entry in entries:
                    if not entry.get('fd_closed'):
                        os.close(entry['fd']);entry['fd_closed']=True
                    entry['terminating']=False
                    if self._process_closed(entry['process']) and self.closing.get(entry['key']) is entry:self.closing.pop(entry['key'],None)
        return all(self._process_closed(entry['process']) for entry in requested)

    def _process_closed(self,process):
        if getattr(process,'leased_group',False) is True:return process.group_closed()
        return process.poll() is not None

    def _terminate_processes(self, processes):
        # Signal the whole batch before waiting. Every batch shares one grace
        # period, rather than adding a timeout for each simultaneous shell.
        for process in processes:
            if getattr(process,'leased_group',False) is True:
                # Kill the owned helper group before reaping its leader. A
                # completed leader alone cannot establish descendant shutdown.
                try:process.kill()
                except Exception:pass # Retain uncertain groups in the closing registry.
                continue
            if process.poll() is not None:continue
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except OSError:pass # Keep uncertain live processes in the closing registry.
        deadline=time.monotonic()+2
        for process in processes:
            try:process.wait(timeout=max(0,deadline-time.monotonic()))
            except subprocess.TimeoutExpired:pass
        for process in processes:
            if getattr(process,'leased_group',False) is True:
                if self._process_closed(process):continue
                try:process.kill()
                except Exception:pass
                continue
            if process.poll() is not None:continue
            try:os.killpg(process.pid,signal.SIGKILL)
            except OSError:pass
        deadline=time.monotonic()+2
        for process in processes:
            try:process.wait(timeout=max(0,deadline-time.monotonic()))
            except subprocess.TimeoutExpired:pass

    def revoke(self, machines, wait=True):
        """Permanently reject new PTYs for fenced assignments and close their PTYs.

        Guest processes detached from the PTY require the separate VM execution
        fence. This manager cannot claim that closing an adb client stops them.
        """
        with self.lock:
            self.revoked.update(machines)
            for key in list(self.sessions):
                if key[0] in self.revoked:self._detach(key)
            entries=[entry for key,entry in self.closing.items() if key[0] in self.revoked]
        if wait:return self._terminate(entries)
        elif entries:threading.Thread(target=self._terminate,args=(entries,),daemon=True).start()

    def sweep(self, active=None):
        with self.lock:
            entries=[self._detach(key) for key,entry in list(self.sessions.items())
                     if time.monotonic()-entry['seen']>600 or (active is not None and key[0] not in active)]
            if active is not None:
                entries=list({id(entry):entry for entry in [*entries,*self.closing.values()]}.values())
        self._terminate(entries)
