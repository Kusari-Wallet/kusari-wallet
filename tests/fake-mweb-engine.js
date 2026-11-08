#!/usr/bin/env node
// Speaks the MWEB engine's protocol (native/mweb-bridge) with made-up chain data.
const readline = require('node:readline');
const crypto = require('node:crypto');
const log = process.env.FAKE_MWEB_LOG;
const fs = require('node:fs');
const CHARS = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
// A made-up address per index: ltcmweb1 + 110 bech32 characters, the same every time for the same key.
const addr = (scan, i) => 'ltcmweb1' + [...crypto.createHash('sha512').update(`${scan}/${i}`).digest().toString('hex').repeat(2)].slice(0, 110).map((c) => CHARS[parseInt(c, 16) * 2 % 32]).join('');
let coins = JSON.parse(process.env.FAKE_MWEB_COINS ?? '[]'); // [{index, value, height}]
let scan = '';
const FEE = 2000;
const reply = (id, result, error) => process.stdout.write(JSON.stringify(error ? { id, error } : { id, result }) + '\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, m, p } = JSON.parse(line);
  if (log) fs.appendFileSync(log, JSON.stringify({ m, p: { ...p, Spend: p?.Spend ? 'set' : undefined, inputs: p?.inputs?.map((i) => ({ ...i, key: i.key ? 'set' : undefined })) } }) + '\n');
  const owned = () => coins.map((c, n) => ({ outputId: crypto.createHash('sha256').update(`coin${n}`).digest('hex'), value: c.value, address: addr(scan, c.index), height: c.height, blockTime: 0 }));
  switch (m) {
    case 'start': return reply(id, null);
    case 'addresses': scan = p.Scan; return reply(id, Array.from({ length: p.To - p.From }, (_, i) => addr(p.Scan, p.From + i)));
    case 'watch': return reply(id, null);
    case 'status': return reply(id, { headers: 3000000, mwebHeaders: 3000000, mwebUtxos: 3000000, peers: 8, scanReady: true, scanDone: 10, scanSize: 10 });
    case 'coins': return reply(id, { ready: true, coins: owned() });
    case 'send': {
      const have = owned().filter((c) => p.coins.some((x) => x.outputId === c.outputId)).reduce((s, c) => s + c.value, 0);
      const amount = p.max ? have - FEE : p.to.value;
      if (amount <= 0 || amount + FEE > have) return reply(id, null, 'Not enough private LTC.');
      if (!p.dryRun && !p.Spend) return reply(id, null, 'bad key');
      if (!p.dryRun) coins = coins.filter((c, n) => !p.coins.some((x) => x.outputId === owned()[n].outputId));
      return reply(id, { amount, fee: FEE, pegout: !p.to.address.startsWith('ltcmweb1'), txid: p.dryRun ? undefined : 'ab'.repeat(32) });
    }
    case 'pegin': {
      const total = p.inputs.reduce((s, i) => s + i.value, 0);
      if (!p.dryRun && p.inputs.some((i) => !i.key)) return reply(id, null, 'bad key');
      if (p.inputs.some((i) => !/^0014[0-9a-f]{40}$/.test(i.script))) return reply(id, null, 'bad script');
      if (!p.dryRun) coins.push({ index: 1, value: total - 3000, height: 0 });
      return reply(id, { amount: total - 3000, fee: 3000, txid: p.dryRun ? undefined : 'cd'.repeat(32) });
    }
    default: return reply(id, null, `unknown method ${m}`);
  }
});
