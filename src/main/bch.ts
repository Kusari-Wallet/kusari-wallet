import { bip39Seed } from './seed';
import { BLOCKBOOK, blockbookSend, isBlockbook } from './blockbook';
import type { Agent } from 'node:http';
import { SigningKey, getBytes, ripemd160, sha256 } from 'ethers';
import { getJson, requestJson, USER_AGENT } from './request';
import { InsightDraft, InsightWallet } from './insight';

const { HDKey } = require('@scure/bip32');

// Coin type 145 is Bitcoin Cash's own, as Electron Cash and Bitcoin.com Wallet use it.
export const BCH_PATH = "m/44'/145'/0'";
const PREFIX = 'bitcoincash';
const FEE_SATS_PER_BYTE = 2n; // the network minimum is 1
const DUST = 546n;
const SIZE_BASE = 10n;
const SIZE_INPUT = 148n;
const SIZE_OUTPUT = 34n;
// The server answers one address per request, so a scan looks only a few unused addresses ahead.
const GAP_RECEIVE = 5;
const GAP_CHANGE = 2;
const CACHE_MS = 2 * 60_000;
const HISTORY_TXS = 15;
const SIGHASH_ALL_FORKID = 0x41;

// ---- CashAddr ----

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x98f2bc8e61n, 0x79b76d99e2n, 0xf33e5fb3c4n, 0xae2eabe2a8n, 0x1e4f43e470n];

function polymod(values: number[]): bigint {
  let c = 1n;
  for (const d of values) {
    const top = c >> 35n;
    c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(d);
    for (let i = 0; i < 5; i++) if ((top >> BigInt(i)) & 1n) c ^= GEN[i];
  }
  return c ^ 1n;
}

function convert(data: number[], from: number, to: number, pad: boolean): number[] {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const max = (1 << to) - 1;
  for (const v of data) {
    acc = (acc << from) | v;
    bits += from;
    while (bits >= to) { bits -= to; out.push((acc >> bits) & max); }
  }
  if (pad && bits > 0) out.push((acc << (to - bits)) & max);
  else if (!pad && (bits >= from || ((acc << (to - bits)) & max))) throw new Error('bad padding');
  return out;
}

const prefixData = () => [...PREFIX].map((ch) => ch.charCodeAt(0) & 31).concat(0);

/** type 0 is a key hash (q...), 1 a script hash (p...). */
export function encodeCashAddr(type: 0 | 1, hash: Uint8Array): string {
  if (hash.length !== 20) throw new Error('bad hash');
  const data = convert([type << 3, ...hash], 8, 5, true);
  const sum = polymod([...prefixData(), ...data, 0, 0, 0, 0, 0, 0, 0, 0]);
  const check = Array.from({ length: 8 }, (_, i) => Number((sum >> BigInt(5 * (7 - i))) & 31n));
  return `${PREFIX}:${[...data, ...check].map((d) => CHARSET[d]).join('')}`;
}

/** Only CashAddr: an old-style address looks exactly like a Bitcoin one, and coins sent to the wrong chain are lost. */
export function decodeCashAddr(input: string): { type: 0 | 1; hash: Uint8Array } {
  const text = input.trim();
  if (text !== text.toLowerCase() && text !== text.toUpperCase()) throw new Error('mixed case');
  const lower = text.toLowerCase();
  const body = lower.startsWith(`${PREFIX}:`) ? lower.slice(PREFIX.length + 1) : lower;
  if (body.includes(':') || body.length !== 42) throw new Error('bad length');
  const data = [...body].map((ch) => { const i = CHARSET.indexOf(ch); if (i < 0) throw new Error('bad character'); return i; });
  if (polymod([...prefixData(), ...data]) !== 0n) throw new Error('bad checksum');
  const bytes = convert(data.slice(0, -8), 5, 8, false);
  const version = bytes[0];
  if ((version & 7) !== 0 || bytes.length !== 21) throw new Error('not a 20-byte hash');
  const type = version >> 3;
  if (type !== 0 && type !== 1) throw new Error('unknown type');
  return { type, hash: Uint8Array.from(bytes.slice(1)) };
}

export function isBchAddress(address: string): boolean {
  try { decodeCashAddr(address); return true; } catch { return false; }
}

/** The address as this wallet writes it everywhere: lower case with the bitcoincash: prefix. */
export function normalBchAddress(address: string): string {
  const { type, hash } = decodeCashAddr(address);
  return encodeCashAddr(type, hash);
}

const hash160 = (b: Uint8Array) => getBytes(ripemd160(sha256(b)));
const sha256d = (b: Uint8Array) => getBytes(sha256(sha256(b)));
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

export function bchAccountXpub(mnemonic: string): string {
  return HDKey.fromMasterSeed(bip39Seed(mnemonic)).derive(BCH_PATH).publicExtendedKey;
}

export const typicalBchFee = (): bigint => (SIZE_BASE + SIZE_INPUT + SIZE_OUTPUT * 2n) * FEE_SATS_PER_BYTE;

// ---- transactions ----

function join(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
const u64 = (n: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return b; };
const varint = (n: number) => (n < 0xfd ? Uint8Array.from([n]) : join([Uint8Array.from([0xfd]), Uint8Array.from([n & 255, n >> 8])]));
const pushData = (b: Uint8Array) => join([Uint8Array.from([b.length]), b]);
const txidBytes = (txid: string) => Uint8Array.from(Buffer.from(txid, 'hex').reverse());

function outputScript(address: string): Uint8Array {
  const { type, hash } = decodeCashAddr(address);
  return type === 0
    ? join([Uint8Array.from([0x76, 0xa9, 0x14]), hash, Uint8Array.from([0x88, 0xac])])
    : join([Uint8Array.from([0xa9, 0x14]), hash, Uint8Array.from([0x87])]);
}

/** DER, as the network wants it, from the low-S signature SigningKey gives. */
function der(r: string, s: string): Uint8Array {
  const int = (h: string) => {
    let b = getBytes(h);
    let i = 0;
    while (i < b.length - 1 && b[i] === 0 && b[i + 1] < 0x80) i++;
    b = b.slice(i);
    return b[0] >= 0x80 ? join([Uint8Array.from([0]), b]) : b;
  };
  const R = int(r);
  const S = int(s);
  return join([Uint8Array.from([0x30, R.length + S.length + 4, 0x02, R.length]), R, Uint8Array.from([0x02, S.length]), S]);
}

/**
 * Plain key-hash spends, signed the Bitcoin Cash way: SIGHASH_FORKID over the BIP143 digest, which also commits to
 * each input's amount. Returns the raw transaction and its id.
 */
export function signBchDraft(draft: InsightDraft, mnemonic: string): { hex: string; id: string } {
  if (!isBchAddress(draft.to)) throw new Error('The receiving address is not a BCH address.');
  const totalIn = draft.inputs.reduce((s, u) => s + u.value, 0n);
  if (totalIn - draft.amount - draft.change !== draft.fee) throw new Error('The amounts do not add up, so signing was stopped.');
  const account = HDKey.fromMasterSeed(bip39Seed(mnemonic)).derive(BCH_PATH);
  const outputs: { script: Uint8Array; value: bigint }[] = [{ script: outputScript(draft.to), value: draft.amount }];
  if (draft.change > 0n) {
    const change = account.deriveChild(1).deriveChild(draft.changeIndex);
    if (encodeCashAddr(0, hash160(change.publicKey)) !== draft.changeAddress) throw new Error('The change address does not match this wallet\'s keys, so signing was stopped.');
    outputs.push({ script: outputScript(draft.changeAddress), value: draft.change });
  }
  const keys = draft.inputs.map((u) => {
    const child = account.deriveChild(u.chain).deriveChild(u.index);
    if (encodeCashAddr(0, hash160(child.publicKey)) !== u.address) throw new Error('An input address does not match this wallet\'s keys, so signing was stopped.');
    return child;
  });
  const version = u32(2);
  const sequence = u32(0xffffffff);
  const locktime = u32(0);
  const serializedOutputs = join(outputs.map((o) => join([u64(o.value), varint(o.script.length), o.script])));
  const hashPrevouts = sha256d(join(draft.inputs.map((u) => join([txidBytes(u.txid), u32(u.vout)]))));
  const hashSequence = sha256d(join(draft.inputs.map(() => sequence)));
  const hashOutputs = sha256d(serializedOutputs);
  const scriptSigs = draft.inputs.map((u, i) => {
    const pub = keys[i].publicKey as Uint8Array;
    const scriptCode = join([Uint8Array.from([0x76, 0xa9, 0x14]), hash160(pub), Uint8Array.from([0x88, 0xac])]);
    const preimage = join([version, hashPrevouts, hashSequence, txidBytes(u.txid), u32(u.vout), varint(scriptCode.length), scriptCode, u64(u.value), sequence, hashOutputs, locktime, u32(SIGHASH_ALL_FORKID)]);
    const sig = new SigningKey(keys[i].privateKey as Uint8Array).sign(sha256d(preimage));
    return join([pushData(join([der(sig.r, sig.s), Uint8Array.from([SIGHASH_ALL_FORKID])])), pushData(pub)]);
  });
  const raw = join([
    version, varint(draft.inputs.length),
    ...draft.inputs.map((u, i) => join([txidBytes(u.txid), u32(u.vout), varint(scriptSigs[i].length), scriptSigs[i], sequence])),
    varint(outputs.length), serializedOutputs, locktime,
  ]);
  return { hex: hex(raw), id: hex(sha256d(raw).reverse()) };
}

// ---- server ----

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const UNEXPECTED = 'The BCH server gave an unexpected answer.';

/**
 * BitPay's public Bitcore API, asked about one address at a time so no request ties the account's addresses together.
 * Answers are reshaped into the Insight form the shared wallet logic reads.
 */
export class BchClient extends InsightWallet<'BCH'> {
  private readonly account: any;

  constructor(xpub: string, apis: string[], agent?: Agent, timeoutMs = 30_000) {
    super({ symbol: 'BCH', dust: DUST, feePerByte: FEE_SATS_PER_BYTE, base: SIZE_BASE, input: SIZE_INPUT, output: SIZE_OUTPUT, sign: signBchDraft, gapReceive: GAP_RECEIVE, gapChange: GAP_CHANGE, cacheMs: CACHE_MS }, apis, agent, timeoutMs);
    this.account = HDKey.fromExtendedKey(xpub);
  }

  addressAt(chain: number, index: number): string {
    return encodeCashAddr(0, hash160(this.account.deriveChild(chain).deriveChild(index).publicKey));
  }

  protected async get(path: string): Promise<any> {
    let last: unknown;
    for (const base of this.only ? [this.only] : this.apis.filter((b) => !isBlockbook(b))) {
      try { return await getJson(base + path, { agent: this.agent, timeoutMs: this.timeoutMs, headers: { Accept: 'application/json', 'User-Agent': USER_AGENT } }); } catch (e) { last = e; }
    }
    throw last instanceof Error ? last : new Error('Could not reach the BCH server.');
  }

  /** The first server that answers for every address: Bitcore, or a Blockbook (marked "blockbook+") as the backup. */
  protected async lookup(addresses: string[]): Promise<{ utxoRows: any[]; txs: any[] }> {
    let last: unknown;
    for (const base of this.apis) {
      try { return isBlockbook(base) ? await this.lookupBlockbook(base.slice(BLOCKBOOK.length), addresses) : await this.lookupBitcore(base, addresses); } catch (e) { last = e; }
    }
    throw last instanceof Error ? last : new Error('Could not reach the BCH server.');
  }

  private one(base: string, path: string): Promise<any> {
    return getJson(base + path, { agent: this.agent, timeoutMs: this.timeoutMs, headers: { Accept: 'application/json', 'User-Agent': USER_AGENT } });
  }

  /** Blockbook gives coins and transactions per address with their addresses and values in satoshis. */
  private async lookupBlockbook(base: string, addresses: string[]): Promise<{ utxoRows: any[]; txs: any[] }> {
    const utxoRows: any[] = [];
    const txs = new Map<string, any>();
    const sats = (v: unknown) => { const n = Number(v); if (!Number.isSafeInteger(n) || n < 0) throw new Error(UNEXPECTED); return n; };
    for (const address of addresses) {
      const coins = await this.one(base, `/api/v2/utxo/${address}`);
      if (!Array.isArray(coins)) throw new Error(UNEXPECTED);
      for (const c of coins) {
        if (typeof c?.txid !== 'string' || !/^[0-9a-f]{64}$/.test(c.txid) || !Number.isInteger(c.vout)) throw new Error(UNEXPECTED);
        utxoRows.push({ address, txid: c.txid, vout: c.vout, satoshis: sats(c.value), confirmations: Number(c.confirmations) || 0 });
      }
      const info = await this.one(base, `/api/v2/address/${address}?details=txs&pageSize=${HISTORY_TXS}`);
      if (info?.address !== address) throw new Error(UNEXPECTED);
      for (const t of Array.isArray(info.transactions) ? info.transactions : []) {
        if (typeof t?.txid !== 'string' || !/^[0-9a-f]{64}$/.test(t.txid) || txs.has(t.txid)) continue;
        txs.set(t.txid, {
          txid: t.txid, confirmations: Number(t.confirmations) || 0, time: Number(t.blockTime) || undefined,
          vin: (t.vin ?? []).map((i: any) => ({ addr: i.addresses?.[0], value: sats(i.value ?? 0) / 1e8 })),
          vout: (t.vout ?? []).map((o: any) => ({ value: sats(o.value ?? 0) / 1e8, scriptPubKey: { addresses: o.addresses ?? [] } })),
        });
      }
    }
    return { utxoRows, txs: [...txs.values()] };
  }

  private async lookupBitcore(base: string, addresses: string[]): Promise<{ utxoRows: any[]; txs: any[] }> {
    this.only = base;
    try { return await this.lookupBitcoreAll(addresses); } finally { this.only = null; }
  }
  /** While set, requests go to this server alone. */
  private only: string | null = null;

  private async lookupBitcoreAll(addresses: string[]): Promise<{ utxoRows: any[]; txs: any[] }> {
    const tip = Number((await this.get('/block/tip'))?.height);
    if (!Number.isSafeInteger(tip) || tip <= 0) throw new Error(UNEXPECTED);
    const confirmations = (height: number) => (height > 0 ? tip - height + 1 : 0);
    const utxoRows: any[] = [];
    const txs = new Map<string, { txid: string; height: number; vin: any[]; vout: any[] }>();
    const touch = (txid: string, height: number) => {
      const t = txs.get(txid) ?? { txid, height, vin: [], vout: [] };
      if (height > 0 && (t.height <= 0 || height < t.height)) t.height = height;
      txs.set(txid, t);
      return t;
    };
    for (const address of addresses) {
      // Their coins carry the address without the prefix.
      const bare = address.slice(PREFIX.length + 1);
      const coins = await this.get(`/address/${bare}/txs?limit=1000`);
      if (!Array.isArray(coins)) throw new Error(UNEXPECTED);
      for (const c of coins) {
        if (typeof c?.mintTxid !== 'string' || !/^[0-9a-f]{64}$/.test(c.mintTxid) || !Number.isInteger(c.mintIndex) || !Number.isSafeInteger(c.value) || c.value <= 0) throw new Error(UNEXPECTED);
        if (c.address !== bare && c.address !== address) throw new Error(UNEXPECTED);
        const height = Number(c.mintHeight);
        touch(c.mintTxid, height).vout.push({ value: c.value / 1e8, scriptPubKey: { addresses: [address] } });
        const spent = typeof c.spentTxid === 'string' && /^[0-9a-f]{64}$/.test(c.spentTxid);
        if (spent) touch(c.spentTxid, Number(c.spentHeight)).vin.push({ addr: address, value: c.value / 1e8 });
        else utxoRows.push({ address, txid: c.mintTxid, vout: c.mintIndex, satoshis: c.value, confirmations: confirmations(height) });
      }
    }
    // Times need a request per transaction, so only the newest few get one.
    const list = [...txs.values()].sort((a, b) => (b.height <= 0 ? Infinity : b.height) - (a.height <= 0 ? Infinity : a.height));
    const out: any[] = [];
    for (const [i, t] of list.entries()) {
      let time: number | undefined;
      if (i < HISTORY_TXS) {
        try { const d = await this.get(`/tx/${t.txid}`); time = Date.parse(d?.blockTimeNormalized ?? d?.blockTime ?? '') / 1000 || undefined; } catch { /* no time, still listed */ }
      }
      out.push({ txid: t.txid, confirmations: confirmations(t.height), time, vin: t.vin, vout: t.vout });
    }
    return { utxoRows, txs: out };
  }

  protected async broadcast(base: string, raw: string, id: string): Promise<void> {
    if (isBlockbook(base)) {
      const got = await blockbookSend(base, raw, { agent: this.agent, timeoutMs: this.timeoutMs });
      if (got !== id) throw new Error(`The server returned a different transaction ID. Check ${id} on an explorer.`);
      return;
    }
    const res = await requestJson(`${base}/tx/send`, { method: 'POST', body: { rawTx: raw }, agent: this.agent, timeoutMs: this.timeoutMs });
    if (res.status >= 400) throw new Error(String(res.body?.message ?? res.body?.error ?? res.body ?? res.status).slice(0, 200));
    if (res.body?.txid !== id) throw new Error(`The server returned a different transaction ID. Check ${id} on an explorer.`);
    await wait(0);
  }
}
