// Kusari: Dandelion++ relay for t_currency_protocol_handler (see dandelion.h). Included at the end of
// currency_protocol_handler.inl.
// Distributed under the MIT/X11 software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.

namespace currency
{
  //------------------------------------------------------------------------------------------------------------------------
  template<class t_core>
  int t_currency_protocol_handler<t_core>::handle_notify_stem_transactions(int command, NOTIFY_STEM_TRANSACTIONS::request& arg, currency_connection_context& context)
  {
    NOTIFY_OR_INVOKE_NEW_TRANSACTIONS::response rsp_dummy = AUTO_VAL_INIT(rsp_dummy);
    return this->handle_new_transaction_from_net(arg, rsp_dummy, context, true, true);
  }
  //------------------------------------------------------------------------------------------------------------------------
  template<class t_core>
  void t_currency_protocol_handler<t_core>::dandelion_init()
  {
    // For tests only: a node's own share of fluff epochs and its embargo, so a test can force a stem or a fail-safe.
    dandelion_config cfg = m_dandelion.config();
    if (const char* p = getenv("KUSARI_TEST_DANDELION_FLUFF_PERCENT"))
      cfg.fluff_percent = static_cast<unsigned>(std::min(100, std::max(0, atoi(p))));
    if (const char* e = getenv("KUSARI_TEST_DANDELION_EMBARGO_MS"))
      cfg.embargo_avg_ms = static_cast<uint64_t>(std::max(0, atoi(e)));
    if (const char* d = getenv("KUSARI_TEST_DANDELION_FLUFF_DELAY_MS"))
      cfg.fluff_delay_avg_ms = static_cast<uint64_t>(std::max(0, atoi(d)));
    m_dandelion.set_config(cfg);
    // The pool shows nothing that is still on its stem here (privacy/stem-hiding.js). It asks from outside this
    // lock: nothing here calls the pool while holding it.
    m_core.get_tx_pool().kusari_set_private_check([this](const crypto::hash& h) {
      const std::string id(reinterpret_cast<const char*>(&h), sizeof(h));
      if (m_kusari_tor.is_pending(id))
        return true; // on its way through Tor
      CRITICAL_REGION_LOCAL(m_dandelion_lock);
      return m_dandelion.is_private(id);
    });
  }
  //------------------------------------------------------------------------------------------------------------------------
  template<class t_core>
  std::vector<typename dandelion_router<boost::uuids::uuid>::tx_entry> t_currency_protocol_handler<t_core>::dandelion_entries(const std::list<blobdata>& txs)
  {
    std::vector<typename dandelion_router<boost::uuids::uuid>::tx_entry> entries;
    for (const auto& b : txs)
    {
      transaction t = AUTO_VAL_INIT(t);
      crypto::hash h = null_hash;
      if (parse_and_validate_tx_from_blob(b, t, h))
        entries.push_back({std::string(reinterpret_cast<const char*>(&h), sizeof(h)), b});
    }
    return entries;
  }
  //------------------------------------------------------------------------------------------------------------------------
  template<class t_core>
  void t_currency_protocol_handler<t_core>::dandelion_seen_fluff(const std::list<blobdata>& txs)
  {
    auto entries = dandelion_entries(txs);
    for (const auto& e : entries)
      m_kusari_tor.seen(e.id);
    CRITICAL_REGION_LOCAL(m_dandelion_lock);
    for (const auto& e : entries)
      m_dandelion.seen_fluff(e.id);
  }
  //------------------------------------------------------------------------------------------------------------------------
  template<class t_core>
  void t_currency_protocol_handler<t_core>::broadcast_now(const std::list<blobdata>& txs)
  {
    // The relay queue sends to every connection but the one named; a nil one names none.
    CRITICAL_REGION_LOCAL(m_relay_que_lock);
    m_relay_que.push_back(AUTO_VAL_INIT(relay_que_entry()));
    m_relay_que.back().first.txs = txs;
  }
  //------------------------------------------------------------------------------------------------------------------------
  template<class t_core>
  void t_currency_protocol_handler<t_core>::stem_relay(const std::list<blobdata>& txs, const boost::uuids::uuid& source)
  {
    const uint64_t now = epee::misc_utils::get_tick_count();
    auto entries = dandelion_entries(txs);
    if (entries.empty())
      return;
    std::list<connection_context> connections;
    m_p2p->get_connections(connections);
    // Stems are outgoing connections, which this node chose itself.
    std::vector<boost::uuids::uuid> candidates;
    for (auto& cc : connections)
      if (!cc.m_is_income && cc.m_state == currency_connection_context::state_normal)
        candidates.push_back(cc.m_connection_id);

    typename dandelion_router<boost::uuids::uuid>::decision d;
    {
      CRITICAL_REGION_LOCAL(m_dandelion_lock);
      d = m_dandelion.route(source, now, candidates);
      for (const auto& e : entries)
      {
        if (d.fluff)
          m_dandelion.fluff(e, now);
        else
          m_dandelion.embargo(e, now);
      }
    }
    if (d.fluff)
    {
      LOG_PRINT_L1("[DANDELION] fluff " << entries.size() << " tx(s) after a random delay");
      return;
    }
    for (auto& cc : connections)
    {
      if (cc.m_connection_id != d.to)
        continue;
      NOTIFY_STEM_TRANSACTIONS::request req = AUTO_VAL_INIT(req);
      for (const auto& e : entries)
        req.txs.push_back(e.blob);
      if (post_notify<NOTIFY_STEM_TRANSACTIONS>(req, cc))
      {
        LOG_PRINT_L1("[DANDELION] stem " << entries.size() << " tx(s) to " << cc);
        return;
      }
      break;
    }
    // The stem peer went away: broadcast instead, after the delay.
    CRITICAL_REGION_LOCAL(m_dandelion_lock);
    for (const auto& e : entries)
      m_dandelion.fluff(e, now);
    LOG_PRINT_L1("[DANDELION] stem peer gone, fluff " << entries.size() << " tx(s)");
  }
  //------------------------------------------------------------------------------------------------------------------------
  template<class t_core>
  void t_currency_protocol_handler<t_core>::dandelion_tick()
  {
    const uint64_t now = epee::misc_utils::get_tick_count();
    // This node's own transactions sent through Tor: again through Tor if nobody broadcast them yet.
    m_kusari_tor.tick(now, [this](const std::string& id) {
      crypto::hash h = null_hash;
      memcpy(&h, id.data(), sizeof(h));
      return m_core.get_tx_pool().have_tx(h);
    });
    typename dandelion_router<boost::uuids::uuid>::due_work w;
    {
      CRITICAL_REGION_LOCAL(m_dandelion_lock);
      w = m_dandelion.due(now);
    }
    if (w.fluff_now.empty() && w.embargo_expired.empty())
      return;
    // Only what is still waiting in the pool: a mined transaction relayed again would get this node dropped.
    auto in_pool = [this](const std::string& id) {
      crypto::hash h = null_hash;
      memcpy(&h, id.data(), sizeof(h));
      return m_core.get_tx_pool().have_tx(h);
    };
    std::list<blobdata> out;
    for (const auto& e : w.embargo_expired)
    {
      if (!in_pool(e.id))
        continue;
      out.push_back(e.blob);
      LOG_PRINT_L1("[DANDELION] embargo over and nobody broadcast it: broadcasting");
    }
    for (const auto& e : w.fluff_now)
      if (in_pool(e.id))
        out.push_back(e.blob);
    if (!out.empty())
    {
      broadcast_now(out);
      LOG_PRINT_L1("[DANDELION] broadcast " << out.size() << " tx(s)");
    }
  }
}
