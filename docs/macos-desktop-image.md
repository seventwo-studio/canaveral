# macOS desktop image (operator-supplied)

A macOS desktop launched from the dashboard boots a clone of an operator-prepared
macOS disk on an Apple-silicon host. Its guest runs the assigned helper
(`CanaveralAssignedGuest`), which carries the display, input, files and terminals
to the shared viewer over the pinned TLS transport described in
[macOS guest access](macos-guest-access.md#unleased-dashboard-desktops).

Canaveral does not build this image in CI. A macOS guest needs an Apple restore
image (IPSW) and Apple-silicon virtualization, so it cannot be built on the Linux
image runners. Hosted macOS runners are virtual machines that cannot run a nested
macOS guest. Installation also stops at Setup Assistant, and privacy permissions
must be granted inside the guest. CI builds and ad-hoc signs only the guest
bundle (`validate.yaml`, `native-compile`) to check its packaging.

## Inputs

| Input | Source |
| --- | --- |
| Apple-silicon Mac running macOS 26 or later | The host that runs the desktops |
| IPSW restore image for macOS 26 or later | Apple. `CanaveralVMRunner restore-image` prints the URL, version and build of the latest image this Mac supports. The 27.2.1 image is about 25.6 GB. Record its SHA-256. |
| Guest bundle `canaveral-assigned-guest-macos-arm64.tar.gz` | `CANAVERAL_SIGNING_IDENTITY=<identity> bash tools/macos-image/build-guest-app.sh OUTPUT_DIR` on the Mac. The screen-recording and accessibility grants follow the app's signature, so sign with a stable identity. An ad-hoc build works only for the image it was installed in, and rebuilding it voids the grants. |
| Signed `CanaveralVMRunner` from this revision or later | It accepts launch media for unleased desktops |

The guest runs macOS 26 or later, the Swift package's minimum. Apple's macOS
license limits how many macOS virtual machines may run on one Mac. Keep the
host's capacity within that limit; Canaveral does not count licenses.

## Prepare the image

1. Create a build VM with the **Canaveral Machines** app
   (`VirtualMachines/script/build_and_run.sh`). Choose macOS and the IPSW. Give
   it at least 4 vCPUs, 8 GiB memory and the disk size every clone should start
   with.
2. Complete Setup Assistant in the app's window. Create one administrator account
   for the desktop session. Do not sign in with an Apple Account. Leave
   FileVault off, because automatic login requires it to be off.
3. In **System Settings → General → Sharing**, keep Remote Login, Screen Sharing
   and Remote Management off.
4. Copy the guest bundle into the guest, extract it, and run
   `sudo sh install-guest.sh` from its directory. This installs
   `/Applications/Canaveral Assigned Guest.app` and
   `/Library/LaunchAgents/app.canaveral.assigned-guest.plist`. Do not install
   the manual `Canaveral Guest` app, which keeps a reusable credential in the
   login Keychain.
5. In **Privacy & Security**, allow **Screen Recording** and **Accessibility**
   for Canaveral Assigned Guest. Add the app with **+** if it is not listed.
6. In **Users & Groups**, turn on automatic login for the desktop account. In
   **Lock Screen**, set **Require password after screen saver begins or display
   is turned off** to **Never**, and run `sudo pmset -a sleep 0 displaysleep 0`.
   Otherwise an idle dashboard user returns to a password prompt.
7. Run `sudo sh check-image.sh` from the bundle directory. It must print
   `Image identity check passed`. It fails in these cases:
   - the manual helper, its LaunchAgent or its Keychain item is present;
   - Canaveral Guest state is left in a user's Application Support, for example
     from a test launch;
   - there are SSH host keys or `authorized_keys`;
   - sshd, Screen Sharing, File Sharing or Remote Apple Events is not disabled,
     or Remote Management is on;
   - FileVault is on, automatic login is off, or Setup Assistant has not finished;
   - the screen lock is on, or system or display sleep is not 0;
   - the assigned helper or its LaunchAgent is missing or invalid.

   If the check reports that sshd or Screen Sharing is not disabled while the
   Sharing settings show them off, run
   `sudo launchctl disable system/com.openssh.sshd` or
   `sudo launchctl disable system/com.apple.screensharing` to record it.
   Then run the check again.
8. Shut the guest down from the Apple menu. Do not boot it again before export;
   every later change becomes part of every clone. Without launch media the
   helper stops at startup and leaves only its empty service lock, which the
   check allows.
9. From the build VM's folder in the Canaveral Machines storage location
   (`~/Library/Application Support/Canaveral Machines` by default), copy these
   files into a new image directory:

   | Build VM file | Image directory file |
   | --- | --- |
   | `disk.img` | `disk.raw` (`cp -c` makes an APFS clone) |
   | `auxiliary.bin` | `auxiliary.bin` |
   | `hardware.bin` | `hardware-model.bin` |

   Do not copy `identity.bin`. Every clone receives a new machine identifier.
   Make the files private (`chmod 600`) and record their SHA-256 values.

## Run it

```sh
node coordination/dist/src/cli.js local \
  --macos-image /absolute/path/image-directory \
  --macos-restore-image /absolute/path/UniversalMac.ipsw \
  --apple-runner /absolute/path/CanaveralVMRunner
```

Add `--linux-image` and `--guest-helper-manifest` to offer Linux desktops from
the same host. Both use one Apple runtime. With a macOS image, the generated
host capacity is 8 vCPUs, 16 GiB and 256 GiB disk. The macOS image's minimum is
4 vCPUs, 8 GiB and the disk's size, at least 64 GiB. The restore image's own
minimums can raise these at preparation. These options take effect only when
local creates a fresh host configuration.

**Launch desktop** on Machines then offers the macOS image. See
[guest access](guest-access.md#launch-use-and-delete-a-desktop-from-the-dashboard).

## What clones share

Every clone has the same local account and the same automatic-login password,
because macOS stores that password in the image. The account is an
administrator. The image check requires Remote Login, Screen Sharing, File
Sharing, Remote Apple Events and Remote Management to be off, the screen lock
to be off and system and display sleep to be disabled, so dashboard users never
see a password prompt and need not be told the password.

That check is a snapshot of the image. All clones share the host's NAT subnet
and can reach each other, and an administrator inside a clone can turn a remote
service back on. If the shared password is ever disclosed, a user who does so
exposes that clone to every other clone. Per-clone password rotation or
isolation between clones is an open gate, not a property of this release. Each
clone receives its own helper credential, TLS key and launch identity on its
launch media. The runner gives each clone a new machine identifier when it
prepares the clone. The clone's MAC address is derived from its machine ID.

## Lifetime

The launch certificate is valid for two days from when the media is built, and
there is no renewal. After that the host refuses the helper's TLS, the
desktop leaves **Ready**, and only a new launch restores access. A stopped
desktop cannot be started again either. In both cases, delete it and launch a
new one.

## Open gates

Native boot of a clone, the helper's startup with copied privacy grants,
whether newer macOS releases ask to re-confirm screen recording, Local Network
behavior of the guest listener, input fidelity and latency are unaccepted. See
the [trial record](../coordination/native-acceptance/dashboard-desktop-macos.md).
