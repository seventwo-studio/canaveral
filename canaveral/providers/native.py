import platform

from .base import Provider
from ..model import Error


class Native(Provider):
    """Inference-only host; mixed hosts use their existing VM provider."""

    def check(self):
        if platform.system() not in ("Darwin", "Linux"):
            raise Error("Embedded inference currently supports native Mac and Linux hosts.")

    def reconcile(self, machine, image, folder):
        raise Error("The native inference provider cannot run VMs.")
