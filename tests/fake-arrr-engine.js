#!/usr/bin/env node
// Speaks the Pirate Chain engine's protocol with made-up chain data.
const fs = require('node:fs');
const readline = require('node:readline');
const log = process.env.FAKE_ARRR_LOG;
const note = (o) => { if (log) fs.appendFileSync(log, JSON.stringify(o) + '\n'); };
const ADDRESS = 'zs1' + 'q'.repeat(75);
const state = process.env.FAKE_ARRR_STATE;
let saved = state && fs.existsSync(state) ? fs.readFileSync(state, 'utf8').trim() : null;
let spendable = 200000000; let total = 300000000; const sent = [];
const methods = {
  open: (p) => { note({ m: 'open', dir: p.dir, passLength: p.pass.length, socks: p.socks ?? null }); return { wallet: saved }; },
  tip: (p) => { note({ m: 'tip', server: p.server }); if (process.env.FAKE_ARRR_DOWN === p.server) return { ok: false, height: null, error: 'unreachable' }; return { ok: true, height: 5000000 }; },
  restore: (p) => { note({ m: 'restore', words: p.seed.split(' ').length, birthday: p.birthday }); saved = 'w-1'; if (state) fs.writeFileSync(state, saved); return saved; },
  use: (p) => { note({ m: 'use', wallet: p.wallet, server: p.server }); return true; },
  sync: () => { note({ m: 'sync' }); return true; },
  rescan: (p) => { note({ m: 'rescan', from: p.from }); return true; },
  status: () => ({ running: false, local: 5000000, target: 5000000, percent: 100, total, spendable, pending: 0 }),
  address: () => ({ address: ADDRESS }),
  validate: (p) => /^(zs1|pirate1)/.test(p.address),
  quote: (p) => { const value = p.value ?? spendable - 10000; if (value + 10000 > spendable) throw new Error('insufficient'); return { value, fee: 10000 }; },
  send: (p) => { note({ m: 'send', to: p.to, value: p.value, maxFee: p.maxFee }); spendable -= p.value + 10000; total -= p.value + 10000; sent.push(p.value); return { txid: 'ab'.repeat(32) }; },
  history: () => [{ txid: 'ef'.repeat(32), height: 4999000, time: 1790000000, amount: 300000000, fee: 0, confirmed: true, expired: false }, ...sent.map((v) => ({ txid: 'ab'.repeat(32), height: null, time: 0, amount: -v, fee: 10000, confirmed: false, expired: false }))],
};
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const r = JSON.parse(line);
  try { process.stdout.write(JSON.stringify({ id: r.id, result: methods[r.m](r.p) }) + '\n'); }
  catch (e) { process.stdout.write(JSON.stringify({ id: r.id, error: e.message }) + '\n'); }
});
