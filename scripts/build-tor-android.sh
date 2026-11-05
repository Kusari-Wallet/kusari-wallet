#!/usr/bin/env bash
# Builds Tor for Android from source as static executables (no NDK needed).
# Output: android/jniLibs/<abi>/libtor.so. Android only allows running executables that sit in the
# app's native library folder, which is why an executable carries a .so name.
# Needs: python ziglang (pip), autoconf automake libtool make perl git.
set -euo pipefail
TOR_TARBALL="${TOR_TARBALL:?path to a verified tor-x.y.z source tarball}"; OPENSSL_TAG="${OPENSSL_TAG:?}"; ZLIB_TAG="${ZLIB_TAG:?}"; LIBEVENT_TAG="${LIBEVENT_TAG:?}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${TOR_WORK:-/tmp/tor-android-build}"; mkdir -p "$WORK/src"
fetch() { [ -d "$WORK/src/$2" ] || git clone -q --depth 1 --branch "$3" "https://github.com/$1" "$WORK/src/$2"; }
[ -d "$WORK/src/tor" ] || { mkdir -p "$WORK/src/tor"; tar xzf "$TOR_TARBALL" -C "$WORK/src/tor" --strip-components=1; }
fetch openssl/openssl openssl "$OPENSSL_TAG"; fetch madler/zlib zlib "$ZLIB_TAG"; fetch libevent/libevent libevent "$LIBEVENT_TAG"
export ZIG_GLOBAL_CACHE_DIR="$WORK/zigcache"

build_abi() {
  local abi="$1" target="$2" host="$3" osslt="$4"
  local P="$WORK/$abi/prefix" BIN="$WORK/$abi/bin" S="$WORK/$abi/src"; mkdir -p "$P" "$BIN"
  [ -d "$S" ] || cp -r "$WORK/src" "$S"
  printf '#!/bin/sh\nexec python3 -m ziglang cc -target %s "$@"\n' "$target" > "$BIN/cc"
  printf '#!/bin/sh\nexec python3 -m ziglang ar "$@"\n' > "$BIN/ar"
  printf '#!/bin/sh\nexec python3 -m ziglang ranlib "$@"\n' > "$BIN/ranlib"
  chmod +x "$BIN"/*
  export CC="$BIN/cc" AR="$BIN/ar" RANLIB="$BIN/ranlib" CFLAGS="-O2 -fPIC"

  [ -f "$P/lib/libz.a" ] || (cd "$S/zlib" && CHOST="$host" ./configure --static --prefix="$P" >/dev/null && make -j"$(nproc)" install >/dev/null)
  [ -f "$P/lib/libcrypto.a" ] || (cd "$S/openssl" && ./Configure "$osslt" no-shared no-tests no-docs no-apps no-legacy no-dso no-async no-engine no-comp --prefix="$P" --libdir=lib >/dev/null && make -j"$(nproc)" build_libs >/dev/null && make install_dev >/dev/null)
  [ -f "$P/lib/libevent.a" ] || (cd "$S/libevent" && ./autogen.sh >/dev/null 2>&1 && ./configure --host="$host" --prefix="$P" --disable-shared --enable-static --disable-openssl --disable-samples --disable-libevent-regress >/dev/null && make -j"$(nproc)" install >/dev/null)
  (cd "$S/tor" && ./configure --host="$host" \
     --enable-static-tor --with-openssl-dir="$P" --with-libevent-dir="$P" --with-zlib-dir="$P" \
     --disable-asciidoc --disable-manpage --disable-html-manual --disable-tool-name-check --disable-seccomp \
     --disable-libscrypt --disable-systemd --disable-lzma --disable-zstd --disable-module-relay --disable-module-dirauth \
     --disable-unittests --disable-gcc-hardening --disable-linker-hardening \
     CC="$CC" AR="$AR" RANLIB="$RANLIB" CFLAGS="$CFLAGS -UNDEBUG" LDFLAGS="-static -s" >/dev/null && make -j"$(nproc)" src/app/tor >/dev/null)
  mkdir -p "$ROOT/android/jniLibs/$abi"
  cp "$S/tor/src/app/tor" "$ROOT/android/jniLibs/$abi/libtor.so"
  rm -rf "$S"
  echo "built $abi: $(du -h "$ROOT/android/jniLibs/$abi/libtor.so" | cut -f1)"
}
build_abi arm64-v8a aarch64-linux-musl aarch64-linux-musl linux-aarch64
build_abi armeabi-v7a arm-linux-musleabihf arm-linux-musleabihf linux-armv4
echo "$(basename "$TOR_TARBALL") $OPENSSL_TAG $ZLIB_TAG $LIBEVENT_TAG" > "$ROOT/android/jniLibs/SOURCES.txt"
