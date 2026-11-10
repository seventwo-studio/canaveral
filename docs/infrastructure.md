# Infrastructure setup, health and resources

Accepted local implementation, 2026-11-02. A direct host provides VMs or
simulators on its own machine. An external orchestrator provides a bounded pool;
KubeVirt is the first adapter. Existing KubeVirt identities appear as
`kind: orchestrator` without re-enrollment, changed ownership or a second capacity
ledger. The central Canaveral controller is distinct from these connections.

## Connect a runner

Open **Hosts → Add host** or **Orchestrators → Add orchestrator**. Select the
host operating system and enabled runtimes (or external orchestrator provider),
name, controller origin reachable from that runner and its Canaveral
host limits. Configure storage and provider bindings using the form;
advanced configuration holds installed image definitions and other bindings.
Kubernetes context credentials remain in the runner's kubeconfig. An empty image
catalogue is allowed during onboarding; it cannot receive machine placements.

Create and download the private `canaveral-setup.json` file. It contains a
30-minute enrollment credential bound to the configured name, provider and
initial capacity. The controller persists its hash, not the secret, and returns
the secret once. Pending credentials can be revoked. If a creation response is lost, inspect
pending setups and revoke that credential before creating a replacement; retrying
the same intent never returns a second secret. Closing the dialog clears its
in-memory copy. No setup credential goes into browser local/session storage or
shell command arguments. Protect the downloaded file on disk and during transfer.

Install Canaveral and the selected backend on the target machine, then run:

```sh
canaveral host --setup-file ./canaveral-setup.json --state ./state/runner --check
canaveral host --setup-file ./canaveral-setup.json --state ./state/runner
```

The check command exits nonzero on failures; it does not enroll or create VMs.
It checks storage with a temporary write and probes installed runtime tools.
Provider validation may contact the backend or start the local adb server.
It does not install runtimes. Normal startup registers diagnostics even when a
prerequisite fails, so the dashboard can explain a connected but unusable runner.
Source image preparation failures before enrollment still require local repair.

The runner saves `host-config.json` and its private persistent identity in the
state directory. Preserve the identity across restarts; never clone/share its
state with another runner. For later starts, use the existing controller origin:

```sh
canaveral --url https://controller.example.com host \
  --config ./state/runner/host-config.json --state ./state/runner
```

One setup can enroll only one UUID/credential pair. Repeating that enrollment
with the same saved pair is safe after a lost response. Revoking a setup prevents
further enrollment with it; it does not revoke an already enrolled host or stop
its machines. Draining disables new placements and restarts while preserving
existing assignments. Remote enrollment requires HTTPS by default. Existing
operator-managed enrollment files remain compatible.

## Capabilities and environment checks

Runners check platform/architecture, writable storage, executable availability
and available versions, offered CPU/memory capacity against the local machine,
storage headroom, backend access and image bindings. Reports contain bounded,
structured checks with passed/warning/failed/skipped status and repair guidance.
Raw SDK stderr, environment variables, kubeconfig and credentials are not sent.
Provider adapters perform their existing ownership and runtime/image validation.

Libvirt checks separately report a configured Linux deadline library's static
ELF/architecture/function-export validation and the still-unverified native lease
behavior. Inspection never loads the library. Missing configuration warns;
configured invalid artifacts fail with fixed repair guidance and no private paths.
`libvirtLeaseArtifact` means the artifact inspection passed; it grants no consumer
lease eligibility or native execution guarantee. Native expiry, cleanup, restart
and isolation retain their separate acceptance gate.

Checks run independently of heartbeats every 60 seconds. **Run checks** queues an
immediate refresh through the outbound heartbeat. Results older than 120 seconds,
failed checks and checks still in progress block new placements and restarts.
Re-sending a cached report does not refresh its age. Failed checks suppress
running reconciliation effects; explicit stop intents may still reconcile.
Existing reservations and running guest disks are retained. Legacy runners that
do not report diagnostics remain compatible and display **Checks not reported**;
upgrade them for the health admission gate.

Configured capabilities distinguish VMs, simulators, desktop stream, files,
shells and native accessibility. These describe adapters and image configuration,
not live acceptance of every guest OS or a remote display broker. Runtime checks
and machine readiness qualify their availability. TV/Watch and unsupported
Windows/macOS guest access are not inferred from backend availability.

## Resource accounting

The dashboard separates host limits, reservations and observed usage:

- **Host limits:** controller-owned CPU, memory and logical disk limits on what
  Canaveral may allocate to this host or pool. Initial limits come from the
  enrollment capacity; administrators can edit them in the host overview. Each
  resource must fit both its saved limit and the current runner offer. Neither
  value automatically discovers allocatable cluster capacity.
- **Reservations:** the authoritative transactional allocation ledger. CPU and
  memory remain reserved until a stopped intent is confirmed stopped. Logical
  disks remain reserved after shutdown. Unknown/offline assignments keep their
  reservations. Machine allocation details explain each reservation.
  Explicit power-off intents additionally require a matching stopped receipt;
  an older stopped observation cannot release compute while that intent is open.
  Leased CPU, memory and disk remain reserved until matching storage and credential
  cleanup completes; a stopped lease report alone releases none of them.
- **Observed usage:** host-wide CPU busy percentage, total/available memory and
  total/free storage on the configured storage filesystem, collected with
  [psutil](https://psutil.io/). Other applications are included; the first CPU
  reading or denied/unsupported metrics are unavailable, not invented zeroes.

Samples are collected every five seconds and persisted at most once per ten
seconds, with six hours retained per reporting host. The resource endpoint returns
the latest 360 samples; the dashboard plots the latest 60 available CPU samples
against actual sample times. Usage older than 30 seconds or from an offline host
is explicitly stale. These values do not replace the reservation ledger or
establish per-VM CPU/RSS attribution, GPU metrics, alerts or billing.

Resource details include `categories`, a breakdown of the same reservation ledger:
virtual machines, simulators, stopped machine disks, registered images (deduplicated
by artifact), pending image imports/captures, and inference. Their CPU, memory and
disk totals equal `reserved`. Stopping and unknown machines keep compute charged;
only a confirmed stopped intent moves their disks into the stopped category.

Host overviews render these ledger categories as stacked CPU, memory and storage
bars with explicit unreserved/over-limit capacity and a complete legend. Their
machine list stays scoped to the selected host and keeps stopped allocations
visible alongside running machines. The resource API also returns `images`:
that host's public runtime-image bindings and registered artifact metadata,
merged by immutable identity/revision/architecture. `origin` distinguishes
runtime bindings from library artifacts, and `offered` distinguishes registered
storage from an image currently advertised for creation. No private host paths
or another host's artifacts are included.
The optional heartbeat `installedImages` inventory carries public immutable
definitions for all configured image revisions, including retained revisions
which the runner no longer offers. Reporting them does not make them schedulable.
Older runners fall back to their advertised bindings. The inventory is scoped
to Canaveral's configured/runtime catalogue, not an adoption of unrelated SDK
caches or arbitrary host files.

Observed samples optionally include `canaveral`. Legacy `runner-process-tree`
samples measure the runner and descendants. `runner-and-owned-processes` adds
verified assigned Apple VM, libvirt cgroup and version 2 Android emulator processes, including
those no longer parented by this runner after a restart. Matching assignment/storage fingerprints, native machine
and lease identity, configured executable, exact VM arguments, UID and process
birth time relative to the recorded boot are required. Status PID alone and
process-name matches cannot add an unrelated detached process. A fresh birth-time
lookup after measurement rejects PID reuse; identities present in both sources
are measured once. Observation never signals/adopts a process, opens runtime
locks or writes runtime receipts, and changes no capacity reservation.

[Android attribution](android-runtime-ownership.md) additionally pins the owned AVD,
console port, complete launch receipt and exact process birth time. It accepts the
configured SDK's matching launcher/QEMU layouts and verified descendants. It
contacts no device and never upgrades a legacy launch receipt during sampling.
Missing or inconsistent Android identity makes simulator metrics unknown.

[Libvirt attribution](libvirt-resource-ownership.md) uses exact assigned native
domain/disk metadata and a fixed read-only QMP query to anchor the VM's cgroup-v2
processes, including daemon-launched helpers outside the runner tree. Matching
kernel membership and process births are rechecked after counters, without
runtime locks, receipt writes or process adoption. Inaccessible/unsupported scope
or unproven helper exit keeps VM metrics unknown. Native Linux layout, helper
coverage and restart acceptance remain unverified.

Failed or inaccessible native identity checks make VM-category metrics unavailable,
not zero. A positively absent process adds no usage. This is partial observation:
other detached runtimes and system-managed simulators still need ownership
collectors. An assigned runtime without a collector makes its VM or simulator
category unavailable while its observed state is running or uncertain. A failed
simulator identity lookup affects the simulator category; it does not silently
produce zero usage. Positively stopped assignments add no expected runtime usage.
Separately launched controller/dashboard services can still be excluded. Process names classify
already-owned tree members; they never discover detached ownership. The new
scope requires a controller that accepts it; updated controllers also retain
legacy report compatibility. This addition has fixture evidence; real native attribution and coverage across
runtimes remain acceptance gates.

Measurements group runner/helpers, VM processes and simulator processes. CPU is
normalized to total host CPU capacity; first readings and denied metrics are
unavailable. Memory is summed process RSS, which can count shared pages more than
once. These are explicitly partial measurements, not a whole-Canaveral total.
Do not subtract them from host usage to label the remainder as other applications.
Physical per-category disk usage is not measured; disk category numbers remain
logical reservations.

### Observation scheduling and freshness

The resource stream has one background observer per running agent. It collects
immediately, then waits five seconds after each completed attempt. Heartbeats
only read the cached resource snapshot; resource filesystem, process and provider
lookups do not run in the heartbeat path. A blocked collection is not replaced by more observer
threads. Prerequisite/environment checks retain their separate worker.

An exception or invalid sample leaves the previous observation and its timestamp
unchanged. Before the first valid sample, resource data is omitted. Cached data
can be sent on repeated heartbeats, preserving its original `sampledAt` and any
nested measurement timestamps. The controller keeps its ten-second history
interval but does not create another point for an unchanged observation. This
also avoids a false freshness update after a lost heartbeat acknowledgement.
Repeated delivery lets a newer cached observation pass that history interval even
if its first delivery was throttled; delivery alone is not a new measurement.

Snapshot publication is atomic with respect to heartbeat reads. A newer collection
that completes during an HTTP request is retained for the next request. Invalid
collector data cannot poison subsequent heartbeat payloads; collector failures
log a fixed diagnostic without raw provider details.

Stopping an agent waits at most one second specifically for its resource observer,
after the other worker cleanup steps. The observer is a daemon and a collection
that returns after stop is discarded. This does not forcibly cancel filesystem or
OS calls, or prove that such calls finish within a deadline. It keeps those waits
outside controller contact and does not signal a guest process. Fixtures cover
blocked/error collectors, late results, cache replacement, malformed observations
and history retry/throttling; native scheduling and filesystem acceptance remain
separate gates.

### Partial startup and shutdown

Worker creation and startup share the host's cleanup path. Handles are tracked
before `Thread.start()` returns, so a failure or cancellation after bootstrap
does not lose the worker. On failure, the agent sets its stop and environment-wake
events, attempts actor/session cleanup and joins only workers with a published
thread identity. An unstarted worker is never joined. Environment and resource
observers each have a one-second join budget; other existing role budgets remain
unchanged. The agent lock is released when the run context unwinds.

An ordinary cleanup exception is logged with a fixed role label, and later
cleanup steps still run. A startup or heartbeat-loop exception keeps precedence.
If shutdown otherwise completes normally but a cleanup step raises, the caller
receives `host_shutdown_incomplete` with an unknown outcome and no automatic retry.
Startup cancellation retains its original exception. These bounded attempts do
not establish that an uninterruptible worker or every owned process has exited;
resource reclamation still requires its existing positive evidence.

The environment observer rechecks stop after clearing its refresh event and after
in-flight probes. A shutdown wake cannot be lost by a concurrent initial clear;
results returning after stop do not update health/cluster caches or start another
cluster probe. An already running OS/backend call is not forcibly cancelled.

Fixtures inject constructor/start failures at every worker boundary, including
optional inference, cancellation before/after bootstrap and cleanup errors. Two
real event-waiter threads verify stop/drain after a later startup failure, without
executing runtime/provider commands. Controlled event races also verify lost-wake
prevention and discarded late environment results. Native process cleanup and retained-device
lifecycle acceptance remain separate gates.

A physical host uses one identity and set of limits across its compatible
runtimes. Limits belong to the controller and cannot be changed by heartbeats
or repeated enrollment. Lowering a limit preserves existing reservations, reports
overcommit and blocks excess new placements or restarts. Offline assignments,
retained disks, inference, registered images and unresolved image tasks still
count toward host limits. These are allocation limits, not runtime CPU throttles
or hard ceilings on measured memory or storage usage.

Shared budgets, overlapping budget membership and their administrative endpoints
have been removed. Existing database rows are left inert; they no longer affect
admission. Existing hosts seed their limits once from their last advertised
capacity when the controller opens the database. Do not advertise the same
physical capacity under multiple identities: each host's limits are independent,
and there is no combined limit across hosts or overlapping pools.

Direct runners on the same physical machine report the same opaque resource
domain. Their observed usage must not be summed. The domain is a discovery hint,
not additional capacity or an automatic grouping rule. KubeVirt measurements have
`scope: runner`: they describe the worker machine/container, never cluster node
utilization. The KubeVirt runner additionally reads namespace pod CPU/memory from the metrics
API and namespace ResourceQuota hard/used values. These include all namespace
workloads and remain distinct from worker metrics and Canaveral reservations.
Missing metrics-server or read permissions report unavailable values, not zero.
The collector also reads namespace pod inventory. A namespace CPU/memory total
requires fresh measurements for every inventory-observed active pod and its
regular containers, plus running init sidecars and ephemeral containers. Finished
pods are excluded. Missing inventory permission, missing or duplicate pod/container
measurements, invalid quantities and stale timestamps withhold totals. Measurements
must end within 120 seconds of collection, at most five seconds in the future,
and after the pod's recorded creation time; previous same-name pod readings cannot
satisfy coverage. A measured empty namespace is zero only when both inventory and
metrics reads succeed. Reports expose coverage counts and the oldest underlying
measurement time, separately from collection time. Older reports without coverage
remain compatible and do not establish this check.

Inventory and metrics are separate API reads, not an atomic cluster snapshot.
Concurrent pod churn can change membership between them. These are namespace-wide
measurements, including workloads outside Canaveral; labels do not prove assignment
ownership or authorize changing reservations. The optional [assigned VM pod report](kubevirt-resource-ownership.md) now has
isolated creation-UID/owner-graph coverage; live cluster attribution remains
unverified. The Metrics API defines each reading's timestamp and averaging window;
see the [Kubernetes resource metrics pipeline](https://kubernetes.io/docs/tasks/debug/debug-cluster/resource-metrics-pipeline/).
Collection runs outside heartbeats with bounded command timeouts. Quota and
metric observations do not automatically rewrite saved host limits.
Cluster node/cgroup attribution and live cluster acceptance remain open. Do not enroll backing nodes as
additional capacity for an already offered overlapping cluster pool.

## API

The TypeScript migration now includes compatible per-host limits and reservation accounting.
Its SQLite fixtures cover limit edits, retained charges and concurrent
admission. It is not yet connected to the replacement controller scheduler or
HTTP worker, and does not replace running services or establish native cleanup.

Account sessions or the operator credential authorize these administrative paths:

| Method/path | Behavior |
| --- | --- |
| `POST /v1/connection-setups` | Issue a scoped enrollment credential once; accepts UUID `id`, `name`, `provider`, `capacity` |
| `GET /v1/connection-setups` | List the latest 100 setup states without secrets |
| `POST /v1/connection-setups/{id}/revoke` | Revoke enrollment credential; existing host identity survives |
| `POST /v1/hosts/{id}/checks` | Request an outbound environment check refresh |
| `GET /v1/hosts/{id}/resources` | Host capacity, limits, reservations, observed sample history and machine allocations |

`POST /v1/hosts/{id}/limits` saves `{limits: {cpu, memoryMiB, diskGiB}}` and
returns `{hostId, limits}`. Values are positive integers up to 1,048,576. A save
is atomic with placement admission and does not stop or resize existing machines.
The dashboard binds the response to the requested host and amounts and does not
automatically replay an uncertain save.

`GET /v1/hosts` adds `limits`, `kind`, `health`, `usage`, `available`, `overcommitted` and
`placementReady`. Image offers use health-qualified accepting state. Heartbeats
optionally carry bounded `health` and `resources` reports and receive
`checksRequestedAt`. Host identity may not switch provider after enrollment.
Scoped setup credentials authorize only `/v1/hosts/enroll`; they cannot read
inventory, issue setups or control guests. The dashboard proxies the administrative
paths with its existing session/CSRF checks. Its setup response also supplies the
configured controller URL as an editable starting point; that origin may need a
different externally reachable address for remote runners.


## Physical host runtime configuration

New direct hosts use `provider: macos`, `linux` or `windows`, plus a `runtimes`
object. macOS supports the existing Apple VM, Android and iOS adapters; Linux
supports libvirt and Android; Windows currently supports Hyper-V. Each runtime
has its local backend bindings and storage, while image definitions and the
capacity offer and saved limits belong to the parent host. Image OS selects its
matching runtime, or an explicit `runtime` image field selects an enabled compatible backend.

The local launcher consolidates historical local runtime identities while holding
all old agent locks. It retains the canonical credential, immutable image
definitions, machine UUIDs, runtime state directories, storage and operation
receipts; source identities are retired and cannot heartbeat. A private SQLite
backup precedes migration. This is locally fenced maintenance, not an API that
can reassign an unavailable remote host. The resulting configuration is
`state/local/machine-host.json`; old configuration files remain as evidence.

Kubernetes resource semantics follow the [ResourceQuota contract](https://kubernetes.io/docs/concepts/policy/resource-quotas/).
