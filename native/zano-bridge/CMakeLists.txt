cmake_minimum_required(VERSION 3.20)
project(zano_bridge CXX)
set(CMAKE_CXX_STANDARD 17)
# The prebuilt Zano libraries use the shared C++ runtime (/MD), so this must match.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreadedDLL")
# A Windows path arrives with backslashes.
file(TO_CMAKE_PATH "${ZANO_NATIVE_LIB_PATH}" ZANO_ROOT)

if(ANDROID)
  set(INCLUDE ${ZANO_ROOT}/_install_android/include)
  file(GLOB LIBS
    "${ZANO_ROOT}/_install_android/${ANDROID_ABI}/lib/*.a"
    "${ZANO_ROOT}/_libs_android/boost/${ANDROID_ABI}/lib/*.a"
    "${ZANO_ROOT}/_libs_android/openssl/${ANDROID_ABI}/lib/*.a"
    "${ZANO_ROOT}/_libs_android/libbacktrace/${ANDROID_ABI}/lib/*.a")
  list(FILTER LIBS EXCLUDE REGEX "libz\\.a$")
  set(SYSTEM_LIBS z log dl)
elseif(WIN32)
  set(Z ${ZANO_ROOT}/_install_windows)
  set(INCLUDE ${Z}/zano/x86_64/include-plain-wallet)
  file(GLOB LIBS "${Z}/zano/x86_64/lib/*.lib" "${Z}/boost/x86_64/lib/*.lib" "${Z}/openssl/x86_64/lib/*.lib")
  set(SYSTEM_LIBS crypt32 ws2_32 advapi32 user32 bcrypt ntdll dbghelp iphlpapi mswsock winmm ole32 shell32 psapi rpcrt4 version userenv)
elseif(APPLE)
  # Universal (arm64 + x86_64) static libraries packed as xcframeworks.
  set(Z ${ZANO_ROOT}/_install_macosx)
  set(INCLUDE ${Z}/libzano.xcframework/macos-arm64_x86_64/Headers)
  file(GLOB LIBS "${Z}/*.xcframework/macos-arm64_x86_64/*.a")
  set(SYSTEM_LIBS z "-framework CoreFoundation" "-framework Foundation" "-framework Security" "-framework SystemConfiguration")
else()
  set(Z ${ZANO_ROOT}/_install_linux)
  set(INCLUDE ${Z}/zano/x86_64/include-plain-wallet)
  file(GLOB LIBS "${Z}/zano/x86_64/lib/*.a" "${Z}/boost/x86_64/lib/*.a" "${Z}/openssl/x86_64/lib/*.a" "${Z}/iconv/x86_64/lib/*.a")
  # The prebuilt Boost stack traces use libbacktrace, which the Linux package doesn't include: build it
  # (github.com/ianlancetaylor/libbacktrace, BSD) and pass its folder as BACKTRACE_LIB_PATH.
  if(BACKTRACE_LIB_PATH)
    list(APPEND LIBS "${BACKTRACE_LIB_PATH}/libbacktrace.a")
  endif()
  set(SYSTEM_LIBS z pthread dl)
endif()

if(NOT EXISTS "${INCLUDE}/plain_wallet_api.h")
  message(FATAL_ERROR "Zano library not found: ${INCLUDE}")
endif()
list(LENGTH LIBS LIB_COUNT)
message(STATUS "Zano bridge links ${LIB_COUNT} libraries")
if(LIB_COUNT LESS 5)
  message(FATAL_ERROR "Expected the Zano, Boost and OpenSSL libraries, found ${LIB_COUNT}")
endif()
add_executable(zano-bridge main.cpp)
target_include_directories(zano-bridge PRIVATE ${INCLUDE})
if(WIN32 OR APPLE)
  target_link_libraries(zano-bridge PRIVATE ${LIBS} ${SYSTEM_LIBS})
else()
  target_link_libraries(zano-bridge PRIVATE -Wl,--start-group ${LIBS} -Wl,--end-group ${SYSTEM_LIBS})
endif()
