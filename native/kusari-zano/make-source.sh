#!/usr/bin/env bash
# Makes a source archive of Kusari that builds without git: Zano at the pinned tag with every Kusari change applied,
# RandomX at the pinned commit in contrib/randomx, and no .git folders.
#   bash native/kusari-zano/make-source.sh <zano checkout at the pinned tag, with submodules> <output.tar.gz>
set -euo pipefail
SRC="$(cd "$1" && pwd)"
OUT="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
KIT="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
RX_COMMIT="$(node -p "require('$KIT/params.json').randomx.commit")"
RX_REPO="$(node -p "require('$KIT/params.json').randomx.repo")"

# libmdbx reads its version from git, the way it would in a clone of Zano, so it is read here, before .git goes.
MDBX="$(cd "$SRC/contrib/db/libmdbx" && git describe --tags --long | sed -E 's/^v?([0-9]+)\.([0-9]+)\.([0-9]+).*/\1.\2.\3/').$(cd "$SRC/contrib/db/libmdbx" && git rev-list --count --no-merges HEAD)"

cp -r "$SRC" "$WORK/kusari"
rm -rf "$WORK/kusari/build" "$WORK/kusari/contrib/randomx"
git clone -q "$RX_REPO" "$WORK/kusari/contrib/randomx"
git -C "$WORK/kusari/contrib/randomx" checkout -q "$RX_COMMIT"
node "$KIT/prepare.js" "$WORK/kusari"

# Without .git, libmdbx takes its version from a VERSION file, and only looks at git when there is none.
echo "$MDBX" > "$WORK/kusari/contrib/db/libmdbx/VERSION"
UTILS="$WORK/kusari/contrib/db/libmdbx/cmake/utils.cmake"
grep -q '^  if(GIT)$' "$UTILS"
sed -i 's|^  if(GIT)$|  if(GIT AND NOT EXISTS "${version_file}")|' "$UTILS"

find "$WORK/kusari" -name .git -prune -exec rm -rf {} +
tar -C "$WORK" -czf "$OUT" kusari
echo "wrote $OUT (libmdbx $MDBX)"
