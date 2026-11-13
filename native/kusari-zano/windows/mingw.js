'use strict';
// Build fixes so Kusari cross-compiles for Windows with MinGW-w64 (GCC), as build-windows.sh does. Zano's Windows
// releases are built with MSVC and its MinGW support has fallen behind; none of this changes a Linux build or what
// the code does. Every edit goes through `add`, which must match the code exactly once.

module.exports = function mingw(add) {
  // gold links ELF only, and GCC's LTO on MinGW defines the same COMDAT thunks twice.
  add('CMakeLists.txt', '  if (NOT APPLE AND NOT MSVC)\n    if (CLANG)', '  if (NOT APPLE AND NOT MSVC AND NOT MINGW)\n    if (CLANG)');
  add('CMakeLists.txt', '  if(NOT APPLE AND NOT (CMAKE_SYSTEM_NAME STREQUAL "Android"))\n    set(RELEASE_FLAGS "${RELEASE_FLAGS} -flto=auto -g3")',
    '  if(NOT APPLE AND NOT MINGW AND NOT (CMAKE_SYSTEM_NAME STREQUAL "Android"))\n    set(RELEASE_FLAGS "${RELEASE_FLAGS} -flto=auto -g3")');
  // System libraries MSVC takes from #pragma comment(lib), which GCC ignores: libmdbx (ntdll, netapi32), the call
  // stack printer (psapi, dbghelp), OpenSSL (crypt32, bcrypt). They go at the end of every link line, after the
  // static libraries that need them.
  add('CMakeLists.txt', '  set(Boost_LIBRARIES "${Boost_LIBRARIES};ws2_32;mswsock")',
    '  set(Boost_LIBRARIES "${Boost_LIBRARIES};ws2_32;mswsock")\n  set(CMAKE_CXX_STANDARD_LIBRARIES "${CMAKE_CXX_STANDARD_LIBRARIES} -lntdll -lnetapi32 -lpsapi -ldbghelp -liphlpapi -lcrypt32 -lbcrypt -lws2_32 -lmswsock")');
  // LMDB declares the NT section calls itself, which WIN32_LEAN_AND_MEAN hides the types for; Zano undefines it for
  // MSVC already.
  add('contrib/CMakeLists.txt', 'if(MSVC)\n  target_compile_options(lmdb PRIVATE "/UWIN32_LEAN_AND_MEAN")\nendif()',
    'if(MSVC)\n  target_compile_options(lmdb PRIVATE "/UWIN32_LEAN_AND_MEAN")\nelseif(MINGW)\n  target_compile_options(lmdb PRIVATE "-UWIN32_LEAN_AND_MEAN")\nendif()');
  // "ui64" is an MSVC-only suffix; MinGW also defines _UI64_MAX. Header names are lower case in MinGW's headers.
  add('src/crypto/ecrypt-config.h', '#ifdef _UI64_MAX\n', '#if defined(_UI64_MAX) && defined(_MSC_VER)\n');
  add('src/common/callstack_helper.cpp', '#include <Psapi.h>', '#include <psapi.h>');
  // The wallet's entry point on Windows is wmain.
  add('src/CMakeLists.txt', 'set_property(TARGET simplewallet PROPERTY OUTPUT_NAME "kusari-wallet")',
    'set_property(TARGET simplewallet PROPERTY OUTPUT_NAME "kusari-wallet")\nif(MINGW)\n  target_link_options(simplewallet PRIVATE -municode)\nendif()');
};
