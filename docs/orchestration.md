# Orchestration contract

The authoritative service is TypeScript on Node.js 24 or later. CLI commands use
`coordination/src/cli.ts` (compiled to `coordination/dist/src/cli.js`); HTTP
controller modules live in `coordination/src/control`. Rust runners and native
Swift/C bridges execute only explicitly supported work. Missing adapters fail
closed; a generated backend definition is not evidence of native execution.

## Controller module boundary

Each module exports `createModule(store: SqliteStore, options: ControlOptions):
ControlModule` using `coordination/src/control/contracts.ts`. Its `handle(req)`
returns `{body, status?}` for an owned route and `undefined` otherwise. The request
contains method, path parts, query, body, token and a current `principal()` resolver.
Modules use `requireScope`, `requireAdmin` and `owns` for current account authority
and ownership; storing a role in an old token is not sufficient authorization.

`coordination/src/sqlite.ts` provides synchronous `BEGIN IMMEDIATE` transactions
through `node:sqlite`; asynchronous work must not escape a transaction callback.
Credential revalidation, owner checks, idempotent intent comparison and durable
receipt updates belong at the protected effect boundary. Another owner's UUID
must be hidden before comparing its request. New module tables do not imply a
migration of retained accounts, sessions or machines. Back up selected state and
verify schema compatibility before cutover; do not share writable state with an
older controller.

## Placement and reconciliation

Canaveral stores machine placements and capacity reservations. Direct hosts and KubeVirt pools advertise capacity through the host API. Do not double-count pools and their underlying nodes. Embedded inference shares the capacity ledger; see [inference](inference.md) for its limits.

Native Android/iOS hosts offer [mobile device templates and control](devices.md)
through the same machine scheduler. These provision independent SDK device
instances; commands and durable results travel through host heartbeats.

The central service owns machine intent, host enrollment, placement and resource reservations. A host agent owns local hypervisor operations. Hosts connect outbound to the service; the controller does not need inbound access to each host. A KubeVirt agent offers a bounded cluster pool and translates assignments to Kubernetes VMs; Kubernetes then schedules the VM pods onto suitable nodes.

## Identity and admission

The owner initializes separate administrator and enrollment tokens. Enrollment credentials can add hosts but cannot list or control machines. Each agent generates and saves its own UUID and credential before enrolling. Enrollment is idempotent for that pair; another credential cannot replace an existing host. Subsequent heartbeats use the per-host credential. Keep the private agent state directory across restarts and never share or clone it between agents.

Hosts advertise configured capacity and a catalogue of configured templates. The controller separately stores per-host CPU, memory and disk limits, initially set from enrollment capacity and editable through the host overview. Admission uses the smaller of the offered capacity and saved limit for each resource. These values control allocation, not an automatic measurement or hard ceiling on physical resource use. Template ID, revision and architecture identify an immutable contract; the controller rejects conflicting definitions. Retain older revisions on hosts while their VMs exist. Remote creation requests choose catalogue entries; the owner configures recipes, source URLs and image bindings separately through template files. Backend configuration and actual image paths remain local to the agent.

Creation uses a caller-provided UUID as an idempotency key. The controller atomically chooses a fresh, accepting host with the matching template and architecture and enough reserved capacity. Placement minimizes the highest CPU, memory or disk reservation fraction after adding the request, using the smaller of physical capacity and configured limits. Total reservation fractions and then stable host IDs break ties. This ranks reservations rather than measured live utilization; it does not establish fair queueing between applications. Minimum resources and memory granularity come from the template. Explicit host pinning is supported. The same UUID and specification returns the existing placement; a different specification with that UUID is rejected.

Compute remains reserved until the requested state is stopped and the host confirms it is stopped. Disks stay reserved while the computer exists. A shutdown request alone does not release resources. Restart checks the original host's current availability and remaining capacity. Draining a host prevents new placement/restarts while continuing to deliver existing assignments; it does not evict VMs.

## Reconciliation and failures

An agent polls every five seconds. A separate reconciliation thread operates its local backend so long provisioning does not suppress heartbeats. The controller treats an offer as stale after 30 seconds. Agents stop beginning reconciliation when they have not contacted the controller for 20 seconds; already running VMs continue. This is a single-controller service with durable SQLite state and transactional admission; run one orchestrator replica against local persistent storage, not multiple replicas against a network filesystem.

On macOS and Linux, the runner's contact timeout includes host sleep. It measures
age from dispatch of the last successful heartbeat, including network latency and
local response processing. A stale contact cannot start new machine, device, image
or inference work. Lease execution deadlines remain a separate bound; fresh
contact cannot revive an expired lease. Suspend behavior has clock-fixture
coverage; actual host-suspend acceptance remains open.

Placements are durable and remain pinned when a host disappears. Observed state becomes unknown and reservations remain held. Automatic reassignment or live migration would require positive fencing of the old runtime and coordinated storage; neither is implemented. Existing hosts can reconnect with their saved identity after controller or worker restarts.

Each adapter uses a deterministic VM name derived from the assignment UUID and checks ownership before controlling an existing resource. Local disks have owner records and are not overwritten. Partial disk creation, uncertain Apple runner launches and unsupported states surface an error/unknown state for inspection rather than creating another computer. A native agent uses an exclusive state-directory lock. Kubernetes workers must retain their state PVC and remain a single instance per offered pool.

Templates can start from bootable base disks and prepare the guest after boot. Linux uses cloud-init NoCloud media, compatible Windows images use Cloudbase-Init ConfigDrive, and SSH preparation supports guests with configured remote access. KubeVirt clones offline base PVCs and references per-instance preparation Secrets. Native sources can be cached by verified SHA-256. macOS clones retain independent disk/platform files and run a preparation recipe over verified SSH. The [template contract](templates.md) documents sources, commands and readiness. A shared image build/import service, remote console proxying, deletion, snapshots and migration remain future work.

The machine response includes separate runtime state, preparation state and a `ready` flag. Prepared images without a recipe report `notRequired`; configured recipes remain pending/failed until a positive guest or SSH receipt is recorded. Guest callbacks use a per-machine credential registered by the assigned host, whose hash is stored in the controller. That credential cannot create computers, read inventory or prepare another machine. Successful receipts survive retries, stale pending heartbeats and controller restarts. Preparation completion confirms the configured recipe; add workload checks to the recipe when readiness depends on a service or login path.

Headless guests use serial or configured SSH access. Desktop guests expose the backend's console facilities or guest remote access: loopback-only VNC with libvirt, VMConnect with Hyper-V, `virtctl` with KubeVirt, and configured guest services or Canaveral guest helpers with the Apple runner. Running a desktop OS does not imply that Canaveral currently tunnels its display to the CLI client.

## HTTP API

All bodies and responses are JSON. Administrative paths require the admin bearer token. Host enrollment uses the enrollment bearer token; heartbeat uses the matching host token. Browser-origin requests are rejected and the CLI does not follow redirects with credentials. Remote clients require HTTPS unless explicitly configured for a trusted private HTTP network. Terminate TLS in front of the service for remote use; the embedded server listens on HTTP.

Administrator account sessions can also authorize inventory and lifecycle paths. Accounts, password hashes, session hashes and the login-attempt budget persist in the controller database. The optional dashboard does not own identity storage. The original operator credential still controls first-admin setup and the existing CLI; enrollment, host and guest-preparation roles remain separate.

| Method and path | Purpose |
| --- | --- |
| `GET /healthz` | Unauthenticated liveness |
| `GET /v1/auth/status` | Report whether first-admin setup is required |
| `POST /v1/auth/setup` | Atomically create the first admin; requires operator bearer credential |
| `POST /v1/auth/login` | Verify username/password and issue an expiring session |
| `POST /v1/auth/logout` | Revoke the presented session |
| `POST /v1/hosts/enroll` | Register UUID, credential and capacity/template offer |
| `POST /v1/hosts/{id}/heartbeat` | Update offer and owned machine reports; receive assignments |
| `GET /v1/hosts` | List offers, accepting state, freshness and reserved resources |
| `POST /v1/hosts/{id}/accepting` | Set `enabled` to true/false |
| `POST /v1/machines` | Reserve and place a computer |
| `GET /v1/machines` | List desired/observed state and placement |
| `GET /v1/templates` | List offered template contracts and defaults |
| `POST /v1/machines/{id}/prepared` | Receive a ready receipt using that machine's preparation credential |
| `POST /v1/machines/{id}/desired` | Request `running` or `stopped` |
| `POST /v1/machines/{id}/operations` | Queue a mobile device control action with a stable UUID |
| `GET /v1/operations/{id}` | Read a durable device action receipt and result |

Creation fields are `id`, `name`, `templateId`, optional resource overrides (`cpu`, `memoryMiB`, `diskGiB`), and optional `templateRevision`/`arch`/`hostId`. Defaults come from the selected template and are pinned on first creation. Choose a revision explicitly when multiple revisions can be placed. The returned machine includes its pinned template definition, host and desired/observed state. A heartbeat sends `offer` plus `reports`, a map from assignment UUID to `state`, optional `detail` and preparation receipt state. A host cannot report another host's assignment. The API never returns host or guest-preparation credential hashes.

Each host response includes `reserved` with `cpu`, `memoryMiB` and `diskGiB`, calculated from the same admission rules used by the scheduler. These are configured reservations, not live hypervisor utilization. The [optional dashboard](dashboard.md) uses a separate authenticated gateway; the orchestrator's direct browser-origin rejection remains in force.

Persist the controller database, credentials, host identities and template disks separately from disposable processes. Back up the SQLite database consistently with normal SQLite backup tooling. A fresh database is a new controller, not a discovery/import of arbitrary existing VMs. Do not point multiple controllers at the same host state or restore only the database while reusing conflicting identities.

## Backend sources

The adapters follow the [libvirt domain format](https://libvirt.org/formatdomain.html), [Hyper-V PowerShell interface](https://learn.microsoft.com/en-us/powershell/module/hyper-v/), [KubeVirt run strategies](https://kubevirt.io/user-guide/compute/run_strategies/) and [CDI volume-cloning contract](https://github.com/kubevirt/containerized-data-importer/blob/main/doc/datavolumes.md). The existing Apple runtime uses Apple's Virtualization framework. Actual images, firmware and installed hypervisor versions need acceptance on each target host.
