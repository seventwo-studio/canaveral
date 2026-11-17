# Dashboard API coverage

The dashboard has two administrator workspaces in addition to the existing machine,
image, infrastructure and account screens. **System** is the operational inventory;
**Configuration** exposes named administrative API actions and their exact request
configuration. Complex immutable definitions use an editable JSON configuration with
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
| Hosts, external orchestrators, setup, diagnostics and limits | Hosts and Orchestrators |
| Templates, image registry/library, import/capture receipts | Image library and host overview |
| Immutable machine blueprints | Machine blueprints |
| Administrative machine creation, desired state, power off and deletion | Machines and machine details |
| Guest screen, files, shells and accessibility | Machine Control |
| Application identities and policies | System and Configuration |
| Application-owned legacy and Linux leases | System; administrator release |
| Waiting requests, operation receipts and jobs | System; request/job cancellation and machine-operation receipt inspection |
| Access and video sessions | System; administrator close |
| Model catalog, resource domains, grants and runner approvals | Configuration |
| Linux lease images, grants and runner approvals | Configuration |
| Runner enrollment and revocation | Configuration |
| Inference models and jobs | Configuration |
| Application artifact admission, chunks, verification and deletion | Configuration |
| Discrete machine operations, including uploaded app installation | Configuration and Machine Control |
| Mobile video admission, inspection and closure | Configuration; playback remains a negotiated stream-client feature |
| Managed update releases and rollouts | Configuration |

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

Frontend/controller fixture checks do not establish native stream disconnection,
provider cleanup, mobile capture, model execution or deployment acceptance. No
native experiment, enrollment, update rollout or deployment is performed by
building or testing these screens.

## Administrator recovery contract

| Method and path | Request | Effect |
| --- | --- | --- |
| `GET /v1/admin/system` | none | Redacted activity across application, lease, request, job, operation and session ledgers |
| `GET /v1/admin/configuration` | none | Configured models, domains, grants, approvals, runner bindings/enrollments and application artifact metadata |
| `POST /v1/admin/leases/{id}/release` | `{id: mutationUUID}` | Terminalize the lease using its owning backend's cleanup rules |
| `POST /v1/admin/sessions/{id}/close` | `{id: mutationUUID}` | Revoke a single access/video session without ending its lease |
| `POST /v1/admin/applications/{id}/revoke` | `{id: mutationUUID}` | Revoke application authority and refresh subordinate lifecycle state |
| `POST /v1/admin/requests/{id}/cancel` | `{id: mutationUUID}` | Cancel waiting intent or release its admitted lease |
| `POST /v1/admin/jobs/{id}/cancel` | `{id: mutationUUID}` | Request model/inference cancellation without releasing claimed reservations early |

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
