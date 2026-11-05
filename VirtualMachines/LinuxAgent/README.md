# Preserved Python guest worker alternative

This is the older guest-only Python agent and its systemd unit, retained as a
separate implementation from the Rust guest runtime. It uses a private vsock
host relay, SQLite task state and a worker-only service. The companion
`Sources/CanaveralMachines/LinuxAgentVM.swift` builds a networkless EFI guest
and cloud-init seed for this protocol. No application UI or current satellite
is wired to this implementation by this preservation change.

Source: local Canaveral revision `6ea08034326d`, preserved on 2026-11-05.
The original Seven service/user/path names are retained to keep the paired
bootstrap and service contract consistent. Source and tests are unchanged.

Run `python3 -m unittest discover -s VirtualMachines/LinuxAgent -p 'test_*.py'`
from the repository root. All 30 tests pass locally. These tests use fixture
relays and temporary state. Actual EFI provisioning, vsock, shutdown, resource
ownership and current controller integration require review and native testing.
No VM image, guest state, credentials or provenance archive accompanies this
source. Do not treat this alternative as production acceptance or as a
replacement for the current Rust guest path.
