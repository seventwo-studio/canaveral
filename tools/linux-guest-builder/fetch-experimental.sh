#!/bin/bash
# Experimental TLS-acquired trust material; production trust approval stays false.
set -euo pipefail
mkdir inputs
cd inputs
fetch() { curl -fLS --retry 2 --max-time 600 "$1" -o "$2"; }
fetch https://cdn.kernel.org/pub/linux/kernel/v6.x/sha256sums.asc kernel-sha256sums.asc
fetch https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-6.12.117.tar.xz linux-6.12.117.tar.xz
fetch https://nodejs.org/dist/v24.11.0/SHASUMS256.txt.asc node-sums.asc
fetch https://nodejs.org/dist/v24.11.0/node-v24.11.0-linux-arm64.tar.xz node-v24.11.0-linux-arm64.tar.xz
for file in rust-1.99.1-aarch64-unknown-linux-gnu.tar.xz rust-std-1.99.1-aarch64-unknown-linux-musl.tar.xz; do
  fetch "https://static.rust-lang.org/dist/$file" "$file"
done
printf '%s\n' \
 '74e99aa5e60e242e0a165fed8cb2ea0d054bf7a401f01861d403d75733456613  linux-6.12.117.tar.xz' \
 '33a6673b2c7bffeae9deec7f9f8b31aad9119b08f13d49b2ca3ee3bebfe8260f  node-v24.11.0-linux-arm64.tar.xz' \
 'a48fb1e853be56ce9b8e2751f5464dbd5e16440cd81e237920f3a5e7e806333e  rust-1.99.1-aarch64-unknown-linux-gnu.tar.xz' \
 '2f3eb0d0610e2b7f6b2121d106e2490ac648decfa0c09b30873bdfc60de6c1ab  rust-std-1.99.1-aarch64-unknown-linux-musl.tar.xz' | sha256sum -c -
