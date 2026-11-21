# Event log

Implemented in the TypeScript controller. Verified by portable fixtures only: a real
controller on loopback with disposable fixture hosts. No native runtime, emulator or
device took part, and nothing here establishes native runtime acceptance.

The controller keeps a durable, append-only history of what changed: leases and
waiting requests, hosts, machines and devices, operation outcomes, video sessions,
install resolution, update rollouts and administrator interventions. Operators read
it by cursor or time and can follow it live. An application reads the part about its
own leases and requests. [Usage reporting](usage.md), [alerts](alerts.md) and
[`canaveral doctor`](doctor.md) build on it. Clients no longer need to poll
inventory to notice a change.

## How events are written

Every event is a row in the `events` table of the controller's SQLite database with
a sequence from `AUTOINCREMENT`. The sequence only grows and is never reused, also
after rows are pruned or the controller restarts.

State changes are captured by SQLite triggers on the ledger tables, not by calls in
each code path. The event is therefore written by the same statement, and committed
in the same transaction, as the row change it describes. This holds for both
controller workers and for every route, timer and lifecycle refresh that changes a
ledger. A change that rolls back leaves no event, including one refused admission
attempt inside a larger admission pass. SQLite serialises writers, so sequence order
is commit order.

Triggers cannot read the controller clock. They insert the event without a time, and
the store stamps `at` just before `COMMIT`. A row inserted by another tool on the same
database is stamped by the next controller transaction that reads or writes events.

Three kinds of fact have no row change to capture and are written explicitly:

- **Derived conditions.** A host that stops reporting, storage or memory pressure and
  a request that waits too long are detected by an observer on a timer. It writes the
  event together with a durable condition row, in one transaction, so each transition
  is recorded once and survives a restart. After a start the observer waits 45 seconds
  before it judges host liveness, because every host looks silent until its next
  heartbeat.
- **Refused direct acquisitions.** A refused `POST /v1/leases` rolls back and changes
  nothing. `lease.refused` is written afterwards in its own transaction, for the
  authenticated application only, and at most once per application and code per
  minute. It is a signal, not a count.
- **Controller start, alert destination changes and exhausted alert deliveries.**

Capture is installed when the control worker starts, after every module has created
its tables. Each trigger is compiled once against the live schema; one that does not
fit is dropped, so a schema this version does not expect loses that event kind rather
than failing writes to that table. `controller.started` reports how many were
installed.

## What an event contains

```json
{
  "sequence": 4812,
  "at": "2026-11-21T09:14:03.512Z",
  "kind": "lease.cleanup_blocked",
  "applicationId": "9415f91b-569d-4d93-a09d-8f7f903a8463",
  "leaseId": "b7682a27-b32e-472a-8a4d-f54a98a6d962",
  "hostId": "5a0d0a53-6f3e-4d0e-8a3c-0d1b7f2f9a10",
  "machineId": "0c8d2d5e-64f1-5b0a-9d55-0a8a5b0f6f11",
  "data": { "ledger": "generic", "state": "released", "cleanup": "blocked", "reason": "storage_removal", "attempts": 3 }
}
```

`applicationId`, `leaseId`, `requestId`, `hostId` and `machineId` appear when the
event is about one. `data` holds identifiers, states and bounded reason codes.
Credentials, credential hashes, command arguments, operation results, prompts, file
contents, provider detail text and free-text operator reasons are never read by a
trigger. A reason column is copied only when it is a short code; other text is left
out.

`reason` is present where the ledger records or implies it. The generic lease ledger
does not store why a lease ended, so a failed generic lease names `runtime_error` or
`preparation_failed` when a member shows it and otherwise has no reason.

## Retention

| Setting | Default | Range | Effect |
| --- | --- | --- | --- |
| `eventRetentionSeconds` | 2592000 (30 days) | 3600 to 34560000 | Older events are removed once a minute |
| `eventMaxRows` | 100000 | 1000 to 5000000 | Hard cap on rows, enforced by a trigger on every insert |

The row cap is part of the schema: it holds inside the writing transaction and for
any writer. `operation.succeeded` and `lease.refused` are high-volume kinds. Each is
kept in its own tier of one tenth of the cap, so routine successes cannot push the
rest of the history out.

Set both under `observability` in the controller configuration file. They are not
`serve` flags.

```json
{ "observability": { "eventRetentionSeconds": 1209600, "eventMaxRows": 250000 } }
```

A cursor older than the oldest retained event is not an error. The list response
sets `truncated: true` and the stream sends a `truncated` message, so a consumer
knows that it missed history. An older controller opened on this database keeps the
triggers and the row cap, but it neither prunes by age nor stamps event times. Such
events are stamped, with that later time, when a current controller next opens the
database.

## Reading events

| Method and path | Credential | Result |
| --- | --- | --- |
| `GET /v1/admin/events` | Administrator | All events, oldest first |
| `GET /v1/admin/events/kinds` | Administrator | The kind catalogue |
| `GET /v1/admin/events/stream` | Administrator | Live follow, server-sent events |
| `GET /v1/events` | Application | That application's events |
| `GET /v1/events/stream` | Application | Live follow of that application's events |

Administrator means the operator credential or an active account with administrator
scope. Application routes accept only the application credential. A lease key, host
key or administrator credential is refused with 401.

Query parameters of the list routes:

| Parameter | Meaning |
| --- | --- |
| `after` | Sequence cursor, exclusive. Omitted: start at the oldest retained event |
| `tail` | The newest N matching events, 0 to 500. Not with `after` |
| `limit` | Page size, 1 to 500, default 100 |
| `since` | UTC RFC3339 lower bound on `at` |
| `kind` | A kind, or a family such as `lease.*`. Repeat it or separate with commas, at most 32 |
| `lease`, `request` | Only events about that UUID |
| `application`, `host`, `machine` | Administrator routes only |

An unknown kind or family returns 400 `event_kind_unknown`. The response is
`{events, cursor, more, truncated}`. Pass `cursor` as the next `after`. `more` says
that there is more to read now. On a full page `cursor` is the last event returned;
otherwise it is as far as the read examined, so a reader with a narrow filter does
not scan the same range again. `truncated` means retention removed events after the
supplied cursor. Those events may not have matched the filter. Administrator
responses add `oldestSequence` and `latestSequence`.

Every read does bounded work, because it runs inside the controller's single write
transaction:

- A read by application alone (every unfiltered application read) or by one exact
  kind alone follows an index in sequence order and costs its page.
- Any other read, such as a family, several kinds or a subject filter, examines at
  most 20,000 sequences of the log. Its page can come back short, or empty, with
  `more: true` and `cursor` at the end of that stretch. Read again from `cursor`.
- `tail` with such a filter looks at the newest 20,000 sequences only.

`since` finds its starting point by sequence and assumes that the controller clock
has not moved backwards.

### Live follow

The stream routes take `after`, `kind` and the subject filters of their scope. The
resume cursor is the `Last-Event-ID` header, or `after` when the header is absent.
The header wins because a standard SSE client reconnects to the same URL and sends
the last id it saw, which is newer than an `after` still in that URL. Without
either, the stream starts after the newest matching event.

| Message | `id` | `data` | Sent |
| --- | --- | --- | --- |
| unnamed | The event's sequence | The event | For every matching event |
| `open` | The position the stream starts after | `{cursor}` | First, always |
| `cursor` | How far the stream has read | `{cursor}` | After ten seconds without another message |
| `truncated` | none | `{after}` | When retention removed history after the resume cursor |
| `end` | How far the stream has read | `{code, cursor}` | When the controller closes the stream |

Every message that moves the position carries it as its `id`. A client that
reconnects with the last id it received therefore neither loses nor repeats an
event while that position is still retained. This also holds for a stream on which
no event arrived: `open`, `cursor` and `end` tell it where it stands.

`end` codes are `stream_lifetime` after one hour, `controller_closing` when the
controller shuts down, `unauthenticated` or `forbidden` when the credential stopped
being valid, and `unavailable`. A stream that stops without `end` was cut off.

A stream is authorised by reading the list route with the follower's credential on
every round, at least every 15 seconds, so revocation ends it. When the controller
is momentarily too busy to answer, the round is skipped and the stream stays open.

Streams are bounded, and a refused request gets 429 `event_stream_limit`:

| Bound | Limit |
| --- | --- |
| Open streams in total | 32 |
| Open streams per credential | 4 |
| Open application streams in total | 24, so eight are always left for administrators |
| Stream requests being authenticated at once | 4 |

The last bound means a burst of stream requests, authenticated or not, cannot fill
the request slots that ordinary routes use. Open streams together use one of those
slots at a time and never hold a transaction. Controller routes refuse browser
origins, so a browser reaches a stream only through a gateway that relays it.

### What an application sees

An application sees events whose `applicationId` is its own: its leases, its waiting
requests, the leased machines' state changes, operation and install outcomes on its
leases, lease video sessions and its own identity events. The filter is applied in
SQL from the authenticated application. `hostId` and the administrator filters are
not part of the application view. Sequences are positions in the controller-wide
log, so an application's events are not consecutive.

## Kinds

Lease kinds cover both lease ledgers; `data.ledger` is `generic` or `linux`.

| Kind | Written when | Payload |
| --- | --- | --- |
| `controller.started` | The controller opened its state | `controllerId`, `captured` |
| `application.created` | An application identity was created | `name` |
| `application.credential_rotated` | An application credential was rotated | `rotated` |
| `application.revoked` | An application was revoked | `revoked` |
| `lease.admitted` | A lease was admitted and reserved; provisioning began | `ledger`, `templateId`, `templateRevision`, `arch`, `platform`, `expiresAt`, `member` |
| `lease.refused` | A direct acquisition was refused (403, 429 or 503) | `ledger`, `code`, `status`, template fields |
| `lease.ready` | Every member became ready | `ledger`, `state`, `previous`, `revision` |
| `lease.renewed` | The deadline was extended | `ledger`, `revision`, `expiresAt` |
| `lease.released` | The lease was released | `ledger`, `revision`, `reason` when revoked |
| `lease.expired` | The lease reached its deadline | `ledger`, `revision`, `reason` |
| `lease.failed` | Provisioning or runtime failed | `ledger`, `revision`, `reason` when known |
| `lease.cleanup_blocked` | Cleanup became blocked | `ledger`, `cleanup`, `reason`, `attempts` |
| `lease.cleanup_proven` | Cleanup was proven and reservations released | `ledger`, `cleanup` |
| `request.submitted` | A waiting request was stored | `requestKind`, `priority`, `deadline`, template or model |
| `request.admitted` | A request was admitted | `requestKind`, `target`, `priority` |
| `request.cancelled` | A waiting request was cancelled | `requestKind`, `reason` |
| `request.expired` | A waiting request passed its deadline | `requestKind`, `reason` |
| `request.rejected` | A request was permanently rejected | `requestKind`, `reason` |
| `request.waiting_long` | A request waited past `requestWaitAlertSeconds` | `requestKind`, `waitedSeconds`, `thresholdSeconds`, `reason` |
| `host.enrolled` | A host enrolled | `name`, `provider` |
| `host.online` | A silent host reported again | `offlineSeconds` |
| `host.offline` | A host stopped reporting for 30 seconds | `lastSeenAt`, `silentSeconds` |
| `host.accepting` | A host was set to accept placements | `accepting` |
| `host.draining` | A host was set to refuse placements | `accepting` |
| `host.maintenance_began` | A maintenance drain began | `drainId`, `phase` |
| `host.maintenance_resumed` | A maintenance drain was resumed | `drainId`, `phase` |
| `host.checks_failed` | Environment checks started failing | `status`, `failedChecks` |
| `host.checks_passed` | Environment checks recovered | `status` |
| `host.limits_changed` | Host limits were saved | `cpu`, `memoryMiB`, `diskGiB` |
| `host.disk_pressure` | Free storage fell below `diskFreeAlertPercent` | `freeGiB`, `totalGiB`, `freePercent`, `thresholdPercent` |
| `host.disk_pressure_cleared` | Free storage recovered | same |
| `host.memory_pressure` | Available memory fell below `memoryAvailableAlertPercent` | `availableMiB`, `totalMiB`, `freePercent`, `thresholdPercent` |
| `host.memory_pressure_cleared` | Available memory recovered | same |
| `machine.created` | A machine or device was placed | template fields, `platform`, `mode`, `desired` |
| `machine.desired` | Its requested state changed | `desired`, `previous` |
| `machine.observed` | Its observed runtime state changed | `observed`, `previous`, `platform` |
| `machine.error` | It reported a runtime error | `observed`, `previous`, `platform` |
| `machine.preparation` | Guest preparation changed state | `state`, `previous` |
| `machine.power_off_requested` | An explicit power-off was requested | `requestId`, `state` |
| `machine.power_off` | A power-off reached an outcome | `requestId`, `state`, `previous` |
| `machine.deletion_requested` | Owned storage deletion was requested | `requestId`, `state` |
| `machine.deletion_blocked` | Deletion became blocked | `requestId`, `state`, `previous` |
| `machine.deleted` | Deletion completed | `requestId`, `state`, `previous` |
| `operation.succeeded` | A device or command operation succeeded | `operationId`, `ledger`, `action` |
| `operation.failed` | It failed | `operationId`, `ledger`, `action` |
| `operation.unknown` | Its outcome is unknown | `operationId`, `ledger`, `action` |
| `install.succeeded` | An app installation succeeded | `operationId`, `action` |
| `install.failed` | An app installation failed | `operationId`, `action` |
| `install.unknown` | An app installation has an unknown outcome | `operationId`, `action` |
| `install.resolved` | An operator resolved an uncertain installation | `operationId`, `resolutionId`, `decision` |
| `video.session_opened` | A video session was admitted | `sessionId`, `state`, `member` |
| `video.session_ready` | It became ready | `sessionId`, `state`, `previous` |
| `video.session_ended` | It finished or disconnected | `sessionId`, `state`, `previous` |
| `video.session_cleaned` | Host cleanup was confirmed | `sessionId`, `state` |
| `video.session_abandoned` | An administrator abandoned its cleanup | `sessionId`, `decision` |
| `update.rollout_created` | A managed update rollout was created | `rolloutId` |
| `update.job_queued` | A host update job was queued | `jobId`, `rolloutId`, `targetKind`, `releaseId`, `phase` |
| `update.job_phase` | A job changed phase | `jobId`, `phase`, `previous`, `uncertain` |
| `update.job_succeeded` | A job succeeded | same |
| `update.job_rolled_back` | A job rolled back | same |
| `update.job_failed` | A job failed | same |
| `update.job_cancelled` | A job was cancelled | same |
| `update.job_uncertain` | A job has an uncertain outcome | same |
| `admin.intervention` | An administrator recovery action was recorded | `mutationId`, `action`, `target`, `actor` |
| `alert.destination_added` | An alert destination was added | `destinationId`, `type`, `kinds`, `actor` |
| `alert.destination_removed` | An alert destination was removed | `destinationId`, `actor` |
| `alert.delivery_failed` | An alert exhausted its retries | `deliveryId`, `destinationId`, `kind`, `attempts`, `outcome` |

Operation events report outcomes, not submissions. `action` is the action name
only. Other pressure and wait thresholds are set under `observability`:

| Setting | Default | Range |
| --- | --- | --- |
| `requestWaitAlertSeconds` | 600 | 10 to 604800 |
| `diskFreeAlertPercent` | 10 | 1 to 50 |
| `memoryAvailableAlertPercent` | 5 | 1 to 50 |

Pressure uses the host's own resource samples. It begins below the threshold and
ends two percentage points above it. An unavailable reading changes nothing.

## SDK and CLI

```ts
const page = await client.listEvents({ kinds: ["lease.*"], after: savedCursor });
for await (const event of client.followEvents({ after: page.cursor })) handle(event);
```

`ConsumerClient.listEvents` and `followEvents` read `/v1/events` with the
application key. `followEvents` is one stream and never reconnects. How it ends is
always visible to the caller:

- It returns `{reason, cursor}` for an ordinary end: `stream_lifetime`,
  `controller_closing`, or `aborted` when the caller's signal fired. A `for await`
  loop simply finishes. Follow again with `after` set to that cursor or to the last
  `sequence` received.
- It throws a service error with code `unauthenticated` or `forbidden` when the
  credential is no longer accepted, and `unavailable` for any other end.
- It throws a transport error when the connection stops without an `end` message.
- When retention removed history after `after`, it calls `onTruncated` and
  continues. Without that handler it throws `events_truncated`, so a consumer that
  resumes from an expired cursor cannot miss history without being told.

`onCursor` reports the stream's position while it is quiet, so a follower can save
a fresh cursor.

```sh
canaveral --token-file admin.token events --kind 'lease.*' --tail 20
canaveral --token-file admin.token events --follow --after 4812
canaveral --token-file app.key events --own --lease b7682a27-b32e-472a-8a4d-f54a98a6d962
```

`events` prints one JSON object per line and the resume cursor on standard error.
`--text` prints a line per event instead. A filtered listing reads on, up to 50
requests, until it has printed `--limit` events or reached the head of the log.
`--own` reads the application view with an application credential.

`--follow` streams until interrupted. Without `--after` it starts at the head and
prints only new events. It resumes from the newest position the controller reported,
never from the beginning. A stream that ends at its one-hour lifetime is followed
again at once, without a limit. A closing or unavailable controller, or a lost
connection, is retried five times, two seconds apart; any message received resets
that count. Any other end, such as a revoked credential, stops the command with
exit status 1.

## Limits

- Model job state changes have no events of their own. Queued model calls appear as
  `request.*` events.
- Access sessions (shell, file and display sessions) are not captured. Video
  sessions are.
- A refused direct acquisition is throttled and so cannot be counted.
- Alerts and the usage ledger derive from events. A row written by another tool is
  projected when the controller next reads or writes events, not at once.
- A filtered read examines 20,000 sequences per request. Finding a rare event in a
  large log takes several requests, and a filtered `tail` does not look further back
  than that.
- At startup the controller scans both lease ledgers once to seed the usage ledger
  with the leases that are active.
- The dashboard's Activity page shows the administrator view by reading the list
  route with its cursor; see [the dashboard contract](dashboard.md#queue-activity-and-usage).
  The gateway forwards `/v1/admin/events` and `/v1/admin/events/kinds` only. It
  does not forward either stream or the application routes.
- Host liveness is judged from heartbeats, as elsewhere in the controller. An event
  says that the host stopped reporting. It does not say that its machines stopped.
