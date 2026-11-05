#!/usr/bin/env node
// Speaks the Zcash engine's protocol with made-up chain data, for tests of everything around the engine.
const fs = require('node:fs');
const readline = require('node:readline');
const log = process.env.FAKE_ZEC_LOG;
const note = (o) => { if (log) fs.appendFileSync(log, JSON.stringify(o) + '\n'); };
let db = null;
let fail = process.env.FAKE_ZEC_FAIL_SYNC_ONCE === '1';
const fresh = () => ({ accounts: 0, birthday: null, total: 0, spendable: 0, transparent: 0, syncs: 0, history: [] });
const U = 'u1' + 'q'.repeat(211); // as long as a real one
const T = 't1' + 'a'.repeat(33);
const HANG = Symbol('hang');
const methods = {
  validate: (p) => /^(u1|zs1|t1|t3|tex1)/.test(p.address),
  open: (p) => { note({ m: 'open', server: p.server, socks: p.socks ?? null, hasDb: Boolean(p.db) }); db = p.db ? JSON.parse(Buffer.from(p.db, 'base64')) : fresh(); return true; },
  account: (p) => { const hang = process.env.FAKE_ZEC_HANG_FLAG; if (hang && !fs.existsSync(hang)) { fs.writeFileSync(hang, ''); return HANG; }  note({ m: 'account', index: p.index, birthday: p.birthday ?? null, seedWords: p.seed.split(' ').length }); db.birthday = p.birthday ?? null; db.total = 150000000; db.spendable = 100000000; db.transparent = 50000000; return db.accounts++; },
  sync: () => { const die = process.env.FAKE_ZEC_DIE_FLAG; if (die && db.syncs > 0 && !fs.existsSync(die)) { fs.writeFileSync(die, ''); process.exit(1); } if (fail) { fail = false; throw new Error('transport error'); } db.syncs++; return true; },
  summary: () => ({ total: db.total, spendable: db.spendable, transparent: db.transparent, tip: 3200000, scanned: 3200000 }),
  address: () => ({ unified: U, transparent: T }),
  quote: (p) => { const value = p.value ?? db.spendable - 15000; if (value + 15000 > db.spendable) throw new Error('insufficient'); return { value, fee: 15000 }; },
  send: (p) => { note({ m: 'send', to: p.to, value: p.value, maxFee: p.maxFee, seedWords: p.seed.split(' ').length }); if (p.maxFee < 15000) throw new Error('fee rose'); db.spendable -= p.value + 15000; db.total -= p.value + 15000; db.history.push({ txid: 'ab'.repeat(32), received: 0, sent: p.value, height: 3199990, status: 'confirmed' }); return { txids: ['ab'.repeat(32)], fee: 15000 }; },
  shield: (p) => { note({ m: 'shield', seedWords: p.seed.split(' ').length }); const v = db.transparent; if (!v) throw new Error('no transparent funds'); db.transparent = 0; db.total -= 15000; db.spendable += v - 15000; return { txids: ['cd'.repeat(32)] }; },
  history: () => ({ tip: 3200000, items: [{ txid: 'ef'.repeat(32), received: 100000000, sent: 0, height: 3199900, status: 'confirmed' }, ...db.history] }),
  dump: () => Buffer.from(JSON.stringify(db)).toString('base64'),
};
readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const r = JSON.parse(line);
  try { const result = methods[r.m](r.p); if (result === HANG) return; process.stdout.write(JSON.stringify({ id: r.id, result }) + '\n'); }
  catch (e) { process.stdout.write(JSON.stringify({ id: r.id, error: e.message }) + '\n'); }
});
