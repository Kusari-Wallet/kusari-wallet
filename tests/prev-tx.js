// A transaction without witnesses that pays the given outputs, for tests whose coins must check out against it.
const { createHash } = require('node:crypto');

const dsha = (b) => createHash('sha256').update(createHash('sha256').update(b).digest()).digest();
const varint = (n) => (n < 0xfd ? Buffer.from([n]) : Buffer.from([0xfd, n & 0xff, n >> 8]));

/** outputs: [{ value: bigint|number, script: hex }], placed at their index. Returns { txid, hex }. */
function prevTx(outputs, salt = 0) {
  const input = Buffer.concat([Buffer.alloc(32, salt & 0xff), Buffer.from([1, 0, 0, 0]), Buffer.from([0]), Buffer.from([0xff, 0xff, 0xff, 0xff])]);
  const outs = outputs.map((o) => {
    const v = Buffer.alloc(8); v.writeBigUInt64LE(BigInt(o.value));
    const s = Buffer.from(o.script, 'hex');
    return Buffer.concat([v, varint(s.length), s]);
  });
  const raw = Buffer.concat([Buffer.from([1, 0, 0, 0]), varint(1), input, varint(outs.length), ...outs, Buffer.alloc(4)]);
  return { txid: Buffer.from(dsha(raw)).reverse().toString('hex'), hex: raw.toString('hex') };
}

module.exports = { prevTx };
