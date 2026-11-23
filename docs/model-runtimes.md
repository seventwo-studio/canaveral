# Managed model runtimes

## Product requirements

Accepted on 17 November 2026: Canaveral supports multiple popular model runtimes
and chooses a compatible execution path for the host and model. Bundle or embed
runtime components where practical. External engines such as Ollama are also
managed by Canaveral: users must not install an engine separately, start its
service, or connect Canaveral to an existing unauthenticated endpoint.

The user-facing operation is selecting a model. Runtime release selection,
installation, private runtime state, startup, shutdown and updates belong to
Canaveral. Runtime paths, download origins, process arguments and backend
environment variables are trusted distribution configuration, never consumer
request fields. This requirement supersedes the earlier manual runtime
installation assumption for the managed Rust model execution path. The legacy
TypeScript inference adapter has not acquired managed installation by implication.

## Runtime integration

The initial backend set is Ollama, llama.cpp, vLLM and MLX-LM. Each backend has
its own launch and model identity contract; OpenAI-compatible HTTP alone does
not establish compatibility. Keep the adapter in the immutable model catalog,
submission and executor configuration consistent. A backend mismatch must not
start a different engine under the original job identity.

Prefer distribution-bundled native llama.cpp components for portable GGUF
execution. MLX-LM targets Apple Silicon; vLLM targets qualified Linux accelerator
hosts. Ollama provides another managed native engine with hardware discovery.
These are compatibility choices, not a universal performance ranking. Select
using model format, supported operations, installed driver/backend support and
qualified resource limits. Measure latency, throughput and memory on the actual
host before claiming a runtime is faster or fits a model.

Bundling a complete runtime package and supervising its process is distinct
from linking an inference library into the executor. The current owned-process
boundary retains independent cancellation, crash isolation and positive stop
evidence. Do not describe bundled subprocesses as in-process inference. Optional
Python-based engines must carry their own interpreter and pinned dependencies;
the user does not install Python, pip packages or a virtual environment.

## Distribution and lifecycle

The [engine catalog](../crates/model-execution/src/runtime-pins.json) ships inside
the trusted Canaveral release. It pins the upstream archive URL, byte count,
SHA-256 and extracted tree for each engine and host combination. The Rust
executor owns the package store and provisions the matching engine before
claiming work. The local [management commands](rust-model-execution.md#runtime-management)
can prepare and verify the same cache ahead of a job.

| Engine | Pinned release | Catalog hosts |
| --- | --- | --- |
| Ollama | v0.40.17 | macOS aarch64 |
| llama.cpp | v1.0.0, binary tag b12359 | macOS aarch64, Linux aarch64 and x86_64 |

The Ollama Linux assets use Zstandard and need additional archive format support.
Separate GPU builds are deferred. MLX-LM and vLLM remain unavailable in the
catalog pending qualified hermetic packages. Every entry remains unqualified for
native operation.

The executor verifies compressed size and SHA-256 before opening an archive and
publishes only a complete verified tree. Installation preserves relative
library and helper paths. The upstream library aliases that these releases
require become regular files. Published versions remain available while a
live or unresolved journal references them. For older journals without a
package identity, the executor retains every version until reconciliation.

Model artifacts remain separately pinned. GGUF models and model snapshot
directories require explicit local artifact identities; a public label is never
a filesystem path, download instruction or permission to execute model code.
Native model and runtime packaging must establish completeness, offline loading
and immutable inventory before production qualification.

One resource domain accounts for the physical host even when several backend
workers use it. Preserve existing owned assignments, scoped credentials,
transactional reservations, bounded context/output, cancellation, process-group
fencing and durable unknown outcomes. An uncertain operation is never retried
using another engine. Runtime installation and version changes must not replace
an unresolved execution's artifacts or receipts.

## Verification boundary

Portable owned-runtime fixtures verify protocol, provisioning and lifecycle
behavior. They load no model weights and do not qualify the distributed engines.
Real runtime releases, native library loading, process topology, accelerator use,
model quality, resource fit and ingress/inventory isolation need separate native
acceptance. Keep release pins and [third-party notices](../THIRD_PARTY_NOTICES.md) current.
Host qualification remains a separate gate for offering model capacity.

Implementation details: [Rust execution](rust-model-execution.md),
[model job wire contract](model-job-contract.md) and
[controller ledger](model-controller.md). Delivery and remaining acceptance are
tracked in [ST-599](https://linear.app/seventwo/issue/ST-599).
