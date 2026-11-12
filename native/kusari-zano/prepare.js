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
  add(cfg, '"aaa2d7aabc8d383fd53a3ae898697b28f236ceade6bafc1eecff413a6a02272a"', `"${p.maintainersPubKey}"`);
  add(cfg, '#define ALIAS_SHORT_NAMES_VALIDATION_PUB_KEY            "37947f7b6a5268c5d0a48bde73d7a426f0b5f24648f74024279540207dc70031"',
    `#define ALIAS_SHORT_NAMES_VALIDATION_PUB_KEY            "${p.aliasAuthorityPubKey}"`);
  add(cfg, /#define PREMINE_AMOUNT(\s+)\(17517203000000000000U\)[^\n]*/, `#define PREMINE_AMOUNT$1(${BigInt(p.genesis.amount) * 10n ** 12n}U) // the genesis output, burned`);
  add(cfg, '"https://api.zano.org/assets_whitelist.json"', '""');
  add(cfg, '"https://api.zano.org/assets_whitelist_testnet.json"', '""');
  // A new chain runs every Zano hard fork from its first block instead of replaying Zano's history.
  add(cfg, /\/\/ Mainnet\n#define ZANO_HARDFORK_01_AFTER_HEIGHT[\s\S]*?#define ZANO_HARDFORK_06_MIN_BUILD_VER\s+382\n/, [
    '// Mainnet (Kusari: every fork from the first block)',
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
    '#define ZANO_HARDFORK_06_AFTER_HEIGHT                   0',
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
  add('src/currency_core/checkpoints_create.h', /    \/\/ MAINNET\n(    ADD_CHECKPOINT\([^\n]*\n)+/, '    // MAINNET (Kusari: none)\n');
  add('src/common/pre_download.h', /#ifndef TESTNET\n(  static constexpr pre_download_entry [^\n]*\n){4}#else\n(  static constexpr pre_download_entry [^\n]*\n){4}#endif/,
    ['', '_mdbx', '_lmdb', '_mdbx_unpruned', '_lmdb_unpruned'].slice(1).map((n) => `  static constexpr pre_download_entry c_pre_download${n} = { "", "", 0, 0 };`).join('\n'));

  // Binary names.
  add('src/CMakeLists.txt', 'set_property(TARGET daemon PROPERTY OUTPUT_NAME "zanod")',
    'set_property(TARGET daemon PROPERTY OUTPUT_NAME "kusarid")\nset_property(TARGET simplewallet PROPERTY OUTPUT_NAME "kusari-wallet")');

  if (genesis) {
    // Monero's RandomX in place of ProgPoWZ. contrib/randomx is RandomX at the commit Monero pins.
    list.push({ file: 'src/currency_core/basic_pow_helpers.cpp', whole: fs.readFileSync(path.join(__dirname, 'randomx', 'basic_pow_helpers.cpp'), 'utf8') });
    add('src/currency_core/basic_pow_helpers.h', '  crypto::hash ethash_epoch_to_seed(int epoch);\n', '  crypto::hash ethash_epoch_to_seed(int epoch);\n  crypto::hash kusari_rx_seed(uint64_t height);\n');
    add('contrib/CMakeLists.txt', 'add_subdirectory(ethereum)\n', 'add_subdirectory(ethereum)\nadd_subdirectory(randomx)\n');
    add('src/CMakeLists.txt', 'target_link_libraries(currency_core lmdb mdbx)', 'target_link_libraries(currency_core lmdb mdbx randomx)\ntarget_include_directories(currency_core PRIVATE ${CMAKE_SOURCE_DIR}/contrib/randomx/src)');

    add('src/currency_core/genesis.h', /#ifndef TESTNET\n  struct genesis_tx_raw_data\n  \{\n    uint64_t const v\[\d+\];\n    uint8_t const r\[\d+\];\n  \};\n\n#else\n  struct genesis_tx_raw_data\n  \{\n    uint64_t const v\[\d+\];\n    uint8_t const r\[\d+\];\n  \};\n#endif/,
      `  struct genesis_tx_raw_data\n  {\n    uint64_t const v[${genesis.words}];\n    uint8_t const r[${genesis.tail}];\n  };`);
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
