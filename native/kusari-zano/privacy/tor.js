'use strict';
// This node's own transactions over Tor (privacy/tor_relay.h explains it). Runs after the Dandelion++ edits, which
// it builds on. Every edit goes through `add`, which must match the code exactly once.

const fs = require('fs');
const path = require('path');

module.exports = function tor(add, list) {
  list.push({ file: 'src/currency_protocol/kusari_tor_relay.h', whole: fs.readFileSync(path.join(__dirname, 'tor_relay.h'), 'utf8') });
  const h = 'src/currency_protocol/currency_protocol_handler.h';
  add(h, '#include "dandelion.h"\n', '#include "dandelion.h"\n#include "kusari_tor_relay.h"\n');
  add(h, '    std::mutex m_dandelion_lock;\n', '    std::mutex m_dandelion_lock;\n    kusari_tor_relay m_kusari_tor;\n');
  const inl = 'src/currency_protocol/currency_protocol_handler.inl';
  // A setting that leaves Tor nowhere to send stops the node instead of falling back to the open network.
  add(inl, '    dandelion_init();\n', '    if (!m_kusari_tor.configure(vm))\n      return false;\n    dandelion_init();\n');
  add(inl, [
    '    if (exclude_context.m_connection_id.is_nil())',
    '    {',
    '      stem_relay(arg.txs, exclude_context.m_connection_id);',
    ''].join('\n'), [
    '    if (exclude_context.m_connection_id.is_nil())',
    '    {',
    '      if (m_kusari_tor.enabled())',
    '      {',
    '        // Only through Tor, never to the peers.',
    '        std::vector<std::pair<std::string, std::string>> txs;',
    '        for (const auto& e : dandelion_entries(arg.txs))',
    '          txs.emplace_back(e.id, e.blob);',
    '        m_kusari_tor.send(txs, epee::misc_utils::get_tick_count());',
    '        return true;',
    '      }',
    '      stem_relay(arg.txs, exclude_context.m_connection_id);',
    ''].join('\n'));
  add('src/daemon/daemon.cpp', '  currency::stratum_server::init_options(desc_cmd_sett);\n',
    '  currency::stratum_server::init_options(desc_cmd_sett);\n  currency::kusari_tor_init_options(desc_cmd_sett);\n');
};
