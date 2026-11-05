// A small process that holds the Zano wallet library, for the desktop app. One JSON request per line on
// stdin, one JSON answer per line on stdout. Seeds and passwords only ever pass through these pipes.
#include <iostream>
#include <string>
#include "plain_wallet_api.h"

int main(int argc, char** argv) {
  if (argc > 1 && std::string(argv[1]) == "--version") {
    std::cout << plain_wallet::get_version() << std::endl;
    return 0;
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
