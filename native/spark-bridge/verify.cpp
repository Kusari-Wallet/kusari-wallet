// Test tool, not shipped: checks a Spark spend the way a Firo node does before relaying it. Reads one JSON object on
// stdin, {"tx": hex, "sets": [{"id": n, "coins": [hex, newest first], "setHash": hex}]}, and prints
// {"ok": bool, "fee": n, "vout": n, "inputs": n, "error": "..."}. The metadata hash is the transaction without its
// extra payload and without its private outputs, as in CheckSparkSpendTransaction.
#include <iostream>
#include <map>
#include <string>
#include <unordered_map>
#include <vector>

#include "json.hpp"
#include "deps/sparkmobile/bitcoin/streams.h"
#include "deps/sparkmobile/bitcoin/hash.h"
#include "deps/sparkmobile/src/spend_transaction.h"

using nlohmann::json;

static std::vector<unsigned char> unhex(const std::string& h) {
  std::vector<unsigned char> out(h.size() / 2);
  for (size_t i = 0; i < out.size(); i++) out[i] = (unsigned char)std::stoul(h.substr(i * 2, 2), nullptr, 16);
  return out;
}

static std::string hexs(const std::vector<unsigned char>& v) {
  static const char* d = "0123456789abcdef";
  std::string s;
  for (auto c : v) { s += d[c >> 4]; s += d[c & 15]; }
  return s;
}

struct Reader {
  const std::vector<unsigned char>& b;
  size_t at = 0;
  uint64_t le(int n) { uint64_t v = 0; for (int i = 0; i < n; i++) v |= (uint64_t)b.at(at++) << (8 * i); return v; }
  uint64_t varint() { uint8_t c = b.at(at++); return c < 0xfd ? c : c == 0xfd ? le(2) : c == 0xfe ? le(4) : le(8); }
  std::vector<unsigned char> bytes(size_t n) { std::vector<unsigned char> v(b.begin() + at, b.begin() + at + n); at += n; return v; }
};

static void putVarint(std::vector<unsigned char>& o, uint64_t n) {
  if (n < 0xfd) { o.push_back((unsigned char)n); return; }
  int w = n <= 0xffff ? 2 : n <= 0xffffffff ? 4 : 8;
  o.push_back(w == 2 ? 0xfd : w == 4 ? 0xfe : 0xff);
  for (int i = 0; i < w; i++) o.push_back((n >> (8 * i)) & 0xff);
}

int main() {
  json out;
  try {
    json in = json::parse(std::cin);
    std::vector<unsigned char> tx = unhex(in.at("tx").get<std::string>());
    Reader r{ tx };
    uint32_t ver = (uint32_t)r.le(4);
    if ((ver & 0xffff) != 3) throw std::runtime_error("not a version 3 transaction");
    int type = ver >> 16;
    std::vector<unsigned char> head(tx.begin(), tx.begin() + 4);
    size_t vinStart = r.at;
    uint64_t nIn = r.varint();
    for (uint64_t i = 0; i < nIn; i++) { r.bytes(36); r.bytes(r.varint()); r.le(4); }
    std::vector<unsigned char> vin(tx.begin() + vinStart, tx.begin() + r.at);
    uint64_t nOut = r.varint();
    std::vector<std::pair<uint64_t, std::vector<unsigned char>>> outs;
    for (uint64_t i = 0; i < nOut; i++) { uint64_t v = r.le(8); outs.push_back({ v, r.bytes(r.varint()) }); }
    uint32_t lock = (uint32_t)r.le(4);
    std::vector<unsigned char> payload = r.bytes(r.varint());
    if (r.at != tx.size()) throw std::runtime_error("trailing bytes");

    // The metadata hash.
    std::vector<unsigned char> meta = head;
    meta.insert(meta.end(), vin.begin(), vin.end());
    std::vector<std::pair<uint64_t, std::vector<unsigned char>>> pub;
    std::vector<std::vector<unsigned char>> priv;
    for (auto& o : outs) (o.second.size() && o.second[0] == 0xd2 ? priv.push_back(o.second) : pub.push_back(o));
    putVarint(meta, pub.size());
    uint64_t vout = 0;
    for (auto& o : pub) {
      vout += o.first;
      for (int i = 0; i < 8; i++) meta.push_back((o.first >> (8 * i)) & 0xff);
      putVarint(meta, o.second.size());
      meta.insert(meta.end(), o.second.begin(), o.second.end());
    }
    for (int i = 0; i < 4; i++) meta.push_back((lock >> (8 * i)) & 0xff);
    meta.push_back(0);
    uint256 sig = Hash(meta.begin(), meta.end());

    const spark::Params* params = spark::Params::get_default();
    auto version = type == 11 ? spark::SpendTransactionVersion::V2 : spark::SpendTransactionVersion::V1;
    spark::SpendTransaction spend(params, version, priv.size());
    CDataStream ps((const char*)payload.data(), (const char*)payload.data() + payload.size(), SER_NETWORK, PROTOCOL_VERSION);
    ps >> spend;
    std::vector<spark::Coin> outCoins;
    for (auto& s : priv) {
      CDataStream cs((const char*)s.data() + 1, (const char*)s.data() + s.size(), SER_NETWORK, PROTOCOL_VERSION);
      spark::Coin c(params);
      cs >> c;
      outCoins.push_back(c);
    }
    spend.setOutCoins(outCoins);
    std::unordered_map<uint64_t, std::vector<spark::Coin>> sets;
    std::unordered_map<uint64_t, spark::CoverSetData> data;
    for (const auto& s : in.at("sets")) {
      uint64_t id = s.at("id").get<uint64_t>();
      std::vector<spark::Coin> coins;
      for (const auto& h : s.at("coins")) {
        auto b = unhex(h.get<std::string>());
        CDataStream cs((const char*)b.data(), (const char*)b.data() + b.size(), SER_NETWORK, PROTOCOL_VERSION);
        spark::Coin c(params);
        cs >> c;
        coins.push_back(c);
      }
      spark::CoverSetData d;
      d.cover_set = coins;
      d.cover_set_representation = unhex(s.at("setHash").get<std::string>());
      d.cover_set_representation.insert(d.cover_set_representation.end(), sig.begin(), sig.end());
      data[id] = d;
      sets[id] = coins;
    }
    spend.setCoverSets(data);
    spend.setVout(vout);
    bool ok = spark::SpendTransaction::verify(params, { spend }, sets);
    // What a node would record: the spent tags, and the serial context of the new private coins.
    json tags = json::array();
    for (const auto& t : spend.getUsedLTags()) {
      std::vector<unsigned char> b(34);
      t.serialize(b.data());
      tags.push_back(hexs(b));
    }
    CDataStream ctx(SER_NETWORK, PROTOCOL_VERSION);
    ctx << spend.getUsedLTags();
    std::vector<unsigned char> cb(ctx.begin(), ctx.end());
    out = { { "ok", ok }, { "fee", spend.getFee() }, { "vout", vout }, { "inputs", spend.getUsedLTags().size() }, { "type", type }, { "tags", tags }, { "context", hexs(cb) } };
  } catch (const std::exception& e) {
    out = { { "ok", false }, { "error", e.what() } };
  }
  std::cout << out.dump() << std::endl;
  return 0;
}
