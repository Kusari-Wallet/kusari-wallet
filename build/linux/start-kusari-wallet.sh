#!/bin/sh
# Starts Kusari Wallet on Linux. Chromium keeps each page in a sandbox. Where the system doesn't let apps make
# that sandbox themselves (Ubuntu 24.04 and later, some others), its helper must belong to root, which a
# download can't carry. This sets that up once, asking for your password, instead of running without a sandbox.
DIR="$(cd "$(dirname "$0")" && pwd)"
SB="$DIR/chrome-sandbox"
restricted=0
[ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" = "1" ] && restricted=1
[ "$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null)" = "0" ] && restricted=1
if [ "$restricted" = "1" ] && [ "$(stat -c %u:%a "$SB" 2>/dev/null)" != "0:4755" ]; then
  echo "Kusari Wallet needs its sandbox helper set up once. Your password is asked for this only."
  FIX="chown root:root '$SB' && chmod 4755 '$SB'"
  if command -v pkexec >/dev/null 2>&1; then pkexec sh -c "$FIX"; else sudo sh -c "$FIX"; fi || {
    echo "Could not set up the sandbox helper. Run this once, then start again:"
    echo "  sudo chown root:root '$SB' && sudo chmod 4755 '$SB'"
    exit 1
  }
fi
exec "$DIR/kusari-wallet" "$@"
