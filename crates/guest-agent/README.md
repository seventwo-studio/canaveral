# Guest agent

ST-535 workspace boot support is partial. PID1 accepts the closed launch-v2
schema, configures loopback using Linux ioctls, and provisions the independently
identified workspace. V1 retains its tmpfs and control-session behavior.

Workspace discovery uses kernel sysfs serial and size, rejects ambiguous matches,
partitions, holders and any device backing an existing mount (including root and
the launch medium), and checks the opened block descriptor's identity and size.
The entire device must read as zero before formatting. This deliberately stricter
fresh-media rule rejects unknown signatures and backup metadata without adding a
signature-library dependency; it adds one sequential read of the whole disk to
boot latency. Read errors and premature EOF fail boot. No force or reuse path is
provided. The pinned `/usr/sbin/mkfs.ext4 -V` stderr first line is checked before
formatting; formatting runs once with a bounded timeout. Failure never retries.
Formatting and mounting use PID1's pinned device descriptor via procfs.

The ext4 mount must be writable, executable, nosuid and nodev on the expected
device. Workspace and `.canaveral`, `home`, `tmp`, `.npm` are uid/gid 1000 mode
0700. PID1 pins the workspace root and probes strict openat2 confinement support.
Any provisioning failure fails boot.

**V2 currently fails boot after successful provisioning**, with an explicit data
handshake not implemented error. It never enters the legacy reactor or advertises
command/files readiness. This gate must remain until control and data handshakes
both complete. Do not relaunch a consumed boot attempt: an already formatted
workspace will be rejected on subsequent provisioning.

Remaining ST-535 work includes the HOST_CID-only one-shot data listener and
handshake, independent bounded data reactor, loopback CONNECT listener, trusted
v2 command environment and negotiated transfer refusal/dispatch hook. The closed
`guest-protocol::data::Frame` schema currently has no files-unavailable refusal or
capability signal. Agree an additive signal with the satellite before enabling
v2 readiness; do not substitute failed `io_error` transfer receipts. File execution
and durable publication remain a separate later deliverable.

Portable tests and a Linux cross-build establish no native acceptance. An
authorized native run must verify actual sysfs serial/device provenance, zero
media, formatting without prompts, pinned mkfs version, ext4 flags/ownership,
openat2 support, loopback address and route, boot failures on ambiguous/used disks,
and fresh-attempt behavior. Full data/control/proxy acceptance remains pending.
