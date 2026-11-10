# Canaveral

Canaveral provides a Python controller, outbound host runners and an optional web dashboard for machine and local-model execution. The controller stores placements and capacity reservations in SQLite. Hosts advertise templates, pull assignments and report state; lost hosts are marked unknown rather than silently duplicating their machines.

Backend source covers libvirt/KVM, Hyper-V, Apple Virtualization, KubeVirt, Android emulators and iOS simulators. Implemented adapters and fixture tests do not establish successful native execution on every platform. Ordinary runners remain gated for consumer lease execution. macOS and Windows guest components retain provider-binding and native-acceptance limits documented in their contracts.

Python remains the runtime implementation. Rust and TypeScript libraries under `crates/execution-core` and `coordination` contain shared wire fixtures and do not replace a running controller or runner.

[User accounts and personal API tokens](docs/accounts-and-tokens.md) provide private machine ownership, administrator-managed invitations and recovery, and expiring, revocable automation credentials. Guest connections enforce the same ownership and scope checks. The experimental TypeScript account backend refuses databases upgraded to this Python account schema.

The experimental [Linux command slice](docs/linux-command-operations.md) connects the TypeScript API and Rust satellite through portable fixtures. [Local boot-bundle tooling](docs/linux-boot-bundle.md) assembles pinned operator-built artifacts and a deterministic initrd. Native admission and release acceptance remain gated.

Start with [self-hosting](docs/self-hosting.md), [running](docs/running.md) and the [technical guide](docs/project-guidance.md). Python dependencies and package entry points are declared in `pyproject.toml`. Run portable Python checks with `./script/test.sh` in an environment with the declared dependencies. Native checks require their target platforms and explicit operator setup.

The [Apple package](VirtualMachines/README.md) contains native VM and guest-helper components. Existing disks and credentials are not automatically imported. The consumer [OpenAPI](docs/consumer-api.md) and [session protocol](docs/session-protocol.md) describe the implemented subsets and their limits.

Licensed under [MIT](LICENSE). Bundled third-party notices retain their own terms. Container publication configuration requires operator review; example package coordinates do not identify published artifacts.
