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
| Premine, dev fund | none: the genesis pays 1 KSR to an address nobody has keys for, and every reward and every fee goes to whoever mines or stakes the block |
| Fee | 0.01 KSR (Zano's), paid to whoever mines or stakes the block, as in Monero (Zano burns fees since its HF4) |
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
  market such as NiceHash computes different hashes and can't mine Kusari as it is. XMRig is open source, though, and
  Kusari's own miners use XMRig with RandomKSR added (see Mining): the same patch lets any XMRig rig, including
  MoneroOcean's switching, mine Kusari once someone applies it.
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

## Mining

- **The node's own miner:** `kusarid --start-mining <K… address> --mining-threads <n>`, or `/start_mining` over RPC.
  It builds the 2 GiB dataset in the background and mines in light mode until then; `KUSARI_RX_LIGHT=1` keeps it in
  light mode (256 MiB, about ten times slower).
- **XMRig:** `kusarid --stratum --stratum-bind-port 21082` serves XMRig's protocol (the one Monero pools speak:
  login, job, submit, keepalived) next to Zano's EthProxy one. Connect an XMRig with RandomKSR added:
  `xmrig -o <node>:21082 -a rx/ksr -u <K… address>` (`<address>+<difficulty>` sets the starting share difficulty).
  It is solo mining: every worker mines to one address, the first to log in or `--stratum-miner-address`. A job is the
  40 bytes RandomKSR hashes, the header hash and then the 64-bit nonce; each connection has its own upper half of the
  nonce and XMRig fills the lower half, so workers never repeat each other's work.
- **The XMRig patch** (`rx/ksr`: Kusari's salt and program counts, the 40-byte input, the nonce at byte 32, no
  donation) is kept out of this repository because XMRig is GPL-3.0. Whoever ships that XMRig ships its source
  under the GPL. `xmrig-test.js` mines a private chain with it.

The node reads a RandomX output as a little-endian number when it checks the difficulty, as Monero does. Zano's
`check_hash()` reads hashes with their bytes reversed (Ethash's order), so the PoW hash handed to it is the RandomX
output reversed.

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

A transaction still on its stem is private: until it has been broadcast, a node shows it to nobody. Its RPC leaves
it out of pool listings, lookups by id and the pool size, a block template leaves it out, and "relay the pool" doesn't
send it (`privacy/stem-hiding.js`). The pool still holds it and checks spends against it.

## Decoys

Anyone can see on the chain which kind an output is: a regular transaction's, a PoW block's reward or a PoS block's
reward. Zano picks the decoys for a regular transaction from regular outputs and those for a stake from rewards, so
spending mined coins (every first spend on Kusari for the first 90 days) or staking coins received in a transfer put
the real output in a ring of the other kind, and it stood out. Kusari picks every decoy from the real output's own
kind, from the blocks that kind comes from (rewards from any block, PoS rewards from PoS blocks, regular outputs from
blocks with transactions), and asks for 8 blocks per ring member instead of 2 so enough of one kind turn up. Only when
the chain holds too few of a kind does a ring fill up with others, and the wallet logs it: early on, the first spends
of received coins can't hide among many like them. The ages decoys are drawn from stay Zano's, measured on its chain
(also a block a minute). `privacy/decoys.js`.

## Tor

`--tx-proxy-tor 127.0.0.1:9050 --tx-proxy-node <node>:21081` (give several nodes; onion addresses work) sends this
node's own transactions, from its wallet or RPC, only through Tor to those nodes' RPC, which start them on a stem
there. Its peers never get them from it, so they never learn its IP address started anything. Each transaction gets
its own Tor circuit (a fresh SOCKS login). A failed send is retried through Tor after 15 seconds, one nobody broadcast
within 90 seconds goes to another node, each wait twice the last up to 10 minutes, for as long as the transaction is
in the pool. It never falls back to the open network (a Tor outage only delays it), and until it has been broadcast
the node shows it to nobody. The nodes given should broadcast normally: two nodes that pass transactions to each
other through Tor would wait for each other. `privacy/tor_relay.h`; `tor-test.js` checks it with a stand-in SOCKS5
proxy, since a real Tor network isn't reachable from the test machine.

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
- `stratum/xmrig-stratum.js`: XMRig's protocol in the node's stratum server.
- `xmrig-test.js`: XMRig with RandomKSR mining a private chain through that stratum.
- `build-windows.sh`, `windows/mingw.js`: the Windows build.
- `privacy/`: decoys of the real output's kind, stem transactions hidden, own transactions through Tor.
- `tor-test.js`: a node sending through a SOCKS5 proxy, with the proxy up, down and back.

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

### The engine for the Kusari Wallet app

The app runs KSR on its Zano client with `ksr-bridge`: the app's own `native/zano-bridge` code, linked against this
chain's wallet library. Configure the build with `-DKUSARI_BRIDGE_DIR=<the app's native/zano-bridge>` and build the
`ksr-bridge` target; `build-windows.sh` does this for Windows. Put the program in the app's `native-bin/ksr/`. Its
`--selftest <node> - <folder>` makes a wallet with a throwaway key, syncs it and checks that restoring gives the same
address (the chain needs a block past the genesis to sync).

### Windows

`build-windows.sh` cross-compiles `kusarid.exe` and `kusari-wallet.exe` on Linux with MinGW-w64 (Ubuntu 24.04:
`g++-mingw-w64-x86-64-posix cmake git curl`), and XMRig with RandomKSR when its source is given:

```
bash native/kusari-zano/build-windows.sh kusari-zano-checkout /path/to/work [/path/to/xmrig-with-rx-ksr]
```

It builds Boost 1.83, OpenSSL 3.0 and libuv for Windows first (checked against fixed SHA-256 sums or a commit), then
the same source archive `make-source.sh` makes; `windows/mingw.js` holds the build fixes MinGW needs. The programs
are static and need only Windows' own DLLs (Windows 8 or newer). What was checked: RandomKSR built for Windows gives
the Linux hashes in JIT, interpreter and full-dataset modes, and a wallet made by `kusari-wallet.exe` opens in the
Linux wallet with the same `K…` address (both under Wine). Under Wine the node stops at opening its database, since
Wine lacks the NT memory-section calls LMDB and MDBX use, and XMRig stops before connecting; both need a run on real
Windows before a release.

To test proof of stake switching on without waiting 129,600 blocks, make a second build with
`-DCMAKE_CXX_FLAGS=-DKUSARI_TEST_POS_START_HEIGHT=40`; never release that build. `selftest.js` takes it.

## Before a public launch

1. Make the genesis again on launch day (`make-params.js --force`, then the bootstrap build and `make-genesis.sh`),
   and never change `params.json` or `genesis/` after that.
2. Put two or more always-on nodes in `seedNodes`.
3. Have miners ready from the first block, and add checkpoints with each release in the first months.
4. If you want notices or short aliases, make the keys offline as above.
5. Run `selftest.js` and `tor-test.js` against the release's code, and use Tor for any node that sends.
6. Check the Windows programs on real Windows (see Windows above).
