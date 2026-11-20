// XRP on the XRP Ledger. The account is secp256k1 at m/44'/144'/0'/0/0 (BIP44, as Ledger and Trust Wallet derive
// it), so the same 12 words show the same r-address there. Must never change. Payments are serialized in the
// ledger's binary format and signed here (checked byte for byte against ripple-binary-codec and ripple-keypairs
// in tests/xrp.test.js); public rippled servers only relay them.
import type { Agent } from 'node:http';
import { bip39Seed } from './seed';
import { requestJson } from './request';
import { formatAmount } from './amount';

const { HDKey } = require('@scure/bip32');
const { secp256k1 } = require('@noble/curves/secp256k1.js');
const { sha256, sha512 } = require('@noble/hashes/sha2.js');
const { ripemd160 } = require('@noble/hashes/legacy.js');
const { base58xrp } = require('@scure/base');

export const XRP_PATH = "m/44'/144'/0'/0/0";
const DROPS = 1_000_000n;
const CACHE_MS = 30_000;
/** What an account must keep while it exists (the ledger's base reserve, 1 XRP since December 2024). */
export const XRP_BASE_RESERVE_FALLBACK = 1_000_000n;

export interface XrpDraft { to: string; tag?: number; amount: bigint; fee: bigint; sequence: number; lastLedger: number }

function keyOf(mnemonic: string) {
  const node = HDKey.fromMasterSeed(bip39Seed(mnemonic)).derive(XRP_PATH);
  return { priv: node.privateKey as Uint8Array, pub: node.publicKey as Uint8Array };
}

function join(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();

/** Base58 with the ledger's alphabet, a version byte and a 4-byte double-SHA-256 checksum. */
function check(version: number, payload: Uint8Array): string {
  const body = join([Uint8Array.of(version), payload]);
  return base58xrp.encode(join([body, sha256(sha256(body)).slice(0, 4)]));
}
function uncheck(text: string): Uint8Array | null {
  try {
    const raw: Uint8Array = base58xrp.decode(text);
    if (raw.length !== 25 || raw[0] !== 0) return null;
    const body = raw.slice(0, 21);
    const sum = sha256(sha256(body)).slice(0, 4);
    return sum.every((b: number, i: number) => b === raw[21 + i]) ? body.slice(1) : null;
  } catch { return null; }
}

export const xrpAddressOf = (pub: Uint8Array): string => check(0, ripemd160(sha256(pub)));
export function xrpAddress(mnemonic: string): string { return xrpAddressOf(keyOf(mnemonic).pub); }
export function isXrpAddress(address: string): boolean { return /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(address) && uncheck(address) !== null; }

// ---- the ledger's binary format, just what a Payment needs ----
// Fields go in order of (type code, field code); each starts with its header: type << 4 | field when both < 16.
const fieldId = (type: number, field: number) => Uint8Array.of((type << 4) | field);
const u16 = (type: number, field: number, v: number) => { const b = new Uint8Array(3); b.set(fieldId(type, field)); new DataView(b.buffer).setUint16(1, v); return b; };
const u32 = (field: number, v: number) => { const b = new Uint8Array(5); b.set(fieldId(2, field)); new DataView(b.buffer).setUint32(1, v >>> 0); return b; };
/** A native amount: 64 bits, top bit 0 (XRP), next bit 1 (positive), then drops. */
const drops = (field: number, v: bigint) => { const b = new Uint8Array(9); b.set(fieldId(6, field)); new DataView(b.buffer).setBigUint64(1, v | 0x4000000000000000n); return b; };
const vl = (n: number) => { if (n > 192) throw new Error('Field too long.'); return Uint8Array.of(n); };
const blob = (field: number, data: Uint8Array) => join([fieldId(7, field), vl(data.length), data]);
const account = (field: number, id: Uint8Array) => join([fieldId(8, field), vl(20), id]);

/** The Payment in canonical field order; with a signature for the blob, without it for signing. */
export function serializePayment(from: { pub: Uint8Array; address: string }, d: XrpDraft, signature?: Uint8Array): Uint8Array {
  const src = uncheck(from.address);
  const dst = uncheck(d.to);
  if (!src || !dst) throw new Error('Not an XRP address.');
  return join([
    u16(1, 2, 0), // TransactionType: Payment
    u32(2, 0x80000000), // Flags: tfFullyCanonicalSig
    u32(4, d.sequence),
    ...(d.tag !== undefined ? [u32(14, d.tag)] : []),
    join([fieldId(2, 0), Uint8Array.of(27), (() => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, d.lastLedger); return b; })()]), // LastLedgerSequence: field 27
    drops(1, d.amount), // Amount
    drops(8, d.fee), // Fee
    blob(3, from.pub), // SigningPubKey
    ...(signature ? [blob(4, signature)] : []), // TxnSignature
    account(1, src), // Account
    account(3, dst), // Destination
  ]);
}

const half = (data: Uint8Array) => sha512(data).slice(0, 32);
const SIGN_PREFIX = Uint8Array.of(0x53, 0x54, 0x58, 0x00); // "STX\0"
const ID_PREFIX = Uint8Array.of(0x54, 0x58, 0x4e, 0x00); // "TXN\0"

export function signXrpPayment(mnemonic: string, d: XrpDraft): { blob: string; hash: string } {
  if (!isXrpAddress(d.to)) throw new Error('Not an XRP address.');
  if (d.amount <= 0n) throw new Error('The amount must be more than zero.');
  if (d.tag !== undefined && !(Number.isInteger(d.tag) && d.tag >= 0 && d.tag <= 0xffffffff)) throw new Error('The destination tag must be a whole number up to 4294967295.');
  const { priv, pub } = keyOf(mnemonic);
  const from = { pub, address: xrpAddressOf(pub) };
  const digest = half(join([SIGN_PREFIX, serializePayment(from, d)]));
  const sig = secp256k1.sign(digest, priv, { lowS: true, prehash: false, format: 'der' }) as Uint8Array;
  const signed = serializePayment(from, d, sig);
  return { blob: hex(signed), hash: hex(half(join([ID_PREFIX, signed]))) };
}

// ---- the network ----

const UNEXPECTED = 'The XRP server gave an unexpected answer.';

export class XrpClient {
  private cache: { at: number; total: bigint; spendable: bigint } | null = null;
  constructor(readonly address: string, private readonly servers: string[], private readonly agent?: Agent, private readonly timeoutMs = 20_000) {}
  get receiveAddress(): string { return this.address; }

  private async rpc(method: string, params: Record<string, unknown> = {}): Promise<any> {
    let last: unknown;
    for (const url of this.servers) {
      try {
        const res = await requestJson(url, { method: 'POST', body: { method, params: [params] }, agent: this.agent, timeoutMs: this.timeoutMs });
        if (res.status >= 500 || res.status === 429) throw new Error(`Server error (${res.status})`);
        const r = res.body?.result;
        if (!r) throw new Error(UNEXPECTED);
        if (r.status === 'error') {
          if (r.error === 'actNotFound') return { notFound: true };
          const e = new Error(String(r.error_message ?? r.error ?? 'The server refused this.').slice(0, 200));
          (e as any).final = true;
          throw e;
        }
        return r;
      } catch (e) { if ((e as any).final) throw e; last = e; }
    }
    throw last instanceof Error ? last : new Error('Could not reach an XRP server.');
  }

  private async reserves(): Promise<{ base: bigint; owner: bigint }> {
    const r = await this.rpc('server_state');
    const l = r?.state?.validated_ledger;
    const base = BigInt(Number(l?.reserve_base ?? XRP_BASE_RESERVE_FALLBACK));
    const owner = BigInt(Number(l?.reserve_inc ?? 200_000));
    return { base, owner };
  }

  /** total is what the account holds; spendable leaves out the reserve the ledger keeps. */
  async getBalance(): Promise<{ total: bigint; spendable: bigint }> {
    if (!this.cache || Date.now() - this.cache.at > CACHE_MS) {
      const r = await this.rpc('account_info', { account: this.address, ledger_index: 'validated' });
      if (r?.notFound) this.cache = { at: Date.now(), total: 0n, spendable: 0n };
      else {
        const d = r?.account_data;
        if (typeof d?.Balance !== 'string' || !/^\d+$/.test(d.Balance)) throw new Error(UNEXPECTED);
        const total = BigInt(d.Balance);
        const { base, owner } = await this.reserves();
        const keep = base + owner * BigInt(Number(d.OwnerCount ?? 0));
        this.cache = { at: Date.now(), total, spendable: total > keep ? total - keep : 0n };
      }
    }
    return { total: this.cache.total, spendable: this.cache.spendable };
  }

  async draft(to: string, amount: bigint | 'max', tagInput?: string): Promise<XrpDraft> {
    const dest = to.trim();
    if (!isXrpAddress(dest)) throw new Error('Not an XRP address. XRP addresses start with r.');
    if (dest === this.address) throw new Error('You cannot send to your own address.');
    const tag = tagInput?.trim() ? Number(tagInput.trim()) : undefined;
    if (tag !== undefined && !(/^\d+$/.test(tagInput!.trim()) && tag <= 0xffffffff)) throw new Error('The destination tag must be a whole number up to 4294967295.');
    this.cache = null;
    const [{ spendable }, info, fee, current, target] = await Promise.all([
      this.getBalance(),
      this.rpc('account_info', { account: this.address, ledger_index: 'current' }),
      this.rpc('fee'),
      this.rpc('ledger_current'),
      this.rpc('account_info', { account: dest, ledger_index: 'validated' }),
    ]);
    if (info?.notFound) throw new Error('This account has never received XRP, so there is nothing to send yet.');
    const sequence = Number(info?.account_data?.Sequence);
    const ledger = Number(current?.ledger_current_index);
    const open = BigInt(Number(fee?.drops?.open_ledger_fee ?? 12));
    if (!Number.isInteger(sequence) || !Number.isInteger(ledger)) throw new Error(UNEXPECTED);
    const flat = open < 12n ? 12n : open;
    if (flat > 100_000n) throw new Error('The fee is abnormally high, so this was stopped.');
    const value = amount === 'max' ? spendable - flat : amount;
    if (value <= 0n) throw new Error('No XRP left to send after the fee and the reserve the account must keep.');
    if (value + flat > spendable) throw new Error(`Not enough XRP. An account always keeps a reserve, so up to ${formatAmount(spendable > flat ? spendable - flat : 0n, 6)} XRP can be sent.`);
    // A new account only comes into being with at least the reserve.
    if (target?.notFound) {
      const { base } = await this.reserves();
      if (value < base) throw new Error(`This address has no XRP yet. The first payment to it must be at least ${formatAmount(base, 6)} XRP.`);
    }
    return { to: dest, ...(tag !== undefined ? { tag } : {}), amount: value, fee: flat, sequence, lastLedger: ledger + 20 };
  }

  async send(draft: XrpDraft, mnemonic: string): Promise<string> {
    if (xrpAddress(mnemonic) !== this.address) throw new Error('This wallet\'s seed does not match the XRP account.');
    const { blob, hash } = signXrpPayment(mnemonic, draft);
    const r = await this.rpc('submit', { tx_blob: blob });
    const code = String(r?.engine_result ?? '');
    if (r?.tx_json?.hash && String(r.tx_json.hash).toUpperCase() !== hash) throw new Error(`The server returned a different transaction ID. Check ${hash} on an explorer.`);
    if (!/^(tes|terQUEUED)/.test(code)) throw new Error(`Send rejected: ${code} ${String(r?.engine_result_message ?? '').slice(0, 160)}`);
    this.cache = null;
    return hash;
  }

  async getHistory() {
    const r = await this.rpc('account_tx', { account: this.address, limit: 20, ledger_index_min: -1, ledger_index_max: -1 });
    const rows: any[] = Array.isArray(r?.transactions) ? r.transactions : [];
    const items = [];
    for (const row of rows) {
      const tx = row?.tx ?? row?.tx_json;
      if (tx?.TransactionType !== 'Payment') continue;
      const delivered = row?.meta?.delivered_amount ?? tx.Amount;
      if (typeof delivered !== 'string') continue; // an issued currency, not XRP
      const incoming = tx.Destination === this.address;
      const hash = String(tx.hash ?? row.hash ?? '');
      if (!/^[0-9A-F]{64}$/i.test(hash)) continue;
      items.push({
        asset: 'XRP' as const, hash, direction: incoming ? 'in' as const : 'out' as const,
        amount: formatAmount(BigInt(delivered), 6), counterparty: String(incoming ? tx.Account : tx.Destination),
        timestamp: (Number(tx.date ?? 0) + 946684800) * 1000 || Date.now(),
        status: row?.meta?.TransactionResult === 'tesSUCCESS' ? 'confirmed' as const : 'failed' as const,
        dust: incoming && BigInt(delivered) < 10_000n,
      });
    }
    return items;
  }
}

export const XRP_DROPS = DROPS;
