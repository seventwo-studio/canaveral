# Canaveral development platform plan

The first priority is to let development agents acquire Linux and macOS workspaces, run app/backend builds, collect artifacts and release their resources. iOS simulators, Android emulators and local models use the same resource-control principles. Managed updates support that platform; expanding updater coverage is secondary.

This plan describes remaining delivery work. Passing fixtures, controller routes or a configurable adapter do not establish a usable native development environment.

## Agent workflow

An agent selects a pinned template/model and required capabilities, supplies a stable request UUID and bounded resource/time requirements, then waits for actual readiness. It receives access scoped to that lease or job, performs work through owned command/file/session transports, retrieves results and releases its reservation. Renewal is explicit. Lost replies reuse the original identity; reconnecting never blindly replays a command.

| Resource | Required working outcome |
| --- | --- |
| Linux workspace | Isolated repo/working directory, scoped command execution, file transfer, build/test output and artifacts |
| macOS workspace | Apple-backed isolated development environment, scoped command/files, native app build tools and retained artifact access |
| iOS simulator | Exact owned runtime/device identity on Apple hardware, app install/launch, logs, screenshots and bounded controls |
| Android emulator | Private AVD and pinned system image, owned serial/ports, app install/launch, logs and bounded controls |
| Model execution | Pinned installed model, bounded inference, scoped results and positive stop/cleanup before releasing capacity |

A macOS workspace and an iOS simulator may be separately leased resources. The design must not assume nested virtualization or expose unrestricted host device access. Agent-provider credentials are supplied through an explicit secret boundary, never baked into shared images.

## Shared pool and scheduling

- Give each physical machine one authoritative capacity domain, even when it runs VMs, simulators and models through different adapters. Do not enroll the same hardware twice or count host and runner ledgers as separate physical capacity.
- Reserve CPU, RAM, disk and, where applicable, accelerator slots/memory before dispatch. GPU scheduling is not implemented by a CPU/RAM/disk placement score.
- Respect operator headroom, per-application resource/concurrency limits, exact image/model grants, current runner identity, host health and update drains.
- Rank already-approved fitting candidates using the largest reservation fraction after admission, then total fractions and stable identity. This balances CPU, RAM and disk pressure; it is not cross-tenant fair queueing.
- Complete fair waiting/admission behavior without allowing a busy agent to monopolize the pool or silently moving an existing lease. Queued requests must have a defined deadline, cancellation and idempotent recovery contract.
- Keep reservations until positive owned cleanup. Expiry revokes access and stops owned execution; an unavailable host or unknown stop cannot prove capacity is free.

The embedded host ledger already shares VM/image/inference reservations. The Rust runner domain ledger shares Linux leases and model jobs. Binding both to one physical inventory, rather than relying on duplicate operator declarations, remains delivery work.

## Delivery sequence

1. Finish the shared-pool substrate: Linux/macOS multi-runtime model offers, CPU/RAM/disk placement, accounting across runtime types and tenant quota regression coverage.
2. Make Linux and macOS workspace leases usable end to end: acquire, verified readiness, repo/build operations, artifacts, renewal, expiry, controller/host loss and owned release. Native deadline and cleanup proof must precede enabling ordinary host lease execution.
3. Apply the same ownership, accounting and expiry contract to iOS/Android simulator leases and scoped model work. Add explicit accelerator admission where needed; do not treat simulator/model inventory as readiness.
4. Validate the supported paths on specifically authorized disposable targets, including recovery and concurrency under mixed workloads.
5. Ship the supported matrix and precise remaining gates. Keep the Docker controller externally updated and avoid interrupting active work during runtime updates.

## Current gates

Ordinary TypeScript hosts still reject consumer execution declarations. Mobile providers reject leased execution pending independent deadline/cleanup support. The Linux runner controller and generic host lease paths have different execution bindings and must not be enabled through a permissive configuration flag. The embedded inference API is an administrator API; scoped application model jobs are a separate path, not a general model-session lease.

Existing portable tests cover many authority, reservation, command/session and recovery cases. They do not establish Linux/macOS build acceptance, native simulator leasing, real model fit/cancellation, signing admission or GPU isolation. Preserve these distinctions in code and documentation.

## Acceptance before completion

- Linux and macOS: acquire a workspace, clone a test repository, run its build/tests, retrieve artifacts and release; a second tenant cannot access it.
- Mobile: acquire each supported simulator/emulator, install/launch a fixture app, retrieve logs/screenshots, exercise scoped input and positively reclaim the exact instance.
- Models: run a pinned real model while development/simulator work exists, preserve headroom and prove cancellation/cleanup before reservation release.
- Scheduling: concurrent requests cannot overspend the same physical budget; constrained and busy hosts are avoided; quotas, draining and fair waiting have observable outcomes.
- Recovery: expiry, disconnected clients, worker/controller restart and lost receipts do not resurrect a lease, replay effects or release unknown resources.
- Run relevant portable checks for every change. Native experiments, signing, service installation and deployment require concrete operator authorization under `AGENTS.md`.

Keep implementation in TypeScript/Rust, preserve scoped credentials and recovery records, and keep the repository free of Python code. Consolidate changes on one integration branch, with focused verification and independent review before release.
