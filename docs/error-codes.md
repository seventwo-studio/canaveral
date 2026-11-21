# Error codes

Every refusal from the controller carries a stable `code`. Clients should branch on
the code and the HTTP status, never on the message text, which may change.

```json
{ "error": "Request conflicts with current state. Inspect state before another mutation.",
  "message": "Request conflicts with current state. Inspect state before another mutation.",
  "code": "request_conflict", "requestId": "3f0c...", "retryable": false }
```

`retryable` says whether sending the same request again can succeed without a change
elsewhere. `outcome: "unknown"` is added when a mutation may have taken effect. In
that case never repeat the mutation under a new UUID: inspect the resource, or replay
the identical request with the same UUID. A 429 answer also carries `Retry-After`.

The CLI prints the code beside the HTTP status, for example
`Controller request failed (HTTP 409, request_conflict)`. Its exit status is 1 for
any refusal; codes are not mapped to distinct exit statuses.

This page lists every code written in `coordination/src`. A repository test
(`coordination/test/error-catalogue.test.ts`) scans the source and fails when a code
is missing here or when a code listed here is no longer used.

The **Status** column gives the HTTP status. `client` marks a code raised by the SDK
or CLI on the caller's side with no HTTP reply of that code. `receipt` marks a code
carried in an operation or cleanup receipt rather than as the reply status.

[Doctor finding codes](doctor.md#findings) and [event kinds](events.md#kinds) are
separate vocabularies with their own pages.

## General codes

These are used when a refusal names no more specific code. The code follows from the
status.

| Code | Status | Meaning | Retry |
| --- | --- | --- | --- |
| `invalid_request` | 400, client | The request is malformed: an unknown field, a wrong type, an invalid UUID or an out-of-range value. The SDK raises it before sending | No. Correct the request |
| `unauthenticated` | 401 | The credential is missing, wrong, expired, revoked or of a kind this route does not accept | No. Supply a current credential of the right kind |
| `forbidden` | 403 | The credential is valid but its role or scope does not permit the action; also a browser origin on a controller route | No. Use a credential with the needed authority |
| `not_found` | 404 | The route or resource does not exist, or belongs to another principal and is hidden | No. Check the identifier and the owner |
| `conflict` | 409 | The request conflicts with current state: a changed revision, a reused UUID with a different body, or a state that forbids the action | Not unchanged. Inspect current state first |
| `lease_ended` | 410 | The lease or its authorisation has ended; access and new work are refused | No. Acquire a new lease |
| `payload_too_large` | 413 | The body exceeds the size limit of its route | No. Send a smaller body |
| `limit_exceeded` | 429 | An application limit, a resource limit or a service concurrency bound was reached | After `Retry-After`, when `retryable` is true; otherwise free capacity first |
| `unavailable` | 503, client | Controller storage or the service is unavailable, or a permitted image has no host; a mutation may carry `outcome: unknown` | When `retryable` is true. Inspect before repeating a mutation |
| `request_failed` | 501, 502 | A refusal with a status that has no code of its own, such as a capability this build lacks | No. Read the status |

## Requests, leases and sessions

| Code | Status | Meaning | Retry |
| --- | --- | --- | --- |
| `capacity_unavailable` | 503 | No eligible host or approved runner domain has capacity for this acquisition | Yes, later. Prefer a waiting request, which is admitted when capacity frees |
| `capability_unsupported` | 409, receipt | The image, runtime or host does not implement the requested capability or operation; nothing ran | No. Choose a supported capability or template |
| `member_not_ready` | 409 | The lease or its member is not ready for access yet | Yes, once the lease is `ready` |
| `lease_credential_required` | 403 | Guest access needs the lease-scoped key; the application key was presented | No. Exchange for a lease key and use it |
| `credential_role` | 403 | The credential kind is not accepted on this route, for example an operator key on a lease transfer route | No. Use the lease's current key |
| `linux_ttl_below_minimum` | 400 | A Linux workspace lease TTL or its configured maximum is below 30 seconds | No. Request at least 30 seconds |
| `image_mismatch` | 409 | A runner receipt reported a different image digest than the lease pinned | No. The runner must report the assigned image |
| `request_conflict` | 409 | The request UUID already exists with a different kind, intent, priority, deadline or source | No. Replay the identical envelope or use a new UUID for new intent |
| `request_kind_unsupported` | 400 | The request kind is not `lease`, `linux-lease` or `model-job` | No. Use a supported kind |
| `request_priority_invalid` | 400 | The priority is not an integer within the application's maximum | No. Lower the priority |
| `request_wait_limit` | 429 | Too many held request reads: 32 across the controller or 4 for one application credential | Yes, after `Retry-After`, or read without `wait` |
| `request_waiting_limit` | 429 | The application has reached its limit of waiting requests | Yes, after cancelling waiting requests or after an admission |
| `preview_waiting_limit` | 429 | An owner reached the dashboard's limit of waiting previews or builds | Yes, after one starts or is cancelled |
| `capture_cleanup_pending` | 409 | An earlier recording or live capture of the device ended without confirmed cleanup, so a new live view of it is refused | Yes, later: once the cleanup is confirmed, or after an administrator abandons that session |
| `host_draining` | 409 | Admission is closed on the host by a drain, maintenance or an update | Later. A waiting request stays queued until admission reopens |
| `maintenance_blocked` | 409 | A maintenance drain cannot be resumed; the reply lists the blockers | After resolving the listed resume blockers |
| `session_disconnected` | 410, client | The session's stream ended; unconfirmed input was not applied on reconnect | Open a new session with a new UUID; do not replay input |
| `session_incomplete` | receipt, client | A session reply did not arrive or native capture ended early; the result is incomplete | Inspect the original receipt before another action |
| `session_protocol_error` | client | The peer sent a frame outside the session protocol | No. Close the session and report the mismatch |
| `chunk_too_large` | 413 | A transfer body exceeds 128 KiB | No. Send smaller chunks |
| `download_destination_exists` | 409 | The download destination exists and replacement was not requested | Only with an explicit replace policy |
| `upload_publication_uncertain` | 409 | A durable upload may have been published but was not confirmed | No. Inspect the destination before retrying |
| `transfer_helper_invalid` | 400 | The Android transfer helper failed its manifest, architecture, API level or checksum check | No. Install a matching helper |

## Guest input and display

| Code | Status | Meaning | Retry |
| --- | --- | --- | --- |
| `input_busy` | 409, client | Another input operation holds the guest's input lane | Yes, after the current operation finishes |
| `input_not_owned` | 409, receipt | The display session does not own the input context | No. Take input ownership first |
| `input_rejected` | 409 | Native input or inspection refused the request or is unavailable | Not unchanged. Check the target and the guest's input support |
| `input_stale` | 409 | The frame, element or display topology the action refers to is out of date | Capture a new frame, then act |
| `input_reset_uncertain` | 409, 410 | Guest input ended or its state could not be confirmed; an explicit reset is needed | No. Reset input explicitly and inspect the guest |
| `file_cleanup_uncertain` | 409 | Cleanup of a guest file transfer could not be confirmed | No. Inspect the guest before reusing the transfer |
| `worker_interrupted` | 503 | A guest worker stopped before confirming its reply; an effect may have happened | No. Inspect guest state first |
| `video_stop_uncertain` | 409 | A video capture ended without the guest confirming completion | No. Inspect the recorder before reopening |

## Runner and host state

| Code | Status | Meaning | Retry |
| --- | --- | --- | --- |
| `transport_interrupted` | 503 | The controller's or a guest's reply was not confirmed; a mutation may have taken effect | No. Inspect state, then replay the identical request if needed |
| `assignment_busy` | 409 | The assignment or its owned state has active work or an unresolved lock | After the current work ends; an unresolved lock needs inspection |
| `execution_pending` | 409, receipt | Native stop of a leased runtime is not confirmed, so cleanup cannot proceed | The runner retries cleanup; reservations stay held |
| `operations_pending` | 409, receipt | Owned helper processes of an assignment are not confirmed closed | The runner retries cleanup; inspect surviving helpers |
| `ownership` | 409, receipt | Assignment or storage ownership differs from the recorded owner | No. Investigate the mismatch before any removal |
| `storage_removal` | 409, receipt | A native storage removal receipt does not match its request | No. Inspect the host's storage and receipts |
| `credential_erasure` | 409, receipt | The layout for erasing an assignment's credentials differs from the expected one | No. Inspect the assignment directory |
| `recovery` | 409, receipt | An unexplained storage quarantine was found during cleanup recovery | No. An operator must resolve the quarantine |
| `helper_cancellation_uncertain` | 409 | Closure of an owned helper process could not be confirmed; its reservation is retained | No. Inspect the process before reuse |
| `host_shutdown_incomplete` | 409 | A host stopped without confirming every cleanup step | No. Inspect the host before restarting work |
| `image_cache_publication_uncertain` | 409 | Publication of a cached base image was not confirmed | No. Inspect the cache before retrying |
| `lease_deadline_artifact_invalid` | 409 | The configured Linux lease deadline library failed its static validation | No. Install a valid artifact |

## Observability

| Code | Status | Meaning | Retry |
| --- | --- | --- | --- |
| `event_kind_unknown` | 400 | An event kind or family is not in the catalogue | No. Use a kind from `GET /v1/admin/events/kinds` |
| `event_stream_limit` | 429 | The bound on concurrent event streams was reached | Yes, later, or poll the list route |
| `usage_range_invalid` | 400 | The usage range is not UTC RFC3339, is empty or exceeds 400 days | No. Correct the range |
| `usage_group_unsupported` | 400 | The grouping is unknown, or `host` was asked on the application route | No. Use a supported grouping |
| `alert_destination_invalid` | 400 | An alert destination's name, type, URL, secret or fields are invalid | No. Correct the destination |
| `alert_destination_insecure` | 400 | An alert destination URL is not HTTPS and not loopback | No. Use an HTTPS URL |
| `alert_destination_conflict` | 409 | The UUID belongs to a different or removed destination, or a test UUID to another delivery | No. Replay the identical intent or use a new UUID |
| `alert_destination_limit` | 409 | The maximum number of alert destinations exists | After removing a destination |

## SDK and gateway codes

These are raised on the caller's side. They describe the connection or a local
precondition, not a controller decision.

| Code | Status | Meaning | Retry |
| --- | --- | --- | --- |
| `invalid_configuration` | client | The client options are invalid, such as a base URL that is not HTTPS | No. Correct the configuration |
| `invalid_credential` | client | The credential is not an opaque token of the expected shape | No. Load the right credential |
| `invalid_ca` | client | The CA file or bundle could not be read or is not valid PEM | No. Supply a valid bundle |
| `connection_failed` | client | The connection failed or the reply was interrupted; a mutation's outcome is unknown | Reads yes. Inspect before repeating a mutation |
| `timeout` | client | No complete reply arrived within the client's time limit; a mutation's outcome is unknown | Reads yes. Inspect before repeating a mutation |
| `tls_verification_failed` | client | The controller certificate was not accepted; no request was sent | No. Fix the certificate or the CA bundle |
| `redirect_refused` | client | The controller answered with a redirect, which the client never follows | No. Use the controller's own origin |
| `response_too_large` | client | The reply exceeds the client's response size limit | No. Raise the limit or page the request |
| `content_type_invalid` | client | The reply is not JSON, or not an event stream where one was requested | No. Check that the origin is a controller |
| `response_invalid` | 502, client | A reply did not match the contract; the dashboard gateway returns 502 for it | No. Inspect state; a mutation's outcome is unknown |
| `session_upgrade_refused` | client | The controller refused the session WebSocket upgrade | No. Check the session identity and lease state |
| `capture_cancelled` | client | A display capture was cancelled; any recording output is incomplete | Start a new capture |
| `recording_incomplete` | client | A recording exceeded its byte budget or timed out; its output is incomplete | Start a new recording with a larger budget |
| `video_incomplete` | client | A video operation was cancelled or timed out; completion is unconfirmed | Inspect the video session before reopening |
| `download_publication_uncertain` | client | A downloaded file may have been published locally but was not confirmed | No. Inspect the local destination |
| `download_temporary_cleanup_failed` | client | A private temporary file could not be created or removed | No. Inspect and remove the temporary file |
| `publication_unknown` | client | Reason on a file publication error: the published file's identity was not confirmed | No. Inspect the destination |
| `temporary_unknown` | client | Reason on a file publication error: a temporary file's state is unknown | No. Inspect the temporary file |
