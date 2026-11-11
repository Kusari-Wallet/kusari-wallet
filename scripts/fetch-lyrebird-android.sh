#!/usr/bin/env bash
# Takes lyrebird (Snowflake, obfs4, webtunnel) and its default bridge list from the Tor Project's own Android
# expert bundles, after checking their signature against the Tor Browser signing key.
# Output: android/jniLibs/<abi>/liblyrebird.so and android/pt_config.json. Android only runs executables from
# the app's native library folder, which is why the program carries a .so name.
# Usage: TOR_VERSION=16.0.1 scripts/fetch-lyrebird-android.sh   Needs: curl, gpg, tar.
set -euo pipefail
VERSION="${TOR_VERSION:?Tor Browser version, e.g. 16.0.1}"
FPR=EF6E286DDA85EA2A4BA7DE684E2C6E8793298290
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
export GNUPGHOME="$WORK/gnupg"; mkdir -m 700 "$GNUPGHOME"
curl -fsS "https://keys.openpgp.org/vks/v1/by-fingerprint/$FPR" | gpg --quiet --import
for pair in aarch64:arm64-v8a armv7:armeabi-v7a; do
  arch="${pair%%:*}"; abi="${pair##*:}"
  name="tor-expert-bundle-android-$arch-$VERSION.tar.gz"
  curl -fsS -o "$WORK/$name" "https://dist.torproject.org/torbrowser/$VERSION/$name"
  curl -fsS -o "$WORK/$name.asc" "https://dist.torproject.org/torbrowser/$VERSION/$name.asc"
  gpg --status-fd 1 --verify "$WORK/$name.asc" "$WORK/$name" 2>/dev/null | grep -Eq "^\[GNUPG:\] VALIDSIG .* $FPR$" || { echo "bad signature: $name" >&2; exit 1; }
  mkdir -p "$WORK/$arch" "$ROOT/android/jniLibs/$abi"
  tar xzf "$WORK/$name" -C "$WORK/$arch" tor/pluggable_transports/lyrebird tor/pluggable_transports/pt_config.json
  install -m 755 "$WORK/$arch/tor/pluggable_transports/lyrebird" "$ROOT/android/jniLibs/$abi/liblyrebird.so"
  install -m 644 "$WORK/$arch/tor/pluggable_transports/pt_config.json" "$ROOT/android/pt_config.json"
  echo "$abi: lyrebird $(du -h "$ROOT/android/jniLibs/$abi/liblyrebird.so" | cut -f1)"
done
echo "lyrebird from tor-expert-bundle-android $VERSION" > "$ROOT/android/jniLibs/LYREBIRD.txt"
