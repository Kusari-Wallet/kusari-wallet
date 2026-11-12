# Kusari coin (a Monero fork)

Kusari (KUS) is Monero's code with its own chain: its own genesis block, network ids, address prefixes and ports, and no
Monero history, checkpoints, seed nodes or update servers. Everything else is Monero's v0.18.5.4 as released: RandomX
mining, ring signatures (CLSAG, ring size 16), Bulletproofs+, view tags, stealth addresses and subaddresses, the same
emission curve with its tail emission, the same 25-word seeds and the same RPC.

Monero's source isn't stored here. `prepare.js` changes a checkout of Monero's pinned tag, and every change has to
match the code exactly once, so a different Monero version stops with an error instead of building something half
changed.

## What changes

| | Monero | Kusari |
|---|---|---|
| Addresses (mainnet) | `4…`, subaddresses `8…` | `K…`, subaddresses `L…` |
| Testnet / stagenet addresses | `9…` / `5…` | `C…` / `F…` |
| Ports (P2P, RPC, ZMQ) | 18080, 18081, 18082 | 21080, 21081, 21082 |
| Network id, genesis | Monero's | new, in `params.json` |
| Hard forks | v1 … v16 over 2014–2022 | v1 … v16 on blocks 1 … 16, one block each |
| Checkpoints, compiled block hashes | Monero's | none |
| Seed nodes, DNS seeds, Tor/I2P seeds | Monero's | none until you add your own |
| Update check | moneropulse DNS, on | none, off |
| Message signatures | `MoneroMessageSignature` | `KusariMessageSignature` |
| Data folder, binaries | `~/.bitmonero`, `monerod`, `monero-wallet-cli`, `monero-wallet-rpc` | `~/.kusari`, `kusarid`, `kusari-wallet-cli`, `kusari-wallet-rpc` |

The genesis output goes to a key whose secret was thrown away when `make-params.js` ran, so there is no premine and
nobody can spend it. Blocks 1 to 15 step through Monero's versions 1 to 15, one block each, and from block 16 the chain
uses version 16. Skipping versions would be simpler, but Monero's wallet looks the fork table up by version number and
refuses blocks when one is missing.

Changing the hash domain separators (`SubAddr`, `CLSAG_*` and the others) is not needed for a chain with its own
genesis, and they are kept so Monero libraries keep working with only the prefixes changed.

## Files

- `params.json`: the chain. Everything here is consensus: changing any of it after launch makes a different chain.
- `make-params.js`: writes a fresh `params.json` (network ids, genesis transactions, fork times). Run once before
  launch. It refuses to overwrite without `--force`.
- `prepare.js`: applies `params.json` to a Monero checkout.
- `selftest.js`: with the built binaries, starts an offline private mainnet from the genesis and mines past the switch
  to version 16 at block 16, then on regtest (same code, genesis and prefixes, fixed difficulty) mines 120 blocks and sends 1 KUS
  from one wallet to another wallet's subaddress. Real difficulty follows the 2-minute target, so mining enough
  unlocked outputs for a ring of 16 on mainnet would take hours.
- `lib.js`: Monero's base58, Keccak-256, varints and the genesis transaction layout, in plain Node.

## Building

```
git clone --depth 1 --branch v0.18.5.4 --recurse-submodules --shallow-submodules https://github.com/monero-project/monero kusari
node native/kusari-coin/prepare.js kusari
cmake -S kusari -B kusari/build -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTS=OFF -DUSE_DEVICE_TREZOR=OFF -DMANUAL_SUBMODULES=1
cmake --build kusari/build --target daemon simplewallet wallet_rpc_server -j 4
node native/kusari-coin/selftest.js kusari/build/bin
```

The dependencies are Monero's (on Ubuntu: `build-essential cmake pkg-config libboost-all-dev libssl-dev libzmq3-dev
libunbound-dev libsodium-dev libunwind8-dev liblzma-dev libreadline-dev libexpat1-dev libhidapi-dev libusb-1.0-0-dev
libudev-dev`). `.github/workflows/kusari-coin.yml` does all of this when started by hand and uploads the binaries.

Monero's own unit tests are not built: many of them check Monero's genesis, checkpoints and fork heights.

## Before a public launch

1. Run `node native/kusari-coin/make-params.js --force` once more so the genesis and fork times are the launch day's,
   commit `params.json`, and never change it again.
2. Put two or more always-on nodes in `seedNodes` (`"host:21080"`), so new nodes can find the network. Without them
   every node has to be given peers with `--add-peer` or `--seed-node`.
3. Mine from the start yourself, or announce the launch time so others can. A new chain with little hashrate can be
   rewritten by anyone with more, so wait for real hashrate before anyone treats coins as final.
4. The wallet app does not list KUS yet. `monero-ts` reads Monero's prefixes from its WebAssembly build, so KUS in the
   app needs `monero-ts` built from this source, a public `kusarid` node and its own coin entry.
5. A Monero hard fork needs the same work here: move the tag in `params.json`, rerun `prepare.js`, and add the new
   version to `hardForks` at a future height.
