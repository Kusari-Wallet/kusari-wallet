// The Spark wallet side of the engine: anonymity sets cached on disk, our coins found with the full view key, spent
// coins matched by their tag hashes, and complete spend transactions. Included by main.cpp, after its helpers.
//
// Files: <sets>/g<N>.bin holds group N's coins oldest first as [u32 len][coin][u32 len][tx hash][u32 len][context];
// <sets>/g<N>.json says how many of those records are valid; <sets>/tags.txt is one "lTagHash txid" line per spent
// coin on the chain. <wallet>/coins.json is this wallet's own coins. The node lists sets newest first.

// Its headers are included at the top of main.cpp, outside the namespace.
namespace fs = std::filesystem;

std::vector<unsigned char> b64(const std::string& s) {
  static int map[256];
  static bool ready = false;
  if (!ready) {
    for (int i = 0; i < 256; i++) map[i] = -1;
    const char* a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    for (int i = 0; i < 64; i++) map[(unsigned char)a[i]] = i;
    ready = true;
  }
  std::vector<unsigned char> out;
  out.reserve(s.size() * 3 / 4);
  int val = 0, bits = -8;
  for (unsigned char c : s) {
    if (c == '=') break;
    if (map[c] < 0) { if (c == '\n' || c == '\r' || c == ' ') continue; throw std::runtime_error("bad base64 from the server"); }
    val = (val << 6) + map[c];
    bits += 6;
    if (bits >= 0) { out.push_back((unsigned char)((val >> bits) & 0xff)); bits -= 8; }
  }
  return out;
}

std::string hexv(const std::vector<unsigned char>& v) { return hex(v.data(), v.size()); }

std::string reversedHex(std::vector<unsigned char> v) { std::reverse(v.begin(), v.end()); return hexv(v); }

std::vector<unsigned char> sha256d(const std::vector<unsigned char>& d) {
  unsigned char a[32], b[32];
  SHA256(d.data(), d.size(), a);
  SHA256(a, 32, b);
  return std::vector<unsigned char>(b, b + 32);
}

std::string digestHex(const std::vector<unsigned char>& d) {
  unsigned char a[32];
  SHA256(d.data(), d.size(), a);
  return hex(a, 32);
}

json readJson(const fs::path& f, json fallback) {
  std::ifstream in(f, std::ios::binary);
  if (!in) return fallback;
  try { json j; in >> j; return j; } catch (...) { return fallback; }
}

void writeJson(const fs::path& f, const json& j) {
  fs::path tmp = f;
  tmp += ".tmp";
  { std::ofstream out(tmp, std::ios::binary | std::ios::trunc); out << j.dump(); if (!out) throw std::runtime_error("could not write " + f.string()); }
  fs::rename(tmp, f);
}

struct Rec { std::vector<unsigned char> coin, tx, ctx; };

void putU32(std::string& s, uint32_t v) { for (int i = 0; i < 4; i++) s += (char)((v >> (8 * i)) & 0xff); }

std::vector<Rec> readGroup(const fs::path& bin, int count) {
  std::vector<Rec> out;
  std::ifstream in(bin, std::ios::binary);
  if (!in) return out;
  out.reserve(count);
  auto field = [&](std::vector<unsigned char>& v) {
    unsigned char l[4];
    if (!in.read((char*)l, 4)) return false;
    uint32_t n = l[0] | (l[1] << 8) | (l[2] << 16) | ((uint32_t)l[3] << 24);
    if (n > 1 << 20) return false;
    v.resize(n);
    return (bool)in.read((char*)v.data(), n);
  };
  for (int i = 0; i < count; i++) {
    Rec r;
    if (!field(r.coin) || !field(r.tx) || !field(r.ctx)) throw std::runtime_error("the Spark cache is damaged; it will be rebuilt");
    out.push_back(std::move(r));
  }
  return out;
}

struct Engine {
  net::Electrum el;
  std::vector<net::Server> servers;
  std::mutex dataMu;
  std::mutex progMu;
  std::recursive_mutex connMu;  // the connection's settings and opening; each call holds it
  json progress = { { "stage", "idle" } };
  std::atomic<bool> syncing{ false };

  void setProgress(json p) { std::lock_guard<std::mutex> l(progMu); progress = std::move(p); }
  json getProgress() { std::lock_guard<std::mutex> l(progMu); json p = progress; p["syncing"] = syncing.load(); return p; }

  void configure(const json& p) {
    std::lock_guard<std::recursive_mutex> c(connMu);
    std::vector<net::Server> list;
    for (const auto& s : p.at("servers")) list.push_back({ s.at("host").get<std::string>(), s.value("port", 50002), s.value("pin", "") });
    std::string socks = p.value("socks", ""), connect = p.value("connect", "");
    bool changed = socks != el.socks || connect != el.connect || list.size() != servers.size();
    for (size_t i = 0; !changed && i < list.size(); i++) changed = list[i].host != servers[i].host || list[i].port != servers[i].port || list[i].pin != servers[i].pin;
    servers = list;
    el.socks = socks;
    el.connect = connect;
    if (changed) el.close();
  }

  void ensure() {
    std::lock_guard<std::recursive_mutex> c(connMu);
    if (el.isOpen()) return;
    std::string last = "no Spark servers are set";
    for (const auto& s : servers) {
      try {
        el.open(s);
        el.call("server.version", json::array({ "Kusari", "1.4" }));
        return;
      } catch (const std::exception& e) {
        last = e.what();
        if (last.find("certificate") != std::string::npos) throw;
      }
    }
    throw std::runtime_error(last);
  }

  // One retry after a dropped connection.
  json call(const std::string& m, const json& params) {
    std::lock_guard<std::recursive_mutex> c(connMu);
    ensure();
    try { return el.call(m, params); } catch (const std::exception& e) {
      if (el.isOpen()) throw;
      ensure();
      return el.call(m, params);
    }
  }

  // Brings group g's cached set up to the server's. Returns {count, blockHash, setHash}.
  json updateGroup(const fs::path& sets, int g, int latest, bool retried = false) {
    fs::path bin = sets / ("g" + std::to_string(g) + ".bin"), meta = sets / ("g" + std::to_string(g) + ".json");
    json have = readJson(meta, json{ { "count", 0 }, { "bytes", 0 }, { "blockHash", "" }, { "setHash", "" }, { "newest", "" } });
    json m = call("spark.getsparkanonymitysetmeta", json::array({ std::to_string(g) }));
    int size = m.value("size", 0);
    std::string bh = m.value("blockHash", ""), sh = m.value("setHash", "");
    int count = have.value("count", 0);
    if (size == count && bh == have.value("blockHash", "")) {
      if (sh != have.value("setHash", "")) { have["setHash"] = sh; writeJson(meta, have); }
      return have;
    }
    bool reset = size < count || (size == count);
    int need = size - count;
    if (reset) { count = 0; need = size; have = json{ { "count", 0 }, { "bytes", 0 }, { "blockHash", "" }, { "setHash", "" }, { "newest", "" } }; }
    // A cache started afresh gets a new generation, so each wallet looks through it again from the start.
    if (count == 0) have["gen"] = hexv(sha256d(std::vector<unsigned char>(bh.begin(), bh.end()))).substr(0, 16) + std::to_string(size);
    // The newest coins first; one more than needed, to check it is the newest one already cached.
    int want = need + (count > 0 ? 1 : 0);
    std::vector<Rec> fresh;
    fresh.reserve(want);
    const int step = 10000;
    for (int start = 0; start < want; start += step) {
      int end = std::min(want, start + step);
      setProgress({ { "stage", "sets" }, { "group", g }, { "groups", latest }, { "done", start }, { "total", want } });
      json r = call("spark.getsparkanonymitysetsector", json::array({ std::to_string(g), bh, std::to_string(start), std::to_string(end) }));
      const json& coins = r.at("coins");
      if ((int)coins.size() != end - start) throw std::runtime_error("the Spark server sent an incomplete set");
      for (const auto& c : coins) fresh.push_back({ b64(c.at(0).get<std::string>()), b64(c.at(1).get<std::string>()), b64(c.at(2).get<std::string>()) });
    }
    if (count > 0) {
      if (digestHex(fresh.back().coin) != have.value("newest", "")) {
        if (retried) throw std::runtime_error("the Spark set does not line up with the cache");
        fs::remove(meta);
        fs::remove(bin);
        return updateGroup(sets, g, latest, true);
      }
      fresh.pop_back();
    }
    std::reverse(fresh.begin(), fresh.end());
    uint64_t bytes = have.value("bytes", (uint64_t)0);
    if (count == 0) { std::ofstream(bin, std::ios::binary | std::ios::trunc); bytes = 0; }
    else if (fs::exists(bin) && fs::file_size(bin) > bytes) fs::resize_file(bin, bytes);
    {
      std::ofstream out(bin, std::ios::binary | std::ios::app);
      std::string chunk;
      for (const auto& r : fresh) {
        putU32(chunk, (uint32_t)r.coin.size()); chunk.append((const char*)r.coin.data(), r.coin.size());
        putU32(chunk, (uint32_t)r.tx.size()); chunk.append((const char*)r.tx.data(), r.tx.size());
        putU32(chunk, (uint32_t)r.ctx.size()); chunk.append((const char*)r.ctx.data(), r.ctx.size());
      }
      out.write(chunk.data(), chunk.size());
      if (!out) throw std::runtime_error("could not write the Spark cache");
      bytes += chunk.size();
    }
    if (!fresh.empty()) have["newest"] = digestHex(fresh.back().coin);
    have["count"] = count + (int)fresh.size();
    have["bytes"] = bytes;
    have["blockHash"] = bh;
    have["setHash"] = sh;
    writeJson(meta, have);
    return have;
  }

  // Appends newly spent tags to the shared list, hashed. Returns lTagHash -> spending txid.
  std::unordered_map<std::string, std::string> updateTags(const fs::path& sets) {
    fs::path f = sets / "tags.txt";
    std::unordered_map<std::string, std::string> all;
    std::vector<std::string> lines;
    {
      std::ifstream in(f);
      std::string line;
      while (std::getline(in, line)) {
        if (line.size() < 64) break;
        lines.push_back(line);
      }
    }
    setProgress({ { "stage", "tags" } });
    json list;
    try {
      list = call("spark.getusedcoinstagstxhashes", json::array({ std::to_string(lines.size()) })).at("tagsandtxids");
    } catch (const std::exception&) {
      // Servers without spending txids: the whole tag list, without txids, keeping only tags not yet listed.
      json all = call("spark.getusedcoinstags", json::array({ "0" })).at("tags");
      std::set<std::string> have;
      for (const auto& l : lines) have.insert(l.substr(0, 64));
      std::vector<unsigned char> raw;
      for (const auto& t : all) { auto b = b64(t.get<std::string>()); raw.insert(raw.end(), b.begin(), b.end()); }
      list = json::array();
      if (!all.empty()) {
        const char* h = hashTags(raw.data(), (int)all.size());
        if (!h) throw std::runtime_error(lastError("could not hash the tags"));
        for (size_t i = 0; i < all.size(); i++)
          if (!have.count(std::string(h + i * 64, 64))) list.push_back(json::array({ all[i], "" }));
        native_free((void*)h);
      }
    }
    if (!list.empty()) {
      std::vector<unsigned char> raw;
      std::vector<std::string> txids;
      for (const auto& t : list) {
        auto tag = b64(t.at(0).get<std::string>());
        if (tag.size() != 34) throw std::runtime_error("the Spark server sent a bad tag");
        raw.insert(raw.end(), tag.begin(), tag.end());
        auto tx = b64(t.at(1).get<std::string>());
        txids.push_back(tx.size() == 32 && std::any_of(tx.begin(), tx.end(), [](unsigned char c) { return c != 0; }) ? reversedHex(tx) : std::string("-"));
      }
      const char* h = hashTags(raw.data(), (int)list.size());
      if (!h) throw std::runtime_error(lastError("could not hash the tags"));
      std::string add;
      for (size_t i = 0; i < list.size(); i++) {
        std::string line = std::string(h + i * 64, 64) + " " + txids[i];
        lines.push_back(line);
        add += line + "\n";
      }
      native_free((void*)h);
      // Lines past a partial write are dropped by the reader above, then fetched again.
      std::ofstream out(f, std::ios::binary | std::ios::app);
      out << add;
    }
    for (const auto& l : lines) { std::string t = l.size() > 65 ? l.substr(65) : ""; all[l.substr(0, 64)] = t == "-" ? "" : t; }
    return all;
  }

  json sync(const json& p) {
    std::lock_guard<std::mutex> lock(dataMu);
    configure(p);
    fs::path sets = fs::u8path(p.at("setsDir").get<std::string>()), wdir = fs::u8path(p.at("walletDir").get<std::string>());
    fs::create_directories(sets);
    fs::create_directories(wdir);
    auto fvkBytes = unhex(p.at("fvk").get<std::string>());
    void* fvk = deserializeFullViewKey(fvkBytes.data(), (int)fvkBytes.size());
    if (!fvk) throw std::runtime_error(lastError("bad view key"));
    struct Free { void* p; ~Free() { deleteFullViewKey(p); } } freeFvk{ fvk };
    int testnet = p.value("testnet", false) ? 1 : 0;

    setProgress({ { "stage", "connect" } });
    ensure();
    json head = call("blockchain.headers.subscribe", json::array());
    int latest = call("spark.getsparklatestcoinid", json::array()).get<int>();
    fs::path wfile = wdir / "coins.json";
    json w = readJson(wfile, json{ { "v", 1 }, { "identified", json::object() }, { "coins", json::array() } });
    std::set<std::string> known;
    for (const auto& c : w["coins"]) known.insert(c.value("lTagHash", ""));
    json groups = json::array();
    for (int g = 1; g <= latest; g++) {
      json meta = updateGroup(sets, g, latest);
      int count = meta.value("count", 0);
      std::string key = std::to_string(g);
      std::string gen = meta.value("gen", "");
      json seen = w["identified"].value(key, json::object());
      int done = seen.is_object() && seen.value("gen", "") == gen ? seen.value("n", 0) : 0;
      if (done == 0 || done > count) {
        // The cache was rebuilt: this group's coins are found again from the start.
        json keep = json::array();
        for (const auto& c : w["coins"]) if (c.value("g", 0) != g) keep.push_back(c);
        w["coins"] = keep;
        known.clear();
        for (const auto& c : w["coins"]) known.insert(c.value("lTagHash", ""));
        done = 0;
      }
      if (done < count) {
        auto recs = readGroup(sets / ("g" + key + ".bin"), count);
        for (int i = done; i < count; i++) {
          if ((i - done) % 2000 == 0) setProgress({ { "stage", "identify" }, { "group", g }, { "groups", latest }, { "done", i - done }, { "total", count - done } });
          const Rec& r = recs[i];
          AggregateCoinData* c = idAndRecoverCoinByFullViewKey(r.coin.data(), (int)r.coin.size(), fvk, const_cast<unsigned char*>(r.ctx.data()), (int)r.ctx.size(), testnet);
          if (!c) { char* e = native_last_error(); if (e) native_free(e); continue; }
          std::string tag = c->lTagHash ? std::string(c->lTagHash) : std::string();
          if (!tag.empty() && !known.count(tag)) {
            known.insert(tag);
            w["coins"].push_back({ { "g", g }, { "coin", hexv(r.coin) }, { "ctx", hexv(r.ctx) }, { "txid", reversedHex(r.tx) },
                                   { "value", c->value }, { "d", c->diversifier }, { "type", (int)c->type }, { "lTagHash", tag },
                                   { "memo", c->memo ? std::string(c->memo, c->memoLength) : std::string() }, { "spent", false }, { "spentTx", "" } });
          }
          if (c->address) native_free(c->address);
          if (c->memo) native_free(c->memo);
          if (c->lTagHash) native_free(c->lTagHash);
          if (c->encryptedDiversifier) native_free(c->encryptedDiversifier);
          if (c->serial) native_free(c->serial);
          if (c->nonceHex) native_free(c->nonceHex);
          native_free(c);
        }
        w["identified"][key] = { { "n", count }, { "gen", gen } };
      }
      groups.push_back({ { "id", g }, { "count", count } });
    }
    auto spent = updateTags(sets);
    for (auto& c : w["coins"]) {
      auto it = spent.find(c.value("lTagHash", ""));
      c["spent"] = it != spent.end();
      c["spentTx"] = it != spent.end() ? it->second : "";
    }
    writeJson(wfile, w);
    setProgress({ { "stage", "done" } });
    json coins = json::array();
    for (const auto& c : w["coins"]) {
      json o = c;
      o.erase("coin");
      o.erase("ctx");
      coins.push_back(o);
    }
    return { { "height", head.value("height", 0) }, { "host", el.host }, { "fingerprint", el.fingerprint }, { "verified", el.verified },
             { "coins", coins }, { "groups", groups }, { "tags", spent.size() } };
  }

  // A complete Spark spend, ready to broadcast: proofs in the extra payload, private outputs after the public ones.
  json send(const json& p) {
    std::lock_guard<std::mutex> lock(dataMu);
    auto key = key32(p);
    int index = p.value("index", 1);
    int version = p.value("version", 2);
    fs::path sets = fs::u8path(p.at("setsDir").get<std::string>()), wdir = fs::u8path(p.at("walletDir").get<std::string>());
    json w = readJson(wdir / "coins.json", json::object());
    std::set<std::string> exclude;
    for (const auto& e : p.value("exclude", json::array())) exclude.insert(e.get<std::string>());

    struct Avail { std::vector<unsigned char> coin, ctx; int g; std::string tag; };
    std::vector<Avail> avail;
    for (const auto& c : w.value("coins", json::array())) {
      if (c.value("spent", false) || exclude.count(c.value("lTagHash", ""))) continue;
      avail.push_back({ unhex(c.at("coin").get<std::string>()), unhex(c.at("ctx").get<std::string>()), c.at("g").get<int>(), c.value("lTagHash", "") });
    }
    if (avail.empty()) throw std::runtime_error("No confirmed private FIRO to send yet.");
    std::vector<CCDataStream> streams;
    streams.reserve(avail.size() * 2);
    std::vector<DartSpendCoinData> sc;
    for (auto& a : avail) {
      streams.push_back({ a.coin.data(), (int)a.coin.size() });
      CCDataStream* cs = &streams.back();
      streams.push_back({ a.ctx.data(), (int)a.ctx.size() });
      sc.push_back({ cs, &streams.back(), a.g, a.g });
    }

    struct Out { std::vector<unsigned char> script; uint64_t value; };
    std::vector<Out> pub;
    for (const auto& t : p.value("transparent", json::array())) pub.push_back({ unhex(t.at("script").get<std::string>()), t.at("value").get<uint64_t>() });
    std::vector<std::string> paddr, pmemo;
    std::vector<uint64_t> pval;
    for (const auto& r : p.value("private", json::array())) { paddr.push_back(r.at("address").get<std::string>()); pmemo.push_back(r.value("memo", "")); pval.push_back(r.at("value").get<uint64_t>()); }
    if (pub.size() + paddr.size() != 1) throw std::runtime_error("one recipient per transaction");
    bool subtract = p.value("subtractFee", false);
    uint64_t total = 0;
    for (auto& o : pub) total += o.value;
    for (auto v : pval) total += v;

    SparkFeeResult* fr = estimateSparkFee(key.data(), index, (int64_t)total, subtract ? 1 : 0, sc.data(), (int)sc.size(), (int)paddr.size(), (int)pub.size(), 0, version);
    if (!fr) throw std::runtime_error(lastError("could not estimate the fee"));
    if (fr->error) { std::string e(fr->error); native_free(fr->error); native_free(fr); throw std::runtime_error(e); }
    int64_t fee = fr->fee;
    native_free(fr);
    if (subtract) {
      uint64_t& v = pub.empty() ? pval[0] : pub[0].value;
      if (v <= (uint64_t)fee) throw std::runtime_error("The amount is too small to cover the fee.");
      v -= (uint64_t)fee;
    }

    uint32_t lockTime = p.value("lockTime", 0u);
    auto varint = [](std::vector<unsigned char>& b, uint64_t n) {
      if (n < 0xfd) b.push_back((unsigned char)n);
      else if (n <= 0xffff) { b.push_back(0xfd); for (int i = 0; i < 2; i++) b.push_back((n >> (8 * i)) & 0xff); }
      else if (n <= 0xffffffff) { b.push_back(0xfe); for (int i = 0; i < 4; i++) b.push_back((n >> (8 * i)) & 0xff); }
      else { b.push_back(0xff); for (int i = 0; i < 8; i++) b.push_back((n >> (8 * i)) & 0xff); }
    };
    auto le = [](std::vector<unsigned char>& b, uint64_t v, int n) { for (int i = 0; i < n; i++) b.push_back((v >> (8 * i)) & 0xff); };
    auto build = [&](const std::vector<std::vector<unsigned char>>& sparkOuts, const std::vector<unsigned char>& payload) {
      std::vector<unsigned char> b;
      le(b, 3u | ((uint32_t)(version == 2 ? 11 : 9) << 16), 4);
      varint(b, 1);
      b.insert(b.end(), 32, 0);
      le(b, 0xffffffffu, 4);
      varint(b, 1);
      b.push_back(0xd3);  // OP_SPARKSPEND
      le(b, 0xffffffffu, 4);
      varint(b, pub.size() + sparkOuts.size());
      for (const auto& o : pub) { le(b, o.value, 8); varint(b, o.script.size()); b.insert(b.end(), o.script.begin(), o.script.end()); }
      for (const auto& s : sparkOuts) { le(b, 0, 8); varint(b, s.size()); b.insert(b.end(), s.begin(), s.end()); }
      le(b, lockTime, 4);
      varint(b, payload.size());
      b.insert(b.end(), payload.begin(), payload.end());
      return b;
    };
    std::vector<unsigned char> sig = sha256d(build({}, {}));

    // Cover sets for every group our coins sit in, newest first as the node lists them.
    std::set<int> gids;
    for (const auto& a : avail) gids.insert(a.g);
    std::vector<std::vector<Rec>> recs;
    std::vector<std::vector<CCDataStream>> setStreams(gids.size());
    std::vector<CCoverSetData> covers;
    std::vector<std::vector<unsigned char>> reps, hashes;
    std::vector<BlockHashAndId> ids;
    reps.reserve(gids.size());
    hashes.reserve(gids.size());
    recs.reserve(gids.size());
    size_t k = 0;
    for (int g : gids) {
      std::string gk = std::to_string(g);
      json meta = readJson(sets / ("g" + gk + ".json"), json::object());
      recs.push_back(readGroup(sets / ("g" + gk + ".bin"), meta.value("count", 0)));
      auto& rs = recs.back();
      for (auto it = rs.rbegin(); it != rs.rend(); ++it) setStreams[k].push_back({ it->coin.data(), (int)it->coin.size() });
      reps.push_back(b64(meta.value("setHash", "")));
      hashes.push_back(b64(meta.value("blockHash", "")));
      if (reps.back().size() != 32 || hashes.back().size() != 32) throw std::runtime_error("the Spark set is not synced yet");
      covers.push_back({ setStreams[k].data(), (int)setStreams[k].size(), reps.back().data(), 32, g });
      ids.push_back({ hashes.back().data(), g });
      k++;
    }

    std::vector<CRecip> recips;
    for (const auto& o : pub) recips.push_back({ o.value, 0 });
    std::vector<COutputCoinData> pcoins(paddr.size());
    std::vector<COutputRecipient> privs;
    for (size_t i = 0; i < paddr.size(); i++) {
      pcoins[i] = { paddr[i].c_str(), (int)paddr[i].size(), pval[i], pmemo[i].c_str(), (int)pmemo[i].size() };
      privs.push_back({ &pcoins[i], 0 });
    }
    std::vector<unsigned char> ext(32, 0);
    SparkSpendTransactionResult* r = cCreateSparkSpendTransaction(
        key.data(), index, recips.data(), (int)recips.size(), privs.data(), (int)privs.size(), sc.data(), (int)sc.size(),
        covers.data(), (int)covers.size(), ids.data(), (int)ids.size(), sig.data(), 0, version, ext.data());
    if (!r) throw std::runtime_error(lastError("could not make the Spark spend"));
    if (r->isError) throw std::runtime_error(r->data ? std::string((char*)r->data, r->dataLength) : "could not make the Spark spend");
    if (r->fee != fee) throw std::runtime_error("The fee changed while the transaction was made. Try again.");
    std::vector<std::vector<unsigned char>> outs;
    for (int i = 0; i < r->outputScriptsLength; i++) outs.emplace_back(r->outputScripts[i].bytes, r->outputScripts[i].bytes + r->outputScripts[i].length);
    std::vector<unsigned char> payload(r->data, r->data + r->dataLength);
    json used = json::array();
    for (int i = 0; i < r->usedCoinsLength; i++) {
      const CCDataStream* u = r->usedCoins[i].serializedCoin;
      for (const auto& a : avail)
        if (a.coin.size() >= (size_t)u->length && std::equal(u->data, u->data + u->length, a.coin.begin())) { used.push_back(a.tag); break; }
    }
    if ((int)used.size() != r->usedCoinsLength) throw std::runtime_error("could not tell which coins the spend uses");
    std::vector<unsigned char> tx = build(outs, payload);
    std::vector<unsigned char> id = sha256d(tx);
    std::reverse(id.begin(), id.end());
    json sent = json::array();
    for (const auto& o : pub) sent.push_back(o.value);
    for (auto v : pval) sent.push_back(v);
    return { { "hex", hexv(tx) }, { "txid", hexv(id) }, { "fee", fee }, { "amounts", sent }, { "used", used }, { "size", tx.size() } };
  }
};

Engine engine;
