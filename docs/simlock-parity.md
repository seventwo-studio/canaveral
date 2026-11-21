# Simlock parity

[Simlock](https://github.com/callstackincubator/simlock) leases iOS simulators,
Android emulators and enrolled phones to coding agents that run in parallel. On
21 November 2026 the owner asked that Canaveral match it feature for feature at a
holistic level: the same capabilities in Canaveral's own terms and contracts, not
simlock's commands, flags or wire formats.

This page records the comparison, the scope and decisions accepted that day, and
where each area is delivered. The comparison used simlock 0.8.0 (its public
documentation) against Canaveral at `8d2c436`, checked in code. Each pull request
states its own evidence. Fixture coverage does not establish native acceptance.

## Where Canaveral was already level or ahead

- **Fleet.** One controller with outbound-only hosts, placement, maintenance drain
  and signed host updates.
- **Queue.** Durable requests with priority, fairness between applications,
  deadline, cancellation and idempotent replay. Simlock's fleet queue is in memory
  and is lost when its gateway restarts.
- **Android emulator leases.** A fresh device per lease, a deadline enforced
  independently of the runner and controller, proven cleanup, and a guest fenced
  from the host. Simlock's isolation is cooperative.
- **Device actions.** Apps, input, screenshots, MP4 recording, logs, UI hierarchy,
  deep links and chunked build upload.
- **Accounts, scoped tokens and restart recovery.**

## Scope accepted on 21 November 2026

| Area | What simlock offers | Canaveral before | Delivery |
| --- | --- | --- | --- |
| Queue and lease visibility | Queue position and reason, a held read instead of polling, a label on a lease | State and reason only; clients polled; the label was accepted but not returned | [#80](https://github.com/seventwo-studio/canaveral/pull/80) |
| Agent surfaces | MCP server, a held lease that renews itself and releases on exit, agent instructions and setup, a CI recipe | No MCP and no agent instructions; CLI leases needed request files and never renewed | [#81](https://github.com/seventwo-studio/canaveral/pull/81) |
| Observability | Durable event feed, usage figures, Slack and webhook alerts, `doctor`, an error catalogue | Host metrics and administrator inventories only | [#82](https://github.com/seventwo-studio/canaveral/pull/82) |
| Dashboard | Queue, several live screens side by side, activity, usage | No device queue view and no screen wall | [#88](https://github.com/seventwo-studio/canaveral/pull/88) |
| iOS simulator leases | Leased like Android emulators | Refused in code; iOS existed only as account-owned machines | [#83](https://github.com/seventwo-studio/canaveral/pull/83) |
| Dev-loop networking | Reverse and forward port tunnels, for example to reach Metro | None; leased emulators have no guest network | [#86](https://github.com/seventwo-studio/canaveral/pull/86) |
| Warm pool and prepared devices | Pre-booted devices and saved device states that each lease clones | Neither; every lease was a cold boot | [#85](https://github.com/seventwo-studio/canaveral/pull/85) |
| Live screen for a lease | Live stream for the holder and for operators | Screenshots and bounded recordings only | [#87](https://github.com/seventwo-studio/canaveral/pull/87) |
| Runtime and capacity upkeep | Install and remove runtimes and images, idle-device cleanup, back-off under memory or disk pressure | Operators installed runtimes by hand; observed load never affected placement | [#84](https://github.com/seventwo-studio/canaveral/pull/84) |

One draft pull request per area, each with its contract documentation, evidence
and open items. Review and portable checks apply to the revision they examined.
The dashboard builds on the queue visibility, observability and live screen
changes and needs combined verification with their reviewed revisions.

## Decisions and their reasons

**iOS simulator leases are operator opt-in, with a declared shared-host isolation
class, for trusted code only.** A simulator app is an ordinary process of the Mac
host's user, with the host's network and files, so a leased simulator cannot be
fenced from the host the way a leased Android emulator is. A host advertises iOS
leases only when its configuration explicitly declares that class, and only
applications whose policy allowlists the template can lease it. Deadline
enforcement, single-use devices and proven cleanup still match Android. The
alternatives were to keep iOS leases gated, which leaves the largest capability gap
open, or to run simulators inside macOS guests, which depends on macOS workspaces
that are not accepted.

**Dev-loop networking is tunnels only.** A lease gets explicit port tunnels carried
over the device's own control channel and relayed through the controller to the
lease holder. The guest has no route through the device host's network. A reverse
tunnel can reach services the lease holder exposes, including a proxy the holder
runs. Public HTTPS egress through an
allowlisting proxy was considered and left out, because it changes that guarantee
and is a larger design.

**Device-side work is fixture-only for now.** `AGENTS.md` requires operator
authorization for native runs. Each device-side pull request lists native
acceptance as open. Native trials follow later, one pull request at a time, after
the code has been reviewed.

**Physical phones and proxy sign-in are out of scope.** Enrolling and leasing real
iOS and Android hardware, and trusting a signed identity from a sign-in proxy for
the dashboard, stay known gaps against simlock.

## Decisions taken while building

These were made during delivery on 21 November 2026 and are open to the owner's
correction. Each is recorded in the pull request that carries it.

- **A leased device's screen is visible to its lease holder only.** Simlock lets an
  operator watch any running device. Canaveral's lease sessions accept only the
  lease's own key, so the dashboard's screen wall shows account-owned devices and
  never a leased one.
- **A held request read is refused, not answered early, beyond its limits.** At most
  32 reads are held across the controller and 4 per application credential.
- **Refusing placement under host pressure is a per-host opt-in.** Hosts sample and
  report pressure by default as observation only, because the thresholds have not
  been measured natively.
- **A host may declare port tunnels only if it offers no account-owned Android
  devices.** The host's adb server is reachable by any local process and by an
  unfenced emulator, so a tunnel on a mixed host would extend that reach to the lease
  holder's machine. A runner-private adb server is the proper fix and needs a native
  run.
- **Tunnel traffic is authorized on a short interval, not per message**, with a
  per-tunnel rate bound, so tunnels cannot monopolise the single control worker.
- **A recording takes priority over live views** for a host's capture slots. The
  runner must prove a prior live capture of the same device stopped before it
  dispatches the recording.
- **An administrator saves a baseline only from a device their own account owns.**
  The operator credential saves only a device with no user owner.

## Acceptance still open

Native trials require operator authorization. The device-side drafts record the
assumptions each trial must check, including CoreSimulator process ownership and
stop proof, Android baseline restoration, adb tunnel mappings, native screen
capture and runtime installation and removal. Leased screens remain visible to
their lease holders. The dashboard screen wall covers account-owned devices.

## Known differences that are not gaps

- Canaveral selects a device through an operator-defined, pinned template that an
  application is allowlisted for. Simlock accepts a free-form model, class and OS
  range. Pinned templates are a deliberate Canaveral contract.
- Canaveral's lease credentials are scoped per application and per lease. Simlock's
  agent token is, by its own documentation, effectively shell access to the worker.
- Canaveral never replays an operation whose outcome is unknown. Agent-facing
  surfaces report `unknown` instead of retrying.
