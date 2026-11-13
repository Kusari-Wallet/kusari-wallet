#!/usr/bin/env node
'use strict';
// Turns a Zano checkout at the pinned tag into Kusari, using params.json.
//   git clone --recursive --branch v2.2.0.490 https://github.com/hyle-team/zano kusari
//   node native/kusari-zano/prepare.js kusari
// Every edit must match exactly once, so a Zano version with different code stops here instead of building
// something half changed. The genesis block comes from genesis/, made once by make-genesis.sh; --bootstrap skips it
// for the one build that makes it.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { leadingChar, decodeAddress } = require('../kusari-coin/lib');

const hexBytes = (h) => h.match(/../g).map((x) => '0x' + x);

function load(file) {
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));
  const seen = new Set();
  for (const [k, v] of Object.entries(p.prefixes)) {
    if (!Number.isInteger(v) || leadingChar(v) === null) throw new Error(`${k}: prefix ${v} has no fixed first character`);
    if (seen.has(v)) throw new Error(`prefix ${v} is used twice`);
    seen.add(v);
  }
  for (const k of ['networkId', 'testnetNetworkId']) if (!/^[0-9a-f]{32}$/.test(p[k])) throw new Error(`${k} must be 16 bytes of hex`);
  if (p.networkId === p.testnetNetworkId) throw new Error('network ids must differ');
  for (const k of ['maintainersPubKey', 'aliasAuthorityPubKey']) if (!/^[0-9a-f]{64}$/.test(p[k])) throw new Error(`${k} must be 32 bytes of hex`);
  if (decodeAddress(p.genesis.burnAddress).prefix !== p.prefixes.address) throw new Error('the genesis address must be a Kusari address');
  if (!(Number.isInteger(p.genesis.amount) && p.genesis.amount > 0)) throw new Error('the genesis amount must be a whole number of coins');
  if (!/^[\x20-\x7e]{1,200}$/.test(p.genesis.proof) || /["\\]/.test(p.genesis.proof)) throw new Error('bad genesis proof phrase');
  for (const s of p.seedNodes) if (!/^[A-Za-z0-9.-]+$/.test(s)) throw new Error(`bad seed node ${s} (host only; the port is the P2P port)`);
  if (!Number.isInteger(p.launchTime) || p.launchTime < 1.7e9) throw new Error('bad launch time');
  if (p.testnetMaintainersPubKey === p.maintainersPubKey) throw new Error('mainnet and testnet need different maintainers keys');
  if (!/^[0-9a-f]{64}$/.test(p.testnetMaintainersPubKey ?? '')) throw new Error('testnetMaintainersPubKey must be 32 bytes of hex');
  const e = p.emission;
  if (!e || !/^\d+$/.test(e.moneySupply) || BigInt(e.moneySupply) >= 2n ** 64n || !/^\d+$/.test(e.tailReward) || !(BigInt(e.tailReward) > 0n)) throw new Error('bad emission');
  if (!Number.isInteger(e.speedFactor) || e.speedFactor < 10 || e.speedFactor > 30) throw new Error('bad emission speed factor');
  if (!Number.isInteger(p.posStartHeight) || p.posStartHeight < 1) throw new Error('posStartHeight must be a block height');
  if (!Number.isInteger(p.powTargetBeforePos) || p.powTargetBeforePos < 10 || p.powTargetBeforePos > 600) throw new Error('bad powTargetBeforePos');
  let last = 0;
  for (const c of p.checkpoints) {
    if (!Number.isInteger(c.height) || c.height <= last || !/^[0-9a-f]{64}$/.test(c.hash)) throw new Error(`bad checkpoint ${JSON.stringify(c)}`);
    last = c.height;
  }
  return p;
}

function edits(p, genesis) {
  const list = [];
  const add = (file, from, to) => list.push({ file, from, to });
  const cfg = 'src/currency_core/currency_config.h';
  const pre = {
    CURRENCY_PUBLIC_ADDRESS_BASE58_PREFIX: ['0xc5', p.prefixes.address],
    CURRENCY_PUBLIC_INTEG_ADDRESS_BASE58_PREFIX: ['0x3678', p.prefixes.integrated],
    CURRENCY_PUBLIC_INTEG_ADDRESS_V2_BASE58_PREFIX: ['0x36f8', p.prefixes.integratedV2],
    CURRENCY_PUBLIC_AUDITABLE_ADDRESS_BASE58_PREFIX: ['0x98c8', p.prefixes.auditable],
    CURRENCY_PUBLIC_AUDITABLE_INTEG_ADDRESS_BASE58_PREFIX: ['0x8a49', p.prefixes.auditableIntegrated],
    CURRENCY_PUBLIC_GATEWAY_BASE58_PREFIX: ['0x656e', p.prefixes.gateway],
    CURRENCY_PUBLIC_INTEG_GATEWAY_BASE58_PREFIX: ['0x14276e', p.prefixes.integratedGateway],
  };
  for (const [name, [zano, ours]] of Object.entries(pre)) {
    add(cfg, new RegExp(`#define ${name}(\\s+)${zano}(\\s+)//[^\\n]*`), `#define ${name}$1${ours}$2// Kusari: starts with '${leadingChar(ours)}'`);
  }
  add(cfg, '#define CURRENCY_NAME_ABR                               "ZANO"', `#define CURRENCY_NAME_ABR                               "${p.ticker}"`);
  add(cfg, '#define CURRENCY_NAME_BASE                              "Zano"', `#define CURRENCY_NAME_BASE                              "${p.name}"`);
  add(cfg, '#define CURRENCY_NAME_SHORT_BASE                        "Zano"', `#define CURRENCY_NAME_SHORT_BASE                        "${p.name}"`);
  // Ports, mainnet then testnet.
  add(cfg, '#define P2P_DEFAULT_PORT                                11121\n', `#define P2P_DEFAULT_PORT                                ${p.ports.p2p}\n`);
  add(cfg, '#define RPC_DEFAULT_PORT                                11211\n', `#define RPC_DEFAULT_PORT                                ${p.ports.rpc}\n`);
  add(cfg, '#define STRATUM_DEFAULT_PORT                            11777\n', `#define STRATUM_DEFAULT_PORT                            ${p.ports.stratum}\n`);
  add(cfg, '#define P2P_DEFAULT_PORT                                (11211 + CURRENCY_FORMATION_VERSION)', `#define P2P_DEFAULT_PORT                                ${p.testnetPorts.p2p}`);
  add(cfg, '#define RPC_DEFAULT_PORT                                12111', `#define RPC_DEFAULT_PORT                                ${p.testnetPorts.rpc}`);
  add(cfg, '#define STRATUM_DEFAULT_PORT                            11888', `#define STRATUM_DEFAULT_PORT                            ${p.testnetPorts.stratum}`);
  add(cfg, '"8f138bb73f6d663a3746a542770781a09579a7b84cb4125249e95530824ee607"', `"${p.maintainersPubKey}"`);
  add(cfg, '"aaa2d7aabc8d383fd53a3ae898697b28f236ceade6bafc1eecff413a6a02272a"', `"${p.testnetMaintainersPubKey}"`);
  add(cfg, '#define ALIAS_SHORT_NAMES_VALIDATION_PUB_KEY            "37947f7b6a5268c5d0a48bde73d7a426f0b5f24648f74024279540207dc70031"',
    `#define ALIAS_SHORT_NAMES_VALIDATION_PUB_KEY            "${p.aliasAuthorityPubKey}"`);
  add(cfg, /#define PREMINE_AMOUNT(\s+)\(17517203000000000000U\)[^\n]*/, `#define PREMINE_AMOUNT$1(${BigInt(p.genesis.amount) * 10n ** 12n}U) // the genesis output, burned`);
  add(cfg, '"https://api.zano.org/assets_whitelist.json"', '""');
  add(cfg, '"https://api.zano.org/assets_whitelist_testnet.json"', '""');
  // Monero's emission for 1-minute blocks, in place of Zano's fixed 1 coin a block.
  add(cfg, /#define CURRENCY_BLOCK_REWARD(\s+)1000000000000[^\n]*\n/, [
    '#define CURRENCY_BLOCK_REWARD                           1000000000000 // 1.0 coin; Kusari pays by KUSARI_* below',
    '// Kusari: Monero\'s emission for 1-minute blocks: (supply - generated) >> speed factor, never below the tail.',
    `#define KUSARI_MONEY_SUPPLY                             ((uint64_t)${p.emission.moneySupply}ULL)`,
    `#define KUSARI_EMISSION_SPEED_FACTOR                    ${p.emission.speedFactor}`,
    `#define KUSARI_TAIL_REWARD                              ((uint64_t)${p.emission.tailReward}ULL)`,
    ''].join('\n'));
  // Proof of work alone, with a 1-minute target, until the height proof of stake starts at; then Zano's 2 + 2 minutes.
  // A test build can lower that height with -DKUSARI_TEST_POS_START_HEIGHT=<h>; a release build never sets it.
  add(cfg, '#define POS_START_HEIGHT                                0\n', [
    '#ifdef KUSARI_TEST_POS_START_HEIGHT',
    '#define POS_START_HEIGHT                                KUSARI_TEST_POS_START_HEIGHT',
    '#else',
    `#define POS_START_HEIGHT                                ${p.posStartHeight} // Kusari: proof of stake from here on`,
    '#endif',
    ''].join('\n'));
  add(cfg, '#define DIFFICULTY_POW_TARGET                           120 // seconds\n', [
    '#define DIFFICULTY_POW_TARGET                           120 // seconds',
    `#define KUSARI_POW_TARGET_BEFORE_POS                    ${p.powTargetBeforePos} // seconds, while proof of work is alone`,
    '#define KUSARI_POW_TARGET(h)                            ((h) < POS_START_HEIGHT ? KUSARI_POW_TARGET_BEFORE_POS : DIFFICULTY_POW_TARGET)',
    ''].join('\n'));
  const bcs = 'src/currency_core/blockchain_storage.cpp';
  add(bcs, 'next_difficulty_2(timestamps, commulative_difficulties, pos ? global_difficulty_pos_target : global_difficulty_pow_target,',
    'next_difficulty_2(timestamps, commulative_difficulties, pos ? global_difficulty_pos_target : KUSARI_POW_TARGET(h),');
  add(bcs, 'next_difficulty_1(timestamps, commulative_difficulties, pos ? global_difficulty_pos_target : global_difficulty_pow_target,',
    'next_difficulty_1(timestamps, commulative_difficulties, pos ? global_difficulty_pos_target : KUSARI_POW_TARGET(h),');
  add(bcs, '   const uint64_t target_seconds = pos ? DIFFICULTY_POS_TARGET : DIFFICULTY_POW_TARGET;',
    '   const uint64_t target_seconds = pos ? DIFFICULTY_POS_TARGET : KUSARI_POW_TARGET(max_block_height_for_this_type);');
  const fu = 'src/currency_core/currency_format_utils.cpp';
  add(fu, /  uint64_t get_base_block_reward\(uint64_t height\)\n  \{\n    if \(!height\)\n      return PREMINE_AMOUNT;\n\s*\n    return CURRENCY_BLOCK_REWARD;\n  \}/, [
    '  // Kusari: Monero\'s emission. A 1-minute block pays (supply - generated) >> speed factor, never less than the tail.',
    '  uint64_t get_base_block_reward(uint64_t height, const boost::multiprecision::uint128_t& already_generated_coins)',
    '  {',
    '    if (!height)',
    '      return PREMINE_AMOUNT;',
    '    const boost::multiprecision::uint128_t supply = KUSARI_MONEY_SUPPLY;',
    '    const uint64_t reward = already_generated_coins >= supply ? 0 : static_cast<uint64_t>((supply - already_generated_coins) >> KUSARI_EMISSION_SPEED_FACTOR);',
    '    return std::max<uint64_t>(reward, KUSARI_TAIL_REWARD);',
    '  }'].join('\n'));
  // Fees go to whoever mines or stakes the block, as in Monero, instead of being burned as in Zano since its HF4.
  add(fu, '    // before HF4: add tx fee to the block reward; after HF4: burn it\n    if (tx_version < TRANSACTION_VERSION_POST_HF4)\n    {\n      block_reward += fee;\n    }',
    '    // Kusari: the fees go to the miner (or staker), with every transaction version.\n    block_reward += fee;');
  add(bcs, '  // before HF4: add tx fee to the block reward; after HF4: burn fees, so they don\'t count in block_reward\n  if (miner_tx.version < TRANSACTION_VERSION_POST_HF4)\n  {\n    block_reward += fee;\n  }',
    '  // Kusari: the fees go to the miner (or staker), with every transaction version.\n  block_reward += fee;');
  add(bcs, '  bei.already_generated_coins = already_generated_coins - burned_coins + block_reward_without_fee;\n  if (bei.bl.miner_tx.version >= TRANSACTION_VERSION_POST_HF4)\n  {\n    bei.already_generated_coins -= fee_summary;\n  }',
    '  // Kusari: fees move coins from sender to miner and change nothing in the supply.\n  bei.already_generated_coins = already_generated_coins - burned_coins + block_reward_without_fee;');
  add(bcs, '  if(bei.bl.miner_tx.version >= TRANSACTION_VERSION_POST_HF4)\n    block_reward_entry << "block reward: " << print_money_brief(block_reward_without_fee) << ", fee burnt: " << print_money_brief(fee_summary);\n  else\n    block_reward_entry',
    '  block_reward_entry');
  // Zano's short get_block_reward() passes 0 for the coins made so far, which its flat reward never read; ours does.
  // Checking a block has to use the same total the miner built it with.
  add(bcs, '  block_reward_without_fee = get_block_reward(get_top_block_height() + 1, blocks_size_median, next_block_cumulative_size);',
    '  block_reward_without_fee = 0;\n  if (!get_block_reward(false, blocks_size_median, next_block_cumulative_size, total_coins(), block_reward_without_fee, get_top_block_height() + 1))\n    block_reward_without_fee = 0;');
  add(fu, '    uint64_t base_reward = get_base_block_reward(height);', '    uint64_t base_reward = get_base_block_reward(height, already_generated_coins);');
  add(fu, '    pei_rpc.base_reward = get_base_block_reward(bei_chain.height);\n    pei_rpc.summary_reward = get_reward_from_miner_tx(bei_chain.bl.miner_tx);', [
    '    pei_rpc.summary_reward = get_reward_from_miner_tx(bei_chain.bl.miner_tx);',
    '    // Kusari: the reward follows the coins made before this block, which this record doesn\'t hold: show what was paid.',
    '    pei_rpc.base_reward = pei_rpc.summary_reward > pei_rpc.total_fee ? pei_rpc.summary_reward - pei_rpc.total_fee : 0;'].join('\n'));
  add('src/currency_core/currency_format_utils.h', '  uint64_t get_base_block_reward(uint64_t height);', '  uint64_t get_base_block_reward(uint64_t height, const boost::multiprecision::uint128_t& already_generated_coins);');
  add('src/rpc/core_rpc_server.cpp', '      res.block_reward = currency::get_base_block_reward(res.height);', '      res.block_reward = currency::get_base_block_reward(res.height, total_coins);');
  add('src/wallet/wallet2.cpp', '          mined += CURRENCY_BLOCK_REWARD; //this code would work only for cases where block reward is full. For reduced block rewards might need more flexible code (TODO)',
    '          mined += td.amount(); // Kusari: rewards follow the emission curve, so count what the block paid');

  // A new chain runs the hard forks Zano's mainnet has (1 to 5) from its first block instead of replaying its history.
  add(cfg, /\/\/ Mainnet\n#define ZANO_HARDFORK_01_AFTER_HEIGHT[\s\S]*?#define ZANO_HARDFORK_06_MIN_BUILD_VER\s+382\n/, [
    '// Mainnet (Kusari: forks 1 to 5 from the first block)',
    '#define ZANO_HARDFORK_01_AFTER_HEIGHT                   0',
    '#define ZANO_HARDFORK_02_AFTER_HEIGHT                   0',
    '#define ZANO_HARDFORK_03_AFTER_HEIGHT                   0',
    '',
    '#define ZANO_HARDFORK_04_AFTER_HEIGHT                   0',
    `#define ZANO_HARDFORK_04_TIMESTAMP_ACTUAL               ${p.launchTime}ull`,
    '',
    '#define ZANO_HARDFORK_05_AFTER_HEIGHT                   0',
    '#define ZANO_HARDFORK_05_MIN_BUILD_VER                  382',
    '',
    '#define ZANO_HARDFORK_06_AFTER_HEIGHT                   999999999999999999 // not active on Zano\'s mainnet either',
    '#define ZANO_HARDFORK_06_MIN_BUILD_VER                  382',
    '',
  ].join('\n'));

  // Network id, and none of Zano's seed nodes, checkpoints or chain snapshots.
  const id = (h) => `{ { ${hexBytes(h).join(', ')} } }`;
  add('src/p2p/net_node.inl', /  \/\/zero network before launch\n  const static boost::uuids::uuid P2P_NETWORK_ID = \{ \{[^}]*\} \};/,
    `#ifndef TESTNET\n  const static boost::uuids::uuid P2P_NETWORK_ID = ${id(p.networkId)};\n#else\n  const static boost::uuids::uuid P2P_NETWORK_ID = ${id(p.testnetNetworkId)};\n#endif`);
  const seeds = p.seedNodes.map((s) => `    ADD_HARDCODED_SEED_NODE("${s}", P2P_DEFAULT_PORT);`).join('\n');
  add('src/p2p/net_node.inl', /#ifndef TESTNET\n    \/\/TODO:\n    \/\/ADD_HARDCODED_SEED_NODE[^\n]*\n(    ADD_HARDCODED_SEED_NODE\([^\n]*\n)+#else\n    \/\/ TESTNET\n(    ADD_HARDCODED_SEED_NODE\([^\n]*\n)+#endif\n/,
    `#ifndef TESTNET\n${seeds ? seeds + '\n' : ''}#endif\n`);
  // Developer checkpoints from params.json in place of Zano's.
  add('src/currency_core/checkpoints_create.h', /    \/\/ MAINNET\n(    ADD_CHECKPOINT\([^\n]*\n)+/,
    '    // MAINNET (Kusari: developer checkpoints from params.json)\n' + p.checkpoints.map((c) => `    ADD_CHECKPOINT(${c.height}, "${c.hash}");\n`).join(''));
  add('src/common/pre_download.h', /#ifndef TESTNET\n(  static constexpr pre_download_entry [^\n]*\n){4}#else\n(  static constexpr pre_download_entry [^\n]*\n){4}#endif/,
    ['', '_mdbx', '_lmdb', '_mdbx_unpruned', '_lmdb_unpruned'].slice(1).map((n) => `  static constexpr pre_download_entry c_pre_download${n} = { "", "", 0, 0 };`).join('\n'));

  // Zano's genesis tool gives every payment a second, empty address, which makes the output a multisig one that
  // needs no signature. One address per payment makes it an ordinary output to that address.
  add('src/connectivity_tool/conn_tool.cpp', '  de.addr.resize(1);\n', '');
  add('src/connectivity_tool/conn_tool.cpp', '    de.addr.push_back(addr);\n', '    de.addr.assign(1, addr);\n');

  // Binary names.
  add('src/CMakeLists.txt', 'set_property(TARGET daemon PROPERTY OUTPUT_NAME "zanod")',
    'set_property(TARGET daemon PROPERTY OUTPUT_NAME "kusarid")\nset_property(TARGET simplewallet PROPERTY OUTPUT_NAME "kusari-wallet")');

  // Windows builds with MinGW-w64 (build-windows.sh).
  require('./windows/mingw')(add);

  if (genesis) {
    // Monero's RandomX in place of ProgPoWZ. contrib/randomx is RandomX at the commit Monero pins.
    list.push({ file: 'src/currency_core/basic_pow_helpers.cpp', whole: fs.readFileSync(path.join(__dirname, 'randomx', 'basic_pow_helpers.cpp'), 'utf8') });
    add('src/currency_core/basic_pow_helpers.h', '  crypto::hash ethash_epoch_to_seed(int epoch);\n', '  crypto::hash ethash_epoch_to_seed(int epoch);\n  crypto::hash kusari_rx_seed(uint64_t height);\n  crypto::hash get_block_longhash_mining(uint64_t h, const crypto::hash& block_header_hash, uint64_t nonce);\n');
    add('src/currency_core/miner.cpp', '      crypto::hash h = get_block_longhash(local_height, local_blob_data_hash, nonce);', '      crypto::hash h = get_block_longhash_mining(local_height, local_blob_data_hash, nonce);');
    // Zano turns the node's own CPU miner off on mainnet, because ProgPoWZ is for GPUs. RandomX is for CPUs.
    add('src/currency_core/miner.h', '#ifdef TESTNET\n#define CPU_MINING_ENABLED // disable CPU mining capabilities in mainnet\n#endif // #ifndef TESTNET',
      '#define CPU_MINING_ENABLED // Kusari: RandomX is mined on CPUs, on every network');
    // Monero's RandomX with Kusari's own parameters, which RandomX recommends so that hashrate rented or
    // redirected from Monero can't be pointed at Kusari as it is. Same work per hash: 16 programs of 1024
    // iterations in place of 8 of 2048; all of RandomX's safety conditions still hold.
    add('contrib/randomx/src/configuration.h', '#define RANDOMX_ARGON_SALT         "RandomX\\x03"', '#define RANDOMX_ARGON_SALT         "RandomKSR\\x01"');
    add('contrib/randomx/src/configuration.h', '#define RANDOMX_PROGRAM_ITERATIONS 2048', '#define RANDOMX_PROGRAM_ITERATIONS 1024');
    add('contrib/randomx/src/configuration.h', '#define RANDOMX_PROGRAM_COUNT      8', '#define RANDOMX_PROGRAM_COUNT      16');

    // XMRig's stratum protocol, so RandomKSR can be mined with XMRig ("rx/ksr").
    require('./stratum/xmrig-stratum')(add);

    // Monero's Dandelion++: a new transaction walks a stem of single peers before it is broadcast.
    const dir = path.join(__dirname, 'dandelion');
    list.push({ file: 'src/currency_protocol/dandelion.h', whole: fs.readFileSync(path.join(dir, 'dandelion.h'), 'utf8') });
    list.push({ file: 'src/currency_protocol/dandelion_relay.inl', whole: fs.readFileSync(path.join(dir, 'dandelion_relay.inl'), 'utf8') });
    const defs = 'src/currency_protocol/currency_protocol_defs.h';
    add(defs, '  struct NOTIFY_REQUEST_GET_OBJECTS\n', [
      '  // Kusari: transactions on their Dandelion++ stem, handed to one peer, which passes them on or broadcasts them.',
      '  struct NOTIFY_STEM_TRANSACTIONS',
      '  {',
      '    const static int ID = BC_COMMANDS_POOL_BASE + 20;',
      '    typedef NOTIFY_OR_INVOKE_NEW_TRANSACTIONS::request request;',
      '  };',
      '',
      '  struct NOTIFY_REQUEST_GET_OBJECTS',
      ''].join('\n'));
    const h = 'src/currency_protocol/currency_protocol_handler.h';
    add(h, '#include "currency_core/verification_context.h"\n', '#include "currency_core/verification_context.h"\n#include "dandelion.h"\n');
    add(h, '      HANDLE_INVOKE_T2(NOTIFY_OR_INVOKE_NEW_TRANSACTIONS, &currency_protocol_handler::handle_invoke_new_transaction)\n',
      '      HANDLE_INVOKE_T2(NOTIFY_OR_INVOKE_NEW_TRANSACTIONS, &currency_protocol_handler::handle_invoke_new_transaction)\n      HANDLE_NOTIFY_T2(NOTIFY_STEM_TRANSACTIONS, &currency_protocol_handler::handle_notify_stem_transactions)\n');
    add(h, 'currency_connection_context& context, bool is_notify);\n', [
      'currency_connection_context& context, bool is_notify, bool is_stem = false);',
      '    int handle_notify_stem_transactions(int command, NOTIFY_STEM_TRANSACTIONS::request& arg, currency_connection_context& context);',
      '    void dandelion_init();',
      '    std::vector<typename dandelion_router<boost::uuids::uuid>::tx_entry> dandelion_entries(const std::list<blobdata>& txs);',
      '    void dandelion_seen_fluff(const std::list<blobdata>& txs);',
      '    void stem_relay(const std::list<blobdata>& txs, const boost::uuids::uuid& source);',
      '    void broadcast_now(const std::list<blobdata>& txs);',
      '    void dandelion_tick();',
      ''].join('\n'));
    add(h, '    std::atomic<bool> m_want_stop;\n', [
      '    std::atomic<bool> m_want_stop;',
      '    dandelion_router<boost::uuids::uuid> m_dandelion{ [] { return crypto::rand<uint64_t>(); } };',
      '    std::mutex m_dandelion_lock;',
      ''].join('\n'));
    const inl = 'src/currency_protocol/currency_protocol_handler.inl';
    add(inl, '    m_relay_que_thread = std::thread([this](){relay_que_worker();});', '    dandelion_init();\n    m_relay_que_thread = std::thread([this](){relay_que_worker();});');
    // A transaction handed over by invoke is someone's own, like one from this node's RPC: it starts on a stem.
    add(inl, '    return this->handle_new_transaction_from_net(req, rsp, context, false);', '    return this->handle_new_transaction_from_net(req, rsp, context, false, true);');
    add(inl, 'currency_connection_context& context, bool is_notify)\n  {', 'currency_connection_context& context, bool is_notify, bool is_stem)\n  {');
    add(inl, '    TIME_MEASURE_START_MS(new_transactions_handle_time);\n    for (auto tx_blob_it', '    if (!is_stem)\n      dandelion_seen_fluff(arg.txs); // a broadcast ends any Dandelion++ embargo on these\n\n    TIME_MEASURE_START_MS(new_transactions_handle_time);\n    for (auto tx_blob_it');
    add(inl, '      //TODO: add announce usage here\n      relay_transactions(arg, context);', '      //TODO: add announce usage here\n      if (is_stem)\n        stem_relay(arg.txs, context.m_connection_id);\n      else\n        relay_transactions(arg, context);');
    add(inl, 'currency_connection_context& exclude_context)\n  {\n#ifdef ASYNC_RELAY_MODE', [
      'currency_connection_context& exclude_context)',
      '  {',
      '    // Kusari: this node\'s own transactions (RPC, wallet) start on a Dandelion++ stem.',
      '    if (exclude_context.m_connection_id.is_nil())',
      '    {',
      '      stem_relay(arg.txs, exclude_context.m_connection_id);',
      '      return true;',
      '    }',
      '#ifdef ASYNC_RELAY_MODE'].join('\n'));
    add(inl, '      epee::misc_utils::sleep_no_w(500);', '      dandelion_tick();\n      epee::misc_utils::sleep_no_w(500);');
    list.push({ file: inl, append: '\n#include "dandelion_relay.inl"\n' });

    add('contrib/CMakeLists.txt', 'add_subdirectory(ethereum)\n', 'add_subdirectory(ethereum)\nadd_subdirectory(randomx)\n');
    add('src/CMakeLists.txt', 'target_link_libraries(currency_core lmdb mdbx)', 'target_link_libraries(currency_core lmdb mdbx randomx)\ntarget_include_directories(currency_core PRIVATE ${CMAKE_SOURCE_DIR}/contrib/randomx/src)');

    add('src/currency_core/genesis.h', /#ifndef TESTNET\n  struct genesis_tx_raw_data\n  \{\n    uint64_t const v\[\d+\];\n    uint8_t const r\[\d+\];\n  \};\n\n#else\n  struct genesis_tx_raw_data\n  \{\n    uint64_t const v\[\d+\];\n    uint8_t const r\[\d+\];\n  \};\n#endif/,
      `  struct genesis_tx_raw_data\n  {\n    uint64_t const v[${genesis.words}];\n    uint8_t const r[${genesis.tail}];\n  };`);
    add('src/currency_core/genesis_acc.h', '#ifndef TESTNET\nextern const genesis_tx_dictionary_entry ggenesis_dict[26];\n#else\nextern const genesis_tx_dictionary_entry ggenesis_dict[5];\n#endif',
      `extern const genesis_tx_dictionary_entry ggenesis_dict[${genesis.entries}];`);
    list.push({ file: 'src/currency_core/genesis.cpp', whole: genesis.cpp });
    list.push({ file: 'src/currency_core/genesis_acc.cpp', whole: genesis.acc });
  }
  return list;
}

/** The genesis files from make-genesis.sh, as C++ the build uses for mainnet and testnet alike. */
function loadGenesis(dir) {
  // The raw transaction is the source; the C++ arrays are its bytes as the little-endian words Zano stores.
  const tx = Buffer.from(fs.readFileSync(path.join(dir, 'genesis.txt'), 'utf8').trim(), 'hex');
  if (tx.length < 40) throw new Error('genesis.txt is too short');
  const words = [];
  for (let i = 0; i + 8 <= tx.length; i += 8) words.push('0x' + tx.readBigUInt64LE(i).toString(16).padStart(16, '0'));
  const tail = [...tx.subarray(words.length * 8)].map((b) => '0x' + b.toString(16).padStart(2, '0'));
  const dict = fs.readFileSync(path.join(dir, 'genesis.dictionary.txt'), 'utf8');
  const pub = dict.match(/ggenesis_tx_pub_key_str = "([0-9a-f]{64})"/);
  const entries = dict.match(/\{\d+ULL,\d+\}/g) ?? [];
  if (!pub || !entries.length) throw new Error('genesis.dictionary.txt is not what make-genesis.sh writes');
  const header = '// Kusari genesis, made by native/kusari-zano/make-genesis.sh from params.json.\n// Distributed under the MIT/X11 software license, see the accompanying\n// file COPYING or http://www.opensource.org/licenses/mit-license.php.\n';
  return {
    entries: entries.length,
    words: words.length,
    tail: Math.max(tail.length, 1),
    cpp: `${header}#include "genesis.h"\n\nnamespace currency\n{\n  const genesis_tx_raw_data ggenesis_tx_raw = { {\n    ${words.join(',')} },\n    { ${(tail.length ? tail : ['0x00']).join(',')} } };\n}\n`,
    acc: `${header}#include "genesis_acc.h"\n\nnamespace currency\n{\n  const std::string ggenesis_tx_pub_key_str = "${pub[1]}";\n  const crypto::public_key ggenesis_tx_pub_key = epee::string_tools::parse_tpod_from_hex_string<crypto::public_key>(ggenesis_tx_pub_key_str);\n  const genesis_tx_dictionary_entry ggenesis_dict[${entries.length}] = {\n    ${entries.map((e) => e.replace(',', ', ')).join(',\n    ')}\n  };\n}\n`,
  };
}

function apply(root, list) {
  const files = new Map();
  for (const e of list) {
    const file = path.join(root, e.file);
    if (e.whole !== undefined) { files.set(file, e.whole); continue; }
    if (e.append !== undefined) {
      if (!files.has(file)) files.set(file, fs.readFileSync(file, 'utf8'));
      files.set(file, files.get(file) + e.append);
      continue;
    }
    if (!files.has(file)) files.set(file, fs.readFileSync(file, 'utf8'));
    let s = files.get(file);
    const count = typeof e.from === 'string' ? s.split(e.from).length - 1 : (s.match(new RegExp(e.from.source, 'g')) || []).length;
    if (count !== 1) throw new Error(`${e.file}: expected one match, found ${count}: ${e.from}`);
    s = typeof e.from === 'string' ? s.replace(e.from, () => e.to) : s.replace(e.from, e.to);
    files.set(file, s);
  }
  for (const [file, s] of files) fs.writeFileSync(file, s);
  return files.size;
}

function main() {
  const root = process.argv[2];
  if (!root) { console.error('usage: prepare.js <zano checkout> [--bootstrap]'); process.exit(2); }
  const p = load(path.join(__dirname, 'params.json'));
  if (fs.existsSync(path.join(root, '.git'))) {
    const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    if (head !== p.zano.commit) throw new Error(`checkout is at ${head}, params.json pins ${p.zano.commit} (${p.zano.tag})`);
  }
  const bootstrap = process.argv.includes('--bootstrap');
  const genesisDir = path.join(__dirname, 'genesis');
  if (!bootstrap && !fs.existsSync(path.join(genesisDir, 'genesis.txt'))) throw new Error('no genesis yet: run make-genesis.sh first');
  if (!bootstrap) {
    const rx = path.join(root, 'contrib', 'randomx');
    if (!fs.existsSync(path.join(rx, 'src', 'randomx.h'))) throw new Error(`put RandomX ${p.randomx.commit} in ${rx} first`);
    if (fs.existsSync(path.join(rx, '.git'))) {
      const head = execFileSync('git', ['-C', rx, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      if (head !== p.randomx.commit) throw new Error(`contrib/randomx is at ${head}, params.json pins ${p.randomx.commit}`);
    }
  }
  const n = apply(root, edits(p, bootstrap ? null : loadGenesis(genesisDir)));
  fs.writeFileSync(path.join(root, 'KUSARI_PARAMS.json'), JSON.stringify(p, null, 2) + '\n');
  console.log(`${p.name}${bootstrap ? ' (bootstrap, Zano\'s genesis)' : ''}: changed ${n} files in ${root}`);
}

if (require.main === module) main();
module.exports = { load, edits, apply, loadGenesis };
