'use strict';
// XMRig's stratum protocol (the one Monero pools speak) in Zano's stratum server, next to its EthProxy protocol.
// Zano's server was written for ProgPoWZ miners; RandomKSR is mined with XMRig (patched for "rx/ksr"), which speaks
// login / job / submit / keepalived with JSON objects as parameters.
//
// A job is the 40 bytes RandomKSR hashes: the block's header hash and the 64-bit nonce, little-endian. Each
// connection gets its own upper half of the nonce, already in the blob; XMRig fills the lower half (bytes 32..35),
// so two workers never hash the same nonces. The target is Monero's 64-bit one, (2^64 - 1) / difficulty, and the
// seed hash is the RandomKSR key for the block's height.
//
// Every edit goes through `add`, which must match the code exactly once.

const SS = 'src/stratum/stratum_server.cpp';

module.exports = function xmrigStratum(add) {
  // Worker difficulty in RandomKSR hashes: a CPU core does about a thousand a second, ProgPoWZ GPUs a million times
  // more. The server raises it from here until a worker finds a share about every 30 seconds.
  add(SS, '#define VDIFF_TARGET_MIN_DEFAULT 100000000ull // = 100 Mh',
    '#define VDIFF_TARGET_MIN_DEFAULT 1000ull // Kusari: RandomKSR on CPUs, about 1 kH/s a core');

  // The connection: which protocol it speaks, whether it has its first job yet, and its half of the nonce.
  add(SS, '    vdiff_params_t m_vd_params;\n  }; // struct stratum_connection_context', [
    '    vdiff_params_t m_vd_params;',
    '    bool m_xmrig = false;        // Kusari: speaks XMRig\'s protocol',
    '    bool m_xmrig_ready = false;  // has had its login response, so jobs can be pushed to it',
    '    uint32_t m_extra_nonce = 0;  // the upper half of every nonce this connection tries',
    '  }; // struct stratum_connection_context'].join('\n'));

  // The EthProxy protocol's seed was Ethereum's epoch seed; the key RandomKSR uses is Kusari's.
  add(SS, '      ethash_hash256 seed_hash = ethash_calculate_epoch_seed(ethash_height_to_epoch(m_block_template_height));',
    '      crypto::hash seed_hash = kusari_rx_seed(m_block_template_height);');

  add(SS, '    void update_work(protocol_handler_t* p_ph)\n', [
    '    // Kusari: a job in XMRig\'s format, or nothing while the node is not synchronized.',
    '    std::string get_xmrig_job_json(stratum_connection_context& cc)',
    '    {',
    '      CRITICAL_REGION_LOCAL(m_work_change_lock);',
    '      if (!is_core_syncronized())',
    '        return std::string();',
    '      std::string blob(reinterpret_cast<const char*>(&m_block_template_ethash), sizeof(m_block_template_ethash));',
    '      const uint64_t le_nonce = SWAP64LE(static_cast<uint64_t>(cc.m_extra_nonce) << 32);',
    '      blob.append(reinterpret_cast<const char*>(&le_nonce), sizeof(le_nonce));',
    '      wide_difficulty_type d = cc.get_worker_difficulty();',
    '      if (d < 1)',
    '        d = 1;',
    '      const uint64_t le_target = SWAP64LE((wide_difficulty_type(std::numeric_limits<uint64_t>::max()) / d).convert_to<uint64_t>());',
    '      const crypto::hash seed = kusari_rx_seed(m_block_template_height);',
    '      return std::string(R"({"blob":")") + epee::string_tools::buff_to_hex_nodelimer(blob) +',
    '        R"(","job_id":")" + epee::string_tools::pod_to_hex(m_block_template_ethash) +',
    '        R"(","target":")" + epee::string_tools::pod_to_hex(le_target) +',
    '        R"(","height":)" + std::to_string(m_block_template_height) +',
    '        R"(,"seed_hash":")" + epee::string_tools::pod_to_hex(seed) + R"(","algo":"rx/ksr"})";',
    '    }',
    '',
    '    uint32_t next_extra_nonce() { return m_next_extra_nonce++; }',
    '',
    '    void update_work(protocol_handler_t* p_ph)',
    ''].join('\n'));
  add(SS, '      if (!updated)\n        p_ph->set_work(get_work_json(p_ph->get_context().get_worker_difficulty()));', [
    '      if (!updated)',
    '        p_ph->set_work(p_ph->get_context().m_xmrig ? get_xmrig_job_json(p_ph->get_context()) : get_work_json(p_ph->get_context().get_worker_difficulty()));'].join('\n'));
  add(SS, [
    '        std::string new_work_json = get_work_json(ph.second->get_context().get_worker_difficulty());',
    '        ph.second->set_work(new_work_json);',
    '        ph.second->send_notification(new_work_json);'].join('\n'), [
    '        if (ph.second->get_context().m_xmrig)',
    '        {',
    '          // Kusari: XMRig gets its first job in the login response, and every later one pushed as "job".',
    '          if (!ph.second->get_context().m_xmrig_ready)',
    '            continue;',
    '          std::string job = get_xmrig_job_json(ph.second->get_context());',
    '          ph.second->set_work(job);',
    '          if (!job.empty())',
    '            ph.second->send_notification(R"("method":"job","params":)" + job);',
    '          continue;',
    '        }',
    '        std::string new_work_json = get_work_json(ph.second->get_context().get_worker_difficulty());',
    '        ph.second->set_work(new_work_json);',
    '        ph.second->send_notification(new_work_json);'].join('\n'));
  add(SS, '      p_ph->send_response_default(id);\n      \n      // send initial work\n      update_work(p_ph);\n', [
    '      if (p_ph->get_context().m_xmrig)',
    '      {',
    '        // Kusari: XMRig takes its first job in the login response.',
    '        update_work(p_ph);',
    '        return p_ph->send_xmrig_login_response(id);',
    '      }',
    '      p_ph->send_response_default(id);',
    '      ',
    '      // send initial work',
    '      update_work(p_ph);',
    ''].join('\n'));
  add(SS, '    bool m_is_core_always_online;\n', '    bool m_is_core_always_online;\n    std::atomic<uint32_t> m_next_extra_nonce{1}; // Kusari: hands out the upper halves of nonces\n');

  // The methods.
  add(SS, '        m_methods_handlers.insert(std::make_pair("eth_submitWork",              &this_t::handle_method_eth_submitWork));\n', [
    '        m_methods_handlers.insert(std::make_pair("eth_submitWork",              &this_t::handle_method_eth_submitWork));',
    '        m_methods_handlers.insert(std::make_pair("login",                       &this_t::handle_method_xmrig_login));',
    '        m_methods_handlers.insert(std::make_pair("getjob",                      &this_t::handle_method_xmrig_getjob));',
    '        m_methods_handlers.insert(std::make_pair("submit",                      &this_t::handle_method_xmrig_submit));',
    '        m_methods_handlers.insert(std::make_pair("keepalived",                  &this_t::handle_method_xmrig_keepalived));',
    ''].join('\n'));
  add(SS, '    void send(const std::string& data)\n', [
    '    // Kusari: XMRig\'s protocol. login {login, pass, rigid}: the login is the wallet address, or "miner" when the',
    '    // node was given --stratum-miner-address, optionally followed by "+<start difficulty>".',
    '    bool handle_method_xmrig_login(const jsonrpc_id_t& id, epee::serialization::portable_storage& ps, epee::serialization::portable_storage::hsection params_section)',
    '    {',
    '      std::string user_str, pass_str, worker_str;',
    '      ps_get_value_noexcept(ps, "login", user_str, params_section);',
    '      ps_get_value_noexcept(ps, "pass", pass_str, params_section);',
    '      ps_get_value_noexcept(ps, "rigid", worker_str, params_section);',
    '      if (worker_str.empty())',
    '        worker_str = std::to_string(m_config.get_number_id_for_nameless_worker());',
    '',
    '      uint64_t start_difficulty = 0;',
    '      size_t delim = user_str.find(\'+\');',
    '      if (delim != std::string::npos)',
    '      {',
    '        TRY_ENTRY()',
    '          start_difficulty = std::stoull(user_str.substr(delim + 1));',
    '        CATCH_ENTRY_CUSTOM("login", { LOG_PRINT_L0(worker_str << ": can\'t parse the start difficulty in " << user_str); }, false);',
    '        user_str = user_str.substr(0, delim);',
    '      }',
    '',
    '      m_context.m_xmrig = true;',
    '      m_context.m_extra_nonce = m_config.next_extra_nonce();',
    '      return m_config.handle_login(this, id, user_str, pass_str, worker_str, start_difficulty);',
    '    }',
    '',
    '    bool send_xmrig_login_response(const jsonrpc_id_t& id)',
    '    {',
    '      std::string job;',
    '      {',
    '        CRITICAL_REGION_LOCAL(m_work_change_lock);',
    '        job = m_cached_work_json;',
    '      }',
    '      if (job.empty())',
    '      {',
    '        send_response_error(id, JSONRPC_ERROR_CODE_DEFAULT, "the node is not synchronized yet");',
    '        return false;',
    '      }',
    '      send_response(id, R"("error":null,"result":{"id":")" + std::to_string(m_context.m_extra_nonce) + R"(","job":)" + job + R"(,"extensions":["algo","keepalive"],"status":"OK"})");',
    '      m_context.m_xmrig_ready = true;',
    '      return true;',
    '    }',
    '',
    '    bool handle_method_xmrig_getjob(const jsonrpc_id_t& id, epee::serialization::portable_storage& ps, epee::serialization::portable_storage::hsection params_section)',
    '    {',
    '      m_config.update_work(this);',
    '      CRITICAL_REGION_LOCAL(m_work_change_lock);',
    '      if (m_cached_work_json.empty())',
    '        send_response_error(id, JSONRPC_ERROR_CODE_DEFAULT, "the node is not synchronized yet");',
    '      else',
    '        send_response(id, R"("error":null,"result":)" + m_cached_work_json);',
    '      return true;',
    '    }',
    '',
    '    // submit {id, job_id, nonce, result}: the job id is the header hash, the nonce the 4 bytes XMRig wrote at',
    '    // offset 32 of the blob, so the low half of the little-endian 64-bit nonce.',
    '    bool handle_method_xmrig_submit(const jsonrpc_id_t& id, epee::serialization::portable_storage& ps, epee::serialization::portable_storage::hsection params_section)',
    '    {',
    '      std::string job_id, nonce_str;',
    '      ps_get_value_noexcept(ps, "job_id", job_id, params_section);',
    '      ps_get_value_noexcept(ps, "nonce", nonce_str, params_section);',
    '      crypto::hash header_hash = null_hash;',
    '      uint32_t low = 0;',
    '      if (!m_context.m_xmrig || !epee::string_tools::hex_to_pod(job_id, header_hash) || !epee::string_tools::hex_to_pod(nonce_str, low))',
    '      {',
    '        send_response_error(id, JSONRPC_ERROR_CODE_DEFAULT, "malformed share");',
    '        return false;',
    '      }',
    '      const uint64_t nonce = (static_cast<uint64_t>(m_context.m_extra_nonce) << 32) | SWAP32LE(low);',
    '      return m_config.handle_work(this, id, m_context.m_worker_name, nonce, header_hash);',
    '    }',
    '',
    '    bool handle_method_xmrig_keepalived(const jsonrpc_id_t& id, epee::serialization::portable_storage& ps, epee::serialization::portable_storage::hsection params_section)',
    '    {',
    '      send_response(id, R"("error":null,"result":{"status":"KEEPALIVED"})");',
    '      return true;',
    '    }',
    '',
    '    void send(const std::string& data)',
    ''].join('\n'));
  // XMRig only counts a share as accepted when the result is an object.
  add(SS, '      send_response(id, R"("result":true)");',
    '      send_response(id, m_context.m_xmrig ? R"("error":null,"result":{"status":"OK"})" : R"("result":true)");');
};
