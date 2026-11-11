# Canaveral completion plan

Finish the operator installation and managed component-update paths on top of the merged TypeScript/Rust implementation. Keep the controller in Docker, updated externally. Preserve existing credentials, workloads, reservations and recovery records. Keep the repository free of Python code.

This is an implementation plan, not a claim of native acceptance. The starting main revision is `d49283bd07599c06da7baf4cadb3779c0b6c85fb`. Every work chat starts from the same committed plan revision in its own T3-managed worktree.

## Delivery order

1. Freeze the component-adoption interface and binding rules. Start installation, packaging, boot-input validation, test preparation and documentation independently.
2. Implement guest and helper adoption against that interface. Deliver small local commits and focused portable checks; report interface needs immediately.
3. The lead integrates commits in dependency order and owns shared entrypoint wiring. Run combined checks once the graph is complete, then fix failures with the owning chat.
4. Start a separately briefed ChatGPT reviewer on the exact integrated revision. Resolve material findings before presenting the code as complete.
5. Hand back tested code and exact commands for any remaining operator-authorized acceptance. Do not claim deployment or platform support from fixtures.

The requested two-hour window is a prioritization target. The first checkpoint is interface agreement; the next is one complete install/update/recovery path. Add platform breadth only after that path works. Stop expanding scope when it threatens integration and review.

## Exclusive write ownership

| Chat | Deliverable | Owned paths |
| --- | --- | --- |
| Lead, this chat | Integration, CLI dispatch, host wiring and final verification | `coordination/src/cli.ts`, `coordination/src/host.ts`, `coordination/src/updates/runtime.ts`, this plan; unassigned shared integration files only after explicit allocation |
| Component contracts and ledger | Strict adoption identity, durable component reports, manager/controller coordination | `coordination/src/updates/components.ts`, `coordination/src/updates/manager.ts`, `coordination/src/control/updates.ts`, `coordination/test/control/update-components.test.ts`, `coordination/test/control/update-controller.test.ts`, `coordination/test/control/update-manager*.test.ts` |
| Guest adoption | Existing Linux guest update/provision path, positive application acknowledgement and recovery | `coordination/src/updates/guest.ts`, `coordination/src/guest/{access,linux-services,server}.ts`, `coordination/test/control/update-guest.test.ts`; existing guest tests only after notifying lead |
| Native-helper adoption | Signed helper selection at a positively closed boundary, identity/version acknowledgement | `coordination/src/updates/native-helper.ts`, `coordination/src/providers/mobile-native.ts`, `coordination/test/control/update-native-helper.test.ts`; request any other platform file before editing |
| Bootstrap installer | Verify and expand the existing release format, initial installation, generated service configuration | `coordination/src/updates/bootstrap.ts`, `coordination/src/updates/install-cli.ts`, `coordination/test/control/update-bootstrap.test.ts`, `coordination/test/control/update-install-cli.test.ts` |
| Release packaging | Dependency closure, native/guest assets, build/package verification | `script/{tasks,prepare_cli,prepare_native,build_runtime_release,build_guest_bundle}.mjs`, related `script/*.test.mjs`, root `package.json`, `coordination/package.json`, `.github/workflows/*`; lockfiles only for justified dependency changes |
| Linux boot inputs | Close bounded production-input validation/assembly gaps without inventing trust or release pins | `crates/boot-bundle/**`, new `script/verify_linux_boot_inputs.mjs` and matching test; request any other crate before editing |
| System verification | Cross-component recovery tests and read-only acceptance prerequisites | `coordination/test/control/update-completion-system.test.ts`, `script/check_canaveral_acceptance.mjs` and matching test; no production source writes |
| Operator documentation | Installation, component status, supported paths and precise remaining gates | `docs/{runtime-updates,running,linux-boot-bundle,project-guidance}.md`, `README.md` |

No worker edits an unowned shared file, fixes another worker's compile error, merges another branch, pushes, opens a PR, or changes a live service. Request a transfer from the lead. New files are owned by the chat named here, not implicitly shared.

## Component contract before wiring

The contracts chat publishes the exported TypeScript interface first and notifies the lead. Guest/helper chats may inspect their current adapters and write independent tests while that interface is prepared; they must not invent competing controller endpoints or schemas.

Reuse the signed `canaveral-update-v1` manifest, existing release directories, attempts and ordered reports. An adoption receipt binds the exact job, attempt, installation, release, component file-set digest and concrete current guest/helper target. Guest binding includes the existing machine/assignment identity and boot or generation evidence where available. Helper binding includes the exact executable and owned process/service instance. Missing binding or proof remains pending.

Staging, spawning, host readiness, process exit, and a caller-supplied `ready` flag are insufficient adoption proof. Require a positive current-identity acknowledgement through the owned transport, and a confirmed idle/closed boundary before replacement. Persist intent before effects. Recover an existing attempt after interruption; never blindly replay an uncertain application. Authority loss, lost acknowledgements and unconfirmed stop retain uncertainty and any necessary drain. Keep host phase and per-target component status distinct, including partial adoption.

Do not replace a running guest, force-stop work, update the stable launcher/Node/trust roots through a runtime manifest, adopt unrelated installations, or expand provider eligibility without its established proof.

## Verification and delivery boundaries

- Per owner: relevant strict TypeScript or Rust checks, meaningful focused tests, staged-diff and whitespace checks. Avoid repeated whole-repository builds. Cargo jobs at most two per worker; do not run broad builds concurrently with the lead's final verification.
- Integrated: build/typecheck, TypeScript/Rust portable suites, packaging smoke tests, zero-Python check, install-to-update-to-recovery scenarios, exact-diff independent review.
- Failure cases: bad signature/hash/path/link, changed current identity or credentials, duplicate/reordered receipts, crash before/after dispatch, lost reply, failed stop, failed publication, exact-baseline rollback and preserved mutable state.
- Native VM/device/inference tests, real service installation, signing, production boot artifact construction and fleet rollout require a concrete operator-authorized target under `AGENTS.md`. Prepare commands and prerequisites without executing them. Unsupported adapters remain explicitly gated.
- Prefer TypeScript/Rust and existing dependencies. Add no Python, unnecessary Bash, generic updater framework, controller self-update endpoint or unrelated enterprise CI changes.

Each work chat returns its branch/commit, exact changed paths, checks, remaining limits and integration instructions. Only the lead integrates and publishes. A final independent review is a new assignment against the resulting immutable commit.
