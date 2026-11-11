# Managed runtime updates

Managed updates distribute signed host, guest and native helper code to connected legacy hosts and enrolled runners. The Docker controller is updated externally. There is no controller-image update endpoint, remote shell installer, manifest hook or force-stop operation.

A rollout drains new placements. Existing VMs, inference work, disks, credentials, ownership records and reservations remain intact. Downloaded guest/helper files are inactive assets: host readiness does not prove that a live guest or a separately installed native helper has adopted them.

## Trust and release format

Pin Ed25519 public keys independently on the controller and each installation. Controller configuration accepts `updatePublicKeys`, a JSON object mapping key IDs to PEM public keys. Omitting it disables release creation. Hosts use their configured `updates.trustedKeys` map. A signed release cannot introduce a key or change either trust map. Distribute trust-map changes through the operator's protected configuration workflow, retaining any key needed to verify the exact rollback baseline.

Keep the private signing key on the offline release builder. `--key-file` reads an explicit private regular PEM file, owned by the builder account with no group/other permissions on Unix. Signing uses Node's Ed25519 implementation; it does not invoke machine code signing, keychains, notarization or platform installers. Production native helpers still require their platform admission and signing procedures before packaging.

The strict `canaveral-update-v1` manifest contains exactly:

- `releaseId`: canonical lowercase nonnil UUID; `version`: SemVer; `sequence`: positive safe integer; `createdAt`: nonnegative integer Unix seconds.
- `target`: `{ "os": "linux|darwin|win32", "arch": "amd64|arm64" }`; `minimumLauncherVersion`: positive integer.
- `entrypoint`: the relative path of a listed `host` file.
- `files`: nonempty array of `{path, sha256, bytes, executable, component}`, where component is `host`, `guest` or `native-helper`.

The envelope is exactly `{manifest,keyId,signature}`. Its signature is canonical base64 for a 64-byte Ed25519 signature over `canonicalManifest(manifest)`: recursively sorted object keys, original array order, compact JSON encoded as UTF-8 without BOM or newline. Integers must be safe and finite; negative zero and malformed surrogate sequences are rejected. There is no Unicode normalization during canonicalization. Paths must already be NFC and portable relative POSIX paths. Absolute paths, traversal, backslashes, empty/dot segments, Windows aliases, case-insensitive duplicates, file/directory collisions and unknown fields are rejected. A release cannot describe links, origins, trust roots or install commands.

The protocol limits canonical manifest bytes to 512 KiB and files to 10,000. Controller limits also apply: artifacts at most 512 MiB each and total listed release bytes at most 2 GiB. The builder reserves 4 KiB of that total for signed build evidence. SemVer is descriptive; the monotonic sequence is the anti-downgrade authority. A distinct release for the same platform must have a higher sequence, even after a failed candidate or rollback.

## Build a release offline

Use the repository's installed Node 24.11+ tooling and the pinned Rust 1.99.1 toolchain to compile and admit the runtime first. Assembly executes no compiler, downloaded binary or packaged code. The recipe records declared toolchain/source evidence; assembly checks literal JavaScript module references against the exact packaged file set, but does not establish dependency provenance, computed-import closure or native acceptance. JavaScript sources are bounded to 16 MiB per module and 128 MiB aggregate. Builtins are allowed; unbundled bare dependencies and missing relative modules are rejected. Computed imports require separate entrypoint smoke tests and operator review. See [package checks](../script/package_checks.mjs) and [release assembly](../script/build_runtime_release.mjs).

An explicit recipe lists every required module, package metadata, dependency, guest binary and native helper. Sources are relative to a dedicated input directory; output paths are relative to the release root. This minimal shape illustrates the recipe:

```json
{
  "schema": "canaveral-runtime-build-v1",
  "releaseId": "2b31b466-4d1f-4d62-9104-6a890fb4811a",
  "version": "1.2.3",
  "sequence": 23,
  "createdAt": 1800000000,
  "target": { "os": "linux", "arch": "amd64" },
  "minimumLauncherVersion": 1,
  "entrypoint": "host/managed-entry.js",
  "toolchain": { "node": "24.11.0", "rust": "1.99.1" },
  "sourceRevision": "0123456789abcdef0123456789abcdef01234567",
  "files": [
    { "source": "managed-entry.js", "path": "host/managed-entry.js", "component": "host", "executable": false },
    { "source": "guest-agent", "path": "guest/agent", "component": "guest", "executable": true },
    { "source": "native-helper", "path": "native/helper", "component": "native-helper", "executable": true }
  ]
}
```

Replace the example release identity, sequence, timestamp, source revision and file list with reviewed inputs. A Darwin or Windows host may carry guest code for another guest OS; `target` selects the installation receiving the entire release. It does not prove that a bundled guest binary matches a particular guest. The existing guest provisioning mechanism must enforce that binding.

```sh
node script/build_runtime_release.mjs \
  --recipe /private/build/recipe.json \
  --inputs /private/build/runtime-inputs \
  --output /private/build/new-release \
  --key-file /private/signing/runtime-ed25519.pem \
  --key-id runtime-2026
```

Use real filesystem paths without symlink ancestors. Assembly rejects symlinks, nonregular inputs and hardlinked inputs, and checks input size/change metadata while streaming. It refuses the signing-key inode and exact copies of the signing PEM embedded in artifacts. Keep the input tree controlled and exclude credentials, other private keys, test fixtures, mutable state and VM disks from the recipe. Same-account concurrent malicious filesystem mutation is outside this directory trust boundary.

The fresh private output contains only `release.json` and `artifacts/<sha256>`. Identical content is stored once; each manifest path retains its own component and executable flag. `.canaveral-build.json` is an additional signed host data file with the source revision, toolchain pins, platform and version. No private key, private-key path or source-tree path is placed in that metadata. `release.json` is written last as the completion marker. Existing output is never replaced. Assembly failure cleans the directory it created; process loss may leave incomplete private output, which must be inspected and rebuilt at a fresh path.

## Upload and operate rollouts

The update CLI is callable through `canaveral updates` or as standalone compiled JavaScript at `coordination/dist/src/updates/cli.js`. It exports `updateMain(argv, io?)`, returning a process-style status. Arguments exclude `updates`; `io` optionally supplies `stdout`, `stderr` and the existing authenticated `RequestClient`. Without an injected client, provide an origin URL and private token file; `--ca-file` supports an explicit private controller CA. HTTP is allowed on loopback, or with explicit `--allow-http` for an operator-approved private network. Redirects are refused.

The trusted-key file is an independently pinned JSON key-ID-to-public-PEM map, separate from the bundle:

```sh
node coordination/dist/src/updates/cli.js \
  --url https://controller.example.internal \
  --token-file /private/operator/admin.token \
  releases upload --bundle /private/build/new-release \
  --trusted-keys /private/operator/update-public-keys.json
```

Upload checks the signature, every local digest/size and the exact bundle entry set before any controller mutation. It registers the signed envelope directly, then POSTs content-addressed artifact chunks `{offset,totalBytes,data}`. Raw chunks are fixed at 512 KiB; base64 plus JSON fits the normal 1 MiB request limit. The final chunk triggers controller digest verification. The CLI requires matching registration and artifact acknowledgements before reporting success. Empty files use one zero-length chunk.

Repeating upload starts at offset zero and replays identical chunks, including completed artifacts. This supports interrupted uploads without an unauthenticated progress/download endpoint. Keep the exact bundle and chunk convention when resuming. Changed bytes, sizes or overlapping chunks fail; never replace signed bytes beneath an existing release ID. After one unconfirmed reply the CLI retries the same POST once. If uncertainty remains, inspect the same release/rollout and retry with the same inputs. It never generates a replacement operation UUID.

```sh
node coordination/dist/src/updates/cli.js --url https://controller.example.internal \
  --token-file /private/operator/admin.token rollouts create \
  --id 3d482642-edf1-4fb7-8b92-30e6fb279acb \
  --release-id 2b31b466-4d1f-4d62-9104-6a890fb4811a \
  --host-id 329af889-3e8f-4dad-9dcb-00818996d872
```

Repeat `--host-id` or `--runner-id` for additional targets. Host-only bodies remain `{id,releaseId,hostIds}`; enrolled runners add optional `runnerIds`. An enrolled runner is bound to its current RunnerEnrollment controller/runner/generation/incarnation and credential revision. It is not enrolled as a fake legacy host. A target must first poll with a durable installation ID, its platform and launcher version. Artifact access is limited to the assigned current credential and exact job. Credentials are sent only to controller-relative routes, never to a manifest-supplied origin.

Other commands are `releases list`, `releases status --id UUID`, `rollouts list`, `rollouts status --id UUID` and `rollouts cancel --id UUID`, using the same global options. Cancellation targets `POST /v1/updates/rollouts/:id/cancel` and applies only to queued, undelivered jobs. Once delivered, operator cancellation cannot establish that activation did not occur. A cancelled queue item does not authorize stopping workloads or releasing reservations.

## Install the stable bootstrap once

Provision the stable launcher and its supporting compiled modules outside the replaceable release tree. Pin its source/package through the operator's existing service installation workflow. The signed manifest selects only a relative runtime entrypoint; it cannot replace the launcher, Node executable, service manager, trust configuration or launch arguments. Launcher upgrades require a separate operator action.

Use disjoint private locations, for example:

| Location | Contents |
| --- | --- |
| `/opt/canaveral-bootstrap` | Operator-installed launcher and its module closure |
| `/var/lib/canaveral-code` | `releases/` and fresh `staging/` directories only |
| `/var/lib/canaveral-update-state` | Installation ID, active pointer, sequence high-water, manifests, locks and receipts |
| `/var/lib/canaveral-host` | Persistent host identity and provider receipts |
| `/var/lib/canaveral-disks` | Retained guest disks and provider state |
| `/etc/canaveral` | Protected configuration and credential files |

List every credential, VM/provider and mutable state root in `protectedPaths`; the manager rejects overlap with either code or update-state roots. Unix update storage must be owned by the service account and private. Windows requires equivalent operator-provisioned account isolation/ACLs; portable mode checks do not establish Windows ACL acceptance.

The Unix bootstrap installer verifies the signed content-addressed bundle, rejects an inexact entry set, expands files with their declared executable modes and calls `UpdateStore.installInitial` to seal/select the baseline. It matches the current Linux/Darwin amd64/arm64 target; Windows installation is refused because ACL acceptance is unproven. Both installation and update-state roots must be absent, disjoint and below already private, owned parents. Existing or interrupted roots are retained and refused, never adopted or overwritten.

Supply the protected existing host configuration with its current controller URL, persistent `stateDir` (or `agentStateDirectory`), pinned `updates.trustedKeys` and explicit `updates.protectedPaths`. Supply Node and the complete stable launcher module closure separately; bootstrap neither installs nor executes them. The stable tree must be private and owned by the invoking account; the Node executable must be protected, regular and owned by root or that account. Use normalized absolute paths without symlink ancestors, including the actual resolved path of Node.

The `canaveral install` command accepts only the local flags below; controller/token flags are refused. From the built checkout:

```sh
node coordination/dist/src/cli.js install \
  --bundle /private/build/new-release \
  --host-config /etc/canaveral/host.json \
  --installation /var/lib/canaveral-code \
  --state /var/lib/canaveral-update-state \
  --node /opt/canaveral-node/bin/node \
  --launcher /opt/canaveral-bootstrap/updates/launcher.js \
  --stable-root /opt/canaveral-bootstrap
```

Run only after the one-time service migration is authorized. Output is JSON containing installation/release IDs, roots and `service: {filename, content}`: a Linux systemd unit or Darwin launchd plist. Review it and install it separately under the owning service account. No service is installed, enabled or started; no credentials are minted and no enrollment/network request occurs. Generated definitions clear Node injection variables and disable automatic restart/keepalive and forced child killing. Service ownership, boot policy, shutdown and native admission still require operator acceptance. Failed/interrupted installation preserves reserved roots and identity for inspection; do not rerun with new identities or delete uncertain state.

For embedding, the import-safe `installMain(argv)` API takes arguments excluding `install` and returns a process-style status. The lower-level `bootstrapInstall` API is in [bootstrap.ts](../coordination/src/updates/bootstrap.ts); argument/service behavior is in [install-cli.ts](../coordination/src/updates/install-cli.ts). The upload bundle's `artifacts/` directory is not itself an expanded runtime tree.

Preserve the existing host identity and stop/idle proof during this one-time service migration. Verify that all workloads are positively stopped and no host operations remain in flight before changing process ownership. Do not use service termination as evidence that VMs stopped. Initialize a baseline whose entrypoint implements the launcher readiness contract. The shipped TypeScript CLI recognizes managed launch arguments and starts its fenced host mode; custom entrypoints must implement that contract themselves.

The launcher executable accepts:

```sh
node /opt/canaveral-bootstrap/updates/launcher.js \
  --installation /var/lib/canaveral-code \
  --host-config /etc/canaveral/host.json \
  --state /var/lib/canaveral-update-state
```

Its private configuration contains `stateDir` (or `agentStateDirectory`) for the persistent host state, plus `updates.trustedKeys` and `updates.protectedPaths`. Configure the platform service manager once to run that fixed command under the owning account. Do not put service restart commands in releases.

For enrolled Rust model and Apple runners, set `updates.targetKind` to `"runner"` and `updates.nativeConfigFile` to the absolute path of the existing protected native configuration. The parent configuration's controller URL and state directory must match it. The parent rereads the saved credential and exact controller/runner/generation/incarnation binding for every update request. The native entrypoint runs in `--update-managed` mode, repeating its existing one-shot loop. Quiesce fences the next claim and waits for the current turn; it does not cancel active execution. Positive idle status requires the runtime's existing lock, durable dispatch/stop/cleanup evidence and absence of an owned workspace. Original standalone command forms remain available. Other native entrypoints require equivalent lifecycle integration.

The launcher passes fixed `--config` and `--state` arguments. Node candidates use inherited IPC; native candidates receive `CANAVERAL_UPDATE_READY_FD=3` and `CANAVERAL_UPDATE_COMMIT_FD=4`. The startup exchange is `ready → activate → started → committed → committed-ack`, using types prefixed with `canaveral-update-`. Each record contains exactly `{type,version:1,releaseId,installationId}`; native framing is one bounded JSON line. Readonly preflight precedes `ready`; initialized, admission-fenced startup precedes `started`. After receiving `committed`, the child admits work and sends `canaveral-update-committed-ack` for that exact installation and release. The parent persists a nonterminal commit intent before sending, and records success or rollback only after the ACK. A missing ACK retains uncertainty and the live child; it does not authorize starting a replacement. Node entrypoints can use `announceUpdateReady()` for the exchange while retaining their own admission fence. Default readiness is bounded to 30 seconds; a timeout is not success.

## Activation, recovery and component receipts

`ManagedUpdater` polls and steps a durable job using explicit current identity, controller transport, private roots, pinned keys and lifecycle callbacks. Activation requires both positive idle/workloads-stopped observations and a quiesce receipt that fences new local work and waits for in-flight operations. Missing inspection, an active workload or uncertain stop blocks activation. The updater never asks a VM provider to force power off.

The launcher verifies the candidate immediately before execution and retains the exact verified previous release. Candidate failure restores that baseline and requires its readiness before reporting rollback. The high-water sequence is retained. If process ownership, stop completion, activation or receipt delivery is uncertain, keep the attempt ID, journal and drain; inspect/recover the saved attempt rather than creating a new UUID. Success and verified rollback clear the update drain. Pre-activation failure/cancellation needs positive no-activation proof; `unknown` remains drained. None of these receipts releases workload reservations.

| Component | Meaning of host success |
| --- | --- |
| `host` | Candidate entrypoint passed bounded readiness and committed |
| `guest` | Verified files staged; `pendingGuestReceipt` until guest application is positively acknowledged |
| `native-helper` | Verified files staged; `pendingNativeReceipt` until the specific native adapter acknowledges adoption |

Component plans and ordered receipts bind job, attempt, installation, release, signed component file-set digest and each concrete target. Guest identity includes machine, assignment, boot and generation; helper identity includes helper, signed executable path, instance and generation. The manager persists intent before dispatch and uses inspection-only recovery for interrupted/unknown adoption. The controller independently verifies the current target inventory and acknowledgement; a caller-supplied receipt alone cannot establish adoption.

Rollout job views expose `hostState`, `components` and `componentTargets` separately. Target states are `pending`, `intent`, `adopted` or `unknown`. Component summaries can be `pendingGuestReceipt`/`pendingNativeReceipt`, `adopting`, `partial`, `ready` or `unknown`. Partial means some planned targets acknowledged; unknown means at least one uncertain target. Neither is fleet completion. Host `succeeded` does not establish component adoption. The default production controller has no guest/helper evidence verifier: those components remain pending. Fixture-injected drivers/verifiers do not enable live adoption. See the [strict component contract](../coordination/src/updates/components.ts), [durable manager](../coordination/src/updates/manager.ts) and [controller ledger](../coordination/src/control/updates.ts).

The [guest mechanism](../coordination/src/updates/guest.ts) supports the signed headless Linux fresh/stopped cloud-init provisioning path, with exactly one nonexecutable signed guest file at `guest/bundle.json` in the existing helper-bundle format. It verifies provisioned modules and decoded helpers, binds the actual guest boot and persists an acknowledgement before admitting work. It does not rewrite a live guest or an existing stopped disk. Production wiring still needs an independent current machine/assignment/boot/generation inventory and controller evidence verifier; without them adoption remains pending.

The [helper mechanism](../coordination/src/updates/native-helper.ts) selects a signed executable through a shared scoped transport selection at a confirmed closed boundary. Its owned local process/pipe nonce exchange establishes a local acknowledgement; spawning or exit alone does not. All external helper consumers must be stopped before using this mechanism. It does not establish remote controller evidence, platform code-signing admission or Windows support. After process loss, saved receipts alone cannot prove the current helper instance; inspection without proof retains uncertainty and never respawns/replays the attempt.

Route guest assets through the existing provision/update mechanism after a separately confirmed idle/stop boundary. Never rewrite a running guest or reinterpret a host receipt as guest adoption. Registered Rust runner protocol support likewise requires each runtime's real lifecycle and readiness integration. An unsupported adapter stays pending/disabled and drained when uncertain; it must not manufacture readiness or no-workload proofs.

## Preserve state before installation or rollback

Take a consistent SQLite backup using the database's supported backup mechanism or a stopped-controller copy; copying only a live database file can omit WAL state. Record the controller identity, schema/version, image digest and independently pinned update keys with that backup. Protect backups like the originals: they contain credential authority and recovery data.

On each target preserve the existing host/runner configuration, saved credentials, installation ID, update journal, sequence high-water, active/previous release manifests, provider ownership receipts and retained disks. Keep a recoverable copy of the exact previous release. Never copy a live installation's identity into another target. A mutable-state backup must be consistent with workload/provider ownership; restoring old receipts over still-running resources is not a safe rollback.

A runtime rollback selects the verified previous code through the saved attempt; it does not roll back SQLite, credentials, VM disks, reservations or the sequence high-water. Do not edit the active pointer, delete an uncertain journal, lower the sequence or re-enroll to clear a failed update. If the previous release no longer passes verification/readiness, leave admission fenced and investigate. Controller schema rollback and service/bootstrap replacement are separate operator decisions.

## Update the Docker controller externally

Back up the SQLite database consistently, its controller identity and private operator/enrollment credentials. Review schema and trust-map compatibility, then use the existing Docker/GitOps/operator workflow to select an immutable controller image digest and replace the container while retaining those volumes and configuration. Keep controller secrets and database outside runtime bundles. Never reinitialize credentials or reseed persistent state during an image update. Refer to [self-hosting](self-hosting.md) and [running](running.md) for the deployment layout.

Portable tests cover protocol/schema/path rejection, deterministic offline signing, artifact integrity, authenticated controller upload, exact replay after committed replies are lost, queued cancellation, post-spawn persistence failure and missing commit acknowledgement. A disposable real-controller test uploads and activates an actual signed TypeScript CLI release. These checks do not establish native host/guest boot acceptance, service-manager installation, platform code-signing admission, Windows ACL enforcement or live guest rollout. Those remain separately authorized platform checks. Building, uploading a bundle or staging code is not authorization to update a fleet.

## Operator acceptance (prepare only; separate authorization required)

Record the exact source commit, signed release ID/digest, target installation ID, current credential revision and baseline before each run. Use a disposable owned target first; production rollout needs its own authorization. Keep private receipts and logs out of release artifacts.

1. Verify CLI help/imports locally, then inspect the existing target and rollout with the same protected operator token:

   ```sh
   node coordination/dist/src/cli.js --help
   node coordination/dist/src/updates/cli.js --help
   node coordination/dist/src/cli.js install --help
   node --input-type=module -e 'await import("./coordination/dist/src/updates/launcher.js")'
   node coordination/dist/src/updates/cli.js --url https://controller.example.internal \
     --token-file /private/operator/admin.token rollouts status \
     --id 3d482642-edf1-4fb7-8b92-30e6fb279acb
   ```

2. On the authorized service target, validate account ownership, private configuration, Node/module closure and baseline readiness. Restart through the installed service manager and confirm the same installation and saved host/runner credentials return. Record the exact service command selected for that machine; this document does not authorize starting it.
3. For a VM target, record workload, disk and reservation identities. Confirm an active VM prevents replacement. After an independently confirmed idle/closed boundary, run one signed candidate and verify host commit and each applicable component acknowledgement separately. Confirm retained disks and current credentials are unchanged. Exercise lost acknowledgement/restart recovery without issuing a new attempt or blindly replaying application.
4. For a device/helper target, verify the admitted executable's actual identity and the owned service/process instance. Keep an unrelated device/workload running to check isolation. Require positive closure before selection and a current-identity acknowledgement after selection. Unconfirmed stop or adoption must retain uncertainty.
5. For inference, use the explicitly configured supported runtime and real model weights. Start a bounded request with a saved request UUID, verify active execution prevents activation, then verify idle update and the same model/credential binding. A lost running receipt stays unknown and must not cause generation replay. Portable HTTP fixtures do not establish model quality, accelerator fit or native cancellation.
6. In the disposable lane, exercise candidate startup failure and verify readiness of the exact baseline before declaring rollback. Exercise process loss around dispatch and commit; record drain, attempt ID and pending/partial/unknown component state after restart. Do not simulate failure on production workloads.
7. Only after target-specific acceptance, select a small explicit host/runner list for a canary rollout. Inspect each rollout receipt before widening the list. Queued cancellation does not undo delivered work. Fleet completion requires evidence for every intended component/target, not merely host success.

Record native VM boot, launch-medium delivery, device control, inference and fleet results independently from portable tests. Missing provider fencing, Windows ACL acceptance or platform admission remains a failed/open gate; never change eligibility to make an acceptance run pass.
