#!/bin/sh
# Builds the Litecoin MWEB engine (native/mweb-bridge) for Linux, Windows and Android into native-bin/.
# Needs Go 1.24+, a C compiler (the secp256k1 code is C), zig for Windows (pip install ziglang) and the Android NDK
# (NDK=/path/to/android-ndk-r26c).
set -e
cd "$(dirname "$0")/../native/mweb-bridge"
out=../../native-bin
mkdir -p "$out/mweb" "$out/mweb-linux" "$out/android"
CGO_ENABLED=1 go build -trimpath -ldflags="-s -w" -o "$out/mweb-linux/mweb-bridge" .
zigcc=$(mktemp -d)/cc && printf '#!/bin/sh\nexec python3 -m ziglang cc -target x86_64-windows-gnu "$@"\n' > "$zigcc" && chmod +x "$zigcc"
CGO_ENABLED=1 GOOS=windows GOARCH=amd64 CC="$zigcc" go build -trimpath -ldflags="-s -w" -o "$out/mweb/mweb-bridge.exe" .
CGO_ENABLED=1 GOOS=android GOARCH=arm64 CC="$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android26-clang" go build -trimpath -ldflags="-s -w" -o "$out/android/libmwebbridge.so" .
sha256sum "$out/mweb/"* "$out/mweb-linux/"* "$out/android/libmwebbridge.so"
