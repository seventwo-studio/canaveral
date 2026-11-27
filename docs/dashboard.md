# Optional web dashboard

## Images and machine blueprints

**Image library** (`#images`, with `#templates` retained as an alias) lists
downloaded base artifacts from `/v1/image-library`, including those whose host is
offline. Captured prepared artifacts do not appear as publisher originals. Each
entry shows its content hash and publisher-checksum or manual-import evidence.
Administrators open the base image registry or import a downloaded publisher file
from this page. Imports still require an eligible host and storage reservation.

**Machine blueprints** (`#blueprints`) lists immutable resource presets tied to
an exact source revision. Administrators create blueprints from library entries or
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
Its segmented bar partitions the full inventory snapshot (before search and owner filters),
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

The dashboard is a separate, stateless service. The orchestrator, CLI and host agents work without it. It displays machines, preparation readiness, host capacity and available images. It can request machine creation, graceful start/stop, deletion of a stopped machine and host drain/accept. A deletion is reported only after the controller confirms the host's owned removal. Android devices have a control workspace with screenshots/input, file browsing and multiple persistent shells. iOS supports app-container browsing and discrete controls through a configured simulator host; screenshot tapping is currently Android-only because iOS point scaling is not yet negotiated. Configured local Linux desktops now have a live desktop connection, files, terminals and an accessibility inspector. **Launch desktop** on Machines starts one from a Linux or operator-supplied macOS desktop image; see [guest access](guest-access.md#launch-use-and-delete-a-desktop-from-the-dashboard). Per-platform guest control, cold capture and clone acceptance retain their separate runtime requirements. Running-memory snapshots are not implemented.

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
cleanup. A lease shows the label its holder gave it and, while it is provisioning
or ready, the time remaining until its deadline, counted against the controller's
clock when the inventory carries it. See the [API coverage and authority map](dashboard-api-coverage.md) for
credential boundaries and native acceptance limits.

## Queue, activity and usage

Administrators have three more destinations under Infrastructure. Each reads
through the gateway with the signed-in administrator session; the controller
decides administrator authority on every read. Ordinary accounts do not see the
entries, a deep link returns them to Machines without a request, and a 401 or 403
on any of these reads signs the session out. Nothing is kept in browser storage.
See the [gateway allowlist and query rules](dashboard-api-coverage.md#queries-through-the-gateway).

### Queue (`#queue`)

The page reads `GET /api/v1/admin/queue` every five seconds while the tab is
visible. See [the administrator queue view](requests.md#administrator-queue-view)
for the fields.

- **Waiting requests** are listed in the controller's attempt order. Each shows its
  position, the reason it waits in plain words with the stable refusal code beside
  it, the caller's label, kind, template or model, priority, how long it has
  waited and its deadline, then the application and request identifiers. A code
  the page has no words for is shown as the code. A request that has not been
  tried says so.
- The page states that position is an order of attempts, not a promise. Model calls
  and requests past their deadline have no position, and the row says why.
- **Leases holding capacity** lists provisioning and ready leases, soonest deadline
  first, with the holder, the label, the template and the time remaining. Time
  remaining is the lease deadline. It is not when capacity frees: a holder can
  renew, and an ended lease keeps its reservation until cleanup is proven. Release
  stays on System.
- Waiting time and time remaining are counted against `observedAt`, the
  controller's clock, and advance locally between reads.
- **Cancel request** opens a confirmation that names the request, its identifier and
  its application, and says what cancelling does, including that a request the
  controller admitted in the meantime has its lease released instead. It sends
  `POST /api/v1/admin/requests/{id}/cancel` with a new mutation UUID and the
  application ID. After a lost response the button becomes **Retry same
  cancellation** and reuses that UUID; the dialog cannot be dismissed into a second
  attempt while the outcome is unknown. A definite refusal ends the attempt.
- A list longer than the reply's bound says how many it shows of how many. A failed
  read keeps the last queue with a stale notice, disables cancelling and offers
  **Refresh queue**. A reply that is malformed or not in attempt order is not shown.
- Application, request and lease identifiers link to their events on Activity.

### Activity (`#activity`)

The page shows the [event log](events.md), newest first: time, sequence, kind, the
catalogue's sentence for that kind, the subjects it concerns and its payload
fields. Kinds the event module marks `attention` carry a **Needs attention** badge.
The kind catalogue comes from `GET /api/v1/admin/events/kinds`, so the page holds no
list of kinds of its own.

- **Filters:** family, kind, application, host and lease, and **Needs attention
  only**, which selects exactly the kinds the catalogue marks. An identifier filter
  applies once it is a complete UUID. Choosing an identifier in an event filters to
  it. `#activity/<subject>/<uuid>`, with subject `application`, `lease`,
  `request`, `host` or `machine`, opens the page filtered. A selection that
  matches no marked kind, or more than the 32 kinds one read may carry, is said so
  and is never sent as an unfiltered read.
- **Live updates** are cursor reads of the list route, not a relayed stream. The
  page opens with `tail=100`, then asks for `after=<cursor>` every three seconds
  while the tab is visible, using the cursor the controller returned, so no event
  is repeated or skipped. **Pause live updates** stops the reads; resuming continues
  from the same cursor. The gateway does not forward the server-sent stream: every
  gateway response is one bounded request that closes, a read by cursor carries the
  same guarantee, each read is authorized on its own and so ends with the session,
  and a stream would hold one of the controller's 32 follower slots per open tab
  for up to an hour, at the expense of CLI and application followers. The cost is
  latency of up to three seconds instead of one.
- **Scroll-back:** the list route reads forwards or returns the newest N, so **Load
  older events** works within that. It first reads a larger tail, up to the route's
  500, which finds sparse matches in one request. Beyond that it walks backwards in
  windows of 500 sequence numbers, each read holding every match in its window, up
  to eight windows a step. The page shows the sequence it has searched back to and
  says when no older event is retained. A tail that returns fewer events than asked
  for ends the search at once.
- The page keeps at most 2,000 events. Live updates drop the oldest beyond that;
  scrolling back stops there and asks for narrower filters.
- A cursor that retention has overtaken is reported as a gap, not hidden. A failed
  read keeps the events with a stale notice and **Refresh activity** reads again.
  An empty log and an empty filter result say what would appear.

### Usage (`#usage`)

The page reads [`GET /api/v1/admin/usage`](usage.md) for the last 24 hours, 7, 30 or
90 days, or a custom range of at most 400 days, grouped by application, template,
platform or host. A preset ends at the moment of the read. It reads when the
choices change and on **Refresh usage**; it does not poll, because each report scans
the request ledger for its range.

- A total and one row per group show requests by outcome, wait until admitted,
  leases by outcome, device time held with the group's share of the total, time to
  ready, hold time and failures. Percentiles are p50 and p95 with their sample
  count. No sample reads **No samples**.
- The page says beside the figures what they are: the controller's records, counted
  by submission and admission time; device time is held lease time, not CPU, memory
  or power measured on a host. It states when the lease ledger began, flags a range
  that starts before it, and shows lease figures as unavailable when the controller
  reports no ledger. Grouping by host reports leases only and says why.
- **Download CSV** fetches the controller's CSV for exactly the range and grouping on
  screen and saves it as `canaveral-usage-<group>-<from>_<to>.csv`. A refusal or a
  reply that is not CSV is shown in place and no file is offered.
- A reply for a different grouping than was asked is not shown. A failed read keeps
  the earlier report and says so.

### Limits

- Component tests, gateway tests against a real loopback controller and browser
  fixtures at 320 and 1440 pixels cover these pages. No host, emulator, simulator or
  lease run took part. Nothing here establishes native runtime acceptance.
- These three pages show no device screens. Live pictures are on the
  [screen wall](#screen-wall), for account-owned devices only.
- Alerts, diagnosis, host pressure, runtime management, iOS leases and warm pools
  have no dashboard page.
- Activity shows the administrator view only. Access sessions and model job state
  changes are not in the event log; see [event log limits](events.md#limits).

## Frontend development

The dashboard uses React, Tailwind CSS v4 and checked-in shadcn/ui components
(Radix primitives) in `dashboard/`. The workspace uses a white canvas, a light gray navigation rail and a compact orange brand mark. The [dashboard design guide](dashboard-design.md) defines the component treatments. Account entry screens use a deterministic Bayer-dithered
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

Use full-width catalogue rows on wide screens and cards on smaller screens. Host cards sit directly in the grid. Do not add fabricated charts or telemetry.

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
Before an error reply, the gateway reads and discards an unread body of up to
1 MiB, waiting at most five seconds, without forwarding it. This lets clients
receive the HTTP error instead of a connection reset. Larger, chunked or stalled
bodies, and streaming uploads already handed to a connector, still close the
connection immediately.
The operator, personal API token and enrollment credentials remain separate;
account sessions and personal tokens cannot enroll hosts. The gateway rejects a
request that supplies both a bearer credential and a session cookie.

The dashboard forwards inventory, lifecycle, infrastructure setup/diagnostics and authentication endpoints to its fixed upstream, without forwarding browser Origin headers. The orchestrator continues rejecting direct browser origins. No public access or external identity provider is configured by starting the dashboard; use an existing trusted private access boundary.

Inventory refreshes every five seconds while the tab is visible. Connection failures keep the last inventory visible with a stale-data notice. Running and ready are separate states: required preparation must finish before a running guest is shown as ready. Host bars show the orchestrator's reservations against its host limits, not CPU or memory utilization. Disks stay reserved after shutdown; compute is released only after the host confirms a stopped state. Offline hosts retain their placement and reservation rules.

Creation pins the template revision and architecture, uses its resource defaults and lets the scheduler choose an eligible host or honor a selected host. Retries of an unchanged creation form reuse the request ID, so a lost response cannot create a second computer. Keep the form open for a retry after an uncertain result. Closing the form, reloading or editing the specification starts a new intent; inspect inventory before creating again. A lifecycle response records requested state; the machine remains pending or transitioning until its host reports the result. Draining prevents new placements and restarts while retaining existing machines.


**Add host** creates a scoped private setup file, followed by runner
preflight and outbound connection. Cards show check status and compact CPU,
memory and storage reservation meters. A host name or **View resources** opens
its overview at `#hosts/{id}`. Older `/resources` links
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
limits and physical host metrics.

## Owner workspace previews

Use a dashboard account session and the usual same-origin mutation headers.
POST `/api/v1/previews` with a client-generated lowercase UUID `id`, a
`mode` of `static` or `command`, and `files` containing objects with
`path` (a workspace-relative filename) and `data` (canonical base64).
Command mode also requires `argv` (foreground executable and arguments) and
`port` (guest loopback HTTP port). Static mode serves index.html at the root.
Optional `priority` (integer from -1000000 to 1000000, default 0, at most the
dashboard's `maxPreviewPriority` and the application's `maxRequestPriority`) and
`deadline` (UTC RFC3339, in the future and at most 24 hours ahead) queue the
preview; see below. A priority above `maxPreviewPriority` returns 400. An owner
with `maxWaitingPreviewsPerOwner` previews and builds still waiting, counted
together, gets 429 `preview_waiting_limit` until one starts, ends or is
cancelled; a replay of an existing preview or build is not counted again.
Replay the same ID and body after a lost response; a changed body, including
priority or deadline, returns 409. GET the collection for
`{previews: Preview[]}`; GET or DELETE `/api/v1/previews/{id}` to inspect or
stop. All item and create responses contain the Preview object directly:
`{id, mode, state, expiresAt, request?}`, with UTC ISO expiry and state one of
`provisioning`, `starting`, `ready`, `stopping`, `stopped`, `failed`.
Poll until ready or terminal. A separate private gateway handles opening the
preview. Lease and application credentials stay on the server.

Each preview is a [queued `linux-lease` request](requests.md#queued-previews)
for the configured pin. When capacity or the application's box limit is full,
the preview waits in `provisioning` instead of failing. `request` appears once
the controller has answered and is `{state, priority, deadline, reason,
admittedAt}`: `waiting` while queued (with the reason of the last admission
attempt), then `admitted`, `cancelled`, `expired` or `rejected`. It never
contains files or the command. While waiting, `expiresAt` is the waiting
deadline (default: creation plus `ttlSeconds`, as before). At admission it moves
to the lease expiry, so `ttlSeconds` of preview lifetime starts at admission.
DELETE cancels a waiting preview, which ends `stopped` with request reason
`consumer_cancelled`. One that reaches its deadline or is rejected ends `failed`.
If the controller rejects the dashboard's application credential, for example
after revocation (which cancels waiting requests), a preview that was never seen
admitted ends `failed`. A lost submission reply or a controller outage before
admission is retried by replaying the same request on the next tick; the preview
neither fails nor creates a second request. The controller's waiting cap
(`request_waiting_limit`) and other definitive submission refusals (4xx) still
fail the preview, at once: unless an earlier attempt's outcome was unknown, the
controller holds no request that a later reply could reveal, so stopping does not
wait out the deadline. After an unknown outcome the preview stays `stopping` until
its waiting deadline before trusting a missing request. A submission the dashboard
had sent but not seen answered when it stopped is an unknown outcome too: startup
marks it so, and a refused replay after the restart waits out the deadline. The submitted intent
includes the configured pin and `ttlSeconds`, so changing either while previews
wait makes their replay after a dashboard restart return 409, which fails them.
All of one dashboard's previews share its application, so the controller's
per-application fairness and waiting cap apply to the dashboard as a whole. The
dashboard bounds each owner's share with `maxWaitingPreviewsPerOwner` and
`maxPreviewPriority`; owners are not otherwise scheduled against each other.
The Workspace previews page shows a waiting preview's priority, last admission
reason and waiting deadline, and offers **Cancel waiting preview**.

Set `CANAVERAL_DASHBOARD_PREVIEW_CONFIG` to a server-local JSON file with
`applicationKeyFile`, `database` (a dedicated SQLite file for one dashboard
process), `templateId`, `templateRevision`, `arch`, `digest` (sha256: plus
64 lowercase hex digits), and `ttlSeconds` (30–1800, within application limits).
Optional `maxPreviewPriority` (0–1000000, default 0) is the highest priority an
owner may set; the default lets owners only lower their own previews. Optional
`maxWaitingPreviewsPerOwner` (1–1000, default 10) bounds each owner's waiting
previews and builds together, so one owner cannot fill the application's waiting
cap (default 100): builds wait as `linux-lease` requests on the same cap.
Grant that application command and file access to the pinned workspace image.
The dashboard requires an approved workspace with Node for static serving and
nested directory preparation. Command mode runs the supplied argv in /workspace
and requires its executable in the image. The POST body limit is 1 MiB and up
to 128 files. The controller's existing preview HTTP response limits apply.
Restart fences previews that were seen admitted and reconciles cancellation
against their stored request IDs. A preview whose request was never seen admitted
holds no key, workspace or service: it keeps its stored files and resumes waiting
after restart. Cleanup remains stopping while the controller holds the reservation.
The database gains a `workspace_requests` table holding pending files until launch
or stop. The dashboard keeps the database file mode 0600, narrowing an existing
file at startup, and enables SQLite `secure_delete` so cleared files are
overwritten. `secure_delete` does not reach pages freed before it was set: only
interim builds of queued previews stored files without it, so on first start the
dashboard rebuilds (`VACUUM`) a database that already has `workspace_requests`,
once, and records that in `user_version`. The rebuild needs about twice the
database size in free disk space; if it fails, the dashboard logs it, keeps
running and retries at the next start. Only the database file is rewritten: the
temporary rollback journal is deleted, not overwritten. A dashboard from before queued previews ignores the table and fences
every provisioning preview at startup, cancelling its request; it cannot resume
one, and it never clears the files already stored there. After a downgrade, delete
the `workspace_requests` rows (or the database once no preview is active) to
remove them.

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
A build waits as a `linux-lease` request like a preview and counts toward the
owner's `maxWaitingPreviewsPerOwner` together with previews; over it, POST
returns 429 `preview_waiting_limit`.
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

## Host maintenance

Hosts in manual maintenance carry a Maintenance label. Open the host overview and select **Begin maintenance**. Enter an optional reason and confirm to close admission while existing work finishes. The legacy accepting switch controls placement independently.

The panel refreshes the scope, phase, admission owners, runner confirmation and blockers. Read each blocker’s affected actions and next step. The power-off verdict covers Canaveral-managed workloads on a direct host. **Resume admission** becomes available after reconciliation permits resume. If the controller refuses, inspect the returned blockers before retrying.

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

Below the administrator runs, **Application model queue** lists up to 100
application model jobs from `GET /api/v1/admin/model-jobs`: open work first, oldest
first so long-waiting jobs stay visible, then the most recently closed. It
shows each job's application, model, state and reservation, and for a
[queued model call](requests.md#queued-model-calls) its request state, waiting
reason, priority and deadline. Direct submissions show as priority 0. Prompts and
results are not listed. **Cancel waiting job** (or **Cancel job** once admitted)
sends `POST /api/v1/admin/jobs/{id}/cancel` with a new mutation UUID and the
application ID; after a lost response the button becomes **Retry same
cancellation** and reuses that UUID. Waiting jobs close without execution;
admitted jobs keep their reservation until the runner confirms stop and cleanup.
The list refreshes every five seconds while any job is unfinished and the tab is
visible.

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

## Owner mobile capture

The machine details of an owned, running iOS or Android device include
**Capture**. It uses existing routes only.

- **Screenshot:** submits the `screenshot` device operation and accepts only an
  `image/png` result with a valid PNG signature and header. The operator names
  the file, previews it and downloads it.
- **Recording:** POST `/api/v1/machines/{machine}/video-sessions` with
  `{id, fps:30, durationSeconds, bitRate:4000000}` for 5, 10, 15, 30, 60, 120
  or 180 seconds; 180 is the backend maximum, and its file fits the page's
  memory limit. The page then opens a WebSocket to
  `/api/v1/machines/{machine}/video-sessions/{id}/{generation}` with
  subprotocol `canaveral-session-v1`. Starting a recording returns 409
  `device_live_view_active` while a live capture holds the same device, including
  while its cleanup is unproven.

The gateway relays that WebSocket only for a same-origin request carrying the
session cookie and a matching Origin. A bearer header, missing or foreign Origin,
or another account is refused. The gateway checks machine access before the
upgrade and every second while attached. It opens the controller attachment with
that cookie's own session token as a bearer credential, the browser's WebSocket
key and no extensions, then copies frames unchanged. The token never reaches page
script or the upstream response. An ordinary GET to the attachment path stays 404.

The page shows a recording as successful only after the host's `finish`
message matches the received byte count and SHA-256, reports `cleaned:true`, and
the bytes pass the dashboard's MP4 structure check. That check requires `ftyp`,
one movie header with one H.264 video track, ordered fragments whose sample
tables cover exactly the following media data, a key frame first, and at least
one frame with a positive duration. Only then does the page acknowledge the
stream, show frames, duration and size, preview the file and offer a download.
A stream error, early close, stall, size or checksum mismatch, or failed
structure check is shown as a failure without a file. A stall is silence for the
requested length plus 30 seconds: Android sends nothing while the screen is
static, and a lost host closes the socket through the broker's liveness check. The page holds a recording
in memory, up to 128 MiB.

Cancelling, failing, closing the details or leaving the page closes the socket
and POSTs `{}` to `/api/v1/machines/{machine}/video-sessions/{id}/close`. Page
unload uses a keepalive request. After success the page waits for the session's
`finished` state, which follows the runner's positive cleanup report and releases
the reservation. A browser that cannot decode the verified file shows an error
beside the preview. The [native trial](../coordination/native-acceptance/dashboard-mobile-capture.md)
passed Android screenshots and recordings and iOS screenshots; iOS recording
failed at idb's stop and remains open. The [video lifecycle trial](../coordination/native-acceptance/dashboard-mobile-video-lifecycle.md)
then verified 60- and 180-second Android recordings with static stretches longer
than 30 seconds, and machine deletion refused until an uncleaned session was
abandoned by an administrator. Android Cancel and leaving the page now reach
positive cleanup without abandonment; see the [recording cleanup trial](../coordination/native-acceptance/dashboard-android-recording-cleanup.md).

## Owner live screen

The gateway relays a live view of an account-owned mobile device, so a dashboard
can show devices that run on another machine than the dashboard itself. The
[screen wall](#screen-wall) uses the routes and messages below; Machine Control
does not use them yet. The contract is
[live screen](mobile-control.md#live-screen). Fixture-covered only: Chromium has
decoded fixture segments through this relay (see the screen wall), no browser has
decoded a native device's stream, and no native run has measured its frame rate or
latency.

Send JSON mutations with the dashboard session cookie and matching Origin.

| Step | Request | Notes |
| --- | --- | --- |
| Open | POST `/api/v1/machines/{machine}/live-views` with `{id, ttlSeconds?}` | `id` is a client-generated UUID; 201, or 200 for a replay. `ttlSeconds` is 10–120, default 120 |
| Attach | WebSocket `/api/v1/machines/{machine}/live-views/{id}/{generation}`, subprotocol `canaveral-session-v1` | Within 30 seconds of opening |
| Inspect | GET `/api/v1/machines/{machine}/live-views/{id}` | `state` and, once ended, `endReason` |
| Close | POST `/api/v1/machines/{machine}/live-views/{id}/close` with `{}` | On leaving the page; use a keepalive request on unload |

Refusals a page should expect when opening: 404 for an unowned device or for
another account's device when the viewer lacks administrator access, 409 for a
leased or stopped device or a host without capacity for the capture, 409
`device_recording_active` while a recording holds the same device, including
while its cleanup is unproven, 409 `capture_cleanup_pending` (retryable) while
an earlier live capture of the device is still being cleaned up, 409
`capture_cleanup_unproven` (not retryable) once that
cleanup was not reported within a minute or was abandoned, 409
`capability_unsupported` for a device that is not mobile, and 429
(`live_view_limit`, or all four video sessions of the host held). A view that a
recording displaced from the host's capture slots ends with
`preempted_by_recording`; the page offers to open it again later.
A leased device is never shown here: its screen belongs to its lease holder.

The gateway relays the WebSocket exactly as it relays the
[recording attachment](#owner-mobile-capture): only for a same-origin request with
the session cookie and a matching Origin; a bearer header, a missing or foreign
Origin, or another account is refused. It checks machine access before the upgrade
and every second after it, opens the controller attachment with that cookie's own
session token and copies frames unchanged. An ordinary GET to the attachment path
stays 404.

Messages the page receives, in order:

1. `{"type":"ready","sessionId","generation","capability":"live"}` from the broker.
2. `{"type":"live","mediaType":"video/mp4","codec":"avc1","fps":30}`.
3. Segments. Each is one text message followed by binary messages (at most 64 KiB
   each) that total exactly its `bytes`:
   - `{"type":"init","epoch","bytes"}`: the initialization segment (`ftyp` and
     `moov`) of an epoch. The page reads the codec string from it. When a later
     epoch starts, the page appends its `init` to the `SourceBuffer` it already
     has. Chromium accepts that for fixture segments; no native stream has been
     tried.
   - `{"type":"segment","epoch","sequence","keyframe","bytes"}`: one media segment
     (`moof` and `mdat`). The first of an epoch, and the first after a gap in
     `sequence`, is a key frame segment.
4. Possibly `{"type":"end","reason"}` when the host ends the stream, or
   `{"type":"error","code","message","outcome":"unknown"}` when it cannot serve it
   (for example `capability_unsupported` on an iOS host that has not opted in).
   Otherwise the socket simply closes; read `endReason` with the inspect request.

The page sends one message only, `{"type":"renew"}`, and receives
`{"type":"renewal","renewed","authorizationDeadline"}`, possibly between the binary
messages of a segment. An unrenewed view ends after `ttlSeconds`. Renew after about
a third of it, and only while the screen is visible, so that a hidden tab lets its
capture stop. Any other message from the page ends the session.

Viewers of one device share one capture and one reservation (one CPU and 256 MiB
on its host); a device accepts four viewers. A page showing several devices holds
one capture per device and so at most four per host, together with any recordings.
While a recording of the device runs, its viewers are fed the recording's stream
as an epoch of its own. Input stays on the existing device operations (`tap`,
`swipe`, `text`, `key`, `rotate` through POST `/api/v1/machines/{machine}/operations`);
the live view carries none.

## Screen wall

**Screens** (`#screens`, under Workspace, for every account) shows up to four
running mobile devices side by side, live and watch-only. It is built on the
[owner live screen](#owner-live-screen) relay and adds no route of its own.

- **Which devices.** A device is offered while it is a running Android or iOS
  device that belongs to an account: its owner sees it, and an administrator sees
  every account's. A device without a user owner is not offered to anyone. A leased
  machine never has a user owner, so no leased device can appear, and the
  controller refuses a leased device on this route as well. A leased device's
  screen belongs to its lease holder.
- **Nothing is captured until asked.** Opening the page opens no view. **Watch**
  adds a device to the wall, up to four; `#screens/<uuid>+<uuid>` in the address
  names the devices, so a reload or a shared link shows the same ones. Nothing is
  kept in browser storage. The page states the cost: each watched device runs one
  capture on its host, one of that host's four video sessions, with one CPU and
  256 MiB reserved.
- **One view per tile.** A tile opens a view with a 60-second lifetime and renews
  it in-band every 20 seconds, only while its picture is on screen and the tab is
  visible. A tile that is scrolled away or a tab in the background stops renewing,
  so its view lapses and the capture stops within a minute. When the picture
  returns it renews at once, or opens a new view if the old one lapsed meanwhile.
  **Stop watching**, leaving the page and page unload (with a keepalive request)
  close the view.
- **Watch-only.** The picture has no controls and takes no input. **Open control**
  opens the device's Machine Control, where input goes through the durable device
  operations.
- **States.** A tile says *Connecting*, then *Connected* until the first frame
  (a still Android screen sends none until it changes), then *Live*. An ending is
  shown in words from its reason. Endings that are an ordinary state are shown as
  one and not as an error: *Not offered* for a host that does not serve live
  views (iOS is off unless the host opts in), *Full* when the device or host has
  all its viewers or video sessions, *Stopped*, and *Paused* for a view that
  lapsed off screen. Failures offer **Watch again** unless asking again cannot
  help. A 401 signs the session out.
- **Playback.** Segments are appended through Media Source Extensions in
  `sequence` mode, so a later epoch or a gap where the runner dropped a slow
  viewer's backlog continues on one timeline. The codec string comes from each
  initialization segment. The element stays within 1.5 seconds of the newest frame
  and keeps about ten seconds behind the playhead. A browser without Media Source
  Extensions or H.264 decoding says so in the tile and leaves the view.
- **One module.** The routes and messages are used by
  `dashboard/src/lib/live-view.ts` only, because the relay is still under review.

What has been verified: component and module tests with a stand-in socket, and a
browser test in which the production gateway relays a stand-in controller's stream
to Chromium at 320 and 1440 pixels. That stream is cut from an FFmpeg recording made
with the runner's encoder arguments. Chromium decoded it, reported the encoded
picture size, and accepted a second epoch's initialization segment on the same
source buffer. What has not: a native device's stream, its frame rate and latency,
rotation, a recording taking over and handing back, and any browser other than
Chromium. `ManagedMediaSource`, which iPhone Safari offers in place of
`MediaSource`, is selected when it is the only one present but has not been tried
on a device. Nothing here establishes native runtime acceptance.
