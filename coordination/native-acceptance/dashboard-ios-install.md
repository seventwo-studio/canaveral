# Dashboard iOS install trial, 18 November 2026

The disposable loopback controller enrolled the native iOS runner. Its Xcode, idb, runtime and device-type preflight passed for iPhone 18 Pro on iOS 27.2. The runner's iOS provider rejected consumer lease execution. The ordinary machine provider also lacked removeOwnedStorage, which the runner requires for confirmed deletion. The preflight exited 1. No assignment was started. The temporary controller and runner were closed.

Device inventory before and after showed the same six shutdown iOS simulators, including the stock iPhone 18 Pro. No device was opened. Dashboard upload, native installation, bundle-ID launch, release and owned simulator removal remain unverified.

Run dashboard-ios-install.mjs with Node and the selected Xcode DEVELOPER_DIR after building coordination. dashboard-ios-upload.mjs provides the browser step for an authenticated disposable machine detail page. It checks the assigned machine and host, terminal operation, archive digest, byte count and stage cleanup receipt. Native launch and device disappearance require separate observations.

## Ordinary account-owned machine trial

The 18 November follow-up uses an invited ordinary account and POST /v1/machines. Consumer lease execution is a separate future acceptance item. Provider commit bbc4f58 adds iOS owned removal. At that revision the controller still rejects ordinary iOS delete requests with capability_unsupported. Boot remains pending controller support and verification of the end-to-end cleanup route.

Build coordination and dashboard assets for the revision under trial. In the selected Xcode login environment run bash dashboard-ios-app.sh and retain the printed archive path. The simulator build and ad-hoc signing succeeded on this Mac. Running dashboard-ios-install.mjs with that archive and --prepare-only passed the Xcode preflight, found the stock neighbor, and signed into the actual loopback dashboard as the trial account. No machine was created.

After verifying the controller and provider delete path in the built revision, run the same driver with IOS_TRIAL_CLEANUP_VERIFIED=1 and the archive path as its only argument. The driver records private state and stable identifiers in its printed directory. After upload and the bundle container check, match the printed disposable UDID with device_list on host local. Use device_open for that host and UDID, then its returned command to open test.canaveral.dashboardtrial. Observe the trial label and write the printed UDID and bundle ID to the indicated confirmation file. The driver requests shutdown, waits for controller confirmation, submits the saved deletion UUID and compares the final native inventory with the baseline. Preserve the private state for reconciliation if any step fails.

## Result, 18 November 2026 (23:20–23:30 CET)

Revision: d535699 plus the uncommitted runner scheduling fix and fixture change described below. Coordination and dashboard assets were built from that tree. The controller admits deletion for stopped iOS and Android device machines on a matching runtime (lifecycle.ts, with a lifecycle test). IosProvider.removeOwnedStorage is present and covered by the mobile provider tests. Xcode 27.2, iPhone 18 Pro, iOS 27.2.

Private state: dashboard-ios-install-50K6uL in the user temporary directory. Machine 966b7072-f880-4529-833b-7e0c6b546e93, disposable UDID 183e098f-2f80-4c24-adc1-8997c498d575, deletion 4e52f908-0db7-4397-a74e-3cb13067e1cc.

- Upload and install receipt: passed. The ordinary owner's dashboard upload created operation 1174770e-3f42-4625-ac0b-865ffb7a0a24 on the assigned machine and host. Its receipt was succeeded, with installed and artifactCleaned true and a matching digest and byte count (59,904). simctl reported an app container under the disposable UDID.
- Launch: the first build failed. The app was installed and visible on the home screen, but it crashed with SIGTRAP in UIKit's `_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption`. iOS 27 terminates apps that don't adopt the scene lifecycle. This is a fixture defect, not a Canaveral defect. dashboard-ios-app.sh now declares a UIApplicationSceneManifest and uses a UIWindowSceneDelegate. The corrected 60,928-byte build was uploaded to the same disposable machine with the operator credential through the CLI (`app-upload`, then `device install-uploaded`, operation 71f2a124-18f0-4b47-b7dc-6745951a9f52). Its receipt was succeeded with artifactCleaned true. The corrected build was not uploaded through the dashboard.
- Launch observed: passed for the corrected build. T3 device_open on host local and `agent-device open test.canaveral.dashboardtrial` started the app. The accessibility snapshot showed the application "Trial" with the text "Canaveral dashboard install trial". The screenshot was black because the fixture's label has no background color, so it draws black text on a black window. The label was confirmed from accessibility, not from pixels. The confirmation file was then written.
- Shutdown: passed. The controller reported the machine observed as stopped.
- Controller-confirmed deletion: passed. Replaying the saved deletion UUID returned complete. The machine_deletions row is complete.
- Inventory restored: passed. The driver's final simctl inventory matched its 15-entry baseline exactly. device_list showed the six stock simulators unchanged and shut down.
- Upload storage released: passed. The dashboard upload 5285c299-fed9-49da-9ec1-899774fad1c7 was deleted with 0 reserved disk after installation. The corrective CLI upload is not released automatically. After the driver finished, it was deleted by restarting the disposable controller from its state and calling `POST /v1/app-artifacts/{id}/delete`. Both rows are now deleted, with 0 reserved disk and 0 chunks.

### Earlier failed run, preserved for reconciliation

The private state dashboard-ios-install-Lv6iy4 belongs to an earlier run at this head, 23:15–23:17, which this attempt did not start. That run left disposable simulator f2bfc9a6-3a0c-439c-ba88-10b9a9c891c3 (cvm-1d3f99f7-1109-4f97-bea0-438093cacedd) booted. Its controller database holds:

- machine 1d3f99f7-1109-4f97-bea0-438093cacedd, running;
- install operation ffc954eb-b65a-4632-9619-6343345be792, unknown ("Dispatched work outcome requires inspection");
- upload b300c9dc-3560-4699-824f-20e1543050dd, ready, reserving 2 GiB.

The provider operation journal directory was created but holds no receipt. Before writing a receipt, the provider takes assignment.lock. Reconciliation of the same running machine holds that lock during simctl list and bootstatus. Even so, the runner scheduled queued device operations while a reconciliation of the same machine was still active. A busy lock then became a permanent unknown outcome. host.ts now skips device operations while that machine's reconciliation is active, mirroring the existing reverse guard, and a host-runner test covers it. The race is inferred from the empty journal and the code path. There is no log of the actual exception. The orphan was not modified. Removing it needs the retained state and authorization for its reconciliation.

### Unverified

- Launch of the original dashboard-uploaded build. It cannot launch on iOS 27 because of the fixture defect.
- A dashboard upload of the corrected fixture.
- A pixel-level view of the label.
- Native recurrence of the reconcile/install race, which this run did not reproduce under the fix.
- Reconciliation of the earlier orphan.
- Native video, input, consumer leases and remote hosts.
