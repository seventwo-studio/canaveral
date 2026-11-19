# Dashboard Linux desktop trial, 19 November 2026

Driver: `dashboard-desktop.mjs`, run on the Mac Studio homelab (Apple silicon, macOS 27.2.1) from this PR's branch. Each run started the real `canaveral local` controller, Apple host and dashboard on loopback with fresh private state, created one disposable desktop through the dashboard in Playwright Chromium, and removed it. The driver records the VM processes that existed before the run and never signals, inspects or removes them. One pre-existing Virtualization process was present throughout and was untouched.

## Inputs

| Input | SHA-256 |
| --- | --- |
| `desktop-arm64.qcow2` from the [desktop image workflow](../../.github/workflows/desktop-image.yaml), run 44451524755 at `a29e361` | `2d1b8c29ff72d14418ebff9efd567e9aedd4e9a36b3c572a56f9805390f97aa9` |
| `desktop-guest-bundle-arm64.json` from the same run | `d22a351085258552010cd0fe97881cc8a38c5927902fa200ed63d67dde1f5c2c` |
| `CanaveralVMRunner` built from this branch, signed with the operator's Apple Development identity (`app.canaveral.vm-runner`) | `d6255b2ac0b3d286a8dbbad8ce8c0241aa647ca662bf0cbacc0a63a4689cd5de` |

Both CI artifacts matched their published digests after download. `apple-native-helper` was installed beside the built provider with `script/prepare_native.mjs debug`.

## Passing run (04:29–04:31 UTC)

Machine `36bc8e26-4ef3-4a38-9068-fd52903a6f42`, 2 vCPU, 4 GiB, 32 GiB disk.

- **Launch.** **Launch desktop** offered the desktop image (`linux · Desktop · Minimum 2 vCPU, 4 GiB, 32 GiB disk`) and asked only for a name. The row showed Pending, then Preparing 10 s later, then Ready 35 s after launch. The host reserved 2 CPU, 4096 MiB and 32 GiB.
- **Connect and interact.** **Control** opened the shared viewer showing the XFCE session at 1440 × 900. After **Take control** the gateway acknowledged `owned`. A pointer click on the panel's terminal launcher, sent through the viewer, opened xfce4-terminal. Typing `echo typed-<nonce> > /tmp/canaveral-trial.txt` and Enter through the viewer produced the file with exactly `typed-b056d9a6-5b00-47d8-bb51-0878915bf502`. The guest's own screenshot (129,175-byte PNG) shows the terminal with the command and a fresh prompt. The browser sent 5 pointer and 150 key events.
- **Stop and delete.** **Stop** reached Stopped at 04:30:49. **Delete machine** showed `Deletion requested. Waiting for the host to confirm removal.`, and the dashboard reported `deleted. The host confirmed removal.` at 04:30:53. The controller then returned 404 for the machine.
- **Baseline.** Host reservations returned to 0 CPU, 0 MiB and 0 GiB. The VM's storage directory was gone. The set of Virtualization processes matched the pre-run set.

## Defects found and fixed in this PR

Earlier runs on the same day failed and are kept as evidence of what changed:

1. `canaveral local` re-read its own generated host configuration with a 1 MiB limit. A real guest bundle (two native helpers, about 5 MB of base64) made local mode refuse to start. Generated host configurations now allow the operator bundle envelope.
2. With `apple-native-helper` missing, a deletion was journaled and reported **Deletion blocked**; storage and the reservation were kept. After installing the helper and restarting local, the host completed the same deletion request. This was the intended uncertain-removal behavior. The driver now refuses to start without the helper.
3. Viewer input took effect only after long delays, so typed text arrived after control was released and was dropped. A CPU profile of the local process showed half its time re-validating the host's multi-MiB operator recipe on every access fence. The host now validates a configured definition once. The local desktop socket also called the gateway's controller authorization 14 times per WebSocket message; it now authorizes each complete message before and after it is read (3 checks), and checks liveness locally for frame parts.

## Open

- **Input latency.** In the passing run, 2.4 s of typing appeared in the guest file 12.4 s after typing began, about 12 input events per second. Each message still makes three authorization round trips to the controller. That is usable for short commands, not for sustained typing.
- **Remote dashboards.** Only `canaveral local` attaches a desktop connector. A standalone dashboard beside a remote controller refuses the desktop WebSocket until an outbound display broker for machine owners exists.
- **Image build verification.** CI builds the disk and smoke-starts Xtigervnc in the build container. It does not boot the disk; this trial is the only boot evidence.
- **Not exercised.** Clipboard, accessibility inspection, files and terminals panels, reboots during a session, concurrent viewers, a second account, and long sessions.
