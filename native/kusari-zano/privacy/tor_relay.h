// Kusari: this node's own transactions over Tor.
// Distributed under the MIT/X11 software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.
//
// With --tx-proxy-tor <SOCKS host:port> and one or more --tx-proxy-node <host:port>, a transaction this node
// starts (from its wallet or RPC) is not sent to its peers at all. It goes through Tor to the RPC of another Kusari
// node (an onion address, or any public node), which takes it as its own and starts it on a Dandelion++ stem from
// there. The peers of this node never learn its IP address started anything; the receiving node sees a Tor circuit.
//
// - Each transaction gets a circuit of its own: Tor isolates streams by SOCKS user name, and each send uses a fresh
//   random one.
// - It never falls back to the open network. A send that fails is tried again through Tor after 15 seconds, and one
//   that went through but that nobody broadcast within 90 seconds is sent to another node; each wait is twice the
//   last, up to 10 minutes, for as long as the transaction is in the pool (a Tor outage just delays it).
// - Until it has been broadcast, the pool shows it to nobody (privacy/stem-hiding.js).
// - The nodes given should broadcast normally: two nodes that pass transactions to each other through Tor would each
//   wait for the other.

#pragma once

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstring>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
#else
#include <netdb.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <sys/types.h>
#include <unistd.h>
#endif

#include "common/command_line.h"
#include "crypto/crypto.h"
#include "string_tools.h"

namespace currency
{
  inline const command_line::arg_descriptor<std::string>& arg_kusari_tx_proxy_tor()
  {
    static const command_line::arg_descriptor<std::string> a("tx-proxy-tor",
      "Send this node's own transactions only through this Tor SOCKS proxy (host:port, e.g. 127.0.0.1:9050), to the nodes given with --tx-proxy-node, never to peers", "");
    return a;
  }
  inline const command_line::arg_descriptor<std::vector<std::string>>& arg_kusari_tx_proxy_node()
  {
    static const command_line::arg_descriptor<std::vector<std::string>> a("tx-proxy-node",
      "A Kusari node's RPC (host:port, an onion address works) that takes this node's transactions through Tor; give several");
    return a;
  }
  inline void kusari_tor_init_options(boost::program_options::options_description& desc)
  {
    command_line::add_arg(desc, arg_kusari_tx_proxy_tor());
    command_line::add_arg(desc, arg_kusari_tx_proxy_node());
  }

  namespace kusari_tor_detail
  {
#ifdef _WIN32
    typedef SOCKET sock_t;
    static const sock_t bad_sock = INVALID_SOCKET;
    inline void close_sock(sock_t s) { closesocket(s); }
#else
    typedef int sock_t;
    static const sock_t bad_sock = -1;
    inline void close_sock(sock_t s) { ::close(s); }
#endif

    inline bool split_host_port(const std::string& s, std::string& host, uint16_t& port)
    {
      const size_t c = s.rfind(':');
      if (c == std::string::npos || c == 0 || c + 1 == s.size())
        return false;
      host = s.substr(0, c);
      unsigned long p = 0;
      try { p = std::stoul(s.substr(c + 1)); } catch (...) { return false; }
      if (p == 0 || p > 65535)
        return false;
      port = static_cast<uint16_t>(p);
      return true;
    }

    struct socket_guard
    {
      sock_t s = bad_sock;
      ~socket_guard() { if (s != bad_sock) close_sock(s); }
    };

    inline bool send_all(sock_t s, const std::string& data)
    {
      size_t off = 0;
      while (off < data.size())
      {
        const int n = ::send(s, data.data() + off, static_cast<int>(data.size() - off), 0);
        if (n <= 0)
          return false;
        off += static_cast<size_t>(n);
      }
      return true;
    }

    inline bool recv_exact(sock_t s, char* buf, size_t len)
    {
      size_t off = 0;
      while (off < len)
      {
        const int n = ::recv(s, buf + off, static_cast<int>(len - off), 0);
        if (n <= 0)
          return false;
        off += static_cast<size_t>(n);
      }
      return true;
    }

    // POSTs the transaction to host:port's /sendrawtransaction through the SOCKS5 proxy. The host name goes to the
    // proxy unresolved, so onion addresses work and nothing is looked up outside Tor.
    inline bool post_tx(const std::string& proxy_host, uint16_t proxy_port, const std::string& host, uint16_t port,
      const std::string& tx_hex, const std::string& isolation, std::string& err)
    {
      if (host.size() > 255) { err = "host name too long"; return false; }
      addrinfo hints{};
      hints.ai_family = AF_UNSPEC;
      hints.ai_socktype = SOCK_STREAM;
      addrinfo* res = nullptr;
      if (getaddrinfo(proxy_host.c_str(), std::to_string(proxy_port).c_str(), &hints, &res) != 0 || !res)
      {
        err = "can't resolve the proxy " + proxy_host;
        return false;
      }
      socket_guard g;
      for (addrinfo* ai = res; ai && g.s == bad_sock; ai = ai->ai_next)
      {
        sock_t s = ::socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol);
        if (s == bad_sock)
          continue;
        if (::connect(s, ai->ai_addr, static_cast<int>(ai->ai_addrlen)) == 0)
          g.s = s;
        else
          close_sock(s);
      }
      freeaddrinfo(res);
      if (g.s == bad_sock) { err = "can't connect to the proxy"; return false; }

      // Building a circuit and reaching an onion service can take a while.
#ifdef _WIN32
      DWORD ms = 120000;
      setsockopt(g.s, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char*>(&ms), sizeof(ms));
      setsockopt(g.s, SOL_SOCKET, SO_SNDTIMEO, reinterpret_cast<const char*>(&ms), sizeof(ms));
#else
      timeval tv{120, 0};
      setsockopt(g.s, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
      setsockopt(g.s, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
#endif

      // SOCKS5 greeting: user name and password (Tor isolates circuits by them), or none.
      char r[2];
      if (!send_all(g.s, std::string("\x05\x02\x02\x00", 4)) || !recv_exact(g.s, r, 2) || r[0] != 5)
      { err = "not a SOCKS5 proxy"; return false; }
      if (r[1] == 2)
      {
        std::string auth("\x01", 1);
        auth += static_cast<char>(isolation.size());
        auth += isolation;
        auth += static_cast<char>(1);
        auth += 'x';
        if (!send_all(g.s, auth) || !recv_exact(g.s, r, 2) || r[1] != 0)
        { err = "the proxy refused the login"; return false; }
      }
      else if (r[1] != 0)
      { err = "the proxy offers no usable login"; return false; }

      std::string req("\x05\x01\x00\x03", 4);
      req += static_cast<char>(host.size());
      req += host;
      req += static_cast<char>(port >> 8);
      req += static_cast<char>(port & 0xff);
      char head[4];
      if (!send_all(g.s, req) || !recv_exact(g.s, head, 4) || head[0] != 5)
      { err = "no answer from the proxy"; return false; }
      if (head[1] != 0)
      { err = "the proxy couldn't reach " + host + " (SOCKS error " + std::to_string(static_cast<int>(static_cast<unsigned char>(head[1]))) + ")"; return false; }
      size_t rest = 0;
      if (head[3] == 1) rest = 4 + 2;
      else if (head[3] == 4) rest = 16 + 2;
      else if (head[3] == 3)
      {
        char l = 0;
        if (!recv_exact(g.s, &l, 1)) { err = "short SOCKS reply"; return false; }
        rest = static_cast<unsigned char>(l) + 2;
      }
      else { err = "bad SOCKS reply"; return false; }
      std::string skip(rest, '\0');
      if (!recv_exact(g.s, &skip[0], rest)) { err = "short SOCKS reply"; return false; }

      const std::string body = "{\"tx_as_hex\":\"" + tx_hex + "\"}";
      const std::string http = "POST /sendrawtransaction HTTP/1.1\r\nHost: " + host + "\r\nContent-Type: application/json\r\n"
        "Content-Length: " + std::to_string(body.size()) + "\r\nConnection: close\r\n\r\n" + body;
      if (!send_all(g.s, http)) { err = "sending failed"; return false; }
      std::string answer;
      char buf[4096];
      for (;;)
      {
        const int n = ::recv(g.s, buf, sizeof(buf), 0);
        if (n <= 0)
          break;
        answer.append(buf, static_cast<size_t>(n));
        if (answer.size() > 65536)
          break;
      }
      const size_t st = answer.find("\"status\"");
      const size_t ok = st == std::string::npos ? std::string::npos : answer.find("\"OK\"", st);
      if (ok == std::string::npos || ok - st > 16)
      {
        const size_t eol = answer.find("\r\n");
        err = answer.empty() ? "no answer from the node" : "the node refused it: " + answer.substr(0, eol == std::string::npos ? 80 : eol);
        return false;
      }
      return true;
    }
  }

  class kusari_tor_relay
  {
  public:
    // Returns false for a setting that would leave this node's transactions with nowhere to go but the open network.
    bool configure(const boost::program_options::variables_map& vm)
    {
      const std::string proxy = command_line::get_arg(vm, arg_kusari_tx_proxy_tor());
      if (proxy.empty())
        return true;
      if (!kusari_tor_detail::split_host_port(proxy, m->proxy_host, m->proxy_port))
      {
        LOG_ERROR("[TOR] --tx-proxy-tor needs host:port, got " << proxy);
        return false;
      }
      if (command_line::has_arg(vm, arg_kusari_tx_proxy_node()))
      {
        for (const auto& n : command_line::get_arg(vm, arg_kusari_tx_proxy_node()))
        {
          std::string h;
          uint16_t p = 0;
          if (!kusari_tor_detail::split_host_port(n, h, p))
          {
            LOG_ERROR("[TOR] --tx-proxy-node needs host:port, got " << n);
            return false;
          }
          m->nodes.emplace_back(h, p);
        }
      }
      if (m->nodes.empty())
      {
        LOG_ERROR("[TOR] --tx-proxy-tor needs at least one --tx-proxy-node to send to");
        return false;
      }
      m->enabled = true;
      LOG_PRINT_L0("[TOR] this node's own transactions go only through Tor (" << proxy << ") to " << m->nodes.size() << " node(s)");
      return true;
    }

    bool enabled() const { return m->enabled; }

    // Hands each transaction (id, blob) to Tor, once. One already on its way is left alone.
    void send(const std::vector<std::pair<std::string, std::string>>& txs, uint64_t now)
    {
      for (const auto& t : txs)
      {
        {
          std::lock_guard<std::mutex> l(m->lock);
          if (m->pending.count(t.first))
            continue;
          m->pending[t.first] = entry{t.second, 0, now, SIZE_MAX, false};
        }
        launch(t.first);
      }
    }

    bool is_pending(const std::string& id) const
    {
      std::lock_guard<std::mutex> l(m->lock);
      return m->pending.count(id) != 0;
    }

    // Someone broadcast it: Tor's job is done.
    void seen(const std::string& id)
    {
      std::lock_guard<std::mutex> l(m->lock);
      if (m->pending.erase(id))
      {
        LOG_PRINT_L1("[TOR] tx " << epee::string_tools::buff_to_hex_nodelimer(id) << " has been broadcast");
      }
    }

    // Retries what was not broadcast in time, drops what left the pool.
    void tick(uint64_t now, const std::function<bool(const std::string&)>& in_pool)
    {
      std::vector<std::string> again;
      {
        std::lock_guard<std::mutex> l(m->lock);
        for (auto it = m->pending.begin(); it != m->pending.end();)
        {
          if (!in_pool(it->first))
          {
            it = m->pending.erase(it);
            continue;
          }
          entry& e = it->second;
          if (!e.in_flight && now >= e.next_ms)
            again.push_back(it->first);
          ++it;
        }
      }
      for (const auto& id : again)
        launch(id);
    }

  private:
    static const uint64_t retry_ms = 90000;        // nobody broadcast it after a send that went through
    static const uint64_t retry_failed_ms = 15000; // a send that failed
    static const uint64_t retry_max_ms = 600000;

    struct entry
    {
      std::string blob;
      unsigned attempts;
      uint64_t next_ms;    // when to send it again if nobody broadcast it
      size_t last_node;    // not the same node twice in a row
      bool in_flight;
    };
    struct state
    {
      mutable std::mutex lock;
      bool enabled = false;
      std::string proxy_host;
      uint16_t proxy_port = 0;
      std::vector<std::pair<std::string, uint16_t>> nodes;
      std::map<std::string, entry> pending;
    };
    std::shared_ptr<state> m = std::make_shared<state>();

    void launch(const std::string& id)
    {
      std::shared_ptr<state> s = m;
      std::string blob;
      size_t node = 0;
      {
        std::lock_guard<std::mutex> l(s->lock);
        auto it = s->pending.find(id);
        if (it == s->pending.end() || it->second.in_flight)
          return;
        entry& e = it->second;
        node = crypto::rand<uint64_t>() % s->nodes.size();
        if (s->nodes.size() > 1 && node == e.last_node)
          node = (node + 1 + crypto::rand<uint64_t>() % (s->nodes.size() - 1)) % s->nodes.size();
        e.last_node = node;
        e.in_flight = true;
        ++e.attempts;
        blob = e.blob;
      }
      std::thread([s, id, blob, node]() {
        const std::string isolation = epee::string_tools::pod_to_hex(crypto::rand<uint64_t>());
        std::string err;
        const auto& n = s->nodes[node];
        const bool ok = kusari_tor_detail::post_tx(s->proxy_host, s->proxy_port, n.first, n.second,
          epee::string_tools::buff_to_hex_nodelimer(blob), isolation, err);
        const uint64_t now = static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch()).count());
        std::lock_guard<std::mutex> l(s->lock);
        auto it = s->pending.find(id);
        if (it == s->pending.end())
          return;
        entry& e = it->second;
        e.in_flight = false;
        // Sooner after a failed send, later after one that went through but nobody has broadcast yet; each wait twice
        // the last, up to retry_max_ms.
        uint64_t wait = ok ? retry_ms : retry_failed_ms;
        for (unsigned i = 1; i < e.attempts && wait < retry_max_ms; ++i)
          wait *= 2;
        e.next_ms = now + std::min(wait, retry_max_ms);
        const std::string tx = epee::string_tools::buff_to_hex_nodelimer(id);
        if (ok)
        {
          LOG_PRINT_L0("[TOR] sent tx " << tx << " to " << n.first << ":" << n.second << " through Tor");
        }
        else
        {
          LOG_PRINT_YELLOW("[TOR] could not send tx " << tx << " through Tor (" << err << "), trying again in " << (e.next_ms - now) / 1000 << " s; never on the open network", LOG_LEVEL_0);
        }
      }).detach();
    }
  };
}
