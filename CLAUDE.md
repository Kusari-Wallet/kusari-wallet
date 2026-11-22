# Kusari Wallet

Self-custody privacy wallet. Desktop is Electron + TypeScript (`src/main`, `src/renderer`, `src/preload`); Android is a
Java WebView (`android/java`) running the same code as an esbuild bundle (`src/android`, `scripts/build-android-web.js`).

## Rules

- All text in files, commits and GitHub is English. Only `locales/*.json` holds other languages; every new UI string
  gets translations there (`node scripts/i18n-extract.js` lists them).
- Never commit secrets. These stay local and are gitignored: `.swap-keys.json`, `src/main/swap-keys.generated.ts`,
  `android/release.keystore`, `android/keystore.properties`, `native-bin/`, `android/jniLibs/*/liblyrebird.so`.
  Before every commit, scan the staged diff for the values in `.swap-keys.json` (and pieces of them).
- No private keys or API keys in source. Release builds may carry public-app swap partner keys: they come from
  `.swap-keys.json` or CI secrets at build time only, masked by `scripts/gen-keys.js`, and are never in the source
  or the repository.
- Tor never falls back to clearnet; CoinJoin requests only ever go out over Tor.
- Don't copy GPL code. MIT code that is ported gets its notice in `THIRD-PARTY-NOTICES.md`.
- The repository stays private; workflows run only by hand.
- Commit only when asked.

## Build and test

- `npm test`: unit tests (builds first).
- `xvfb-run -a node tests/ui-e2e.js`: desktop UI test against local stand-in servers.
- `node scripts/build-android-web.js --test && xvfb-run -a node tests/android-web.js`: Android WebView and proxy test
  (rebuild the test bundle first, it is not rebuilt automatically).
- `npm run dist:win`, `npm run dist:android`: release builds into `release/` (Android needs the keystore files).
- `npm run dist:linux`: Linux x64 tar.gz; engines come from `native-bin/*-linux` (zec, zano, arrr, mweb, spark). The
  Linux zano-bridge links a static libbacktrace (`-DBACKTRACE_LIB_PATH`), which the Zano package lacks.
- `npm run dist:win-dev` (`scripts/dist-dev.js`): "Kusari Wallet Dev" into `release/dev/`, with its own app ID and data
  folder. It is built with `KUSARI_FLAVOR=developer` (`src/main/flavor.ts`, `DEVELOPER_BUILD`), shows a ribbon, and
  carries coins and features not yet released (KSR, from `native-bin/_later/`). Gate new unreleased work on
  `DEVELOPER_BUILD`. Regular builds never ship the KSR engine.
- Bump `version` in `package.json` and `package-lock.json` for each release.
- The desktop app runs one bundle: `npm run build` ends with `scripts/bundle-main.js`, which bundles `dist/main/main.js`
  into `dist/main/app.js` (the package `main`) and monero-ts's worker into `dist/main/monero-worker.js`. Only
  `web-worker` ships as a package (it starts threads from its own file); every other library is a devDependency and is
  bundled. A library that must ship as files goes in `dependencies` and `external`. `npm run check:package` checks
  a Windows build.
- Code signing: electron-builder signs the app and every engine `.exe` when `CSC_LINK` (a .pfx path or base64) and
  `CSC_KEY_PASSWORD` are set for the build; without them builds are unsigned. The Linux tar.gz ships
  `start-kusari-wallet.sh`, which sets up Chromium's sandbox helper once where the system requires it.
- Swap keys are masked in `src/main/swap-keys.generated.ts` with random bytes made fresh by `scripts/gen-keys.js`
  on every build (split, shuffled, joined only at run time). Masking only makes keys harder to find; partner keys
  meant for public apps, the services' own limits and rotating a misused key are the real protection.

## Map

- The wallet service used by both platforms, one class in layers: `src/main/service-core.ts` (wallets, sessions,
  engines, Tor routes, balances, prices) → `service-send.ts` (sends, fees, Tornado, private transfers, settings) →
  `service.ts` (`WalletService`: swaps). Shared helpers and types are in `service-common.ts`.
- `src/renderer/`: plain scripts sharing one scope, loaded in the order `index.html` lists them (`ui.ts` first,
  `screens-*.ts`, `app.ts` last, which wires events and boots). `src/android/index.html` and
  `scripts/build-android-web.js` list the same files.
- `src/main/btc.ts`: Bitcoin (taproot, BIP86), coin control, CoinJoin account `m/86'/0'/1'`.
- Private Bitcoin sync (BIP157/158): `btc-filter-sync.ts` (headers from checkpoints, filters two peers agree on,
  matching on the device, reorgs), `btc-p2p.ts` (onion peers over Tor), `btc-gcs.ts` (filters), `btc-block.ts`.
  `BtcClient.useFilters` switches a client over. On for new wallets (`btc-sync.json`, sealed); needs Tor.
  Litecoin uses the same sync (`p2p-net.ts`: magic, seeds, scrypt work, its difficulty rule; `ltc-seeds.ts`, onion and
  IPv4 peers through Tor exits; files `ltc-*`); MWEB still syncs through the MWEB server. `tests/ltc-regtest.js` runs
  it by hand against two litecoind regtest nodes.
- Payjoin (BIP77/78): `payjoin.ts` (links, OHTTP+BHTTP at 8192 bytes, HPKE messages A/B at 7168, PSBT checks both
  ways), `hpke.ts` (RFC 9180, secp256k1 DHKEM, ChaCha20-Poly1305), `ellswift.ts` (BIP324), `btc-payjoin.ts`
  (`payjoinPay`: the ordinary payment is signed first and goes out on any problem or after 60 s; `receiveStep`).
  Sending: a `pj=` link in the send field, needs Tor. Receiving: BTC receive screen, password unlocks the key of the
  smallest coin, held in memory; the request lasts an hour while unlocked (`pjRecv`, ends on lock). Directories go
  straight over Tor (no OHTTP relay). `tests/payjoin-regtest.js` runs both versions against bitcoind by hand.
- Duress password: `duressSet`/`unlock` in `service-core.ts`. A decoy wallet in `wallets/<id>` (never listed)
  opens in the real one's place; from a decoy session the real wallet's files are never touched. Every wallet keeps
  such a hidden wallet (`duress.json`), one nobody can open when no duress password is set, so files and unlock time
  don't show whether one is; the setting itself is in the sealed `duress-state.json`.
- DOGE, DASH and FIRO sign with the legacy hash, which doesn't cover input values: `InsightWallet.checkCoins` checks
  every coin against its raw transaction (hash = ID) before it is spent, so a lying server can't burn coins as fee.
- Android `LocalProxy` answers only requests carrying the app's Origin (a browser page's plain GET has none).
- `src/main/lookalike.ts`: address-poisoning check on every send review, judged on matching characters past the
  part every address of a kind shares (3+ at each end, 7+ in all).
- Uniswap: `checkRouterCommands` (`dex.ts`) decodes the router call the Trading API returns and allows only V2/V3
  swaps, the Permit2 permit, wrap/unwrap and sweep, all paying this wallet, with at least the quoted minimum.
  V4 routes aren't asked for: their calls aren't read.
- `src/main/socks-gate.ts` (desktop) and `android/java/.../SocksGate.java`: a SOCKS gateway per engine (Zano, KSR,
  ZEC, ARRR) that logs in to Tor; `renewTorRoute` changes the login, so each send gets a fresh circuit.
- `src/main/seed.ts`: the BIP39 seed with the open wallet's optional passphrase. Every key from the 12 words goes
  through `bip39Seed`/`passphraseOf`; never call `mnemonicToSeedSync` directly. ZEC and ARRR engines take the
  words themselves, so they stay off in a wallet with a passphrase.
- `src/main/btc-silent.ts`: paying Silent Payments (sp1) addresses (BIP352); the output is made at signing time.
  Receiving needs a tweak index server, which isn't done.
- BTC fee bumps: `BtcClient.bumpDraft` (RBF, own sends kept in `btc-sent.json`) and `cpfpDraft`; sends signal RBF.
- BTC/LTC sends look like Bitcoin Core's (`coreLike`): lock time at the tip (sometimes up to 99 lower), coins in
  random order, change at a random place. Beside a non-taproot payment the change is bc1q (BIP84 `m/84'/0'/0'/1/i`,
  "chain 2" of the main account, `V0_CHAIN`), found by the scan or its own filter account (`btc:v0`); never mixed.
- On private sync a BTC send goes only to onion peers when two took it; `checkLater` asks peers for it after the
  2 minutes nodes wait before handing a transaction out, and only if nobody has it does a server get it.
- Monero sends go out through another node than the sync node (`MoneroClient.submitElsewhere`), own Tor login.
- Extra Ethereum addresses (`ethAddresses`/`ethAddressNew`/`ethAddressesFind`, sealed `eth-addresses.json`): account
  4, 5, ... (`ETH_EXTRA_FIRST`), each its own `EthClient` and Tor route; sends pick one with `fromAddress`.
- Tornado on Ethereum, BNB Chain, Polygon and Arbitrum ETH (`TORNADO_CHAINS` in `tornado.ts`: the site's pools, ENS key
  `<chain>-tornado.<name>`, withdraw gas; notes carry `chain`, absent = Ethereum). A deposit can name an address to
  send it on to (`sendTo`): the note's keys wait sealed in `tornado-later.json` and the proof is made at the random
  time (1 to 24 hours, `randomLater`). Withdrawals later work the same way. Mixers take no service fee.
- Tornado: relayers from the registry's events and ENS (`mainnet-tornado.<name>` "url" text), picked as the site does
  (random among the cheapest 30%); withdrawals to a new wallet address ("new"); deposits after yours shown from the
  local deposit list; withdrawals later (proof made now, sealed in `tornado-later.json`, relayer only); split deposits
  (`splitPlan`, later ones pre-signed with following nonces).
- Android launcher: two activity-aliases (`.Launcher`, `.PlainLauncher` "Tools"); `setPlainLauncher` swaps them.
- Own servers per coin: `customServers` setting, `OWN_SERVER_COINS` in `config.ts`.
- Account coins with their own client, wired through `ACCOUNT_COINS` / `AccountCoin` (`service-common.ts`): GRAM and
  USDT on TON (`ton.ts`, v4r2 wallet at m/44'/607'/0', toncenter). Sends can carry a TON comment. No auto-lock: the
  wallet stays open until locked.
- Swaps into XMR use a new subaddress per order (`swapSubaddress`); XMR sends reconnect with a new Tor login
  (`MoneroClient.renewRoute`, desktop). Coin selection takes the smallest single coin that covers a payment.
- Delayed Bitcoin sends: signed at confirm, kept sealed in `btc-delayed.json`, coins reserved, sent at a random
  time (`scheduleSend`, re-armed on unlock).
- `src/main/wabisabi/`: WabiSabi CoinJoin client (credentials, round, decomposer); `src/main/btc-mix.ts` runs it.
  `tests/fixtures/wabisabi-*.json` are vectors from the reference implementation and live coordinators.
- `src/main/coinjoin.ts`, `dash-mix.ts`, `dash-p2p.ts`: Dash CoinJoin.
- `src/main/dcr.ts`: Decred (DCR) on dcrdata's Insight API, BIP44 `m/44'/42'/0'` from the 12 words. Its own transaction
  format (prefix and witness), BLAKE-256 everywhere, and dcrd's signature hash (`dcrSignatureHash`); addresses pinned
  to dcrd's vectors in `tests/dcr.test.js`. No raw-transaction coin check: consensus refuses a wrong input amount.
  Each address is looked up on its own request, in random order, through Tor each on its own route
  (`DcrClient.lookup`, through the service's `isolated`: an agent on desktop, a route name for Android's forwarder);
  change takes a random output place. Vote and revocation rewards are stake-tree coins (`dcrCoinKind`), spendable
  after CoinbaseMaturity. `useDcrNetwork('simnet')` (`VAULT_DEV_DCR_NET=simnet`) is for development only.
- `src/main/dcr-stake.ts`: Decred tickets through a VSP (vspd API v3), as dcrwallet buys them: a split (seats and
  fee funds to fresh change addresses, no expiry), tickets committing back to the seat's address, voting keys at
  the hardened `m/44'/42'/0'/2'/i'`. The VSP broadcasts split and ticket on `feeaddress`; its answers must carry its
  ed25519 signature and echo the request. Records sealed in `dcr-tickets.json`; fee coins reserved until the fee
  transaction confirms; status from the chain only. `tests/dcr-simnet.js` runs a purchase, vote and reward spend
  against dcrd, dcrwallet and vspd on simnet (by hand, `DCR_SIM=<run dir>`).
- Decred mixing (StakeShuffle): `dcr-mix.ts` (mixpool + mixclient ported from dcrd's mixing v0.7.5: pairing
  version 3, 10-minute epochs, stages KE CT SR DC DCRS CM, blame from revealed secrets), `dcr-mix-crypto.ts`
  (ChaCha20 PRNG, EC-Schnorr-DCRv0, key exchange, DC-nets, root solving), `sntrup.ts`, `dcr-wire.ts` (P2P framing
  and the eight mix messages, pinned to Go vectors in `tests/fixtures/dcr-mix-vectors.json`), `dcr-mixnet.ts`
  (nodes from Decred's HTTPS seeders, connected over Tor; version height 0 and an empty `headers` reply so dcrd
  doesn't take it for a sync peer). `dcr-mixer.ts` mixes each confirmed regular coin into up to four outputs of
  dcrwallet's denominations in the mixed account `m/44'/42'/1'` (`DCR_MIXED_PATH`), change back to the regular
  account; Tor required. Mixed sends put their change in the regular account (`changePath`); tickets can be bought
  from mixed coins. `tests/dcr-mix-simnet.js` mixes with dcrwallet (2.1.6+, mixing v0.7.x) on simnet by hand.
- Solana private pool (PrivacyCash, program `9fhQBb…`): `sol-privacy.ts` (keys from the SOL key's signature of the
  site's sign-in text, so the site shows the same notes; Poseidon notes, AES-GCM note encryption, ext-data hash,
  instruction bytes, v0 messages with the pool's lookup table), `sol-pool.ts` (scan of every published output, the
  index being its place in the list; tree paths asked among decoys and checked against the program's root history;
  deposits signed here and passed through the relayer; withdrawals through the relayer), `src/solpool/worker.js`
  (snarkjs Groth16, single-threaded, circuit files in `assets/solpool/` pinned by hash). Never use the relayer's
  `/utxos/indices`. Each purpose gets its own Tor route; Tor required. `tests/solpool-standin.js` stands in for the
  program and relayer (proof checked as the program's verifier reads it). Sends out of the pool can wait (sealed
  `sol-pool-later.json`, while unlocked).
- `src/main/tor-bridges.ts`: Snowflake/obfs4 via lyrebird (`scripts/fetch-lyrebird-android.sh` for Android).
- `src/main/blockbook.ts`, `config.ts`: servers and their backups.
- `src/main/zano.ts`, `zano-process.ts`: Zano, and Kusari (KSR) on the same client with its own engine (`ksr-bridge`:
  `native/zano-bridge` built against the KSR chain), key label, wallet file, node and Tor route. `native/kusari-zano/`
  is the KSR chain itself (see its README).
- Swap providers in `swap.ts`, each with its own coin table (coin + network as that provider names it; GhostSwap
  matches tokens by contract): Exolix, SimpleSwap, GhostSwap, ETZ Swap, CCECash, ChangeNOW, PegasusSwap (HMAC-SHA512
  of the endpoint name, `x-api-*` headers). ETZ, CCECash and PegasusSwap keys can read the account's orders.
- No feature takes a fee for Kusari Wallet (swaps, mixers, CoinJoin, Tornado); donations are optional.
- Releases: Windows, Linux and macOS (`npm run dist:win && npm run dist:linux && npm run dist:mac`); Android is no
  longer built. macOS zips (arm64, x64) are made on Linux and signed ad hoc after the fuses (`scripts/mac-adhoc-sign.js`,
  rcodesign from `RCODESIGN`); no Developer ID, so Gatekeeper asks on first start. They carry no native engines yet
  (ZEC, ZANO, ARRR, MWEB, Spark need a Mac or the macOS SDK to build), so those coins stay off there.
- Wide windows (960 px+): side menu (`sideNav`, `navOn` in ui.ts), holdings cards on home, settings section index
  (`settingsIndex`); narrow windows keep the bottom menu.
