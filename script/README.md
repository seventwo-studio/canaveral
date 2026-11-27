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
- `node fixtures/migration/verify_lease_guard.mjs` runs the Rust shared trace and
  persisted wire assertions against disposable fixture state.
- `npm run check:no-python` scans tracked and new files for forbidden extensions,
  interpreter entry points and embedded source. It intentionally fails while
  legacy reference sources remain in the checkout.
- `node script/package_model_runtime.mjs --inputs /absolute/prepared-engine --output /absolute/new-package --os linux --arch x86_64 --entrypoint bin/engine`
  assembles a complete, pinned model runtime package offline. It copies all regular
  single-linked assets, retains executable metadata and includes license files
  present in the input. Add `--base-url https://releases.example/engine/version/`
  to generate a downloadable package descriptor; otherwise the descriptor names
  the bundled output assets. It does not execute, download, install or publish
  an engine. Distribution maintainers must prepare a relocatable dependency
  closure, normalize upstream symlink layouts into regular assets, review license
  notices and include the descriptor in trusted Canaveral release configuration.
  An arbitrary existing runtime installation is not the user setup flow.
- `npm run test:remote-tls -- --url https://controller.example --token-file /private/operator.token --ca-file /private/ca.crt`
  is an optional operator-selected, read-only acceptance check. It verifies trusted
  TLS and authenticated inventory; it establishes no native runtime acceptance.
  The optional workflow input uses a public CA and the separately configured
  `CANAVERAL_ACCEPTANCE_TOKEN` Actions secret. No acceptance command deploys a service.

Release publication is separate from builds. Pushing an authorized stable release
tag starts the publication workflow. It requires a matching root package/lock
version, exact remote tag identity and main ancestry. It creates a missing
exact-commit draft, but rejects duplicate, conflicting or already published
releases. Existing image and Flux artifact identities and digests are checked
before reuse. Portable tests exercise these guards without publishing anything.

Container controllers bind a non-loopback interface and therefore require TLS.
Compose takes `CANAVERAL_TLS_DIRECTORY`, containing `server.crt`, `server.key`,
and `ca.crt`; the dashboard receives only the public CA. Kubernetes takes a
`canaveral-controller-tls` Secret with `tls.crt`/`tls.key` and a separate public
`canaveral-controller-ca` ConfigMap with `ca.crt` in each client namespace. The
server certificate must cover the controller names clients actually use.
Operator/enrollment credentials remain a different Secret or volume. These
inputs are examples requiring operator provisioning, not deployment acceptance.

## Release procedure

The public version is the root npm package version. The private coordination
and dashboard packages have their own versions. Each stable tag identifies one
source revision for its lifetime. The steps below use `0.7.1` as the version.

Stable Flux subscriptions can select a version as soon as the publisher promotes
its deployment artifact. Before publishing a release that removes KubeVirt,
verify that dependent installations are pinned to a compatible release or have
completed their cutover. [Existing KubeVirt installations](../docs/getting-started.md#install-a-release)

1. Merge the reviewed release preparation into main and require green validation
   at the selected full commit. Verify root package.json and package-lock.json,
   including the lockfile root package entry, all declare `0.7.1`.
2. With separate release authorization, create `v0.7.1` on that exact commit and
   push it. This push authorizes automatic publication. An optional pre-existing
   draft must target the full commit SHA, never the string main. The workflow
   otherwise creates an exact-commit draft after validating release identity.
3. To retry a failed unfinished release, dispatch **Publish Canaveral release**
   on the same tag, supplying that tag as input:
   `gh workflow run release.yaml --ref v0.7.1 -f tag=v0.7.1`.
   Dispatch from main or a different tag is rejected, preserving one signing
   identity for automatic and manual runs. No run creates or moves a Git tag.
4. The runner fetches main and checks ancestry, package/lock versions and local
   and remote tag resolution against the immutable workflow event SHA. It builds three repo-scoped GHCR images for
   linux/amd64 and linux/arm64, then a Flux deployment artifact with
   controller, dashboard and canaverald stages. The candidate tag is
   `candidate-0.7.1-FULL_SOURCE_SHA` in `ghcr.io/seventwo-studio/canaveral/deploy`.
   This non-semver staging tag cannot enter the stable subscription. The deployment bundle pins
   each image by digest; kubectl, Flux and Cosign are version-pinned.
5. After attaching signed SLSA provenance for all four digests, the workflow
   signs the deployment manifest at its immutable digest using GitHub OIDC.
   --finalize verifies that signature with the exact issuer and tag-scoped
   workflow identity, revalidates release/registry identity and prepared metadata,
   compares the complete artifact against the rebuilt source with no ignored paths,
   then promotes the same digest to the stable `0.7.1` tag. It confirms promotion,
   uploads release.json and publishes the draft. Reused artifacts get the same
   source-content check; matching annotations alone are insufficient.
   `node script/publish_release.mjs` only prepares artifacts; --finalize is the
   workflow's final step, not a substitute for signing and provenance.

The workflow builds each image under a candidate tag and checks the registry
digest against Buildx metadata. It signs that digest before assigning the
version tag. Its signed image index identifies the build target. Retries
verify that target and the signature from the release workflow's exact tag
identity before reusing a version image.

The publisher exports the lease helper from both platforms of the verified
`canaverald` image index through BuildKit, then hashes the two files. The
**Validate Canaveral** workflow accepts an optional `lease_helper_image` input
such as `ghcr.io/seventwo-studio/canaveral/canaverald@sha256:<digest>`. Use it
to check both helper digests on a runner without publishing a release.

A failed run may leave some immutable images or an unsigned deployment artifact
and an unfinished draft. After a completed push, the publisher makes at most six
manifest readback attempts, two seconds apart, reconnecting each time. Only
absence or transport loss is retried; authentication and malformed evidence fail closed.
The push is never repeated within that operation. Fixed stage names and command
exit statuses identify failures without logging subprocess output or credentials.
Inspect registry state and retry the same exact commit;
matching artifacts are reused and missing artifacts are completed. Identity
mismatches require a new reviewed version. Completed GitHub releases are rejected
on retry, including same-source releases, and are never reopened or overwritten.
A lost final acknowledgement requires inspection rather than another publication.
Never delete a signature or disable verification to recover a failed release.
Stable v* Git tags require administrator-only creation and a separate active
ruleset blocking all updates and deletions, with no bypass. Consumers trust the
tag-scoped workflow identity, so a writer must not be able to tag an unreviewed
replacement workflow. Preserve those repository controls before publication.

CI needs no cluster access or deployment credentials. Publication and portable
validation do not establish installed-cluster or native runtime acceptance.

### Deployment signature contract

Cosign installer v4.1.3 is pinned by commit; Cosign v3.1.4 uses
--new-bundle-format=false and --use-signing-config=false when signing. This
retains legacy registry signatures for older source controllers. Flux
source-controller v1.9.3 checks Sigstore bundle referrers first when present,
and otherwise checks legacy signatures. Signatures and provenance coexist;
the first live consumer must verify the final artifact with all provenance
attached and report SourceVerified=True and Ready=True. A legacy cosign verify
alone does not establish that consumer path.

The certificate issuer is exactly https://token.actions.githubusercontent.com.
For v0.4.1 the certificate subject is exactly:

`https://github.com/seventwo-studio/canaveral/.github/workflows/release.yaml@refs/tags/v0.4.1`

A consumer can poll stable releases with this public source definition. The
matchers are anchored Go regular expressions; omit verify.secretRef for keyless
verification. Narrow ref and subject to one version for a fixed release.

```yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: OCIRepository
metadata:
  name: canaveral-release
spec:
  interval: 5m
  url: oci://ghcr.io/seventwo-studio/canaveral/deploy
  ref:
    semver: '>=0.4.0'
  layerSelector:
    mediaType: application/vnd.cncf.flux.content.v1.tar+gzip
    operation: extract
  verify:
    provider: cosign
    matchOIDCIdentity:
      - issuer: '^https://token[.]actions[.]githubusercontent[.]com$'
        subject: '^https://github[.]com/seventwo-studio/canaveral/[.]github/workflows/release[.]yaml@refs/tags/v(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)$'
```

Require SourceVerified=True with reason Succeeded and Ready=True for the selected
revision before treating the source as admitted. Verification checks the signed
manifest digest, Fulcio certificate chain, issuer/subject and Rekor transparency
log evidence using Sigstore's public trust infrastructure. The stable matcher
trusts this workflow for all stable releases; it does not independently bind the
certificate's tag string to the selected artifact version. Compare release.json,
selected version, source revision and digest for a fixed promotion. Version tags
before 0.4.0 are outside this signing contract.

To verify a fixed digest independently with the pinned Cosign version:

```sh
cosign verify --new-bundle-format=false \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity https://github.com/seventwo-studio/canaveral/.github/workflows/release.yaml@refs/tags/v0.4.1 \
  ghcr.io/seventwo-studio/canaveral/deploy@sha256:<digest>
gh attestation verify oci://ghcr.io/seventwo-studio/canaveral/deploy@sha256:<digest> --repo seventwo-studio/canaveral
```

Actual public signing and Flux reconciliation remain release/operator acceptance
checks; portable tests validate workflow ordering and guards, not live trust or
runtime acceptance. See [Flux keyless verification](https://fluxcd.io/flux/components/source/ocirepositories/#keyless-verification),
[Cosign signing options](https://github.com/sigstore/cosign/blob/v3.1.4/cmd/cosign/cli/options/sign.go)
and the [official installer](https://github.com/sigstore/cosign-installer/tree/756fe2d284c7292c4e9b62c8a28f1e5629c59532).

## Temporary dashboard audit exception

Approved by the project owner on 2026-11-17 for release v0.4.2, expiring at
**2026-11-24 00:00 UTC** (at most seven days).
`node script/check_dashboard_audit.mjs` still runs production and full npm audits.
It excepts only [GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf)
and its reviewed development-only chain: picomatch 4.0.7, fdir 6.5.0,
tinyglobby 0.2.17, Vite 7.3.7 and Vitest 4.1.12. This is risk acceptance, not a fix;
source-checkout builds and CI still execute the affected tools. Dashboard runtime
artifacts contain static output rather than these development dependencies.

The exception pins the entire dashboard lockfile SHA-256, installed versions,
lockfile development-only flags, node paths and advisory propagation edges. All
production advisories, unrelated advisories (including new ones on these packages),
audit failures, unknown reports, changed dependency evidence and expired use fail
closed. CI prints an explicit warning when the exception is used. No generic
package or development-dependency suppression is authorized.

When an official patched release is available, update and re-audit the tooling,
remove the exception and restore the direct full audit in CI. Do not refresh the
lock fingerprint or extend the expiry without a new review and owner approval.
The gate tests run with the existing `npm run test:tools` command.
