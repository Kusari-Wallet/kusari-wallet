// GRAM (formerly Toncoin) on TON, and USDT on TON (a jetton). The key is ed25519 at m/44'/607'/0' (SLIP-0010, as
// Trust Wallet derives it from 12 words) in a v4r2 wallet contract, so the same words show the same address there.
// Must never change. Messages are built and signed here with @ton/core; toncenter only relays them. The wallet
// contract is deployed by its first send.
import type { Agent } from 'node:http';
import { computeHmac, getBytes, toUtf8Bytes } from 'ethers';
import { bip39Seed } from './seed';
import { requestJson } from './request';
import { formatAmount } from './amount';

const { ed25519 } = require('@noble/curves/ed25519.js');
const { Address, beginCell, external, internal, storeMessage, toNano, Cell, SendMode } = require('@ton/core');
const { WalletContractV4 } = require('@ton/ton');

export const TON_PATH = [44, 607, 0];
export const TON_USDT_MASTER = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';
export type TonAsset = 'GRAM' | 'USDTT';
/** Reserved for the network fee of a plain transfer (it is usually well under this). */
export const TON_FEE = 10_000_000n; // 0.01 GRAM
/** Sent with a jetton transfer to pay its contracts' fees; what isn't used comes back. */
const JETTON_GAS = 50_000_000n; // 0.05 GRAM
const FORWARD = 1n; // nanoton, so the receiver (an exchange, say) gets the transfer notification and its comment
const CACHE_MS = 30_000;

export interface TonDraft { asset: TonAsset; to: string; amount: bigint; fee: bigint; seqno: number; comment?: string; bounce: boolean; jettonWallet?: string }

function deriveSecret(mnemonic: string): Uint8Array {
  const step = (key: Uint8Array, data: Uint8Array) => getBytes(computeHmac('sha512', key, data));
  let node = step(toUtf8Bytes('ed25519 seed'), bip39Seed(mnemonic));
  for (const part of TON_PATH) {
    const data = new Uint8Array(37);
    data.set(node.slice(0, 32), 1);
    new DataView(data.buffer).setUint32(33, (part | 0x80000000) >>> 0);
    node = step(node.slice(32), data);
  }
  return node.slice(0, 32);
}

const walletOf = (publicKey: Uint8Array) => WalletContractV4.create({ workchain: 0, publicKey: Buffer.from(publicKey) });
export function tonPublicKey(mnemonic: string): Uint8Array { return ed25519.getPublicKey(deriveSecret(mnemonic)); }
/** The wallet's address as wallets show it for receiving: non-bounceable (UQ…). */
export function tonAddressOf(publicKey: Uint8Array): string { return walletOf(publicKey).address.toString({ bounceable: false, urlSafe: true }); }
export function tonAddress(mnemonic: string): string { return tonAddressOf(tonPublicKey(mnemonic)); }

export function isTonAddress(text: string): boolean {
  const t = text.trim();
  if (!/^[A-Za-z0-9_-]{48}$/.test(t) && !/^-?[01]:[0-9a-fA-F]{64}$/.test(t)) return false;
  try { Address.parse(t); return true; } catch { return false; }
}
/** Friendly addresses carry whether to bounce; raw ones (0:…) bounce, as the address format's default. */
function bounceOf(text: string): boolean {
  try { return Address.isFriendly(text) ? Address.parseFriendly(text).isBounceable : true; } catch { return true; }
}

const commentCell = (text: string) => beginCell().storeUint(0, 32).storeStringTail(text).endCell();

/** The external message that carries one transfer from this wallet, as a base64 BOC. */
export function signTonTransfer(mnemonic: string, d: TonDraft, ownJettonWallet?: string): { boc: string; hash: string } {
  if (!isTonAddress(d.to)) throw new Error('Not a TON address.');
  if (d.amount <= 0n) throw new Error('The amount must be more than zero.');
  if (d.comment && Buffer.byteLength(d.comment) > 120) throw new Error('The comment is too long.');
  const secret = deriveSecret(mnemonic);
  const pub = ed25519.getPublicKey(secret);
  const wallet = walletOf(pub);
  const secretKey = Buffer.concat([Buffer.from(secret), Buffer.from(pub)]); // the 64-byte form TON's signing takes
  let message;
  if (d.asset === 'GRAM') {
    message = internal({ to: Address.parse(d.to), value: d.amount, bounce: d.bounce, body: d.comment ? commentCell(d.comment) : undefined });
  } else {
    if (!ownJettonWallet) throw new Error('The USDT wallet address is missing.');
    const me = wallet.address;
    // TEP-74 transfer: op, query id, amount, destination, where the excess goes, no custom payload, forward amount,
    // and the comment as the forward payload (inline).
    const fwd = d.comment ? commentCell(d.comment) : null;
    const body = beginCell().storeUint(0x0f8a7ea5, 32).storeUint(BigInt(Date.now()), 64).storeCoins(d.amount)
      .storeAddress(Address.parse(d.to)).storeAddress(me).storeBit(0).storeCoins(FORWARD)
      .storeMaybeRef(fwd).endCell();
    message = internal({ to: Address.parse(ownJettonWallet), value: JETTON_GAS, bounce: true, body });
  }
  const transfer = wallet.createTransfer({ seqno: d.seqno, secretKey, messages: [message], sendMode: SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS });
  const ext = external({ to: wallet.address, init: d.seqno === 0 ? wallet.init : undefined, body: transfer });
  const cell = beginCell().store(storeMessage(ext)).endCell();
  return { boc: cell.toBoc().toString('base64'), hash: cell.hash().toString('hex') };
}

// ---- the network ----

const UNEXPECTED = 'The TON server gave an unexpected answer.';

export class TonClient {
  private cache = new Map<TonAsset, { at: number; total: bigint; spendable: bigint }>();
  private jettonWallet: string | null = null;
  readonly address: string;
  constructor(private readonly publicKey: Uint8Array, private readonly apis: string[], private readonly agent?: Agent, private readonly timeoutMs = 20_000) {
    this.address = tonAddressOf(publicKey);
  }
  get receiveAddress(): string { return this.address; }

  private async v2(method: string, params: Record<string, unknown>): Promise<any> {
    let last: unknown;
    for (const base of this.apis) {
      try {
        const res = await requestJson(`${base}/api/v2/jsonRPC`, { method: 'POST', body: { jsonrpc: '2.0', id: 1, method, params }, agent: this.agent, timeoutMs: this.timeoutMs });
        if (res.status === 429 || res.status >= 500) throw new Error(`Server error (${res.status})`);
        if (res.body?.ok === false || res.body?.error) {
          const e = new Error(String(res.body?.error?.message ?? res.body?.error ?? res.body?.result ?? 'The server refused this.').slice(0, 200));
          if (res.status < 500 && res.status !== 429) (e as any).final = true;
          throw e;
        }
        return res.body?.result;
      } catch (e) { if ((e as any).final) throw e; last = e; }
    }
    throw last instanceof Error ? last : new Error('Could not reach a TON server.');
  }
  private async v3(path: string): Promise<any> {
    let last: unknown;
    for (const base of this.apis) {
      try {
        const res = await requestJson(`${base}/api/v3${path}`, { agent: this.agent, timeoutMs: this.timeoutMs });
        if (res.status >= 400) throw new Error(`Server error (${res.status})`);
        return res.body;
      } catch (e) { last = e; }
    }
    throw last instanceof Error ? last : new Error('Could not reach a TON server.');
  }

  private async gram(): Promise<bigint> {
    const r = await this.v2('getAddressBalance', { address: this.address });
    if (typeof r !== 'string' || !/^\d+$/.test(r)) throw new Error(UNEXPECTED);
    return BigInt(r);
  }
  private async seqno(): Promise<number> {
    const r = await this.v2('getWalletInformation', { address: this.address });
    if (r?.account_state === 'uninitialized' || r?.wallet === false) return 0;
    const n = Number(r?.seqno);
    if (!Number.isInteger(n) || n < 0) throw new Error(UNEXPECTED);
    return n;
  }
  /** This wallet's USDT jetton wallet, from the master contract (get_wallet_address). */
  private async usdtWallet(): Promise<string> {
    if (this.jettonWallet) return this.jettonWallet;
    const owner = beginCell().storeAddress(Address.parse(this.address)).endCell().toBoc().toString('base64');
    const r = await this.v2('runGetMethod', { address: TON_USDT_MASTER, method: 'get_wallet_address', stack: [['tvm.Slice', owner]] });
    const cellB64 = r?.stack?.[0]?.[1]?.bytes;
    if (r?.exit_code !== 0 || typeof cellB64 !== 'string') throw new Error(UNEXPECTED);
    const addr = Cell.fromBase64(cellB64).beginParse().loadAddress();
    this.jettonWallet = addr.toString({ bounceable: true, urlSafe: true });
    return this.jettonWallet!;
  }
  private async usdt(): Promise<bigint> {
    const jw = await this.usdtWallet();
    const r = await this.v3(`/jetton/wallets?address=${encodeURIComponent(jw)}&limit=1`);
    const row = r?.jetton_wallets?.[0];
    if (!row) return 0n; // not deployed yet: nothing received
    if (typeof row.balance !== 'string' || !/^\d+$/.test(row.balance)) throw new Error(UNEXPECTED);
    return BigInt(row.balance);
  }

  async getBalance(asset: TonAsset = 'GRAM'): Promise<{ total: bigint; spendable: bigint }> {
    const c = this.cache.get(asset);
    if (c && Date.now() - c.at < CACHE_MS) return { total: c.total, spendable: c.spendable };
    const total = asset === 'GRAM' ? await this.gram() : await this.usdt();
    this.cache.set(asset, { at: Date.now(), total, spendable: total });
    return { total, spendable: total };
  }

  async draft(asset: TonAsset, to: string, amount: bigint | 'max', comment?: string): Promise<TonDraft> {
    const dest = to.trim();
    if (!isTonAddress(dest)) throw new Error('Not a TON address.');
    if (Address.parse(dest).equals(Address.parse(this.address))) throw new Error('You cannot send to your own address.');
    const memo = comment?.trim() || undefined;
    if (memo && Buffer.byteLength(memo) > 120) throw new Error('The comment is too long.');
    this.cache.clear();
    const [gram, seqno] = await Promise.all([this.gram(), this.seqno()]);
    if (asset === 'GRAM') {
      const value = amount === 'max' ? gram - TON_FEE : amount;
      if (value <= 0n) throw new Error('No GRAM left to send after the fee.');
      if (value + TON_FEE > gram) throw new Error(`Not enough GRAM. Up to ${formatAmount(gram > TON_FEE ? gram - TON_FEE : 0n, 9)} GRAM can be sent with the fee.`);
      return { asset, to: dest, amount: value, fee: TON_FEE, seqno, ...(memo ? { comment: memo } : {}), bounce: bounceOf(dest) };
    }
    const held = await this.usdt();
    const value = amount === 'max' ? held : amount;
    if (value <= 0n || value > held) throw new Error(`Not enough USDT. You have ${formatAmount(held, 6)} USDT.`);
    const fee = JETTON_GAS + TON_FEE;
    if (gram < fee) throw new Error(`Sending USDT on TON needs about ${formatAmount(fee, 9)} GRAM at this address for the fee (most of it comes back).`);
    return { asset, to: dest, amount: value, fee, seqno, ...(memo ? { comment: memo } : {}), bounce: true, jettonWallet: await this.usdtWallet() };
  }

  async send(d: TonDraft, mnemonic: string): Promise<string> {
    if (tonAddress(mnemonic) !== this.address) throw new Error('This wallet\'s seed does not match the TON address.');
    const { boc, hash } = signTonTransfer(mnemonic, d, d.jettonWallet);
    await this.v2('sendBoc', { boc });
    this.cache.clear();
    return hash;
  }

  async getHistory(asset: TonAsset = 'GRAM') {
    const items: any[] = [];
    if (asset === 'GRAM') {
      const r = await this.v3(`/transactions?account=${encodeURIComponent(this.address)}&limit=20&sort=desc`);
      for (const tx of Array.isArray(r?.transactions) ? r.transactions : []) {
        const hash = String(tx?.hash ?? '');
        const at = Number(tx?.now ?? 0) * 1000 || Date.now();
        const inMsg = tx?.in_msg;
        if (inMsg?.source && BigInt(String(inMsg.value ?? '0')) > 0n) {
          items.push({ asset: 'GRAM' as const, hash, direction: 'in' as const, amount: formatAmount(BigInt(inMsg.value), 9), counterparty: String(inMsg.source), timestamp: at, status: 'confirmed' as const, dust: BigInt(inMsg.value) < 1_000_000n });
        }
        for (const m of Array.isArray(tx?.out_msgs) ? tx.out_msgs : []) {
          if (!m?.destination || !/^\d+$/.test(String(m.value ?? ''))) continue;
          items.push({ asset: 'GRAM' as const, hash, direction: 'out' as const, amount: formatAmount(BigInt(m.value), 9), counterparty: String(m.destination), timestamp: at, status: 'confirmed' as const, dust: false });
        }
      }
    } else {
      const r = await this.v3(`/jetton/transfers?owner_address=${encodeURIComponent(this.address)}&jetton_master=${TON_USDT_MASTER}&limit=20&sort=desc`);
      const me = Address.parse(this.address);
      for (const t of Array.isArray(r?.jetton_transfers) ? r.jetton_transfers : []) {
        if (!/^\d+$/.test(String(t?.amount ?? ''))) continue;
        let incoming = false;
        try { incoming = Address.parse(String(t.destination)).equals(me); } catch { continue; }
        items.push({ asset: 'USDTT' as const, hash: String(t.transaction_hash ?? ''), direction: incoming ? 'in' as const : 'out' as const, amount: formatAmount(BigInt(t.amount), 6), counterparty: String(incoming ? t.source : t.destination), timestamp: Number(t.transaction_now ?? 0) * 1000 || Date.now(), status: t.transaction_aborted ? 'failed' as const : 'confirmed' as const, dust: incoming && BigInt(t.amount) < 10_000n });
      }
    }
    return items;
  }
}
