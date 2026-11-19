# Dashboard remote desktop relay trial, 19 November 2026

Driver: `dashboard-desktop.mjs` from this PR's branch, run on the Mac Studio homelab (Apple silicon, macOS 27.2.1). Each run used fresh private state on loopback, created one disposable Linux desktop through the dashboard in Playwright Chromium, and removed it. The driver records the Virtualization processes that existed before the run and never signals, inspects or removes them. One pre-existing Virtualization process (PID 92289) was present throughout and was untouched. No simulator or emulator was used.

## Inputs

| Input | SHA-256 |
| --- | --- |
| `desktop-arm64.qcow2`, the CI artifact of the [first desktop trial](dashboard-desktop.md#inputs) | `2d1b8c29ff72d14418ebff9efd567e9aedd4e9a36b3c572a56f9805390f97aa9` |
| `desktop-guest-bundle-arm64.json`, same run | `d22a351085258552010cd0fe97881cc8a38c5927902fa200ed63d67dde1f5c2c` |
| `CanaveralVMRunner` built from this branch, signed with the operator's Apple Development identity (`app.canaveral.vm-runner`) | `d593b3fe1d39102601a731a4133e1afa48b60e315d2c5185b1e0a212a40799f9` |

## Relayed run, separate processes (07:29–07:31 UTC)

`CANAVERAL_TRIAL_TOPOLOGY=separate` started three processes: `canaveral serve` (the controller), `canaveral host` with the generated Apple host configuration, and a standalone `canaveral dashboard --url <controller>` with no attached connector. The browser talked only to the dashboard. Machine `26c09aed-8413-457e-af65-3c53ec85801d`, 2 vCPU, 4 GiB, 32 GiB disk.

- **Launch.** The row showed Pending, Preparing 10 s later, then Ready 35 s after launch. The host reserved 2 CPU, 4096 MiB and 32 GiB.
- **Relayed viewer.** **Control** opened one desktop WebSocket. Its first message was the controller broker's `ready` for capability `display`; the viewer ignored it and completed the RFB handshake with the guest's XFCE session at 1440 × 900. **Take control** returned `owned`.
- **Click and type.** A pointer click on the panel's terminal launcher opened xfce4-terminal. Typing `echo typed-<nonce> > /tmp/canaveral-trial.txt` and Enter produced the file with exactly `typed-56c2112a-ecf3-4231-8ff2-c9474198b44e`. The guest's own screenshot (129,074 bytes) shows the command and a fresh prompt.
- **Logout mid-session.** With control owned, the driver typed `echo revoked-<nonce> > /tmp/canaveral-revoked.txt` without Enter, logged the browser out (`200`), then pressed Enter at once. The viewer still sent the Enter's two key events, and the desktop WebSocket closed 8 ms after the logout response. Ten seconds later the guest had no `canaveral-revoked.txt`. The driver signed in again for the next steps.
- **Stop and delete.** **Stop** reached Stopped at 07:30:43. **Delete machine** reported `deleted. The host confirmed removal.` at 07:30:50, and the controller returned 404 for the machine.
- **Baseline.** Host reservations returned to 0 CPU, 0 MiB and 0 GiB. No storage named for the machine remained. The Virtualization processes matched the pre-run set.

## Relayed rerun after review fixes (07:38–07:39 UTC)

Review then made the controller's per-message check read only the session's own row, bounded session creation, and stopped a closed viewer from logging host recovery noise. The separate-process run was repeated on that final code with the same inputs, machine `b9121d39-d43d-4daf-88d4-6ab2b3f0bf3f`. It passed with the same steps. Ready came 35 s after launch. The typed file held exactly `typed-202cb62d-f522-40f4-b3f2-f1ab0b2c2112`, and the guest screenshot was 128,927 bytes. After logout, the viewer's Enter was sent, the WebSocket closed 10 ms after the logout response, and no `canaveral-revoked.txt` appeared. Delete was confirmed at 07:39:33. Reservations returned to zero, no owned storage remained, and the Virtualization processes matched the pre-run set.

## Local baseline, same session (07:31–07:33 UTC)

`CANAVERAL_TRIAL_TOPOLOGY=local` ran the same steps through `canaveral local`'s in-process viewer, machine `54d893fa-5d3c-4122-acda-3fe11366ee20`. It passed. Logout also stopped input: the Enter after logout was sent, the connection closed 76 ms after the logout response, and no `canaveral-revoked.txt` appeared. Reservations, storage and Virtualization processes returned to baseline.

## Typing rate

Both runs typed the same 75-character line with Playwright's 30 ms key delay: 150 key events over about 2.4 s. The metric is the one the first trial used: key events sent, divided by the time from the first key until a 1 s file poll found the guest file.

| Path | Typing | File visible | Rate |
| --- | --- | --- | --- |
| `canaveral local`, in-process viewer | 2,421 ms | 12,388 ms | 12.1 events/s |
| Standalone dashboard, relayed through the controller (both runs) | 2,407 ms | 2,915 ms | 51.5 events/s |

The relayed rate is bounded by the typing delay and the poll, not by the relay. The local path is unchanged: its socket still authorizes each complete message with three controller round trips. In the portable fixture (`dashboard-desktop.test.ts`), 200 one-event messages through the relay apply at about 820–880 events per second.

## Open

- The local in-process viewer keeps its per-message gateway authorization and about 12 events per second.
- macOS desktops through the relay, concurrent viewers, a second account in the browser, long sessions, reboots during a session, and a dashboard on another machine or behind TLS were not exercised.
- The relay was exercised on one Mac with all three processes on loopback. A cross-network deployment remains open.
