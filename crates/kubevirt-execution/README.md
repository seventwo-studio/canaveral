# KubeVirt execution adapter

Partial native integration for the Linux lease runner wire, with Unix-only private state. This crate performs
concrete Kubernetes HTTPS calls for a CSI snapshot clone PVC, immutable cloud-init
Secret and KubeVirt VM. It does not run the outbound satellite engine, claim leases,
send receipts, expose guest access, qualify lease execution or establish readiness.
Default builds unconditionally reject `create` before API requests, including
resume and preparation in a fresh directory with a replayed assignment clock.
No production deadline fence or admission proof implementation ships here.
`DeadlineFence` is sealed in default builds; only `MissingFence` is available.
Injectable fences and the simulated creation path exist only within this crate’s
unit tests. There is no Cargo feature that enables them for downstream callers.
An always-successful fixture fence provides no deadline enforcement.

## Required integration gate

A VM can outlive both its satellite and a cluster API partition. Implementing a
reviewed independent cluster fence is the next integration gate before production
creation can be enabled. It must prevent fresh and replayed late creates, bind the
exact assignment, enrolled generation, creation ID, image digest and deadline to a
pinned/signed admission proof carried in the manifest and expiry annotations, and
independently stop execution through process/API failure. The local integration
must age controller time with a continuous monotonic clock, account for latency,
persist sticky expiry across resume, and never extend authority from an old revision.
No custom cryptography or admission controller is proposed by this fixture slice.

`MissingFence` also blocks adapter stop evidence before API calls: this is missing
authorization/evidence, not proof that an operator cannot safely stop or clean up
the resources through a separately reviewed procedure. API absence never proves
independent quiescence or erasure.

The separate `storage_erased` and `credentials_erased` hooks default to false.
They need reviewed backend evidence for the exact PVC/Secret UIDs, including guest
copies, retained PVs and storage/secret replicas. API absence is only one
prerequisite. Do not translate an observation into a complete controller receipt
until these gates and the runner's terminal-lease rules are satisfied.

## Integration API

`prepare` validates scope, canonical UUIDs, binding, exact inventory image and held
CPU/memory/disk resources before creating a private journal. `Assignment` is the
backend projection of the current wire plus the canonical VM ID and binding;
the satellite must validate the complete held wire assignment before projecting it.
VM ID is stable input, not a fresh ID minted during restart. `resume` requires the
same complete projection, scope and inventory. Deadline renewal integration is not
implemented; changed projections are refused. Use a canonical absolute private
state path, with no symlink ancestors. State uses descriptor-relative opens,
exclusive process locking, mode checks, atomic replacement and file/directory fsync.
Do not copy a live state directory to another runner.

The fixture-only `create(userdata)` path validates the simulated fence, checks the operator-installed snapshot UID
and readiness, and creates the PVC, Secret and VM in order. The immutable installed
inventory maps the exact catalog digest to a same-namespace CSI snapshot UID,
architecture, storage class and disk capacity. The operator must verify the disk
contents/digest and keep the snapshot name/UID mapping immutable under admission
policy throughout cloning; CSI dataSource references themselves are name-based.
No registry image, download, arbitrary host command or ingestion path exists.
Disk capacity must equal the installed snapshot size and held assignment. The
manifest sets exact domain CPU and memory requests/limits and PVC requested size.
Launcher overhead and storage provisioner rounding still require capacity/admission
review; these fixtures do not measure actual host consumption.

Every resource has a durable creation intent before its sole POST. The journal
binds the full assignment/inventory/scope fingerprint, creation ID and recovered
UID. It stores only a bootstrap-content digest, never plaintext bootstrap data.
A pending create never retries POST, even after GET 404. `recover(kind)` can pin
only a matching name, namespace, kind, API version, creation annotation, assignment
fingerprint and prior UID if known. Uncertain creates that never reached the API
remain blocked for separate reviewed reconciliation. Never remove their intent to
force a retry. New bootstrap contents, same-name replacements and different
bindings are refused.

`observe` follows VM → VMI → launcher/migration pods → support pod controller
references, checking kind/API/name/UID, namespace, duplicates, cycles, missing
parents and contradictory identity labels/annotations. It persists proven
descendants before deletion so surviving support pods remain attributable after
parents disappear. Same-name orphan VMIs and incomplete inventories withhold stop.
Namespace VMIs and pods are listed in bounded pages with opaque continuation
cursors and a consistent resource version; failed, missing, repeated or changed
pages withhold evidence. HTTPS requests use metadata-only list negotiation, so
unrelated workload specifications are not queried. There is no aggregate pod cap.
Clusters that cannot serve metadata-only inventory fail closed. Metadata-only
inventory does not report VMI runtime phase; `running: None` means unknown and is not stop evidence. Observations are sequential reads,
not an atomic cluster snapshot; independent fencing is essential.

`stop` durably forbids further creation, quiesces the fence and requests foreground
VM deletion using its exact UID precondition. It leaves PVC/Secret resources intact.
`cleanup` requires positive stop before separate exact-UID PVC/Secret deletes.
Deletion acceptance is not deletion completion; unknown HTTP errors/timeouts remain
errors. Only successful exact GET 404 establishes API absence, and never ownership.
Unrelated namespace resources are neither patched nor deleted. Never use force
finalizer removal or label-based bulk deletion to unblock cleanup.

`Kubernetes` pins one HTTPS origin and namespace and checks SelfSubjectReview against
the explicit API service account before resource requests. Supply a scoped bearer
token and CA PEM; no kubeconfig credential executors are used. TLS hostname checking
is enabled, redirects disabled and environment proxies ignored. Each request has a
configurable deadline of at most 20 seconds; request and response bodies are capped
at 1 MiB. Credentials, URLs and response bodies are excluded from error strings.
The caller owns token provisioning/rotation and credential memory lifetime.

## Verification and remaining acceptance

With Rust 1.99.1:

```sh
cargo +1.99.1 fmt -p canaveral-kubevirt-execution -- --check
cargo +1.99.1 clippy -p canaveral-kubevirt-execution --all-targets -- -D warnings
cargo +1.99.1 test -p canaveral-kubevirt-execution
```

Tests include a disposable loopback Node/OpenSSL HTTPS API server exercising the
production HTTPS transport with lost PVC, Secret and VM create responses, restart/UID recovery, stop/cleanup,
TLS hostname and account mismatch, redirects, response limits and deadlines.
In-memory API fixtures distinguish name reuse, changed UIDs, pending intent with
no API effect, ambiguous deletes, retained unrelated resources, migration/support
ownership, orphan VMIs, journal lock exclusion and separate erasure evidence.
These tests contact no cluster. Node/OpenSSL are fixture-only dependencies.

Proposed native acceptance requires separately approved disposable capacity: verify
the immutable installed snapshot and CSI clone format (`disk.img` for filesystem
PVCs), reviewed admission/RBAC and launcher account policy, actual CPU/memory/disk
allocation, boot and guest access, then crash/partition past expiry with the actual
fence, delayed-create rejection, positive descendant stop, backend erasure and
fresh-lease isolation. Satellite integration, renewal, command/PTY/files and receipt
mapping remain outstanding. This source slice does not grant release acceptance.

Contracts: [resource ownership](../../docs/kubevirt-resource-ownership.md),
[Linux lease wire](../../docs/linux-lease-controller.md),
[KubeVirt volumes](https://kubevirt.io/user-guide/storage/disks_and_volumes/) and
[KubeVirt API](https://kubevirt.io/api-reference/main/definitions.html).
