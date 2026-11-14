const test = require('node:test');
const assert = require('node:assert');
const vectors = require('./fixtures/bip158-vectors.json'); // from Bitcoin Core, src/test/data/blockfilters.json
const { buildFilter, filterMatchesAny, filterHeader, siphash } = require('../dist/main/btc-gcs');
const { parseBlock, hexLE, fromHexLE, readHeader, bitsToTarget, targetToBits, nextTarget } = require('../dist/main/btc-block');

test('siphash-2-4: reference vector', () => {
  // From the SipHash paper: key 00..0f, message 00..0e.
  const k0 = 0x0706050403020100n; const k1 = 0x0f0e0d0c0b0a0908n;
  assert.strictEqual(siphash(k0, k1, Uint8Array.from({ length: 15 }, (_, i) => i)).toString(16), 'a129ca6149be45e5');
});

test('BIP158: blocks parse, filters match Bitcoin Core byte for byte, headers chain, scripts are found', () => {
  let checked = 0;
  for (const row of vectors.slice(1)) {
    const [height, hash, blockHex, prevScripts, prevHeader, filterHex, headerHex, note] = row;
    const raw = Uint8Array.from(Buffer.from(blockHex, 'hex'));
    const { header, txs } = parseBlock(raw);
    assert.strictEqual(hexLE(header.hash), hash, `hash at ${height}`);
    const outScripts = txs.flatMap((t) => t.outputs.map((o) => o.script)).filter((s) => s.length && s[0] !== 0x6a);
    const items = [...outScripts, ...prevScripts.map((s) => Uint8Array.from(Buffer.from(s, 'hex')))];
    const filter = buildFilter(header.hash, items);
    assert.strictEqual(Buffer.from(filter).toString('hex'), filterHex, `filter at ${height} (${note})`);
    assert.strictEqual(hexLE(filterHeader(filter, fromHexLE(prevHeader))), headerHex, `filter header at ${height}`);
    const real = items.filter((i) => i.length);
    if (real.length) assert.ok(filterMatchesAny(filter, header.hash, [real[real.length - 1]]), `finds a script at ${height}`);
    assert.ok(!filterMatchesAny(filter, header.hash, [Uint8Array.from([0x51, 0x20, ...new Array(32).fill(7)])]), `no false match at ${height}`);
    checked++;
  }
  assert.ok(checked >= 10);
});

test('proof-of-work helpers: bits round trip and the retarget rule', () => {
  for (const bits of [0x1d00ffff, 0x17053894, 0x1b0404cb]) assert.strictEqual(targetToBits(bitsToTarget(bits)), bits);
  // Two weeks exactly: unchanged. Twice as fast: target halves (bits as Bitcoin computes them).
  assert.strictEqual(nextTarget(0x17053894, 0, 14 * 24 * 3600), 0x17053894);
  assert.strictEqual(nextTarget(0x1b0404cb, 0, 7 * 24 * 3600), targetToBits(bitsToTarget(0x1b0404cb) / 2n));
  // Clamped at four times either way.
  assert.strictEqual(nextTarget(0x17053894, 0, 1), nextTarget(0x17053894, 0, 14 * 24 * 3600 / 4));
});

// ---- a whole sync against simulated Bitcoin nodes ----
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { FilterSync } = require('../dist/main/btc-filter-sync');
const { frame, Unframer } = require('../dist/main/btc-p2p');
const { plainRecords } = require('../dist/main/records');
const { dsha } = require('../dist/main/btc-block');

const scriptFor = (chain, i) => Buffer.concat([Buffer.from([0x51, 0x20]), crypto.createHash('sha256').update(`${chain}/${i}`).digest()]);
const other = (n) => Buffer.concat([Buffer.from([0x51, 0x20]), crypto.createHash('sha256').update(`other/${n}`).digest()]);
const varint = (n) => (n < 0xfd ? Buffer.from([n]) : Buffer.from([0xfd, n & 0xff, n >> 8]));
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
function tx(inputs, outputs, tag) {
  const ins = inputs.length ? inputs : [{ txid: Buffer.alloc(32), vout: 0xffffffff, script: Buffer.from(`cb${tag}`) }];
  return Buffer.concat([u32(2), varint(ins.length), ...ins.flatMap((i) => [i.txid, u32(i.vout), varint(i.script?.length ?? 0), i.script ?? Buffer.alloc(0), u32(0xffffffff)]),
    varint(outputs.length), ...outputs.flatMap((o) => [u64(o.value), varint(o.script.length), o.script]), u32(0)]);
}
const txid = (raw) => Buffer.from(dsha(raw)); // little-endian bytes

function makeChain(length, plan, fork) {
  // plan(height) -> extra transactions as { inputs: [{ref: [height, txIndex, vout]}], outputs }
  let blocks = [Buffer.alloc(0)]; let hashes = [crypto.randomBytes(32)]; let filters = [Buffer.alloc(0)]; let fheaders = [Buffer.alloc(32)];
  let outputsAt = new Map(); let txids = [[]];
  let from = 1; const salt = fork ? fork.salt : '';
  if (fork) {
    const b = fork.chain; from = fork.at + 1;
    blocks = b.blocks.slice(0, from); hashes = b.hashes.slice(0, from); filters = b.filters.slice(0, from); fheaders = b.fheaders.slice(0, from);
    outputsAt = new Map(b.outputsAt); txids = b.txids.slice(0, from);
  }
  for (let h = from; h <= length; h++) {
    const raws = [tx([], [{ value: 625000000, script: other(h) }], `${h}${salt}`)];
    const prevScripts = [];
    for (const t of plan(h) ?? []) {
      const ins = t.inputs.map(({ ref }) => { const [bh, ti, vo] = ref; prevScripts.push(outputsAt.get(`${bh}:${ti}:${vo}`)); return { txid: txids[bh][ti], vout: vo }; });
      raws.push(tx(ins, t.outputs, `${h}`));
    }
    txids.push(raws.map(txid));
    outputsAt.set(`${h}:0:0`, other(h));
    plan(h)?.forEach((t, k) => t.outputs.forEach((o, vo) => outputsAt.set(`${h}:${k + 1}:${vo}`, o.script)));
    let level = txids[h];
    while (level.length > 1) { const nx = []; for (let i = 0; i < level.length; i += 2) nx.push(Buffer.from(dsha(Buffer.concat([level[i], level[i + 1] ?? level[i]])))); level = nx; }
    let header;
    for (let nonce = 0; ; nonce++) {
      header = Buffer.concat([u32(0x20000000), hashes[h - 1], level[0], u32(1700000000 + h * 600), u32(0x207fffff), u32(nonce)]);
      if (Buffer.from(dsha(header)).reverse()[0] < 0x7f) break;
    }
    const hash = Buffer.from(dsha(header));
    blocks.push(Buffer.concat([header, varint(raws.length), ...raws])); hashes.push(hash);
    const items = [...raws.flatMap((r, i) => (i === 0 ? [other(h)] : plan(h)[i - 1].outputs.map((o) => o.script))), ...prevScripts];
    const f = Buffer.from(buildFilter(hash, items)); filters.push(f);
    fheaders.push(Buffer.from(dsha(Buffer.concat([Buffer.from(dsha(f)), fheaders[h - 1]]))));
  }
  return { blocks, hashes, filters, fheaders, length, outputsAt, txids };
}

function mockPeer(src, { lie = false } = {}) {
  const C = () => src.chain ?? src;
  const sent = [];
  return { sent, dial: () => {
    let onData = () => {}; const un = new Unframer();
    const reply = (cmd, payload) => setImmediate(() => onData(frame(cmd, payload ?? Buffer.alloc(0))));
    const heightOf = (hash) => C().hashes.findIndex((x) => x.equals(hash));
    const filterAt = (h) => (lie ? Buffer.from(buildFilter(C().hashes[h], [other(h)])) : C().filters[h]);
    return {
      write(b) {
        for (const m of un.push(b)) {
          const p = m.payload;
          if (m.command === 'version') {
            const v = Buffer.concat([u32(70016), u64(1n | (1n << 6n)), u64(0), Buffer.alloc(26), Buffer.alloc(26), Buffer.alloc(8), Buffer.from([0]), u32(C().length), Buffer.from([0])]);
            reply('version', v); reply('verack');
          } else if (m.command === 'getaddr') reply('addrv2', Buffer.from([0]));
          else if (m.command === 'getheaders') {
            const n = p[4]; let from = 0;
            for (let i = 0; i < n; i++) { const h = heightOf(p.subarray(5 + i * 32, 37 + i * 32)); if (h >= 0) { from = h; break; } }
            const list = C().blocks.slice(from + 1, from + 2001).map((b) => b.subarray(0, 80));
            reply('headers', Buffer.concat([varint(list.length), ...list.map((x) => Buffer.concat([x, Buffer.from([0])]))]));
          } else if (m.command === 'getcfcheckpt') {
            const stop = heightOf(p.subarray(1, 33)); const list = [];
            for (let h = 1000; h <= stop; h += 1000) list.push(lie ? crypto.randomBytes(32) : C().fheaders[h]);
            reply('cfcheckpt', Buffer.concat([Buffer.from([0]), p.subarray(1, 33), varint(list.length), ...list]));
          } else if (m.command === 'getcfheaders') {
            const start = p.readUInt32LE(1); const stop = heightOf(p.subarray(5, 37));
            const hs = []; let prev = C().fheaders[start - 1];
            for (let h = start; h <= stop; h++) hs.push(Buffer.from(dsha(filterAt(h))));
            if (lie) prev = Buffer.alloc(32, 1);
            reply('cfheaders', Buffer.concat([Buffer.from([0]), p.subarray(5, 37), prev, varint(hs.length), ...hs]));
          } else if (m.command === 'getcfilters') {
            const start = p.readUInt32LE(1); const stop = heightOf(p.subarray(5, 37));
            for (let h = start; h <= stop; h++) { const f = filterAt(h); reply('cfilter', Buffer.concat([Buffer.from([0]), C().hashes[h], varint(f.length), f])); }
          } else if (m.command === 'getdata') {
            reply('block', C().blocks[heightOf(p.subarray(5, 37))]);
          } else if (m.command === 'tx') sent.push(p);
        }
      },
      close() {}, onData(cb) { onData = cb; }, onClose() {},
    };
  } };
}

test('block-filter sync: finds coins, change and spends, extends the gap, ignores a lying node, sends over the peers', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const plan = (h) => {
    if (h === 1100) return [{ inputs: [{ ref: [900, 0, 0] }], outputs: [{ value: 50000, script: scriptFor(0, 0) }] }];
    if (h === 1150) return [{ inputs: [], outputs: [{ value: 7000, script: scriptFor(0, 18) }] }];
    if (h === 1180) return [{ inputs: [], outputs: [{ value: 9000, script: scriptFor(0, 35) }] }]; // only reachable after 18 is seen
    if (h === 1200) return [{ inputs: [{ ref: [1100, 1, 0] }], outputs: [{ value: 30000, script: other('pay') }, { value: 19000, script: scriptFor(1, 0) }] }];
    return [];
  };
  const chain = makeChain(1300, plan);
  const honest1 = mockPeer(chain); const honest2 = mockPeer(chain); const liar = mockPeer(chain, { lie: true });
  const peers = { 'liar.onion': liar, 'a.onion': honest1, 'b.onion': honest2 };
  const sync = new FilterSync({
    dir, records: plainRecords, birthday: 1001,
    checkpoints: [{ height: 0, hash: Buffer.from(chain.hashes[0]).reverse().toString('hex'), minDifficulty: 0 }],
    seeds: Object.keys(peers).map((h) => `${h}:8333`),
    dial: async (host) => peers[host].dial(),
  });
  sync.addAccount({ id: 'main', script: scriptFor, gap: [20, 5] });
  await sync.sync(true);
  const v = sync.view('main');
  assert.strictEqual(v.tip, 1300);
  const coins = v.coins.map((c) => `${c.chain}/${c.index}=${c.value}@${c.height}`).sort();
  assert.deepStrictEqual(coins, ['0/18=7000@1150', '0/35=9000@1180', '1/0=19000@1200']);
  assert.deepStrictEqual(v.next, [36, 1]);
  assert.strictEqual(v.txs.length, 4);
  const spend = v.txs.find((x) => x.height === 1200).accounts.main;
  assert.deepStrictEqual(spend, { in: '19000', out: '50000' });

  // Saved encrypted-or-not by the records given, and picked up again without rescanning.
  const again = new FilterSync({ dir, records: plainRecords, birthday: 1001, checkpoints: [{ height: 0, hash: Buffer.from(chain.hashes[0]).reverse().toString('hex'), minDifficulty: 0 }], seeds: [], dial: async (host) => peers[host].dial() });
  again.addAccount({ id: 'main', script: scriptFor, gap: [20, 5] });
  await again.load();
  assert.strictEqual(again.view('main').coins.length, 3);

  // A send: its coin counts as spent and its change as waiting, and the peers are handed the transaction.
  const raw = tx([{ txid: txids(chain, 1150, 1), vout: 0 }], [{ value: 2000, script: other('x') }, { value: 4000, script: scriptFor(1, 1) }], 's');
  sync.recordSent(raw);
  const after = sync.view('main');
  assert.ok(!after.coins.some((c) => c.index === 18 && c.chain === 0));
  assert.ok(after.coins.some((c) => c.chain === 1 && c.index === 1 && c.height === 0));
  assert.strictEqual(await sync.broadcast(raw) >= 2, true);
  assert.ok([honest1, honest2, liar].some((p) => p.sent.length));
  sync.close();
});

function txids(chain, height, index) {
  // The transaction's ID straight from the block bytes (non-witness, so the whole transaction).
  const b = chain.blocks[height]; let at = 81; const raws = [];
  const readTx = () => { const s = at; at += 4; let n = b[at++]; for (; n > 0; n--) { at += 36; at += b[at] + 1; at += 4; } let o = b[at++]; for (; o > 0; o--) { at += 8; at += b[at] + 1; } at += 4; return b.subarray(s, at); };
  for (let i = 0; i <= index; i++) raws.push(readTx());
  return Buffer.from(dsha(raws[index]));
}

test('onion names from addrv2 keys: every seed in the list decodes and encodes back with a valid checksum', () => {
  const { onionFromKey } = require('../dist/main/btc-p2p');
  const { BTC_ONION_SEEDS } = require('../dist/main/btc-seeds');
  const A = 'abcdefghijklmnopqrstuvwxyz234567';
  for (const name of BTC_ONION_SEEDS) {
    const s = name.replace('.onion', ''); let bits = 0; let v = 0; const out = [];
    for (const ch of s) { v = (v << 5) | A.indexOf(ch); bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } }
    assert.strictEqual(onionFromKey(Uint8Array.from(out.slice(0, 32))), name);
  }
  assert.ok(BTC_ONION_SEEDS.length >= 50);
});

test('heights from dates, birthdays, and the per-wallet switch', async (t) => {
  const { estimateBtcHeight, TAPROOT_HEIGHT } = require('../dist/main/btc-filter-sync');
  const { btcBirthdayFor } = require('../dist/main/service-core');
  const { WalletService } = require('../dist/main/service');
  assert.ok(Math.abs(estimateBtcHeight(new Date(1713571767000)) - 840000) <= 1);
  assert.ok(Math.abs(estimateBtcHeight(new Date(1788925573000)) - 966143) <= 1);
  assert.strictEqual(btcBirthdayFor(new Date('2020-01-01')), TAPROOT_HEIGHT, 'never before taproot');
  assert.strictEqual(btcBirthdayFor(new Date(1788925573000)), 966143 - 1008, 'a week early');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = new WalletService(dir, undefined, { tronHost: 'http://x' });
  assert.deepStrictEqual(await s.readBtcSync(), { filters: false, birthday: 0, from: undefined }, 'older and restored wallets: off');
  await s.writeBtcSync({ filters: true, birthday: 950000, from: '2026-05-01' });
  assert.deepStrictEqual(await s.readBtcSync(), { filters: true, birthday: 950000, from: '2026-05-01' });
  await s.writeBtcSync({ filters: true, birthday: 5 });
  assert.strictEqual((await s.readBtcSync()).filters, false, 'a broken birthday turns it off');
});

test('the Bitcoin client on private sync: balance, history and a draft from filtered blocks, no server asked', async (t) => {
  const { BtcClient, btcAccountXpub } = require('../dist/main/btc');
  const btcSigner = require('@scure/btc-signer');
  const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const client = new BtcClient(btcAccountXpub(SEED), ['http://127.0.0.1:1'], undefined, 2000);
  const scriptOf = (chain, i) => Buffer.from(btcSigner.OutScript.encode(btcSigner.Address(btcSigner.NETWORK).decode(client.addressAt(chain, i))));
  const chain = makeChain(1060, (h) => (h === 1010 ? [{ inputs: [], outputs: [{ value: 120000, script: scriptOf(0, 0) }] }] : h === 1020 ? [{ inputs: [], outputs: [{ value: 3000, script: scriptOf(0, 1) }] }] : []));
  const peers = { 'a.onion': mockPeer(chain), 'b.onion': mockPeer(chain) };
  const sync = new FilterSync({ dir, records: plainRecords, birthday: 1001, checkpoints: [{ height: 0, hash: Buffer.from(chain.hashes[0]).reverse().toString('hex'), minDifficulty: 0 }], seeds: Object.keys(peers), dial: async (host) => peers[host].dial() });
  client.useFilters(sync, 'btc');
  await client.refresh(true);
  assert.deepStrictEqual(await client.getBalance(), { total: 123000n, spendable: 123000n });
  assert.strictEqual(client.nextReceiveIndex, 2);
  assert.strictEqual(client.receiveAddress, client.addressAt(0, 2));
  const hist = await client.getHistory();
  assert.deepStrictEqual(hist.map((x) => [x.direction, x.amount, x.status]).sort(), [['in', '0.00003', 'confirmed'], ['in', '0.0012', 'confirmed']]);
  assert.deepStrictEqual((await client.coins()).map((c) => c.value).sort((a, b) => (a < b ? -1 : 1)), [3000n, 120000n]);
  sync.close();
});

test('block-filter sync: a reorganisation undoes the replaced blocks and finds the coins on the winning branch', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const first = makeChain(1100, (h) => (h === 1090 ? [{ inputs: [], outputs: [{ value: 5000, script: scriptFor(0, 0) }] }] : []));
  const holder = { chain: first };
  const peers = { 'a.onion': mockPeer(holder), 'b.onion': mockPeer(holder) };
  const opts = { dir, records: plainRecords, birthday: 1001, checkpoints: [{ height: 0, hash: Buffer.from(first.hashes[0]).reverse().toString('hex'), minDifficulty: 0 }], seeds: Object.keys(peers), dial: async (host) => peers[host].dial() };
  const sync = new FilterSync(opts);
  sync.addAccount({ id: 'main', script: scriptFor, gap: [20, 5] });
  await sync.sync(true);
  assert.deepStrictEqual(sync.view('main').coins.map((c) => c.height), [1090]);
  // A longer branch from 1085: the payment lands at 1095 there instead.
  sync.lastSync = 0; // a forced sync right after another one would otherwise be skipped
  holder.chain = makeChain(1110, (h) => (h === 1095 ? [{ inputs: [], outputs: [{ value: 5000, script: scriptFor(0, 0) }] }] : []), { chain: first, at: 1085, salt: 'b' });
  await sync.sync(true);
  const v = sync.view('main');
  assert.strictEqual(v.tip, 1110);
  assert.deepStrictEqual(v.coins.map((c) => c.height), [1095]);
  assert.deepStrictEqual(v.txs.map((x) => x.height), [1095]);
  sync.close();
});
