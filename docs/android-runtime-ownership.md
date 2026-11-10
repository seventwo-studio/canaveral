# Android runtime resource ownership

New Android launches write a version 2 private `launch.json` with a boot UUID,
machine and lease binding, assignment fingerprint, exact launch arguments,
attempt time and PID. A process creation time is added only when the runner can
establish that the PID is its unreaped direct child, with matching UID and a
creation time consistent with that launch. Missing process metadata does not
retry or terminate an otherwise successful launch. The child handle is retained
before publishing the final receipt; a publication failure retains the original
launch intent and prevents automatic relaunch.

## Read-only attribution

The resource sampler can recover the emulator after a runner restart without
calling ADB, enumerating devices, creating storage or writing receipts. It requires:

- Matching assignment and storage fingerprints.
- A complete version 2 launch with the current machine and lease identity.
- The owned AVD creation name and reserved console port.
- The exact current CPU, memory, AVD and port arguments.
- The recorded process birth time, current UID and an accepted SDK executable.

The launcher can replace itself with QEMU while preserving its process identity.
The collector accepts the configured SDK's `emulator` binary and the matching
QEMU or headless QEMU layout for macOS/Linux and ARM64/x86-64. Executable paths
must resolve inside that SDK. Other architectures, SDKs, altered command lines,
reused PIDs and inaccessible identities remain unknown. The upstream layout and
argument behavior are documented in the
[Android launcher source](https://android.googlesource.com/platform/external/qemu/+/refs/heads/emu-35-3-release/android/emulator/main-emulator.cpp),
checked 2026-11-03, blob `be5c405652cd358ad1947cd8cf009d848257c081`.
Installed SDK compatibility still needs native acceptance.

Verified descendants join the simulator category with their own creation times
and UID checks. The root identity is checked again after collection, and the
shared sampler verifies birth times again after reading CPU/RSS. A process also
present in the runner tree is measured once. A disappearing or inaccessible
descendant makes the category unknown rather than reporting a partial zero.
No global process-name scan discovers ownership.

Legacy, incomplete and contradictory launch receipts remain unmeasurable. They
are not silently upgraded or adopted. A missing root stays unknown while its
machine is active or uncertain; an observed stopped machine with a positively
absent root adds no observed usage. A stopped assignment without a launch still
requires matching storage and assignment ownership before reporting absence.

This is process accounting, not execution fencing or a cleanup receipt. It does
not prove that every detached helper has exited, guest data is erased, quota can
be released or an expired lease has stopped. It changes no controller admission,
installed SDK, enrollment, machine lifecycle or host limits. Ordinary consumer
execution remains gated.

## Verification

Eleven isolated fixtures cover launcher/QEMU/headless layouts, Linux x86-64,
unrecognized hosts, restart observation without writes, exact identity and lease
checks, descendant ownership, duplicate measurement, PID reuse during RSS reads,
missing processes, malformed/legacy/nonregular receipts, SDK symlink escape,
child birth capture and failed final receipt publication. SDK/process collectors
and launches are fakes operating on temporary files. No existing emulator or live
host inventory was read or changed. Native attribution across an actual runner
restart and the other providers remain acceptance gates.
