# Canaveral

Run the controller in Docker and replace its image through your external deployment workflow. Connected host agents and registered runners use [signed, managed runtime updates](docs/runtime-updates.md), with separate private state, idle checks, staged activation and rollback. The offline Unix bootstrap expands a verified baseline and generates a service definition for separate operator installation. Guest and native-helper adoption remains separately acknowledged; staging a bundle does not establish a live guest update.

Canaveral provides a TypeScript controller, outbound TypeScript hosts, Rust execution components and an optional web dashboard for machine and local-model execution. The controller stores ownership, placements and capacity reservations in SQLite. Hosts advertise installed templates, pull assignments and report state. Lost hosts remain unknown; their machines are never silently duplicated.

The runtime requires Node.js 24 or later and the Rust binaries needed by the selected backend. Python is not required to run the controller, hosts or SDK. Swift VM/guest services and C platform bridges remain intentional native dependencies. A guest image may independently include Python as a workload tool or distribution prerequisite.

[Accounts and scoped personal tokens](docs/accounts-and-tokens.md) govern private machine ownership. Authorization uses the current account role, credential scope and resource owner. Application, lease, enrollment, runner and guest credentials have separate authority. Callers persist mutation UUIDs and exact requests before dispatch; unknown outcomes require inspection or explicit identical replay where supported.

For installation boundaries, use the [target matrix](docs/running.md#installation-and-target-boundaries); keep [operator acceptance](docs/runtime-updates.md#operator-acceptance-prepare-only-separate-authorization-required) separate from portable fixtures.

Start with [self-hosting](docs/self-hosting.md), [running](docs/running.md) and the [technical guide](docs/project-guidance.md). The CLI source is `coordination/src/cli.ts`; the controller modules are in `coordination/src/control`. The [consumer SDK](docs/consumer-sdk.md) and its terminal, visual and accessibility clients are TypeScript. Rust workspace components cover execution ownership, runner identity, model execution, Apple supervision, KubeVirt and the guest wire protocol.

Portable checks:

```sh
npm --prefix coordination ci --ignore-scripts
npm --prefix coordination run typecheck
npm --prefix coordination run build
npm --prefix coordination test
cargo test --workspace --locked -j2
```

Root scripts also provide `npm run setup`, `npm run typecheck`, `npm run build`,
`npm test` and `npm run check:no-python`. The language scan is a repository check;
external guest tool pins are not controller runtime dependencies.

These checks do not prove a guest boots, native input works, deadlines survive suspend or owned resources are reclaimed. Native experiments, signing, installation and deployment require explicit operator authorization. Provider-specific acceptance gaps remain in the contracts. Linux guest command execution has bounded fixture coverage; it does not confer consumer lease eligibility on every provider.

Back up existing databases before cutover. New module tables and wire compatibility do not establish a safe migration of legacy user, session or machine records. Do not run old and new controllers against the same writable state. Preserve controller identity, credential authority, ownership and uncertain-operation receipts; validate the installed schema and migration path before selecting retained state.
