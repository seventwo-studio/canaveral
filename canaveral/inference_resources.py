"""Cache-aware host admission with resource safeguards."""
import os
import platform
import re
import shutil
import subprocess
import time
from collections import deque
from pathlib import Path

from .model import Error


MiB = 1024 ** 2
GiB = 1024 ** 3


def command(*args):
    try:
        return subprocess.check_output(args, timeout=3, env={"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LC_ALL": "C"}).decode()
    except (OSError, subprocess.SubprocessError, UnicodeError):
        raise Error("Host memory telemetry is unavailable.")


def memory_sample():
    system = platform.system()
    if system == "Darwin":
        output = command("/usr/bin/vm_stat")
        page = int(re.search(r"page size of (\d+) bytes", output)[1])
        counts = {key: int(value) for key, value in re.findall(r"^(.+?):\s+(\d+)\.", output, re.M)}
        physical = int(command("/usr/sbin/sysctl", "-n", "hw.memsize"))
        capacity = max(0, physical - page * (counts["Pages wired down"] + counts["Pages occupied by compressor"]))
        free = min(page * counts["Pages free"], capacity)
        # Free includes speculative pages, which also appear in file-backed pages.
        cache = min(page * max(0, counts["File-backed pages"] - counts["Pages speculative"]), capacity - free)
        purgeable = min(page * counts["Pages purgeable"], capacity - free - cache)
        available = free + cache + purgeable
        normal = int(command("/usr/sbin/sysctl", "-n", "kern.memorystatus_vm_pressure_level")) == 1
        writes = counts["Swapouts"] * page
    elif system == "Linux":
        info = {key: int(value) * 1024 for key, value in re.findall(r"^(\w+):\s+(\d+) kB", Path("/proc/meminfo").read_text(), re.M)}
        physical, available = info["MemTotal"], info["MemAvailable"]
        counters = dict(line.split() for line in Path("/proc/vmstat").read_text().splitlines())
        writes = int(counters["pswpout"]) * os.sysconf("SC_PAGE_SIZE")
        # MemAvailable already estimates safely reclaimable cache on Linux.
        normal = available >= max(2 * GiB, physical // 10)
    else:
        raise Error("Host memory admission currently supports Mac and Linux only.")
    if not 0 <= available <= physical or physical <= 0:
        raise Error("Invalid host memory telemetry.")
    return physical, available, normal, writes


class ResourceGuard:
    def __init__(self, directory, sample=memory_sample, clock=time.monotonic):
        self.directory, self.sample, self.clock = directory, sample, clock
        self.history = deque(maxlen=64)

    def restriction(self, budget_mib, running=False):
        try:
            physical, available, normal, written = self.sample()
            now = self.clock()
            if self.history and (written < self.history[-1][1] or now < self.history[-1][0]):
                self.history.clear()
            self.history.append((now, written))
            while len(self.history) > 1 and self.history[1][0] <= now - 30:
                self.history.popleft()
            if len(self.history) < 2:
                return "Collecting a baseline for active swap traffic."
            if not normal:
                return "Waiting for normal system memory pressure."
            if written - self.history[0][1] >= 32 * MiB:
                return "Waiting for SSD swap activity to settle."
            headroom = max(2 * GiB, physical // 10)
            # Loaded weights already reduce available memory; do not count them twice.
            required = headroom + (0 if running else budget_mib * MiB)
            if available < required:
                return "Waiting for RAM after reclaimable cache and system headroom."
            if shutil.disk_usage(self.directory).free < 2 * GiB:
                return "Waiting for at least 2 GiB of free disk space."
        except (Error, OSError, ValueError, KeyError, TypeError):
            return "Host memory or disk telemetry is unavailable."
        return None
