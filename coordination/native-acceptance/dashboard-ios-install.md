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

## Orphan reconciliation attempt, 18 November 2026 (23:31 CET)

Stopped before any change to the orphan; its resources were left as they were. The supported API offers no way to resolve or abandon an unknown device operation, and the upload cannot be deleted while that operation stays unknown.

- Code path: reportDeviceOperations ignores reports for terminal rows, and unknown is terminal. No controller, admin or host route changes a device operation after it is terminal. requireCleanAttempts rejects upload deletion unless every install attempt either succeeded with artifactCleaned or was never dispatched. Operation ffc954eb-… is in control_device_dispatch, so it was dispatched.
- Evidence: a temporary controller was started on a private copy of the retained database (db, admin and enroll files only), using the retained controller identity. No runner was started. On that copy, GET /v1/operations/ffc954eb-… returned unknown ("Dispatched work outcome requires inspection; it is not replayed.") and GET /v1/app-artifacts/b300c9dc-… returned ready (59,904 bytes). POST /v1/app-artifacts/b300c9dc-…/delete returned 409, and POST /v1/operations/ffc954eb-…/resolve returned 404. The copy was then removed.
- The retained controller and runner were not restarted. A runner restart would reconcile the booted simulator without making the cleanup possible. Deleting the machine alone would leave the ready upload and its 2 GiB scratch reservation, and would remove the native state that the unknown outcome needs for inspection.
- device_list after the attempt: cvm-1d3f99f7-… (F2BFC9A6-…) was still booted. The six stock simulators were present and shut down: iPhone 18 Pro, iPhone 18 Pro Max, Ambiently Audit iPhone 17e, iPhone 17e, Ambiently Audit iPhone SE (3rd generation), and iPad Air 11-inch (M4).

Gap: clearing this orphan needs either an authorized operator recovery route for unknown install operations, with an inspection record, or explicit authorization for an out-of-band path. Either is a product or operator decision, not a small fix. The state directory dashboard-ios-install-Lv6iy4 is retained.

## Orphan cleanup through the supported path, 19 November 2026 (00:21–00:23 CET)

Revision: a33e57d (main, includes #64), detached and clean. Coordination was built at that commit. The canaveral-mobile-native debug helper was already current (cargo reported no rebuild). Xcode 27.2 via DEVELOPER_DIR. The retained state dashboard-ios-install-Lv6iy4 was first copied to the sibling dashboard-ios-install-Lv6iy4.backup-20261119 and compared with diff -r.

The disposable controller was restarted from the retained db, admin and enroll files with the retained controller identity on its original loopback port 60848, which the runner identity is bound to. The HostRunner was restarted with the driver's configuration (stateDir runner, storage devices, provider ios, the acceptance-ios template and capacity). The state path must be passed through realpath, as the driver does. The first attempt used the /var symlink path, and the runner refused it with "Owned paths cannot be symbolic links" before enrolling. Nothing was submitted in that attempt.

The trial owner's random password was never retained. An operator reset (POST /v1/users/{id}/reset-password with the retained operator credential, then /v1/auth/claim with a new password held only in memory) gave a login session for the owner `trial` (d2a9d6e5-…). User ID and machine ownership were preserved. That user's earlier sessions were revoked as part of the reset. No credential was printed or stored.

- Before: machine 1d3f99f7-1109-4f97-bea0-438093cacedd desired running. Install ffc954eb-b65a-4632-9619-6343345be792 unknown. Upload b300c9dc-3560-4699-824f-20e1543050dd ready (59,904 bytes), reserved_disk 2 GiB. device_list showed cvm-1d3f99f7-… (F2BFC9A6-…) booted and the six stock simulators shut down.
- Inspection: the owner submitted inspect-install 394efd34-7238-40a7-afde-318e0b18a314 after the machine was observed running. Receipt succeeded, about 10 s after submission: `providerReceipt: absent`, `stagedArtifacts: absent`, `artifactCleaned: true`. That matches the empty operations journal recorded earlier, so the provider never started that install.
- Resolution: owner session recorded cab88a62-ee61-446a-8957-aaad1b6f6468, `cleanup-confirmed`, inspection 394efd34-…, decidedBy `{kind: session, username: trial}`. The reason states the inspection result and that the install outcome stays unknown. GET of the install still returns `unknown`, now with that resolution.
- Upload deleted: POST /v1/app-artifacts/b300c9dc-…/delete returned deleted. The row shows reserved_disk 0, 0 chunks, and the host's app-artifact reservation sum is 0 (it was 2).
- Shutdown: desired stopped. The controller observed stopped about 10 s later. iOS POST power-off remains capability_unsupported, so the driver's desired-state path was used.
- Deletion: the retained deletion UUID 8852710d-e79d-4d84-98c4-3d2d3ef15f1a was queued and then returned complete. The machine_deletions row is complete. The provider devices directory for the machine is gone.
- device_list afterwards: the orphan UDID F2BFC9A6-… is absent. The six stock simulators remain, all shut down and with the same UDIDs: iPhone 18 Pro, iPhone 18 Pro Max, Ambiently Audit iPhone 17e, iPhone 17e, Ambiently Audit iPhone SE (3rd generation) and iPad Air 11-inch (M4). No device was opened, and simctl or idb was not used directly.
- The controller and runner were closed. Port 60848 is free.

Observations: the runner directory runner/machines/1d3f99f7-… still holds assignment.json, deletion.json and simulator-removal.sqlite. The runner was closed within a second of the deletion reaching complete, so whether a later poll would remove these journals was not observed. Runners do not prune host state folders, and retaining the deletion receipt is intentional: it lets a replayed deletion request return complete, as for the other providers (see docs/leases.md). This is the first native run of inspect-install on iOS. It covered only the absent-journal case. A present or partial journal and the iOS staged-artifact enumeration remain fixture-covered only.
