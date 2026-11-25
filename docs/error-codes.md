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

This page lists the codes written in `coordination/src`. A repository test
(`coordination/test/error-catalogue.test.ts`) parses that source with the TypeScript
compiler and fails when a code it finds is missing here, or when a code listed here
is no longer found. [What the test checks](#what-the-test-checks) says exactly what
it reads and what it cannot see.

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
| `invalid_request` | 400, 409, client | The request is malformed: an unknown field, a wrong type, an invalid UUID or an out-of-range value. The SDK raises it before sending. A runner transfer poll that names another boot or bundle gets it with 409 | No. Correct the request |
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
| `unsupported_host_provider` | 400, local | The provider is unsupported by canaverald or controller enrollment | No. Configure a supported provider and enroll it with a separate host identity |
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
| `internal_error` | client | The agent could not complete the command and returned a generic error | Inspect any recorded outcome before retrying a write |
| `invalid_arguments` | client | An agent command received unsupported or malformed arguments | Correct the arguments and submit the command again |
| `lease_ambiguous` | client | The agent holds several leases and the command did not name one | Supply the intended lease UUID |
| `lease_in_progress` | client | The agent is still acquiring or provisioning the requested lease | Wait for acquisition or readiness before issuing device commands |
| `lease_key_missing` | client | The agent has no device credential for the lease | Establish a lease session with a current credential |
| `lease_not_held` | client | The named lease is outside the current agent session | Acquire or select a lease held by this session |
| `local_file_error` | client | The agent could not read or use the requested local file | Check the path and permissions before retrying |
| `operation_unknown` | client | The agent cannot confirm whether the device operation completed | Inspect the original receipt before taking another action |
| `provisioning_timeout` | client | The admitted device did not become ready within the wait | Inspect the lease state and provisioning reason |
| `release_unconfirmed` | client | The controller still reports the lease active after release | Inspect the lease and its release receipt before retrying |
| `session_closed` | client | The agent session is closing and refuses new leases | Start another session before requesting a lease |
| `template_ambiguous` | client | Several allowlisted device templates match the selection | Specify an exact revision and architecture |
| `template_unknown` | client | No device template available to the application matches | List the available templates and choose a matching one |
| `wait_deadline` | client | The agent's wait for admission reached its deadline | Inspect the request state and choose a new wait if needed |
| `request_cancelled` | client | The device request was cancelled before the agent received a lease | Submit a new request if a device is still needed |
| `request_rejected` | client | The controller rejected the device request without admitting a lease | Read the reported reason and address it before submitting another request |
| `request_waiting_limit` | 429 | The application has reached its limit of waiting requests | Yes, after cancelling waiting requests or after an admission |
| `preview_waiting_limit` | 429 | An owner reached the dashboard's limit of waiting previews or builds | Yes, after one starts or is cancelled |
| `baseline_clone_failed` | 409 | The host could not finish creating the device from the baseline | Inspect the lease receipt and confirm partial storage was cleaned |
| `baseline_clone_incomplete` | 409 | A previous baseline copy into the device was interrupted | Let cleanup settle the device before requesting another lease |
| `baseline_corrupt` | 409 | The stored baseline failed an integrity or manifest check | Replace the baseline with a verified capture |
| `baseline_exists` | 409 | The baseline name and revision are already present on the host | Choose a new baseline revision or inspect the existing one |
| `baseline_mismatch` | 409 | The baseline does not match the selected image or data size | Select a baseline with the matching immutable image definition |
| `baseline_missing` | 409 | The recorded baseline is absent on the selected host | Make the required baseline available before trying again |
| `baseline_overlay_unsupported` | 409 | The device image overlay cannot be copied independently | Use a supported self-contained image and verify its baseline |
| `baseline_referenced` | 409, receipt | A template or device still points to the baseline | Clear its references before requesting removal |
| `baseline_source_changed` | 409 | The source device changed while its baseline was being captured | Confirm the source is stopped and inspect the capture receipt |
| `baseline_source_leased` | 409 | The source is a leased or warm device and cannot be saved | Choose an eligible stopped administrator-owned device |
| `baseline_source_not_owned` | 403 | The caller does not own the device eligible for capture | Use an eligible device owned by the current principal |
| `baseline_source_running` | 409 | The host has not confirmed the source device stopped | Wait until its host reports the device stopped |
| `baseline_source_unsupported` | 409, receipt | The source device does not support a baseline capture | Choose a stopped Android emulator that supports capture |
| `baseline_stale` | 409 | The baseline refers to a different installed system image | Capture a new baseline for the installed image |
| `warm_pool_device` | 409 | An ordinary device action targeted storage owned by the warm pool | Use the pool controls to manage the warm target |
| `warm_pool_disabled` | 409 | The operator has not enabled warm devices on this host | Select an opted-in Android lease host |
| `warm_target_ineligible` | 409 | The host does not advertise the pinned image for Android leases | Choose a lease image advertised by the host |
| `warm_target_limit` | 409 | The requested warm targets exceed the host's device bound | Reduce the target count to fit the host limit |
| `error` | receipt | The native upkeep command ended without a conclusive result | Inspect the host before another mutation |
| `expired` | receipt | The operation's start window elapsed before dispatch or execution | Submit a new operation if it is still needed |
| `host_inspection_required` | 409 | A recent successful inspection is required for the requested upkeep change | Inspect the host and resolve any uncertain change first |
| `host_operation_busy` | 409 | An install, removal or purge already holds this host and platform | Wait for the active operation to end |
| `host_pressure` | 503 | Eligible hosts report pressure and their operators enabled admission gating | Wait for pressure to clear or choose an eligible host |
| `host_pressure_unknown` | 503 | An opted-in host has an unreadable or stale pressure sample | Check the host report or wait for a fresh sample |
| `installer_failed` | receipt | The installer failed and the requested runtime is still unavailable | Inspect the runtime inventory before requesting another install |
| `interrupted` | receipt | The upkeep command lost authorization before producing a confirmed outcome | Inspect the host and settle the receipt before making another change |
| `invalid_identifier` | receipt | The host refused an unsupported runtime or image identifier | Select a runtime from the host inventory |
| `inventory_incomplete` | receipt | The host could not complete its storage ownership inventory | Inspect again before authorizing a purge |
| `inventory_unavailable` | receipt | The host could not read the runtime inventory from its platform tools | Check the platform tools and run another inventory |
| `license_acknowledgement_required` | 400, receipt | The requested Android install did not acknowledge the SDK licences | Accept the licences in the install request before submitting it |
| `license_not_accepted` | receipt | The Android installer reported that its licence check failed | Inspect the SDK licence state before requesting another install |
| `not_removable` | receipt | The platform tool or inventory did not identify a removable runtime | Inspect the runtime before deciding whether to remove it |
| `not_verified` | receipt | The host could not verify that installation or removal took effect | Inspect the inventory and settle the original operation first |
| `orphan_refused` | receipt | The host could not prove the named orphan was eligible for deletion | Inspect the remaining entry and its ownership evidence |
| `outcome_unknown` | receipt | The host reported no confirmed result before its deadline | Inspect and settle it before making another change |
| `runtime_in_use` | 409, receipt | A template, lease, device or retained storage still depends on the runtime | Clear the runtime's references before requesting removal |
| `storage_owner_exists` | 409 | Named storage still has a live owner or lacks proof of removability | Inspect current ownership and submit a new purge only after proof |
| `tool_unavailable` | receipt | A required platform tool was unavailable or could not start | Check the host's tool configuration before retrying |
| `unauthorized` | receipt | Host upkeep lost authority before it could finish safely | Inspect the existing receipt before retrying work |
| `uninstall_failed` | receipt | The uninstaller failed and the runtime remains installed | Inspect the runtime and its users before another removal |
| `unsupported` | receipt | The host does not support the requested upkeep operation | Choose a host and platform with that capability |
| `update_fenced` | receipt | A pending host update prevented the runner from starting upkeep | Wait for the update and confirm host readiness before retrying |
| `upkeep_unsupported` | 409, receipt | The host does not offer runtime or storage upkeep for this platform | Choose a host with the required upkeep capability |
| `capture_cleanup_pending` | 409 | A prior live capture or recording has ended and its stop proof is still pending | Wait for the host to report cleanup before requesting another capture |
| `capture_cleanup_unproven` | 409 | The prior capture's stop proof is missing after the reporting deadline, or its cleanup was abandoned | Resolve the device or lease cleanup before requesting another capture |
| `live_view_limit` | 429 | A device, host or credential reached its viewer limit, or the device reached its limit for retained view records | Wait for a view to close or a retained record to expire, then retry after `Retry-After` |
| `tunnel_cancelled` | client | The caller cancelled the tunnel before attaching its peer | Inspect the tunnel receipt if a create request was sent |
| `tunnel_ended` | 410, client | The tunnel identity already attached or reached a terminal state | Use a new UUID when opening another tunnel |
| `tunnel_host_limit` | 429 | The host reached its limit for retained lease tunnels | Wait for active tunnels and pending mapping removals to settle |
| `tunnel_identity_limit` | 429 | The lease reached its rolling hourly tunnel identity limit | Wait for an older identity to leave the rate window |
| `tunnel_limit` | 429 | The application has no free tunnel slot for this lease | Close an active tunnel or wait for one to end |
| `tunnel_listen_failed` | client | The local listener could not bind and the tunnel closed | Check the local address and use a new tunnel UUID |
| `tunnel_mapping_failed` | 409 | The runner could not create the requested device port mapping | Check the device port and inspect the original mapping receipt |
| `tunnel_mapping_lost` | 410 | The device port mapping disappeared while the tunnel was open | Inspect the ended tunnel and use a new UUID when reopening |
| `tunnel_port_busy` | 409 | The lease already holds that device port and direction | Wait for removal proof or choose another device port |
| `tunnel_residue_limit` | 429 | Too many ended tunnels still lack mapping removal proof | Wait for the host to confirm the pending removals |
| `tunnels_not_permitted` | 403 | The application policy grants no port tunnels to this lease | Use an application with an explicit tunnel allowance |
| `host_draining` | 409 | Admission is closed on the host by a drain, maintenance or an update | Later. A waiting request stays queued until admission reopens |
| `maintenance_blocked` | 409 | A maintenance drain cannot be resumed; the reply lists the blockers | After resolving the listed resume blockers |
| `session_disconnected` | 410, client | The session's stream ended; unconfirmed input was not applied on reconnect | Open a new session with a new UUID; do not replay input |
| `session_incomplete` | receipt, client | A session reply did not arrive or native capture ended early; the result is incomplete | Inspect the original receipt before another action |
| `session_protocol_error` | client | The peer sent a frame outside the session protocol | No. Close the session and report the mismatch |
| `chunk_too_large` | 413 | A transfer body exceeds 128 KiB, or one decoded chunk exceeds 64 KiB | No. Send smaller chunks |
| `download_destination_exists` | 409 | The download destination exists and replacement was not requested | Only with an explicit replace policy |
| `upload_publication_uncertain` | 409 | A durable upload may have been published but was not confirmed | No. Inspect the destination before retrying |
| `transfer_helper_invalid` | 400 | The Android transfer helper failed its manifest, architecture, API level or checksum check | No. Install a matching helper |
| `upload_temporary_cleanup_failed` | 409 | An owned temporary file of an upload could not be cleaned up before anything was published | No. Inspect and remove the temporary file |
| `operation_incomplete` | 409 | A guest request ended without a confirmed result and without a more specific code | No. Inspect the guest; the request is never replayed |

## Linux workspace transfers

| Code | Status | Meaning | Retry |
| --- | --- | --- | --- |
| `files_not_ready` | 409 | The workspace's file channel is not ready, so a new transfer cannot start | Yes, once the lease reports its files capability ready |
| `transfer_busy` | 429 | The assignment already has a transfer that is not finished | Yes, after the current transfer ends |
| `transfer_backpressure` | 503 | The controller's transfer spool is full | Yes, after pending steps are acknowledged |
| `step_pending` | 409 | The previous step of this transfer has not been acknowledged yet | Yes, after inspecting that step |
| `invalid_cursor` | 400 | A step number, offset or length is out of range or out of order | No. Continue from the transfer's current cursor |
| `invalid_path` | 400 | The workspace path is empty, too long, not normalised or reserved | No. Use a relative path inside the workspace |
| `digest_mismatch` | 400 | The bytes transferred do not match the declared SHA-256 | No. Start a new transfer with the correct digest |
| `idempotency_conflict` | 409 | A runner poll reused its UUID for a different assignment, boot or bundle | No. The runner must replay the identical poll |
| `chunk_evicted` | 410 | The data of a finished step is no longer held by the controller | No. Its receipt remains; the bytes cannot be read again |
| `authorization_lost` | receipt | A transfer failed because its lease ended or its key was rotated | No. Start a new transfer under a current lease key |
| `data_channel_lost` | receipt | A transfer failed because the workspace's file channel was lost within one boot | No. The files cannot be recovered in that boot |
| `controller_restarted` | receipt | A step that was waiting for dispatch was failed when the controller restarted | Inspect the transfer, then start a new one |
| `deadline` | receipt | A step passed its deadline or the lease authorisation expired first | Inspect the transfer, then start a new one |

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
| `usage_range_too_large` | 400 | The range holds more requests and leases than one report may read | No. Ask for a shorter range and add the reports up |
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
| `invalid_credential` | 401, client | The credential is not an opaque token of the expected shape; a transfer route answers 401 with it for a malformed key | No. Load the right credential |
| `invalid_ca` | client | The CA file or bundle could not be read or is not valid PEM | No. Supply a valid bundle |
| `connection_failed` | client | The connection failed or the reply was interrupted; a mutation's outcome is unknown | Reads yes. Inspect before repeating a mutation |
| `timeout` | client | No complete reply arrived within the client's time limit; a mutation's outcome is unknown | Reads yes. Inspect before repeating a mutation |
| `tls_verification_failed` | client | The controller certificate was not accepted; no request was sent | No. Fix the certificate or the CA bundle |
| `redirect_refused` | client | The controller answered with a redirect, which the client never follows | No. Use the controller's own origin |
| `response_too_large` | client | The reply exceeds the client's response size limit | No. Raise the limit or page the request |
| `content_type_invalid` | client | The reply is not JSON, or not an event stream where one was requested | No. Check that the origin is a controller |
| `response_invalid` | 502, client | A reply did not match the contract; the dashboard gateway returns 502 for it | No. Inspect state; a mutation's outcome is unknown |
| `session_upgrade_refused` | client | The controller refused the session WebSocket upgrade | No. Check the session identity and lease state |
| `events_truncated` | client | A followed event stream reported that retention removed history after the resume cursor, and no `onTruncated` handler accepted the gap | Follow again with `onTruncated`, or list from the oldest retained event |
| `capture_cancelled` | client | A display capture was cancelled; any recording output is incomplete | Start a new capture |
| `recording_incomplete` | client | A recording exceeded its byte budget or timed out; its output is incomplete | Start a new recording with a larger budget |
| `video_incomplete` | client | A video operation was cancelled or timed out; completion is unconfirmed | Inspect the video session before reopening |
| `download_publication_uncertain` | 409, client | A downloaded file may have been published at its destination but was not confirmed | No. Inspect the destination |
| `download_temporary_cleanup_failed` | 409, client | A private temporary file of a download could not be created or removed | No. Inspect and remove the temporary file |
| `download_destination_failed` | client | A download failed before publication; the destination was not replaced | Yes, as a new download |

## What the test checks

The test reads every `.ts` file under `coordination/src` with the TypeScript parser, so
line breaks, punctuation inside a message and argument order make no difference. It
treats these as places where a code is written:

- the value of a property named `code`, including `x.code = …`, and the literal types
  or default of a field or parameter named `code`;
- a constructor argument bound to a parameter named `code`, for a class declared in
  the same file or imported by name, including an inherited constructor;
- an argument of a helper function whose parameter ends up in one of those places,
  directly or through another helper, when the helper is declared in the same file or
  imported by name;
- the status-derived defaults in `errors.ts`.

From there it follows string literals, both branches of `?:`, `??` and `||`,
constants declared in the same file and tables indexed in place. A template literal
must have its possible codes declared in the test. A value read from another error,
such as `known.code`, forwards a code written elsewhere and adds nothing. Any other
expression in one of those places fails the test until it is resolved or acknowledged
there with a reason, so a place the test cannot read is never skipped silently.

The test does not catch:

- a code that first appears somewhere else, for example in a `reason` field that
  later code copies into `code`. One such case is known and declared by hand
  (`data_channel_lost`);
- a helper reached as a method on an object that another file created;
- a code received at run time from a guest, a runner or a native helper and passed
  on unchanged;
- anything outside `coordination/src`: the Rust crates, the Swift and C bridges and
  the dashboard;
- the meaning and status written on this page. The test checks that each row has a
  status, a meaning and retry guidance, not that they are correct.

The two files that hold the doctor's finding codes are read against
[doctor](doctor.md) instead, and the event stream's end codes against
[events](events.md).
