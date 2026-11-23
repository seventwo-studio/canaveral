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
3. A maintainer adds an entry to `qualification/promotions.json`. The entry
   cites passing records from runs of `main` by path and content digest.
   `script/qualification.mjs sync` turns the promotions into the tables that
   are compiled into the executor and the daemon.

## Scope

Each record and promotion covers one scope:

| Field | Values |
| --- | --- |
| `os` | `linux`, `macos` |
| `arch` | `x86_64`, `aarch64` |
| `acceleration` | `cpu`, `none`, `kvm`, `vz`. Accelerator values are reserved. |
| `executionMode` | `cpu-generation`, `root-lifecycle`, `detect-only`, `vm-boot`, `service` |

The exact pin is the record's `identity`. Its `pinId` is the version followed by
the first 24 hex digits (96 bits) of the SHA-256 of the canonical identity
JSON. The canonical form uses sorted keys and no whitespace.

| Backend | Identity | Suite | Promotable scope |
| --- | --- | --- | --- |
| llama.cpp | Catalog version, archive URL and SHA-256, tree SHA-256 and executor package digest from [`runtime-pins.json`](../crates/model-execution/src/runtime-pins.json) | Model acceptance | `cpu-generation` with `cpu` |
| containerd | Every installer asset's name, version, URL, size and SHA-256 from [`pins.json`](../crates/host-installer/src/pins.json) | Host acceptance | `root-lifecycle` with `none` |
| libvirt | Detected `virsh` version | Host acceptance | Blocked: `vm_components_unbound` |
| Apple Virtualization | Detected macOS version | Host acceptance | Blocked: `vm_components_unbound` |
| Ollama | Same as llama.cpp | Model acceptance | Blocked: `ollama_host_isolation_missing` |
| vLLM, MLX-LM | None | Model acceptance | Blocked: `runtime_package_unavailable` |
| canaverald service | Service manager, Node.js version and account | Daemon acceptance | Supporting evidence only |

A backend's records must come from its own suite. `check` rejects any other
workflow.

Ollama serves an unauthenticated loopback API. It stays unpromotable until
Canaveral enforces host ingress, egress and filesystem isolation. The promotion
validator, the Rust executor and the daemon each encode this block.

Virtual machine promotions stay disabled until two things exist: a workflow
that boots a guest, and records that bind the exact QEMU, libvirt and Swift
runner components the boot used. The current libvirt and Apple
Virtualization records are `detect-only`. The validator and the daemon
both refuse to qualify these backends.

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
- `source`: repository, workflow, run ID, run attempt, run URL, event, full ref
  (`refs/heads/<branch>`), commit, job ID and conclusion, artifact ID and
  archive digest, and the SHA-256 of the evidence file
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
- The run is attempt 1. The artifacts API does not say which attempt produced an
  artifact, so the tool refuses re-run attempts. Dispatch a fresh run instead.
- For a run on `main`, GitHub's comparison API shows that the commit is
  reachable from `main`. The check does not use the local checkout.
- GitHub reports a digest for each artifact, and the downloaded archive matches
  it. Each archive contains a single JSON file.
- Each evidence file names the run commit, has a runner image version and maps to
  a job in the same attempt on the expected runner label.
- The engine, model and containerd digests in the evidence equal the pins in the
  checked-out tree.

Runs on other branches produce informational records. The tool labels them as
not promotable.

A record for a later run of the same pin and scope replaces the earlier file.
Git history keeps the old one. Failed cells produce `failed` records.
Promotions bind each record to a digest, so a replaced record breaks every
promotion that cites it. The promotion must then be reviewed again.

## Promotion

[`promotions.json`](../qualification/promotions.json) is empty, so nothing is
qualified. To promote a pin:

1. Record a first-attempt push, scheduled or dispatched run of `main` within 90
   days of the run.
2. Add an entry with `backend`, `pinId`, `identity` and `scope` copied from the
   record. Cite the records in `records` as `{ "path", "sha256" }`. The `record`
   command prints each digest, which is the SHA-256 of the file's exact bytes.
   In `supporting`, cite at least one passing `canaverald` service record from
   a run of `main` for the same OS and architecture. Add `review` with the pull
   request URL, the reviewer's GitHub login and the date. State the remaining
   gaps in `limitations`.
3. Run `node script/qualification.mjs sync`, which validates the entry and
   regenerates the embedded tables.
4. Update the acceptance assertions that expect `qualified: false` for the
   promoted cell. These are in `fixtures/model-execution/real-engine.mjs` and
   `fixtures/host-runtimes/*.sh`.
5. Open a pull request that cites the run and any required isolation or
   hardware evidence.

`check` works offline. It rejects an entry in any of these cases:

- The backend is blocked.
- The scope is not the backend's promotable scope.
- The identity differs from the exact pin the tree ships for that OS and
  architecture.
- A cited record is missing, or its bytes no longer match the cited digest.
- A cited record does not claim a first-attempt trusted run of `refs/heads/main`
  in this repository from the backend's own suite.
- A cited record is not `passed`, or covers a different pin or scope.
- The entry has no passing service record.
- The review or limitations are missing.
- Two entries share a scope.

On pull requests, `verify` compares every record that a new or changed
promotion cites with the GitHub API. It fetches the run and requires the
repository, a non-fork head, a trusted event, the `main` branch, attempt 1, the
backend's workflow and the commit. It also requires that the commit is
reachable from `main`. It then fetches the artifact, checks that the artifact
belongs to the run and matches its digest, and rebuilds the record from the
evidence and the job. The rebuilt record must equal the committed record
exactly. `verify` needs the artifact, so promote within the 90-day retention
window.

## Derivation

`sync` writes the same table twice. Both copies are generated files. Do not
edit them.

- [`runtime-qualified.json`](../crates/model-execution/src/runtime-qualified.json)
  is compiled into `canaveral-model-execution`. The executor reports
  `qualified: true` for a llama.cpp pin only when an entry matches the pin's
  full identity, the compiled target's OS and architecture, `cpu` and
  `cpu-generation`. The identity includes the package digest that the
  executor derives from the tree hash. Each status row includes the host's
  full `catalogPin` identity. The executor never reports Ollama as qualified.
- [`qualified-pins.ts`](../coordination/src/host-runtimes/qualified-pins.ts)
  is compiled into `canaverald`. The registry reports `qualified: true` for a
  model engine only when two conditions hold. The executor must report it
  with a well-formed `catalogPin`. The daemon's table must promote exactly
  that identity for the host's OS and architecture, not just its version. If
  a package is active, it must also be the promoted package digest.
  - An executor report that marks Ollama, vLLM or MLX-LM as qualified, or
    claims qualification without a `catalogPin`, is rejected as
    `model_executor_invalid_report`.
  - Containerd qualifies only when it is `verified` and every receipt asset's
    name, version and SHA-256 matches a promoted identity.
  - Libvirt and Apple Virtualization never qualify for now.

Host config, the CLI and environment variables cannot change either table.
Two build checks catch stale or hand-edited tables:

- The executor's build script fails unless every model-engine entry names an
  exact catalog pin with a correct `pinId`. In a source checkout, it also
  requires the table to match `promotions.json`.
- `script/package_checks.mjs` runs `check` when it loads. CLI preparation,
  runtime releases and guest bundles all import it, so a failed check stops
  each of them.

The container image build copies neither `qualification/` nor the tool. That
build relies on the executor's catalog check and on CI having passed for the
commit.

## Continuous checks

[`qualification.yaml`](../.github/workflows/qualification.yaml) runs two jobs
on pull requests that touch records, promotions, pins or generated tables:

- The tool's tests and `node script/qualification.mjs check`. This job also
  lists records whose pin no longer matches the tree as stale, without failing.
- `node script/qualification.mjs verify` against the base branch's promotions.
  This job has `contents: read` and `actions: read` and uses only the job's
  token.

`npm run test:tools` in the validation workflow also runs the tool's tests,
including `check` against the committed state.

## Current records

These records were captured on 23 November 2026 from push runs of
`feat/runtime-acceptance` at commit `65e28f4`. Each run is on attempt 1.
The run IDs are
[model 45231181336](https://github.com/seventwo-studio/canaveral/actions/runs/45231181336),
[host 45231181163](https://github.com/seventwo-studio/canaveral/actions/runs/45231181163)
and [daemon 45231181144](https://github.com/seventwo-studio/canaveral/actions/runs/45231181144).
All engine, model and containerd digests match the current tree. These are
branch runs, so the records are informational and cannot support a promotion.

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
recent scheduled runs of `main` when promoting.
