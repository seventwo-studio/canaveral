#!/bin/bash
set -euo pipefail
: "${OUTPUT:?new host build directory required}"
test "$(uname -s)" = Darwin
mkdir "$OUTPUT"
cd "$OUTPUT"
curl -fLS https://deb.debian.org/debian/pool/main/e/erofs-utils/erofs-utils_1.8.6.orig.tar.gz -o erofs-utils-1.8.6.tar.gz
printf '%s  %s\n' 5b221dc3fd6d151425b30534ede46fb7a90dc233a8659cba0372796b0a066547 erofs-utils-1.8.6.tar.gz | shasum -a256 -c -
tar -xf erofs-utils-1.8.6.tar.gz
cd erofs-utils-1.8.6
./autogen.sh
./configure --disable-lz4 --disable-lzma --without-libzstd --without-zlib --disable-fuse
make -j2
env -i "$PWD/mkfs/mkfs.erofs" --version
otool -L mkfs/mkfs.erofs
