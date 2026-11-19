# Dashboard macOS desktop trial, 19 November 2026

**Result: not run. The required macOS restore image and prepared image are not
on the designated Mac.** No VM was created, signed, started or removed.

Host: the Mac Studio homelab (Apple silicon, macOS 27.2.1, build 26B131), at
05:25 UTC. The trial would follow the [Linux desktop trial](dashboard-desktop.md)
with `CANAVERAL_TRIAL_OS=macos` in `dashboard-desktop.mjs`. That means launching
through the dashboard, waiting for Ready, then opening the viewer and taking
control. It would open Terminal with Spotlight and click into its window. It
would then type a nonce command and confirm the file's size through the guest
file listing. Size alone does not bind the content to the nonce; it relies on
the VM being fresh for each trial. Finally it would stop the VM, delete it with controller
confirmation, and check the baseline.

## Observed

- A filesystem search found no `.ipsw` restore image, no macOS VM disk and no
  auxiliary storage outside source trees.
- One pre-existing Virtualization process (PID 92289, started 18 November
  22:10) was running. It was not signaled, inspected or changed.
- A freshly built, ad-hoc-signed `CanaveralVMRunner restore-image` reported the
  latest restore image this Mac supports:
  `UniversalMac_27.2.1_26B131_Restore.ipsw` (macOS 27.2.1, build 26B131,
  minimum 2 vCPUs and 4 GiB) at
  `https://updates.cdn-apple.com/2026FallFCS/c202a724-db7e-4d56-917b-110aa0226507/UniversalMac_27.2.1_26B131_Restore.ipsw`.
  A HEAD request reported 25,595,954,706 bytes. The image was not downloaded.
- The boot volume had 115 GiB free.
- `tools/macos-image/build-guest-app.sh --adhoc` built and verified the guest
  bundle on this Mac. Images need a build with a stable identity instead.

## Needed to run it

1. Operator approval to download the 25.6 GB restore image above, or the path
   of an existing IPSW for macOS 26 or later.
2. A prepared image directory following [macOS desktop image](../../docs/macos-desktop-image.md).
   Setup Assistant and the Screen Recording and Accessibility grants need
   interactive access to the build VM's window in the Canaveral Machines app on
   this Mac, so the operator must do them, for example over Screen Sharing.
   Preparing the image uses about 64 GiB, and each launched clone adds its own
   disk.
3. The guest bundle built with the operator's Apple Development identity, and
   a `CanaveralVMRunner` from this branch signed with the same identity as in
   the Linux trial. Both follow the local signing helper.

## Open

Everything on the native path is unverified:
- a clone boots and its helper starts with copied privacy grants;
- the helper reads its launch media and binds the NAT address;
- the host reaches it through TLS and readiness passes;
- pointer and keyboard input arrive through the viewer;
- stop, deletion and erasure of the launch media complete.
