#!/bin/bash
# Experimental trust acquisition; authenticate exact executable source inputs.
set -euo pipefail
: "${INPUTS:?absolute authenticated input directory required}"
cd "$INPUTS"
export GNUPGHOME="$INPUTS/build-input-keyring"
mkdir -p "$GNUPGHOME"
chmod 700 "$GNUPGHOME"
fetch() { test -f "$2" || curl -fLS --retry 2 --max-time 600 "$1" -o "$2"; }
fetch https://static.rust-lang.org/rust-key.gpg.ascii rust-key.asc
gpg --batch --import rust-key.asc
for name in rust-1.99.1-aarch64-unknown-linux-gnu rust-std-1.99.1-aarch64-unknown-linux-musl; do
  fetch "https://static.rust-lang.org/dist/$name.tar.xz.asc" "$name.tar.xz.asc"
  gpg --batch --status-fd 3 --verify "$name.tar.xz.asc" "$name.tar.xz" 3>"$name.status"
  grep -q '^\[GNUPG:\] VALIDSIG 108F66205EAEB0AAA8DD5E1C85AB96E6FA1BE5FE ' "$name.status"
done
# Debian archive keys are supplied by the authenticated builder image/apt chain.
: "${DEBIAN_ARCHIVE_KEYRING:=/usr/share/keyrings/debian-archive-keyring.gpg}"
fetch https://deb.debian.org/debian/dists/trixie/Release erofs-Release
fetch https://deb.debian.org/debian/dists/trixie/Release.gpg erofs-Release.gpg
gpgv --keyring "$DEBIAN_ARCHIVE_KEYRING" --status-fd 3 erofs-Release.gpg erofs-Release 3>erofs-release.status
fetch https://deb.debian.org/debian/dists/trixie/main/source/Sources.xz erofs-Sources.xz
awk '$3=="main/source/Sources.xz" && length($1)==64 {print $1 "  erofs-Sources.xz"; found=1} END {if (!found) exit 1}' erofs-Release | shasum -a256 -c -
xz -dc erofs-Sources.xz > erofs-Sources
# Match exact package/version, then authenticate its .dsc through Sources SHA256.
awk 'BEGIN {RS=""} /^Package: erofs-utils\n/ && /\nVersion: 1.8.6-1\n/ {print; found=1} END {if (!found) exit 1}' erofs-Sources > erofs-source-entry
fetch https://deb.debian.org/debian/pool/main/e/erofs-utils/erofs-utils_1.8.6-1.dsc erofs-utils_1.8.6-1.dsc
awk '/^Checksums-Sha256:/ {section=1; next} section && /^[^ ]/ {section=0} section && $3=="erofs-utils_1.8.6-1.dsc" {print $1 "  " $3; found=1} END {if (!found) exit 1}' erofs-source-entry | shasum -a256 -c -
fetch https://deb.debian.org/debian/pool/main/e/erofs-utils/erofs-utils_1.8.6.orig.tar.gz erofs-utils-1.8.6.tar.gz
awk '/^Checksums-Sha256:/ {section=1; next} section && /^[^ ]/ {section=0} section && $3=="erofs-utils_1.8.6.orig.tar.gz" {print $1 "  erofs-utils-1.8.6.tar.gz"; found=1} END {if (!found) exit 1}' erofs-utils_1.8.6-1.dsc | shasum -a256 -c -
# Pins are additional constraints, never substitutes for signature authentication.
printf '%s\n' \
 'a48fb1e853be56ce9b8e2751f5464dbd5e16440cd81e237920f3a5e7e806333e  rust-1.99.1-aarch64-unknown-linux-gnu.tar.xz' \
 '2f3eb0d0610e2b7f6b2121d106e2490ac648decfa0c09b30873bdfc60de6c1ab  rust-std-1.99.1-aarch64-unknown-linux-musl.tar.xz' \
 '5b221dc3fd6d151425b30534ede46fb7a90dc233a8659cba0372796b0a066547  erofs-utils-1.8.6.tar.gz' | shasum -a256 -c -
