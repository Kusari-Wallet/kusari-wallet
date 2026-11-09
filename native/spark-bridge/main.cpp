// Spark engine for Kusari Wallet: Firo's sparkmobile library (MIT) behind a JSON-lines protocol on stdin/stdout.
// Each request is {"id":n,"m":"method","p":{...}}; each answer is {"id":n,"r":...} or {"id":n,"e":"message"}.
// Binary values travel as lowercase hex. Keys arrive per request and are never written anywhere.

#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

#include "json.hpp"
#include "flutter_libsparkmobile.h"

using nlohmann::json;

namespace {

std::vector<unsigned char> unhex(const std::string& h) {
  if (h.size() % 2) throw std::runtime_error("odd hex length");
  std::vector<unsigned char> out(h.size() / 2);
  for (size_t i = 0; i < out.size(); i++) out[i] = static_cast<unsigned char>(std::stoul(h.substr(i * 2, 2), nullptr, 16));
  return out;
}

std::string hex(const unsigned char* p, size_t n) {
  static const char* d = "0123456789abcdef";
  std::string s(n * 2, '0');
  for (size_t i = 0; i < n; i++) { s[i * 2] = d[p[i] >> 4]; s[i * 2 + 1] = d[p[i] & 15]; }
  return s;
}

std::string lastError(const char* fallback) {
  char* e = native_last_error();
  std::string s = e ? e : fallback;
  if (e) native_free(e);
  return s;
}

std::vector<unsigned char> key32(const json& p) {
  auto k = unhex(p.at("key").get<std::string>());
  if (k.size() != 32) throw std::runtime_error("the key must be 32 bytes");
  return k;
}

struct Fvk {
  void* p;
  explicit Fvk(std::vector<unsigned char>& key, int index) : p(getFullViewKeyFromPrivateKeyData(key.data(), index)) {
    if (!p) throw std::runtime_error(lastError("could not make the view key"));
  }
  ~Fvk() { deleteFullViewKey(p); }
};

json address(const json& p) {
  auto key = key32(p);
  const char* a = getAddress(key.data(), p.value("index", 1), p.value("diversifier", 0), p.value("testnet", false) ? 1 : 0);
  if (!a) throw std::runtime_error(lastError("could not make the address"));
  std::string s(a);
  native_free((void*)a);
  return s;
}

json valid(const json& p) {
  ValidateAddressResult* r = isValidSparkAddress(p.at("address").get<std::string>().c_str(), p.value("testnet", false) ? 1 : 0);
  if (!r) throw std::runtime_error(lastError("could not check the address"));
  bool ok = r->isValid != 0;
  if (r->errorMessage) native_free(r->errorMessage);
  native_free(r);
  return ok;
}

// Which of these coins are ours: [[coinHex, contextHex], ...] -> [{n, value, diversifier, memo, lTagHash, type}]
json identify(const json& p) {
  auto key = key32(p);
  Fvk fvk(key, p.value("index", 1));
  json out = json::array();
  const auto& coins = p.at("coins");
  for (size_t n = 0; n < coins.size(); n++) {
    auto coin = unhex(coins[n].at(0).get<std::string>());
    auto ctx = unhex(coins[n].at(1).get<std::string>());
    AggregateCoinData* c = idAndRecoverCoinByFullViewKey(coin.data(), (int)coin.size(), fvk.p, ctx.data(), (int)ctx.size(), p.value("testnet", false) ? 1 : 0);
    if (!c) { char* e = native_last_error(); if (e) native_free(e); continue; }
    json row = { { "n", n }, { "value", c->value }, { "diversifier", c->diversifier }, { "type", (int)c->type },
                 { "lTagHash", c->lTagHash ? std::string(c->lTagHash) : std::string() },
                 { "memo", c->memo ? std::string(c->memo, c->memoLength) : std::string() } };
    out.push_back(row);
    if (c->address) native_free(c->address);
    if (c->memo) native_free(c->memo);
    if (c->lTagHash) native_free(c->lTagHash);
    if (c->encryptedDiversifier) native_free(c->encryptedDiversifier);
    if (c->serial) native_free(c->serial);
    if (c->nonceHex) native_free(c->nonceHex);
    native_free(c);
  }
  return out;
}

// Hashes of spent coins' tags as the node lists them (34-byte serialized points) -> lTagHash hex, to match identify.
json tagHashes(const json& p) {
  std::vector<unsigned char> all;
  for (const auto& t : p.at("tags")) {
    auto b = unhex(t.get<std::string>());
    if (b.size() != 34) throw std::runtime_error("a tag must be 34 bytes");
    all.insert(all.end(), b.begin(), b.end());
  }
  int count = (int)(all.size() / 34);
  if (!count) return json::array();
  const char* r = hashTags(all.data(), count);
  if (!r) throw std::runtime_error(lastError("could not hash the tags"));
  json out = json::array();
  for (int i = 0; i < count; i++) out.push_back(std::string(r + i * 64, 64));
  native_free((void*)r);
  return out;
}

// Spark outputs for a transparent-to-Spark transaction. The serial context binds them to its inputs.
json mint(const json& p) {
  std::vector<DartInputData> ins;
  std::vector<std::vector<unsigned char>> keep;
  for (const auto& i : p.at("inputs")) {
    keep.push_back(unhex(i.at("txid").get<std::string>()));
    ins.push_back({ keep.back().data(), (int)keep.back().size(), i.at("vout").get<int>() });
  }
  SerializedMintContextResult* ctx = serializeMintContext(ins.data(), (int)ins.size());
  if (!ctx) throw std::runtime_error(lastError("could not make the mint context"));
  std::vector<CMintedCoinData> outs;
  std::vector<std::string> addrs, memos;
  for (const auto& o : p.at("outputs")) { addrs.push_back(o.at("address").get<std::string>()); memos.push_back(o.value("memo", "")); }
  size_t k = 0;
  for (const auto& o : p.at("outputs")) {
    outs.push_back({ addrs[k].c_str(), o.at("value").get<uint64_t>(), memos[k].c_str(), (int)memos[k].size() });
    k++;
  }
  CCRecipientList* r = cCreateSparkMintRecipients(outs.data(), (int)outs.size(), ctx->context, ctx->contextLength, 1);
  native_free(ctx->context);
  native_free(ctx);
  if (!r) throw std::runtime_error(lastError("could not make the Spark outputs"));
  json out = json::array();
  for (int i = 0; i < r->length; i++) {
    out.push_back({ { "script", hex(r->list[i].pubKey, r->list[i].pubKeyLength) }, { "value", r->list[i].cAmount } });
    native_free(r->list[i].pubKey);
  }
  native_free(r->list);
  native_free(r);
  return out;
}

struct Streams {
  std::vector<std::vector<unsigned char>> bufs;
  std::vector<CCDataStream> streams;
  CCDataStream* add(const std::string& h) { bufs.push_back(unhex(h)); streams.push_back({ bufs.back().data(), (int)bufs.back().size() }); return nullptr; }
};

// A Spark spend: the proof payload for the transaction's extra data, plus its outputs.
json spend(const json& p) {
  auto key = key32(p);
  int index = p.value("index", 1);
  std::vector<CRecip> recips;
  for (const auto& r : p.value("transparent", json::array())) recips.push_back({ r.at("value").get<uint64_t>(), r.value("subtractFee", false) ? 1 : 0 });
  std::vector<std::string> paddr, pmemo;
  for (const auto& r : p.value("private", json::array())) { paddr.push_back(r.at("address").get<std::string>()); pmemo.push_back(r.value("memo", "")); }
  std::vector<COutputCoinData> pcoins(paddr.size());
  std::vector<COutputRecipient> privs;
  size_t k = 0;
  for (const auto& r : p.value("private", json::array())) {
    pcoins[k] = { paddr[k].c_str(), (int)paddr[k].size(), r.at("value").get<uint64_t>(), pmemo[k].c_str(), (int)pmemo[k].size() };
    privs.push_back({ &pcoins[k], r.value("subtractFee", false) ? 1 : 0 });
    k++;
  }
  // Every byte buffer is reserved up front so pointers into them stay valid.
  const auto& coins = p.at("coins");
  const auto& sets = p.at("coverSets");
  size_t total = coins.size() * 2;
  for (const auto& s : sets) total += s.at("coins").size() + 1;
  std::vector<std::vector<unsigned char>> bufs;
  bufs.reserve(total + p.at("blockHashes").size() + 2);
  std::vector<CCDataStream> coinStreams;
  coinStreams.reserve(coins.size() * 2);
  std::vector<DartSpendCoinData> spendCoins;
  for (const auto& c : coins) {
    bufs.push_back(unhex(c.at("coin").get<std::string>()));
    coinStreams.push_back({ bufs.back().data(), (int)bufs.back().size() });
    CCDataStream* coinPtr = &coinStreams.back();
    bufs.push_back(unhex(c.at("context").get<std::string>()));
    coinStreams.push_back({ bufs.back().data(), (int)bufs.back().size() });
    spendCoins.push_back({ coinPtr, &coinStreams.back(), c.at("groupId").get<int>(), c.at("height").get<int>() });
  }
  std::vector<std::vector<CCDataStream>> setStreams(sets.size());
  std::vector<CCoverSetData> coverSets;
  for (size_t s = 0; s < sets.size(); s++) {
    for (const auto& c : sets[s].at("coins")) { bufs.push_back(unhex(c.get<std::string>())); setStreams[s].push_back({ bufs.back().data(), (int)bufs.back().size() }); }
    bufs.push_back(unhex(sets[s].at("representation").get<std::string>()));
    coverSets.push_back({ setStreams[s].data(), (int)setStreams[s].size(), bufs.back().data(), (int)bufs.back().size(), sets[s].at("setId").get<int>() });
  }
  std::vector<BlockHashAndId> hashes;
  for (const auto& b : p.at("blockHashes")) { bufs.push_back(unhex(b.at("hash").get<std::string>())); hashes.push_back({ bufs.back().data(), b.at("id").get<int>() }); }
  bufs.push_back(unhex(p.at("txHashSig").get<std::string>()));
  unsigned char* sig = bufs.back().data();
  std::vector<unsigned char> ext;
  if (p.contains("extensionCommitment")) ext = unhex(p.at("extensionCommitment").get<std::string>());
  SparkSpendTransactionResult* r = cCreateSparkSpendTransaction(
      key.data(), index, recips.data(), (int)recips.size(), privs.data(), (int)privs.size(),
      spendCoins.data(), (int)spendCoins.size(), coverSets.data(), (int)coverSets.size(), hashes.data(), (int)hashes.size(),
      sig, p.value("additionalTxSize", 0), p.value("version", 1), ext.empty() ? nullptr : ext.data());
  if (!r) throw std::runtime_error(lastError("could not make the Spark spend"));
  if (r->isError) {
    std::string msg = r->data ? std::string((char*)r->data, r->dataLength) : "could not make the Spark spend";
    throw std::runtime_error(msg);
  }
  json scripts = json::array();
  for (int i = 0; i < r->outputScriptsLength; i++) scripts.push_back(hex(r->outputScripts[i].bytes, r->outputScripts[i].length));
  json out = { { "payload", hex(r->data, r->dataLength) }, { "outputScripts", scripts }, { "fee", r->fee }, { "usedCoins", r->usedCoinsLength } };
  return out;
}

json fee(const json& p) {
  auto key = key32(p);
  const auto& coins = p.at("coins");
  std::vector<std::vector<unsigned char>> bufs;
  bufs.reserve(coins.size() * 2);
  std::vector<CCDataStream> streams;
  streams.reserve(coins.size() * 2);
  std::vector<DartSpendCoinData> sc;
  for (const auto& c : coins) {
    bufs.push_back(unhex(c.at("coin").get<std::string>())); streams.push_back({ bufs.back().data(), (int)bufs.back().size() });
    CCDataStream* a = &streams.back();
    bufs.push_back(unhex(c.at("context").get<std::string>())); streams.push_back({ bufs.back().data(), (int)bufs.back().size() });
    sc.push_back({ a, &streams.back(), c.at("groupId").get<int>(), c.at("height").get<int>() });
  }
  SparkFeeResult* r = estimateSparkFee(key.data(), p.value("index", 1), p.at("amount").get<int64_t>(), p.value("subtractFee", false) ? 1 : 0,
                                       sc.data(), (int)sc.size(), p.value("privateRecipients", 0), p.value("utxoNum", 0), p.value("additionalTxSize", 0), p.value("version", 1));
  if (!r) throw std::runtime_error(lastError("could not estimate the fee"));
  if (r->error) { std::string e(r->error); native_free(r->error); native_free(r); throw std::runtime_error(e); }
  int64_t f = r->fee;
  native_free(r);
  return f;
}

}  // namespace

int main() {
  std::ios::sync_with_stdio(false);
  std::string line;
  while (std::getline(std::cin, line)) {
    if (line.empty()) continue;
    json id = nullptr;
    json answer;
    try {
      json req = json::parse(line);
      id = req.value("id", json(nullptr));
      const std::string m = req.at("m").get<std::string>();
      const json p = req.value("p", json::object());
      json r;
      if (m == "address") r = address(p);
      else if (m == "valid") r = valid(p);
      else if (m == "identify") r = identify(p);
      else if (m == "tagHashes") r = tagHashes(p);
      else if (m == "mint") r = mint(p);
      else if (m == "spend") r = spend(p);
      else if (m == "fee") r = fee(p);
      else if (m == "ping") r = "pong";
      else throw std::runtime_error("unknown method " + m);
      answer = { { "id", id }, { "r", r } };
    } catch (const std::exception& e) {
      answer = { { "id", id }, { "e", e.what() } };
    }
    std::cout << answer.dump() << "\n" << std::flush;
  }
  return 0;
}
