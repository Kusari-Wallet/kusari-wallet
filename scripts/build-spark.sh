#!/bin/bash
# Builds the Firo Spark engine (native/spark-bridge) for Linux, Windows and Android into native-bin/.
# Sources: firoorg/sparkmobile (MIT) as vendored by cypherstack/flutter_libsparkmobile (MIT) at a pinned commit,
# with its C wrapper, plus nlohmann/json (MIT). Needs g++, autotools, Boost headers, OpenSSL headers (Linux),
# zig for Windows (pip install ziglang) and the Android NDK (NDK=/path/to/android-ndk-r26c).
# Usage: scripts/build-spark.sh [linux|windows|android|all|verify|mac]
# "mac" runs on a Mac (Xcode command line tools, Homebrew autoconf, automake, libtool, boost, GNU sed) for its own
# architecture, into native-bin/spark-mac-<arm64|x64>.
# "verify" builds a Linux test tool that checks spends as a Firo node does; it is never shipped.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
work="${SPARK_WORK:-$here/native/spark-bridge/.deps}"
out="$here/native-bin"
pin=e2238a5   # flutter_libsparkmobile; its src/deps/sparkmobile is the library
targets="${1:-all}"
jobs="${JOBS:-8}"
mkdir -p "$work" "$out/spark" "$out/spark-linux" "$out/android"

if [ ! -d "$work/fls" ]; then
  git clone -q https://github.com/cypherstack/flutter_libsparkmobile "$work/fls"
fi
git -C "$work/fls" checkout -q "$pin"
[ -f "$work/json.hpp" ] || curl -sSfL -o "$work/json.hpp" https://raw.githubusercontent.com/nlohmann/json/v3.11.3/single_include/nlohmann/json.hpp

S="$work/fls/src"
D="$S/deps/sparkmobile"
SRC=("$D"/src/*.cpp "$D"/bitcoin/*.cpp "$D"/bitcoin/support/*.cpp "$D"/bitcoin/crypto/*.cpp "$S/flutter_libsparkmobile.cpp" "$S/utils.cpp" "$S/transaction.cpp" "$here/native/spark-bridge/main.cpp")
# Boost is used for headers only; cross builds get just its folder, not the rest of /usr/include.
mkdir -p "$work/boostinc" && [ -e "$work/boostinc/boost" ] || ln -s "${BOOST_INCLUDE:-/usr/include/boost}" "$work/boostinc/boost"
INC=(-I"$D/include" -I"$D/src" -I"$D" -I"$S" -I"$S/deps" -I"$work" -I"$work/boostinc")

# secp256k1 (the old Spark-flavoured one in sparkmobile) for one host triple, into $1.
secp() {
  local dir="$1" host="$2" cc="$3" cxx="${4:-g++}" flags="${5:-}"
  if [ ! -f "$dir/.libs/libsecp256k1.a" ]; then
    rm -rf "$dir" && cp -r "$D/secp256k1" "$dir"
    # Its scratch functions drop "static" on Windows, which clang (zig) refuses next to their static definitions.
    sed -i 's/^  #define S$/  #define S static/' "$dir/src/scratch.h"
    (cd "$dir" && ./autogen.sh >/dev/null 2>&1 && CC="$cc" CXX="$cxx" CPPFLAGS="$flags" ./configure -q ${host:+--host=$host} --enable-experimental --enable-module-ecdh --with-bignum=no --enable-endomorphism --disable-shared --disable-tests --disable-exhaustive-tests --disable-benchmark --disable-jni >/dev/null && make -j"$jobs" libsecp256k1.la >/dev/null)
  fi
}

# OpenSSL's libcrypto, static, for one OpenSSL target, into $1/prefix (not "install": macOS file names ignore case,
# and OpenSSL ships an INSTALL file).
openssl() {
  local dir="$1" target="$2" cc="$3"
  if [ ! -f "$dir/prefix/lib/libcrypto.a" ] && [ ! -f "$dir/prefix/lib64/libcrypto.a" ]; then
    rm -rf "$dir" && cp -r "$S/deps/openssl-cmake" "$dir"
    (cd "$dir" && CC="$cc" AR="${AR_TOOL:-ar}" RANLIB="${RANLIB_TOOL:-ranlib}" ./Configure "$target" no-shared no-asm no-tests no-engine no-dso --prefix="$dir/prefix" >/dev/null && make -j"$jobs" build_libs >/dev/null && make install_dev >/dev/null)
  fi
}

if [ "$targets" = linux ] || [ "$targets" = all ]; then
  secp "$work/secp-linux" "" gcc
  g++ -std=c++17 -O2 -s "${INC[@]}" -I"$work/secp-linux/include" "${SRC[@]}" "$work/secp-linux/.libs/libsecp256k1.a" -l:libssl.a -l:libcrypto.a -lpthread -ldl -o "$out/spark-linux/spark-bridge"
fi

if [ "$targets" = verify ]; then
  secp "$work/secp-linux" "" gcc
  VSRC=("${SRC[@]}")
  unset 'VSRC[${#VSRC[@]}-1]'
  g++ -std=c++17 -O2 -s "${INC[@]}" -I"$work/secp-linux/include" "${VSRC[@]}" "$here/native/spark-bridge/verify.cpp" "$work/secp-linux/.libs/libsecp256k1.a" -l:libcrypto.a -lpthread -ldl -o "$out/spark-linux/spark-verify"
fi

if [ "$targets" = windows ] || [ "$targets" = all ]; then
  zig="$(mktemp -d)"
  printf '#!/bin/sh\nexec python3 -m ziglang cc -target x86_64-windows-gnu "$@"\n' > "$zig/cc"
  printf '#!/bin/sh\nexec python3 -m ziglang c++ -target x86_64-windows-gnu "$@"\n' > "$zig/c++"
  printf '#!/bin/sh\nexec python3 -m ziglang ar "$@"\n' > "$zig/ar"
  printf '#!/bin/sh\nexec python3 -m ziglang ranlib "$@"\n' > "$zig/ranlib"
  chmod +x "$zig"/*
  AR_TOOL="$zig/ar" RANLIB_TOOL="$zig/ranlib" openssl "$work/ossl-win" mingw64 "$zig/cc"
  ossl="$work/ossl-win/prefix"; lib="$ossl/lib"; [ -d "$ossl/lib64" ] && lib="$ossl/lib64"
  secp "$work/secp-win" x86_64-w64-mingw32 "$zig/cc" "$zig/c++" "-I$ossl/include"
  (cd "$out/spark" && "$zig/c++" -std=c++17 -O2 -s "${INC[@]}" -I"$work/secp-win/include" -I"$ossl/include" -I"$S/deps/missing_headers/windows" "${SRC[@]}" "$work/secp-win/.libs/libsecp256k1.a" "$lib/libssl.a" "$lib/libcrypto.a" -lws2_32 -lcrypt32 -lbcrypt -luser32 -ladvapi32 -static -o "$out/spark/spark-bridge.exe") && rm -f "$out/spark/"*.lib
fi

if [ "$targets" = android ] || [ "$targets" = all ]; then
  tc="$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin"
  PATH="$tc:$PATH" AR_TOOL="$tc/llvm-ar" RANLIB_TOOL="$tc/llvm-ranlib" ANDROID_NDK_ROOT="$NDK" ANDROID_NDK_HOME="$NDK" openssl "$work/ossl-android" android-arm64 "$tc/aarch64-linux-android26-clang"
  ossl="$work/ossl-android/prefix"; lib="$ossl/lib"; [ -d "$ossl/lib64" ] && lib="$ossl/lib64"
  secp "$work/secp-android" aarch64-linux-android "$tc/aarch64-linux-android26-clang" "$tc/aarch64-linux-android26-clang++" "-I$ossl/include"
  # An executable named like a library, so Android unpacks it next to the app's other native code.
  "$tc/aarch64-linux-android26-clang++" -std=c++17 -O2 -s -fPIE -pie -static-libstdc++ -D_LIBCPP_ENABLE_CXX17_REMOVED_UNARY_BINARY_FUNCTION -Wno-enum-constexpr-conversion "${INC[@]}" -I"$work/secp-android/include" -I"$ossl/include" "${SRC[@]}" "$work/secp-android/.libs/libsecp256k1.a" "$lib/libssl.a" "$lib/libcrypto.a" -Wl,-z,max-page-size=16384 -o "$out/android/libsparkbridge.so"
fi

if [ "$targets" = mac ]; then
  arch="$(uname -m)"; [ "$arch" = x86_64 ] && arch=x64
  osslt=darwin64-arm64-cc; [ "$arch" = x64 ] && osslt=darwin64-x86_64-cc
  export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-11.0}"
  openssl "$work/ossl-mac" "$osslt" clang
  ossl="$work/ossl-mac/prefix"; lib="$ossl/lib"; [ -d "$ossl/lib64" ] && lib="$ossl/lib64"
  secp "$work/secp-mac" "" clang clang++ "-I$ossl/include"
  mkdir -p "$out/spark-mac-$arch"
  clang++ -std=c++17 -O2 -D_LIBCPP_ENABLE_CXX17_REMOVED_UNARY_BINARY_FUNCTION -Wno-enum-constexpr-conversion "${INC[@]}" -I"$work/secp-mac/include" -I"$ossl/include" "${SRC[@]}" "$work/secp-mac/.libs/libsecp256k1.a" "$lib/libssl.a" "$lib/libcrypto.a" -o "$out/spark-mac-$arch/spark-bridge"
  strip -x "$out/spark-mac-$arch/spark-bridge"
  codesign --force --sign - "$out/spark-mac-$arch/spark-bridge"
fi

ls -la "$out/spark-linux" "$out/spark" "$out/android" 2>/dev/null | grep -i spark || true
