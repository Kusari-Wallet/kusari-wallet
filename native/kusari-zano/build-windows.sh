#!/usr/bin/env bash
# Cross-compiles kusarid.exe and kusari-wallet.exe for 64-bit Windows on Linux with MinGW-w64, and XMRig with
# RandomKSR when its source is given. The programs are linked statically and need only Windows' own DLLs (Windows 8
# or newer).
#   bash native/kusari-zano/build-windows.sh <zano checkout at the pinned tag, with submodules> <work dir> [xmrig source with rx/ksr]
#
# Needs (Ubuntu 24.04): g++-mingw-w64-x86-64-posix cmake git curl. Boost, OpenSSL and libuv are built for Windows
# in <work dir>/prefix the first time and reused after. Downloads are checked against these SHA-256 sums.
set -euo pipefail
ZANO="$(cd "$1" && pwd)"
mkdir -p "$2"
WORK="$(cd "$2" && pwd)"
XMRIG="${3:-}"
KIT="$(cd "$(dirname "$0")" && pwd)"
PREFIX="$WORK/prefix"
JOBS="${JOBS:-$(nproc)}"
HOST=x86_64-w64-mingw32

BOOST_URL=https://github.com/boostorg/boost/releases/download/boost-1.83.0/boost-1.83.0.tar.xz
BOOST_SHA=c5a0688e1f0c05f354bbd0b32244d36085d9ffc9f932e8a18983a9908096f614
OPENSSL_URL=https://github.com/openssl/openssl/releases/download/openssl-3.0.15/openssl-3.0.15.tar.gz
OPENSSL_SHA=23c666d0edf20f14249b3d8f0368acaee9ab585b09e1de82107c66e1f3ec9533
LIBUV_TAG=v1.48.0
LIBUV_COMMIT=e9f29cb984231524e3931aa0ae2c5dae1a32884e

mkdir -p "$WORK/dl" "$WORK/src" "$PREFIX"

fetch() { # url sha256
  local f="$WORK/dl/$(basename "$1")"
  [ -f "$f" ] || curl -fsSL -o "$f" "$1"
  echo "$2  $f" | sha256sum -c --quiet - || { echo "checksum mismatch: $f" >&2; exit 1; }
}

cat > "$WORK/toolchain.cmake" <<EOF
set(CMAKE_SYSTEM_NAME Windows)
set(CMAKE_SYSTEM_PROCESSOR x86_64)
set(CMAKE_C_COMPILER $HOST-gcc-posix)
set(CMAKE_CXX_COMPILER $HOST-g++-posix)
set(CMAKE_RC_COMPILER $HOST-windres)
set(CMAKE_AR $HOST-gcc-ar-posix)
set(CMAKE_RANLIB $HOST-gcc-ranlib-posix)
set(CMAKE_FIND_ROOT_PATH /usr/$HOST $PREFIX)
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)
EOF

if [ ! -f "$PREFIX/lib/libcrypto.a" ]; then
  fetch "$OPENSSL_URL" "$OPENSSL_SHA"
  rm -rf "$WORK/src/openssl-3.0.15" && tar -C "$WORK/src" -xzf "$WORK/dl/openssl-3.0.15.tar.gz"
  (cd "$WORK/src/openssl-3.0.15" &&
    ./Configure mingw64 no-shared no-tests --prefix="$PREFIX" --libdir=lib CC=$HOST-gcc-posix CXX=$HOST-g++-posix \
      AR=$HOST-ar RANLIB=$HOST-ranlib RC=$HOST-windres > ../openssl.log 2>&1 &&
    make -j"$JOBS" >> ../openssl.log 2>&1 && make install_sw >> ../openssl.log 2>&1)
fi

if [ ! -f "$PREFIX/lib/libboost_system.a" ]; then
  fetch "$BOOST_URL" "$BOOST_SHA"
  rm -rf "$WORK/src/boost-1.83.0" && tar -C "$WORK/src" -xJf "$WORK/dl/boost-1.83.0.tar.xz"
  echo "using gcc : mingw : $HOST-g++-posix : <archiver>$HOST-ar <ranlib>$HOST-ranlib <rc>$HOST-windres ;" > "$WORK/src/user-config.jam"
  (cd "$WORK/src/boost-1.83.0" && ./bootstrap.sh > ../boost.log 2>&1 &&
    ./b2 --user-config="$WORK/src/user-config.jam" toolset=gcc-mingw target-os=windows threadapi=win32 binary-format=pe \
      abi=ms address-model=64 architecture=x86 link=static runtime-link=static variant=release threading=multi \
      boost.locale.icu=off boost.locale.iconv=off --layout=system --prefix="$PREFIX" -j"$JOBS" \
      --with-system --with-filesystem --with-locale --with-thread --with-timer --with-date_time --with-chrono \
      --with-regex --with-serialization --with-atomic --with-program_options --with-log install >> ../boost.log 2>&1)
fi

# Kusari: the same source archive a Linux build uses (prepare.js includes the MinGW fixes in windows/mingw.js).
bash "$KIT/make-source.sh" "$ZANO" "$WORK/kusari-source.tar.gz"
rm -rf "$WORK/kusari" && tar -C "$WORK" -xzf "$WORK/kusari-source.tar.gz"
cmake -S "$WORK/kusari" -B "$WORK/kusari/build" -DCMAKE_TOOLCHAIN_FILE="$WORK/toolchain.cmake" -DCMAKE_BUILD_TYPE=Release \
  -DSTATIC=ON -DBOOST_ROOT="$PREFIX" -DBoost_NO_SYSTEM_PATHS=ON -DOPENSSL_ROOT_DIR="$PREFIX" -DOPENSSL_USE_STATIC_LIBS=ON \
  -DCMAKE_EXE_LINKER_FLAGS=-static -DBUILD_TESTS=OFF -DKUSARI_BRIDGE_DIR="$KIT/../zano-bridge" > "$WORK/kusari-cmake.log" 2>&1
# The node, the wallet, and the engine the Kusari Wallet app runs (its native-bin/ksr/).
cmake --build "$WORK/kusari/build" --target daemon simplewallet ksr-bridge -j"$JOBS" > "$WORK/kusari-build.log" 2>&1
mkdir -p "$WORK/out"
cp "$WORK/kusari/build/src/kusarid.exe" "$WORK/kusari/build/src/kusari-wallet.exe" "$WORK/kusari/build/src/ksr-bridge.exe" "$WORK/out/"

if [ -n "$XMRIG" ]; then
  if [ ! -f "$PREFIX/lib/libuv.a" ]; then
    rm -rf "$WORK/src/libuv"
    git -c advice.detachedHead=false clone -q --depth 1 --branch "$LIBUV_TAG" https://github.com/libuv/libuv "$WORK/src/libuv"
    [ "$(git -C "$WORK/src/libuv" rev-parse HEAD)" = "$LIBUV_COMMIT" ] || { echo "libuv $LIBUV_TAG is not $LIBUV_COMMIT" >&2; exit 1; }
    cmake -S "$WORK/src/libuv" -B "$WORK/src/libuv/build" -DCMAKE_TOOLCHAIN_FILE="$WORK/toolchain.cmake" -DCMAKE_BUILD_TYPE=Release \
      -DLIBUV_BUILD_SHARED=OFF -DLIBUV_BUILD_TESTS=OFF -DCMAKE_INSTALL_PREFIX="$PREFIX" > "$WORK/libuv.log" 2>&1
    cmake --build "$WORK/src/libuv/build" -j"$JOBS" >> "$WORK/libuv.log" 2>&1 && cmake --install "$WORK/src/libuv/build" >> "$WORK/libuv.log" 2>&1
  fi
  X="$(cd "$XMRIG" && pwd)"
  cmake -S "$X" -B "$WORK/xmrig-build" -DCMAKE_TOOLCHAIN_FILE="$WORK/toolchain.cmake" -DCMAKE_BUILD_TYPE=Release \
    -DWITH_HWLOC=OFF -DWITH_OPENCL=OFF -DWITH_CUDA=OFF -DWITH_TLS=ON -DOPENSSL_ROOT_DIR="$PREFIX" -DOPENSSL_USE_STATIC_LIBS=ON \
    -DUV_INCLUDE_DIR="$PREFIX/include" -DUV_LIBRARY="$PREFIX/lib/libuv.a" -DCMAKE_EXE_LINKER_FLAGS=-static > "$WORK/xmrig-cmake.log" 2>&1
  cmake --build "$WORK/xmrig-build" -j"$JOBS" > "$WORK/xmrig-build.log" 2>&1
  cp "$WORK/xmrig-build/xmrig.exe" "$WORK/out/"
fi

for f in "$WORK"/out/*.exe; do
  deps=$($HOST-objdump -p "$f" | sed -n 's/.*DLL Name: //p' | sort -u | tr '\n' ' ')
  echo "$(basename "$f"): $(du -h "$f" | cut -f1), needs $deps"
done
