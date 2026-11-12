#!/bin/bash
set -euo pipefail
: "${BUILD:?absolute build directory required}"
cd "$BUILD"
cp kernel-build/Image inputs/Image
cp kernel-build/kernel.config inputs/kernel.config
cp rootfs.erofs inputs/rootfs.erofs
cp repo/target/aarch64-unknown-linux-musl/release/canaveral-bootstrap inputs/bootstrap
cp /usr/bin/mkfs.erofs inputs/linux-mkfs.erofs
cp probe-*.txt inputs/
mkdir inputs/packages
find inputs/debs -name '*.deb' -print | sort | while IFS= read -r path; do
  identity=$(dpkg-deb -f "$path" Package)=$(dpkg-deb -f "$path" Version):$(dpkg-deb -f "$path" Architecture)
  digest=$(sha256sum "$path"); digest=${digest%% *}
  cp "$path" "inputs/packages/$digest.deb"
  printf '%s\t%s\n' "$identity" "packages/$digest.deb"
done > inputs/packages.tsv
# The package archive set must equal dpkg's complete installed package set.
cut -f1 inputs/packages.tsv | sort > packages-archive.txt
sort packages.txt > packages-installed.txt
cmp packages-archive.txt packages-installed.txt
for name in canaveral-guest-agent canaveral-bootstrap; do
  readelf -h -l "repo/target/aarch64-unknown-linux-musl/release/$name" > "$name.elf.txt"
  grep -q 'Type:.*EXEC' "$name.elf.txt"
  if grep -E 'INTERP|DYNAMIC' "$name.elf.txt"; then exit 1; fi
done
