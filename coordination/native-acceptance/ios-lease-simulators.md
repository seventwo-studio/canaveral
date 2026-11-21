# iOS simulator lease trial

The authorized [mobile parity trial](mobile-parity.md#ios-simulator-lease) on 21 November
2026 verified private-set creation, boot and readiness, lease-key app listing, and release
with proven cleanup. The table below describes the original test plan. The trial record
identifies the checks that still need native verification.

The lease runs in the `shared-host` isolation class. The trial does not test isolation from
the host, because there is none to test.

## Preconditions

- A Mac with the Xcode, simulator runtime and device type named by the leased template.
- `idb` and `idb_companion`, and a built `canaveral-mobile-native`.
- A disposable host state directory and a short `storage` path (the lease socket must fit in
  a 104-byte Unix socket path).
- Operator authorization for creating, booting and deleting simulators on that Mac.

Record the default device set before and after (`xcrun simctl list devices`): it must be
identical. The trial may only create simulators inside lease device sets under `storage`.

## Checks

| Question | How to check | Evidence at implementation |
| --- | --- | --- |
| Does a simulator in a private device set create, boot, shut down and delete under the host's account? | Lease once; watch `simulator.log` and `xcrun simctl --set <device set> list devices` | Only a stand-in `simctl` has run |
| Is `launchd_sim` named and argued as `launchd_sim <device directory>/…`, and do installed apps run from inside the device directory? | `ps -axww -o pid=,ppid=,command=` while leased, with an app launched. If not, every lease ends with `treeObserved: false` and blocked cleanup | The tree identification depends on it; this is the first check |
| What does CoreSimulator report while a boot is in flight and after its `simctl` client was killed? Is five seconds of `Shutdown` with an empty tree enough to rule out a late boot? | Release a lease during its boot; watch `simctl --set <device set> list devices` and the process table against `lease-stopped.json` | The settling period is a judgement |
| Does `simctl shutdown` work on a device that is still `Booting`? | The same run; read `simulator.log` | The supervisor retries every 5 s and waits |
| Does `lease-tree.json` list the real tree, and how fast does the tree change? | Compare it with the process table every few seconds | The 2 s sample interval is a guess |
| Does `simctl shutdown` return only after the tree is gone? Is `treeForced` false after a normal expiry? | Let a lease expire; read `lease-stopped.json` | Fixture stand-ins exit at once |
| After the forced path stops and kills `launchd_sim` and its tree, does CoreSimulator report the device `Shutdown`? | Force the stop path by making the shutdown command fail on a disposable lease | If it keeps reporting `Booted`, the supervisor never finishes and cleanup stays blocked |
| Are operator processes that mention the device set left alone by the forced path? | Keep a `tail -f` on a file in the device set during that run | Only tree members may be signalled |
| Do `apps` and `logs` reach a lease holder without host paths, and does the real `listapps` output parse? | Compare a lease's `apps` and `logs` results with the raw `simctl` output | Only a stand-in listing was parsed |
| Does CoreSimulator leave files outside the device set? | Search `/private/tmp` and `~/Library` for the lease's UDID after cleanup | Removal covers the lease's storage only |
| Does `idb_companion` start before the boot with `--device-set-path` and `--grpc-domain-sock`, and does `idb --companion <socket>` drive input and hierarchy? | `tap`, `text`, `hierarchy` through a lease key | Flags were read from help text and client source |
| Do the readiness probes pass on a fresh device, and how long does a first boot take? | Time from admission to `ready`; read `lease-ready.json` | Provisioning timeout sizing |
| Do the detached supervisors survive a host restart under launchd? | Restart the host service mid-lease; the same supervisor PID must keep its lock | Service-manager behaviour is unverified |
| Do install, launch, logs, files and a real `.app` archive work through a lease key? | The scenario in `ios-leases.test.ts` against the real host | Only fixture stand-ins have run |
| Do controller loss, runner loss and supervisor loss behave as in the fixtures? | Repeat each on a real simulator | Fixture evidence only |
| What CPU, memory and disk do several leased simulators really use? | Sample the host during two concurrent leases | Reservations are scheduling values only |

Lease recording, the leased live display stream and lease file sessions are outside this
trial: recording is refused on iOS, and the other two have no accepted path yet.
