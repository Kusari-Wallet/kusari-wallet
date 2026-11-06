// The wallet library has no proxy setting, so it talks to this local port and everything goes on through Tor.
// If Tor isn't there the connection just fails: there is no way from here to the node except through the SOCKS port.
#pragma once
#include <cstdint>
#include <cstring>
#include <string>
#include <thread>
#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
using sock_t = SOCKET;
#define CLOSE_SOCK closesocket
#else
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
using sock_t = int;
#define INVALID_SOCKET (-1)
#define CLOSE_SOCK close
#endif

namespace relay {

inline bool sendAll(sock_t s, const char* data, size_t n) {
  while (n > 0) {
    const auto sent = send(s, data, static_cast<int>(n), 0);
    if (sent <= 0) return false;
    data += sent;
    n -= static_cast<size_t>(sent);
  }
  return true;
}

inline bool recvAll(sock_t s, char* data, size_t n) {
  while (n > 0) {
    const auto got = recv(s, data, static_cast<int>(n), 0);
    if (got <= 0) return false;
    data += got;
    n -= static_cast<size_t>(got);
  }
  return true;
}

inline sock_t listenLoopback(uint16_t* port) {
  sock_t s = socket(AF_INET, SOCK_STREAM, 0);
  if (s == INVALID_SOCKET) return INVALID_SOCKET;
  sockaddr_in a{};
  a.sin_family = AF_INET;
  a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  socklen_t len = sizeof a;
  if (bind(s, reinterpret_cast<sockaddr*>(&a), sizeof a) != 0 || listen(s, 16) != 0 ||
      getsockname(s, reinterpret_cast<sockaddr*>(&a), &len) != 0) {
    CLOSE_SOCK(s);
    return INVALID_SOCKET;
  }
  *port = ntohs(a.sin_port);
  return s;
}

// Asks Tor for the target by name, so the name is resolved at the far end and not here.
inline sock_t throughSocks(uint16_t socksPort, const std::string& host, uint16_t port) {
  if (host.size() > 255) return INVALID_SOCKET;
  sock_t s = socket(AF_INET, SOCK_STREAM, 0);
  if (s == INVALID_SOCKET) return INVALID_SOCKET;
  sockaddr_in a{};
  a.sin_family = AF_INET;
  a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  a.sin_port = htons(socksPort);
  char reply[4];
  std::string req("\x05\x01\x00", 3);
  bool ok = connect(s, reinterpret_cast<sockaddr*>(&a), sizeof a) == 0 && sendAll(s, req.data(), req.size()) &&
            recvAll(s, reply, 2) && reply[0] == 5 && reply[1] == 0;
  if (ok) {
    req = std::string("\x05\x01\x00\x03", 4);
    req += static_cast<char>(host.size());
    req += host;
    req += static_cast<char>(port >> 8);
    req += static_cast<char>(port & 0xff);
    ok = sendAll(s, req.data(), req.size()) && recvAll(s, reply, 4) && reply[0] == 5 && reply[1] == 0;
  }
  if (ok) {
    char skip[262];
    size_t rest = 0;
    if (reply[3] == 1) rest = 6;
    else if (reply[3] == 4) rest = 18;
    else if (reply[3] == 3) {
      ok = recvAll(s, skip, 1);
      rest = static_cast<unsigned char>(skip[0]) + 2u;
    } else ok = false;
    ok = ok && recvAll(s, skip, rest);
  }
  if (!ok) {
    CLOSE_SOCK(s);
    return INVALID_SOCKET;
  }
  return s;
}

inline void pump(sock_t from, sock_t to) {
  char buffer[16384];
  for (;;) {
    const auto got = recv(from, buffer, sizeof buffer, 0);
    if (got <= 0 || !sendAll(to, buffer, static_cast<size_t>(got))) break;
  }
#ifdef _WIN32
  shutdown(to, SD_SEND);
#else
  shutdown(to, SHUT_WR);
#endif
}

// Returns the local port to use as the node's address, or 0.
inline uint16_t start(uint16_t socksPort, const std::string& host, uint16_t port) {
#ifdef _WIN32
  WSADATA wsa;
  WSAStartup(MAKEWORD(2, 2), &wsa);
#endif
  uint16_t local = 0;
  const sock_t server = listenLoopback(&local);
  if (server == INVALID_SOCKET) return 0;
  std::thread([=] {
    for (;;) {
      const sock_t client = accept(server, nullptr, nullptr);
      if (client == INVALID_SOCKET) continue;
      std::thread([=] {
        const sock_t remote = throughSocks(socksPort, host, port);
        if (remote != INVALID_SOCKET) {
          std::thread up([=] { pump(client, remote); });
          pump(remote, client);
          up.join();
          CLOSE_SOCK(remote);
        }
        CLOSE_SOCK(client);
      }).detach();
    }
  }).detach();
  return local;
}

}  // namespace relay
