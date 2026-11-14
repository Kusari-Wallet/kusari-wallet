# Kusari Wallet

Self-custody privacy wallet. Desktop is Electron + TypeScript (`src/main`, `src/renderer`, `src/preload`); Android is a
Java WebView (`android/java`) running the same code as an esbuild bundle (`src/android`, `scripts/build-android-web.js`).

## Rules

- All text in files, commits and GitHub is English. Only `locales/*.json` holds other languages; every new UI string
  gets translations there (`node scripts/i18n-extract.js` lists them).
- Never commit secrets. These stay local and are gitignored: `.swap-keys.json`, `src/main/swap-keys.generated.ts`,
  `android/release.keystore`, `android/keystore.properties`, `native-bin/`, `android/jniLibs/*/liblyrebird.so`.
  Before every commit, scan the staged diff for the values in `.swap-keys.json` (and pieces of them).
- No private keys or API keys in source. Builds that include swap keys are not for distribution.
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
  on every build.

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
- Tornado: relayers from the registry's events and ENS (`mainnet-tornado.<name>` "url" text), picked as the site does
  (random among the cheapest 30%); withdrawals to a new wallet address ("new"); deposits after yours shown from the
  local deposit list; withdrawals later (proof made now, sealed in `tornado-later.json`, relayer only); split deposits
  (`splitPlan`, later ones pre-signed with following nonces).
- Android launcher: two activity-aliases (`.Launcher`, `.PlainLauncher` "Tools"); `setPlainLauncher` swaps them.
- Own servers per coin: `customServers` setting, `OWN_SERVER_COINS` in `config.ts`.
- Swaps into XMR use a new subaddress per order (`swapSubaddress`); XMR sends reconnect with a new Tor login
  (`MoneroClient.renewRoute`, desktop). Coin selection takes the smallest single coin that covers a payment.
- Delayed Bitcoin sends: signed at confirm, kept sealed in `btc-delayed.json`, coins reserved, sent at a random
  time (`scheduleSend`, re-armed on unlock).
- `src/main/wabisabi/`: WabiSabi CoinJoin client (credentials, round, decomposer); `src/main/btc-mix.ts` runs it.
  `tests/fixtures/wabisabi-*.json` are vectors from the reference implementation and live coordinators.
- `src/main/coinjoin.ts`, `dash-mix.ts`, `dash-p2p.ts`: Dash CoinJoin.
- `src/main/tor-bridges.ts`: Snowflake/obfs4 via lyrebird (`scripts/fetch-lyrebird-android.sh` for Android).
- `src/main/blockbook.ts`, `config.ts`: servers and their backups.
- `src/main/zano.ts`, `zano-process.ts`: Zano, and Kusari (KSR) on the same client with its own engine (`ksr-bridge`:
  `native/zano-bridge` built against the KSR chain), key label, wallet file, node and Tor route. `native/kusari-zano/`
  is the KSR chain itself (see its README).
