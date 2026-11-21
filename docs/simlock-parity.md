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
| Agent surfaces | MCP server, a held lease that renews itself and releases on exit, agent instructions and setup, a CI recipe | No MCP and no agent instructions; CLI leases needed request files and never renewed | Pull request pending |
| Observability | Durable event feed, usage figures, Slack and webhook alerts, `doctor`, an error catalogue | Host metrics and administrator inventories only | Pull request pending |
| Dashboard | Queue, several live screens side by side, activity, usage | No device queue view and no screen wall | Pull request pending |
| iOS simulator leases | Leased like Android emulators | Refused in code; iOS existed only as account-owned machines | Pull request pending |
| Dev-loop networking | Reverse and forward port tunnels, for example to reach Metro | None; leased emulators have no guest network | Pull request pending |
| Warm pool and prepared devices | Pre-booted devices and saved device states that each lease clones | Neither; every lease was a cold boot | Pull request pending |
| Live screen for a lease | Live stream for the holder and for operators | Screenshots and bounded recordings only | Pull request pending |
| Runtime and capacity upkeep | Install and remove runtimes and images, idle-device cleanup, back-off under memory or disk pressure | Operators installed runtimes by hand; observed load never affected placement | Pull request pending |

One pull request per area, each with its contract documentation.

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
lease holder. The leased guest keeps no network of its own and no internet, so the
isolation guarantee of Android leases is unchanged. Public HTTPS egress through an
allowlisting proxy was considered and left out, because it changes that guarantee
and is a larger design.

**Device-side work is fixture-only for now.** `AGENTS.md` requires operator
authorization for native runs. Each device-side pull request lists native
acceptance as open. Native trials follow later, one pull request at a time, after
the code has been reviewed.

**Physical phones and proxy sign-in are out of scope.** Enrolling and leasing real
iOS and Android hardware, and trusting a signed identity from a sign-in proxy for
the dashboard, stay known gaps against simlock.

## Known differences that are not gaps

- Canaveral selects a device through an operator-defined, pinned template that an
  application is allowlisted for. Simlock accepts a free-form model, class and OS
  range. Pinned templates are a deliberate Canaveral contract.
- Canaveral's lease credentials are scoped per application and per lease. Simlock's
  agent token is, by its own documentation, effectively shell access to the worker.
- Canaveral never replays an operation whose outcome is unknown. Agent-facing
  surfaces report `unknown` instead of retrying.
