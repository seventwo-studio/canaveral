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
