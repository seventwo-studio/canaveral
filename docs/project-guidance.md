# Technical guide

These documents define the TypeScript controller, `canaverald` host daemon and SDK, Rust execution components and native bridge contracts. Node.js 24 or later is required for the controller and host. No Python runtime is required by Canaveral services. Swift and C platform bridges remain intentional native dependencies. Native acceptance, provider binding and recovery limits remain explicit; a portable fixture or successful build does not establish platform parity.

Optional Python-based model engines require Canaveral-managed hermetic runtime
packages with their interpreter and dependencies. They add no user-installed
interpreter dependency to the controller, host or SDK; see
[managed model runtimes](model-runtimes.md).

- [access transport](access-transport.md)
- [alerts](alerts.md) (Slack and signed webhook destinations, durable at-least-once delivery; fixture-covered)
- [user accounts and personal API tokens](accounts-and-tokens.md)
- [agent surfaces](agent-surfaces.md) (MCP server, held CLI leases, agent rules and a CI recipe; fixture-covered, no native or client acceptance)
- [android runtime ownership](android-runtime-ownership.md)
- [android transfer](android-transfer.md)
- [applications](applications.md)
- [client recovery](client-recovery.md)
- [real browser API and agent-runtime forwarding](browser-api.md)
- [consumer api](consumer-api.md)
- [TypeScript consumer SDK](consumer-sdk.md)
- [consumer operations](consumer-operations.md)
- [dashboard](dashboard.md)
- [devices](devices.md)
- [canaveral doctor](doctor.md) (read-only diagnosis with stable finding codes)
- [error codes](error-codes.md) (every stable `code`, its status, meaning and retry guidance; checked against source)
- [event log](events.md) (durable history captured with each state change, cursor reads and live follow; fixture-covered)
- [remote mobile control and CI builds](mobile-control.md)
- [mobile host upkeep](mobile-host-upkeep.md) (runtime and system-image management, idle stop, orphan storage, and pressure reporting; Android inventory verified on one Mac)
- [guest access](guest-access.md)
- [image registry](image-registry.md)
- [images](images.md)
- [inference](inference.md)
- [Managed model runtimes](model-runtimes.md) (bundled and Canaveral-managed engines; host compatibility and native qualification)
- [Rust model execution](rust-model-execution.md)
- [model-job wire contract](model-job-contract.md)
- [TypeScript model-job controller slice](model-controller.md)
- [TypeScript Linux lease controller slice](linux-lease-controller.md)
- [Bounded Linux command operations](linux-command-operations.md)
- [infrastructure](infrastructure.md)
- [kubevirt resource ownership](kubevirt-resource-ownership.md)
- [lease eligibility](lease-eligibility.md)
- [leases](leases.md)
- [durable waiting requests](requests.md)
- [libvirt resource ownership](libvirt-resource-ownership.md)
- [libvirt supervision](libvirt-supervision.md)
- [macos desktop image](macos-desktop-image.md) (operator-supplied image, guest bundle and identity check)
- [macos display input](macos-display-input.md)
- [macos guest access](macos-guest-access.md)
- [macos guest accessibility](macos-guest-accessibility.md)
- [macos guest files](macos-guest-files.md)
- [macos guest shells](macos-guest-shells.md)
- [orchestration](orchestration.md)
- [power and recovery](power-and-recovery.md)
- [running](running.md)
- [managed runtime updates](runtime-updates.md) (Unix offline bootstrap, generated service definitions, separate component receipts and operator acceptance; no automatic service installation)
- [runner enrollment](runner-enrollment.md)
- [Rust runner identity client](../crates/runner-client/README.md)
- [Rust Apple satellite](../crates/apple-satellite/README.md)
- [scoped accessibility](scoped-accessibility.md)
- [self hosting](self-hosting.md)
- [simlock parity](simlock-parity.md) (comparison, scope and decisions accepted on 21 November 2026, and where each area is delivered)
- [session protocol](session-protocol.md)
- [templates](templates.md)
- [terminal sdk](terminal-sdk.md)
- [usage reporting](usage.md) (requests, waits, leases and device-seconds from controller ledgers; not measured utilisation)
- [tls clients](tls-clients.md)
- [visual sdk](visual-sdk.md)
- [warm devices and device baselines](warm-pool-and-baselines.md) (native warm adoption and prepared Android baseline state verified on one Mac)
- [windows guest accessibility](windows-guest-accessibility.md)
- [windows guest display](windows-guest-display.md)
- [windows guest files](windows-guest-files.md)
- [windows guest terminals](windows-guest-terminals.md)

- [Bounded KubeVirt execution adapter](../crates/kubevirt-execution/README.md) (fixture-covered ownership and transport; production creation disabled pending independent fencing)

- [Linux agent boot bundle](linux-boot-bundle.md) and [guest wire protocol](guest-wire.md) (Rust guest core, deterministic local bundle/initrd assembly, read-only digest preflight and bootstrap source; satellite readiness and consumer commands fixture-covered; kernel/rootfs construction and native acceptance remain outstanding)

- [Native direct Linux boot](../VirtualMachines/Documentation/DirectBoot.md) (direct-kernel helper and relay fixtures; satellite integration and initrd assembly fixture-covered; production kernel/rootfs builds, artifact installation and native acceptance remain open)

- [Linux public HTTPS egress policy](linux-egress-policy.md) and the ST-535 sections
  in guest wire, boot bundles, lease controller, command operations, consumer API
  and applications define workspace/data/transfer contracts. Experimental native
  workspace/files/lifecycle results are in the [acceptance record](../coordination/native-acceptance/README.md#st-535-native-evidence-2026-11-12).
  Qualified cloned-route evidence, public CONNECT and pinned clone/npm passed
  on the tested Mac. Native topology and full production acceptance remain open.
