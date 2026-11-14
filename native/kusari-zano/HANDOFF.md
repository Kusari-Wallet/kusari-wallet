# Kusari (KSR) handoff

For whoever continues KSR. The code says what it does; this file says what was actually run, what wasn't, what is
known to be wrong, why things are the way they are, and what is left. Written at the end of the session that built
the chain (branch `claude/xmr-token-github-code-jjp54w`, since merged into main up to 0.61.1). Read `README.md` in
this folder first: it describes the chain and the build. This file doesn't repeat it.

## 1. What was run, and what came out

All on Ubuntu 24.04, 4 cores, 15 GB RAM, on private chains on one machine (nothing left the machine). "Test build"
means the node built with `-DCMAKE_CXX_FLAGS=-DKUSARI_TEST_POS_START_HEIGHT=40` (proof of stake from block 40).

| What | Command | Result |
|---|---|---|
| Kit unit tests | `node --test tests/kusari-zano.test.js` | 13 of 13 pass (prefixes, ports, genesis, every edit applies once, RandomKSR parameters, emission curve, PoS height, keys, Dandelion router test, privacy edits, bridge target) |
| Dandelion++ router (C++) | `test_dandelion.cpp`, built by the test above | passes: 20.2% fluff epochs, 38.9 s mean embargo, 4.9 s mean fluff delay, private-until-broadcast states |
| `prepare.js` on a pristine Zano v2.2.0.490 | `node native/kusari-zano/prepare.js <checkout>` | "changed 34 files"; the result was diffed against the tree that was built and tested: identical |
| Source archive | `make-source.sh` | unpacked and diffed against the built tree: identical; builds without git |
| Full private-chain test | `node native/kusari-zano/selftest.js <build-test/src> 40` | passes in one run (about 60-75 min): 4 nodes connect; RandomKSR mining; a send whose 16-member ring is all PoW rewards; no node lists the tx while it is on its stem; Dandelion++ path A -> B or C -> D, D broadcasts; emission exact for each of 72 blocks (block 1 = 17.592185090741 KSR); the 0.01 KSR fee reached the miner; 42 PoW and 30 PoS blocks, none PoS before 40; 30 stake rings each of one kind |
| Tor path | `node native/kusari-zano/tor-test.js <build-test/src>` | passes (about 25-35 min), with a stand-in SOCKS5 proxy in the test: own tx goes only through the proxy, by host name, with a SOCKS login; peer gets nothing; with the proxy down it retries, never sends to the peer, shows the tx to nobody; with the proxy back it gets through on a new login |
| XMRig mining | `node native/kusari-zano/xmrig-test.js <build-test/src> <patched xmrig> 5` | passes (about 3-5 min): 5 blocks found through the stratum and accepted, 6 shares accepted, 0 rejected, wallet paid |
| RandomKSR hashes | `scratchpad rxcheck/modes.cpp` (not in the repo) | JIT, interpreter and full-dataset modes give the same hash (`dec292d7...` for its fixed input); it differs from Monero's RandomX for the same input; the Windows (MinGW) build gives the same hash under Wine |
| Release build | `cmake --build build --target daemon simplewallet` | builds; boots and serves genesis `1b5ef99c21110d402b4906dee971e36d5a72f3c8d9aec9841773d8ea768c717f` |
| App engine (`ksr-bridge`) | `ksr-bridge --selftest 127.0.0.1:<rpc> - <dir>` against a local test-build node | "selftest ok": K... address (95 chars), sync, balance, same address on restore |
| App client on the real engine | ad-hoc script: `ZanoClient` + `KSR_CHAIN` + `ksrKeys` + real `ksr-bridge` + local node | K... address, wallet file `ksr-...`, mined balance seen (87.96 KSR), Zano address refused ("Not a Kusari address"), history items tagged KSR, fresh restore gives the same address |
| Windows cross-build | `build-windows.sh` | builds kusarid.exe, kusari-wallet.exe, ksr-bridge.exe, xmrig.exe; static, only Windows system DLLs (Windows 8+) |
| Windows under Wine | | kusari-wallet.exe makes a wallet that the Linux wallet opens with the same K... address; ksr-bridge.exe `--version` runs |
| App (0.59.0 at the time) | `npm test`, `xvfb-run -a node tests/ui-e2e.js`, Android web test | all passed then (336 unit tests; e2e incl. "ok Kusari: receive, checks, send"; Android "ALL PASSED"). Later versions were tested by the session that made them |

## 2. Not checked

- **Real Windows.** Under Wine the node stops at opening its database (LMDB: "Input/output error"; MDBX: "Request
  not supported"): Wine lacks the NT memory-section calls both use. The Windows XMRig starts under Wine but never
  connects to the pool (stops after printing its config). Zano's own Windows builds use the same databases, so this
  is probably Wine, but nobody has run kusarid.exe or the Windows XMRig on Windows.
- **Real Tor.** The test machine couldn't reach the Tor network; tor-test.js uses a SOCKS5 stand-in. The SOCKS code
  path is exercised, Tor itself (onion services, circuit building, timeouts) is not.
- **A public network.** Only private chains of 1 to 4 nodes on one machine. No test with real latency, many peers,
  NAT, reorgs between real miners, or long chains.
- **Long runs.** The longest chain was about 75 blocks. Difficulty over thousands of blocks, the 2048-block RandomX
  epoch change (`ethash_height_to_epoch`), the PoS switch at the real height 129,600 (only tested at 40), the tail
  emission (only by the closed-form unit test) were not run.
- **Android.** No KSR engine is built for Android; KSR is off there.
- **Real XMRig on many machines / NiceHash / pools.** Only one local XMRig against the node's solo stratum.
- **Security review.** Nothing here was audited: RandomKSR wiring, the PoW byte-order change, Dandelion++, decoy
  selection, stem hiding, the Tor relay, the stratum.

## 3. Known bugs and gaps

- **Engines don't get a new Tor route per send.** The app's confirmSend renews lookup routes, but the Zano and KSR
  engines reach their node through the bridge's own relay (`native/zano-bridge/relay.h`), which uses one SOCKS
  connection without a login: no per-send circuit isolation. Same as Zano today.
- **Early chain rings.** With fewer than about 16 usable outputs (10 blocks old), a send fails with
  `NOT_ENOUGH_OUTPUTS_FOR_MIXING`; in the tests the first send works around height 19. When too few outputs of the
  real output's kind exist, the ring is filled with other kinds and the wallet logs `[DECOYS] too few ...`: in the
  first weeks, spending received coins hides poorly.
- **An empty chain never "syncs".** With only the genesis block the wallet stays at 0% (`ksr-bridge --selftest`
  needs at least one mined block). Harmless after launch.
- **Stratum is solo only.** Every worker mines to one address. No pool software exists for KSR. Zano's EthProxy
  protocol is still in the stratum server next to XMRig's; nothing uses it.
- **Explorer: none.** `KSR_EXPLORER_TX` is empty, the app says "Kusari has no public explorer yet."
- **No price.** `NO_MARKET` in `src/main/prices.ts`; KSR never counts as missing a price.
- **Short aliases and network notices are off**: the public keys in `params.json` are keys nobody holds (see 4).
- **Node logs printed to a redirected stdout are buffered** for minutes. The tests read `<data-dir>/kusarid.log`,
  which is flushed per line. Anyone writing new tests should do the same.
- **Windows distribution files lack third-party licences** (OpenSSL, Boost, libuv, LMDB, libmdbx, miniupnpc, zlib,
  secp256k1, ethash, epee). The repo's `THIRD-PARTY-NOTICES.md` has Zano and RandomX; a `LICENSES/` folder for the
  release zip was never made.
- **Code base age.** Pinned to Zano v2.2.0.490 and RandomX `12f2c2ff`. If launch is far off, move to current Zano
  first: `prepare.js` stops at every edit that no longer matches, which is the point.

## 4. Decisions the code doesn't explain

Chain (all consensus: fixed at launch):
- **Zano base, not Monero.** Chosen for confidential assets, Zarcanum PoS, aliases. A Monero node can't validate
  Zano transactions, so "Monero's wallet and node" was declined; the Monero-based KSR (`native/kusari-coin`) was
  dropped when KSR moved into the app on the Zano client.
- **No premine, no dev fund, 100% to miners and stakers.** Offered and declined twice (10%, then 1.5% permanent
  incl. PoS). A hidden pre-launch mine was explicitly refused: block heights and timestamps would show it.
- **Fees go to the miner** (Monero's way); Zano burns them since HF4. Burned coins also no longer come off the
  supply, so the emission curve isn't bent by fees.
- **PoS off until 129,600 (about 90 days)**, because at launch nobody has coins to stake. Trade-off: 90 days where
  PoW alone holds the chain. Checkpoints in each release and the developers' own hashrate are the answer, not code.
- **1-minute PoW target before PoS**, then Zano's 2+2 minutes (a block a minute overall).
- **RandomKSR** (own salt, 16x1024 programs): Monero miners and rental markets can't point hashrate at KSR as is.
  It doesn't stop someone who patches XMRig (as this project did).
- **RandomX key = keccak("Kusari RandomX key v1" | genesis hash | height/2048)**, not a block hash as in Monero,
  because Zano computes PoW from the height alone, also for blocks on other branches. Datasets can be precomputed.
- **The PoW hash handed to `check_hash` is the RandomX output reversed.** Zano's `check_hash` reads hashes
  big-endian (Ethash order). Reversing makes the difficulty check read the output little-endian like Monero, so
  XMRig's share check agrees with the node. Without it every XMRig share was refused.
- **Block check uses `total_coins()`** for the reward: Zano's short `get_block_reward()` passes 0 for coins so far,
  which its flat reward never read. That bug refused every block at height 1 before it was fixed.
- **Zano hard forks 1-5 active from block 0, HF6 never** (`999999999999999999`): a new chain starts on current rules
  without replaying Zano's history; HF6 was left off on purpose (not reviewed for KSR).
- **Genesis pays 1 KSR to a burn address** (no keys exist) with a proof phrase; Zano's genesis tool was patched
  because it made a multisig output with an empty second key, spendable by anyone.

Privacy:
- **Decoys of the real output's kind** (regular / PoW reward / PoS reward), from blocks that kind comes from, 8
  blocks per ring member. Zano's rule (regular decoys for sends, rewards for stakes, plus a 5% lone opposite) put a
  mined coin alone among regular outputs. Zano's measured age distribution was kept: same block rate.
- **Stem transactions are private until broadcast**: hidden from RPC listings, lookups, pool size, block templates
  and "relay the pool". Monero does the same.
- **Tor relay (`--tx-proxy-tor`)** sends own transactions to other nodes' RPC, never to peers, retries forever with
  backoff (15 s after a failure, 90 s if nobody broadcast, doubling to 10 min), never falls back to clearnet. It
  first gave up after 10 tries; a test showed a few minutes of Tor outage was enough, so that was changed. Nodes
  given as `--tx-proxy-node` must broadcast normally (two Tor-relaying nodes would wait on each other).

Keys and operations:
- **Maintainer (mainnet and testnet) and alias-authority public keys are keys nobody holds**: `make-params.js`
  threw the secrets away. No secret key for KSR was made in this session, none is in the repo or anywhere else. To
  turn notices or short aliases on, make keys offline with `make-key.js` (it refuses paths inside the repo) and put
  only the public keys in `params.json`.
- **XMRig patch is GPL, so it stays out of the repo**; it adds `rx/ksr`, nonce at byte 32 of a 40-byte blob, and
  sets the donation to 0 (XMRig's donate pools don't mine rx/ksr).
- **App: KSR key = HMAC-SHA512(seed, "kusari/ksr/v1")**, wallet file and password with labels of their own, so a
  K... address can't be tied to the same seed's Zano address. Pinned in `tests/ksr.test.js`; never change it.
- **No public node before launch.** `KSR_NODE` is empty; the regular app only starts KSR with a node set. (0.61.1's
  developer build shows KSR without one, pointing the engine at an empty local port.)
- **Hosting:** Hostinger forbids mining on VPS; Cloudzy's FAQ forbids it "without permission". Plan: nodes on VPS,
  mining from the developers' own machines. Don't buy long VPS terms until a launch date exists.
- **Not done on purpose:** FCMP++ (unaudited, Monero hasn't shipped it), Decred/Dash features (declined), mining
  pool.

## 5. What is left, in order

1. Decide the launch window. If it is far off (two years was mentioned), port to the current Zano release first and
   rerun everything in section 1.
2. Run kusarid.exe, kusari-wallet.exe, ksr-bridge.exe and the Windows XMRig on real Windows.
3. Run tor-test-like checks with a real Tor (a node with `--tx-proxy-tor` to an onion RPC).
4. Fill a `LICENSES/` folder for the Windows and Linux release archives.
5. Public testnet: 2 VPS nodes in different regions (monthly billing), testnet ports and network id are in
   `params.json`; let miners and users try it; run long (epoch change at 2048 blocks, many reorgs).
6. Security review of everything listed in section 2.
7. Android: build `ksr-bridge` with the NDK like `zano-native.yml` does for `zano-bridge`, ship it, enable KSR.
8. Launch day: `make-params.js --force`, bootstrap build, `make-genesis.sh`, set `seedNodes`, set `KSR_NODE` in the
   app, rebuild everything, announce the start time, mine from block 1, add checkpoints in each release for the
   first months. Never change `params.json` or `genesis/` afterwards.
9. Later: an explorer, pool software, per-send Tor circuits for the engines (a SOCKS login per connection in
   `relay.h`).

## 6. Build environment

- Ubuntu 24.04.5 LTS, x86-64, 4 cores, 15 GB RAM. GCC 13.3, CMake 3.28, system Boost 1.83 (`ZANO_USE_SYSTEM_BOOST=1`).
- Linux packages: `build-essential cmake libboost-all-dev libssl-dev` (node, wallet, bridge); `libuv1-dev
  libhwloc-dev` (XMRig); `g++-mingw-w64-x86-64-posix gcc-mingw-w64-x86-64-posix` (Windows); `wine64 wine` (only to
  try Windows files).
- Downloads: Zano v2.2.0.490 with submodules miniupnp, jwt-cpp, bitcoin-secp256k1 (`git clone` from GitHub works
  through the proxy; GitHub tag archives didn't, so libuv is cloned by tag and its commit checked); RandomX by
  commit; for Windows, Boost 1.83 and OpenSSL 3.0.15 release files from GitHub, checked against the SHA-256 sums
  in `build-windows.sh`. `archives.boost.io` was blocked by the proxy.
- Times with 4 cores: a full Release build of daemon + simplewallet about 30-40 min (LTO); an incremental rebuild
  after one file 5-15 min (LTO relinks); the test build the same again; `ksr-bridge` a few minutes once the
  libraries are built. Windows from nothing: OpenSSL about 5 min, Boost about 15-20 min, Kusari about 20 min (no
  LTO on MinGW), XMRig about 5 min. selftest.js 60-75 min, tor-test.js 25-35 min, xmrig-test.js 3-5 min.
- Disk: Zano checkout 63 MB; Release build tree 2.9 GB, test build tree 2.8 GB (debug info: an unstripped
  ksr-bridge is 253 MB, stripped 19 MB); Windows work folder with Boost/OpenSSL sources and builds 1.7 GB; XMRig
  41 MB; each selftest run leaves a few hundred MB in `/tmp/kusari-selftest-*` (delete them).
- Running two long tests at once on 4 cores works but slows both; a container restart kills them (the scripts
  don't resume).
