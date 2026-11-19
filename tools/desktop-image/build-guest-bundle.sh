#!/bin/bash
# Builds the ARM64 guest service bundle that hosts install into each desktop VM
# during preparation. Run from a checkout on ARM64 Linux with the pinned Rust
# toolchain and Node 24. The AT-SPI helper loads the guest's glibc libatspi at
# run time, so both helpers target glibc rather than static MUSL.
set -euo pipefail
out=${1:?usage: build-guest-bundle.sh OUTPUT.json}
[[ $(uname -sm) == 'Linux aarch64' ]] || { echo 'Requires ARM64 Linux' >&2; exit 1; }
[[ ! -e $out ]] || { echo 'Choose a new output path' >&2; exit 1; }
repo=$(cd "$(dirname "$0")/../.." && pwd)
out=$(realpath -m "$out")
cargo build --manifest-path "$repo/Cargo.toml" --locked --release -p canaveral-guest-agent -p canaveral-mobile-native
target=$(cargo metadata --manifest-path "$repo/Cargo.toml" --format-version 1 --no-deps | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).target_directory))')
node "$repo/script/build_guest_bundle.mjs" --arch arm64 \
  --native-helper "$target/release/canaveral-mobile-native" \
  --atspi-helper "$target/release/canaveral-guest-agent" \
  --output "$out"
