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

The next source release is 0.4.0. Internal coordination/dashboard npm packages
keep their independent private 0.1.0 versions. Historical version tags are not
reused: immutable identity guards reject another source revision.

1. Merge the reviewed release preparation into main and require green validation
   at the selected full commit. Verify root package.json and package-lock.json,
   including the lockfile root package entry, all declare 0.4.0.
2. With separate release authorization, create v0.4.0 on that exact commit and
   push it. This push authorizes automatic publication. An optional pre-existing
   draft must target the full commit SHA, never the string main. The workflow
   otherwise creates an exact-commit draft after validating release identity.
3. To retry a failed unfinished release, dispatch **Publish Canaveral release**
   on the same tag, supplying that tag as input:
   `gh workflow run release.yaml --ref v0.4.0 -f tag=v0.4.0`.
   Dispatch from main or a different tag is rejected, preserving one signing
   identity for automatic and manual runs. No run creates or moves a Git tag.
4. The runner fetches main and checks ancestry, package/lock versions and local
   and remote tag resolution. It builds three repo-scoped GHCR images for
   linux/amd64 and linux/arm64, then a namespace-free Flux deployment artifact
   at ghcr.io/seventwo-studio/canaveral/deploy:0.4.0. The deployment bundle pins
   each image by digest; kubectl, Flux and Cosign are version-pinned.
5. The workflow signs the deployment manifest at its immutable digest using
   GitHub OIDC, verifies that signature with the exact issuer and tag-scoped
   workflow identity, and retains signed SLSA provenance for all four digests.
   Only after those steps succeed does --finalize revalidate release/registry
   identity and prepared metadata, upload release.json and publish the draft.
   `node script/publish_release.mjs` only prepares artifacts; --finalize is the
   workflow's final step, not a substitute for signing and provenance.

A failed run may leave some immutable images or an unsigned deployment artifact
and an unfinished draft. Inspect registry state and retry the same exact commit;
matching artifacts are reused and missing artifacts are completed. Identity
mismatches require a new reviewed version. Completed GitHub releases are rejected
on retry, including same-source releases, and are never reopened or overwritten.
A lost final acknowledgement requires inspection rather than another publication.
Never delete a signature or disable verification to recover a failed release.

CI needs no cluster access or deployment credentials. Publication and portable
validation do not establish installed-cluster or native runtime acceptance.

### Deployment signature contract

Cosign installer v4.1.3 is pinned by commit; Cosign v3.1.4 uses
--new-bundle-format=false and --use-signing-config=false when signing. This
retains the legacy registry signature format consumed by Flux source-controller
v1.7.x (including v1.7.4), rather than relying on newer Sigstore bundle support.
Signatures and provenance attestations coexist; GitHub build provenance alone
is not an OCIRepository Cosign signature.

The certificate issuer is exactly https://token.actions.githubusercontent.com.
For v0.4.0 the certificate subject is exactly:

`https://github.com/seventwo-studio/canaveral/.github/workflows/release.yaml@refs/tags/v0.4.0`

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
  --certificate-identity https://github.com/seventwo-studio/canaveral/.github/workflows/release.yaml@refs/tags/v0.4.0 \
  ghcr.io/seventwo-studio/canaveral/deploy@sha256:<digest>
gh attestation verify oci://ghcr.io/seventwo-studio/canaveral/deploy@sha256:<digest> --repo seventwo-studio/canaveral
```

Actual public signing and Flux reconciliation remain release/operator acceptance
checks; portable tests validate workflow ordering and guards, not live trust or
runtime acceptance. See [Flux keyless verification](https://fluxcd.io/flux/components/source/ocirepositories/#keyless-verification),
[Cosign signing options](https://github.com/sigstore/cosign/blob/v3.1.4/cmd/cosign/cli/options/sign.go)
and the [official installer](https://github.com/sigstore/cosign-installer/tree/756fe2d284c7292c4e9b62c8a28f1e5629c59532).
