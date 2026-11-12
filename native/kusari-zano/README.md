# Kusari (KSR)

Kusari is a privacy coin with its own chain, built from Zano's code (v2.2.0.490) with parts of Monero's design.

- From Zano: ring signatures (CLSAG, 15 decoys), stealth addresses and hidden amounts, confidential assets (tokens
  whose amounts and type are hidden), aliases (`@name`), escrow contracts, proof of stake (Zarcanum), the wallet and
  its RPC.
- From Monero: the RandomX proof of work, the emission curve with a tail, and Dandelion++ transaction relay.

Neither source is stored here. `prepare.js` changes a checkout of Zano's pinned tag, and every change has to match
the code exactly once, so another Zano version stops with an error instead of building something half changed.

## The chain

| | |
|---|---|
| Ticker, decimals | KSR, 12 |
| Addresses | `K…` (auditable `L…`, gateway `M…`) |
| Ports (P2P, RPC, stratum) | 21080, 21081, 21082 |
| Block time | 1 minute on average, all the way |
| Proof of work | RandomX with Kusari's parameters ("RandomKSR"), on CPUs |
| Proof of stake | off until block 129,600 (about 90 days), then on |
| Emission | Monero's: block 1 pays 17.59 KSR, falling smoothly; the main emission ends at block 4,269,201 (about 8.1 years, 18.13 million KSR); then 0.3 KSR a block forever (157,788 KSR a year, 0.87% of supply then) |
| Premine, dev fund | none: the genesis pays 1 KSR to an address nobody has keys for, and every reward goes to whoever mines or stakes the block |
| Fee | 0.01 KSR (Zano's) |
| Coins usable after | 10 blocks |

The reward is `(2^64 − 1 − coins so far) >> 20`, never less than 0.3 KSR, for every block, as Monero's was with
1-minute blocks. Until proof of stake starts, proof-of-work blocks aim at 1 minute. From block 129,600 on, Zano's
targets apply: a proof-of-work block and a proof-of-stake block every 2 minutes each, a block a minute in all. The
difficulty retargets over the following blocks, so blocks run fast for a while just after the switch.

Proof of stake starting at a fixed height is a hard fork built in from the first release: `POS_START_HEIGHT` is
consensus, and blocks before it are refused if they are proof-of-stake blocks.

## Security of a new chain

### Hashrate rented or redirected from Monero (51%)

A new chain's hashrate is small, and Monero's is large. Anyone who can point Monero hashrate at Kusari for a few hours
can rewrite its recent history. Two things make that harder, and neither makes it impossible:

- **RandomKSR.** Kusari uses RandomX with its own parameters, as RandomX's documentation recommends for every
  project: its own salt (`RandomKSR\x01`) and 16 programs of 1024 iterations in place of 8 of 2048 (the same work per
  hash; every safety condition in RandomX's `configuration.h` still holds). A Monero miner, a Monero pool or a rental
  market such as NiceHash computes different hashes and can't mine Kusari as it is. XMRig is open source, though: once
  someone adds RandomKSR to it, any XMRig rig, including MoneroOcean's switching, can mine Kusari.
- **Developer checkpoints.** `checkpoints` in `params.json` (height and hash of main-chain blocks) are compiled in.
  In the first months, each release should pin the chain up to a recent block; a node then refuses any other history
  below that height. This only protects what is older than the last release, and it means trusting whoever makes the
  releases.

### Proof of stake off for the first 90 days

Until block 129,600 proof of work alone holds the chain. Starting with proof of stake isn't possible anyway, since
nobody has coins to stake, but waiting 90 days also means 90 days in which the 51% risk above is the whole story.
After the switch, an attacker also needs stake. That's the trade-off: checkpoints and RandomKSR carry the chain until
then.

### The RandomX key can be computed ahead of time

Monero takes its RandomX key from the hash of a block 64 blocks before each 2048-block epoch, so nobody knows it until
that block exists. Kusari's key is `keccak("Kusari RandomX key v1" ‖ genesis hash ‖ epoch number)` with
`epoch = height / 2048`, because Zano computes the proof of work from the height alone, also for blocks on other
branches. Anyone can work out the key, and build the 2 GiB dataset, for any future epoch. That gives nobody more
hashes, but it removes the short warning Monero's design gives before a new dataset is needed.

### Keys for network notices and short aliases

Zano signs network notices with a maintainers key and approves aliases shorter than 6 characters with an alias
authority key. Kusari's `params.json` holds only public keys, different ones for mainnet and testnet. Today they are
keys nobody holds: `make-params.js` threw their secrets away when it made them, so no secret exists anywhere, and
notices and short aliases are off.

To turn them on, make each key offline, on a machine that isn't connected:

```
node native/kusari-zano/make-key.js /path/outside/the/repo/maintainers-mainnet.key
```

It refuses to write inside this repository, writes the secret key owner-only, and prints the public key for
`params.json` (`maintainersPubKey`, `testnetMaintainersPubKey` or `aliasAuthorityPubKey`). Use a different key for
each. A secret key never goes into the repository, a session, a chat or a cloud machine. Keep it offline, with a
backup; whoever holds it can send notices to every node or hand out short aliases.

## Dandelion++

A new transaction first walks a stem: each node passes it to one peer only. After a few hops a node broadcasts it as
before, so someone watching sees where the broadcast began, not where the walk started. This follows the Dandelion++
paper with Monero's parameters, written for Kusari without Monero's code:

- Each node starts a new epoch about every 10 minutes (10 minutes plus up to 30 seconds), picks 2 of its outgoing
  peers as stems, and with a 20% chance becomes a broadcaster for the epoch instead.
- Each source (an incoming peer, or the node's own RPC and wallet) keeps one stem for the whole epoch. A transaction
  never goes back to the peer it came from.
- A node that passes a transaction on keeps it under embargo: if nobody has broadcast it after about 39 seconds
  (random, exponential), it broadcasts it itself, so a node that drops stems can't make a transaction vanish.
- Broadcasts start after a random delay of about 5 seconds.
- Stem transactions travel as their own message (`NOTIFY_STEM_TRANSACTIONS`); a broadcast seen from any peer ends the
  embargo.

Known gap: Monero hides transactions still on their stem from its RPC; Kusari doesn't yet. A node whose RPC is
public shows them in its pool listing, which tells a watcher they are on a stem there. Wallets should send through a
node of their own or one whose RPC isn't public.

## Files

- `params.json`: the chain. Consensus: changing it after launch makes a different chain.
- `make-params.js`: writes a fresh `params.json`. Run once before launch.
- `make-genesis.sh`: makes `genesis/` with Zano's own tool, once, after `make-params.js`.
- `genesis/`: the genesis transaction. Consensus.
- `prepare.js`: applies all of it to a Zano checkout. `--bootstrap` applies only what the genesis tool needs.
- `make-source.sh`: a source archive that builds without git.
- `make-key.js`: an offline key pair for notices or short aliases.
- `randomx/basic_pow_helpers.cpp`: the proof of work (light mode to check blocks, the 2 GiB dataset to mine).
- `dandelion/`: Dandelion++ (`dandelion.h` decides, `dandelion_relay.inl` sends, `test_dandelion.cpp` tests).
- `selftest.js`: a private chain: RandomKSR mining, the emission, proof of stake switching on, and sends.

## Building

```
git clone --depth 1 --branch v2.2.0.490 https://github.com/hyle-team/zano kusari
git -C kusari submodule update --init --depth 1 contrib/miniupnp contrib/jwt-cpp contrib/bitcoin-secp256k1
git clone https://github.com/tevador/RandomX kusari/contrib/randomx
git -C kusari/contrib/randomx checkout 12f2c2ffe2108d6cf54c391fee33c8bc3646cdab
node native/kusari-zano/prepare.js kusari
ZANO_USE_SYSTEM_BOOST=1 cmake -S kusari -B kusari/build -DCMAKE_BUILD_TYPE=Release
cmake --build kusari/build --target daemon simplewallet -j 4
```

Zano asks for Boost 1.75 or newer and OpenSSL; `ZANO_USE_SYSTEM_BOOST=1` lets it use the system's Boost (Ubuntu 24.04:
`build-essential cmake libboost-all-dev libssl-dev`). The binaries are `kusarid` and `kusari-wallet`.

To test proof of stake switching on without waiting 129,600 blocks, make a second build with
`-DCMAKE_CXX_FLAGS=-DKUSARI_TEST_POS_START_HEIGHT=40`; never release that build. `selftest.js` takes it.

## Before a public launch

1. Make the genesis again on launch day (`make-params.js --force`, then the bootstrap build and `make-genesis.sh`),
   and never change `params.json` or `genesis/` after that.
2. Put two or more always-on nodes in `seedNodes`.
3. Have miners ready from the first block, and add checkpoints with each release in the first months.
4. If you want notices or short aliases, make the keys offline as above.
