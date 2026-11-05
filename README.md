# Kusari Wallet

XMR, BTC, ETH, TRX, USDT(ERC-20, TRC-20), DCR, DASH만 보내고 받는 Windows, Android 지갑. 서버 없이 시드를 이 PC에 암호화해서 저장해.

여러 지갑을 추가하고 이름을 바꿀 수 있어. 지갑마다 시드, 비밀번호, 기록이 따로고, 설정과 Tor는 함께 써. 예전 지갑은 첫 번째 지갑으로 남아.

## 실행

Node.js 22 이상이 필요해.

```
npm install
npm start
```

Windows 배포본 빌드는 `npm run dist:win`, 결과물은 `release/`에 생겨. 코드 서명이 없어서 Windows SmartScreen 경고가 떠.

## Android

Gradle 없이 빌드해. `aapt2`, `apksigner`, `zipalign`, `dalvik-exchange`(또는 `d8`), JDK가 필요해.

```
npm run dist:android
```

- 결과물: `release/KusariWallet-<버전>-android.apk` (Android 10 이상)
- 화면과 지갑 로직은 PC와 같은 코드를 WebView에서 돌려. 네트워크는 `LocalProxy.java`를 거쳐 나가고, 데이터는 앱 전용 저장소에 암호화돼 있어.
- 지문 로그인은 비밀번호를 Android Keystore 키로 암호화해 둬. 그 키는 지문 인증을 통과해야 쓸 수 있어.
- 카메라 권한은 QR 스캔 버튼을 처음 누를 때만 물어봐.
- 스크린샷은 시드 보호를 위해 막혀 있어. 백그라운드 동기화는 아직 없어.
- Tor는 APK에 들어 있어. `scripts/build-tor-android.sh`로 Tor 소스에서 직접 빌드했고(`android/jniLibs/SOURCES.txt`에 버전 기록), 켜면 `LocalProxy`가 모든 요청을 Tor로만 보내. 앱 업데이트로 Tor도 함께 업데이트해야 해.
- `android/release.keystore`와 `android/keystore.properties`는 앱 서명 키야. GitHub에 올리지 말고 따로 백업해. 잃어버리면 앱을 지우고 시드로 복구해야 업데이트할 수 있어.

## 처음 쓰는 순서

메인넷 전용이야. 실제 코인이니까 잃어도 되는 소액부터 시험해.

1. 지갑을 만들고 시드 두 개를 종이에 적어.
2. 코인별로 소액을 받아서 잔액을 확인해.
3. 코인별로 소액을 보내고 탐색기에서 확인해.
4. 지갑을 삭제하고 시드로 복구해서 잔액이 그대로인지 확인해.
5. 이 과정을 다 통과한 뒤에 금액을 늘려.

## 시드가 두 개인 이유

- BTC, ETH, Tron: 같은 BIP39 12단어. BTC 경로는 `m/86'/0'/0'`(탭루트, BIP86)만 써. 예전 버전의 `m/84'/0'/0'`(`bc1q`) 주소는 앱에서 보이지 않으니, 코인이 있으면 같은 시드를 다른 지갑에 넣어서 옮겨. ETH 경로는 `m/44'/60'/0'/0/0`(MetaMask 첫 계정과 같음), Tron 경로는 `m/44'/195'/0'/0/0`.
- Monero: 표준 25단어. Monero GUI, Cake Wallet에서 복구돼.

한 시드로 합치면 다른 지갑에서 XMR을 복구할 수 없어서 나눴어.

## 보안 구조

- 시드: scrypt(N=2^17) + AES-256-GCM으로 암호화. 파일은 앱 데이터 폴더의 `vault.json`.
- Monero 지갑 파일: 금고 안에 있는 무작위 비밀번호로 암호화.
- Tron 개인키: 전송할 때만 비밀번호로 복호화해서 쓰고 메모리에 남겨두지 않아. JS 문자열은 지울 수 없어서 GC 전까지는 메모리에 남을 수 있어.
- Monero 키: 잠금 해제 동안 지갑 엔진 메모리에 있어. 동기화에 필요해. 잠그면 닫혀.
- Tron 거래: 로컬에서 만들고 수신자, 금액, 컨트랙트, 수수료 한도를 승인 내용과 대조한 뒤 서명해. API 서버가 내용을 바꿔치기해도 서명하지 않아.
- 화면: sandbox, contextIsolation, CSP 적용. 화면 코드에는 Node 접근 권한이 없어.
- 전송할 때마다 비밀번호를 다시 물어봐. 10분 동안 조작이 없으면 자동으로 잠겨.

이 지갑은 외부 보안 감사를 받지 않았어. PC가 악성코드에 감염되면 어떤 소프트웨어 지갑도 안전하지 않아.

## 프라이버시

- Monero 공개 노드는 네 IP를 볼 수 있어. 설정에서 내 노드를 지정할 수 있어. 기본 노드는 HTTP라서 통신 내용이 암호화되지 않아. 키는 절대 전송되지 않아.
- DCR은 `m/44'/42'/0'`을 쓰고, 조회와 전송은 공개 dcrdata 서버로 해. 서명 라이브러리 dcr-ts는 dcrd 값과 맞췄지만 보안 감사는 받지 않았어.
- DASH는 `m/44'/5'/0'` 경로의 일반 주소만 써. CoinJoin은 없어. 조회와 전송은 insight.dash.org로 해.
- ETH 잔액 조회와 전송은 공개 노드(publicnode, llamarpc, Cloudflare, 1rpc)를, 내역은 Blockscout를 써. 이 서버들은 IP와 주소를 볼 수 있어.
- BTC 잔액 조회와 전송은 mempool.space를 쓰고, 실패하면 blockstream.info를 써. 이 서버들은 IP와 주소 목록을 볼 수 있어. Tor를 켜면 IP는 숨겨져.
- Tron 거래는 전부 공개돼. TronGrid는 네 IP와 주소를 연결해 볼 수 있어.

## Tor

설정에서 켤 수 있어. 켜면 XMR 노드, TronGrid, CoinGecko 연결이 전부 Tor로 나가고, 호스트 이름도 Tor에서 처리해서 DNS가 새지 않아.

- XMR은 평문 HTTP가 Tor 출구에서 노출되지 않게 .onion 노드만 써. 직접 지정한 노드는 그대로 쓰고, 이 PC의 노드는 Tor를 거치지 않아.
- 지갑 연결은 Tor 포트 말고 다른 경로가 없어. Tor가 꺼지거나 죽으면 일반 인터넷으로 넘어가지 않고 연결이 실패해.
- 탐색기 링크는 일반 브라우저 대신 클립보드로 복사해.
- Tor 실행 파일은 앱에 넣지 않았어. 처음 켤 때 `dist.torproject.org`에서 공식 Expert Bundle을 받고, 고정된 지문(`EF6E286DDA85EA2A4BA7DE684E2C6E8793298290`) 키로 서명을 확인한 뒤에만 풀어. 이 설치 단계만 일반 인터넷을 써서 Tor Project 쪽에 IP가 보여.
- 설정의 Tor 업데이트 버튼으로 최신 버전을 다시 받을 수 있어. 자동 업데이트는 안 돼.

Tor는 IP를 숨길 뿐이야. Tron 거래 내역은 공개되고, 거래소에서 받은 기록도 거래소에 남아.

## 스왑

XMR, BTC, ETH, TRX, USDT(ERC-20, TRC-20)끼리 바꿀 수 있어. 받을 주소를 직접 넣으면 스왑 결과를 다른 지갑으로 보낼 수 있어. BTC, ETH, USDT(Eth)끼리는 프라이버시 스왑도 돼. 새 XMR 서브주소를 거쳐 두 주문으로 나누고, 2단계는 XMR 잠금이 풀린 뒤 비밀번호로 다시 승인해. ETH는 Tornado Cash 고정 풀(0.1, 1, 10, 100 ETH)도 쓸 수 있어. 입금 비밀은 시드에서 만들어서 복구할 수 있고, 증명은 기기에서 만들어. 기본은 Exolix고, SimpleSwap은 앱에 넣어둔 파트너 키로 바로 비교돼. 키는 소스에 없고 빌드할 때 `SIMPLESWAP_KEY` 환경 변수나 `.swap-keys.json`에서 넣어. 앱에서 뽑아낼 수 있으니 비밀로 취급하지 마. 앱은 수수료를 붙이지 않아.

1. 앱이 고정 환율로 주문을 만들고, 받는 주소와 환불 주소를 내 주소로 지정해.
2. 업체 응답의 주소, 코인, 금액을 대조해서 다르면 중단해.
3. 확인 화면과 비밀번호를 거친 뒤에만 입금을 보내.

입금 후에는 코인이 업체로 넘어가. 취소할 수 없고, 업체가 심사로 보류할 수 있어. 업체는 IP와 양쪽 주소를 볼 수 있어.

## QR 스캔

보내기 주소 칸의 스캔 버튼으로 카메라를 켜. 영상은 기기 안에서 QR을 읽는 데만 쓰고 저장하거나 보내지 않아. 소리는 요청하지 않아. 스캔은 주소를 채우기만 하고, 전송은 확인 화면과 비밀번호를 거쳐야 해.

## 시세

달러 시세는 CoinGecko에서 받아와. 주소와 잔액은 보내지 않지만 CoinGecko는 네 IP를 볼 수 있어. 설정에서 끌 수 있어. 테스트넷에서는 달러 금액을 표시하지 않아.

## 테스트

```
npm test                 # 금액 계산, 금고, Tron 서명, Tor 누출과 설치 검증
npm run test:ui          # Electron 앱 실제 구동 (Linux는 xvfb 필요)
npm run test:monero      # 로컬 regtest 전송 (monerod, monero-wallet-rpc 필요)
node tests/packaged-smoke.js <빌드된 실행 파일>
CHROME_BIN=<chrome> node tests/android-web.js  # Android 화면과 Java 프록시 (node scripts/build-android-web.js --test 먼저)
```

## 구조

- `src/main/vault.ts`: 암호화 저장
- `src/main/tron.ts`: TRX, USDT 전송과 검증
- `src/main/monero.ts`: XMR 동기화와 전송 (monero-ts)
- `src/main/tor.ts`: Tor 설치, 서명 확인, 실행
- `src/main/service.ts`: 지갑 세션과 전송 승인 흐름
- `src/main/main.ts`: Electron 프로세스와 IPC
- `src/renderer/`: 화면
- `src/android/`: Android용 저장, 암호화, 네트워크 연결
- `android/`: Android 앱 (Java)

Monero 하드포크가 오면 `monero-ts`를 업데이트해야 해.
