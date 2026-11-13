# Operator-only Apple Linux acceptance

ST-534's native harness is `run.ts`. It is outside the build/test globs and refuses CI or a missing explicit authorization environment variable. It uses the production controller, runner identity client, Rust satellite and signed helper. It never uses a fixture clock, fake helper or simulated filesystem builder. No service is installed.

Build coordination and the Rust binaries first. Build/sign the production helper using `script/build_apple_runner.sh` with the operator's full Xcode environment and stable Apple Development identity. Install it privately without write bits, as required by satellite preflight. Do not put signing identities or local account details in a committed configuration.

From the repository root, create a private JSON configuration outside the checkout:

```json
{
  "stateRoot": "/ABS/private-evidence-root",
  "helper": "/ABS/CanaveralVMRunner",
  "satellite": "/ABS/canaveral-apple-satellite",
  "runnerClient": "/ABS/canaveral-runner-client",
  "manifest": "/ABS/installed-bundle/manifest.json",
  "bundleDigest": "sha256:REPLACE_WITH_CANONICAL_MANIFEST_DIGEST",
  "builder": "/ABS/mkfs.erofs",
  "signingRequirement": "REPLACE_WITH_OPERATOR_APPLE_DESIGNATED_REQUIREMENT",
  "cpu": 2,
  "memoryMiB": 2048,
  "diskGiB": 4,
  "operatorDenyCidrsFile": "/ABS/private-operator-deny-cidrs.json",
  "setupOnly": false
}
```

The operator deny-list file must have mode 0600 and contain `{ "version": 1, "operatorDenyCidrs": ["CIDR"] }` with 1–4096 canonical network CIDRs. The original unversioned v1 format remains supported; other explicit versions are refused. Filesystem and validation failures expose fixed diagnostics only. The harness passes the list to the satellite and probes configured network addresses on port 443 only when the shipped, digest-verified special-purpose and IPv6 allocation tables would otherwise allow them and fresh host interface evidence excludes them. At least one such target must qualify; built-in denials alone fail acceptance. Every qualifying probe must return `403 destination_denied`; CONNECT success or a route denial fails. This proves address-policy discrimination, not route reachability or full topology isolation. Keep policy values in private runtime configuration; copied evidence contains only count, SHA256 digest and aggregate outcomes.

`bundleDigest` is the Rust guest-protocol canonical manifest digest, not the hash of the JSON file. Artifacts must already satisfy the production immutable installation contract. The harness pins the exact helper and builder bytes; it does not build or repair artifacts, alter admission, or set flags to bypass installation checks. An optional `bootstrap` path is also screened for fixture markers when supplied. The builder and all boot artifacts are screened, including known embedded markers in renamed fixture binaries. This screen is an extra refusal boundary, not an attestation that arbitrary operator binaries are trustworthy. The satellite's full signature, pin, path, ownership and immutability checks remain authoritative.

```sh
CANAVERAL_NATIVE_ACCEPTANCE=operator-authorized \
  node coordination/native-acceptance/run.ts /ABS/private-config.json
```

Node >=24, macOS, `openssl`, `codesign`, `ps`, and the satellite's production prerequisites (including `lsof`) are required. The printed directory is unique per invocation. Keep it private: raw configuration, credentials, operational output and receipts stay under `private/`. Files outside `private/` contain allow-listed outcomes, numeric attributed process metadata, console milestones and digests. Proxy evidence filenames use role labels. Never commit native evidence. There is no evidence upload.

For setup without boot artifacts, set `setupOnly: true`, supply a nonexistent manifest path and an explicitly unverified expected `bundleDigest`; `builder` may be omitted. This exercises actual controller startup, fresh state, TLS, application creation, enrollment, domain/image/grant/approval configuration and catalog reads, then stops without acquiring or claiming anything. The expected digest is catalog configuration only: `artifactVerified: false` and `nativeAcceptance: false` prevent treating this as image verification. Setup-only stops before native execution even when artifacts exist.

A workspace run first submits two `linux-lease` box requests into a one-box domain. It proves the second waits without a lease or reservation, runs a command in each box in turn, and checks positive cleanup before starting the successor. A full run uses one guest at a time: acquire/readiness, consumer command/output, renewal, explicit release, a second guest's real wall-clock expiry, then satellite crash/recovery and reservation retention. Application 2 has no grant; cross-application inspect/key issuance/operation submission and acquisition must fail. Renewal must include a successful consumer command after the original expiry plus
the two-second guest margin; helper authorization alone is insufficient. There is
no synthetic guest response. The final loss case kills the satellite, waits past the lease deadline without
restarting it, proves helper PID and VZ absence with no power-off request, records
stop timing relative to the deadline, and only then starts recovery. It retains the unknown reservation and owned state for operator reconciliation; it never forges cleanup or resets the journal. That retained reservation is an expected result, not reclaimed capacity.

Evidence includes controller/domain views, report bodies and domain counts around report forwarding, journal revisions, helper signature/entitlements/cdhash, helper and mkfs.erofs SHA256 pins, command receipt and the helper's real serial console copied as `<lease>-boot.log`. Successful release/expiry additionally requires observed helper PIDs gone, workspace/machine and published relay directories removed, durable stop/cleanup/release flags and zero reservations after the complete cleanup report. The independent process check conservatively refuses **any** remaining `com.apple.Virtualization.VirtualMachine` process because process names alone cannot attribute it to a particular VM. It never stops or inspects unrelated VM storage. Existing VMs can therefore block this check; run on a quiescent host or obtain separate attribution evidence before changing the criterion.

A failed full run preserves evidence and state, requests lease release, and stops its own controller/satellite processes. Release intent is not cleanup proof. The helper's deadline remains the independent fence; inspect failure evidence before rerunning. A new invocation always creates a new controller database, never adopts the old state, and must not be used to evade an unresolved physical reservation.

## Session diagnostic

`session-probe.swift` is a separate operator-only diagnostic, not a helper command or lease admission path. Compile it with full Xcode's `swiftc -parse-as-library`, sign it with the same Apple Development identity and `VirtualMachines/Virtualization.entitlements`, and invoke it with a file containing exactly `invalid-canaveral-probe-kernel` plus a newline. It validates a minimal 2 CPU/2 GiB direct-kernel configuration and records the invalid-image start failure. It then starts/stops an EFI firmware-only configuration without any guest disk and removes its fresh variable store. A 15-second bound fails closed on a stalled probe. Run it in each intended execution context and keep the resulting logs local. Invalid-image rejection alone does not establish VZ start admission; `efi-started` and `efi-stopped` establish only firmware start/stop, never Linux boot, guest readiness, helper relay behavior or positive lease cleanup.

To typecheck the standalone harness without adding it to ordinary tests:

```sh
coordination/node_modules/.bin/tsc --noEmit --target ES2023 --module NodeNext \
  --moduleResolution NodeNext --allowImportingTsExtensions --strict --types node \
  --typeRoots coordination/node_modules/@types coordination/native-acceptance/run.ts
```

## ST-534 native integration evidence (2026-11-12)

An operator-authorized arm64 Mac run used the production signed helper, Linux
6.12.117, the experimental Debian snapshot rootfs and native erofs-utils 1.8.6.
The diagnostic initrd printed `CANAVERAL-DIAGNOSTIC-ONLY-v1` and the launch disk's
20-hex UUID-prefix serial. A fast shutdown exposed lost console output: the
helper now drains pending serial bytes on close and saves a final transcript.
A socket-free portable Swift test covers immediate close with pending bytes.

The first full boot exposed the host builder's 16 KiB block-size default; the
satellite now explicitly requests `-b4096`, covered by its fixed-argv regression
and strict fixture builder. Bootstrap subsequently mounted the real launch
medium and reached guest readiness. The first command exposed missing
`CONFIG_PROC_CHILDREN`, required by PID1 orphan supervision. The kernel fragment
now enables it; the recipe checks the resolved built-in. The fragment also uses
Kconfig's effective `CONFIG_DEBUG_INFO_NONE=y` choice so the recipe can verify
that requirement. The harness consumes the HTTP acquisition response directly
(the SDK wraps it), waits for terminal command states, and captures each guest's
actual mountinfo through the consumer command route.

Native observations apply to this experimental bundle and host only. Production
trust/signing approval, networking, file transfer, shared read-only rootfs across
concurrent VMs, power-loss recovery and the ordinary host lease gate remain open.

The corrected experimental bundle's canonical digest is
`20f1103284c2657207c2feed20f0de9fa3fda1068deb5759ceded7e92691d8a4`.
Private run `canaveral-native-CQg8Em` contains `release-ready.json`, `command.json`,
`renewed-native-authorization.json`, `release-independent-stop.json`, ownership
refusal responses, per-lease boot logs, `release-mountinfo.txt`,
`expiry-mountinfo.txt`, `helper-signature.txt` (helper cdhash) and `pins.json`
(helper and mkfs.erofs SHA256). The diagnostic evidence is in `diagnostic-2`.
These are local evidence labels, not repository artifacts or public downloads.
Acquisition/readiness, consumer command/output, native renewal, explicit release
and application isolation passed. Guest mountinfo showed a separate EROFS launch
mount with `ro,nosuid,nodev,noexec` in both full guests.

### Deadline classification and full rerun (ST-534)

The earlier run's expiry failure is superseded by private run
`canaveral-native-pQM3pq`. The controller now accepts `failure: deadline` within
10 seconds of its deadline as expiry. This covers the two-second guest margin,
one-second report cadence and seven seconds of bounded scheduling/skew allowance.
Linux acquisition and renewal now require at least 30 seconds; smaller TTLs or
acquisition defaults/maximums below that return 400 `linux_ttl_below_minimum`.
This change is confined to the Linux path. The satellite journals the first stop
cause: controller terminal stop reports null, deadline reports deadline, and
unexpected execution loss reports runtime. No deadline or cleanup check is relaxed.

One operator-authorized full run passed, using one 2 CPU / 2 GiB guest at a time:

- Acquisition/readiness: `release-ready.json` and `release-ready.journal.json`.
- Consumer command/output: `command.json`; native renewal:
  `renewed-native-authorization.json` and `renewed.json`.
- Explicit release: `release-independent-stop.json`, `release-after.json`.
  Both stopped and complete-cleanup receipts report `failure: null`.
- Expiry: `expiry-independent-stop.json`, `expiry-after.json` and
  `runner-reports.json`. The first stopped deadline receipt ended the lease as
  `expired` at controller time `1794487297.658`, before the stored deadline
  `1794487299.13`. Its reservation stayed at one until the complete cleanup
  receipt, then became zero. Independent PID, VZ absence, removed machine,
  workspace and relay evidence passed for both release and expiry.
- Satellite loss: `loss-held.json`, `loss-held.journal.json` and
  `loss-independent-fence.json`. Recovery refused relaunch and reported unknown
  runtime. The controller retained one reservation and denied further admission.
  The owned helper was positively stopped through its fenced authorization and
  power-off path; independent PID and VZ absence checks passed.
- Application-2 isolation: `ownership-GET-<lease-id>.json`,
  `ownership-POST-credential.json`, `ownership-POST-operations.json`; its
  acquisition without a grant also returned 403. Every guest's consumer mountinfo
  command confirmed a separate EROFS launch mount with `ro,nosuid,nodev,noexec`.

`result.json` records completion of these experimental native cases. The
controller and satellite processes were stopped. After independent process,
helper-lock and empty lsof checks, the loss guest's owned machine/workspace and
published relay were removed; its owned user-immutable launch medium was cleared
only after stop, as in production cleanup. `loss-post-run-owned-cleanup.json`
records this external cleanup. The satellite journal was not changed to claim
stop/cleanup and no cleanup receipt was fabricated.

The isolated, stopped controller database still holds the loss lease as
`failed`, runtime `unknown`, cleanup `pending`: one reservation for 2 CPU,
2048 MiB memory and 4 GiB disk. Keep its private database, binding/journal and
proofs for operator reconciliation. An operator must correlate that exact
assignment and binding with the independent stop, handle and removal evidence
before recording cleanup and releasing capacity through a separately reviewed
reconciliation implementation. That recovery operation is not implemented;
restarting the satellite or controller does not reclaim it. Do not reset the
journal, forge a report or edit reservation rows to manufacture acceptance.

The full Rust suite passed serially; coordination typecheck/build and all 995
tests passed. Standalone native harness typecheck passed. A stalled-controller
fixture now allows preparation/dispatch before the guest margin; its stall,
local fencing and command-count assertions remain intact. No Swift code changed.
This acceptance applies only to this experimental bundle and host: production
trust/signing approval, networking, PTY/files, concurrent shared-rootfs use,
power-loss reconciliation and ordinary host lease admission remain separate gates.

### Independent review corrections (ST-534, 2026-11-12)

The earlier `pQM3pq` loss case restarted the satellite before proving stop, so
its power-off request did not establish autonomous helper fencing. Its renewal
authorization receipt also did not establish guest renewal. The corrected
harness requires the independent timing and post-deadline command described above.

Portable regressions cover guest-pump/reply errors after authority lapse, observed
process exit taking priority over the final margin, terminal poll returning Ok,
controller-stop priority, legacy no-cause journal replay, stale deadline reports
after controller renewal, provisioning failure followed by a deadline report,
and additive failure-reason migration with a populated lease ledger.

The Rust distribution and host erofs-utils source archives now require signature
authentication. The exact existing archive hashes verified unchanged; installed
experimental artifacts were retained without rebuilding. No Swift source or
signing identity changed.

Final-binary run `canaveral-native-qkkyiZ` passed all cases with one 2 CPU / 2 GiB
VM at a time. `release-ready.json`, `command.json`, ownership refusal receipts,
`release-independent-stop.json` and `expiry-independent-stop.json` cover readiness,
consumer output, isolation, release and expiry. `renewal-post-deadline-command.json`
records a successful command 2.418 seconds after the original expiry. In
`loss-independent-fence.json`, the satellite was killed 103.313 seconds before
the loss deadline; helper PID absence was observed 228 ms after that deadline.
No VZ process or recovery power-off request existed before recovery was launched.
Recovery then reported unknown runtime and held one reservation without claiming
cleanup (`loss-held.json`). `result.json` records completed native cases.

The controller/satellite processes stopped. `loss-post-run-owned-cleanup.json`
records independent PID, VZ, helper-lock and lsof checks, followed by removal of
only the owned workspace, machine and relay; the launch medium's immutable flag
was cleared only after stop. The satellite journal stayed unchanged. The stopped
private controller ledger retains the loss lease as expired, runtime unknown,
cleanup pending, with its reservation held for operator reconciliation. No
cleanup receipt or capacity reclamation was fabricated. The earlier review run
`canaveral-native-L3uYIc` also passed and received the same external cleanup; its
separate stopped private database likewise retains its held reservation.

`signature-authentication/` in the final private evidence directory retains the
Rust signature/key bytes, status logs and Debian authentication chain. Portable
validation passed: coordination typecheck/build and 998 tests; full serial Rust
suite; satellite clippy with warnings denied; standalone harness typecheck; shell
syntax checks and the detached-signature refusal regression. These runs preserve
the experimental scope and all previously listed production acceptance gaps.

### Enforced observation windows (ST-534)

The loss case polls all recorded helper PIDs and requires an alive observation
at or after deadline minus three seconds. The first all-gone observation must
fall between deadline minus 2.5 seconds and deadline plus five seconds. These
bounds account for the guest's two-second early margin, polling jitter and
bounded native shutdown observation; the helper's own fence targets the deadline.
A helper that disappears well before expiry cannot pass. Immediately before
restarting recovery, the harness rechecks that no power-off request exists and
the last native authorization remains unfenced. The helper's autonomous
`lease-fenced.json` is expected and is distinct from a recovery request.

Renewal requires exactly the next controller revision and the requested 180-second
expiry, matching mutation and lease views. The native authorization must reach
that exact revision. After original expiry plus the guest margin, the command
must succeed while the same renewed revision and expiry remain current.
`renewal-post-deadline-command.json` records both. The wait has an explicit bound
derived from the original expiry, so the default polling timeout cannot preempt it.

Full run `canaveral-native-9Tdxt4` passed these tightened assertions on 2026-11-12,
with one 2 CPU / 2 GiB guest at a time. The loss helper was observed alive 53 ms
after its deadline and stopped 255 ms after it. The post-original-deadline
command succeeded 2.471 seconds after original expiry under renewed revision 3.
The private run retains `loss-independent-fence.json`,
`renewal-post-deadline-command.json`, `result.json` and
`loss-post-run-owned-cleanup.json`. Independent PID, VZ, runtime-lock and empty
lsof checks preceded removal of the owned workspace/machine and relay. The
satellite journal was unchanged; its stopped private controller DB retains the
expired loss lease with runtime unknown, cleanup pending and one reservation.
No cleanup receipt or capacity reclamation was fabricated.

The complete source/package authentication gate passed against the retained
experimental inputs, including all 117 Debian packages; signature status, public
key material, chain indexes and `authenticated-inputs.json` are retained under
`signature-authentication/`. Archive byte pins were unchanged, so no boot
artifacts were rebuilt. The disposable signature-verification VM was stopped
before native acceptance and deleted afterward. Portable validation passed:
coordination typecheck/build and 998 tests, the full serial Rust suite, satellite
clippy with warnings denied, standalone harness typecheck, six signature-gate
regressions and shell syntax checks. These results retain the experimental scope
and all previously listed production acceptance gaps.

For a separately authorized workspace-v2 run, set `workspaceIOVersion:1` in the
private configuration. Supply `cloneRepo` (public HTTPS repository), `cloneCommit`
(full pinned commit), `hostLanTarget`, `hostTailnetTarget`, and
`hostLoopbackTarget` (CONNECT authorities including `:443`). Keep all values in
that private file. The bundle must include git, npm, nc, dd and the pinned CA
store; the repository must include its npm lockfile and tests. This mode adds
public-route build/log retrieval, empty/binary/300 KiB file round trips,
no-replace/disk-full failures, foreign application denial, fixed proxy denial
codes, egress-off refusal and simultaneous command/transfer expiry. Cleanup
interception requires both workspaceRemoved and dataPlaneClosed before capacity
release. Existing v1 cases also run. Experimental results below distinguish passed public
HTTPS/transfer cases from remaining data-only disconnect, route-change/hairpin
topology and host power-loss durability gates. Full production acceptance remains false.

## ST-535 native evidence (2026-11-12)

Private run GcetDy
completed all harness groups using source `4e483db`, the signed production helper,
one 2 CPU / 4096 MiB / 8 GiB workspace-v2 guest at a time, and bundle digest
`af15f8ef1bc964874f939f2c7390de64ccd8717fba2d2aac24279b028a71ba11`.
`result.json` correctly records **nativeAcceptance:false** with two failed cases:
allowed CONNECT and clone/npm. `productionBuildReady` remains false.

The disposable VZ builder stayed within 4 CPU / 8 GiB / 40 GiB. Both assemblies
matched. All 119 Debian archives, including the ten-package e2fsprogs
`1.47.0-2+b2:arm64` closure in `formatter-pins.json`, verified against the pinned
signed snapshot Release → Packages chain. Source signature status, keys and
package evidence are in `signature-authentication/`. Installed boot data is
0400/user-immutable. No signing identity or private configuration is recorded here.

Native results:

- Workspace serial/size discovery, ext4 format/mount, both vsock handshakes and
  files readiness passed (`workspace-ready.json`, `workspace-mountinfo.txt`).
- Upload/download round trips passed for 0, 4 and 307200 bytes; exact SHA256 values
  and committed/verified outcomes are in `roundtrip-*-verified.json`. No-replace
  returned `destination_exists`; filling the disk returned a durable `disk_full`
  receipt (`workspace-destination_exists.json`, `workspace-disk_full.json`).
- Host LAN, host tailnet, loopback, metadata and RFC1918 targets returned 403
  `destination_denied`; port 80 returned `port_denied` (`proxy-*.json`). The
  foreign application was denied (`workspace-second-tenant-denial.json`). The
  egress-off guest returned `egress_denied` and cleaned up independently.
- Public CONNECT returned 403 `route_denied`. The kernel changed from a default
  route before connect to a cloned /32 after connect. That route remains denied
  under the unchanged contract (`route-clone-diagnostic.stderr`). Clone of the
  public JavaScript action example, pinned to
  `67f3f118c7d8bf535280cf0b61697b1898f6567b`, failed with exit 128 in 44 ms.
  Guest commit verification, npm ci/test and build-log retrieval were not reached.
- Expiry interrupted a dispatched sleep command and an opened, uncommitted upload:
  command `unknown`, upload `failed/authorization_lost`
  (`workspace-expiry-command-dispatch.json`, `workspace-expiry-transfer-opened.json`,
  `workspace-expiry-terminal.json`). This tests an active upload across expiry,
  not an interrupted publication syscall.
- The v1 lifecycle cases against this v2 bundle passed: readiness, command/output,
  application isolation, renewal (command 3.146 seconds after original expiry),
  explicit release and ordinary expiry. Every successful cleanup/reclamation
  required `workspaceRemoved` and `dataPlaneClosed` (`*-independent-stop.json`,
  `runner-reports.json`, `renewal-post-deadline-command.json`).
- Satellite loss passed autonomous fencing: helper alive 26 ms before its
  deadline, absent 176 ms after it, before any recovery request. Recovery held
  one reservation with unknown runtime (`loss-independent-fence.json`,
  `loss-held.json`).

Native defects fixed: Kconfig omits virtio-net when NETDEVICES is disabled;
Rust acronym casing rejected workspaceIOVersion; redundant host environment
injection tripped the guest's override refusal; Darwin compact host netmasks
were rejected; known denied destinations were hidden by route lookup failures;
file-worker fsuid/fsgid changes left root credentials/capabilities. Regressions
include `workspace_assignment_uses_controller_acronym_spelling`,
`workspace_exec_carries_no_environment_overrides`,
`route_parser_defaults_specific_cloned_and_malformed`,
`forbidden_destination_precedes_unavailable_route_evidence` and
`worker_credential_drop_is_permanent_and_thread_local`. The last test actually
passed in a disposable root-capable Linux namespace (`credential-regression.log`).
The rootfs also gained the required netcat package.

All owned VMs and controller/satellite/helper processes stopped. Independent PID,
VZ, helper-lock and lsof checks preceded external removal of the loss workspace,
machine and relay (`loss-post-run-owned-cleanup.json`). Its journal is unchanged;
its stopped private database retains the expired loss lease, unknown runtime,
pending cleanup and one 2 CPU / 4096 MiB / 8 GiB reservation. No cleanup receipt
was forged. The earlier pre-launch decoder failure was reclaimed through the
normal authenticated decline path, without launching a VM. The disposable
builder was deleted; unrelated VMs were untouched.

Portable validation passed: coordination typecheck/build and 1020 tests, full
serial Rust tests, changed-crate clippy, Linux MUSL guest compilation/clippy,
signature-gate regressions, standalone harness typecheck and no-Python check.
No Swift source changed in that run. The qualified-clone rerun below supersedes
its public HTTPS and replacement gates. Data-only disconnect, route-change/hairpin
topology and host power-loss durability remain separate native gates.


### Qualified-clone full rerun

The final ST-535 integration run on 2026-11-12 supersedes the earlier passing
`canaveral-native-YVunMd` run. Private evidence is
run Vpsi5K;
`result.json` records `nativeAcceptance:true` and no case failures.
Host and guest source is `13bb46b`, integrating `e9e1fc8`, `7fa4bd8` and
`13bb46b`. The rebuilt bundle digest is
`f0b9f6d5d46afbaabf544f9295b3077b496c79dbfb072adbe114ee8466e48fc0`.
The same private configuration and signed helper ran one 2 CPU / 4096 MiB /
approximately 8 GiB guest at a time. Full production and topology acceptance
remain false.

- Public CONNECT returned 200; Git cloned and verified HEAD at
  `67f3f118c7d8bf535280cf0b61697b1898f6567b`
  (`proxy-allowed.json`, `workspace-build.json`).
- npm ci/test passed in 139413/516 ms of guest execution, respectively
  (140044/1074 ms including dispatch/polling). Downloaded build.log begins with
  the verified commit and has SHA256
  `532a42550e33c3869647449bc854920372fb570c65bd6cd3b736a3dffd2d2211`
  (`workspace-npm-{ci,test}.json`, `workspace-build-log.json`).
- Empty, binary and 307200-byte round trips; replace:true with verified
  download; replace:false conflict; and disk_full refusal passed
  (`roundtrip-*-verified.json`, `workspace-replace-true.json`,
  `workspace-destination_exists.json`, `workspace-disk_full.json`).
- Host LAN/tailnet/loopback, metadata/RFC1918, port 80, foreign application and
  egress-off denials passed. Expiry interrupted the dispatched command and
  opened upload: command unknown, upload unknown/authorization_lost, preserving
  uncertain outcomes (`proxy-*.json`, `workspace-expiry-*.json`).
- All v1 lifecycle cases against the v2 bundle passed: readiness, command/output,
  ownership refusal, renewal, explicit release and ordinary expiry. Renewal's
  successful command was observed 2515 ms after original expiry. All five normal
  cleanup cases proved helper/VZ absence and machine/workspace/relay removal;
  capacity release required workspaceRemoved and dataPlaneClosed
  (`*-independent-stop.json`, `runner-reports.json`,
  `renewal-post-deadline-command.json`).
- Satellite-loss fencing passed: helper alive 33 ms before deadline, absent
  168 ms after it, before recovery. Recovery retained one unknown reservation
  (`loss-independent-fence.json`, `loss-held.json`).

The conflict resolution preserves bounded crossed credit after local half-close
on both endpoints and drains already credited data until ordered Close
acknowledgement. Sequence/credit checks, flow accounting and the fixed 10-second
close deadline remain. Both regression groups pass; restoring the old EOF guard
rejects crossed credit, while restoring immediate retirement rejects valid
in-flight data and bypasses the expected sequence/deadline errors. Controller
restart retains opened transfer lanes with cancellation requested; command
timeouts no longer subtract the lease margin or fence an expired-before-exec
command.

Portable validation passed: coordination typecheck/build and 1024 tests
(concurrency 2), 238 serial Rust tests (2 build jobs), satellite/guest clippy
with warnings denied, guest AArch64 MUSL clippy, v1 public API fixture,
standalone harness typecheck, seven signature-gate tests and no-Python checks.
Swift was unchanged. The disposable pinned Lima builder authenticated all inputs
and the package closure; bundle preflight and duplicate assembly comparison
passed. Build/check evidence is in the parent private directory.

All owned VMs, controller/satellite/helper processes, runtime workspace and relay
storage were removed after PID, VZ, helper-lock, inode and lsof checks. The builder
and temporary build/Git copies were deleted; unrelated VMs were untouched.
The loss journal is unchanged; its stopped private database retains one unknown
2 CPU / 4096 MiB / 8 GiB reservation pending operator reconciliation, without a
fabricated cleanup receipt (`loss-post-run-owned-cleanup.json`). Earlier retained
logical reservations and their cleanup proofs in the previous evidence directory
remain unchanged. Route-change monitoring, router hairpin/operator deny CIDRs,
data-only disconnect, power-loss durability, PTY, concurrency, reconciliation
and macOS workspaces remain open.

### Connection-churn regression and native reruns (ST-535 / ST-539)

The 2026-11-12–13 Mac reruns address the intermittent npm data-plane failure
observed in run xEPJmL:
npm ci exited 1 after 70668 ms and satellite stderr recorded `unknown flow`.
The old reactor cleared retired IDs on every Open; a late Close could therefore
terminate the entire data channel. The guest also echoed the acknowledgement of
its own Close. The original native trace does not identify the offending frame.

`socketpair_churn_tolerates_retired_frames` drives the real reactor through 300
flows, alternating close initiators and injecting delayed Close, credit, data
and halfClose frames across subsequent opens. Before the fix it failed with
`unknown flow`. `socketpair_guest_churn_has_no_redundant_close` drives the real
guest state machine through 200 flows; restoring the old guest handler fails
with a redundant Close before the next Open. Both pass with the fix. Existing
live-flow sequence, crossed-credit, half-close, budget and fixed close-deadline
regressions also pass. Retirement now uses the strictly increasing ID high-water
mark and live map, with constant retirement memory; nil/future IDs remain errors.

Cleanup attribution uses observed descendants and VZ open files beneath the
owned workspace, including disks/media beside the helper machine directory.
It retains attributed PIDs across reparenting and fails on survivors or incomplete
lsof evidence. Its portable regression covers unrelated VMs, sibling media,
ancestry, reparenting and adjacent path prefixes. The final native run observed
both helper and launchd-parented VZ PIDs and required their absence on cleanup.

Private evidence set: pr24-churn. Guest runtime source
is `4ecd68e`; later guest/protocol commits only adjust test expectations. The
final host/harness source is `2861955`. A unique disposable Lima VZ builder
(4 CPU / 8 GiB / 40 GiB) rebuilt the guest and rootfs using unchanged pins and
the authenticated unchanged kernel. Complete signature verification passed for
all source inputs and all 119 Debian packages, including the ten-package formatter
closure. Signature/key/chain evidence is in `signature-authentication/`.
Duplicate bundle assemblies matched; installed immutable artifact set pr24-churn has digest
`b8e56af2c3fc6db224b2bc6a272c2260c3a2217e9c8a6c007511b4b452014c14`.
Swift and the signed helper were unchanged.

One 2 CPU / 4096 MiB / approximately 8 GiB guest ran at a time. Full harness
runs `canaveral-native-AwGiRF` (662 s) and `canaveral-native-fcoAtC` (666 s)
record `nativeAcceptance:true` with no case failures. The latter includes the
corrected sibling-media attribution. Both passed workspace transfers, proxy and
ownership denials, egress-off refusal, renewal beyond original expiry, release,
ordinary expiry and autonomous loss fencing. Helpers stopped 86/167 ms after
the respective loss deadlines, before recovery. The separate fresh-guest repeat
`canaveral-native-wr7pUF` passed pinned clone, npm, build-log download and cleanup.
All three verified repository commit `67f3f118c7d8bf535280cf0b61697b1898f6567b`.

Guest npm ci/test execution durations in run order were 131678/525 ms,
134400/526 ms and 135464/528 ms. Including dispatch/polling, these were
132577/1042 ms, 135329/1063 ms and 136040/1253 ms. Each run retains
`workspace-build.json`, `workspace-npm-{ci,test}.json`, `workspace-build-log.json`
and independent cleanup evidence. No data-reactor failure recurred.

All owned controller/satellite/helper/VZ processes, workspace/machine/relay
storage, builder and temporary build/Git/source copies were removed. Both full
runs retain unchanged loss journals and stopped private databases with one
unknown reservation each, pending operator reconciliation; no cleanup receipt
or capacity release was fabricated (`loss-post-run-owned-cleanup.json`).
Unrelated VMs and untracked coordination dependencies were untouched.

Portable validation passed: 242 serial Rust tests with two build jobs;
workspace/all-target clippy with warnings denied; guest AArch64 MUSL clippy;
fmt; coordination typecheck/build and 1026 tests at concurrency two; standalone
harness typecheck and process-attribution regression; seven signature-gate
regressions; no-Python check; and the v1 public-API fixture. These results retain
the experimental scope and previously listed production/topology acceptance gaps.

### Main integration and full native acceptance (2026-11-13)

PR 24 integrates PR 23's squash merge `e9fe93e` through merge commit `9caaabf`.
Operation and transfer polls distinguish lane cancellation from a runtime stop:
rotation, operation failure and transfer uncertainty leave an otherwise eligible
lease running. Unservable active owners receive failure-bearing runtime stops;
terminal leases retain a null failure. Pending runtime receipts and fresh readiness
precede polls. Both acknowledgment paths accept the controller's first terminal
outcome without replacing local uncertainty or replaying guest effects.

The disposable Lima builder used 4 CPU / 8 GiB / 40 GiB and source `9caaabf`.
All source signatures and all 119 Debian archives authenticated under unchanged
pins, including the ten-package e2fsprogs closure. Apt received exact verified
metadata and SHA256-checked archives through the loopback mirror, using only the
pinned-primary keyring. No package bypassed that mirror. Authentication evidence
is retained in the signature-authentication records for evidence set pr24-main.
Preflight and byte-for-byte duplicate bundle assembly passed. Installed immutable
artifact set pr24-main has bundle digest
`1c9a1e93b7a4c3fe419c278f8cfaa79502165a03c7983c66068e30b663cc0216`.
The production helper was rebuilt with full Xcode and signed through the local
session wrapper; no identity details are exported.

Rootfs SHA256 changed from
`cbedf77aadd9291a3fc4c4864f1014fdd2401fce36688874e6cd39e04324ac46` to
`a384225c087544447e357b015fe3bb1c994a74dc7bfbc9cffe7c23acba4d92fe`.
Extracted non-agent file contents match; the rebuilt guest executable differs in
symbol metadata and build ID. Removing symbols and the build-ID note produces
identical executable payloads, SHA256
`b450a066cb1fe2643fb85c06094f360dd771c7a2867cadd6e64fd5c81fcdc532`.
Kernel and initrd digests are unchanged. This establishes the observed binary
cause of the rootfs difference without claiming whole-build reproducibility.

One full native run, vqpCrg,
records `nativeAcceptance:true`, zero case failures, using host `e151061` and
one 2 CPU / 4096 MiB / approximately 8 GiB guest at a time:

- Workspace discovery, ext4 format/mount, both vsock channels and readiness passed.
  Public CONNECT, pinned clone, npm ci/test and build-log download passed. Guest
  npm execution took 137391/517 ms; downloaded log SHA256 is
  `0eee63df96489eaf6c76ca4a1e404942a323664219544436af8e4abf3da9dbd6`.
- Empty, binary and 307200-byte round trips, replacement, no-replace conflict and
  disk-full receipts passed. Host LAN/tailnet/loopback, metadata/private targets,
  port 80, foreign application and egress-off denials passed.
- Active command/upload expiry preserved unknown outcomes; the upload retained
  `authorization_lost`. The v1 command/output, isolation, renewal, release and
  ordinary expiry cases passed. Renewal's command completed 2999 ms after the
  original deadline. All five normal cleanup groups required workspaceRemoved
  and dataPlaneClosed before releasing capacity and independently proved owned
  helper/VZ absence and workspace/machine/relay removal.
- Satellite-loss fencing stopped the helper 316 ms after its deadline, before
  recovery. Recovery retained one unknown reservation. Post-run PID attribution,
  helper-lock and lsof checks preceded external removal of owned residual storage.
  The journal remains unchanged; the stopped private database retains its unknown
  reservation pending operator reconciliation. No cleanup receipt was fabricated.

Raw configuration, process argv, receipts, probe output and build-log bytes stay
under `private/`. Shared JSON uses fixed field/value allowlists; console output
uses the milestone allowlist, and proxy filenames use roles rather than targets.
The final exporter preserves typed cleanup flags and deadlines; shared evidence
was regenerated from private receipts and all 463 files passed checks for IPs,
configured deny targets, private paths and signing identity fields.

Portable checks passed: coordination typecheck/build and 1034 tests at concurrency
two; all 249 Rust tests with two jobs and one test thread; workspace/all-target
clippy and guest AArch64 MUSL clippy with warnings denied; fmt; all 17 Swift tests
selected by `DirectBoot|SerialConsoleTests` under Xcode 27.2.0; nine signature/mirror
regressions; five evidence/process regressions; standalone harness typecheck;
no-Python check; and the v1 public API fixture.

All owned runtime processes and storage, the builder and temporary source/input
and duplicate assembly copies were removed. Installed artifacts and private
acceptance evidence remain. Unrelated VMs and untracked coordination dependencies
were untouched. Production, topology and the previously listed acceptance gaps
remain open.

## Bounded workspace queue evidence (ST-542)

The single full integration run 1RgYle records nativeAcceptance:true and zero
case failures. It uses the installed pr24-main v2 artifact set
unchanged (bundle digest
`1c9a1e93b7a4c3fe419c278f8cfaa79502165a03c7983c66068e30b663cc0216`).
It runs one 2 CPU / 4096 MiB / approximately 8 GiB guest at a time, with
`maxConcurrentBoxes:1` and one box of physical capacity.

- Request 2 waited without a lease or reservation at +16 ms. Box 1 was ready
  and its mountinfo command succeeded at +24831 ms; release was requested at
  +24881 ms and positive cleanup observed at +25714 ms. Request 2 was observed
  admitted at +25719 ms. Its command succeeded at +50585 ms and positive cleanup
  completed at +51456 ms. Both cleanup groups independently proved helper/VZ
  absence and machine/workspace/relay removal (`queue-sequence.json`,
  `queue-*-independent-stop.json`).
- The operator hairpin/site-public-address probe returned 403 destination_denied
  for the one configured target. Policy evidence exports count 1 and SHA256
  `fe3345d9b3c626f6641d504e9b3c4f853ebd73acc2f0b77d5ed0805bc7f240e2`;
  no policy values or probe argv are exported (`operator-hairpin-denial.json`).
- Public CONNECT, pinned clone and npm ci/test passed. Guest npm execution took
  133890/516 ms; including dispatch/polling, 134719/1304 ms. Downloaded build.log
  SHA256 is `bc780bbce9cc05d2a63f67bd31bf018c15eaf5d90d128797c859322e21fa41d0`.
- Empty, binary and 307200-byte file round trips, replacement, no-replace conflict,
  disk-full refusal, workspace command/upload expiry and egress-off denial passed.
  Renewal's consumer command succeeded 3114 ms after the original deadline;
  explicit release proved positive cleanup.

Ordinary expiry and autonomous satellite-loss fencing passed. The helper was
observed alive 39 ms after the loss deadline and absent 241 ms after it, before
recovery. All seven normal cleanup groups required workspaceRemoved and
dataPlaneClosed before capacity release and independently proved owned helper/VZ
absence and machine/workspace/relay removal.

After the run, PID attribution, runtime-lock and empty lsof checks preceded
removal of owned residual workspace/bootstrap and relay storage. The owned launch
medium's user-immutable flag was cleared only after those checks and inode,
ownership and link-count verification. The journal is unchanged and the stopped
private database retains one unknown reservation for operator reconciliation;
no cleanup receipt or capacity release was fabricated
(`loss-post-run-owned-cleanup.json`). All owned runtime processes and storage
are gone. Installed artifacts and private evidence remain; unrelated VMs were
untouched. All 538 shareable files passed checks for configured private values,
private paths and IP addresses; private process logs contain no operator policy
values.

Portable checks passed: coordination typecheck/build, 1037 tests passed and nine
skipped at concurrency two; standalone harness typecheck; six evidence/process
regressions; no-Python check; and the branch diff private-path scan. The full suite used the existing native inference helper configured
explicitly. Rust and Swift are unchanged. Queue milestones and aggregate hairpin results pass the same evidence
allowlist as other receipts; raw configuration and output remain under private/.
Production and topology acceptance remain open.

### Review-fix full rerun (2026-11-13)

Full native run y359Jk passed with `nativeAcceptance:true` and zero case
failures, using the unchanged pr24-main v2 artifacts and resource limits above.
Only one guest ran at a time, including the queue case's two sequential boxes.

- Queue waiting, sequential admission, both readiness commands and independent
  cleanup passed.
- The stricter operator probe passed for one target independently permitted by
  the digest-verified built-in address tables and excluded from fresh host
  interface addresses. Evidence retains only policy count/digest and aggregate
  outcomes. Built-in-denied entries cannot satisfy this case.
- Public CONNECT, pinned clone, npm ci/test and build-log retrieval passed.
  Guest npm execution took 139084/520 ms; downloaded build-log SHA256 is
  `1fce0f4838ae04343cf6406fb85f5f6de1c92fa7ff49e5b72cf50d77476ccf4f`.
- Empty, binary and 307200-byte transfers, replacement/conflict, disk-full,
  tenant isolation, egress-off, active command/upload expiry, v1 commands,
  renewal beyond the original deadline, release and ordinary expiry passed.
- All seven normal cleanup groups independently proved owned helper/VZ absence
  and machine/workspace/relay removal. Autonomous satellite-loss fencing passed:
  helper absence was observed 280 ms after deadline, before recovery.

Post-run process attribution, runtime-lock and empty open-handle checks preceded
removal of owned residual workspace/bootstrap and relay storage. Immutable launch
media flags were cleared only after ownership, inode and link-count verification.
The journal remains unchanged; the stopped private database retains one unknown
reservation for operator reconciliation. No cleanup receipt or capacity release
was fabricated. All owned runtime processes and storage are gone; installed
artifacts and private evidence remain. Unrelated VMs were untouched.

Portable validation passed: coordination typecheck/build, 1037 tests with nine
skipped at concurrency two, standalone harness/test typecheck, eight
evidence/process/policy regressions, no-Python check and private-path diff scan.
The new regressions reject missing/unreadable files, secret-bearing malformed
JSON, wrong shapes/versions, noncanonical CIDRs and excessive counts without
exposing private paths or input through thrown errors, stderr or evidence.
Counterfactual CONNECT success with an omitted operator policy, route-only
denials and built-in-only deny lists fail verification; a qualifying operator
denial passes. Shareable evidence passed address/private-path scanning.
Production and topology acceptance remain open.
