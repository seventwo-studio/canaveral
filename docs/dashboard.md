# Optional web dashboard

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

Image import/capture/activity, the base-image registry and shared-budget controls
also use TypeScript. Image-task responses are bound to the original request ID;
import receipts must match the expected ID and byte count with a SHA-256 identity.
Shared-budget receipts validate their ID, membership, reservations and overcommit
flag before confirming a save. Registry entries validate media, resource amounts
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
live-machine scenarios need their separate explicit authorization. Current
services and native-platform acceptance are not changed by this source migration.

The dashboard is a separate, stateless service. The orchestrator, CLI and host agents work without it. It displays machines, preparation readiness, host capacity and available images. It can request machine creation, graceful start/stop and host drain/accept. Android devices have a control workspace with screenshots/input, file browsing and multiple persistent shells. iOS supports app-container browsing and discrete controls through a configured simulator host; screenshot tapping is currently Android-only because iOS point scaling is not yet negotiated. Configured local Linux desktops now have a live desktop connection, files, terminals and an accessibility inspector; see [guest access](guest-access.md). Other VM guest connections, general outbound display brokering, image import/build, deletion, snapshots and live resource telemetry remain unimplemented.

## Local create and control

From the checkout, with an already installed Android SDK and a compatible system
image:

```sh
python3 -m canaveral local --android-sdk "$HOME/Library/Android/sdk"
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

Images are the product concept. The current API still stores immutable template
definitions internally for compatibility; this does not yet provide image lineage,
import or derived-image creation. That migration is tracked in
the image contract.

## Frontend development

The dashboard uses React, Tailwind CSS v4 and checked-in shadcn/ui components
(Radix primitives) in `dashboard/`. Its custom launch theme uses neutral black and charcoal
surfaces, off-white text, launch-orange controls and a deterministic Bayer-dithered
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

The Hosts inventory keeps **Add host** and **Shared budgets** in the top bar.
Omit the repeated visible Hosts heading and description; retain a screen-reader
heading and let the top-bar actions wrap at narrow widths.

Keep visible copy limited to essential labels, fields, actions and operational
state. The launch photograph carries the theme; omit decorative slogans,
coordinates, section overlines, repeated headings and duplicate summary cards.
Retain validation, stale-data notices and consequential-action confirmations.
The visual reference is [Simlock](https://incubator.callstack.com/simlock/):
near-black surfaces, vivid orange (#ff7a1a), thin rules and nearly square corners.
Use system sans-serif display headings with self-hosted Geist Mono for interface
labels and data. Primary actions use uppercase monospace labels. Keep the small
Lucide outline rocket on an orange background and the lowercase wordmark in foreground text without a background. The font and icon licenses ship in `licenses.txt`.

Use the shadcn dashboard-01 block as the application layout reference: an inset
workspace, compact breadcrumb header, page heading and action, inventory toolbar,
and table or card grid. The sidebar has an infrastructure group and an account
menu. Keep template and host cards directly in the grid, without a second
bordered panel around them. Do not add fabricated charts or telemetry.

Use shadcn compositions for the application structure as well as its controls.
Navigation uses SidebarProvider, Sidebar, its header/content/menu/footer parts,
SidebarInset and SidebarTrigger, including the mobile Sheet. Forms use FieldSet,
FieldGroup and Field with associated labels, descriptions and errors. Search uses
InputGroup; loading and missing inventory use Empty; cards use Header, Content and
Footer sections. Retain the registry's spacing, focus and responsive behavior.
Do not recreate those structures with custom wrappers and global CSS overrides.

Inventory filters are single-choice Toggle Group items, not tab panels. Keep
native capacity meters: they represent reserved resources rather than task
completion. Theme customization belongs in CSS variables; product-specific CSS
is limited to the launch artwork, domain status badges and native meter drawing.
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
and checks that the assets match. Python packages and Docker images continue
serving those bundled static files; Node.js is only a development dependency.
The browser tests use synthetic API fixtures with the real Python gateway and
its content security policy. They do not test a deployed host or guest boot.

Sessions use a persistent HttpOnly, SameSite=Strict cookie. Creation retries retain the same request ID while
the form is unchanged. Editing or reopening the form starts a new intent. Radix
uses inline style attributes for menu positioning and a fresh per-response nonce
for its generated modal/scroll stylesheets. Scripts remain restricted to
same-origin bundles by the gateway's content security policy.

## Run locally

Start the orchestrator with `canaveral serve` as described in [Running Canaveral](running.md), then start the optional dashboard:

```sh
python3 -m canaveral dashboard
```

Open [the local dashboard](http://127.0.0.1:8766). If no administrator exists, the first-run screen lets you choose a username and a password of at least 12 characters. Later visits show the sign-in form. Existing accounts are never overwritten. Native first-run setup automatically uses `./secrets/admin.token` when present; a different operator file can be passed with `dashboard --bootstrap-token-file /private/path/admin.token`. This credential is never sent to the browser. The default upstream is `http://127.0.0.1:8765`. For a remote orchestrator:

```sh
python3 -m canaveral --url https://canaveral.example.internal dashboard
```

The dashboard binds to loopback by default. Browser account creation additionally requires both a loopback peer and a loopback Host; use localhost or a local port-forward for the initial setup. Remote browsers can sign in after the first account exists. For remote access, put the dashboard behind your private HTTPS proxy, preserve the incoming Host header, proxy the entire origin without a path prefix, and bind only to the intended interface. The browser refuses credentials over non-loopback cleartext HTTP. Upstream HTTPS certificate checks remain enabled; `--allow-http` explicitly permits a trusted private upstream network, independently of browser transport.

An operator can also create the first account through the CLI. It prompts privately for a password, or accepts `--password-file` for an already protected local file. Running it again leaves the existing account unchanged:

```sh
python3 -m canaveral --token-file ./secrets/admin.token admin create --username admin
```

## Docker and Kubernetes

The Compose dashboard profile is opt-in. After one-time credential initialization, run:

```sh
docker compose --profile dashboard up -d
```

Without that profile, Compose starts only the orchestrator. The dashboard publishes loopback port 8766 and reaches the orchestrator through the internal network. It mounts no credentials, state or host sockets. Bootstrap the first account through the controller CLI, then sign in to the dashboard with the account:

```sh
docker compose run --rm --no-deps orchestrator \
  --url http://orchestrator:8765 --allow-http \
  --token-file /run/credentials/admin.token admin create --username admin
```

For Kubernetes, build the optional image and select it in the separate deployment input:

```sh
docker build --target dashboard -t canaveral-dashboard:local .
kubectl apply -f deploy/kubernetes/dashboard.json
kubectl -n canaveral port-forward service/dashboard 8766:8766
```

The example assumes the existing `canaveral` namespace and `orchestrator` Service. Publish or load the image first, or replace it with your immutable image reference. The dashboard requires no PVC, Secret, Kubernetes API access or virtualization privileges. Account hashes and sessions live in the existing controller database. Create the first account using the controller's CLI and its mounted operator credential, or use the local setup flow with a deliberately configured bootstrap credential. Its health endpoint checks the dashboard process; login and inventory verify actual orchestrator access. Site-specific GitOps installation and private ingress remain separate deployment work.

## Authentication and state

The orchestrator stores a salted PBKDF2-HMAC-SHA-256 password hash with 600,000 iterations, not the password. The implementation uses Python's standard library; [OWASP's password storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) documents this work factor. Initial setup requires the operator credential and atomically creates only the first administrator. Login is limited to ten attempts per minute across dashboard replicas, with the budget retained over restarts. Usernames are case-insensitive. There is no public registration, account replacement or password-reset endpoint in this initial account implementation; retain the database and operator credential for recovery.

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
The operator and enrollment credentials remain separate for CLI, bootstrap and
worker use; account sessions cannot enroll hosts.

The dashboard forwards inventory, lifecycle, infrastructure setup/diagnostics and authentication endpoints to its fixed upstream, without forwarding browser Origin headers. The orchestrator continues rejecting direct browser origins. No public access or external identity provider is configured by starting the dashboard; use an existing trusted private access boundary.

Inventory refreshes every five seconds while the tab is visible. Connection failures keep the last inventory visible with a stale-data notice. Running and ready are separate states: required preparation must finish before a running guest is shown as ready. Host bars show the orchestrator's reservations against its configured budget, not CPU or memory utilization. Disks stay reserved after shutdown; compute is released only after the host confirms a stopped state. Offline hosts retain their placement and reservation rules.

Creation pins the template revision and architecture, uses its resource defaults and lets the scheduler choose an eligible host or honor a selected host. Retries of an unchanged creation form reuse the request ID, so a lost response cannot create a second computer. Keep the form open for a retry after an uncertain result. Closing the form, reloading or editing the specification starts a new intent; inspect inventory before creating again. A lifecycle response records requested state; the machine remains pending or transitioning until its host reports the result. Draining prevents new placements and restarts while retaining existing machines.


Hosts and external orchestrators have separate inventories. **Add host** and
**Add orchestrator** create scoped private setup files, followed by runner
preflight and outbound connection. Cards show check status and compact CPU,
memory and storage reservation meters. A host name or **View resources** opens
its overview at `#hosts/{id}` or `#orchestrators/{id}`. Older `/resources` links
remain valid. CPU, memory and storage bars stack all reservation categories and
show unreserved capacity or over-budget amounts. The legend retains zero-value
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
resource accounting](infrastructure.md) for enrollment scope, freshness, shared
host budgets and the distinction between KubeVirt runner and cluster metrics.
