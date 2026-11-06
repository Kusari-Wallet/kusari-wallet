# Kusari Wallet

A self-custody wallet for Windows and Android that sends and receives XMR, BTC, ETH, TRX, USDT (ERC-20, TRC-20), DCR, DASH, FIRO, ZEC, ZANO and ARRR. There is no account server: seeds are encrypted and stored on your device.

You can add several wallets and rename them. Each wallet has its own seeds, password and records. Settings and Tor are shared.

ZEC, ZANO and ARRR need native engines, which are built separately and are not stored in this repository. A build or device without an engine doesn't list that coin. 32-bit Android devices don't have these three.

This wallet has not had an external security audit. If your device has malware, no software wallet is safe.

## Running

Requires Node.js 22 or newer.

```
npm install
npm start
```

Build the Windows release with `npm run dist:win`. The output goes to `release/`. It has no code signature, so Windows SmartScreen shows a warning.

## Android

Builds without Gradle. Requires `aapt2`, `apksigner`, `zipalign`, `dalvik-exchange` (or `d8`) and a JDK.

```
npm run dist:android
```

- Output: `release/KusariWallet-<version>-android.apk` (Android 10 or newer).
- The screens and wallet logic are the same code as on the desktop, run in a WebView. Network traffic goes through `LocalProxy.java`, and data is encrypted in app-private storage.
- Fingerprint login encrypts the password with an Android Keystore key that only works after fingerprint authentication.
- The camera permission is only requested the first time the QR scan button is pressed.
- Screenshots are blocked to protect seeds. There is no background sync yet.
- Tor is inside the APK, built from source by `scripts/build-tor-android.sh` (versions are in `android/jniLibs/SOURCES.txt`). When it's on, `LocalProxy` sends every request through Tor only. Tor is updated by updating the app.
- `android/release.keystore` and `android/keystore.properties` are the app signing key. Never upload them to GitHub, and back them up separately. If they are lost, updating requires removing the app and restoring from the seed.

## Getting started

This is mainnet only. These are real coins, so start with amounts you can afford to lose.

1. Create a wallet and write both seeds on paper.
2. Receive a small amount of each coin and check the balance.
3. Send a small amount of each coin and check it on an explorer.
4. Delete the wallet, restore it from the seeds and check that the balances are the same.
5. Only increase amounts after all of this has passed.

## Why there are two seeds

- BTC, ETH, Tron, DCR, DASH, FIRO, ZEC, ZANO, ARRR: one BIP39 12-word seed.
  - BTC uses `m/86'/0'/0'` only (Taproot, BIP86). Addresses from `m/84'/0'/0'` (`bc1q`) in older versions don't appear in the app. If they hold coins, move them by entering the same seed in another wallet.
  - ETH uses `m/44'/60'/0'/0/0` (the same as MetaMask's first account). Tron uses `m/44'/195'/0'/0/0`.
- Monero: the standard 25 words, which restore in Monero GUI and Cake Wallet.

They are separate because a single combined seed couldn't restore XMR in other wallets.

## Security design

- Seeds: encrypted with scrypt (N=2^17) and AES-256-GCM, in `vault.json` in the app data folder.
- Monero wallet file: encrypted with a random password stored inside the vault.
- ZEC, ZANO and ARRR wallet data: encrypted with keys derived from random vault secrets.
- Tron private key: decrypted with the password only when sending, and not kept. JavaScript strings can't be erased, so it may stay in memory until garbage collection.
- Monero keys: in the wallet engine's memory while unlocked, as syncing needs them. They close on lock.
- Tron transactions: built locally, and the recipient, amount, contract and fee limit are compared with what was approved before signing. If an API server changes the contents, nothing is signed.
- Screens: sandbox, contextIsolation and CSP are on. Screen code has no Node access.
- The password is asked for every send. The wallet locks after 10 minutes without activity.

## Privacy

- Public Monero nodes can see your IP. You can set your own node in Settings. The default node uses HTTP, so traffic isn't encrypted. Keys are never sent.
- DCR uses `m/44'/42'/0'`, with public dcrdata servers for lookups and sends. The signing library dcr-ts was checked against dcrd values, but hasn't been audited.
- DASH uses plain addresses at `m/44'/5'/0'`. There is no CoinJoin. Lookups and sends use insight.dash.org.
- FIRO uses plain addresses at `m/44'/136'/0'`. Spark, Firo's private mode, isn't supported, so addresses and amounts are public.
- ZEC uses shielded addresses by default. Swap services pay a transparent address, so those coins need shielding after they arrive.
- ETH balances and sends use public nodes (publicnode, llamarpc, Cloudflare, 1rpc), and history uses Blockscout. These servers can see your IP and addresses.
- BTC balances and sends use mempool.space, then blockstream.info if that fails. These servers can see your IP and address list unless Tor is on.
- Tron transactions are all public. TronGrid can link your IP and address.

## Tor

Turn it on in Settings. When on, wallet connections go through Tor and host names resolve inside Tor, so DNS doesn't leak.

- XMR uses .onion nodes only, so that plain HTTP isn't exposed at Tor exits. A node you set yourself is used as is, and a node on this PC doesn't go through Tor.
- Wallet connections have no route other than the Tor port. If Tor stops, connections fail rather than falling back to the plain internet.
- Explorer links are copied to the clipboard rather than opened in a normal browser.
- On Windows the Tor executable isn't bundled. The first time it's turned on, the app downloads the official Expert Bundle from `dist.torproject.org` and unpacks it only after verifying its signature with the pinned key fingerprint `EF6E286DDA85EA2A4BA7DE684E2C6E8793298290`. That install step uses the plain internet, so the Tor Project can see your IP.
- The Tor update button in Settings downloads the latest version again. There are no automatic updates.
- Some networks block Tor. If it stalls while connecting, try another network.

Tor only hides your IP. Tron history stays public, and exchanges keep their own records.

## Swaps

Coins can be swapped with each other, and entering a receiving address sends the result to another wallet. The default provider is Exolix. SimpleSwap uses a partner key that is put in at build time from the `SIMPLESWAP_KEY` environment variable or `.swap-keys.json`, and is not in the source. It can be extracted from the app, so don't treat it as secret. The app adds no fee of its own. Provider support differs per coin.

BTC, ETH and USDT (Eth) can also use a privacy swap, which splits into two orders through a new XMR subaddress. The second step needs approval with the password once the XMR has unlocked. ETH can also use Tornado Cash fixed pools (0.1, 1, 10, 100 ETH). Deposit secrets come from the seed so they can be restored, and proofs are made on the device.

1. The app creates a fixed-rate order, and sets the receiving and refund addresses to your own.
2. The address, coin and amount in the provider's answer are compared, and it stops if they differ.
3. The deposit is only sent after the review screen and the password.

After the deposit, the coins are with the provider. It can't be cancelled, and the provider may hold it for review or ask for KYC. The provider can see your IP and both addresses.

## QR scanning

The scan button in the send address field turns on the camera. Video is only used on the device to read the QR code, and is never saved or sent. Audio isn't requested. A scan only fills in the address. Sending still needs the review screen and the password.

## Prices

USD prices come from CoinGecko, with Kraken and CryptoCompare as fallbacks. Addresses and balances aren't sent, but these services can see your IP. Prices can be turned off in Settings. Testnet shows no USD amounts.

## Tests

```
npm test                 # amounts, vault, signing, Tor leaks and install checks, coin clients
npm run test:ui          # runs the real Electron app (xvfb needed on Linux)
npm run test:monero      # local regtest sends (needs monerod and monero-wallet-rpc)
node tests/packaged-smoke.js <built executable>
CHROME_BIN=<chrome> node tests/android-web.js  # Android screens and Java proxy (run node scripts/build-android-web.js --test first)
```

Native engines are built by the workflows in `.github/workflows`, which only run when started by hand.

## Layout

- `src/main/vault.ts`: encrypted storage
- `src/main/tron.ts`: TRX and USDT sends and checks
- `src/main/monero.ts`: XMR sync and sends (monero-ts)
- `src/main/zec.ts`, `zano.ts`, `arrr.ts`: clients for the native engines
- `src/main/tor.ts`: Tor install, signature check and running
- `src/main/service.ts`: wallet session and send approval flow
- `src/main/main.ts`: Electron process and IPC
- `src/renderer/`: screens
- `src/android/`: Android storage, encryption and network connection
- `android/`: the Android app (Java)
- `native/`: native engine sources

`monero-ts` needs updating when Monero has a hard fork.
