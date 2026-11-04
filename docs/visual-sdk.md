# Python display SDK

`LeaseClient.display(request_id, member='primary')` opens a scoped display session
through the controller relay and returns a context-managed `DisplayClient`. It
does not renew the lease, acquire a machine or fall back to operator credentials.
Ordinary live runners still reject consumer lease execution; this SDK has fixture
coverage, not cross-network or native-platform acceptance.

Install the optional decoder on the consuming application from this checkout:

```sh
python3 -m pip install '.[visual]'
```

The controller and other SDK methods do not require Pillow. A missing extra or
invalid display options fail before creating a session. `timeout` defaults to 30
seconds for peer-readiness, RFB initialization and method response waits;
connection setup and blocked writes retain the transport's own bounded timeouts.
`max_frame_bytes` defaults to
64 MiB of decoded RGBA-equivalent pixels and is caller-configurable; it is a
client decode budget, not a machine resolution policy or a total-process RSS cap.

```python
with lease.display(session_request_id, 'primary') as display:
    png = display.screenshot()
    # Viewing is independent of input ownership.
    if display.take_control() == 'owned':
        result = display.action(action_id, 'text', {'text': 'Hello'})
        display.release_control()
```

`screenshot()` returns a complete PNG. The client assembles raw and TightPNG image,
JPEG or fill rectangles and handles DesktopSize changes in one coordinate space.
It tracks missing pixels and refuses partial captures, malformed rectangles,
inconsistent image dimensions and unsupported encodings. Raw frames use a
negotiated RGBX pixel format. The protocol follows
[RFB 3.8](https://www.rfc-editor.org/rfc/rfc6143.html); optional image decoding uses
[Pillow](https://pillow.readthedocs.io/en/stable/reference/Image.html).

`take_control()` and `release_control()` return the runner's ownership state:
`owned`, `busy`, `view-only`, `reset-uncertain`, `stale` or `not-ready`.
`key(keysym, down=True)` sends a 32-bit RFB keysym. `pointer(x, y, buttons=0)`
sends display-pixel coordinates and a button mask. Hold/release keys and buttons
explicitly, or use `press_key(keysym)` and `click(x, y, button=1)` for a paired
press/release. These calls confirm transport dispatch, not guest execution; they
have no durable per-input receipt. Only an owning viewer may send them, and the
runner independently enforces ownership. Unsupported simulator keys remain
unsupported; the SDK does not invent input fidelity.

`action(request_id, action, arguments)` uses the existing provider-supported input
action envelope and returns its durable `action-result`. Persist the UUID before
dispatch. `receipt(request_id)` performs a read-only lookup, including while
view-only. Unknown action outcomes locally disable further input until ownership
is resolved. A timeout or disconnect closes the client and never replays input;
errors preserve the action UUID in `Error.request_id` when available. Open a new
session to inspect the original receipt rather than inventing a replacement action.
Missing receipts remain unknown and do not prove an action never executed.

An interrupted receipt request exposes `Error.outcome='unknown'` and
`retryable=False`, including a timeout or a socket failure during dispatch.
Existing typed error codes are preserved; an untyped socket/EOF failure becomes
`session_incomplete` with a fixed public message. This records missing completion
evidence rather than undoing guest effects. The client closes the interrupted
connection. A new session can call `receipt(original_action_id)` while view-only;
that lookup sends no input and does not require taking ownership.

Each client serializes method calls around one protocol reader. `close()` closes
the connection without renewing/releasing the lease. The runner handles owned-input
reset on disconnect; the SDK does not claim that a native RFB reset was executed
inside the guest. [Scoped native accessibility](scoped-accessibility.md) is available
through `LeaseClient.accessibility()` without the image extra. Its snapshot/node
IDs can be used by `accessibility-action` on the inspected member. Full public API
schemas and live platform acceptance remain open.

The internal macOS helper now has a common RFB adapter and injected
[provider access binding](macos-guest-access.md). Broker/SDK fixtures exercise
PNG decoding, full held key/button edges, two viewers, ordered semantic actions,
durable receipt lookup and expiry using fake native responses. This does not
establish a production macOS connection or consumer image eligibility.

The [display example](../examples/lease_display.py) uses an existing private
lease-scoped key and captures an existing lease,
optionally sends an explicitly requested text action or inspects an uncertain
receipt. It requires caller-provided session/action UUIDs, creates a new output
file and prints no credentials. It does not rotate keys or revoke other sessions.
`python -m examples.lease_display --help` is safe
without a runner; the example has not been run against a live leased machine.
An unknown or failed action prints its state and exits nonzero.

Tests pair the real broker and SDK with a synthetic simulator display, check two
viewers competing for ownership, capture/resize, key/pointer dispatch, action
deduplication/read-only lookup and lease expiry. Decoder fixtures include raw,
PNG, JPEG and fill frames, missing pixels, malformed dimensions, budget rejection
and uncertain actions. Simulator demand requests capture current provider pixels
rather than reusing the handshake image; a fixture checks the first capture after
an action. No real simulator or VM is controlled by those fixtures.
An acknowledgement-loss fixture drops a successful action result after provider
completion, then opens a new view-only session and reads the original durable
receipt. It verifies that the provider received the text action exactly once.
This is isolated protocol recovery evidence, not native crash or lease-expiry
acceptance.
