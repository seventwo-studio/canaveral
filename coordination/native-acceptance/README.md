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

Node >=24, macOS, `openssl`, `codesign`, `ps`, and the satellite's production prerequisites (including `lsof`) are required. The printed directory is unique per invocation. Keep it private: it contains local CA keys, administrator and enrolled identity credentials, the isolated SQLite state, raw operational configuration and command output under `private/`. Only the files outside `private/` are acceptance evidence. Never commit it. There is no evidence upload.

For setup without boot artifacts, set `setupOnly: true`, supply a nonexistent manifest path and an explicitly unverified expected `bundleDigest`; `builder` may be omitted. This exercises actual controller startup, fresh state, TLS, application creation, enrollment, domain/image/grant/approval configuration and catalog reads, then stops without acquiring or claiming anything. The expected digest is catalog configuration only: `artifactVerified: false` and `nativeAcceptance: false` prevent treating this as image verification. Setup-only stops before native execution even when artifacts exist.

A full run uses one guest at a time: acquire/readiness, consumer command/output, renewal, explicit release, a second guest's real wall-clock expiry, then satellite crash/recovery and reservation retention. Application 2 has no grant; cross-application inspect/key issuance/operation submission and acquisition must fail. Renewal must include a successful consumer command after the original expiry plus
the two-second guest margin; helper authorization alone is insufficient. There is
no synthetic guest response. The final loss case kills the satellite, waits past the lease deadline without
restarting it, proves helper PID and VZ absence with no power-off request, records
stop timing relative to the deadline, and only then starts recovery. It retains the unknown reservation and owned state for operator reconciliation; it never forges cleanup or resets the journal. That retained reservation is an expected result, not reclaimed capacity.

Evidence includes controller/domain views, report bodies and domain counts around report forwarding, allow-listed journal state/cause/timestamp/digest summaries (paths represented by role names), helper signature status/requirement result/bundle identifier/cdhash/virtualization entitlement, helper and mkfs.erofs SHA256 pins, command receipt and the helper's sanitized serial console exported as `<lease>-boot.log` (only numeric Linux version banners and fixed bootstrap-refused, guest-agent-fenced and session-closed/fence milestones; all payloads discarded and other lines counted as omitted; raw console retained under `private/`). Successful release/expiry additionally requires observed helper PIDs gone, workspace/machine and published relay directories removed, durable stop/cleanup/release flags and zero reservations after the complete cleanup report. Process evidence contains only PID, PPID, state and elapsed time for the run’s observed process tree, with no command arguments. Raw process and codesign output stays in memory; raw journals remain in private operational state. `private/` also holds TLS keys, enrollment identity, configuration, stderr and failure diagnostics; do not share it as evidence. Run `node --test coordination/native-acceptance/evidence.test.ts` for the portable privacy regression. The independent process check conservatively refuses **any** remaining `com.apple.Virtualization.VirtualMachine` process because process names alone cannot attribute it to a particular VM. It never stops or inspects unrelated VM storage. Existing VMs can therefore block this check; run on a quiescent host or obtain separate attribution evidence before changing the criterion.

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
