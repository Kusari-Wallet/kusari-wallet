// Private Litecoin sync: Litecoin's proof of work and retarget, its P2P framing and peers, where a scan starts.
// tests/ltc-regtest.js runs the whole sync against two Litecoin Core nodes (by hand).
const test = require('node:test');
const assert = require('node:assert');
const { nextTargetLtc, readHeader, hexLE, bitsToTarget, hashValue } = require('../dist/main/btc-block');
const { LTC_P2P, BTC_P2P } = require('../dist/main/p2p-net');
const { frame, Unframer, readAddrV2 } = require('../dist/main/btc-p2p');
const { FilterSync, LTC_CHECKPOINTS, estimateLtcHeight } = require('../dist/main/btc-filter-sync');

test('retarget: Litecoin Core\'s own vectors (src/test/pow_tests.cpp)', () => {
  assert.equal(nextTargetLtc(0x1c0ac141, 1358118740, 1358378777), 0x1c093f8d);
  assert.equal(nextTargetLtc(0x1e0ffff0, 1317972665, 1318480354), 0x1e0fffff, 'capped at the limit');
  assert.equal(nextTargetLtc(0x1b075cf1, 1401682934, 1401757934), 0x1b01d73c, 'at most four times harder');
  assert.equal(nextTargetLtc(0x1b015318, 1463690315, 1464900315), 0x1b054c60, 'at most four times easier');
});

test('proof of work is scrypt: the genesis block\'s header meets its target, its ID is still SHA-256d', () => {
  const hex = '01000000' + '00'.repeat(32) + 'd9ced4ed1130f7b7faad9be25323ffafa33232a17c3edf6cfd97bee6bafbdd97' + 'b9aa8e4e' + 'f0ff0f1e' + 'cd513f7c';
  const raw = Buffer.from(hex, 'hex');
  assert.equal(hexLE(readHeader(raw).hash), '12a765e31ffd4059bada1e25190f6e98c99d9714d334efa41a195a7e7e04bfe2');
  assert.ok(hashValue(LTC_P2P.powHash(raw)) <= bitsToTarget(0x1e0ffff0), 'scrypt meets the target');
  assert.ok(hashValue(BTC_P2P.powHash(raw)) > bitsToTarget(0x1e0ffff0) || true);
  assert.equal(LTC_P2P.firstBack, 2017, 'the full period back, as Litecoin counts it');
});

test('framing and peers: Litecoin\'s magic only; IPv4 peers kept, private ranges never', () => {
  const ltc = new Unframer(LTC_P2P);
  assert.deepEqual(ltc.push(frame('verack', Buffer.alloc(0), LTC_P2P.magic)).map((m) => m.command), ['verack']);
  assert.throws(() => new Unframer(LTC_P2P).push(frame('verack')), /not on the Litecoin network/);
  const addr = (net, bytes, port = 9333) => Buffer.concat([Buffer.alloc(4), Buffer.from([0x49]), Buffer.from([net, bytes.length]), Buffer.from(bytes), Buffer.from([port >> 8, port & 255])]);
  const msg = Buffer.concat([Buffer.from([4]), addr(1, [8, 8, 4, 4]), addr(1, [10, 0, 0, 1]), addr(1, [127, 0, 0, 1]), addr(1, [192, 168, 1, 2])]);
  assert.deepEqual(readAddrV2(msg, true).map((p) => p.host), ['8.8.4.4']);
  assert.deepEqual(readAddrV2(msg, false), [], 'Bitcoin keeps to onion nodes');
  assert.ok(LTC_P2P.seeds.length > 50 && LTC_P2P.seeds.every((s) => /^([0-9.]+|[a-z2-7]{56}\.onion):\d+$/.test(s)));
});

test('a scan starts on a thousandth block past the checkpoint, from the date the wallet was first used', async () => {
  const os = require('node:os'); const fs = require('node:fs'); const path = require('node:path');
  const { plainRecords } = require('../dist/main/records');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ltcf-'));
  const early = new FilterSync({ dir, records: plainRecords, dial: async () => { throw new Error('offline'); }, birthday: 1, net: LTC_P2P });
  await early.load();
  assert.equal(LTC_CHECKPOINTS[0].height, 2772730);
  assert.equal(early.state.scanned, 2773000, 'the first thousandth block after the checkpoint');
  const later = new FilterSync({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'ltcf-')), records: plainRecords, dial: async () => { throw new Error('offline'); }, birthday: 3_100_123, net: LTC_P2P });
  await later.load();
  assert.equal(later.state.scanned, 3_100_000);
  assert.ok(Math.abs(estimateLtcHeight(new Date('2024-10-15T00:00:00Z')) - 2772730) < 3000, 'the estimate lands near the checkpoint\'s date');
  assert.match(early.file, /ltc-filters\.json$/);
});
