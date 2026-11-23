# Dashboard API coverage

The dashboard has administrator workspaces in addition to the existing machine,
image, infrastructure and account screens. **System** is the operational inventory;
**Queue**, **Activity** and **Usage** show the waiting queue, the event log and
usage reports; **Configuration** exposes named administrative API actions and their
exact request configuration. Complex immutable definitions use an editable JSON configuration with
an example. The gateway forwards only explicitly permitted routes to its fixed
controller; it is not an arbitrary URL proxy.

## Ownership and intervention

A connection is an access session, subordinate to an environment lease. Closing a
session does not release its lease. Releasing a lease ends its authorization and
requests owned cleanup. Revoking an application ends its authority and subordinate
lease access. These actions do not establish that an offline host has stopped a
machine or reclaimed storage. Keep lifecycle, runtime observation and cleanup
separate, and inspect retained reservations until positive cleanup receipts arrive.

Administrator recovery uses `/v1/admin/system` and dedicated administrator mutation
routes. It never rotates or borrows an application or lease credential to inspect
activity or intervene. Existing consumer endpoints retain their original ownership
and credential requirements. Operational inventories omit secrets, hashes, command
arguments, operation output and provider reports. Configuration credential responses
are shown only for the immediate action and must be saved in the caller's secret
store; browser storage is not used.

## Feature map

| API feature | Dashboard surface |
| --- | --- |
| Account setup, invitations, sign-in, password, sessions | Sign-in, Account and Users |
| Personal API tokens and administrator token revocation | API tokens and API access |
| Hosts, setup, diagnostics and limits | Hosts |
| Templates, image registry/library, import/capture receipts | Image library and host overview |
| Immutable machine blueprints | Machine blueprints |
| Administrative machine creation, desired state, power off and deletion | Machines and machine details |
| Guest screen, files, shells and accessibility | Machine Control |
| Application identities and policies | System and Configuration |
| Application-owned legacy and Linux leases | System; administrator release, with the holder's label and time remaining. Queue lists the leases that hold capacity |
| Waiting requests, operation receipts and jobs | System; request/job cancellation and machine-operation receipt inspection |
| Waiting queue with position and reason (`/v1/admin/queue`) | Queue; administrator cancellation of a named request |
| Access and video sessions | System; administrator close |
| Model catalog, resource domains, grants and runner approvals | Configuration |
| Linux lease images, grants and runner approvals | Configuration |
| Runner enrollment and revocation | Configuration |
| Inference models and jobs | Configuration; Models (administrator prompt, output, cancellation) |
| Application model jobs and queued model calls | Models (application queue state, administrator cancellation) |
| Application artifact admission, chunks, verification and deletion | Configuration |
| Discrete machine operations, including uploaded app installation | Configuration and Machine Control |
| Uncertain uploaded-app install resolution (`/v1/operations/{id}/resolve`) | API and CLI only; not forwarded by the dashboard gateway |
| Mobile video admission, inspection and closure | Configuration; owner capture in machine details (PNG screenshot, verified MP4 recording) |
| Live views of account-owned mobile devices | Screens: up to four devices side by side, watch-only ([screen wall](dashboard.md#screen-wall)), over the [owner live screen](dashboard.md#owner-live-screen) relay. A live capture appears under System as a video session. Leased devices are never offered |
| Managed update releases and rollouts | Configuration |
| Event log (`/v1/admin/events`, `/v1/admin/events/kinds`) | Activity; filters, scroll-back and live updates by cursor |
| Live event stream (`/v1/admin/events/stream`) | API and CLI only; not forwarded by the dashboard gateway. Activity reads the list route by cursor instead |
| Usage reports (`/v1/admin/usage`) | Usage; JSON report and CSV download |
| Alert destinations, deliveries and diagnosis (`/v1/admin/alerts`, `/v1/admin/diagnosis`) | API and CLI only; not forwarded by the dashboard gateway |

## Credential-specific protocols

Consumer acquisition, renewal, scoped credential exchange, discrete execution and
transfer/session admission remain application/lease protocols. An administrator
page is not an application client: it cannot submit work as an application, renew
its authority, attach its data stream or inspect private command output by passing
an account cookie to those endpoints. System provides a separate recovery boundary
for visibility and intervention. Runner enrollment consumption, claims, heartbeat,
assignment reports, preparation callbacks, chunk download and binary WebSocket
framing remain machine protocols. Their effects are represented by inventory,
readiness, operations, session state, cleanup and host diagnostics.

Three gateway WebSockets relay a controller session protocol under the creator's
own credential: the owner's mobile video attachment,
`/api/v1/machines/{machine}/video-sessions/{id}/{generation}` (see
[owner mobile capture](dashboard.md#owner-mobile-capture)), the owner's live view,
`/api/v1/machines/{machine}/live-views/{id}/{generation}` (see
[owner live screen](dashboard.md#owner-live-screen)), and the desktop viewer,
`/api/v1/machines/{machine}/desktop`, on a dashboard without an attached local
display. All require the session cookie and a matching Origin, recheck machine
access before the upgrade and every second after it, and relay frames unchanged.
For the desktop, the gateway first opens an owner display session,
`POST /v1/machines/{machine}/display-sessions` with `{id}`, and closes it when
the viewer leaves; see [remote desktop relay](guest-access.md#remote-desktop-relay).

Frontend/controller fixture checks do not establish native stream disconnection,
provider cleanup, mobile capture, model execution or deployment acceptance. No
native experiment, enrollment, update rollout or deployment is performed by
building or testing these screens.

## Administrator recovery contract

| Method and path | Request | Effect |
| --- | --- | --- |
| `GET /v1/admin/system` | none | Redacted activity across application, lease, request, job, operation and session ledgers. Leases carry `name`, the caller's label, when one was given; `observedAt` is the controller's clock for the page |
| `GET /v1/admin/queue` | none | The waiting queue in attempt order with position and last refusal code, and the active leases that hold capacity; see [the administrator queue view](requests.md#administrator-queue-view) |
| `GET /v1/admin/configuration` | none | Configured models, domains, grants, approvals, runner bindings/enrollments and application artifact metadata |
| `POST /v1/admin/leases/{id}/release` | `{id: mutationUUID}` | Terminalize the lease using its owning backend's cleanup rules |
| `POST /v1/admin/sessions/{id}/close` | `{id: mutationUUID}` | Revoke a single access/video session without ending its lease. Closing a live capture ends every live view of its device; an administrator can end a leased device's capture this way but cannot watch it |
| `POST /v1/admin/applications/{id}/revoke` | `{id: mutationUUID}` | Revoke application authority and refresh subordinate lifecycle state |
| `GET /v1/admin/model-jobs` | none | Up to 100 application model jobs, open first (oldest first), then recently closed, with queue state and no prompts or results |
| `POST /v1/admin/requests/{id}/cancel` | `{id: mutationUUID}` | Cancel waiting intent, release its admitted lease or request its admitted model job's stop |
| `POST /v1/admin/jobs/{id}/cancel` | `{id: mutationUUID}` | Request model/inference cancellation without releasing claimed reservations early |

## Administrator observability routes

These routes use the same administrator authority and authenticate before any
lookup. Reads never change controller state. Each recovery receipt above is also
recorded as an `admin.intervention` event. The **Gateway** column says whether the
dashboard gateway forwards the route; the others are API and CLI only.

| Method and path | Request | Effect | Gateway |
| --- | --- | --- | --- |
| `GET /v1/admin/events` | `after`, `tail`, `since`, `kind`, `limit`, subject filters | The durable [event log](events.md), oldest first | Forwarded |
| `GET /v1/admin/events/kinds` | none | The event kind catalogue | Forwarded |
| `GET /v1/admin/events/stream` | `after` or `Last-Event-ID`, `kind`, subject filters | Live follow as server-sent events | No |
| `GET /v1/admin/usage` | `from`, `to`, `groupBy`, `format`, `application` | [Usage](usage.md) as JSON or CSV | Forwarded |
| `GET /v1/admin/alerts/destinations` | none | [Alert](alerts.md) destinations without their URL path or secret | No |
| `POST /v1/admin/alerts/destinations` | `{id, name, type, url, secret?, kinds?}` | Add a destination; idempotent by UUID | No |
| `POST /v1/admin/alerts/destinations/{id}/remove` | `{}` | Remove it, erase its URL and secret, cancel unsent deliveries | No |
| `POST /v1/admin/alerts/destinations/{id}/test` | `{id: requestUUID}` | One recorded test delivery, never retried | No |
| `GET /v1/admin/alerts/deliveries` | `destination`, `state`, `limit` | Recent alert deliveries and their outcomes | No |
| `GET /v1/admin/diagnosis` | none | Read-only findings for [`canaveral doctor`](doctor.md) | No |

### Queries through the gateway

The gateway refuses a query string on every route except two reads:
`GET /api/v1/admin/events` and `GET /api/v1/admin/usage`. For those it accepts only
the parameters in the table above, each at most once (`kind` up to 32 times, one
kind or family per parameter), and only values of the expected shape: a sequence
number, a count of up to three digits, a UTC instant such as
`2026-11-21T09:14:03.512Z`, a lowercase UUID, a kind such as `lease.*` or
`host.offline`, and the listed `groupBy` and `format` words. Anything else
returns 400 before the controller is asked. The gateway rebuilds the upstream query
from the pairs that passed; it never forwards the browser's string. None of these
shapes can hold a credential, and the controller also refuses credential-named
parameters. A query on a mutation, including the administrator cancel, is refused.

`GET /api/v1/admin/usage` with `format=csv` relays the controller's CSV as an
attachment named `canaveral-usage.csv`, bounded like every control message (8 MiB).
A refusal stays a JSON error.

`GET /api/v1/admin/queue` and `GET /api/v1/admin/events/kinds` take no query. The
gateway sends the caller's own session as the bearer credential, so the controller
decides administrator authority on every read: an ordinary account receives 403,
and a read after sign-out or revocation receives 401. Nothing is cached or stored
by the gateway or in browser storage.

These endpoints require existing administrator authority: an operator credential
or an active account with administrator scope. They authenticate before resource
lookup. Ordinary account, application, lease and runner credentials cannot use this
boundary. Personal tokens retain their owner's current role and explicit scopes.

Recovery receipts use a dedicated administrator namespace and bind the actor,
resource category, target, application scope and action. Request/job cancellation
accepts an optional `applicationId`; the UI supplies it for application-owned work
because request/job UUIDs can overlap across applications. An unscoped ambiguous
UUID conflicts instead of choosing an owner. Retrying the same mutation returns its
original receipt; inspect refreshed inventory for current state. A mutation UUID
reused for another action conflicts. The open confirmation retains its UUID across
an uncertain response. Closing the page loses that local retry context; inspect
inventory before beginning another intervention.

Operations already dispatched to a guest remain receipt-driven. System displays
their state but offers no invented cancellation mechanism. Use lease release to
end lease authority where appropriate, then inspect cleanup. An uncertain operation
must not be replayed under a fresh UUID on the assumption that disconnection
prevented its effect.


## Bounded inventory

System and configuration inventories return bounded pages. Page zero uses the base
endpoint; subsequent pages use `/v1/admin/system/pages/{page}` or
`/v1/admin/configuration/pages/{page}`. Page metadata exposes the current page and
whether another page exists. Each collection is independently ordered and bounded;
these are current pages rather than a transactional snapshot spanning navigation.
System refreshes the visible page every five seconds while the tab is visible.
A failed refresh retains the last good page with a stale notice. Inspect subsequent
pages explicitly to see additional records, ordered by identity.
