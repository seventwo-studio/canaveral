# Experimental model-job wire contract

`model-job/1` is a portable text-generation data contract validated by
`coordination/src/model-job.ts` and `crates/execution-core/src/model_job.rs`.
The shared acceptance corpus is `fixtures/migration/model-job.json`.
It implements no HTTP route, scheduler, authorization service or native adapter.
TypeScript accepts plain data objects without accessors or serialization hooks; helpers
revalidate their inputs and deny malformed records. Rust also revalidates before
ownership, replay, receipt binding or release eligibility checks.
Parsing a record grants no execution authority or evidence of native support.

## Envelope and identity

Every object has exactly `version`, `applicationId`, `id` and `message`.
Only numeric version `1` is supported; unsupported versions fail closed without
fallback. Both IDs use lowercase, hyphenated UUIDs. The authenticated application
owns the job, and supplies and persists `id` before dispatch. Its idempotency key
is `(applicationId, id)`; job identity and submission identity are the same.

A lost reply permits resending the exact submission under the same key. Changed
adapter, model, digest, prompt or token limit under that key is a conflict, never
a new execution. `sameModelSubmission` / `same_submission` compare validated
records independent of object key order. Authentication, durable uniqueness,
transactional admission and conflict responses remain caller responsibilities.
`ownsModelJob` / `owns` require an independently authenticated application ID;
accepting the supplied application ID as authentication would defeat ownership.

## Messages

| `message.type` | Required fields besides `type` |
| --- | --- |
| `submit` | `adapter`, `model`, `digest`, `prompt`, `maxTokens` |
| `cancel` | None |
| `receipt` | `state`, `cancelRequested`, `stopped`, `cleanup`; `result` only for success |

Submission requires `adapter: "ollama"` and an exact lowercase
`sha256:` digest with 64 hex digits. `model` is a local operator-configured label:
1–200 ASCII characters, starting alphanumeric, then alphanumeric or `._:/-`,
without `cloud` (case insensitive). A label is never a URL, path or download
instruction, even if its syntax resembles one. The adapter must resolve the
label and digest against operator-installed inventory. Consumers cannot select
an executable, command, runtime URL, model path or download source. No runtime
or weights are installed by this library.

`prompt` contains scalar Unicode, at most 65,536 UTF-8 bytes, and at least one
character other than ASCII whitespace U+0009–U+000D or U+0020. `maxTokens` is an
explicit integer in 1–4,096 with no default. There is no tokenizer-preservation
promise. Success requires `result: {model, text, usage: {inputTokens,
outputTokens}}`. Text permits empty output and at most 131,072 UTF-8 bytes;
measured usage counts are integers in 0–2,147,483,648. Missing measurements are
invalid. `modelReceiptMatches` / `receipt_matches` bind a receipt's application,
job ID and successful result model to a stored submission. The durable assignment
must also bind the authenticated runner to the pinned model and digest.

Numbers must be finite, integral and within their stated ranges; booleans and
numeric strings are rejected. Integral JSON spellings such as `1.0` are accepted.
No integer may exceed JavaScript's safe range (9,007,199,254,740,991). Unknown,
missing, null, malformed and unsupported fields fail closed at every level.
Optional `result` must be omitted rather than null. These validators consume
JSON values, not a transport: framing, duplicate-key rejection, authentication,
body-size limits and redacted logging belong at the transport boundary. UTF-8
limits count decoded strings, not JSON escape bytes. Prompts/results must not be
logged by an integrating transport.

## Execution uncertainty, stop and cleanup

Canonical states are `queued`, `waitingForResources`, `running`, `unknown`,
`succeeded`, `failed` and `cancelled`. Cancellation is an intent message, not a
stop receipt. `cancelRequested` may accompany an unfinished, successful or failed
job: completion can race with cancellation. `cancelled` requires both cancellation
intent and positively confirmed `stopped: true`.

Nonterminal states, including `unknown`, require `stopped: false` and
`cleanup: "pending"`. They retain all reservations. An unknown outcome never
authorizes replay, relocation or replacement execution. Reconciliation requires
positive evidence; elapsed time or a missing connection is insufficient.
Terminal outcomes can still have pending cleanup. `cleanup: "complete"` requires
a terminal state and positive stop. Only that combination is eligible for
reservation release (`modelJobCanRelease` / `can_release`). A successful result,
failure or cancellation alone cannot release capacity.

`stopped` covers the owned execution scope; `cleanup` covers its temporary runtime
resources and per-job workspace. A never-started job also needs positive evidence
that no execution exists. Installed weights are outside per-job cleanup. Retained
prompt/result deletion and expiry are separate future contracts, not implied by
cleanup. A receipt is a claim until authenticated, bound to the current durable
assignment and reconciled with recorded evidence. These helpers implement no
ledger, revision ordering, host trust, deadlines or state-transition protocol;
they must not be used to accept stale or regressing receipts blindly.

## Existing API boundary and verification

This experimental version is distinct from the existing Python administrator
inference API. That API submits a flat `{id, model, prompt, maxTokens?, digest?,
hostId?}` object, supplies defaults, allows optional digest/host selection and
has no application ownership. Its reports use `state` and optional `result`;
its private runner receipts contain `fingerprint` and `report`. It has no explicit
wire stop/cleanup fields. Its encoded-JSON size limits also differ. None of those
objects can be passed directly to this contract, and no conversion or changed
Python behavior is implemented. Shared names and states are deliberate, not a
claim of wire compatibility. VM and session schemas are unchanged.

Both test suites consume the same valid/invalid cases, replay comparisons and
receipt bindings. Cases cover unsupported versions/adapters, strict fields,
canonical identity, numeric limits, ownership, uncertainty, cancellation and
cleanup; local tests also check UTF-8 byte boundaries. Run:

```sh
npm --prefix coordination run typecheck
npm --prefix coordination run build
npm --prefix coordination test
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

These are portable contract fixtures. They establish no native inference,
hardware qualification, controller integration or release acceptance.
