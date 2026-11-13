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
- Bump `version` in `package.json` and `package-lock.json` for each release.

## Map

- The wallet service used by both platforms, one class in layers: `src/main/service-core.ts` (wallets, sessions,
  engines, Tor routes, balances, prices) → `service-send.ts` (sends, fees, Tornado, private transfers, settings) →
  `service.ts` (`WalletService`: swaps). Shared helpers and types are in `service-common.ts`.
- `src/renderer/`: plain scripts sharing one scope, loaded in the order `index.html` lists them (`ui.ts` first,
  `screens-*.ts`, `app.ts` last, which wires events and boots). `src/android/index.html` and
  `scripts/build-android-web.js` list the same files.
- `src/main/btc.ts`: Bitcoin (taproot, BIP86), coin control, CoinJoin account `m/86'/0'/1'`.
- `src/main/wabisabi/`: WabiSabi CoinJoin client (credentials, round, decomposer); `src/main/btc-mix.ts` runs it.
  `tests/fixtures/wabisabi-*.json` are vectors from the reference implementation and live coordinators.
- `src/main/coinjoin.ts`, `dash-mix.ts`, `dash-p2p.ts`: Dash CoinJoin.
- `src/main/tor-bridges.ts`: Snowflake/obfs4 via lyrebird (`scripts/fetch-lyrebird-android.sh` for Android).
- `src/main/blockbook.ts`, `config.ts`: servers and their backups.
- `src/main/zano.ts`, `zano-process.ts`: Zano, and Kusari (KSR) on the same client with its own engine (`ksr-bridge`:
  `native/zano-bridge` built against the KSR chain), key label, wallet file, node and Tor route. `native/kusari-zano/`
  is the KSR chain itself (see its README).
