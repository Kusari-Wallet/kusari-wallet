#!/usr/bin/env bash
# Downloads Zcash's public Sapling parameters (used by ZEC and ARRR) and checks them against their known hashes.
# Output: native-bin/params/ and native-bin/desktop/ (the desktop build ships them next to zec-bridge.exe).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p native-bin/params native-bin/desktop
fetch() {
  local name="$1" sum="$2"
  curl -fL --retry 3 -o "native-bin/params/$name" "https://download.z.cash/downloads/$name"
  echo "$sum  native-bin/params/$name" | sha256sum -c -
  cp "native-bin/params/$name" "native-bin/desktop/$name"
}
fetch sapling-spend.params 8e48ffd23abb3a5fd9c5589204f32d9c31285a04b78096ba40a79b75677efc13
fetch sapling-output.params 2f0ebbcbb9bb0bcffe95a397e7eba89c29eb4dde6191c339db88570e3f3fb0e4
