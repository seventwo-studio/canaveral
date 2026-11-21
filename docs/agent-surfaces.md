# Agent surfaces: MCP server, held leases and onboarding

Implementation contract, 21 November 2026. Coding agents and CI jobs reach leased
devices through three surfaces built on the [consumer SDK](consumer-sdk.md): an MCP
server (`canaveral mcp`), a CLI lease that is held and renewed in the foreground
(`canaveral lease hold`) with lease-key commands beside it, and shipped rules for agents
(`canaveral instructions`, `canaveral setup`). They add no controller route. Every call
goes through the existing [request](requests.md), [lease](leases.md) and
[operation](consumer-operations.md) contracts.

Status and limits:

- Only [Android emulator leases](mobile-control.md#android-emulator-leases) execute. iOS
  simulator leases are still refused by the controller, so a request for an iOS template
  waits until its deadline.
- Portable fixtures drive these surfaces against a real loopback controller and a
  scripted host. No MCP client product, GitHub Actions run or real emulator has exercised
  them. Nothing here is native acceptance.
- A process that is killed cannot release. Its waiting request ends at the request
  deadline and its lease ends at the TTL.

## Credentials and transport

| Command | Credential | Source |
| --- | --- | --- |
| `mcp`, `lease hold`, `requests` | Application key | `--token-file` or `CANAVERAL_TOKEN_FILE` |
| `lease ID device`, `operation`, `install` | That lease's key | `--lease-key-file` or `CANAVERAL_LEASE_KEY_FILE` |

A credential is read from a regular file that the caller owns with mode 0600. No command
accepts a secret as an argument, prints one, or writes one into a snippet. The MCP server
exchanges the application key for each lease's key and keeps it in memory only.
`lease hold --lease-key-file FILE` saves the key to a new private file and never replaces
an existing one.

`mcp`, `lease hold` and the lease-key commands use the SDK transport: HTTPS with chain and
hostname verification, or plain HTTP to a loopback IP literal such as `127.0.0.1`.
`--allow-http` does not apply to them. `--ca-file FILE` replaces the trust store. The CLI
commands print the controller's stable error code and HTTP status, never its free text.
An MCP tool error also carries the controller's message, which the SDK bounds to 500
characters and strips of the credential. `requests` uses the same client as `leases`.

## What the session does for the caller

The SDK never polls, retries or renews. `canaveral mcp` and `canaveral lease hold` share
one layer (`coordination/src/agent-session.ts`) that does, under these rules.

**Request.** Each lease is one durable `kind: "lease"` [request](requests.md) under a
stable UUID, which becomes the lease UUID. The caller may supply it (`requestId`,
`--request-id`); otherwise it is generated before anything is sent. A supplied UUID that
already names an own request is adopted instead of submitted again, so a caller can
resume after a lost reply. The request carries a `deadline` (`waitSeconds`, `--wait`,
default 600 seconds) and a `source` object that tags its origin. The deadline is set from
the local clock, so a badly skewed clock shortens or lengthens the wait.

**Template.** The template id is enough when the application may lease exactly one
revision and architecture of it. Otherwise the revision and architecture are required.
Only device templates (Android, iOS) are offered here; a Linux workspace box is a
different request kind.

**Wait.** The session reads the request until it is admitted, then the lease until it is
`ready`. It reports `queued` (with the queue `position` when the request view carries
one, and the controller's reason) and `booting`. When the wait ends without a ready
device for any reason (deadline, rejection, failed boot, cancellation, an error), the
session cancels the request. Cancelling a waiting request withdraws it; cancelling an
admitted one releases its lease.

**Renewal.** The TTL runs from admission, through the boot, so the session renews from
admission on. It renews when about a third of the TTL remains
([renew early](mobile-control.md#expiry-release-and-loss)), with the same TTL. It also
reads each held lease at least every 30 seconds.

- The TTL must fit the application's `maxTTLSeconds`. A larger one is refused before
  anything is submitted.
- A renewal that the controller caps at `maxLifetimeSeconds` is the last one. The session
  stops renewing and says when the lease ends.
- A renewal whose reply is lost is sent again with the identical mutation UUID, revision
  and TTL until its receipt arrives. A changed revision is read and then renewed.
- The remaining time is measured on the monotonic clock from the last admission or
  renewal the session observed, so a wrong wall clock cannot delay a renewal. An adopted
  request has no such observation yet and is renewed at once.
- Use a TTL of at least a minute. A third of a shorter TTL leaves little room for the
  host's heartbeat.

**Release.** The session releases through `POST /v1/requests/{id}/cancel`, which is
idempotent and covers a waiting request as well as an admitted lease. Renewal stops
first. If the release cannot be confirmed, renewal stays stopped and the lease ends at
its TTL. Release revokes access at once; the host's cleanup and the return of its
reservation follow the [lease contract](leases.md).

**Unknown.** A device action is one durable [operation](consumer-operations.md) under
its own UUID. It is submitted once. After that the session only reads its receipt.

- A receipt `unknown` is reported as unknown. Nothing replays it.
- A submission whose reply was lost is read by its UUID. If it cannot be read either, the
  outcome is reported as unknown with the UUID.
- Sending the identical UUID, action and arguments again returns the stored receipt and
  never runs the action twice. That is the caller's explicit choice, never automatic.
- An `unknown` install keeps its upload until the lease's cleanup and is not repeated.

## `canaveral mcp`

```sh
CANAVERAL_URL=https://canaveral.example.internal CANAVERAL_TOKEN_FILE=/abs/application.key canaveral mcp
```

A Model Context Protocol server over stdio, written against JSON-RPC 2.0 without an SDK.
One process is one session for one application key. stdout carries protocol messages
only, one JSON object per line; diagnostics go to stderr.

| Supported | Notes |
| --- | --- |
| `initialize`, `ping` | Protocol versions 2024-11-05, 2025-03-26, 2025-06-18 and 2025-11-25. Another version is answered with 2025-06-18. |
| `tools/list`, `tools/call` | Tool mistakes are tool results with `isError`; an unknown tool is a protocol error. |
| `notifications/cancelled` | Aborts the call. A cancelled call sends no reply. |
| `notifications/progress` | Sent when the call carries a `progressToken`: on every change, and at least every 10 seconds while waiting. |
| `notifications/message`, `logging/setLevel` | Lease notices, from level `info`. |
| `resources/list`, `resources/read` | One resource, `canaveral://instructions`: the [rules](#agent-onboarding). |

Not supported: JSON-RPC batches, prompts, sampling, resource subscriptions and the HTTP
transports. A line over 4 MiB is refused.

| Tool | Does |
| --- | --- |
| `list_device_templates` | Device templates the application may lease, with capabilities, `available` (an eligible host is online) and the application's limits. |
| `lease_device` | Submits the request, waits with progress, exchanges the lease key, starts renewing and returns the lease. Arguments: `templateId`, and optionally `templateRevision`, `arch`, `ttlSeconds`, `name`, `priority`, `waitSeconds`, `requestId`, `source`. |
| `lease_status` | The controller's current view of the held leases, the requests still waiting and the leases that ended. |
| `device_action` | One action through the lease key: `screenshot`, `hierarchy`, `accessibility`, `tap`, `swipe`, `text`, `key`, `apps`, `launch`, `terminate`, `uninstall`, `open-url`, `logs`, `shell`. Refused locally when the lease lacks the capability. Optional `operationId` and `waitSeconds` (default 120). |
| `install_app` | Uploads one APK from a local path through the [uploaded-app path](mobile-control.md#lease-recording-and-large-installs), installs it and releases the upload after a cleaned install. Optional `artifactId`, `installId`, `waitSeconds` (default 600). |
| `release_device` | Releases a held lease. |

`leaseId` may be omitted while the session holds exactly one lease. A screenshot is
returned as image content with a text summary. Other results are text, cut at 200,000
characters. Every action and install result names its `operationId`. A tool acts only on a lease this
session holds: another lease's UUID is refused locally as `lease_not_held`, and one that
ended as `lease_ended`.

Cancelling `lease_device` cancels its request, whether it was queued or already booting.
Cancelling `device_action` or `install_app` stops the wait only: the operation is already
recorded and may still run. No controller route cancels an operation. A client that gives
up on a call without cancelling it does not stop it either: the session finishes the
call, and `lease_status` shows a lease granted that way.

Lease notices are logging notifications from logger `canaveral`, with `data.event`:

| Event | Level | Meaning |
| --- | --- | --- |
| `lease_lifetime_reached` | warning | The last renewal was capped. `data.expiresAt` is final. |
| `lease_renewal_unconfirmed` | warning | A renewal reply was lost; the session is replaying it. |
| `lease_renewal_refused` | error | The controller refused renewal; the lease ends at `data.expiresAt`. |
| `lease_ended` | warning (info after `release_device`) | The lease ended as `data.state`. Its device is no longer the session's. |
| `credential_refused` | error | The application key was refused. |

Clients often keep notifications from the model, so every tool also answers for an ended
lease with `lease_ended`, and `lease_status` lists it.

The session ends when stdin closes or on SIGINT, SIGTERM or SIGHUP. It aborts the calls
in flight, withdraws their requests, releases every held lease and exits, with status 1
if a release could not be confirmed within 30 seconds.

## CLI

### `canaveral lease hold`

```sh
canaveral --url https://canaveral.example.internal --token-file ./application.key \
  lease hold --template phone --revision 1 --arch arm64 --ttl 600 --name ci-phone \
  --priority 0 --wait 900 --lease-key-file ./lease.key --bind-pid "$PID"
```

It leases as described above, prints one JSON grant line on stdout and then holds the
lease, renewing it. Progress and notices go to stderr. The grant has `leaseId`,
`requestId` (the same UUID), `state`, `revision`, `expiresAt`, `ttlSeconds`, `template`,
`capabilities`, `member`, `held` and, with `--lease-key-file`, `leaseKeyFile`.
`--source-file FILE` supplies the request's `source` object.

It releases the lease and exits when:

- it receives SIGINT, SIGTERM or SIGHUP;
- its parent process exits (Unix: it is re-parented);
- the `--bind-pid` process exits;
- the lease ends by itself, in which case nothing is left to release and the status is 1.

The parent and PID checks run twice a second. They cannot tell a recycled PID from the
original process, and a SIGKILL releases nothing. Stopped while still waiting, it cancels
the request and exits with status 1 and no grant line.

`--detach` prints the grant with `"held": false` and returns. Nothing renews that lease:
it ends at its TTL unless something renews or releases it.

### `canaveral requests`

`requests list [--after UUID]`, `requests show ID`, `requests submit --request-file FILE`
and `requests cancel ID` map to the four [request routes](requests.md). `cancel` is the
one command that ends a lease in any state: it withdraws a waiting request and releases
an admitted lease, and repeating it is safe.

### Lease-key commands

```sh
canaveral lease LEASE device tap --arguments-file tap.json            # one action
canaveral lease LEASE device screenshot --output screen.png
canaveral lease LEASE device --request-file saved-operation.json      # a persisted request
canaveral lease LEASE operation OPERATION [--wait 60] [--output FILE] # read a receipt
canaveral lease LEASE install app.apk [--request-id UUID --install-id UUID]
```

`device` accepts the lease contract's actions: those of `device_action` plus
`accessibility-action`, `list-files`, `push`, `pull` and `install-uploaded`. A missing
`--request-id` or `--install-id` is generated and written to stderr before use; pass your
own to be able to replay. `--request-file` holds exactly `id`, `member`, `action` and
`arguments`. `--wait SECONDS` bounds the wait for the receipt (default 120; 600 for
`install`; 0 for `operation`).

stdout carries receipt metadata only. Guest output can hold application data, so the
result is written to the new private file named by `--output`, or not at all
(`resultOmitted`). The exit status is 0 only for `succeeded`. `unknown` exits with 1 and
says so; nothing is sent again.

## Agent onboarding

`canaveral instructions` prints the canonical rules: lease before touching a device, hold
only what the task needs, keep the lease renewed, always release, never touch a device
you do not hold, and treat `unknown` as unknown. The same text is the MCP resource and
the body of the skill file (`canaveral instructions --skill`).

`canaveral setup [--agent claude|codex|all] [--project [--directory DIR]] [--force]`
writes that skill file:

| Agent | User scope | Project scope |
| --- | --- | --- |
| Claude Code | `~/.claude/skills/canaveral-devices/SKILL.md` | `DIR/.claude/skills/canaveral-devices/SKILL.md` |
| Codex | `~/.agents/skills/canaveral-devices/SKILL.md` | `DIR/.agents/skills/canaveral-devices/SKILL.md` |

An existing file is never replaced without `--force`; when any target exists, nothing at
all is written. It then prints the MCP registration as JSON for Claude Code and TOML for
Codex, naming the controller URL and the key file path. It registers nothing, reads no
credential and contacts no controller. The skill locations are those tools' conventions
at the time of writing and have not been checked against an installed client.

## CI recipe

A GitHub Actions job that leases an emulator, installs the build, drives it, records it
and always releases. It is an example: the commands are fixture-covered, the workflow has
not run on GitHub Actions.

```yaml
jobs:
  device:
    runs-on: ubuntu-24.04
    timeout-minutes: 30
    env:
      CANAVERAL_URL: https://canaveral.example.internal
      CANAVERAL_TOKEN_FILE: ${{ runner.temp }}/application.key
      CANAVERAL_LEASE_KEY_FILE: ${{ runner.temp }}/lease.key
    steps:
      # Check out, build the APK and install the canaveral CLI first.
      - name: Save the application key privately
        env:
          APPLICATION_KEY: ${{ secrets.CANAVERAL_APPLICATION_KEY }}
        run: |
          umask 077
          printf '%s\n' "$APPLICATION_KEY" > "$CANAVERAL_TOKEN_FILE"
      - name: Lease an emulator
        run: |
          LEASE_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
          echo "LEASE_ID=$LEASE_ID" >> "$GITHUB_ENV"
          printf '{"repository":"%s","run":"%s","attempt":"%s","commit":"%s"}\n' \
            "$GITHUB_REPOSITORY" "$GITHUB_RUN_ID" "$GITHUB_RUN_ATTEMPT" "$GITHUB_SHA" > "$RUNNER_TEMP/source.json"
          canaveral lease hold --template phone --ttl 1200 --wait 900 --request-id "$LEASE_ID" \
            --source-file "$RUNNER_TEMP/source.json" --lease-key-file "$CANAVERAL_LEASE_KEY_FILE" --detach
      - name: Install the build
        run: canaveral lease "$LEASE_ID" install app/build/outputs/apk/debug/app-debug.apk
      - name: Drive and record
        run: |
          node record.mjs "$LEASE_ID" "$RUNNER_TEMP/demo.mp4" &
          RECORDER=$!
          echo '{"app":"com.example.app/.MainActivity"}' > launch.json
          canaveral lease "$LEASE_ID" device launch --arguments-file launch.json
          echo '{"x":540,"y":1200}' > tap.json
          canaveral lease "$LEASE_ID" device tap --arguments-file tap.json
          canaveral lease "$LEASE_ID" device screenshot --output "$RUNNER_TEMP/home.png"
          wait "$RECORDER"
      - name: Release the emulator
        if: always()
        run: |
          if [ -n "${LEASE_ID:-}" ]; then canaveral requests cancel "$LEASE_ID"; fi
```

`record.mjs` records through the [video SDK](visual-sdk.md#recording-a-leased-emulator-with-its-lease-key);
there is no recording command or tool yet:

```js
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { LeaseClient } from "canaveral-machines/sdk";

const [leaseId, output] = process.argv.slice(2);
const lease = LeaseClient.fromCredentialFile({ baseUrl: process.env.CANAVERAL_URL, leaseId, credentialFile: process.env.CANAVERAL_LEASE_KEY_FILE });
const file = createWriteStream(output, { flags: "wx", mode: 0o600 });
const write = chunk => new Promise((resolve, reject) => file.write(chunk, error => error ? reject(error) : resolve(chunk.length)));
const receipt = await lease.video.record({ id: randomUUID(), member: "primary", fps: 30, durationSeconds: 10, bitRate: 4_000_000 }, { write }, { timeoutMs: 60_000 });
await new Promise(done => file.end(done));
console.log(JSON.stringify(receipt));
```

Notes:

- **Tag the run.** The request's `source` object (at most 4096 bytes) stores the
  repository, run, attempt and commit. It changes no behavior; `canaveral requests show`
  and `requests list` return it, so a lease can be traced to its run.
- **One UUID for everything.** The lease UUID is chosen before the lease step, so the
  always-run step can cancel it whether the lease step finished, was still waiting or
  failed halfway. A second cancel is harmless.
- **TTL.** `--detach` holds nothing, so the TTL must cover the job and fit the
  application's `maxTTLSeconds`. For a longer job, start `canaveral lease hold` without
  `--detach` in the background, wait for its grant line and stop it in the always-run
  step; it renews until then. `--bind-pid` ties it to any process that lives as long as
  the job.
- **Cancelled or crashed jobs.** An always-run step does not run when the runner itself
  is lost. The lease then ends at its TTL.
- **Unknown.** A step that exits with `outcome=unknown` must not be retried blindly; see
  [uncertain installation](mobile-control.md#storage-and-uncertain-installation).
- **No guest network.** The app under test cannot reach a backend
  ([guest network isolation](mobile-control.md#guest-network-isolation)).

## Verification and limits

`coordination/test/control/agent-mcp.test.ts` drives `canaveral mcp` over its stdio pipes
and `agent-cli.test.ts` runs the CLI, both against a real loopback controller and a
scripted host (`agent-fixture.ts`) that speaks the host protocol: enrollment, heartbeats,
operation receipts and cleanup receipts. They cover:

- the handshake, listings, the instructions resource and JSON-RPC errors;
- a lease waiting in the queue behind another session, its progress and grant, scoped
  actions with a screenshot as image content, and release;
- renewal past the original TTL, the maximum-lifetime and lease-ended notices;
- release on stdin close, SIGINT and SIGTERM;
- cancellation of a queued and of a booting lease request;
- `unknown` receipts and an action in flight when the lease ends, never run twice;
- install from a local file through the lease key;
- refusal of an unknown application key, an unprotected key file, a wrong lease key and
  another lease's key;
- `lease hold`: one grant line, renewal, the private key file, release on a bound PID's
  exit, on SIGTERM and on parent exit, a wait stopped by SIGINT, and `--detach`;
- `requests`, the lease-key commands, `instructions` and `setup`.

`agent-session.test.ts` runs the session against a scripted server that loses replies
after applying them. It covers a lost submission and a lost renewal replayed byte for
byte, a renewal against a revision that moved, a release that cannot be confirmed
(renewal stays stopped; a later close completes it), and the queue position, which the
real controller's request view does not carry yet.

Not covered: the HostRunner, lease supervisor and a real emulator behind these surfaces
([android-leases.test.ts](../coordination/test/control/android-leases.test.ts) covers the
runner side with the HTTP API); a real MCP client; TLS to a remote controller; Windows
(these tests are skipped there); loss of the real controller during a held lease; and
clock skew, which is reasoned about but not simulated.
