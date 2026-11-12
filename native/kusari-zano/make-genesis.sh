#!/usr/bin/env bash
# Makes Kusari's genesis transaction, once, with Zano's own tool: one output of params.genesis.amount KUS to the burn
# address in params.json, and the proof phrase. The files land in native/kusari-zano/genesis/ and are committed.
#   node native/kusari-zano/prepare.js <zano checkout> --bootstrap
#   (build connectivity_tool in <zano checkout>/build)
#   bash native/kusari-zano/make-genesis.sh <zano checkout>/build/src/connectivity_tool
set -euo pipefail
TOOL="$1"
KIT="$(cd "$(dirname "$0")" && pwd)"
OUT="$KIT/genesis"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
node -e '
const p = require(process.argv[1]);
const cfg = { payments: [{ address_this: p.genesis.burnAddress, amount_this_coin_fl: p.genesis.amount, paid_prm: "0", prm_usd_price: "0" }], proof_string: p.genesis.proof };
require("fs").writeFileSync(process.argv[2], JSON.stringify(cfg, null, 2));
' "$KIT/params.json" "$WORK/genesis.json"
"$TOOL" --generate-genesis "$WORK/genesis.json" > "$WORK/log.txt" 2>&1 || { cat "$WORK/log.txt"; exit 1; }
mkdir -p "$OUT"
cp "$WORK/genesis.json" "$OUT/genesis.json"
cp "$WORK/genesis.json.genesis.txt" "$OUT/genesis.txt"
cp "$WORK/genesis.json.genesis.uint64.array.txt" "$OUT/genesis.uint64.array.txt"
cp "$WORK/genesis.json.genesis.dictionary.txt" "$OUT/genesis.dictionary.txt"
echo "genesis written to $OUT"
