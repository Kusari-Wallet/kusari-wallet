'use strict';
// Decoy selection. Anyone can see on the chain which of three kinds an output is: a regular transaction's, a PoW
// block's reward, or a PoS block's reward (and whether its block holds transactions). Zano's wallet picks the
// decoys for a regular transaction from regular outputs (with a 5% chance of one reward among them), and for a
// stake from rewards. So whenever the real output is of the other kind (spending mined coins, which on Kusari is
// every first spend for the first 90 days, or staking coins received in a transfer) it is the one ring member of
// its kind, and the ring hides nothing.
//
// Kusari picks every decoy from the real output's own kind, from blocks that kind can come from: rewards from any
// block (PoW rewards are in every PoW block, with transactions or without), PoS rewards from PoS blocks, regular
// outputs from blocks with transactions. The lone decoy of another kind is gone: it was always a decoy, so it only
// made the ring smaller. The wallet asks for four times as many blocks as before (8 per ring member) so that enough
// outputs of one kind turn up, and the node's limit for that request grows to match. Only when the blocks still hold
// too few does a ring fill up with other kinds, which the wallet logs; a ring short of members can't be sent.
//
// The age distribution (which heights decoys come from) stays Zano's: measured from spends on Zano's chain, which,
// like Kusari, makes a block a minute.
//
// Every edit goes through `add`, which must match the code exactly once.

const W = 'src/wallet/wallet2.cpp';

module.exports = function decoys(add) {
  add(W, [
    'void pick_decoys_from_pools(std::vector<out_entry>& coinbase_candidates, std::vector<out_entry>& noncb_candidates,',
    '  size_t wanted_decoys_count, uint64_t real_gindex, decoy_selection_generator::dist_kind mode, std::vector<out_entry>& decoy_storage_out)',
    ''].join('\n'), [
    '// Kusari: the kind of an output, as the chain shows it.',
    'enum class kusari_out_kind { regular, pow_reward, pos_reward };',
    '',
    'static kusari_out_kind kusari_kind_of_flags(uint64_t flags)',
    '{',
    '  if (!(flags & RANDOM_OUTPUTS_FOR_AMOUNTS_FLAGS_COINBASE))',
    '    return kusari_out_kind::regular;',
    '  return (flags & RANDOM_OUTPUTS_FOR_AMOUNTS_FLAGS_POS_COINBASE) ? kusari_out_kind::pos_reward : kusari_out_kind::pow_reward;',
    '}',
    '',
    'static kusari_out_kind kusari_kind_of(const transfer_details& td)',
    '{',
    '  bool pos = false;',
    '  if (!currency::is_coinbase(td.m_ptx_wallet_info->m_tx, pos))',
    '    return kusari_out_kind::regular;',
    '  return pos ? kusari_out_kind::pos_reward : kusari_out_kind::pow_reward;',
    '}',
    '',
    'static const char* kusari_kind_name(kusari_out_kind k)',
    '{',
    '  return k == kusari_out_kind::regular ? "regular" : k == kusari_out_kind::pow_reward ? "PoW reward" : "PoS reward";',
    '}',
    '',
    '// The blocks the node should look in for decoys of this kind.',
    'static const char* kusari_lookup_for(kusari_out_kind k)',
    '{',
    '  return k == kusari_out_kind::regular ? LOOK_UP_STRATEGY_REGULAR_TX : k == kusari_out_kind::pos_reward ? LOOK_UP_STRATEGY_POS_COINBASE : LOOK_UP_STRATEGY_ANY;',
    '}',
    '',
    'void pick_decoys_from_pools(std::vector<out_entry>& coinbase_candidates, std::vector<out_entry>& noncb_candidates,',
    '  size_t wanted_decoys_count, uint64_t real_gindex, decoy_selection_generator::dist_kind mode, std::vector<out_entry>& decoy_storage_out)',
    ''].join('\n'));

  add(W, '  bool include_one_opposite = ((crypto::rand<uint32_t>() % 100) < WALLET_NONCB_SET_PROB_PERCENT) && !opposite.empty();',
    '  bool include_one_opposite = false; // Kusari: a lone decoy of the other kind is always a decoy');

  // A regular transaction: the lookup suits the kinds of its inputs, every ring takes its own kind.
  add(W, '  req4.height_upper_limit = m_last_pow_block_h;\n  req4.look_up_strategy = LOOK_UP_STRATEGY_REGULAR_TX;\n', [
    '  req4.height_upper_limit = m_last_pow_block_h;',
    '  req4.look_up_strategy = LOOK_UP_STRATEGY_REGULAR_TX;',
    '  // Kusari: one request serves every input; if any spends a reward, look in every kind of block.',
    '  for (uint64_t tr_idx : selected_indices)',
    '  {',
    '    auto it = m_transfers.find(tr_idx);',
    '    if (it != m_transfers.end() && kusari_kind_of(it->second) != kusari_out_kind::regular)',
    '      req4.look_up_strategy = LOOK_UP_STRATEGY_ANY;',
    '  }',
    ''].join('\n'));
  add(W, '      const size_t overs = (target_outputs + 1) * 2;', '      const size_t overs = (target_outputs + 1) * 8; // Kusari: enough blocks to find decoys of one kind');
  add(W, [
    '      std::vector<out_entry> coinbase_candidates, noncb_candidates;',
    '      build_pools_from_blocks(',
    '        blocks, td.m_global_output_index,',
    '        /* is_post_hf4 */   [&](uint64_t h)                               { return m_core_runtime_config.is_hardfork_active_for_height(ZANO_HARDFORK_04_ZARCANUM, h); },',
    '        /* block_allowed */ [&](uint64_t /*blk_h*/, bool blk_is_post_hf4) { return (plan.is_real_output_post_hf4 == blk_is_post_hf4); },',
    '        /* entry_allowed */ [&](const out_entry& /*oe*/)                  { return true; },',
    '        coinbase_candidates, noncb_candidates);',
    '',
    '      pick_decoys_from_pools(coinbase_candidates, noncb_candidates, plan.target_decoy_count, td.m_global_output_index, decoy_selection_generator::dist_kind::regular, local_decoys);',
    ''].join('\n'), [
    '      std::vector<out_entry> coinbase_candidates, noncb_candidates;',
    '      // Kusari: decoys of the real output\'s kind; others only if the blocks hold too few of it.',
    '      const kusari_out_kind real_kind = kusari_kind_of(td);',
    '      for (int pass = 0; pass != 2 && local_decoys.size() < plan.target_decoy_count; ++pass)',
    '      {',
    '        if (pass == 1)',
    '          WLT_LOG_L0("[DECOYS] too few " << kusari_kind_name(real_kind) << " outputs for a ring of " << plan.target_decoy_count + 1 << ", filling it with other kinds");',
    '        build_pools_from_blocks(',
    '          blocks, td.m_global_output_index,',
    '          /* is_post_hf4 */   [&](uint64_t h)                               { return m_core_runtime_config.is_hardfork_active_for_height(ZANO_HARDFORK_04_ZARCANUM, h); },',
    '          /* block_allowed */ [&](uint64_t /*blk_h*/, bool blk_is_post_hf4) { return (plan.is_real_output_post_hf4 == blk_is_post_hf4); },',
    '          /* entry_allowed */ [&](const out_entry& oe)                     { return pass == 1 || kusari_kind_of_flags(oe.flags) == real_kind; },',
    '          coinbase_candidates, noncb_candidates);',
    '',
    '        pick_decoys_from_pools(coinbase_candidates, noncb_candidates, plan.target_decoy_count, td.m_global_output_index,',
    '          real_kind == kusari_out_kind::regular ? decoy_selection_generator::dist_kind::regular : decoy_selection_generator::dist_kind::coinbase, local_decoys);',
    '      }',
    '      if (local_decoys.size() >= plan.target_decoy_count)',
    '        WLT_LOG_L1("[DECOYS] ring for a " << kusari_kind_name(real_kind) << " output: " << local_decoys.size() << " decoys");',
    ''].join('\n'));

  // A stake: the same, for the one ring of a PoS block.
  add(W, '    decoys_req.look_up_strategy = LOOK_UP_STRATEGY_POS_COINBASE;\n',
    '    decoys_req.look_up_strategy = kusari_lookup_for(kusari_kind_of(td)); // Kusari: where decoys of the stake\'s kind are\n');
  add(W, '      batch.heights.resize((required_decoys_count + 1) * 2);  // request outs by heights distribution',
    '      batch.heights.resize((required_decoys_count + 1) * 8);  // request outs by heights distribution (Kusari: 8, enough of one kind)');
  add(W, [
    '    build_pools_from_blocks(decoys_resp.blocks_batches.at(0).blocks, td.m_global_output_index,',
    '      /* is_post_hf4 block = */ [&](uint64_t h) -> bool                             { return m_core_runtime_config.is_hardfork_active_for_height(ZANO_HARDFORK_04_ZARCANUM, h); },',
    '      /* block_allowed = */ [&](uint64_t blk_height, bool blk_is_post_hf4) -> bool  { return blk_is_post_hf4; }, // PoS stacke only zcarcanum-era outputs',
    '      /* entry_allowed = */ [&](const out_entry& oe) -> bool                        { (void)oe; return true; },',
    '      coinbase_candidates, noncb_candidates',
    '    );',
    '',
    '    pick_decoys_from_pools(coinbase_candidates, noncb_candidates, required_decoys_count, td.m_global_output_index, decoy_selection_generator::dist_kind::coinbase, decoy_storage);',
    ''].join('\n'), [
    '    const kusari_out_kind stake_kind = kusari_kind_of(td);',
    '    for (int pass = 0; pass != 2 && decoy_storage.size() < required_decoys_count; ++pass)',
    '    {',
    '      if (pass == 1)',
    '        WLT_LOG_L0("[DECOYS] too few " << kusari_kind_name(stake_kind) << " outputs for a stake ring, filling it with other kinds");',
    '      build_pools_from_blocks(decoys_resp.blocks_batches.at(0).blocks, td.m_global_output_index,',
    '        /* is_post_hf4 block = */ [&](uint64_t h) -> bool                             { return m_core_runtime_config.is_hardfork_active_for_height(ZANO_HARDFORK_04_ZARCANUM, h); },',
    '        /* block_allowed = */ [&](uint64_t blk_height, bool blk_is_post_hf4) -> bool  { return blk_is_post_hf4; }, // PoS stacke only zcarcanum-era outputs',
    '        /* entry_allowed = */ [&](const out_entry& oe) -> bool                        { return pass == 1 || kusari_kind_of_flags(oe.flags) == stake_kind; },',
    '        coinbase_candidates, noncb_candidates',
    '      );',
    '',
    '      pick_decoys_from_pools(coinbase_candidates, noncb_candidates, required_decoys_count, td.m_global_output_index,',
    '        stake_kind == kusari_out_kind::regular ? decoy_selection_generator::dist_kind::regular : decoy_selection_generator::dist_kind::coinbase, decoy_storage);',
    '    }',
    ''].join('\n'));

  // The node: the "any block" lookup, and room for 8 blocks per ring member.
  add('src/currency_core/blockchain_storage.cpp',
    '  if (req.look_up_strategy != LOOK_UP_STRATEGY_REGULAR_TX && req.look_up_strategy != LOOK_UP_STRATEGY_POS_COINBASE)',
    '  if (req.look_up_strategy != LOOK_UP_STRATEGY_REGULAR_TX && req.look_up_strategy != LOOK_UP_STRATEGY_POS_COINBASE && req.look_up_strategy != LOOK_UP_STRATEGY_ANY)');
  add('src/rpc/core_rpc_server.cpp',
    'CURRENCY_TX_MAX_ALLOWED_INPUTS * (CURRENCY_HF4_MANDATORY_DECOY_SET_SIZE + 1) * 2 // 2 - over',
    'CURRENCY_TX_MAX_ALLOWED_INPUTS * (CURRENCY_HF4_MANDATORY_DECOY_SET_SIZE + 1) * 8 // Kusari: 8 blocks per ring member, over');
};
