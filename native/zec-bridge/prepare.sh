#!/usr/bin/env bash
# Adds the bridge to a checkout of WebZjs at the pinned commit. Run from the repository root: prepare.sh <webzjs dir>
set -euo pipefail
W="$1"
rm -rf "$W/crates/zec-bridge"
cp -r native/zec-bridge "$W/crates/zec-bridge"
rm -f "$W/crates/zec-bridge/prepare.sh"
cd "$W"
grep -q 'crates/zec-bridge' Cargo.toml || sed -i 's|"crates/webzjs-wallet",|"crates/webzjs-wallet",\n    "crates/zec-bridge",|' Cargo.toml
# The Sapling parameters (50 MB, public, checked by hash on load) ship next to the engine rather than inside it.
sed -i 's/"bundled-prover", "multicore"/"local-prover", "multicore"/' Cargo.toml crates/webzjs-wallet/Cargo.toml
F=crates/webzjs-wallet/src/wallet.rs
sed -i 's/pub(crate) db:/pub db:/; s/pub(crate) network:/pub network:/; s/pub(crate) fn usk_from_seed_str/pub fn usk_from_seed_str/' "$F"
sed -i 's/LocalTxProver::bundled()/LocalTxProver::new(std::path::Path::new(\&std::env::var("ZEC_SAPLING_SPEND").unwrap_or_default()), std::path::Path::new(\&std::env::var("ZEC_SAPLING_OUTPUT").unwrap_or_default()))/' "$F"
# Newer releases of this one need a newer compiler than the pinned nightly.
cargo metadata --format-version 1 > /dev/null
cargo update home --precise 0.5.11
