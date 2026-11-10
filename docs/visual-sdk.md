# TypeScript display SDK

`coordination/src/visual-sdk.ts` implements the scoped display client exposed by
`LeaseClient.display(requestId, member, options)` in `coordination/src/sdk.ts`.
It uses the existing lease key and controller relay. It neither acquires a machine
nor renews a lease or falls back to operator credentials. Persist session and action
UUIDs before dispatch. Provider binding and native acceptance remain separate gates.

```ts
const display = await lease.display(sessionId, "primary", { timeoutMs: 30_000 });
try {
  const png = await display.screenshot();
  if (await display.takeControl() === "owned") {
    const result = await display.action(actionId, "text", { text: "Hello" });
    await display.releaseControl();
  }
} finally {
  display.close();
}
```

A display opens view-only. Capturing pixels does not require input ownership.
The client must obtain an explicit runner ownership acknowledgement before sending
keys, pointers or semantic actions. The ownership states include `owned`, `busy`,
`view-only`, `reset-uncertain`, `stale` and `not-ready`. The runner independently
checks ownership; a local client flag cannot grant authority.

The wire is RFB 3.8 over binary session messages. WebSocket boundaries are not
rectangle boundaries. A screenshot must contain a complete frame; missing pixels,
malformed dimensions, unsupported encodings and decode-budget excess must fail
rather than produce a partial PNG. Raw rectangles and DesktopSize are supported by default. TightPNG/JPEG decoding
is negotiated only when callers supply a bounded `decodeImage` callback through
`DisplayOptions`; the SDK does not install or assume an external image codec. A
provider offering only TightPNG requires that explicit decoder. `maxFrameBytes`
defaults to 64 MiB of RGBA-equivalent pixels and `timeoutMs` to 30,000 milliseconds.
A decode budget limits client allocation, not guest resolution policy or total
process memory.

Raw key/pointer methods acknowledge dispatch only. They have no durable per-input
receipt and must never replay automatically after disconnect. Unsupported simulator
keys, Unicode or gestures remain unsupported. Coordinates are provider-specific;
input translation must validate current scale and geometry before dispatch.

Discrete `action(requestId, action, arguments)` uses a caller-owned UUID and the
provider-supported action envelope. `receipt(requestId)` is read-only and may run
while view-only. After timeout, disconnect or an unknown action result, stop input
and inspect that original receipt from a new view-only session. Missing receipts
do not prove that nothing executed. A new action UUID can create a second effect.

Interrupted receipt lookup also preserves uncertainty. Untyped transport failures
become fixed diagnostic errors; they must not expose provider text or credentials.
Closing a display releases its attachment without renewing or releasing the lease.
The runner attempts to reset held native input. A lost reset acknowledgement blocks
ownership handover until positive recovery; local close is not native reset proof.

[Native accessibility](scoped-accessibility.md) is read-only and requires no image
decoder. An inspected snapshot/node may be used for `accessibility-action` only
with current input ownership and provider revalidation of identity, freshness and
bounds. No production provider binding is inferred from a schema-valid snapshot.

Portable coverage must include complete frame capture/resize, unsupported codec
refusal, malformed rectangles, budget checks, competing viewers, held input,
discrete-action deduplication and lost-acknowledgement receipt recovery. These
cases do not establish native RFB interoperability, process cleanup, lease expiry
or cross-network acceptance. See [outbound access](access-transport.md) and
[recovery](client-recovery.md).
