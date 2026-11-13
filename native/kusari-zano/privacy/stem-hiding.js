'use strict';
// Dandelion++ keeps a transaction on its stem private: only the nodes it passed through have it, until one of them
// broadcasts it. Zano's pool shows every transaction it holds, so a node's RPC (pool listings, transaction lookups,
// the pool size in getinfo) and its block templates gave away that a transaction was on its stem there, and an
// operator's "relay the pool" command broadcast stem transactions early. Monero hides such transactions the same way.
//
// The pool now asks the Dandelion++ router whether a transaction is private (under embargo here, or waiting out this
// node's delay before broadcasting it) and leaves it out of all of these until it has been broadcast. The pool still
// holds it, checks it, and uses its key images against double spends.
//
// Every edit goes through `add`, which must match the code exactly once.

const H = 'src/currency_core/tx_pool.h';
const P = 'src/currency_core/tx_pool.cpp';

module.exports = function stemHiding(add) {
  add(H, '#include <set>\n#include <unordered_map>\n', '#include <functional>\n#include <set>\n#include <unordered_map>\n');
  add(H, '    bool force_relay_pool() const;\n', [
    '    bool force_relay_pool() const;',
    '    // Kusari: whether a transaction is still on its Dandelion++ stem here, so shown to nobody yet.',
    '    void kusari_set_private_check(std::function<bool(const crypto::hash&)> f) { m_kusari_is_private = std::move(f); }',
    '    bool kusari_is_private(const crypto::hash& h) const { return m_kusari_is_private && m_kusari_is_private(h); }',
    ''].join('\n'));
  add(H, '  private:\n    bool on_tx_add(crypto::hash tx_id, const transaction& tx, bool kept_by_block);\n', [
    '  private:',
    '    std::function<bool(const crypto::hash&)> m_kusari_is_private;',
    '    bool on_tx_add(crypto::hash tx_id, const transaction& tx, bool kept_by_block);',
    ''].join('\n'));

  // The count, the listings and lookups RPC serves.
  add(P, '  size_t tx_memory_pool::get_transactions_count() const \n  {\n    return m_db_transactions.size();\n  }', [
    '  size_t tx_memory_pool::get_transactions_count() const ',
    '  {',
    '    size_t n = m_db_transactions.size();',
    '    if (m_kusari_is_private)',
    '      m_db_transactions.enumerate_keys([&](uint64_t, const crypto::hash& h) { if (n && kusari_is_private(h)) --n; return true; });',
    '    return n;',
    '  }'].join('\n'));
  const skip = '      if (kusari_is_private(h))\n        return true; // Kusari: still on its stem\n';
  add(P, '    m_db_transactions.enumerate_items([&](uint64_t i, const crypto::hash& h, const tx_details &tx_entry)\n    {\n      txs.push_back(tx_entry.tx);\n',
    '    m_db_transactions.enumerate_items([&](uint64_t i, const crypto::hash& h, const tx_details &tx_entry)\n    {\n' + skip + '      txs.push_back(tx_entry.tx);\n');
  add(P, '    m_db_transactions.enumerate_items([&](uint64_t i, const crypto::hash& h, const tx_details &tx_entry)\n    {\n      txs.push_back(tx_rpc_extended_info());\n',
    '    m_db_transactions.enumerate_items([&](uint64_t i, const crypto::hash& h, const tx_details &tx_entry)\n    {\n' + skip + '      txs.push_back(tx_rpc_extended_info());\n');
  add(P, '    m_db_transactions.enumerate_items([&](uint64_t i, const crypto::hash& h, const tx_details &tx_entry)\n    {\n      txs.push_back(tx_rpc_brief_info());\n',
    '    m_db_transactions.enumerate_items([&](uint64_t i, const crypto::hash& h, const tx_details &tx_entry)\n    {\n' + skip + '      txs.push_back(tx_rpc_brief_info());\n');
  add(P, '    m_db_transactions.enumerate_items([&](uint64_t i, const crypto::hash& h, const tx_details &tx_entry)\n    {\n      txs.push_back(epee::string_tools::pod_to_hex(h));\n',
    '    m_db_transactions.enumerate_items([&](uint64_t i, const crypto::hash& h, const tx_details &tx_entry)\n    {\n' + skip + '      txs.push_back(epee::string_tools::pod_to_hex(h));\n');
  // Lookups by id: a private one is "not in the pool" (the same answer as for an id nobody has).
  add(P, '      auto ptei = m_db_transactions.get(id);\n      if (!ptei)\n        return false;\n\n      txs.push_back(tx_rpc_extended_info());\n',
    '      auto ptei = m_db_transactions.get(id);\n      if (!ptei || kusari_is_private(id))\n        return false;\n\n      txs.push_back(tx_rpc_extended_info());\n');
  add(P, '      auto ptei = m_db_transactions.get(id);\n      if (!ptei)\n        return false;\n\n      txs.push_back(tx_rpc_brief_info());\n',
    '      auto ptei = m_db_transactions.get(id);\n      if (!ptei || kusari_is_private(id))\n        return false;\n\n      txs.push_back(tx_rpc_brief_info());\n');
  add(P, '  bool tx_memory_pool::get_transaction_details(const crypto::hash& id, tx_rpc_extended_info& trei) const\n  {\n    auto ptei = m_db_transactions.get(id);\n    if (!ptei)\n      return false;\n',
    '  bool tx_memory_pool::get_transaction_details(const crypto::hash& id, tx_rpc_extended_info& trei) const\n  {\n    auto ptei = m_db_transactions.get(id);\n    if (!ptei || kusari_is_private(id))\n      return false;\n');
  // "relay the pool" broadcasts only what is public already.
  add(P, '    m_db_transactions.enumerate_items([&](uint64_t i, const crypto::hash& k, const tx_details& v)\n    {\n      r.txs.push_back(t_serializable_object_to_blob(v.tx));\n',
    '    m_db_transactions.enumerate_items([&](uint64_t i, const crypto::hash& k, const tx_details& v)\n    {\n      if (kusari_is_private(k))\n        return true; // Kusari: its stem broadcasts it\n      r.txs.push_back(t_serializable_object_to_blob(v.tx));\n');
  // A block template leaves them out: a block holding one would show it was here.
  add(P, '      txs[i] = i;\n    }\n', [
    '      txs[i] = i;',
    '    }',
    '    // Kusari: not a transaction still on its stem here.',
    '    txs.erase(std::remove_if(txs.begin(), txs.end(), [&](size_t j) { return kusari_is_private(txs_v[j].first); }), txs.end());',
    ''].join('\n'));
};
