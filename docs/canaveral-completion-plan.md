# Canaveral development platform plan

The first milestone is to start each resource type from the Canaveral dashboard and verify that it works on a compatible node. GitHub, Ambiently and other connectors are deferred until the resource workflows have been verified and the next milestone is chosen.

The first dashboard acceptance target is the entire homelab. Its Mac Studio is the designated node for all macOS and iOS workloads in this milestone. The operator's infrastructure configuration supplies the node identity. Record which workload each compatible node actually runs during acceptance.

The dashboard asks for inputs specific to the resource being launched. For an iOS simulator, the operator selects a simulator runtime. For a computer, the operator selects a machine image. Whether operators can also constrain placement to a particular pool remains open.

This plan describes remaining delivery work. Passing fixtures, controller routes or a configurable adapter do not establish a usable native development environment.

## Platform scope agreed on 18 November 2026

Canaveral is a self-hosted compute platform. Operators can place the controller independently of the machines that execute work. Nodes connect back to the controller and advertise what they can run. The deployment target includes native machines, Docker and Kubernetes, with KubeVirt as a possible VM backend. A workload can require a particular OS, runtime or device.

| Workload | Intended use |
| --- | --- |
| Agent environments | Lease a microVM or a simpler execution environment suited to the task. |
| Browser sessions | Start a browser for an agent, open a preview or a forwarded development server, interact with the page, capture a screenshot and release the browser. See the [browser API and native acceptance limits](browser-api.md). |
| Website previews | Serve static output or keep a dynamic application running from a container, Node.js, Bun or another application runtime. |
| Full desktops | Give an agent interactive access to a Linux, Windows or macOS desktop. |
| CI builds | Run Linux and macOS builds and return artifacts. Windows build support is under consideration. |
| Model execution | Run text, audio, video and image models on compatible nodes. |
| Mobile devices | Lease Android emulators and iOS simulators to development agents, CI and unattended workflows, including marketing capture. See [mobile control](mobile-control.md). |

A pool specifies its resource capacity and its priority level for issuing leases. Priority applies only when creating a lease. Once issued, a lease keeps its allocation for its agreed lifetime unless released or cancelled through its own lifecycle. A higher-priority request waits if capacity is occupied. For example, an arriving release build cannot displace a simulator test. Pools on the same machine share its physical capacity budget. The current [request contract](requests.md) implements waiting-request priority for supported lease kinds. Platform-wide pool levels remain a delivery requirement.

## Agent workflow

An agent selects a pinned template/model and required capabilities, supplies a stable request UUID and bounded resource/time requirements, then waits for actual readiness. It receives access scoped to that lease or job, performs work through owned command/file/session transports, retrieves results and releases its reservation. Renewal is explicit. Lost replies reuse the original identity; reconnecting never blindly replays a command.

| Resource | Required working outcome |
| --- | --- |
| Linux workspace | Isolated repo/working directory, scoped command execution, file transfer, build/test output and artifacts |
| macOS workspace | Apple-backed isolated development environment, scoped command/files, native app build tools and retained artifact access |
| iOS simulator | Exact owned runtime/device identity on Apple hardware, app install/launch, logs, screenshots and bounded controls |
| Android emulator | Private AVD and pinned system image, owned serial/ports, app install/launch, logs and bounded controls |
| Model execution | Pinned installed model, bounded inference, scoped results and positive stop/cleanup before releasing capacity |
| Preview service | A dashboard-started static site or dynamic service reachable at a private preview URL |

A macOS workspace and an iOS simulator may be separately leased resources. The design must not assume nested virtualization or expose unrestricted host device access. Agent-provider credentials are supplied through an explicit secret boundary, never baked into shared images.

## Shared pool and scheduling

- Give each physical machine one authoritative capacity domain, even when it runs VMs, simulators and models through different adapters. Do not enroll the same hardware twice or count host and runner ledgers as separate physical capacity.
- Reserve CPU, RAM, disk and, where applicable, accelerator slots/memory before dispatch. GPU scheduling is not implemented by a CPU/RAM/disk placement score.
- Respect operator headroom, per-application resource/concurrency limits, exact image/model grants, current runner identity, host health and update drains.
- Rank already-approved fitting candidates using the largest reservation fraction after admission, then total fractions and stable identity. This balances CPU, RAM and disk pressure; it is not cross-tenant fair queueing.
- Complete fair waiting/admission behavior without allowing a busy agent to monopolize the pool or silently moving an existing lease. Queued requests must have a defined deadline, cancellation and idempotent recovery contract.
- Keep reservations until positive owned cleanup. Expiry revokes access and stops owned execution; an unavailable host or unknown stop cannot prove capacity is free.

The embedded host ledger shares VM/image/inference reservations. The Rust runner domain ledger shares Linux leases and model jobs. An explicit administrator [host-to-domain mapping](infrastructure.md#host-and-runner-physical-budget) combines both paths transactionally against one CPU/RAM/disk budget. Operators must bind the installed physical inventory correctly; unmapped entries retain independent accounting. Portable contention and restart tests cover the mapping, but do not establish native mixed-workload acceptance or accelerator isolation.

## Requests and waiting

Durable `lease` and `linux-lease` requests wait when capacity or application limits are full. Linux workspace boxes share bounded admission with direct acquisition. Application model calls joined the same request model on 19 November 2026 ([queued model calls](requests.md#queued-model-calls)): a runner claim admits them by request order and reserves on the mapped physical ledger in one transaction. This is portable fixture evidence only; no native model runtime has run it. Previews joined on 19 November 2026 as [queued previews](requests.md#queued-previews): a preview is a `linux-lease` box request with its supervised preview service attached after admission, so it waits, is admitted and reserves exactly like a box. Dashboard previews keep waiting across dashboard restart and show their queue state. On 2026-11-19 a dashboard preview on the ARM64 homelab waited for a full one-box domain, survived a dashboard restart, was admitted when the other workspace was cleaned up and served its page; a second waiting preview was cancelled without a lease ([record](../coordination/native-acceptance/dashboard-queued-previews.md)). Priority, fairness, deadline, lost-reply and revocation behaviour are portable evidence only. Lease admission now keeps one application turn per image pool and skips a refused group for the rest of a pass. Embedded administrator inference (`/v1/jobs`, which has no application identity) remains outside the queue, and dashboard owners sharing one dashboard application are not scheduled fairly against each other.

The target is one request model across consumers. Under that model, a request is a box, a preview or a model call. It carries a caller UUID, pinned template or model, resources, priority, deadline and optional source context. Requests beyond current capacity are accepted and wait instead of failing. Admission is fair per application, bounded by its limits, and a waiting request can be cancelled or expire at its deadline. Replaying the same UUID and specification returns the same request. Admission and reservation happen in one transaction against the single per-machine ledger, so the two existing ledgers must be bound first.

## GitHub and previews

**GitHub Actions runners: dropped, 2026-11-13.** Workflow jobs run on the existing enterprise homelab runners. Canaveral has no GitHub App and does not register runners.

Deferred option: the homelab runners are Linux containers on Kubernetes (amd64 and arm64, Ubuntu 22.04 runner image), so they cannot run jobs that need macOS on Apple hardware. Those are Xcode builds, Swift tests that use the Virtualization framework, iOS simulators and code signing. Today these jobs run on GitHub-hosted macOS runners. If that stops being enough, a Canaveral macOS workspace on Apple hardware could host a short-lived runner for them.

**Deferred GitHub preview lifecycle.** The PR automation design of 11 November 2026 applies to a future connector. Dashboard previews start independently of a pull request.

For dashboard previews, first verify that a leased workspace can start a
foreground HTTP service, report readiness on its declared loopback port and
reclaim the process on release or expiry. The existing
[command operation](linux-command-operations.md) finishes with a bounded
command receipt. That receipt alone cannot establish continuing service
readiness. End-to-end acceptance also requires a private preview URL that
serves both a static site's assets and a dynamic response generated inside the
workspace. Verify that releasing the lease closes access to that URL.

On 2026-11-18 the ARM64 homelab served a fresh HTTP response from a Node
process in a leased VM through the controller, satellite and virtio-vsock.
Credential rotation denied the old key, and releasing the lease returned
the reservation count to zero. See the [native trial record](../coordination/native-acceptance/pr60-native-preview.md).

The guest supports a [bounded HTTP exchange](guest-wire.md#bounded-preview-http-exchange)
for GET and HEAD requests to a ready service. Each response, including its
headers, must fit within 64 KiB and arrive within 500 ms. Larger assets and
streaming responses need additional transport support. On 2026-11-18 Chromium
launched static and dynamic previews through the dashboard on the ARM64 homelab.
The static site loaded its nested script and the dynamic service echoed a fresh
nonce. A second account was denied access. Release revoked the private origins
and returned reservations to zero. The trials used disposable TLS ingress and
DNS mappings. See the [dashboard acceptance record](../coordination/native-acceptance/README.md#dashboard-workspace-preview-trials).

- A preview is a request tied to one pull request. The controller routes a per-PR hostname to the declared port over the existing outbound host connection and posts the URL as a deployment. Previews are private-network only for now; public exposure needs separate authentication and fork rules.
- The controller polls the GitHub API for pull-request state, without webhooks. A new push updates the preview, and closing the pull request destroys it.
- The GitHub credential is chosen together with previews. It stays behind the explicit secret boundary and never enters images or request bodies.

## Deployment boundary

Canaveral stays independent of any particular installation. This repository ships the controller, hosts, generic deployment inputs and examples. Site-specific manifests, hostnames, capacity limits, images and credentials belong to the operator's own infrastructure repository.

## Delivery sequence

Start each workload through the dashboard, inspect its readiness, exercise it and release it. For desktops, connect and interact. For builds, retrieve an artifact. For static and dynamic previews, open the served site. Apply the following backend work to support those dashboard checks.

1. Verify the shared-pool substrate: the implemented host/domain mapping, CPU/RAM/disk placement and tenant quotas must cover the selected physical inventory. Linux/macOS multi-runtime model offers and native mixed-workload acceptance remain part of the supported platform boundary.
2. Add the request queue on that ledger: waiting, fair admission, priority, deadline, cancellation and idempotent recovery.
3. Make Linux workspace leases usable end to end, then macOS: acquire, verified readiness, repo/build operations, artifacts, renewal, expiry, controller/host loss and owned release. Native deadline and cleanup proof must precede enabling ordinary host lease execution.
4. Dropped, 2026-11-13: GitHub Actions jobs use the enterprise homelab runners (see GitHub and previews).
5. Apply the same ownership, accounting and expiry contract to iOS/Android simulator leases and scoped model work. Add explicit accelerator or unified-memory admission; do not treat simulator/model inventory as readiness.
6. Add preview services and an application-scoped model endpoint on the same queue.
7. Validate the supported paths on specifically authorized disposable targets, including deliberate over-requesting, recovery and concurrency under mixed workloads.
8. Ship the supported matrix and precise remaining gates. Keep the Docker controller externally updated and avoid interrupting active work during runtime updates.

## Current gates

Ordinary TypeScript hosts still reject consumer execution declarations. Mobile providers reject leased execution pending independent deadline/cleanup support. The Linux runner controller and generic host lease paths have different execution bindings and must not be enabled through a permissive configuration flag. The embedded inference API is an administrator API; scoped application model jobs are a separate path, not a general model-session lease.

Native Linux experimental evidence, 2026-11-12: readiness, public CONNECT,
pinned clone/HEAD verification, npm ci/test, hashed build-log download, binary
file round trips, replacement/conflict/disk-full cases, tenant and egress denials,
renewal, release, expiry and autonomous satellite-loss fencing passed on one
Apple-silicon Mac ([evidence](../coordination/native-acceptance/README.md#qualified-clone-full-rerun)).
Open gates: native route-change acceptance, router hairpin coverage requiring
operator deny CIDRs, data-only disconnect, power-loss durability, PTY, concurrent
guests, native reconciliation, production trust/signing and macOS
workspaces. These results do not enable the ordinary host lease path.

Explicit [held-work reconciliation](../crates/apple-satellite/README.md#explicit-held-work-reconciliation-st-588)
is implemented for the original valid runner binding and prospective launches
whose workers and subprocesses retain ownership. Portable fixtures cover its
exclusion, exact recovery and cleanup-report contract. Native helper retention,
VZ/XPC and handle closure, and interrupted-deletion durability remain unaccepted.
Legacy or revoked-binding recovery and ambiguous missing storage stay blocked.

The [native dashboard Linux build trial](../coordination/native-acceptance/dashboard-builds.md) verified a Node build on ARM64, owner-only artifact download after VM cleanup and dashboard restart, failed builds, and cancellation. macOS build acceptance remains open.

On 2026-11-19 the [native dashboard Linux desktop trial](../coordination/native-acceptance/dashboard-desktop.md) launched a desktop from a CI-built ARM64 image through the dashboard. It reached Ready in 35 s. A click and typed command through the viewer changed the guest. Stop and a controller-confirmed delete restored the host baseline. Windows and macOS desktops remain open. A standalone dashboard now relays the viewer through the controller to the machine's host; the [relay trial](../coordination/native-acceptance/dashboard-desktop-relay.md) ran the controller, host and dashboard as separate processes on 2026-11-19. Typed input landed at 51.5 events per second, against 12 through `canaveral local`, whose in-process viewer is unchanged. Logging out mid-session stopped input. Cross-network deployment of the relay remains open.

macOS desktops can now be launched from the dashboard on the same path. An unleased macOS desktop gets its own launch media, pinned TLS identity and guest helper credential. It reports Ready after the helper shows a frame, and it opens in the shared viewer. The image is operator-supplied ([macOS desktop image](macos-desktop-image.md)). Portable tests cover the controller, host, provider, runner pin and image check. The [native trial](../coordination/native-acceptance/dashboard-desktop-macos.md) has not run, because the designated Mac has no macOS restore image or prepared image. Native macOS desktop acceptance and a restart after stop remain open.

Owners can take a named PNG screenshot and record a verified MP4 of a running mobile device from the dashboard. The [native trial](../coordination/native-acceptance/dashboard-mobile-capture.md) passed screenshots on both platforms and recordings on Android on 2026-11-19. iOS recording fails at idb's stop on the designated Mac. The runner now proves cleanup of a cancelled Android recording, so Cancel and leaving the page release the session without administrator abandonment; the [recording cleanup trial](../coordination/native-acceptance/dashboard-android-recording-cleanup.md) confirmed this natively on 2026-11-19. Abandonment remains for cleanup that cannot be proven, such as an unreachable device. The [video lifecycle trial](../coordination/native-acceptance/dashboard-mobile-video-lifecycle.md) verified Android recordings up to the 180-second maximum on 2026-11-19.

Administrators can run an installed model from the dashboard's **Models** page over the existing embedded inference API, see its output and observe cancellation and capacity release. Portable fixtures cover the flow; the [native trial](../coordination/native-acceptance/dashboard-models.md) could not run on 2026-11-19 because the designated Mac has no operator-installed model runtime.

Existing portable tests cover many authority, reservation, command/session and recovery cases. They do not establish native simulator leasing, real model fit/cancellation, signing admission or GPU isolation. Preserve these distinctions in code and documentation.

## Acceptance before completion

- Linux and macOS: acquire a workspace, clone a test repository, run its build/tests, retrieve artifacts and release; a second tenant cannot access it.
- Mobile: acquire each supported simulator/emulator, install/launch a fixture app, retrieve logs/screenshots, exercise scoped input and positively reclaim the exact instance.
- Models: run a pinned real model while development/simulator work exists, preserve headroom and prove cancellation/cleanup before reservation release.
- Scheduling: concurrent requests cannot overspend the same physical budget; constrained and busy hosts are avoided; quotas, draining and fair waiting have observable outcomes. Over-requesting queues work and every waiting request is admitted, cancelled or expired.
- Previews: start static and dynamic previews from the dashboard, open each private URL, then stop the preview and verify its route is removed.
- Recovery: expiry, disconnected clients, worker/controller restart and lost receipts do not resurrect a lease, replay effects or release unknown resources.
- Run relevant portable checks for every change. Native experiments, signing, service installation and deployment require concrete operator authorization under `AGENTS.md`.

Keep implementation in TypeScript/Rust, preserve scoped credentials and recovery records, and keep the repository free of Python code. Consolidate changes on one integration branch, with focused verification and independent review before release.
