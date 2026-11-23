# canaverald service acceptance

The GitHub-hosted matrix runs the direct Node daemon as a system service.
It renders the repository's systemd unit and launchd plist with disposable
paths and controller credentials. Linux uses a dedicated system account.
The macOS LaunchDaemon uses the hosted runner's existing non-root account
to avoid changing the runner's account database.

The direct definitions cover first enrollment on a new host. The managed
`canaveral install` path takes an existing host identity and a signed offline
bundle. It generates a definition for the stable launcher, which operators
review and register separately.

The fixture stops the daemon through the service manager, removes the
enrollment credential and starts it again with the same private state.
It checks controller health and heartbeat progression, runs both diagnostics
as the service user and verifies clean exit, lock release and removal of the
service registration. Linux disables automatic restarts for the acceptance run
so a crash cannot pass as an operator restart.

The PR smoke uses the same controller and daemon checks in the foreground.
Only the hosted matrix installs services. Both modes use an idle `native`
offer with no workload templates. The evidence covers the daemon lifecycle
and local diagnostics. Virtualization, model execution and managed updates
have separate acceptance gates.
