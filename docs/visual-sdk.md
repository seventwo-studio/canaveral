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

## Native MP4 video

`MobileVideoClient` opens a separate, view-only administrative stream through the
outbound broker. It uses a personal API token with `machines:access` and checks
machine ownership; it does not enable consumer lease execution. The host needs
its native capture tools and an operator-configured absolute `ffmpeg` path with
the `libx264` encoder. No tools are downloaded or installed by a video request.

```ts
import { MobileVideoClient } from 'canaveral-machines/video-sdk';

const api = new MobileVideoClient({
  baseUrl: 'https://canaveral.example.internal',
  credential: personalToken,
});
const session = await api.create(machineId, {
  id: persistedSessionId, fps: 30, durationSeconds: 30, bitRate: 4_000_000,
});
const video = await api.connect(session, { signal, maxBytes: 64 * 1024 * 1024 });
try {
  const receipt = await video.record(writer);
  // Publish the caller-owned MP4 only after this returns successfully.
} finally {
  video.close();
}
```

The writer implements `write(bytes): number | Promise<number>` and may accept
partial writes. `record()` writes the same MP4 bytes received from the host,
checks their SHA-256 digest and complete MP4 box envelope, and acknowledges the
host's completion. The receipt contains `bytes`, `sha256` and `cleaned: true`.
The sink remains caller-owned: the SDK does not flush, close or atomically publish
it. A failed, cancelled or interrupted call leaves an incomplete artifact.

### Recording a leased emulator with its lease key

`LeaseVideoClient` (also `LeaseClient.video` in `coordination/src/sdk.ts`) records the
lease's own Android emulator with the lease's current key, for CI and marketing capture.
It uses the same broker protocol, verification and receipt as `MobileVideoClient`, at
`/v1/leases/{lease}/video-sessions`. See
[lease recording and large installs](mobile-control.md#lease-recording-and-large-installs).
An iOS simulator lease refuses recording with `capability_unsupported`; see
[iOS scoped control](mobile-control.md#ios-scoped-control).

```ts
const lease = new LeaseClient({ baseUrl, leaseId, leaseKey });
const receipt = await lease.video.record(
  { id: persistedSessionId, member: 'primary', fps: 30, durationSeconds: 30, bitRate: 4_000_000 },
  writer, { timeoutMs: 60_000 },
);
```

`record` creates the session (or replays the same persisted intent), attaches and writes
the verified MP4. `create`, `connect`, `inspect` and `close` are also available. The
session ends with the lease: expiry, release, a fence, supervisor loss or key rotation
ends the stream without a finish receipt. Android emits no frames while the screen is
static, so set `timeoutMs` above the longest expected static stretch. Another lease's
key, the application key and administrative credentials are refused.

For live playback, `video.chunks()` is a pull-driven async iterator of MP4 byte
chunks; boundaries are neither decoded frames nor complete MP4 boxes. Feed them
to an appropriate fragmented-MP4 player or decoder with backpressure. Initialization
precedes media fragments, and the stream identifies its codec family as `avc1`.
A browser MediaSource adapter must inspect the initialization segment for the
full codec profile it needs. Consuming one stream twice is rejected. The SDK
captures no input ownership; use existing device actions or display controls
while viewing video.

Sources produce native H.264 from Android `screenrecord` or iOS `idb video-stream`,
rather than polling screenshots. Android raw output lacks capture timestamps,
so the encoder assigns wall-clock input timestamps and re-encodes to a target
30 fps. It uses one decoder thread, one filter thread and one encoder thread,
an even-sized aspect-preserving output of at most 1280 pixels on either edge,
and no audio. The encoder creates
[fragmented MP4](https://ffmpeg.org/ffmpeg-formats.html#mov_002c-mp4_002c-ismv)
with an initial movie header, a one-second keyframe interval and a target fragment
duration of 250 ms. These are encoding targets; native frame cadence, latency,
decoder interoperability and resource use require live acceptance.

Requests require `fps: 30`, `durationSeconds` from 1 to 180 and `bitRate` from
100000 to 20000000. The encoded stream is capped at 512 MiB, and each wire chunk
is at most 64 KiB. The SDK's byte budget can be smaller; read and sink-write
timeouts default to 30 seconds. Both sides apply backpressure. Native sources own
finite termination; an additional ten-second exit grace ends in failure if they
cannot stop. Positive source/encoder completion and cleanup are required before
the host reports a complete recording. After an Android cancellation the runner
stops and confirms the exact guest recorder it started; when that cannot be proven,
for example on an unreachable device, the session keeps its reservation for
inspection. See [Android recorder cleanup](mobile-control.md#android-recorder-cleanup-after-early-cancellation).

Each session is a single capture attempt. Disconnects never reconnect or roll
over to a new capture automatically. Persist the UUID before creation, inspect
that session after uncertainty, and use a new explicit session for another clip.
Portable fixtures check transport, byte preservation, envelopes, process exit
handling and recovery; they do not establish a working native 30 fps recording.

## Sampled PNG frames and APNG recordings

`display.frames({ intervalMs, timeoutMs, signal })` returns a pull-driven async
iterator of complete PNG frames. Each value contains `index` (starting at zero),
`timestampMs` (monotonic elapsed time when capture completes), `width`, `height`
and `png`. The default interval is 250 ms; accepted intervals are 1–60000 ms.
Each frame has its own 30-second default timeout. A slow consumer delays the next
capture: the SDK keeps no background frame queue. Frames may change dimensions
after rotation. Frame capture needs no input ownership, and callers can send
actions between captures on the same display.

The simulator adapter requires TightPNG and currently captures at most four
frames per second. Use the packaged PNG decoder when opening its display:

```ts
import { decodePng } from 'canaveral-machines/visual-sdk';

const display = await lease.display(sessionId, 'primary', {
  decodeImage: (bytes, format, width, height, budget) => {
    if (format !== 'PNG') throw new Error('Expected simulator PNG frames');
    return decodePng(bytes, width, height, budget);
  },
});
try {
  for await (const frame of display.frames({ intervalMs: 250, signal })) {
    await consumeScreen(frame.png);
  }
} finally {
  display.close();
}
```

`display.record(writer, { frameCount, intervalMs, timeoutMs, signal, maxBytes })`
streams an [animated PNG](https://www.w3.org/TR/png-3/#animation-information)
(`image/apng`) to a caller-owned writer. The writer's
`write(bytes)` returns the number of bytes accepted, synchronously or through a
promise; partial writes are supported. The SDK awaits each write before requesting
another screen, writes chunks of at most 64 KiB, and keeps only a bounded number
of frames in memory. It uses no external encoder. The exact `frameCount` is
required by the APNG header and must be 1–10000. `maxBytes` defaults to 256 MiB
and may be at most 1 GiB. Each sink write uses the selected `timeoutMs`.

For example, `await display.record(writer, { frameCount: 120, intervalMs: 250 })`
produces a 30-second APNG playback with 120 sampled screens. Its playback uses the
requested interval; capture or sink delays can make wall-clock recording slower.
The return value contains `mediaType`, `frames`, `bytes`, `width`, `height` and
the playback `durationMs`. This is sampled screen animation, with no audio or
MP4 encoding. Native video and low-latency streaming remain separate work.

Rotation during recording fails rather than stretching frames or producing a
misleading complete artifact. Cancellation, disconnection, byte-budget exhaustion,
writer failure or timeout also leave incomplete output; discard it unless the
method returns successfully. The SDK does not close or publish the caller's
writer. A write already handed to an external sink may finish after cancellation
or timeout; that never authorizes treating the output as complete.

Breaking out of a frame iterator leaves the display available. Aborting while a
capture is pending closes the display to interrupt its read; cancellation during
the cadence wait or a writer call leaves the display open. Already-aborted signals
cause no capture. Capture never reconnects, renews a lease or acquires input.
These SDK methods do not enable live consumer placement: ordinary runners retain
the [native acceptance gate](lease-eligibility.md).

## Input and recovery

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
