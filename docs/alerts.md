# Alerts

Implemented in the TypeScript controller. Verified by portable fixtures: an injected
clock for retry and restart behaviour, and loopback receivers for the wire request.
No test contacts an external service, and no delivery to a real Slack workspace has
been observed.

An alert is an [event](events.md) sent to an administrator-managed destination. A
destination selects event kinds. When a selected event is committed, the controller
queues one delivery for it and sends it shortly afterwards, outside the request that
caused it.

## Destinations

| Type | Request | Authentication |
| --- | --- | --- |
| `slack` | `{"text": "..."}`, the Slack incoming-webhook shape | The secret webhook URL |
| `webhook` | A JSON alert, described below | HMAC-SHA256 signature over the body |

At most eight destinations exist at once. A destination has a caller-chosen UUID, a
name, a URL, the kinds it selects and, for `webhook`, a signing secret of 32 to 512
printable ASCII characters. When `kinds` is omitted it selects the attention kinds:
the events marked as needing an operator, listed by `GET /v1/admin/events/kinds`
with `attention: true`.

The URL must be `https:`. Plain `http:` is accepted only for `localhost`,
`127.0.0.0/8` and `::1`, for a relay on the controller's own machine. A URL with
embedded credentials or a fragment is refused. Redirects are never followed.

### Secrets

The URL and the signing secret are stored as given in the controller's SQLite
database. That file is created with mode 0600 and already holds the controller's
other state. They cannot be stored as hashes, as credentials are, because the
controller has to present them. There is no encryption at rest: protect the database
file and its backups accordingly.

No route returns either value. Responses name only the URL's origin, because a Slack
webhook path is itself a credential, and whether the destination is signed.
Removing a destination erases its URL and secret from the database.

## Routes

All routes require administrator authority.

| Method and path | Request | Effect |
| --- | --- | --- |
| `GET /v1/admin/alerts/destinations` | none | Destinations with delivery counts and the last attempt |
| `POST /v1/admin/alerts/destinations` | `{id, name, type, url, secret?, kinds?}` | 201 new, 200 exact replay |
| `POST /v1/admin/alerts/destinations/{id}/remove` | `{}` | Remove; cancels unsent deliveries |
| `POST /v1/admin/alerts/destinations/{id}/test` | `{id: requestUUID}` | One immediate delivery of kind `alert.test` |
| `GET /v1/admin/alerts/deliveries` | `destination`, `state`, `limit` query | Recent deliveries, newest first |

Adding is idempotent by UUID. The same UUID with the same name, type, URL, secret
and kinds returns the destination. Anything else under that UUID, including the UUID
of a removed destination, returns 409 `alert_destination_conflict`. A ninth
destination returns 409 `alert_destination_limit`. Invalid input returns 400
`alert_destination_invalid`, an insecure URL 400 `alert_destination_insecure`, an
unknown kind 400 `event_kind_unknown`.

A test sends once and returns the recorded delivery, including the receiver's HTTP
status. It is never retried and a failed test is not reported as an incident.
Repeating the same request UUID returns the same record without sending again.

## Delivery

A delivery is queued by the same transaction that records its event. A committed
event therefore has its deliveries, and a rolled-back change has neither.

Sending never runs inside a transaction or a request. Once a second the controller
claims due deliveries in a short transaction that counts the attempt and schedules
the next one, then sends, then records the outcome in a second short transaction. A
send is one POST with a five second limit.

| Attempt | Sent |
| --- | --- |
| 1 | As soon as the event is committed |
| 2 | 10 seconds after attempt 1 |
| 3 | 60 seconds after attempt 2 |
| 4 | 5 minutes after attempt 3 |
| 5 | 15 minutes after attempt 4 |

A 2xx answer ends the delivery. Any other answer, a redirect, a timeout or a
connection failure is a failed attempt. After the fifth failure the delivery is
`failed` and an `alert.delivery_failed` event is recorded. That event can be
selected by another destination; its own failure is not reported again.

**Delivery is at least once.** If the controller stops after sending and before
recording the outcome, it sends that delivery again at its scheduled time. Because
the attempt was counted before it was sent, a delivery is never sent more than five
times, whatever happens to the controller. Pending deliveries survive a restart. A
delivered alert is never sent again. An attempt that was claimed as the last one and
never recorded is closed as `failed` with outcome `interrupted`.

Receivers de-duplicate on the delivery `id`, which is the same for every attempt.

To keep a flapping condition from flooding a channel, a destination receives at
most one alert per kind and subject in five minutes. Every transition is still in
the event log.

Settled deliveries are kept for seven days, and at most 2000 of them.

## The webhook request

```http
POST /hook HTTP/1.1
Content-Type: application/json
User-Agent: Canaveral-alerts/1
X-Canaveral-Delivery: 7c1d2a4e-8f0b-4a7e-9f3d-2b6c1e5a9d10
X-Canaveral-Signature: sha256=3b1f...e9

{"id":"7c1d2a4e-8f0b-4a7e-9f3d-2b6c1e5a9d10","type":"canaveral.alert","controllerId":"...","kind":"host.offline",
 "sequence":4812,"occurredAt":"2026-11-21T09:14:03.512Z","summary":"A host stopped reporting within the freshness window. (host 5a0d...)",
 "event":{"sequence":4812,"at":"2026-11-21T09:14:03.512Z","kind":"host.offline","hostId":"5a0d...","data":{"silentSeconds":30}},
 "attempt":1,"sentAt":"2026-11-21T09:14:04.020Z"}
```

`X-Canaveral-Signature` is `sha256=` followed by the lowercase hex HMAC-SHA256 of
the exact request body bytes, keyed with the destination's secret. Verify it over
the bytes received, before parsing, with a constant-time comparison:

```ts
const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
const ok = expected.length === header.length && timingSafeEqual(Buffer.from(expected), Buffer.from(header));
```

`attempt` and `sentAt` change between attempts, so the body and its signature do
too; `id` does not. Reject a `sentAt` that is too old for your tolerance to bound
replay. The body carries the event as an administrator sees it. It contains no
credential, command argument or operation result.

## Kinds worth selecting

Any event kind can be selected. These cover what an operator usually wants to hear
about, including three conditions specific to this controller.

| Condition | Kind |
| --- | --- |
| A host stopped or resumed reporting | `host.offline`, `host.online` |
| A host was drained or put into maintenance | `host.draining`, `host.maintenance_began` |
| Host prerequisites are failing | `host.checks_failed` |
| Host storage or memory is short | `host.disk_pressure`, `host.memory_pressure` |
| A machine or device reported an error | `machine.error` |
| A lease failed | `lease.failed` |
| **Lease cleanup is blocked** | `lease.cleanup_blocked` |
| **An operation outcome is unknown** | `operation.unknown`, `install.unknown` |
| An app installation failed | `install.failed` |
| **A request waited longer than the configured threshold** | `request.waiting_long` |
| A request was permanently rejected | `request.rejected` |
| An update failed, rolled back or is uncertain | `update.job_failed`, `update.job_rolled_back`, `update.job_uncertain` |

`request.waiting_long` is raised once per request when it has waited
`requestWaitAlertSeconds` (default 600). The pressure thresholds are
`diskFreeAlertPercent` and `memoryAvailableAlertPercent`. Set them under
`observability` in the controller configuration; see [events](events.md#kinds).

## CLI

```sh
canaveral --token-file admin.token alerts add --request-id "$(uuidgen)" --name Operations \
  --type webhook --url-file ./hook.url --secret-file ./hook.secret \
  --kind host.offline --kind lease.cleanup_blocked --kind operation.unknown
canaveral --token-file admin.token alerts list
canaveral --token-file admin.token alerts test 7b0e8a52-3c1f-4f6a-9a4e-1d2c3b4a5f60
canaveral --token-file admin.token alerts deliveries --state failed
canaveral --token-file admin.token alerts remove 7b0e8a52-3c1f-4f6a-9a4e-1d2c3b4a5f60
```

The URL and the secret are read from files that must be owned by you with mode
0600. They are never command arguments and are never printed. Keep the request UUID:
repeating `alerts add` with the same UUID and files is safe after a lost response.
`alerts test` exits 0 when the receiver answered 2xx and 1 otherwise.

## Limits

- Destinations use the default trust store. A receiver with a private certificate
  authority is not supported; put it behind a certificate the controller trusts or a
  loopback relay.
- An administrator may point a destination at any HTTPS host the controller can
  reach, including private addresses. Destination management is an administrator
  action for that reason.
- Slack receives one line of text per alert. There is no message formatting,
  grouping or acknowledgement.
- There is no escalation, schedule or per-destination rate limit beyond the
  cooldown.
- The dashboard has no alert screens. The dashboard gateway does not forward these
  routes.
