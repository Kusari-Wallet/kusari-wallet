#!/usr/bin/env node
'use strict';
// Turns a Monero checkout at the pinned tag into Kusari, using params.json.
//   git clone --recursive --branch v0.18.5.4 https://github.com/monero-project/monero kusari
//   node native/kusari-coin/prepare.js kusari
// Every edit must match exactly once, so a Monero version with different code stops here instead of building
// something half changed.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { leadingChar, parseGenesisTx, networkIdBytes } = require('./lib');

function load(paramsPath) {
  const p = JSON.parse(fs.readFileSync(paramsPath, 'utf8'));
  for (const n of ['mainnet', 'testnet', 'stagenet']) {
    const c = p[n];
    for (const [k, v] of Object.entries(c.prefixes)) {
      if (!Number.isInteger(v) || leadingChar(v) === null) throw new Error(`${n}.${k}: prefix ${v} has no fixed first character`);
    }
    parseGenesisTx(c.genesisTx);
    networkIdBytes(c.networkId);
    for (const s of c.seedNodes) {
      if (!/^[A-Za-z0-9.\-\[\]:]+:\d+$/.test(s)) throw new Error(`${n}: bad seed node ${s}`);
    }
  }
  const ids = ['mainnet', 'testnet', 'stagenet'].map((n) => p[n].networkId);
  if (new Set(ids).size !== 3) throw new Error('network ids must differ');
  for (let i = 1; i < p.hardForks.length; i++) {
    const a = p.hardForks[i - 1], b = p.hardForks[i];
    if (!(b.version > a.version && b.height > a.height && b.time > a.time)) throw new Error('hard forks must increase');
  }
  if (p.hardForks[0].version !== 1 || p.hardForks[0].height !== 1) throw new Error('the first hard fork must be version 1 at height 1');
  if (!/^[a-z][a-z0-9-]*$/.test(p.binaryPrefix) || !/^[a-z][a-z0-9-]*$/.test(p.dataDirName)) throw new Error('bad names');
  if (!/^[A-Za-z]+$/.test(p.messageSigningKey)) throw new Error('bad message signing key');
  return p;
}

function edits(p) {
  const list = [];
  const add = (file, from, to) => list.push({ file, from, to });

  // Consensus and network identity.
  const cfg = 'src/cryptonote_config.h';
  add(cfg, '#define CRYPTONOTE_NAME                         "bitmonero"', `#define CRYPTONOTE_NAME                         "${p.dataDirName}"`);
  add(cfg, 'const char HASH_KEY_MESSAGE_SIGNING[] = "MoneroMessageSignature";', `const char HASH_KEY_MESSAGE_SIGNING[] = "${p.messageSigningKey}";`);
  const monero = {
    mainnet: { prefixes: [18, 19, 42], ports: [18080, 18081, 18082], id: '0x10', nonce: 10000 },
    testnet: { prefixes: [53, 54, 63], ports: [28080, 28081, 28082], id: '0x11', nonce: 10001 },
    stagenet: { prefixes: [24, 25, 36], ports: [38080, 38081, 38082], id: '0x12', nonce: 10002 },
  };
  for (const [n, m] of Object.entries(monero)) {
    const c = p[n];
    const names = ['ADDRESS', 'INTEGRATED_ADDRESS', 'SUBADDRESS'];
    const ours = [c.prefixes.address, c.prefixes.integrated, c.prefixes.subaddress];
    names.forEach((k, i) => add(cfg, `CRYPTONOTE_PUBLIC_${k}_BASE58_PREFIX = ${m.prefixes[i]};`, `CRYPTONOTE_PUBLIC_${k}_BASE58_PREFIX = ${ours[i]};`));
    ['P2P', 'RPC', 'ZMQ_RPC'].forEach((k, i) => add(cfg, `${k}_DEFAULT_PORT = ${m.ports[i]};`, `${k}_DEFAULT_PORT = ${[c.ports.p2p, c.ports.rpc, c.ports.zmq][i]};`));
    add(cfg, new RegExp(`0x12 ,0x30, 0xF1, 0x71 , 0x61, 0x04 , 0x41, 0x61, 0x17, 0x31, 0x00, 0x82, 0x16, 0xA1, 0xA1, ${m.id}\\n\\s*\\} \\}; // Bender's \\w+`),
      networkIdBytes(c.networkId).join(', ') + '\n    } };');
    add(cfg, new RegExp(`GENESIS_TX = "[0-9a-f]+";\\n(\\s*)uint32_t const GENESIS_NONCE = ${m.nonce};`),
      `GENESIS_TX = "${c.genesisTx}";\n$1uint32_t const GENESIS_NONCE = ${c.genesisNonce};`);
  }

  // A new chain starts on Monero's current rules instead of replaying Monero's fork history.
  const forks = p.hardForks.map((f) => `  { ${f.version}, ${f.height}, 0, ${f.time} },`).join('\n');
  for (const n of ['mainnet', 'testnet', 'stagenet']) {
    add('src/hardforks/hardforks.cpp', new RegExp(`const hardfork_t ${n}_hard_forks\\[\\] = \\{[\\s\\S]*?\\n\\};`),
      `const hardfork_t ${n}_hard_forks[] = {\n${forks}\n};`);
  }
  add('src/hardforks/hardforks.cpp', 'mainnet_hard_fork_version_1_till = 1009826;', 'mainnet_hard_fork_version_1_till = 1;');
  add('src/hardforks/hardforks.cpp', 'testnet_hard_fork_version_1_till = 624633;', 'testnet_hard_fork_version_1_till = 1;');
  add('src/wallet/wallet2.cpp', 'uint64_t v2height = m_nettype == TESTNET ? 624634 : m_nettype == STAGENET ? 32000  : 1009827;',
    `uint64_t v2height = ${p.hardForks[1].height};`);

  // Monero's checkpoints and precomputed block hashes are for Monero's chain and would reject this one.
  add('src/checkpoints/checkpoints.cpp', /bool checkpoints::init_default_checkpoints\(network_type nettype\)\n  \{[\s\S]*?\n    return true;\n  \}/,
    'bool checkpoints::init_default_checkpoints(network_type nettype)\n  {\n    return true;\n  }');
  for (const v of ['dns_urls', 'testnet_dns_urls', 'stagenet_dns_urls']) {
    add('src/checkpoints/checkpoints.cpp', new RegExp(`static const std::vector<std::string> ${v} = \\{[^}]*\\};`),
      `static const std::vector<std::string> ${v} = {};`);
  }
  add('src/blocks/blocks.cpp', /CheckpointsByNetwork = \{[\s\S]*?\n  \};/, 'CheckpointsByNetwork = {};');

  // No Monero seed nodes, DNS seeds, Tor or I2P seeds, or update checks against Monero's servers.
  add('src/p2p/net_node.h', /m_seed_nodes_list =\n\s*\{[^}]*\};/, 'm_seed_nodes_list = {};');
  const seeds = (n) => p[n].seedNodes.map((s) => `      full_addrs.insert("${s}");`).join('\n');
  add('src/p2p/net_node.inl', /    if \(m_nettype == cryptonote::TESTNET\)\n    \{\n      full_addrs\.insert[\s\S]*?\n    return full_addrs;/,
    [
      '    if (m_nettype == cryptonote::TESTNET)', '    {', seeds('testnet'), '    }',
      '    else if (m_nettype == cryptonote::STAGENET)', '    {', seeds('stagenet'), '    }',
      '    else if (m_nettype == cryptonote::FAKECHAIN)', '    {', '    }',
      '    else', '    {', seeds('mainnet'), '    }',
      '    return full_addrs;',
    ].filter((l) => l !== '').join('\n'));
  add('src/p2p/net_node.inl', /case epee::net_utils::zone::tor:\n      if \(m_nettype == cryptonote::MAINNET\)\n      \{\n        return \{[^}]*\};\n      \}\n/, 'case epee::net_utils::zone::tor:\n');
  add('src/p2p/net_node.inl', /case epee::net_utils::zone::i2p:\n      if \(m_nettype == cryptonote::MAINNET\)\n      \{\n        return \{[^}]*\};\n      \}\n/, 'case epee::net_utils::zone::i2p:\n');
  add('src/common/updates.cpp', /static const std::vector<std::string> dns_urls = \{[^}]*\};/, 'static const std::vector<std::string> dns_urls = {};');
  add('src/cryptonote_core/cryptonote_core.cpp', ', "Check for new versions of monero: [disabled|notify|download|update]"\n  , "notify"',
    ', "Check for new versions: [disabled|notify|download|update]"\n  , "disabled"');

  // Binary names.
  const bins = [
    ['src/daemon/CMakeLists.txt', 'monerod', `${p.binaryPrefix}d`],
    ['src/simplewallet/CMakeLists.txt', 'monero-wallet-cli', `${p.binaryPrefix}-wallet-cli`],
    ['src/wallet/CMakeLists.txt', 'monero-wallet-rpc', `${p.binaryPrefix}-wallet-rpc`],
    ['src/gen_ssl_cert/CMakeLists.txt', 'monero-gen-ssl-cert', `${p.binaryPrefix}-gen-ssl-cert`],
    ['src/gen_multisig/CMakeLists.txt', 'monero-gen-trusted-multisig', `${p.binaryPrefix}-gen-trusted-multisig`],
    ['src/blockchain_utilities/CMakeLists.txt', 'monero-blockchain-import', `${p.binaryPrefix}-blockchain-import`],
    ['src/blockchain_utilities/CMakeLists.txt', 'monero-blockchain-export', `${p.binaryPrefix}-blockchain-export`],
  ];
  for (const [f, a, b] of bins) add(f, `OUTPUT_NAME "${a}")`, `OUTPUT_NAME "${b}")`);

  return list;
}

function apply(root, list) {
  const files = new Map();
  for (const e of list) {
    const file = path.join(root, e.file);
    if (!files.has(file)) files.set(file, fs.readFileSync(file, 'utf8'));
    let s = files.get(file);
    const count = typeof e.from === 'string'
      ? s.split(e.from).length - 1
      : (s.match(new RegExp(e.from.source, 'g')) || []).length;
    if (count !== 1) throw new Error(`${e.file}: expected one match, found ${count}: ${e.from}`);
    s = typeof e.from === 'string' ? s.replace(e.from, () => e.to) : s.replace(e.from, e.to);
    files.set(file, s);
  }
  for (const [file, s] of files) fs.writeFileSync(file, s);
  return files.size;
}

function main() {
  const root = process.argv[2];
  if (!root) {
    console.error('usage: prepare.js <monero checkout> [params.json]');
    process.exit(2);
  }
  const p = load(process.argv[3] || path.join(__dirname, 'params.json'));
  if (fs.existsSync(path.join(root, '.git'))) {
    const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    if (head !== p.monero.commit) throw new Error(`checkout is at ${head}, params.json pins ${p.monero.commit} (${p.monero.tag})`);
  }
  const n = apply(root, edits(p));
  fs.writeFileSync(path.join(root, 'KUSARI_PARAMS.json'), JSON.stringify(p, null, 2) + '\n');
  console.log(`${p.name}: changed ${n} files in ${root}`);
}

if (require.main === module) main();
module.exports = { load, edits, apply };
