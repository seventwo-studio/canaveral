# Rust owned model execution

`canaveral-model-execution` connects the TypeScript controller's public runner
claim, assignment-list and report routes to owned Ollama, llama.cpp, vLLM or
MLX-LM runtime processes.
It reuses `execution-core::model_job` and `runner-client::Binding`. Runtime
packages are supplied through Canaveral's trusted distribution configuration;
users do not install a separate engine or attach an existing service. See the
[managed runtime requirements](model-runtimes.md). Model downloads, runner
enrollment and capacity advertisement remain separate lifecycle concerns.

Build with the repository's pinned Rust toolchain. Run one assignment with:

```sh
cargo build --locked -p canaveral-model-execution
./target/debug/canaveral-model-execution /absolute/private/runner.json
```

Reinvoke with the same configuration and private state to process another job or
reconcile a lost reply. A successful invocation may mean no eligible job, a
completed assignment, or an acknowledged unknown receipt. Inspect the controller
job state to distinguish them. An unresolved assignment blocks new claims.

The operator supplies the configuration below. Omit `runtimePackages` and
the legacy executable fields to use the compiled catalog for the selected
backend and host. Existing explicit per-file packages and the legacy Ollama
executable remain supported for execution. Paths are absolute;
the state directory must be owned by the effective user with mode 0700 and have an existing parent. The credential
file must be owned by that user, private, regular and single-linked. Credential,
CA and state paths reject symlinks in every component. Ancestors must be owned
by root or the effective user and reject group/other writes except root-owned
sticky temporary directories. Use physical paths (for example `/private/tmp`,
not macOS's `/tmp` alias). CA files must be regular, single-linked, owned by root
or the effective user, and not writable by group/others; empty CA bundles fail. `binding` comes from completed runner enrollment and needs
an explicit model/domain approval on the controller. The controller reserves the
catalogued resources; this executable never invents a host budget. Execution
budgets below are explicit operator limits, not capacity measurements.

```json
{
  "controller": "https://controller.example",
  "credentialFile": "/absolute/private/runner.credential",
  "binding": {
    "controllerId": "<UUID>", "runnerId": "<UUID>",
    "generation": 1, "incarnationId": "<UUID>"
  },
  "caFile": "/absolute/private/controller-ca.pem",
  "execution": {
    "backend": "ollama",
    "runtimePackages": [{
      "os": "macos", "arch": "aarch64",
      "root": "/absolute/canaveral/bundled/ollama",
      "entrypoint": "ollama",
      "files": { "ollama": "<64 lowercase hex digits>" }
    }],
    "modelsDir": "/absolute/operator/installed-models",
    "inventory": { "operator-model:tag": "sha256:<64 lowercase hex digits>" },
    "stateDir": "/absolute/private/model-execution",
    "startupMs": 20000, "executionMs": 120000,
    "contactMs": 20000, "stopMs": 5000,
    "responseBytes": 262144, "contextTokens": 8192
  }
}
```

This abbreviated package lists only its entrypoint; real release manifests must
also list every required backend library and helper. A legacy single-executable
configuration can use `executable` and `executableSha256` instead of
`runtimePackages`, for existing Ollama deployments only. It does not provide the
managed product setup flow.

`caFile` may be omitted or null to use system roots. Plain HTTP is accepted only
for an IP-literal loopback origin. Redirects, proxy inheritance and automatic
HTTP retries are disabled. The executable takes no consumer-supplied command,
runtime endpoint, path or download source. Runtime assets are verified and fsynced
in private executor state before the HTTP claim request. Installation errors abort
before claiming: queued application jobs and reservations remain unchanged.
Managed installations are revalidated and reused between invocations;
restart never restages while reconciling an unresolved assignment. Execution
requires the trusted release's SHA-256 to match. The runtime must remain
in the owned process group and keep its generation listener in the leader.
Native distribution compatibility is unproven on both Linux and macOS. For a
distribution with adjacent libraries or other assets, use a host-matched runtime
package below instead of the single-executable configuration.

## Host-matched runtime packages

Use Ollama's packaged native backends for the host: Metal on supported Apple
hardware, or supported CUDA, ROCm and Vulkan backends on Linux. Ollama discovers
compatible accelerators and selects model offloading; Canaveral does not infer
driver compatibility or safe model fit from a GPU name. See upstream
[hardware support](https://docs.ollama.com/gpu) and
[Linux distribution packaging](https://docs.ollama.com/linux).

In internal `execution` configuration, replace `executable` and
`executableSha256` with `runtimePackages`. Each entry identifies a release package and
pins every required file, including the entrypoint. Other execution fields,
including the model inventory and budgets, stay required.

```json
{
  "runtimePackages": [
    {
      "os": "macos",
      "arch": "aarch64",
      "root": "/absolute/operator/ollama-macos-arm64",
      "entrypoint": "ollama",
      "files": {
        "ollama": "<64 lowercase hex digits>",
        "lib/required-backend.dylib": "<64 lowercase hex digits>"
      }
    },
    {
      "os": "linux",
      "arch": "x86_64",
      "root": "/absolute/operator/ollama-linux-amd64",
      "entrypoint": "bin/ollama",
      "executables": ["lib/ollama/required-runner"],
      "files": {
        "bin/ollama": "<64 lowercase hex digits>",
        "lib/ollama/required-backend.so": "<64 lowercase hex digits>",
        "lib/ollama/required-runner": "<64 lowercase hex digits>"
      }
    }
  ],
  "acceleration": "auto"
}
```

The asset names above illustrate layout, not a distribution's actual file list.
Canaveral's distribution must provide the package for its pinned runtime release, retaining all executable,
library and backend paths it requires, and hash each file. Platform identifiers
are `macos`/`linux`; architecture identifiers are `aarch64`/`x86_64`. Exactly one
package must match the executor's OS and architecture. Missing or ambiguous
matches fail before claim; another platform's package is never a fallback.
Labels identify operator intent, not independently verified binary compatibility.

For a downloadable release, omit `root` and supply `baseUrl`, a credential-free
HTTPS directory ending in `/`. Canaveral fetches the listed relative assets
automatically; it accepts no redirects, proxy inheritance, URL credentials,
query strings or fragments. Each file is streamed and verified before the
installation is published. Requests have a 120-second timeout and 10-second
connection timeout, within a ten-minute installation deadline.

The executor stages only the pinned files into private state while preserving
their relative layout. It verifies hashes, trusted ownership and permissions and
rejects links and unsafe relative paths. Declare executable helpers in
`executables`; the entrypoint is always executable. Files receive mode 0500
(executable) or 0400 (other), directories 0700. Limits are 16 package candidates,
4,096 files per package, 2 GiB per file and 8 GiB total. Package staging failures consume no new
job or reservation. Package paths and hashes remain operator configuration; a
consumer cannot choose them. Do not combine package configuration with the legacy
executable/hash fields. Bundled assets are supplied by Canaveral; the managed
provisioner handles downloadable release assets. Driver and model preparation
remain separate from runtime package installation. A content-addressed installed
cache preserves the package layout. Every reuse verifies its exact file set,
hashes and modes, with no download or copy. Changed releases publish a verified
new cache before pruning unreferenced obsolete versions. A failed installation
preserves the prior version. Tampering in an existing cache fails closed.

Package entrypoints must have an ELF header on Linux or Mach-O/fat binary header
on macOS. Script entrypoints that depend on an ambient interpreter are rejected.
Header checks do not verify the executable architecture, dynamic dependencies,
code signature or runtime compatibility; those remain release qualification work.

`acceleration` defaults to `auto`, which leaves hardware selection to Ollama's
installed backends. Set it to `cpu` to disable CUDA, ROCm and Vulkan device
selection and submit `num_gpu: 0`, including on Metal hosts. Provider credentials,
proxy settings and caller backend overrides are not inherited. There is no
automatic retry with another package or backend after execution starts.

An automatic selection is not evidence that generation used a GPU, that GPU
memory fits the model, or that this is the fastest configuration. Qualify the
actual runtime release, driver, model, context size and concurrent workloads on
each host before offering its capacity. Account for staged runtime package disk
usage separately from per-job temporary disk reservations. The existing native
isolation gate remains open; package pinning does not isolate the model API or
make model weights immutable. This configuration applies to the Rust executor;
the legacy TypeScript embedded host inference adapter is a separate path.

## Runtime management

Supply the same private runner configuration with `--config`. These commands
use its state directory and the compiled engine catalog. They do not read the
credential or CA files, contact the controller, or start an engine.

```sh
canaveral-model-execution --runtime-status --config /absolute/private/runner.json
canaveral-model-execution --runtime-prepare --config /absolute/private/runner.json --backend llama.cpp --dry-run
canaveral-model-execution --runtime-verify --config /absolute/private/runner.json --backend llama.cpp
canaveral-model-execution --runtime-remove --config /absolute/private/runner.json --backend llama.cpp --version 1.0.0
```

Management backend names are `ollama`, `llama.cpp`, `vllm` and `mlx-lm`.
`prepare` downloads an absent pin and reuses a verified installation.
`verify` checks the current installed pin. `remove` accepts `--dry-run`, as
does `prepare`. Dry runs leave disk state untouched. Removal and pruning
hold the execution lock and retain packages referenced by live or unresolved
journals. An explicit removal of a referenced version returns `runtime_in_use`.
An older unresolved journal without a package digest protects the entire cache.

Each invocation writes one `canaveral-runtime-report` JSON line. Exit 0 means
success, exit 1 reports a failed or unknown operation in JSON, and exit 2
reports a usage or config error on stderr. A verified package has the pinned
files, digests, entrypoint header and modes. `qualified` records separate
native acceptance for that engine and host. The current catalog sets it to false.

### Archive pins

The catalog ships as [compiled-in release data](../crates/model-execution/src/runtime-pins.json).
Each archive uses the bounded HTTPS client. GitHub release URLs can follow one
redirect to GitHub's HTTPS release asset host. The executor checks exact
compressed bytes and SHA-256 before parsing, bounds expansion to 128:1 and
applies the per-file and package limits above. Each pin's `unpackedBytes` also
caps installed file data, including materialized aliases. The executor checks
filesystem free space for the download and installed tree, then checks again
before extraction. Both checks reserve a 64 MiB margin. Failed extraction
removes the staging directory under the executor lock.

Archives allow 4,096 entries with paths up to 1,024 bytes. Zstandard tarballs
use a single frame with an 8 MiB maximum window. The executor uses ruzstd for
pure-Rust streaming decoding with a configurable allocation bound, avoiding a
native dependency. ZIP support covers single-disk stored and deflated files
with standard end records. Unsafe paths, case collisions, special files,
set-id bits and hard links fail before publication. Catalog tarballs may opt
into materializing same-directory symlink chains from retained file descriptors.
Pinned omissions, such as the Ollama GPU subtrees, still undergo tar validation
and count toward decompressed stream limits. The installer discards permitted
PAX timestamp and Apple code-signing annotations, so native acceptance must
check any dependency on those attributes.

The executor verifies the staging directory's device and inode on either side
of publication. It verifies file digests during staging and checks the
entrypoint and other listed executables against their verified file metadata
before spawn.
As with [managed updates](runtime-updates.md), these checks assume a controlled
directory tree. Same-account concurrent malicious filesystem mutation is outside
that trust boundary. Old cache entries with unreadable or undecodable manifests
are skipped during inventory and pruning. A corrupt current package fails
verification. Explicit removal still refuses journal-referenced packages.

To update a pin, download the versioned upstream asset to a disposable directory.
Measure its byte count with `wc -c` and its SHA-256 with `shasum -a 256`.
Compare both against the release metadata and checksum list when available.
Update the URL, version, retrieval date, format, strip prefix, entrypoint and
executable paths in the catalog. Record the installed byte count after omissions
and including materialized aliases. Run the offline archive check with all
catalog assets present. The check prints the calculated tree digest if it differs from
`treeSha256`. Review the installed file layout and update the tree pin and notices
before landing the release. Remove the downloaded copies afterwards.

```sh
CANAVERAL_RUNTIME_PIN_FIXTURES=/absolute/temp/assets \
  cargo test --locked -p canaveral-model-execution downloaded_catalog_archives_match_tree_pins -- --ignored
```

## Backend and model configuration

`backend` is `ollama` (default), `llama.cpp`, `vllm` or `mlx`. It must match the
immutable catalog adapter and the submitted job adapter. Runner claims include
this backend, so an approved worker does not reserve jobs for another engine.
Use separate managed workers with one shared physical resource domain when
several backends serve the same host.

All non-Ollama backends require managed runtime packages. The entrypoint is a
native server or a Canaveral-packaged hermetic launcher with its own interpreter
and dependency closure. A host interpreter, user virtual environment, script
shebang pointing outside the package, or adjacent unlisted runtime library does
not satisfy this contract. Packages must be relocatable and preserve the process
leader/listener and owned-group topology; unverified topology fails closed.

`llama.cpp` accepts one local GGUF per model. Add `modelFiles` alongside the
existing `inventory`:

```json
{
  "backend": "llama.cpp",
  "inventory": { "local-model:1": "sha256:<GGUF file SHA-256>" },
  "modelFiles": {
    "local-model:1": {
      "path": "local-model.gguf",
      "files": { "local-model.gguf": "<GGUF file SHA-256>" }
    }
  }
}
```

Paths are relative to the private model root, never supplied by consumers.
Split GGUF and multimodal asset sets are not supported by this adapter.
`vllm` and `mlx` use local snapshot directories instead: `path` names a snapshot
subdirectory and `files` pins every file relative to that subdirectory. At least
`config.json` and one `.safetensors` file are required; a working tokenizer and
all runtime-required files must also be packaged. The inventory digest is SHA-256
of compact UTF-8 JSON for the sorted path-to-hash map (Rust `BTreeMap` order, no
whitespace). Each file and the whole snapshot identity are verified before claim.
Keep snapshots immutable during use; verification does not establish OS-level
immutability. No remote model identifier or trust-remote-code flag is passed.

MLX-LM is restricted to Apple Silicon macOS; vLLM to Linux. CPU policy is accepted
for Ollama and llama.cpp and rejected for MLX-LM/vLLM. llama.cpp uses zero GPU
layers in CPU mode. Automatic selection delegates accelerator discovery to the
packaged engine; it does not establish a measured accelerator budget.

llama.cpp, vLLM and MLX-LM use nonstreaming `/v1/completions`, with one plain prompt
and one choice. Results require a matching private model identity, terminal
`stop`/`length`, bounded text and measured prompt/completion usage. MLX-LM receives
only the fixed `default_model` alias; its public model label is restored after
validating that private identity. Other request aliases could load a different
model and are never forwarded. llama.cpp/vLLM receive a fresh private bearer key
for their owned listener. Ollama and upstream MLX-LM have no equivalent API-key
boundary here; their native ingress isolation gate remains open.

llama.cpp's context size and vLLM's maximum model length use `contextTokens`.
Upstream MLX-LM does not enforce this context budget through this adapter;
its output token limit and execution deadline are bounded, but context/KV-memory
acceptance remains open. None of these protocol limits constitutes a RAM/VRAM
hard limit. The Python-based packages do not add a Python requirement to the
controller, host agent or SDK.

Upstream protocol references: [llama.cpp server](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md),
[vLLM server](https://docs.vllm.ai/en/latest/cli/serve/), and
[MLX-LM server](https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/server.py).

## Ollama protocol

Each child has a cleared environment, private HOME/TMPDIR, one model/parallel
request, cloud disabled, `OLLAMA_NOPRUNE=1` and a fresh IPv4 loopback port.
The no-prune switch disables startup blob pruning in [upstream Ollama](https://github.com/ollama/ollama/blob/main/envconfig/config.go).
The adapter never deletes operator model inventory. Before claim, the model tree
must contain only regular single-linked files and directories, owned by root or
the effective user, with no symlinks or group/other write permission. The operator
must keep that trusted inventory stable throughout execution. Kernel socket ownership
is checked before inventory and generation requests. The exact submitted tag
and manifest digest must match both operator inventory and `/api/tags`; no pull endpoint
is called. This pins reported manifest identity only. Blob bytes are not hashed
and content integrity of the installed weights is not established. Generation uses `stream: false`, explicit `num_predict` and `num_ctx`,
and no warm retention. Results require `done`, matching model identity, text
within the canonical contract, and measured input/output token counts. Output
tokens cannot exceed the submitted limit. Context does not promise preservation
of the complete prompt under Ollama's tokenizer. CPU/RAM hard containment and
model-specific fit are not established by these protocol budgets.

Runtime stdout/stderr are discarded. Errors contain fixed codes, never prompt,
result, controller response text, credentials or local paths. HTTP bodies are
checked for duplicate JSON keys and bounded separately from the model contract's decoded UTF-8 text limits.

## Durable lifecycle

One lifetime advisory lock protects the private executor state. `claim.json`
contains a UUID claim intent and its complete binding before the HTTP claim.
A lost claim reply reuses that ID. `receipt.json` stores every assignment/job,
submission, binding, sequence and exact receipt. Atomic replacement synchronizes
the file and directory. Failed publication poisons the instance. Under an exclusive validated lock,
reopening discards only unpublished `receipt.next` and `claim.next` entries and
fsyncs the directory, retaining committed claim/receipt identity. Malformed
committed state fails closed. State and lock inode identity are revalidated
before descriptor-relative reads and atomic publications. These files contain prompts and results;
protect them and their backups. No automatic retention deletion is implemented.

Launch intent is durable before workspace creation or process launch. The first
report is sequence 1; this minimal adapter publishes a final or unknown receipt
rather than an intermediate running report. Each report is durable before send.
Lost report replies replay the exact sequence/receipt. Completed job history is
retained across fresh jobs, so earlier execution cannot be replayed locally.

Cancellation is read from the claimed assignment and subsequent authenticated
assignment listings. Changed/missing assignments or failed controller contact
fence execution. Mac deadlines use continuous Mach time; Linux uses BOOTTIME.
Contact age is measured from the start of the last validated claim/list request,
not its reply. The contact budget is `min(contactMs, 20000)` milliseconds.
Assignment polling starts at 100 ms intervals with at most one outstanding request;
its timeout is the remaining contact budget. Both controller listings and runtime
HTTP requests run off the supervision loop. Startup starts at process spawn;
generation starts immediately before dispatch. The loop checks cancellation and
suspend-aware deadlines about every 20 ms without waiting for listing completion.
Staging and model-tree validation happen before claim and consume no claimed
contact budget. Filesystem/kernel scheduling stalls are not hard realtime bounds.

Cancellation, generation/startup deadlines and controller fencing stop the owned
process group before deleting the workspace or publishing a stop receipt. Stop
sends TERM, permits up to `min(stopMs / 4, 50)` ms for descendant reaping, then
sends KILL while the leader is still unreaped. Startup observes exit with
`waitid(WNOWAIT)`. No group signal is sent after leader reaping; subsequent group
probes can conservatively retain a reservation if a group identity is reused.
The whole stop phase uses `stopMs`, checked about every 10 ms.
Positive group disappearance is required, including descendants that remain in
that group. An escaped/daemonized descendant is outside this adapter's supported
runtime contract; arbitrary subprocess orchestration is unsupported.

If stop cannot be established, the receipt is unknown with pending cleanup. A
lost runtime generation response or body also remains unknown; transport failure
is never generally converted to terminal failure. The journal's `stopConfirmed`
and `cleanupConfirmed` independently preserve positive evidence even when the
public unknown receipt must retain `stopped: false` and pending cleanup.
A generation request timeout/deadline means the bounded operation failed; it may
be terminal `failed` only after positive process-group fencing and workspace
cleanup. It cannot be mistaken for successful generation and is never retried.
A prelaunch executable read failure has no runtime effect and may be terminal
failed after workspace cleanup. Restart with launch
intent and no durable terminal receipt reports unknown and never adopts a PID,
reruns work, cleans the uncertain workspace or releases its reservation. Exact
terminal result/cleanup receipts survive restart. Unknown and failed-cleanup
reconciliation requires a separate positive-evidence recovery implementation;
there is no repair command and deleting state is not recovery. Binding changes
are rejected rather than adopting another generation/incarnation's work.

## Disposable verification and remaining gates

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cargo build --locked -p canaveral-model-execution
node fixtures/model-execution/public-api.mjs \
  coordination/dist/src/main.js target/debug/canaveral-model-execution \
  "target/debug/deps/owned-REPLACE_WITH_TEST_EXECUTABLE_HASH"
```

Build the TypeScript controller first with `npm --prefix coordination run build`.
Use the `owned-*` executable printed by `cargo test --test owned`. It is a
Rust HTTP fixture selected by the test harness's `serve` filter, not Ollama; it
loads no model. The public API fixture creates and removes only disposable
controller/executor state, credentials and owned test processes. It covers
application submission, transactional reservation, generation, measured usage,
cancellation, cleanup, fresh jobs, shared-domain contention, lost claim/report replay and a crashed
execution's unknown reservation retention. Rust cases additionally cover pin and
inventory rejection, `/api/tags` digest mismatch, foreign socket ownership,
output bounds, deadlines, private-file/link rejection, lock replacement,
unpublished-candidate recovery and durable no-replay behavior. A stalled
assignment-list response cannot postpone the public fixture's generation deadline;
cancellation checks both PID disappearance and workspace removal.

Build the `runtime_fixture` test target and pass its compiler artifact path as a
fourth argument to `public-api.mjs` to exercise managed backend packages through
the application/controller/runner HTTP flow. This runs llama.cpp's strategy on
every supported host, vLLM's on Linux and MLX-LM's on Apple Silicon macOS, using
only disposable protocol executables. It verifies a second job succeeds from
the installed cache after bundled source assets are removed. The executor's
unit fixtures exercise all protocol strategies independent of production host
policy; this does not grant platform compatibility.

Managed provisioning fixtures cover downloaded asset hashes, cache reuse,
redirect/credential rejection, helper modes, tampering and failed version
installation. The offline distribution packager is covered by
`node --test script/package_model_runtime.test.mjs`.

Fixture results establish no native model quality, model/runtime installation,
hardware fit, Linux/macOS distribution qualification, escaped-process containment,
suspend timing under real sleep, shared VM admission or production cutover.
Streaming, warm models, embeddings and non-text modes are explicitly unsupported.
Windows and other platforms lack this adapter's socket ownership/clock support.
Native execution remains a separately authorized evidence gate.

## Native isolation gate

The Ollama loopback API has no authentication. Other local principals can reach its
mutation and generation endpoints; socket ownership checks do not prevent this.
`OLLAMA_NOPRUNE` prevents startup pruning but is not a read-only model-store or
network-isolation boundary. A local caller could replace a manifest or request
additional work between inventory verification and generation. This adapter is
not qualified for native operation with untrusted local callers or concurrently
writable inventory. Native acceptance must prove an isolated ingress boundary and
immutable/read-only model inventory (including installed blob integrity), in
addition to runtime distribution and resource fit. Those enforcement mechanisms
are not implemented here; loopback fixtures do not close this gate.

Upstream MLX-LM also lacks an API-key boundary in this integration. vLLM's bearer
key protects the `/v1` routes used here, but other same-listener endpoints can
remain unauthenticated; see [vLLM security](https://docs.vllm.ai/en/latest/usage/security/).
A successful authenticated completion does not establish full server isolation.
Native qualification must check all reachable endpoints, runtime subprocess
topology and package dependency closure for each backend. No maintained native
engine releases or model weights are included in the portable fixtures.
