# Base image registry

Accepted requirement and local implementation, 2026-11-02. The registry is a
curated catalogue of official publisher sources, distinct from host-installed
images and captured images. Open **Images → Base image registry** to search by
OS/architecture, select a host and import a base artifact. Installer media stays
separate from installed boot disks. Registry entries do not create VMs or establish
that an installer console or guest-control adapter is available.

## Sources

- macOS: the signed Apple runner asks `VZMacOSRestoreImage.latestSupported` for a
  restore archive supported by that Mac. It records OS/build and uses the returned
  Apple CDN URL. ARM64 and Apple hardware are required.
- Ubuntu: LTS 24.04/26.04 desktop/server ISOs and Ubuntu 24.04 installed cloud disks,
  for x86-64 and ARM64. Current filenames and SHA-256 identities come from the
  publisher's checksum manifests. Missing architecture/release variants fail
  explicitly rather than substituting another image.
- Debian: stable netinst ISOs for x86-64 and ARM64, resolved from official checksum
  manifests. The downloader allows Debian's observed official redirect to
  `chuangtzu.ftp.acc.umu.se`; unrelated redirect origins are rejected.
- Fedora Workstation: the official release feed selects the newest numeric stable
  release with an ISO for the requested architecture. Beta, RC and compressed disk
  formats do not silently replace a stable ISO. Downloads use Fedora's own origin.
- Windows 11 installation/evaluation media: links to Microsoft for edition,
  language, registration and download, then prefilled file import. The former
  Windows development-VM URL redirected to developer-tools documentation when
  checked on 2026-11-02, so that prebuilt entry is marked unavailable. Existing
  licensed VHDX images can still be imported. The registry does not invent a direct
  link, accept terms, acquire a license or claim Windows runtime readiness.

Official source references:
[Apple restore API](https://developer.apple.com/documentation/virtualization/vzmacosrestoreimage/latestsupported),
[Ubuntu releases](https://releases.ubuntu.com/24.04/),
[Ubuntu cloud images](https://cloud-images.ubuntu.com/noble/current/),
[Debian media](https://www.debian.org/CD/),
[Fedora Workstation](https://fedoraproject.org/workstation/download/),
[Windows ARM64 ISO](https://www.microsoft.com/en-us/software-download/windows11arm64),
[Windows Enterprise evaluation](https://www.microsoft.com/en-us/evalcenter/evaluate-windows-11-enterprise),
[former Windows development-VM page](https://developer.microsoft.com/en-us/windows/downloads/virtual-machines/).

## Resolution, reservation and publication

`GET /v1/image-registry` lists curated entries. An account/operator creates an
idempotent intent with `POST /v1/image-registry/imports` containing caller UUID
`id`, `registryId` and `hostId`, with optional `name` and Linux-disk `guestAccess`.
Arbitrary download URLs are not accepted. Application and runner credentials
cannot create these administrative imports.

The assigned host resolves the channel once. It authenticates a source resolution
at `POST /v1/hosts/{host}/image-tasks/{task}/resolve`, containing pinned official URL,
version, byte length and publisher SHA-256 when supplied. This endpoint accepts only
that host's credential and owned registry task. The controller reserves the actual
artifact length in the host disk limit before any payload copy. Identical retries
return the original resolved source; changed metadata cannot replace it.

The host streams bounded chunks directly into the immutable image library. Linux
imports must match the pinned publisher SHA-256 before publication. The checksum
manifest is fetched over verified HTTPS; detached GPG signature verification is not
implemented and is not claimed. Apple's restore API supplies no SHA-256 here: its
source is recorded as the native API's Apple HTTPS URL, while Canaveral computes
its own immutable content hash. Apple installer validation remains a separate step.

An identical local artifact can supply the bytes without another network download.
Completed artifacts have registry ID/version/source provenance and become offered
only after controller acknowledgement. Image storage is charged once per host,
content hash and format. There is no application-defined per-image download limit;
validated integer length and available host disk capacity still apply.

The task and started download receipt survive restart. Verified published manifests
can recover a lost final report. An interrupted copy with uncertain cleanup becomes
unknown and retains its reservation. It is not automatically replayed. A checksum
failure with confirmed temporary cleanup never publishes an image. Downloads stop
when the host loses controller authorization/contact; uncertain outcomes remain
visible in Image activity. Closing the registry continues an accepted import in
background. Cancellation/resume and custom publisher editing are not implemented.

## Verified local evidence

On 2026-11-02 the official Ubuntu ARM64 cloud image imported through the registry,
matched its publisher SHA-256 and registered provenance without creating a VM.
The host reused its identical 616,522,752-byte artifact. Debian/Fedora ARM64 and
macOS source resolution/length checks passed without downloading their payloads.
The rebuilt signed Apple runner resolved a supported restore image on this Mac.
This does not establish completed macOS installation, ISO installer interaction or
Windows guest control. Those remain the [image workflow](images.md) and platform
acceptance gates.
