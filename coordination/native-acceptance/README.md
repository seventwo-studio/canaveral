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
  "setupOnly": false
}
```

`bundleDigest` is the Rust guest-protocol canonical manifest digest, not the hash of the JSON file. Artifacts must already satisfy the production immutable installation contract. The harness pins the exact helper and builder bytes; it does not build or repair artifacts, alter admission, or set flags to bypass installation checks. An optional `bootstrap` path is also screened for fixture markers when supplied. The builder and all boot artifacts are screened, including known embedded markers in renamed fixture binaries. This screen is an extra refusal boundary, not an attestation that arbitrary operator binaries are trustworthy. The satellite's full signature, pin, path, ownership and immutability checks remain authoritative.

```sh
CANAVERAL_NATIVE_ACCEPTANCE=operator-authorized \
  node coordination/native-acceptance/run.ts /ABS/private-config.json
```

Node >=24, macOS, `openssl`, `codesign`, `ps`, and the satellite's production prerequisites (including `lsof`) are required. The printed directory is unique per invocation. Keep it private: it contains local CA keys, administrator and enrolled identity credentials, the isolated SQLite state, command output and detailed signature evidence. Never commit it. There is no evidence upload.

For setup without boot artifacts, set `setupOnly: true`, supply a nonexistent manifest path and an explicitly unverified expected `bundleDigest`; `builder` may be omitted. This exercises actual controller startup, fresh state, TLS, application creation, enrollment, domain/image/grant/approval configuration and catalog reads, then stops without acquiring or claiming anything. The expected digest is catalog configuration only: `artifactVerified: false` and `nativeAcceptance: false` prevent treating this as image verification. Setup-only stops before native execution even when artifacts exist.

A full run uses one guest at a time: acquire/readiness, consumer command/output, renewal, explicit release, a second guest's real wall-clock expiry, then satellite crash/recovery and reservation retention. Application 2 has no grant; cross-application inspect/key issuance/operation submission and acquisition must fail. There is no synthetic guest response. The final loss case waits for the helper's independent deadline and retains the unknown reservation and owned state for operator reconciliation; it never forges cleanup or resets the journal. That retained reservation is an expected result, not reclaimed capacity.

Evidence includes controller/domain views, report bodies and domain counts around report forwarding, journal revisions, helper signature/entitlements/cdhash, helper and mkfs.erofs SHA256 pins, command receipt and the helper's real serial console copied as `<lease>-boot.log`. Successful release/expiry additionally requires observed helper PIDs gone, workspace/machine and published relay directories removed, durable stop/cleanup/release flags and zero reservations after the complete cleanup report. The independent process check conservatively refuses **any** remaining `com.apple.Virtualization.VirtualMachine` process because process names alone cannot attribute it to a particular VM. It never stops or inspects unrelated VM storage. Existing VMs can therefore block this check; run on a quiescent host or obtain separate attribution evidence before changing the criterion.

A failed full run preserves evidence and state, requests lease release, and stops its own controller/satellite processes. Release intent is not cleanup proof. The helper's deadline remains the independent fence; inspect failure evidence before rerunning. A new invocation always creates a new controller database, never adopts the old state, and must not be used to evade an unresolved physical reservation.

## Session diagnostic

`session-probe.swift` is a separate operator-only diagnostic, not a helper command or lease admission path. Compile it with full Xcode's `swiftc -parse-as-library`, sign it with the same Apple Development identity and `VirtualMachines/Virtualization.entitlements`, and invoke it with a file containing exactly `invalid-canaveral-probe-kernel` plus a newline. It validates a minimal 2 CPU/2 GiB direct-kernel configuration and records the invalid-image start failure. It then starts/stops an EFI firmware-only configuration without any guest disk and removes its fresh variable store. A 15-second bound fails closed on a stalled probe. Run it in each intended execution context and keep the resulting logs local. Invalid-image rejection alone does not establish VZ start admission; `efi-started` and `efi-stopped` establish only firmware start/stop, never Linux boot, guest readiness, helper relay behavior or positive lease cleanup.

To typecheck the standalone harness without adding it to ordinary tests:

```sh
coordination/node_modules/.bin/tsc --noEmit --target ES2023 --module NodeNext \
  --moduleResolution NodeNext --strict --types node \
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
