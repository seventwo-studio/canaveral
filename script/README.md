# Build and validation tools

Use Node 24.11+ and the pinned Rust toolchain. From a source checkout, `npm ci`
runs `prepare`, which installs the independently locked coordination and dashboard
packages when missing and builds their JavaScript and assets. For CI with lifecycle
scripts disabled, run `npm ci --ignore-scripts`, `npm run setup`, then the required
build or test command. `npm run setup` always uses both subprojects' lockfiles.

`npm run build`, `npm run typecheck`, and `npm test` run coordination first,
dashboard second, and Rust last. `npm run check` also requires the dependency scan.
Cargo is limited to two jobs. These commands do not sign apps, start guests or
deploy services. Browser tests remain an explicit dashboard command.

`npm install -g .` builds a source checkout through `prepare` and installs the
`canaveral` CLI. `npm pack` includes the compiled CLI and SDK declarations, dashboard
assets and JSON contracts; an installed tarball needs no compiler or Rust toolchain.
The root SDK exports consumer-client, sdk, contracts, terminal-sdk, visual-sdk and
accessibility-sdk. The coordination package exposes the same subpaths. Build a
source checkout before importing either package.

- `node script/check_retention.mjs before.json after.json` compares saved metadata
  offline. Exit 0 means retained state matches, 1 means changed or unsafe, and 2
  means evidence was invalid or unreadable. It never changes the inputs.
- `node script/build_android_transfer.mjs --ndk /installed/ndk --output-dir dist/android-transfer`
  compiles both Android ABIs, verifies architecture and excludes test injection.
- `node script/build_linux_lease_deadline.mjs --output /new/absolute/deadline.so`
  builds an uninstalled library on Linux. It refuses to replace existing artifacts.
- `node fixtures/migration/verify_lease_guard.mjs` runs the Rust shared trace and
  persisted wire assertions against disposable fixture state.
- `npm run check:no-python` scans tracked and new files for forbidden extensions,
  interpreter entry points and embedded source. It intentionally fails while
  legacy reference sources remain in the checkout.
- `npm run test:remote-tls -- --url https://controller.example --token-file /private/operator.token --ca-file /private/ca.crt`
  is an optional operator-selected, read-only acceptance check. It verifies trusted
  TLS and authenticated inventory; it establishes no native runtime acceptance.
  The optional workflow input uses a public CA and the separately configured
  `CANAVERAL_ACCEPTANCE_TOKEN` Actions secret. No acceptance command deploys a service.

Release publication is separate: `node script/publish_release.mjs` requires
explicit operator authorization, an exact reviewed release tag already on main,
a matching package version, one unfinished draft for that commit, and configured
registry credentials. It validates immutable source labels and content digests
before reusing existing images or publishing a Flux artifact. The portable tests
exercise bundle and validation functions without publishing anything.

Container controllers bind a non-loopback interface and therefore require TLS.
Compose takes `CANAVERAL_TLS_DIRECTORY`, containing `server.crt`, `server.key`,
and `ca.crt`; the dashboard receives only the public CA. Kubernetes takes a
`canaveral-controller-tls` Secret with `tls.crt`/`tls.key` and a separate public
`canaveral-controller-ca` ConfigMap with `ca.crt` in each client namespace. The
server certificate must cover the controller names clients actually use.
Operator/enrollment credentials remain a different Secret or volume. These
inputs are examples requiring operator provisioning, not deployment acceptance.
