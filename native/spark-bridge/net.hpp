// A small ElectrumX client: newline-delimited JSON-RPC over TLS, directly, through Tor's SOCKS5 port, or through an
// HTTP CONNECT proxy (development only). Certificates are pinned by the caller on first use, the way Electrum wallets
// treat self-signed servers: the SHA-256 of the server certificate is reported, and a mismatch with a given pin stops
// the connection before anything is sent.
#pragma once

#include <cstdint>
#include <cstring>
#include <mutex>
#include <stdexcept>
#include <string>
#include <vector>

#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
typedef SOCKET sock_t;
static const sock_t BAD_SOCK = INVALID_SOCKET;
static void closeSock(sock_t s) { closesocket(s); }
#else
#include <netdb.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>
typedef int sock_t;
static const sock_t BAD_SOCK = -1;
static void closeSock(sock_t s) { ::close(s); }
#endif

#include <openssl/err.h>
#include <openssl/sha.h>
#include <openssl/ssl.h>
#include <openssl/x509.h>
#include <openssl/x509v3.h>

#include "json.hpp"

namespace net {

using nlohmann::json;

struct Server {
  std::string host;
  int port = 50002;
  std::string pin;  // hex SHA-256 of the certificate, empty on first use
};

inline void startup() {
#ifdef _WIN32
  static bool done = false;
  if (!done) { WSADATA w; WSAStartup(MAKEWORD(2, 2), &w); done = true; }
#endif
}

inline std::string hexOf(const unsigned char* p, size_t n) {
  static const char* d = "0123456789abcdef";
  std::string s(n * 2, '0');
  for (size_t i = 0; i < n; i++) { s[i * 2] = d[p[i] >> 4]; s[i * 2 + 1] = d[p[i] & 15]; }
  return s;
}

inline sock_t tcp(const std::string& host, int port, int timeoutSec) {
  startup();
  addrinfo hints{};
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_STREAM;
  addrinfo* res = nullptr;
  if (getaddrinfo(host.c_str(), std::to_string(port).c_str(), &hints, &res) != 0 || !res) throw std::runtime_error("could not look up " + host);
  sock_t s = BAD_SOCK;
  for (addrinfo* a = res; a; a = a->ai_next) {
    s = socket(a->ai_family, a->ai_socktype, a->ai_protocol);
    if (s == BAD_SOCK) continue;
#ifdef _WIN32
    DWORD tv = timeoutSec * 1000;
    setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, (const char*)&tv, sizeof tv);
    setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, (const char*)&tv, sizeof tv);
#else
    timeval tv{ timeoutSec, 0 };
    setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
    setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
#endif
    if (connect(s, a->ai_addr, (int)a->ai_addrlen) == 0) break;
    closeSock(s);
    s = BAD_SOCK;
  }
  freeaddrinfo(res);
  if (s == BAD_SOCK) throw std::runtime_error("could not connect to " + host);
  return s;
}

inline void sendAll(sock_t s, const std::string& data) {
  size_t off = 0;
  while (off < data.size()) {
    int n = send(s, data.data() + off, (int)(data.size() - off), 0);
    if (n <= 0) throw std::runtime_error("the connection dropped");
    off += (size_t)n;
  }
}

inline void recvExact(sock_t s, unsigned char* out, size_t len) {
  size_t off = 0;
  while (off < len) {
    int n = recv(s, (char*)out + off, (int)(len - off), 0);
    if (n <= 0) throw std::runtime_error("the proxy closed the connection");
    off += (size_t)n;
  }
}

// SOCKS5 with the name resolved by the proxy, so lookups go through Tor too.
inline void socks5(sock_t s, const std::string& host, int port) {
  if (host.size() > 255) throw std::runtime_error("host name too long");
  sendAll(s, std::string("\x05\x01\x00", 3));
  unsigned char r[4];
  recvExact(s, r, 2);
  if (r[0] != 5 || r[1] != 0) throw std::runtime_error("Tor refused the connection");
  std::string req("\x05\x01\x00\x03", 4);
  req += (char)host.size();
  req += host;
  req += (char)((port >> 8) & 0xff);
  req += (char)(port & 0xff);
  sendAll(s, req);
  recvExact(s, r, 4);
  if (r[1] != 0) throw std::runtime_error("Tor could not reach " + host + " (code " + std::to_string(r[1]) + ")");
  size_t skip = r[3] == 1 ? 4 : r[3] == 4 ? 16 : 0;
  if (r[3] == 3) { unsigned char l; recvExact(s, &l, 1); skip = l; }
  std::vector<unsigned char> rest(skip + 2);
  recvExact(s, rest.data(), rest.size());
}

inline void httpConnect(sock_t s, const std::string& host, int port) {
  std::string target = host + ":" + std::to_string(port);
  sendAll(s, "CONNECT " + target + " HTTP/1.1\r\nHost: " + target + "\r\n\r\n");
  std::string head;
  unsigned char c;
  while (head.size() < 8192) {
    recvExact(s, &c, 1);
    head += (char)c;
    if (head.size() >= 4 && head.compare(head.size() - 4, 4, "\r\n\r\n") == 0) break;
  }
  if (head.find(" 200") == std::string::npos) throw std::runtime_error("the proxy refused " + target);
}

class Electrum {
 public:
  std::string socks;    // "127.0.0.1:9050" when Tor is on
  std::string connect;  // "host:port" of an HTTP CONNECT proxy, development only
  std::string fingerprint;
  bool verified = false;
  std::string host;

  ~Electrum() { close(); }

  bool isOpen() const { return ssl != nullptr; }

  void close() {
    if (ssl) { SSL_shutdown(ssl); SSL_free(ssl); ssl = nullptr; }
    if (ctx) { SSL_CTX_free(ctx); ctx = nullptr; }
    if (fd != BAD_SOCK) { closeSock(fd); fd = BAD_SOCK; }
    buf.clear();
  }

  void open(const Server& srv, int timeoutSec = 60) {
    close();
    auto split = [](const std::string& hp) {
      auto at = hp.rfind(':');
      if (at == std::string::npos) throw std::runtime_error("bad proxy address");
      return std::make_pair(hp.substr(0, at), std::stoi(hp.substr(at + 1)));
    };
    if (!socks.empty()) {
      auto p = split(socks);
      fd = tcp(p.first, p.second, timeoutSec);
      socks5(fd, srv.host, srv.port);
    } else if (!connect.empty()) {
      auto p = split(connect);
      fd = tcp(p.first, p.second, timeoutSec);
      httpConnect(fd, srv.host, srv.port);
    } else {
      fd = tcp(srv.host, srv.port, timeoutSec);
    }
    ctx = SSL_CTX_new(TLS_client_method());
    if (!ctx) throw std::runtime_error("TLS is not available");
    SSL_CTX_set_default_verify_paths(ctx);
    SSL_CTX_set_verify(ctx, SSL_VERIFY_NONE, nullptr);
    ssl = SSL_new(ctx);
    SSL_set_fd(ssl, (int)fd);
    bool ip = srv.host.find_first_not_of("0123456789.") == std::string::npos || srv.host.find(':') != std::string::npos;
    if (!ip) SSL_set_tlsext_host_name(ssl, srv.host.c_str());
    if (SSL_connect(ssl) != 1) { close(); throw std::runtime_error("TLS with " + srv.host + " failed"); }
    X509* cert = SSL_get_peer_certificate(ssl);
    if (!cert) { close(); throw std::runtime_error(srv.host + " sent no certificate"); }
    unsigned char md[32];
    unsigned int mdLen = 0;
    X509_digest(cert, EVP_sha256(), md, &mdLen);
    fingerprint = hexOf(md, mdLen);
    verified = SSL_get_verify_result(ssl) == X509_V_OK && (ip || X509_check_host(cert, srv.host.c_str(), srv.host.size(), 0, nullptr) == 1);
    X509_free(cert);
    if (!srv.pin.empty() && srv.pin != fingerprint) {
      close();
      throw std::runtime_error("The certificate of " + srv.host + " changed since it was first used, so the wallet did not connect.");
    }
    host = srv.host;
  }

  json call(const std::string& method, const json& params) {
    std::lock_guard<std::mutex> lock(mu);
    if (!ssl) throw std::runtime_error("not connected");
    int id = next++;
    std::string line = json{ { "jsonrpc", "2.0" }, { "id", id }, { "method", method }, { "params", params } }.dump() + "\n";
    if (SSL_write(ssl, line.data(), (int)line.size()) <= 0) { close(); throw std::runtime_error("the server connection dropped"); }
    for (;;) {
      std::string got = readLine();
      json ans;
      try { ans = json::parse(got); } catch (...) { continue; }
      if (!ans.is_object() || !ans.contains("id") || ans["id"] != id) continue;  // notifications and stale answers
      if (ans.contains("error") && !ans["error"].is_null()) {
        const json& e = ans["error"];
        throw std::runtime_error(e.is_object() ? e.value("message", e.dump()) : e.dump());
      }
      return ans.value("result", json(nullptr));
    }
  }

 private:
  sock_t fd = BAD_SOCK;
  SSL_CTX* ctx = nullptr;
  SSL* ssl = nullptr;
  std::string buf;
  int next = 1;
  std::mutex mu;

  std::string readLine() {
    char chunk[65536];
    for (;;) {
      auto at = buf.find('\n');
      if (at != std::string::npos) {
        std::string line = buf.substr(0, at);
        buf.erase(0, at + 1);
        return line;
      }
      if (buf.size() > (size_t)512 * 1024 * 1024) { close(); throw std::runtime_error("the server answer is too large"); }
      int n = SSL_read(ssl, chunk, sizeof chunk);
      if (n <= 0) { close(); throw std::runtime_error("the server connection dropped"); }
      buf.append(chunk, (size_t)n);
    }
  }
};

}  // namespace net
