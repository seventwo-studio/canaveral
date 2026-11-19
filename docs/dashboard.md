# Optional web dashboard

## Images and machine blueprints

**Image library** (`#images`, with `#templates` retained as an alias) lists
downloaded base artifacts from `/v1/image-library`, including those whose host is
offline. Captured prepared artifacts do not appear as publisher originals. Each
entry shows its content hash and publisher-checksum or manual-import evidence.
Administrators open the base image registry or import a downloaded publisher file
from this page. Imports still require an eligible host and storage reservation.

**Machine blueprints** (`#blueprints`) lists immutable resource presets tied to
an exact source revision. Administrators create blueprints from library cards or
select existing prepared captures in **New blueprint**. **New revision** preserves
the previous version. Users with machine-write permission can create machines
from an offered blueprint, apply resource overrides and select placement; the
controller enforces minimums, host capacity and exact source identity.

The stopped-machine action **Capture snapshot** makes a prepared source for a
blueprint. It does not change the original library image. The existing host
template/recipe API remains an internal compatibility contract. See
[images](images.md) and [machine blueprints](templates.md) for immutable storage,
credential handling and native acceptance boundaries.

## Administration

Administrators have a visible Administration group in the sidebar. Open `#admin`
for current machine, user, API-token and infrastructure counts, machine/connection
attention states and links to the existing operational controls. Counts use the
current inventory and credential snapshots. Unavailable data stays unavailable;
these are not historical utilization or audit charts.

The machine workspace and administration overview share a **Fleet pulse**.
Its donut partitions the full inventory snapshot (before search and owner filters),
with exact counts and state labels. Selecting a state clears existing search and
owner filters and shows that group; **Running** in the chart means running but not
ready/preparing, while the inventory's **Running** filter includes all running
machines. **Needs attention** keeps the existing error/unknown/setup-failed rules.
Administrators see per-host CPU, memory and disk reservations against effective
limits, including reduced shared physical budgets, with exceptions first. The summary initially shows three connections on
wide screens. On narrow screens, **Show host reservations** expands a one-connection
summary so the machine list stays near the fleet status; **Show all** expands the
remaining connections. Missing
reservations stay unavailable, over-limit amounts remain visible, and retained
snapshots are labeled when refresh fails. These are reservations, not utilization.

Machine inventory uses aligned rows with a shared header on wide screens and
labeled fields on narrow screens. Ready machines with guest access lead with
**Control**; stopped machines lead with **Start**; other states lead with
**Details**. Ordinary lifecycle controls remain visible. **More actions** holds
capture and power-off controls with their existing eligibility and confirmations.
A pending power-off request exposes **Check power-off status**, including while the
host is offline; reopening retains its durable request identity.
Image revisions, update age and the unowned-machine explanation stay in details.
Menu-to-dialog transitions restore focus to the originating menu button.

The sidebar places **Overview** first for administrators. The overview leads with
attention states, then access counts and fleet charts. It never reports an all-clear
from unavailable inventory; stale snapshots retain their qualification. Library
and blueprint searches distinguish no matches from an empty collection, and
initial failures from retained stale results. Blueprint creation stays disabled
while its host-offer inventory is unavailable or stale. Retry and clear-search controls stay
next to the affected content; full image hashes and download evidence disclose
under **Source & checksum** while verification status stays visible.

`#admin/users` provides user search and status filters, machine ownership counts,
invitations, recovery and role/status controls. Disable, password reset and role
changes require a confirmation naming the account and consequences. Invitations
and recovery links last 24 hours and are delivered manually. Re-enabling an account
requires a fresh invitation and password; the controller protects the last active
administrator. The old `#users` route remains usable.

`#admin/tokens` lists personal API-token metadata across all users: owner,
permissions, prefix, expiry, last use and revocation. Revocation requires explicit
confirmation, checks the returned token/owner identity and refreshes the list.
Unknown replies trigger a status refresh without replaying the mutation. Revoked
records remain visible. Creating a token remains a personal account action; no
administrator receives another user's secret. The controller and gateway enforce
current administrator authority independently of navigation.

The machine inventory shows owner names and an owner filter to administrators.
`No user owner` means an explicit null owner; it does not establish whether the
machine was created by an operator or an application lease. Older responses that
omit ownership show `Owner unavailable`. Ownership is not reassigned here.
Infrastructure, images, budgets and guest controls keep their existing contracts.

Ordinary-user admin deep links return to the machine workspace without fetching
privileged collections. Administrative caches belong to the active identity;
late replies cannot restore a prior identity's data, and 401/403 responses clear
the affected collection. Transport failures retain a labeled last snapshot where
available. New admin endpoints require a matching controller and gateway version.

## TypeScript migration

The React dashboard uses TypeScript. The entrypoint, all shared UI primitives, sidebar,
login/power controls, artwork, mobile hook and shared API/operation helpers are
now TypeScript/TSX. `npm run typecheck` checks converted project code with strict
types, including unchecked-index checking. DOM/Radix props, variants, context,
events and state have explicit types; network data remains unknown until decoded
at converted receipt boundaries. Power-off acknowledgements must match the
request and machine before they are displayed.

Machine control, display, files, terminal sessions and the accessibility inspector
also use TypeScript. Their network boundaries validate display ownership and
action acknowledgements, terminal status, normalized accessibility hierarchies,
file listings and durable upload receipts. Malformed display messages fence input
and reject pending actions without replay. Clipboard permission waits cannot
retarget a replacement display connection. Headless machines expose files and
independent terminals without opening a graphics connection; iOS continues to
deny shell access. The workspace imposes no shell-count or total upload-size cap.

Image import/capture/activity, the base-image registry and host-limit controls
also use TypeScript. Image-task responses are bound to the original request ID;
import receipts must match the expected ID and byte count with a SHA-256 identity.
Host-limit receipts validate the selected host and requested CPU, memory and disk
amounts before confirming a save. Registry entries validate media, resource amounts
and HTTPS source links. Unknown task outcomes remain recovery states without
automatic mutation replay. Numeric form fields retain their empty editing state.

Host overview, resource categories, machine/image lists, environment checks and
connection setup now use TypeScript too. Resource responses must match the
selected host; malformed reports leave the last good report visible with an
error. Missing categories, installed-image inventory, reservations and quota usage
stay unavailable. Setup issuance and revocation acknowledgements must match the
original request before the UI offers a setup file or confirms revocation.
Advanced runner JSON retains its arbitrary configuration while checking object
and runtime-binding shapes before use.

App and its tests now also use TypeScript, including authentication, inventory,
navigation, creation, lifecycle controls and session-generation state. Inventory
responses are decoded before replacing the last good snapshot; malformed reports
produce a stale-data warning. Machine creation must acknowledge the original
request before the dialog closes. Explicit retries retain that request ID.
All dashboard source/test modules use TypeScript/TSX; `allowJs` is disabled and
the temporary `checkJs: false` transition has been removed. Browser fixture
specifications and tool configuration remain JavaScript outside the source
typecheck. Vendor declarations use `skipLibCheck` because the
existing Lucide declaration package references React's old `ReactSVG` type;
strict checks remain enabled for project TypeScript. No icon runtime upgrade is
included in this conversion.

Run `npm ci`, `npm run typecheck`, `npm test` and `npm run build` in `dashboard`.
The compiled web bundle remains checked in under `canaveral/web` for the current
gateway. Browser fixtures use temporary state and a private fixture server;
live-machine scenarios need their separate explicit authorization. Frontend fixtures do not establish gateway/provider interoperability or native
platform acceptance.

The dashboard is a separate, stateless service. The orchestrator, CLI and host agents work without it. It displays machines, preparation readiness, host capacity and available images. It can request machine creation, graceful start/stop and host drain/accept. Android devices have a control workspace with screenshots/input, file browsing and multiple persistent shells. iOS supports app-container browsing and discrete controls through a configured simulator host; screenshot tapping is currently Android-only because iOS point scaling is not yet negotiated. Configured local Linux desktops now have a live desktop connection, files, terminals and an accessibility inspector; see [guest access](guest-access.md). Per-platform guest control, cold capture and clone acceptance retain their separate runtime requirements. Running-memory snapshots are not implemented.

## Local create and control

From the checkout, with an already installed Android SDK and a compatible system
image:

```sh
node coordination/dist/src/cli.js local --android-sdk "$HOME/Library/Android/sdk"
```

Open [the local workspace](http://127.0.0.1:8876). Create the first administrator,
choose **Create machine**, select a **Base image**, and wait for Ready. **Control**
opens Screen, Files and Shells. The local command runs a separate loopback API on
8875 and stores credentials, accounts, host identity and device data under
`state/local/`, independently of other Canaveral installations. It downloads no
SDKs or images and adopts no existing devices. Its initial Android profile is
`pixel_8`; edit the generated private `state/local/host.json` for deliberate host
capacity/image choices before creating devices. Keep existing image revisions
while assignments use them. `--state`, `--api-port` and `--dashboard-port` allow
another isolated installation. Without `--android-sdk`, an existing private host
configuration is reused, or the controller/dashboard run without capacity.

Simulator screen refresh is explicit and follows input; Linux uses a live VNC display. Files
supports directory navigation and streamed uploads/downloads without per-file size caps.
Guest permissions apply. Uploading overwrites a same-name file. iOS requires an
installed app's bundle ID and paths relative to its data container.

Each shell is an independent PTY with working-directory/environment state.
Users and agents choose the number of sessions; there is no shell-count cap. Output retains the latest 64 KiB and uses
byte offsets to avoid consuming or replaying reads. Closing the workspace requests
closure of its shells. Host stop/disconnection, runner shutdown and ten minutes
without session activity close shells. Browser reload/sign-out may leave a shell
until its idle timeout; sessions cannot resume after runner restart. Device data
and guest processes outside the owned connection are not reset by closing a shell.
This first version carries interactions through durable operation receipts and
polling, rather than a streaming access broker. The local runner polls every
0.25 seconds; other hosts retain their five-second default.

Stop devices through the dashboard before stopping the local command if they
should stop running. Exiting the command closes its shell connections and retains
devices, disks and placement for restart. Rebuild the frontend to update local
assets; local mode reads rebuilt assets on subsequent page loads.

The registry, downloaded image library and machine blueprints are separate product
concepts. Immutable host template definitions remain their runtime compatibility
format. Imported and derived artifact provenance follows the image contract.

## System activity and API configuration

Administrators can open **System** for applications, leases, waiting requests, jobs,
operations and access sessions, and **Configuration** for named administrative API
actions. Closing an access session retains the lease; releasing a lease requests
cleanup. See the [API coverage and authority map](dashboard-api-coverage.md) for
credential boundaries and native acceptance limits.

## Frontend development

The dashboard uses React, Tailwind CSS v4 and checked-in shadcn/ui components
(Radix primitives) in `dashboard/`. The workspace uses warm paper surfaces, a graphite navigation rail and a restrained
launch-orange accent. Account entry screens use a deterministic Bayer-dithered
launch photograph rendered with four-tone grayscale and warm flame palettes. The original
Unsplash photo (`paris-bilal-X3o5blcQGXA-unsplash.jpg`, Paris Bilal / Unsplash)
is bundled unchanged as `dashboard/public/launch.jpg` under the Unsplash License;
see [third-party notices](../THIRD_PARTY_NOTICES.md). Canvas applies the palette
and pixel treatment once after image decode; it runs no animation loop. The
photograph remains visible as a fallback when canvas is unavailable. Fonts and
assets need no external network requests.
Native form labels, keyboard navigation, modal focus, responsive layouts and
reduced-motion preferences remain part of the interface contract.
Machine inventory must reflow rather than scroll horizontally or clip fields.
Use wrapping cards, break long names/identifiers and keep every action visible
within the available content width, including with the sidebar open.

The Hosts inventory keeps **Add host** in the top bar. Each host overview has
**Canaveral host limits** with editable CPU, memory and disk fields. Shared
budgets are no longer available.
Omit the repeated visible Hosts heading and description; retain a screen-reader
heading and let the top-bar actions wrap at narrow widths.

Keep visible copy limited to essential labels, fields, actions and operational
state. The launch photograph carries the theme; omit decorative slogans,
coordinates, section overlines, repeated headings and duplicate summary cards.
Retain validation, stale-data notices and consequential-action confirmations.
The [screen and navigation guide](dashboard-design.md) maps Browserbase references
to Canaveral workflows. Use a persistent resource rail, a compact breadcrumb header,
and contextual actions beside the resources they affect. Keep the lowercase wordmark,
rocket mark and real launch photograph. The font and icon licenses ship in `licenses.txt`.

Keep template and host cards directly in the grid, without a second bordered panel
around them. Do not add fabricated charts or telemetry.

Use shadcn compositions for the application structure as well as its controls.
Navigation uses SidebarProvider, Sidebar, its header/content/menu/footer parts,
SidebarInset and SidebarTrigger, including the mobile Sheet. Forms use FieldSet,
FieldGroup and Field with associated labels, descriptions and errors. Search uses
InputGroup; loading and missing inventory use Empty; cards use Header, Content and
Footer sections. Retain the registry's spacing, focus and responsive behavior.
Do not recreate those structures with custom wrappers and global CSS overrides.

Inventory state filters use a single-choice Toggle Group, with a native select on
narrow machine inventory screens. Native capacity meters show resource
reservations. Keep shared colors in CSS variables and give each status a text label.
After adding registry components, verify utility imports resolve to `@/lib/utils`.

With Node.js 24 installed:

```sh
cd dashboard
npm ci
npm test
npm run build
npx playwright install chromium --only-shell
npm run test:browser
```

Edit `dashboard/src/`, then rebuild. Vite emits the production assets into
`canaveral/web/`; commit source, lockfile and generated assets together. CI rebuilds
and checks that the assets match. The TypeScript gateway serves those bundled
static files at runtime on Node.js 24 or later. Browser tests use synthetic API
fixtures and the gateway content security policy; they do not test a deployed host
or guest boot.

Sessions use a persistent HttpOnly, SameSite=Strict cookie. Creation retries retain the same request ID while
the form is unchanged. Editing or reopening the form starts a new intent. Radix
uses inline style attributes for menu positioning and a fresh per-response nonce
for its generated modal/scroll stylesheets. Scripts remain restricted to
same-origin bundles by the gateway's content security policy.

## Run locally

Start the orchestrator with `canaveral serve` as described in [Running Canaveral](running.md), then start the optional dashboard:

```sh
node coordination/dist/src/cli.js dashboard
```

Open [the local dashboard](http://127.0.0.1:8766). If no administrator exists, the first-run screen lets you choose a username and a password of at least 12 characters. Later visits show the sign-in form. Existing accounts are never overwritten. Native first-run setup automatically uses `./secrets/admin.token` when present; a different operator file can be passed with `dashboard --bootstrap-token-file /private/path/admin.token`. This credential is never sent to the browser. The default upstream is `http://127.0.0.1:8765`. For a remote orchestrator:

```sh
node coordination/dist/src/cli.js --url https://canaveral.example.internal dashboard
```

The dashboard binds to loopback by default. The local first-admin form requires both a loopback peer and a loopback Host. For remote setup, an operator can issue a one-time setup link; the recipient chooses a separate Canaveral password in their own browser. Existing administrators invite additional users from **Account menu → Users**. See [accounts and personal API tokens](accounts-and-tokens.md) for the complete contract.

For remote access, put the dashboard behind your private HTTPS proxy, preserve the incoming Host header, proxy the entire origin without a path prefix, and bind only to the intended interface. The browser refuses credentials over non-loopback cleartext HTTP. Upstream HTTPS certificate checks remain enabled; `--allow-http` explicitly permits a trusted private upstream network, independently of browser transport.

An operator can also create the first account through the CLI. It prompts privately for a password, or accepts `--password-file` for an already protected local file. Running it again leaves the existing account unchanged:

```sh
node coordination/dist/src/cli.js --token-file ./secrets/admin.token admin create --username admin
```

To let the first administrator choose their password remotely instead:

```sh
node coordination/dist/src/cli.js --token-file ./secrets/admin.token admin setup-link \
  --dashboard-url https://canaveral.example.internal \
  --output-file ./secrets/first-admin.link
```

Open the private link file within 15 minutes. The operator credential remains on
the server. The link is single-use; generating a replacement invalidates the old
one. It grants first-admin setup only and stops working after setup completes.

## Docker and Kubernetes

The Compose dashboard profile is opt-in. After one-time credential initialization, run:

```sh
docker compose --profile dashboard up -d
```

Without that profile, Compose starts only the orchestrator. The dashboard publishes loopback port 8766 and reaches the orchestrator through the internal network. It mounts no credentials, state or host sockets. Bootstrap the first account through the controller CLI, then sign in to the dashboard with the account:

```sh
docker compose run --rm --no-deps -e NODE_EXTRA_CA_CERTS=/run/tls/ca.crt orchestrator \
  --url https://orchestrator:8765 \
  --token-file /run/credentials/admin.token admin create --username admin
```

For Kubernetes, build the optional image and select it in the separate deployment input:

```sh
docker build --target dashboard -t canaveral-dashboard:local .
kubectl apply -k deploy/kubernetes/dashboard
kubectl -n canaveral port-forward service/dashboard 8766:8766
```

The example assumes the existing `canaveral` namespace and `orchestrator` Service. Publish or load the image first, or replace it with your immutable image reference. The dashboard requires no PVC, Secret, Kubernetes API access or virtualization privileges. Account hashes and sessions live in the existing controller database. Create the first account using the controller's CLI and its mounted operator credential, or use the local setup flow with a deliberately configured bootstrap credential. Its health endpoint checks the dashboard process; login and inventory verify actual orchestrator access. Site-specific GitOps installation and private ingress remain separate deployment work.

## Authentication and state

The orchestrator stores a salted PBKDF2-HMAC-SHA-256 password hash with 600,000 iterations. The implementation uses Node's crypto APIs and preserves the stored hash representation. Initial setup requires operator proof and atomically creates the first administrator. Sign-in and public claim attempts have a persistent rate limit. Usernames are case-insensitive. Ordinary users access only their machines; admins manage all machines and user accounts. There is no public registration.

**Account** provides password change. **API tokens** creates and revokes personal
tokens with explicit permissions and expiry; save the secret when it is shown.
Tokens remain limited by their owner's current account permissions. **Users**
lets an admin create invitations, issue password-reset links, change roles and
disable accounts. Re-enabling returns an account to pending and requires a fresh
invitation and password. Password reset immediately blocks the previous password and
revokes existing sessions and tokens. The last active admin requires operator
recovery. Back up the database before upgrading; retained users, sessions and
non-lease ownership require an explicitly supported schema migration. New controller
modules do not authorize overwriting or silently adopting those records. Retain the operator credential for
recovery without deleting users or their machines.

Successful setup or sign-in creates a random 30-day session. Only a hash of the
token is persisted in SQLite. The gateway stores it in a host-only HttpOnly,
SameSite=Strict cookie with a 30-day lifetime and Secure outside loopback
localhost. The token is not returned to browser JavaScript or stored in
local/session storage. Reloads and browser restarts restore the account through
an authenticated session lookup; expiry and sign-out revoke access. Sign-out
clears the cookie and revokes the controller session. An unreachable controller
may delay revocation until expiry. Account/session state survives controller and
gateway restarts through the existing database. Cookie mutations require a
same-origin Origin header; cross-origin browser requests remain rejected.
The operator, personal API token and enrollment credentials remain separate;
account sessions and personal tokens cannot enroll hosts. The gateway rejects a
request that supplies both a bearer credential and a session cookie.

The dashboard forwards inventory, lifecycle, infrastructure setup/diagnostics and authentication endpoints to its fixed upstream, without forwarding browser Origin headers. The orchestrator continues rejecting direct browser origins. No public access or external identity provider is configured by starting the dashboard; use an existing trusted private access boundary.

Inventory refreshes every five seconds while the tab is visible. Connection failures keep the last inventory visible with a stale-data notice. Running and ready are separate states: required preparation must finish before a running guest is shown as ready. Host bars show the orchestrator's reservations against its host limits, not CPU or memory utilization. Disks stay reserved after shutdown; compute is released only after the host confirms a stopped state. Offline hosts retain their placement and reservation rules.

Creation pins the template revision and architecture, uses its resource defaults and lets the scheduler choose an eligible host or honor a selected host. Retries of an unchanged creation form reuse the request ID, so a lost response cannot create a second computer. Keep the form open for a retry after an uncertain result. Closing the form, reloading or editing the specification starts a new intent; inspect inventory before creating again. A lifecycle response records requested state; the machine remains pending or transitioning until its host reports the result. Draining prevents new placements and restarts while retaining existing machines.


Hosts and external orchestrators have separate inventories. **Add host** and
**Add orchestrator** create scoped private setup files, followed by runner
preflight and outbound connection. Cards show check status and compact CPU,
memory and storage reservation meters. A host name or **View resources** opens
its overview at `#hosts/{id}` or `#orchestrators/{id}`. Older `/resources` links
remain valid. CPU, memory and storage bars stack all reservation categories and
show unreserved capacity or over-limit amounts. The legend retains zero-value
categories. Machines are scoped to that host, with running machines first,
status, resource specifications and existing Details/Control actions.
The machine list offers **All machines** and **Running** filters; offline hosts
show unknown runtime state and disable the running filter. Installed
images combine configured runtime images and registered library artifacts;
registered artifacts not yet advertised for creation are labelled accordingly.
Measured usage, history and checks remain below the inventory sections.
Resource and image inventories show loading and failure states explicitly.
Failed refreshes retain the previous report with a stale notice; **Retry
resources** requests a fresh report without leaving the overview.
The page supports direct links and browser history. Details stack on narrow
screens; the inventory keeps its compact summary. See [infrastructure setup and
resource accounting](infrastructure.md) for enrollment scope, freshness, per-host
limits and the distinction between KubeVirt runner and cluster metrics.

## Owner workspace previews

Use a dashboard account session and the usual same-origin mutation headers.
POST `/api/v1/previews` with a client-generated lowercase UUID `id`, a
`mode` of `static` or `command`, and `files` containing objects with
`path` (a workspace-relative filename) and `data` (canonical base64).
Command mode also requires `argv` (foreground executable and arguments) and
`port` (guest loopback HTTP port). Static mode serves index.html at the root.
Replay the same ID and body after a lost response. GET the collection for
`{previews: Preview[]}`; GET or DELETE `/api/v1/previews/{id}` to inspect or
stop. All item and create responses contain the Preview object directly:
`{id, mode, state, expiresAt}`, with UTC ISO expiry and state one of
`provisioning`, `starting`, `ready`, `stopping`, `stopped`, `failed`.
Poll until ready or terminal. A separate private gateway handles opening the
preview. Lease and application credentials stay on the server.

Set `CANAVERAL_DASHBOARD_PREVIEW_CONFIG` to a server-local JSON file with
`applicationKeyFile`, `database` (a dedicated SQLite file for one dashboard
process), `templateId`, `templateRevision`, `arch`, `digest` (sha256: plus
64 lowercase hex digits), and `ttlSeconds` (30–1800, within application limits).
Grant that application command and file access to the pinned workspace image.
The dashboard requires an approved workspace with Node for static serving and
nested directory preparation. Command mode runs the supplied argv in /workspace
and requires its executable in the image. The POST body limit is 1 MiB and up
to 128 files. The controller's existing preview HTTP response limits apply.
Restart fences active previews and reconciles cancellation against their stored
request IDs. Cleanup remains stopping while the controller holds the reservation.

For Kubernetes, mount the application credential read-only and give the dashboard
UID a writable persistent volume for the SQLite directory. Run one dashboard
replica with the `Recreate` deployment strategy so two processes cannot reconcile
the same previews during a rollout. When private host routing is enabled, set
the HTTP `Host` header on both `/healthz` probes to the configured dashboard
hostname. Configure wildcard DNS, TLS and private ingress as described in the
[preview routing guide](private-preview-routing.md).

## Owner workspace builds

Use the same dashboard session, mutation headers, source file encoding and size
limits as previews. GET `/api/v1/builds/images` for `{images: [{id,
templateId,templateRevision,arch,digest}]}`. The preview configuration's pin
has ID `default`. Operators may add pins in its optional `buildImages` array
using those same five fields. Every selected pin must match the live catalogue.

POST `/api/v1/builds` with a lowercase UUID `id`, `imageId`, `files`, a
foreground `argv` array and one workspace-relative filename `artifact`.
Replay the same body and ID after a lost response. Changed intent returns 409.
GET the collection for `{builds: [...]}`. POST, GET and DELETE on the
appropriate collection or item return a build with `id`, `imageId`, `artifact`,
`expiresAt` and `state`. Poll `/api/v1/builds/{id}`. DELETE that item to
cancel. States are `provisioning`, `running`, `stopping`, `succeeded`,
`failed` and `stopped`. Item responses include `result` when a validated
command receipt is available, with stdoutBase64, stderrBase64, byte counts,
truncation and termination fields per the Linux command contract (256 KiB
combined capture). After success GET `/api/v1/builds/{id}/artifact` for the
verified bytes (maximum 1 MiB) as an attachment named for the declared basename.
Before success the owner receives 409. Other owners receive 404. The dashboard
publishes the bytes and their SHA-256 digest together after the transfer SDK
confirms the size and digest. Output and artifacts survive cleanup and
dashboard restart in the private SQLite database. Restart fences unfinished
execution and reconciles its original request without rerunning the command.

## Administrator model runs

Administrators open **Models** (`#models`) to run a prompt against an installed
model through the existing [embedded inference API](inference.md). The page has
no new gateway route or credential: it uses the administrator dashboard session
on the already allowed `/api/v1/models`, `/api/v1/jobs`, `/api/v1/jobs/{id}`
and `/api/v1/jobs/{id}/cancel` routes. Ordinary accounts do not see the page,
and the controller enforces administrator authority on every request.

The model choice lists each exact model ID and digest once, with the number of
online, accepting hosts offering it. Unavailable identities stay visible but
disabled. A submission always pins the selected digest and leaves placement to
the controller. It carries a client UUID, the prompt (64 KiB) and 1–4,096 output
tokens (default 600). After a lost response the dashboard shows **Retry same
request** and replays the identical body and UUID. A definite 400, 409, 413 or 422
rejection discards that UUID. A 401 or 403 signs the session out.

The page polls each new or unfinished job every two seconds. It shows the state,
runner detail, host and request identities, then the generated text and measured
input/output token counts after success. A terminal state alone is not shown as
release: polling continues until the runner confirms that the owned runtime has
stopped and cleanup is complete, then the page reports **Runtime stopped ·
capacity released**. **Cancel job** requests cancellation once; the reservation
stays held until that same positive stop. The job list omits result bodies.
**Show output** inspects one finished job on request.

Portable component and browser fixtures cover this flow. Native dashboard model
execution remains unaccepted; see the [acceptance record](../coordination/native-acceptance/dashboard-models.md).

## Owner mobile app uploads

Send JSON mutations with the dashboard session cookie and matching Origin.
The dashboard forwards the owner's credential to the controller, which checks
machine access on each artifact and operation request.

1. POST `/api/v1/machines/{machine}/app-artifacts` with a client-generated
   UUID `id`, `format` (`apk` for Android or `ios-app-tar` for iOS),
   byte count `bytes` and lowercase hex `sha256`.
2. POST `/api/v1/app-artifacts/{id}/chunks` with byte `offset` and base64
   `data`. Use the reservation's `chunkBytes` size except for the final chunk.
   GET `/api/v1/app-artifacts/{id}` for the acknowledged offset in `received`.
3. POST `{}` to `/api/v1/app-artifacts/{id}/complete`. The controller verifies
   the size and digest before returning `state: "ready"`.
4. POST `/api/v1/machines/{machine}/operations` with
   `{"id":"OPERATION_UUID","action":"install-uploaded","arguments":{"artifact":"ARTIFACT_UUID"}}`.
   Poll `/api/v1/operations/{OPERATION_UUID}` for the installation receipt.
   After a lost submission response, replay the same operation UUID and intent.

Another ordinary account receives 404 for the owner's artifact and operation
receipt. Native installation and recovery follow the [mobile control contract](mobile-control.md).
