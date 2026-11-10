# Embedded inference runners

Canaveral host runners execute local model workloads alongside machine assignments through an operator-installed Ollama binary on native Mac and Linux hosts. The controller places jobs and reserves capacity. Model identity, concurrency and context are bounded; downloads, hosted fallback and uncertain replay are not automatic. Native acceptance remains separate from portable fixture coverage.

## Configure a runner

Copy [host-inference.json](../examples/host-inference.json) into a private local
configuration. Replace both paths, the model ID and the placeholder digest with an
already installed local model's exact tag and SHA-256 digest. Ollama's `api/tags`
inventory supplies the digest; prefix a bare hash with `sha256:` in the configuration.
Canaveral neither installs the runtime nor pulls weights. Model preparation stays
an explicit operator action. Do not use an untrusted executable.

`provider: native` offers inference without requiring a VM backend. To share a host
with VMs, add the same `inference` section to its existing `apple` or `libvirt`
configuration. Keep one agent identity and one set of host limits for that physical
host. Enrolling the same physical capacity twice would bypass shared accounting.
KubeVirt and Hyper-V do not support this initial embedded runner.

The model's `resources` reserve CPU, RAM and temporary disk for each admitted job.
Set a conservative RAM budget covering weights, the bounded 8,192-token context,
loading peaks and runtime workspace. These are operator estimates, not measured
hardware guarantees. Installed model files and operating-system headroom must be
excluded from the capacity offered to Canaveral. Temporary disk reservations are
released when the runner positively confirms a terminal outcome; installed weights
remain outside that per-job reservation. Unknown model budgets must not be offered.

```sh
node coordination/dist/src/cli.js host --config ./host.json --state ./state/host \
  --enrollment-token-file ./secrets/enrollment.token
```

Keep the private host state across restarts. Once enrolled, the saved host identity
can reconnect without the enrollment credential, as with VM-only hosts.

## Submit and inspect work

Use the normal orchestrator administrator credential, or an administrator account
session. Existing enrollment and host credentials cannot submit or inspect jobs.
There is no new inference credential or separately exposed inference server.

```sh
node coordination/dist/src/cli.js --token-file ./secrets/admin.token models
node coordination/dist/src/cli.js --token-file ./secrets/admin.token generate \
  --model your-model:latest --prompt-file ./prompt.txt \
  --request-id 730111ad-aaee-421f-99c6-25e408489101
node coordination/dist/src/cli.js --token-file ./secrets/admin.token job \
  730111ad-aaee-421f-99c6-25e408489101
node coordination/dist/src/cli.js --token-file ./secrets/admin.token cancel-job \
  730111ad-aaee-421f-99c6-25e408489101
```

`--prompt-file -` reads stdin. Generation accepts a prompt whose UTF-8 and
JSON-encoded forms each fit 64 KiB, with 1–4,096 requested output tokens (default
600). Use `--digest` when multiple revisions of a tag are offered, and `--host-id`
to pin a host explicitly. Reuse the same request UUID and specification after a
lost response. A changed request with that UUID is rejected; it never reruns a job.

| Endpoint | Contract |
| --- | --- |
| `GET /v1/models` | Configured model offers, pinned digests, resources and host freshness/accepting state |
| `POST /v1/jobs` | Submit `{id, model, prompt, maxTokens?, digest?, hostId?}` and return the durable placement |
| `GET /v1/jobs` | Most recent 100 jobs without prompts or result bodies |
| `GET /v1/jobs/{id}` | State, placement, pinned definition and a successful result |
| `POST /v1/jobs/{id}/cancel` | Send `{}` to request cancellation |

Job states are `queued`, `waitingForResources`, `running`, `succeeded`, `failed`,
`cancelled` and `unknown`. A result includes `model`, `text` and measured
`usage.inputTokens` / `usage.outputTokens`. Missing counts, incomplete responses
and mismatched model identity fail the job. Text results fit 128 KiB of UTF-8 and
256 KiB encoded JSON. Jobs, prompts and results persist in the private controller
database; this initial operator API has no client-level ownership, automatic result
expiry or deletion. Protect backups accordingly. All administrators share access.

## Placement, execution and recovery

VMs and inference share one transactional CPU/RAM/disk ledger. A job is admitted
only to a fresh, accepting host with the exact offered model and enough unreserved
capacity. Up to 32 unfinished jobs can be assigned to a host. Queued jobs reserve
their full budgets; submission fails when capacity is unavailable instead of
creating an unbounded backlog. Draining blocks new assignments; existing jobs
continue. This remains the single-controller SQLite deployment contract.

The host's existing outbound heartbeat carries `inferenceReports` and receives
`inferenceJobs` alongside VM assignments. It runs inference in a separate worker
thread so loading and generation do not suppress heartbeats or VM reconciliation.
One model job executes at a time in assignment order. Queued cancellation can be
confirmed ahead of that order. Runtime and model paths remain local to the runner;
they are stripped from its public offer.

Each job starts an owned loopback Ollama process with a fresh port, no inherited
provider credentials or proxy settings, cloud disabled, one loaded model and one
inference request. The runner checks the exact installed digest and rejects remote
aliases before generation. It never calls model-pull endpoints or adopts an
existing Ollama service. Generation has a 120-second request timeout; startup has
a separate 20-second deadline. Completion, failure and cancellation all stop the
owned process group before confirming a terminal outcome. Models are unloaded by
process teardown; keeping models warm is deferred.

Local admission additionally preserves the greater of 2 GiB or 10% of physical RAM
and at least 2 GiB of free disk. Mac admission uses normal system memory pressure
and free, file-backed and purgeable pages, subtracting speculative overlap. Linux
uses `MemAvailable`. Compressed/anonymous app memory is not added as reclaimable
cache. Swap-out writes are sampled over a rolling 30-second window; 32 MiB of active
traffic blocks admission or stops running inference. Idle allocated swap alone
does not block work. Missing telemetry blocks admission, and resource waits expire
after ten minutes. During execution, resident weights are not subtracted again
from available RAM. Checks run between bounded runtime operations and each second
while generation is in progress; they do not create OS-level memory reservations.

Cancellation requests retain capacity until the assigned runner confirms the
process has stopped. A host loss marks unfinished jobs unknown and retains their
placement and reservations. The runner stops active inference when controller
contact has expired for 20 seconds or when the agent shuts down. There is no
automatic relocation or retry.

Before starting a runtime, the runner atomically writes a private per-job receipt.
Confirmed terminal receipts survive lost heartbeat responses and agent restarts.
A receipt left in `running` means its outcome is uncertain: the runner reports
`unknown`, retains capacity and blocks further inference on that agent. It does
not replay that job, even after cancellation. Inspect and positively fence the old
process and verify its effects before any manual repair. An operator recovery API
is not implemented; never delete running receipts merely to unblock work.

## Validation boundary

Portable tests exercise the real controller HTTP API, CLI, host inference worker
and a runner-owned child HTTP runtime fixture. They check mixed VM/inference
capacity, model identity, role separation, cancellation, active swap admission and
durable receipts. The fixture does not load model weights or validate inference
quality. Native Mac/Linux model runs and real concurrent VM boots remain live
acceptance work.

This is an initial generation runner. Model installation/management, warm models,
embeddings, decisions, Apple Foundation Models, PCC, MLX/audio/realtime, streaming,
per-client permissions and automatic recovery are future work. Dedicated GPU/VRAM
admission, measured model peaks, CPU/thermal admission and model-specific input
tokenization are also unimplemented. Ollama may truncate inputs to its configured
context; the first API does not promise tokenizer-verified prompt preservation.
Use CPU inference or a separately validated accelerator budget until actual model
and hardware acceptance establishes safe fit. Resource-safety acceptance remains incomplete.
