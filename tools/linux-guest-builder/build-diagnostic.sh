#!/bin/bash
# Diagnostic-only initrd, deliberately outside the lease bundle.
set -euo pipefail
recipe_dir=$(cd "$(dirname "$0")" && pwd)
: "${OUTPUT:?new output directory required}"
mkdir "$OUTPUT"
cc -static -no-pie -Os "$recipe_dir/diagnostic-init.c" -o "$OUTPUT/diagnostic-init"
if readelf -l "$OUTPUT/diagnostic-init" | grep -q INTERP; then exit 1; fi
mkdir -p "$OUTPUT/tree/dev" "$OUTPUT/tree/sys"
cp "$OUTPUT/diagnostic-init" "$OUTPUT/tree/init"
chmod 500 "$OUTPUT/tree/init"
find "$OUTPUT/tree" -exec touch -h -d @1793491200 {} +
(cd "$OUTPUT/tree"; printf '%s\n' dev init sys | cpio -o -H newc --reproducible --owner=0:0) > "$OUTPUT/DIAGNOSTIC-ONLY.cpio"
