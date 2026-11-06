// A small process that holds the Zano wallet library, the same on Windows and Android. One request per line on
// stdin, one JSON answer per line on stdout. Keys and passwords only ever pass through these pipes.
#include <chrono>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <random>
#include <sstream>
#include <string>
#include <thread>
#include "plain_wallet_api.h"

namespace {

std::string randomHex(size_t bytes) {
  std::random_device rd;
  std::ostringstream out;
  const char* hex = "0123456789abcdef";
  for (size_t i = 0; i < bytes; i++) {
    const unsigned v = rd() & 0xff;
    out << hex[v >> 4] << hex[v & 15];
  }
  return out.str();
}

std::string field(const std::string& json, const std::string& name) {
  const std::string key = "\"" + name + "\"";
  auto at = json.find(key);
  if (at == std::string::npos) return "";
  at = json.find(':', at);
  if (at == std::string::npos) return "";
  at++;
  while (at < json.size() && (json[at] == ' ' || json[at] == '\n' || json[at] == '\r' || json[at] == '\t')) at++;
  if (at < json.size() && json[at] == '"') {
    const auto end = json.find('"', at + 1);
    return json.substr(at + 1, end - at - 1);
  }
  auto end = at;
  while (end < json.size() && json[end] != ',' && json[end] != '}' && json[end] != '\n') end++;
  return json.substr(at, end - at);
}

// A throwaway key, so nothing here can ever hold funds or leave a trace of a real wallet.
int selftest(const std::string& node, const std::string& dir) {
  std::cout << "init: " << plain_wallet::init(node, dir, 0).substr(0, 120) << std::endl;
  const std::string secret = randomHex(32);
  const std::string pass = randomHex(16);
  const auto restore = [&](const std::string& path) {
    return plain_wallet::sync_call("restore_from_derivations", 0,
      "{\"pass\":\"" + pass + "\",\"path\":\"" + path + "\",\"secret_derivation\":\"" + secret +
      "\",\"is_auditable\":false,\"creation_timestamp\":" +
      std::to_string(std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count()) + "}");
  };
  const std::string first = restore("selftest-a");
  const std::string id = field(first, "wallet_id");
  std::cout << "wallet id: " << id << std::endl;
  if (id.empty()) { std::cout << "restore failed: " << first.substr(0, 300) << std::endl; return 1; }
  const std::string address = field(first, "address");
  std::cout << "address prefix: " << address.substr(0, 6) << " length " << address.size() << std::endl;

  const auto started = std::chrono::steady_clock::now();
  for (;;) {
    const std::string status = plain_wallet::sync_call("get_wallet_status", std::stoull(id), "");
    const std::string state = field(status, "wallet_state");
    const std::string progress = field(status, "progress");
    const auto seconds = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::steady_clock::now() - started).count();
    if (seconds % 15 == 0) std::cout << "t=" << seconds << " " << status.substr(0, 160) << std::endl;
    if (state == "2") { std::cout << "synced after " << seconds << "s" << std::endl; break; }
    if (seconds > 900) { std::cout << "sync timed out: " << plain_wallet::get_connectivity_status() << std::endl; return 1; }
    std::this_thread::sleep_for(std::chrono::seconds(1));
  }
  const std::string balance = plain_wallet::sync_call("invoke", std::stoull(id),
    "{\"jsonrpc\":\"2.0\",\"id\":0,\"method\":\"getbalance\",\"params\":{}}");
  std::cout << "balance: " << balance.substr(0, 200) << std::endl;
  plain_wallet::sync_call("close", std::stoull(id), "");

  // The same key must give the same address, or a seed couldn't bring a wallet back.
  const std::string second = restore("selftest-b");
  if (field(second, "address") != address) { std::cout << "address differs on restore" << std::endl; return 1; }
  std::cout << "selftest ok" << std::endl;
  return 0;
}

}  // namespace

int main(int argc, char** argv) {
  const std::string first = argc > 1 ? argv[1] : "";
  if (first == "--version") {
    std::cout << plain_wallet::get_version() << std::endl;
    return 0;
  }
  if (first == "--selftest" && argc > 3) {
    const int code = selftest(argv[2], argv[3]);
    std::cout.flush();
    // The library's threads have no clean way down here, and the result is already out.
    std::_Exit(code);
  }
  std::string line;
  while (std::getline(std::cin, line)) {
    std::string::size_type a = line.find('\t');
    std::string::size_type b = a == std::string::npos ? a : line.find('\t', a + 1);
    if (b == std::string::npos) { std::cout << "{\"error\":\"bad request\"}" << std::endl; continue; }
    const std::string method = line.substr(0, a);
    const std::string id = line.substr(a + 1, b - a - 1);
    const std::string params = line.substr(b + 1);
    std::cout << plain_wallet::sync_call(method, std::stoull(id), params) << std::endl;
  }
  return 0;
}
