// Kusari: Dandelion++ transaction relay (Fanti et al., "Dandelion++: Lightweight Cryptocurrency Networking with
// Formal Anonymity Guarantees", 2018), with the parameters Monero uses. Written for Kusari; no code from Monero.
// Distributed under the MIT/X11 software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.
//
// A new transaction first walks a "stem": each node passes it to one peer only. After a few hops a node "fluffs" it,
// broadcasting it to everyone as before. Someone watching the broadcast sees where the fluff began, not where the
// walk started. Per epoch (about 10 minutes) each node picks 2 outgoing peers as stems and decides, with a 20% chance,
// to fluff everything it is handed instead. Each source keeps one stem for the whole epoch, and the node's own
// transactions are one source. A node that stems a transaction also keeps it under embargo: if nobody has broadcast
// it after about 39 seconds (random, exponential), the node broadcasts it itself, so a node that drops stems can't
// make a transaction disappear. Broadcasts start after a random delay (about 5 seconds on average).
//
// This class only decides; the protocol handler sends. Times are milliseconds from any steady clock.

#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <functional>
#include <map>
#include <set>
#include <string>
#include <utility>
#include <vector>

namespace currency
{
  struct dandelion_config
  {
    size_t stems = 2;                       // Monero: CRYPTONOTE_DANDELIONPP_STEMS
    unsigned fluff_percent = 20;            // Monero: CRYPTONOTE_DANDELIONPP_FLUFF_PROBABILITY
    uint64_t epoch_ms = 10 * 60 * 1000;     // Monero: CRYPTONOTE_DANDELIONPP_MIN_EPOCH
    uint64_t epoch_range_ms = 30 * 1000;    // Monero: CRYPTONOTE_DANDELIONPP_EPOCH_RANGE
    uint64_t embargo_avg_ms = 39 * 1000;    // Monero: CRYPTONOTE_DANDELIONPP_EMBARGO_AVERAGE
    uint64_t fluff_delay_avg_ms = 5 * 1000; // Monero: CRYPTONOTE_DANDELIONPP_FLUSH_AVERAGE
  };

  template<class conn_id>
  class dandelion_router
  {
  public:
    struct decision
    {
      bool fluff = true;
      conn_id to{};
    };
    struct tx_entry
    {
      std::string id;   // the transaction hash, as bytes
      std::string blob; // the transaction, as relayed
    };
    struct due_work
    {
      std::vector<tx_entry> fluff_now;       // broadcast these (if still in the pool)
      std::vector<tx_entry> embargo_expired; // nobody broadcast these in time: fluff them (if still in the pool)
    };

    dandelion_router(std::function<uint64_t()> rng, dandelion_config cfg = dandelion_config()) : m_rng(std::move(rng)), m_cfg(cfg) {}

    const dandelion_config& config() const { return m_cfg; }
    void set_config(const dandelion_config& cfg) { m_cfg = cfg; m_epoch_end = 0; }

    // Where transactions from `source` go: the source's stem for this epoch, or fluff. `candidates` are the
    // connections a stem may use (outgoing ones in normal state). The node's own transactions use a source of {}.
    decision route(const conn_id& source, uint64_t now, const std::vector<conn_id>& candidates)
    {
      if (now >= m_epoch_end || !stems_still_connected(candidates))
        new_epoch(now, candidates);
      decision d;
      if (m_fluff_epoch || m_stems.empty())
        return d;
      auto it = m_route.find(source);
      if (it == m_route.end())
        it = m_route.emplace(source, static_cast<size_t>(m_rng() % m_stems.size())).first;
      size_t index = it->second;
      // Never hand a transaction back to the peer it came from.
      if (m_stems[index] == source)
      {
        if (m_stems.size() < 2)
          return d;
        index = (index + 1) % m_stems.size();
      }
      d.fluff = false;
      d.to = m_stems[index];
      return d;
    }

    // A transaction this node just passed along a stem.
    void embargo(const tx_entry& tx, uint64_t now)
    {
      if (m_fluff_ids.count(tx.id))
        return;
      m_embargo.emplace(tx.id, std::make_pair(now + sample(m_cfg.embargo_avg_ms), tx.blob));
    }

    // Someone broadcast it, so the embargo is over and it is public.
    void seen_fluff(const std::string& id) { m_embargo.erase(id); m_fluff_ids.erase(id); }

    // Still private here: passed along a stem under embargo, or waiting out this node's delay before broadcasting
    // it. Nobody but the stem's nodes has it yet, so the node shows it to nobody.
    bool is_private(const std::string& id) const { return m_embargo.count(id) || m_fluff_ids.count(id); }

    // Broadcast after a random delay. Ends any embargo on it.
    void fluff(const tx_entry& tx, uint64_t now)
    {
      m_embargo.erase(tx.id);
      if (!m_fluff_ids.insert(tx.id).second)
        return;
      m_fluff_queue.emplace(now + sample(m_cfg.fluff_delay_avg_ms), tx);
    }

    due_work due(uint64_t now)
    {
      due_work w;
      while (!m_fluff_queue.empty() && m_fluff_queue.begin()->first <= now)
      {
        w.fluff_now.push_back(m_fluff_queue.begin()->second);
        m_fluff_ids.erase(m_fluff_queue.begin()->second.id);
        m_fluff_queue.erase(m_fluff_queue.begin());
      }
      for (auto it = m_embargo.begin(); it != m_embargo.end();)
      {
        if (it->second.first <= now)
        {
          w.embargo_expired.push_back(tx_entry{it->first, it->second.second});
          it = m_embargo.erase(it);
        }
        else
          ++it;
      }
      return w;
    }

    bool is_fluff_epoch() const { return m_fluff_epoch; }
    const std::vector<conn_id>& stems() const { return m_stems; }
    size_t embargoed() const { return m_embargo.size(); }
    size_t queued() const { return m_fluff_queue.size(); }

  private:
    bool stems_still_connected(const std::vector<conn_id>& candidates) const
    {
      for (const auto& s : m_stems)
      {
        bool found = false;
        for (const auto& c : candidates)
          if (c == s) { found = true; break; }
        if (!found)
          return false;
      }
      // An epoch that started with too few peers takes new ones as they connect.
      return m_stems.size() >= std::min(m_cfg.stems, candidates.size());
    }

    void new_epoch(uint64_t now, const std::vector<conn_id>& candidates)
    {
      m_fluff_epoch = m_rng() % 100 < m_cfg.fluff_percent;
      m_stems.clear();
      m_route.clear();
      std::vector<conn_id> pool = candidates;
      while (!pool.empty() && m_stems.size() < m_cfg.stems)
      {
        size_t i = static_cast<size_t>(m_rng() % pool.size());
        m_stems.push_back(pool[i]);
        pool.erase(pool.begin() + i);
      }
      m_epoch_end = now + m_cfg.epoch_ms + (m_cfg.epoch_range_ms ? m_rng() % m_cfg.epoch_range_ms : 0);
    }

    // Exponential with the given mean, capped at ten times the mean.
    uint64_t sample(uint64_t avg_ms)
    {
      if (!avg_ms)
        return 0;
      double u = (static_cast<double>(m_rng() >> 11) + 1.0) / 9007199254740992.0; // (0, 1]
      double v = -std::log(u) * static_cast<double>(avg_ms);
      return static_cast<uint64_t>(std::min(v, 10.0 * static_cast<double>(avg_ms)));
    }

    std::function<uint64_t()> m_rng;
    dandelion_config m_cfg;
    uint64_t m_epoch_end = 0;
    bool m_fluff_epoch = true;
    std::vector<conn_id> m_stems;
    std::map<conn_id, size_t> m_route;
    std::map<std::string, std::pair<uint64_t, std::string>> m_embargo;
    std::multimap<uint64_t, tx_entry> m_fluff_queue;
    std::set<std::string> m_fluff_ids;
  };
}
