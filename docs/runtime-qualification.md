# Runtime qualification

A runtime is qualified only for an exact pin on an explicit scope, and only
after a maintainer promotes it in a reviewed pull request. Acceptance runs
produce evidence. They never qualify anything themselves. A hosted CPU smoke
test does not qualify production hosts.

The chain has three steps:

1. The [native acceptance suites](host-runtimes.md#native-acceptance) upload
   one JSON evidence artifact per cell. GitHub deletes these after 90 days.
2. `script/qualification.mjs record` copies the evidence from a trusted run into
   durable records under `qualification/records/`. It checks the evidence
   against the run, the commit and the exact pins in the tree.
3. A maintainer adds an entry to `qualification/promotions.json` that cites
   passing records. `script/qualification.mjs sync` turns the promotions into
   the tables that are compiled into the executor and the daemon.

## Scope

Each record and promotion covers one scope:

| Field | Values |
| --- | --- |
| `os` | `linux`, `macos` |
| `arch` | `x86_64`, `aarch64` |
| `acceleration` | `cpu`, `none`, `kvm`, `vz`. Accelerator values are reserved. |
| `executionMode` | `cpu-generation`, `root-lifecycle`, `detect-only`, `vm-boot`, `service` |

The exact pin is the record's `identity`. Its `pinId` is the version followed by
the first 12 hex digits of the SHA-256 of the canonical identity JSON.

| Backend | Identity | Promotable scope |
| --- | --- | --- |
| llama.cpp | Catalog version, archive URL and SHA-256, tree SHA-256 and executor package digest from [`runtime-pins.json`](../crates/model-execution/src/runtime-pins.json) | `cpu-generation` with `cpu` |
| containerd | Every installer asset's name, version, URL, size and SHA-256 from [`pins.rs`](../crates/host-installer/src/pins.rs) | `root-lifecycle` with `none` |
| libvirt | Detected `virsh` version | `vm-boot` with `kvm` |
| Apple Virtualization | Detected macOS version | `vm-boot` with `vz` |
| Ollama | Same as llama.cpp | Blocked: `ollama_host_isolation_missing` |
| vLLM, MLX-LM | None | Blocked: `runtime_package_unavailable` |

Ollama serves an unauthenticated loopback API. It stays unpromotable until
Canaveral enforces host ingress, egress and filesystem isolation. The promotion
validator, the Rust executor and the daemon each encode this block.

No workflow boots a guest yet. Libvirt and Apple Virtualization records are
`detect-only`, so they cannot satisfy a promotion. `canaverald` service records
(`executionMode: service`) only support promotions. They qualify nothing on
their own.

## Records

Records live at
`qualification/records/<backend>/<pinId>/<os>-<arch>-<acceleration>.json`.
Service records live at
`qualification/records/canaverald/service/<os>-<arch>-<manager>.json`.
[`record.schema.json`](../qualification/schema/record.schema.json) defines
the format. Each record contains:

- `identity`, `pinId` and `scope`
- `outcome`, which is `passed`, `blocked` (the cell ran but the backend reported a
  blocker) or `failed`, together with any `blockers`
- `evidence`: steps with outcomes and durations, the test model digest, and
  selected observations such as token usage or the KVM device
- `source`: repository, workflow, run ID, run attempt, run URL, event, ref,
  commit, job ID and conclusion, artifact ID and archive digest, and the SHA-256
  of the evidence file
- `runner`: the label, plus the `ImageOS` and `ImageVersion` of the hosted image
- `limitations`: what the evidence does not establish

Record a run while its artifacts still exist:

```sh
node script/qualification.mjs record --run RUN_ID --dry-run
node script/qualification.mjs record --run RUN_ID
```

The tool reads data only through `gh`. It refuses the whole run if any of these
checks fail:

- The run belongs to `seventwo-studio/canaveral` and its head is not from a fork.
- The event is `push`, `schedule` or `workflow_dispatch`. Pull request runs are
  smoke checks and may carry fork code.
- The run has completed and comes from one of the three acceptance workflows.
- The run commit is in the checked-out history.
- Each artifact archive matches the digest GitHub reports and contains a single
  JSON file.
- Each evidence file names the run commit, has a runner image version and maps to
  a job in the same attempt on the expected runner label.
- The engine, model and containerd digests in the evidence equal the pins in the
  checked-out tree.

A record for a later run of the same pin and scope replaces the earlier file.
Git history keeps the old one. Failed cells produce `failed` records. These
break any promotion that cites the path until a maintainer reviews the failure.

## Promotion

[`promotions.json`](../qualification/promotions.json) is empty, so nothing is
qualified. To promote a pin:

1. Find a trusted run on a commit in `main`'s history, preferably a scheduled or
   dispatched run of `main`, and record it.
2. Add an entry with `backend`, `pinId`, `identity` and `scope` copied from the
   record. List the record paths in `records`, and at least one passing
   `canaverald` service record for the same OS and architecture in
   `supporting`. Add `review` with the pull request URL, the reviewer's
   GitHub login and the date. State the remaining gaps in `limitations`.
3. Run `node script/qualification.mjs sync`, which validates the entry and
   regenerates the embedded tables.
4. Update the acceptance assertions that expect `qualified: false` for the
   promoted cell. These are in `fixtures/model-execution/real-engine.mjs` and
   `fixtures/host-runtimes/*.sh`.
5. Open a pull request that cites the run and any required isolation or
   hardware evidence.

The validator rejects an entry in any of these cases:

- The backend is blocked.
- The scope is not the backend's promotable scope.
- The identity differs from the exact pin the tree ships for that OS and
  architecture.
- A cited record is missing, not `passed`, from an untrusted event, or covers a
  different pin or scope.
- The entry has no passing service record.
- The review or limitations are missing.
- Two entries share a scope.

## Derivation

`sync` writes the same table twice. Both copies are generated files. Do not
edit them.

- [`runtime-qualified.json`](../crates/model-execution/src/runtime-qualified.json)
  is compiled into `canaveral-model-execution`. The executor reports
  `qualified: true` for a llama.cpp pin only when an entry matches the
  compiled target's OS and architecture, `cpu` and `cpu-generation`, and the
  pin's full identity. The identity includes the package digest that the
  executor derives from the tree hash. The executor never reports Ollama as
  qualified.
- [`qualified-pins.ts`](../coordination/src/host-runtimes/qualified-pins.ts)
  is compiled into `canaverald`. The registry reports `qualified: true` for a
  model engine only when two conditions hold. The executor must report it,
  and the daemon's table must promote the catalog version for the host's OS
  and architecture. If a package is active, it must also be the promoted
  package digest. An executor report that marks Ollama, vLLM or MLX-LM as
  qualified is rejected as `model_executor_invalid_report`. Containerd
  qualifies only when it is `verified` and every receipt asset's name,
  version and SHA-256 matches a promoted identity. Libvirt and Apple
  Virtualization qualify only when they are `verified` and the detected
  version matches a promoted `vm-boot` entry.

Host config, the CLI and environment variables cannot change either table.

## Continuous checks

[`qualification.yaml`](../.github/workflows/qualification.yaml) runs the tool's
tests and `node script/qualification.mjs check` on pull requests that touch
records, promotions, pins or generated tables. The check:

- validates every record and the promotions against their schemas and the rules
  above
- confirms that both generated tables match `promotions.json`
- lists records whose pin no longer matches the tree as stale, without failing

## Current records

These records were captured on 23 November 2026 from push runs of
`feat/runtime-acceptance` at commit `65e28f4`. Each run is on attempt 1.
The run IDs are
[model 45231181336](https://github.com/seventwo-studio/canaveral/actions/runs/45231181336),
[host 45231181163](https://github.com/seventwo-studio/canaveral/actions/runs/45231181163)
and [daemon 45231181144](https://github.com/seventwo-studio/canaveral/actions/runs/45231181144).
All engine, model and containerd digests match the current tree.

| Backend | Scopes | Outcome |
| --- | --- | --- |
| llama.cpp 1.0.0 | Linux x86_64 and aarch64, macOS aarch64; `cpu-generation` | Passed |
| Ollama 0.40.17 | Linux x86_64 and aarch64, macOS aarch64; `cpu-generation` | Passed, unpromotable |
| containerd 2.4.2 | Linux x86_64 and aarch64; `root-lifecycle` | Passed |
| libvirt 10.0.0 | Linux x86_64 `kvm`; `detect-only` | Passed detection |
| libvirt 10.0.0 | Linux aarch64; `detect-only` | Blocked: `libvirt_kvm_missing` |
| Apple Virtualization | macOS 15.8.2 and 26.7.2; `detect-only` | Blocked: `apple_os_unsupported`, `apple_runner_missing` |
| canaverald service | systemd on Linux x86_64 and aarch64, launchd on macOS aarch64 | Passed. macOS ran as the hosted runner account. |

Nothing is promoted.

These records cover hosted runners only. They do not establish production
hardware, accelerators, resource fit or isolation from untrusted callers.
Records bind evidence to a pin, not to later executor or daemon code. Prefer
recent scheduled runs on `main` when promoting.
