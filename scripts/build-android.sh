#!/usr/bin/env bash
# Builds the signed APK without Gradle. Needs: aapt2 apksigner zipalign dalvik-exchange (or d8), javac, node.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"; B="$ROOT/android/build"; JAR="${ANDROID_JAR:-$ROOT/android/android-34.jar}"
if [ ! -f "$JAR" ]; then
  curl -fsSL -o "$JAR" https://raw.githubusercontent.com/Sable/android-platforms/master/android-34/android.jar
fi
VERSION=$(node -p "require('./package.json').version")
CODE=$(node -p "const v=require('./package.json').version.split('.').map(Number);v[0]*10000+v[1]*100+v[2]")
rm -rf "$B/res" "$B/classes" "$B/dex" "$B/app.apk" "$B/aligned.apk"; mkdir -p "$B/res" "$B/classes" "$B/dex"

npm run -s build
node scripts/build-android-web.js

aapt2 compile --dir android/res -o "$B/res/res.zip"
sed -E "s/android:versionCode=\"[0-9]+\"/android:versionCode=\"$CODE\"/; s/android:versionName=\"[^\"]+\"/android:versionName=\"$VERSION\"/" android/AndroidManifest.xml > "$B/AndroidManifest.xml"
rm -rf "$B/assets-root"; mkdir -p "$B/assets-root"; cp -r "$B/www" "$B/assets-root/www"
aapt2 link -o "$B/app.apk" -I "$JAR" --manifest "$B/AndroidManifest.xml" -A "$B/assets-root" --no-compress "$B/res/res.zip"

javac -encoding UTF-8 -nowarn -source 8 -target 8 -Xlint:-options -bootclasspath "$JAR" -d "$B/classes" android/java/dev/edge/vaultwallet/*.java
if command -v d8 >/dev/null; then d8 --lib "$JAR" --min-api 29 --output "$B/dex" $(find "$B/classes" -name '*.class')
else dalvik-exchange --dex --min-sdk-version=26 --output="$B/dex/classes.dex" "$B/classes"; fi
(cd "$B/dex" && zip -q "$B/app.apk" classes.dex)
rm -rf "$B/native"; mkdir -p "$B/native/lib"; cp -r android/jniLibs/arm64-v8a android/jniLibs/armeabi-v7a "$B/native/lib/"
# The Zcash engine is built separately and only for 64-bit ARM. Without it the app simply has no ZEC.
if [ -f native-bin/android/libzecbridge.so ]; then cp native-bin/android/libzecbridge.so "$B/native/lib/arm64-v8a/"; fi
(cd "$B/native" && zip -qr "$B/app.apk" lib)

KS="$ROOT/android/release.keystore"; PROPS="$ROOT/android/keystore.properties"
if [ ! -f "$KS" ]; then
  PASS=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")
  keytool -genkeypair -keystore "$KS" -storetype PKCS12 -storepass "$PASS" -keypass "$PASS" -alias vaultwallet -keyalg RSA -keysize 4096 -validity 20000 -dname "CN=Shinobi Wallet" 2>/dev/null
  echo "$PASS" > "$PROPS"; chmod 600 "$KS" "$PROPS"
fi
PASS=$(cat "$PROPS")
mkdir -p release
OUT="release/KusariWallet-$VERSION-android.apk"
zipalign -f -p 4 "$B/app.apk" "$B/aligned.apk"
apksigner sign --ks "$KS" --ks-pass "pass:$PASS" --key-pass "pass:$PASS" --ks-key-alias vaultwallet --min-sdk-version 29 --out "$OUT" "$B/aligned.apk"
apksigner verify --min-sdk-version 29 "$OUT"
echo "built $OUT"
