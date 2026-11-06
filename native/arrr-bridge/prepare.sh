#!/usr/bin/env bash
# Adds the bridge to a checkout of Pirate's Stashi wallet at the pinned commit. Run from the repository root.
set -euo pipefail
W="$1"
rm -rf "$W/crates/arrr-bridge"
cp -r native/arrr-bridge "$W/crates/arrr-bridge"
rm -f "$W/crates/arrr-bridge/prepare.sh"
cd "$W"
grep -q 'crates/arrr-bridge' crates/Cargo.toml 2>/dev/null || true
if [ -f crates/Cargo.toml ] && ! grep -q '"arrr-bridge"' crates/Cargo.toml; then
  sed -i '0,/^members = \[/s//members = [\n    "arrr-bridge",/' crates/Cargo.toml
fi
