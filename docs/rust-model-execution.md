# Rust owned model execution

`canaveral-model-execution` connects the TypeScript controller's public runner
claim, assignment-list and report routes to an owned Ollama `serve` process.
It reuses `execution-core::model_job` and `runner-client::Binding`. It does not
install a runtime, download weights, enroll a runner or advertise capacity.

Build with the repository's pinned Rust toolchain. Run one assignment with:

```sh
cargo build --locked -p canaveral-model-execution
./target/debug/canaveral-model-execution /absolute/private/runner.json
```

Reinvoke with the same configuration and private state to process another job or
reconcile a lost reply. A successful invocation may mean no eligible job, a
completed assignment, or an acknowledged unknown receipt. Inspect the controller
job state to distinguish them. An unresolved assignment blocks new claims.

The operator supplies every field in this configuration. Paths are absolute;
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
    "executable": "/absolute/operator/ollama",
    "executableSha256": "<64 lowercase hex digits>",
    "modelsDir": "/absolute/operator/installed-models",
    "inventory": { "operator-model:tag": "sha256:<64 lowercase hex digits>" },
    "stateDir": "/absolute/private/model-execution",
    "startupMs": 20000, "executionMs": 120000,
    "contactMs": 20000, "stopMs": 5000,
    "responseBytes": 262144, "contextTokens": 8192
  }
}
```

`caFile` may be omitted or null to use system roots. Plain HTTP is accepted only
for an IP-literal loopback origin. Redirects, proxy inheritance and automatic
HTTP retries are disabled. The executable takes no consumer-supplied command,
runtime endpoint, path or download source. Its bytes are copied into the private executor state while hashing and fsynced
before the HTTP claim request. Staging errors abort before claiming: queued
application jobs and reservations remain unchanged. The verified artifact is reused only within that invocation;
restart never restages while reconciling an unresolved assignment. Execution
requires the operator's SHA-256 to match. It must be a self-contained executable that supports `serve`, remains
in the owned process group and keeps its generation listener in the leader.
Native distribution compatibility is unproven on both Linux and macOS.
Distributions needing adjacent executable assets are unsupported; copying one
binary has not qualified any packaged Ollama release.

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
  target/debug/deps/owned-<test executable hash>
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
