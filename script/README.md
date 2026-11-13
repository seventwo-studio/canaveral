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

## Release procedure

The next source release is 0.3.0. Internal coordination/dashboard npm packages
keep their independent private 0.1.0 versions; package checks do not couple them
to the root version. Do not reuse historical 0.2.2 registry tags after the history
rewrite: immutable identity checks intentionally reject another source revision.

1. Merge the reviewed change into `main` and require green validation at the
   selected full commit. Verify root `package.json` and lockfile match the release.
2. With separate release authorization, create `v0.3.0` on that exact commit and
   push the tag. Create one **draft** GitHub release with that tag and set its
   target to the full commit SHA (not the string `main`). Add reviewed notes.
3. Dispatch **Publish Canaveral release** from `main`, supplying `v0.3.0`.
   The GitHub-hosted runner checks out that tag, verifies its main ancestry and
   draft identity, and uses `GITHUB_TOKEN` with contents/package write permission.
   Docker buildx and QEMU build `linux/amd64,linux/arm64`; kubectl and Flux are
   version-pinned with verified checksums. No cluster credentials are needed.
4. The script publishes `ghcr.io/seventwo-studio/canaveral`, `canaveral-dashboard`
   and `canaveral-kubevirt`, all under the `seventwo-studio` owner. It pins their
   version/digests into the namespace-free `orchestrator/`, `dashboard/` and
   `kubevirt/` Kustomizations, publishes `deploy-0.3.0` as a Flux OCI artifact,
   uploads `release.json` and publishes the draft. Review the metadata/digests
   before selecting them in an installation-specific GitOps overlay.

Dispatch is publication authorization, not a preview. No workflow run creates a
release tag or deploys to Kubernetes. A failed run may have published some images;
inspect the registry and draft before retrying the same exact commit. Identity
mismatches require a new reviewed version, never overwriting an old tag. Release
publication and portable validation do not establish installed-cluster acceptance.
