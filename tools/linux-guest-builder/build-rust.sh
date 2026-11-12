#!/bin/bash
set -euo pipefail
RECIPE_DIR="$(cd "$(dirname "$0")" && pwd)"
: "${BUILD:?absolute build directory required}"
cd "$BUILD"
INPUTS="$BUILD/inputs" bash "$RECIPE_DIR/verify-build-inputs.sh"
mkdir rust
for name in rust-1.99.1-aarch64-unknown-linux-gnu rust-std-1.99.1-aarch64-unknown-linux-musl; do
  tar -xf "inputs/$name.tar.xz"
  bash "$name/install.sh" --prefix="$BUILD/rust" --without=rust-docs
done
export PATH="$BUILD/rust/bin:$PATH" CARGO_BUILD_JOBS=2
export RUSTFLAGS='-C target-feature=+crt-static -C relocation-model=static'
cd repo
cargo build --locked --release --target aarch64-unknown-linux-musl -p canaveral-guest-agent
cargo build --locked --release --target aarch64-unknown-linux-musl -p canaveral-boot-bundle --bin canaveral-bootstrap
for name in canaveral-guest-agent canaveral-bootstrap; do
  binary="target/aarch64-unknown-linux-musl/release/$name"
  readelf -h -l "$binary" > "$BUILD/$name.elf.txt"
  grep -q 'Type:.*EXEC' "$BUILD/$name.elf.txt"
  if grep -E 'INTERP|DYNAMIC' "$BUILD/$name.elf.txt"; then exit 1; fi
done
