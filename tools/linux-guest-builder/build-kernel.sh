#!/bin/bash
# Run as an unprivileged Linux arm64 builder user after signature verification.
set -euo pipefail
: "${INPUTS:?verified source directory required}" "${OUTPUT:?new build directory required}"
test "$(uname -m)" = aarch64
recipe_dir=$(cd "$(dirname "$0")" && pwd)
mkdir "$OUTPUT"
cd "$OUTPUT"
printf '%s  %s\n' 74e99aa5e60e242e0a165fed8cb2ea0d054bf7a401f01861d403d75733456613 "$INPUTS/linux-6.12.117.tar.xz" | sha256sum -c -
tar -xf "$INPUTS/linux-6.12.117.tar.xz"
cd linux-6.12.117
make ARCH=arm64 allnoconfig
cp "$recipe_dir/arm64.config" .config
make ARCH=arm64 olddefconfig
# Missing or renamed Kconfig options fail rather than silently produce modules.
while IFS= read -r line; do
  case "$line" in CONFIG_*=y) grep -qxF "$line" .config || { echo "missing built-in: $line" >&2; exit 1; };; esac
done < "$recipe_dir/arm64.config"
while IFS= read -r line; do
  grep -qxF "$line" .config || { echo "unexpected enabled option: $line" >&2; exit 1; }
done < <(grep '^# CONFIG_.* is not set$' "$recipe_dir/arm64.config")
export KBUILD_BUILD_USER=builder KBUILD_BUILD_HOST=canaveral KBUILD_BUILD_VERSION=1
export KBUILD_BUILD_TIMESTAMP='2026-11-01 00:00:00 UTC' SOURCE_DATE_EPOCH=1793491200
make -j4 ARCH=arm64 Image
cp arch/arm64/boot/Image ../Image
cp .config ../kernel.config
