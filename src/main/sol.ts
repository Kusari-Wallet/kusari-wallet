import type { Agent } from 'node:http';
import { computeHmac, getBytes, sha256, toUtf8Bytes } from 'ethers';
import { requestJson } from './request';
import { formatAmount } from './amount';

const { mnemonicToSeedSync } = require('@scure/bip39');
const { ed25519 } = require('@noble/curves/ed25519.js');
const { base58 } = require('@scure/base');

// The path Phantom and Solflare use, so this seed shows the same address there. Must never change.
export const SOL_PATH = [44, 501, 0, 0];
export const SOL_FEE = 5_000n; // lamports, one signature
export const SOL_RENT_MINIMUM = 890_880n; // what an empty account needs to exist
const SYSTEM_PROGRAM = new Uint8Array(32);
export const SOL_USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const SYSTEM_ID = '11111111111111111111111111111111';
export type SplAsset = 'USDTS' | 'USDCS' | 'JUP' | 'RAY';
export interface SplToken { asset: SplAsset; mint: string; decimals: number; symbol: string; dust: bigint }
// Classic SPL tokens (the original Token program), each checked against Trust Wallet's and the issuers' own lists.
export const SPL_TOKENS: Record<SplAsset, SplToken> = {
  USDTS: { asset: 'USDTS', mint: SOL_USDT_MINT, decimals: 6, symbol: 'USDT', dust: 10_000n },
  USDCS: { asset: 'USDCS', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6, symbol: 'USDC', dust: 10_000n },
  JUP: { asset: 'JUP', mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', decimals: 6, symbol: 'JUP', dust: 10_000n },
  RAY: { asset: 'RAY', mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', decimals: 6, symbol: 'RAY', dust: 10_000n },
};
const TOKEN_ACCOUNT_SIZE = 165;
const CACHE_MS = 60_000;
const HISTORY_LIMIT = 15;

export interface SolDraft { to: string; amount: bigint; fee: bigint }
/** `create` means the receiver has no account for the token yet, so this transaction opens one and pays its deposit. */
export interface SolUsdtDraft { to: string; toAccount: string; create: boolean; amount: bigint; fee: bigint; asset?: SplAsset }

/** SLIP-0010: on this curve every step is hardened. */
function deriveSecret(mnemonic: string): Uint8Array {
  const step = (key: Uint8Array, data: Uint8Array) => getBytes(computeHmac('sha512', key, data));
  let node = step(toUtf8Bytes('ed25519 seed'), mnemonicToSeedSync(mnemonic));
  for (const part of SOL_PATH) {
    const data = new Uint8Array(37);
    data.set(node.slice(0, 32), 1);
    new DataView(data.buffer).setUint32(33, (part | 0x80000000) >>> 0);
    node = step(node.slice(32), data);
  }
  return node.slice(0, 32);
}

export function solAddress(mnemonic: string): string {
  return base58.encode(ed25519.getPublicKey(deriveSecret(mnemonic)));
}

export function isSolAddress(address: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return false;
  try {
    const raw: Uint8Array = base58.decode(address);
    return raw.length === 32 && raw.some((b) => b !== 0); // all zeros is the system program, which can't hold coins for anyone
  } catch { return false; }
}

const compact = (n: number) => Uint8Array.from(n < 128 ? [n] : [(n & 127) | 128, n >> 7]);
function join(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

interface Meta { key: string; signer: boolean; writable: boolean }
interface Instruction { program: string; accounts: Meta[]; data: Uint8Array }

/** A legacy message: accounts sorted the way the runtime expects, the fee payer first. */
export function compileMessage(payer: string, instructions: Instruction[], recentBlockhash: string): Uint8Array {
  const blockhash: Uint8Array = base58.decode(recentBlockhash);
  if (blockhash.length !== 32) throw new Error('The server gave an unexpected answer.');
  const metas = new Map<string, Meta>([[payer, { key: payer, signer: true, writable: true }]]);
  const add = (m: Meta) => {
    const known = metas.get(m.key);
    metas.set(m.key, known ? { key: m.key, signer: known.signer || m.signer, writable: known.writable || m.writable } : { ...m });
  };
  for (const ix of instructions) { ix.accounts.forEach(add); add({ key: ix.program, signer: false, writable: false }); }
  const rank = (m: Meta) => (m.signer ? (m.writable ? 0 : 1) : (m.writable ? 2 : 3));
  const keys = [...metas.values()].sort((x, y) => (x.key === payer ? -1 : y.key === payer ? 1 : rank(x) - rank(y)));
  const index = (k: string) => keys.findIndex((m) => m.key === k);
  const header = Uint8Array.from([keys.filter((m) => m.signer).length, keys.filter((m) => m.signer && !m.writable).length, keys.filter((m) => !m.signer && !m.writable).length]);
  return join([
    header,
    compact(keys.length), ...keys.map((m) => base58.decode(m.key) as Uint8Array),
    blockhash,
    compact(instructions.length),
    ...instructions.map((ix) => join([Uint8Array.from([index(ix.program)]), compact(ix.accounts.length), Uint8Array.from(ix.accounts.map((m) => index(m.key))), compact(ix.data.length), ix.data])),
  ]);
}

function signMessage(secret: Uint8Array, message: Uint8Array): { base64: string; id: string } {
  const signature: Uint8Array = ed25519.sign(message, secret);
  const raw = join([compact(1), signature, message]);
  return { base64: btoa(String.fromCharCode(...raw)), id: base58.encode(signature) };
}

function onCurve(key: Uint8Array): boolean {
  // Solana accepts any encoding that decompresses to a point, including the few non-canonical ones.
  try { ed25519.Point.fromBytes(key, true); return true; } catch { return false; }
}

/** The account a wallet holds a token in, as every Solana wallet works it out. */
export function tokenAccountOf(owner: string, mint = SOL_USDT_MINT): string {
  const seeds = [base58.decode(owner), base58.decode(TOKEN_PROGRAM), base58.decode(mint)] as Uint8Array[];
  for (let bump = 255; bump >= 0; bump--) {
    const hash = getBytes(sha256(join([...seeds, Uint8Array.from([bump]), base58.decode(ATA_PROGRAM), toUtf8Bytes('ProgramDerivedAddress')])));
    if (!onCurve(hash)) return base58.encode(hash);
  }
  throw new Error('No token account address exists for this wallet.');
}

/** A legacy message with one System Program transfer. Returns the signed transaction and its id. */
export function signSolTransfer(mnemonic: string, to: string, lamports: bigint, recentBlockhash: string): { base64: string; id: string } {
  if (!isSolAddress(to)) throw new Error('The receiving address is not a SOL address.');
  if (lamports <= 0n) throw new Error('The amount must be more than zero.');
  const secret = deriveSecret(mnemonic);
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true); // Transfer
  view.setBigUint64(4, lamports, true);
  const me = base58.encode(ed25519.getPublicKey(secret));
  return signMessage(secret, compileMessage(me, [{ program: SYSTEM_ID, accounts: [{ key: me, signer: true, writable: true }, { key: to, signer: false, writable: true }], data }], recentBlockhash));
}

/** A token from this wallet's token account, opening the receiver's first when it has none. */
export function signSolUsdtTransfer(mnemonic: string, draft: SolUsdtDraft, recentBlockhash: string): { base64: string; id: string } {
  const token = SPL_TOKENS[draft.asset ?? 'USDTS'];
  if (!isSolAddress(draft.to)) throw new Error('The receiving address is not a SOL address.');
  if (draft.amount <= 0n) throw new Error('The amount must be more than zero.');
  if (draft.toAccount !== tokenAccountOf(draft.to, token.mint)) throw new Error('The receiving token account does not match the address.');
  const secret = deriveSecret(mnemonic);
  const me = base58.encode(ed25519.getPublicKey(secret));
  const instructions: Instruction[] = [];
  if (draft.create) {
    instructions.push({
      program: ATA_PROGRAM,
      accounts: [
        { key: me, signer: true, writable: true }, { key: draft.toAccount, signer: false, writable: true }, { key: draft.to, signer: false, writable: false },
        { key: token.mint, signer: false, writable: false }, { key: SYSTEM_ID, signer: false, writable: false }, { key: TOKEN_PROGRAM, signer: false, writable: false },
      ],
      data: Uint8Array.from([1]), // CreateIdempotent: does nothing if someone opened it in the meantime
    });
  }
  const data = new Uint8Array(10);
  data[0] = 12; // TransferChecked, which also checks the mint and decimals
  new DataView(data.buffer).setBigUint64(1, draft.amount, true);
  data[9] = token.decimals;
  instructions.push({
    program: TOKEN_PROGRAM,
    accounts: [
      { key: tokenAccountOf(me, token.mint), signer: false, writable: true }, { key: token.mint, signer: false, writable: false },
      { key: draft.toAccount, signer: false, writable: true }, { key: me, signer: true, writable: false },
    ],
    data,
  });
  return signMessage(secret, compileMessage(me, instructions, recentBlockhash));
}

export class SolClient {
  private cache: { at: number; lamports: bigint } | null = null;
  private tokenCache = new Map<SplAsset, { at: number; amount: bigint }>();
  constructor(readonly address: string, private readonly rpcs: string[], private readonly agent?: Agent, private readonly timeoutMs = 30_000) {}

  get receiveAddress(): string { return this.address; }

  private async rpc(method: string, params: unknown[]): Promise<any> {
    let last: unknown;
    for (const url of this.rpcs) {
      try {
        const res = await requestJson(url, { method: 'POST', body: { jsonrpc: '2.0', id: 1, method, params }, agent: this.agent, timeoutMs: this.timeoutMs });
        if (res.status === 429 || res.status === 403) throw new Error(`Request failed with status code ${res.status}`);
        if (res.status >= 400 && !res.body?.error) throw new Error(`Server error (${res.status})`);
        if (res.body?.error) {
          const e = new Error(String(res.body.error.message ?? 'The server refused this.').slice(0, 200));
          (e as any).final = true; // Another server would say the same.
          throw e;
        }
        return res.body?.result;
      } catch (e) {
        if ((e as any).final) throw e;
        last = e;
      }
    }
    throw last instanceof Error ? last : new Error('Could not reach the SOL server.');
  }

  private async lamports(account: string): Promise<bigint> {
    const r = await this.rpc('getBalance', [account, { commitment: 'confirmed' }]);
    if (!Number.isSafeInteger(r?.value)) throw new Error('The SOL server gave an unexpected answer.');
    return BigInt(r.value);
  }

  async getBalance(): Promise<{ total: bigint; spendable: bigint }> {
    if (!this.cache || Date.now() - this.cache.at > CACHE_MS) this.cache = { at: Date.now(), lamports: await this.lamports(this.address) };
    return { total: this.cache.lamports, spendable: this.cache.lamports };
  }

  async draft(to: string, amount: bigint | 'max'): Promise<SolDraft> {
    this.cache = null;
    const balance = (await this.getBalance()).spendable;
    const value = amount === 'max' ? balance - SOL_FEE : amount;
    if (value <= 0n) throw new Error('No SOL left to send after the fee.');
    if (value + SOL_FEE > balance) throw new Error('Not enough SOL to cover the amount and fee.');
    const left = balance - value - SOL_FEE;
    if (left > 0n && left < SOL_RENT_MINIMUM) throw new Error(`Solana accounts must keep at least ${formatAmount(SOL_RENT_MINIMUM, 9)} SOL or be emptied. Send less, or send the maximum.`);
    if (value < SOL_RENT_MINIMUM && (await this.lamports(to)) === 0n) throw new Error(`This address has no SOL yet, so it needs at least ${formatAmount(SOL_RENT_MINIMUM, 9)} SOL to start.`);
    return { to, amount: value, fee: SOL_FEE };
  }

  async send(draft: SolDraft, mnemonic: string): Promise<string> {
    const latest = await this.rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    const blockhash = latest?.value?.blockhash;
    if (typeof blockhash !== 'string') throw new Error('The SOL server gave an unexpected answer.');
    const { base64, id } = signSolTransfer(mnemonic, draft.to, draft.amount, blockhash);
    const answer = await this.rpc('sendTransaction', [base64, { encoding: 'base64', preflightCommitment: 'confirmed' }]);
    if (answer !== id) throw new Error(`The server returned a different transaction ID. Check ${id} on an explorer.`);
    this.cache = null;
    return id;
  }

  private async tokenIn(account: string, token: SplToken): Promise<bigint> {
    const r = await this.rpc('getTokenAccountsByOwner', [account, { mint: token.mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    if (!Array.isArray(r?.value)) throw new Error('The SOL server gave an unexpected answer.');
    // Only the standard account is spent from and shown, the one every wallet sends to.
    const mine = tokenAccountOf(account, token.mint);
    const row = r.value.find((v: any) => v?.pubkey === mine);
    if (!row) return 0n;
    const info = row.account?.data?.parsed?.info;
    const amount = info?.tokenAmount?.amount;
    if (info?.mint !== token.mint || info?.owner !== account || typeof amount !== 'string' || !/^\d+$/.test(amount)) throw new Error('The SOL server gave an unexpected answer.');
    return BigInt(amount);
  }

  async getUsdtBalance(asset: SplAsset = 'USDTS'): Promise<bigint> {
    const c = this.tokenCache.get(asset);
    if (c && Date.now() - c.at <= CACHE_MS) return c.amount;
    const amount = await this.tokenIn(this.address, SPL_TOKENS[asset]);
    this.tokenCache.set(asset, { at: Date.now(), amount });
    return amount;
  }

  async draftUsdt(to: string, amount: bigint | 'max', asset: SplAsset = 'USDTS'): Promise<SolUsdtDraft> {
    const token = SPL_TOKENS[asset];
    if (!isSolAddress(to)) throw new Error('Not a Solana address.');
    if (to === this.address || to === tokenAccountOf(this.address, token.mint)) throw new Error('You cannot send to your own address.');
    this.tokenCache.delete(asset);
    this.cache = null;
    const [held, sol, target] = await Promise.all([this.getUsdtBalance(asset), this.getBalance(), this.rpc('getAccountInfo', [to, { encoding: 'base64', commitment: 'confirmed' }])]);
    // Sending to a token account would open another account under it that nobody can ever spend from.
    const owner = target?.value?.owner;
    if (owner === TOKEN_PROGRAM || owner === TOKEN_2022_PROGRAM) throw new Error('This is a token account, not a wallet address. Ask for the Solana wallet address.');
    const value = amount === 'max' ? held : amount;
    if (value <= 0n) throw new Error(`No ${token.symbol} to send.`);
    if (value > held) throw new Error(`Not enough ${token.symbol}.`);
    const toAccount = tokenAccountOf(to, token.mint);
    const existing = (await this.rpc('getAccountInfo', [toAccount, { encoding: 'jsonParsed', commitment: 'confirmed' }]))?.value;
    if (existing) {
      const info = existing.data?.parsed?.info;
      if (existing.owner !== TOKEN_PROGRAM || info?.mint !== token.mint || info?.owner !== to) throw new Error(`The receiver's ${token.symbol} account looks wrong. Nothing was sent.`);
    }
    let fee = SOL_FEE;
    if (!existing) {
      const rent = await this.rpc('getMinimumBalanceForRentExemption', [TOKEN_ACCOUNT_SIZE]);
      if (!Number.isSafeInteger(rent) || rent <= 0 || rent > 10_000_000) throw new Error('The SOL server gave an unexpected answer.');
      fee += BigInt(rent);
    }
    if (sol.spendable === 0n) throw new Error(`No SOL for the fee. Sending ${token.symbol} on Solana needs a little SOL at this address.`);
    if (sol.spendable < fee) {
      throw new Error(existing ? `Not enough SOL for the fee. This send needs ${formatAmount(fee, 9)} SOL.` : `Not enough SOL for the fee. This send needs ${formatAmount(fee, 9)} SOL, because the receiver has no ${token.symbol} account yet and this opens one.`);
    }
    const left = sol.spendable - fee;
    if (left > 0n && left < SOL_RENT_MINIMUM) throw new Error(`Solana accounts must keep at least ${formatAmount(SOL_RENT_MINIMUM, 9)} SOL. Add a little SOL first.`);
    return { to, toAccount, create: !existing, amount: value, fee, asset };
  }

  async sendUsdt(draft: SolUsdtDraft, mnemonic: string): Promise<string> {
    const latest = await this.rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    const blockhash = latest?.value?.blockhash;
    if (typeof blockhash !== 'string') throw new Error('The SOL server gave an unexpected answer.');
    const { base64, id } = signSolUsdtTransfer(mnemonic, draft, blockhash);
    const answer = await this.rpc('sendTransaction', [base64, { encoding: 'base64', preflightCommitment: 'confirmed' }]);
    if (answer !== id) throw new Error(`The server returned a different transaction ID. Check ${id} on an explorer.`);
    this.cache = null;
    this.tokenCache.delete(draft.asset ?? 'USDTS');
    return id;
  }

  async getUsdtHistory(asset: SplAsset = 'USDTS') {
    const token = SPL_TOKENS[asset];
    const account = tokenAccountOf(this.address, token.mint);
    const list: any[] = await this.rpc('getSignaturesForAddress', [account, { limit: HISTORY_LIMIT }]);
    const rows = (Array.isArray(list) ? list : []).filter((s) => !s.err && typeof s.signature === 'string');
    const held = (balances: any[] | undefined) => {
      const b = (balances ?? []).find((x: any) => x?.mint === token.mint && x?.owner === this.address);
      return BigInt(/^\d+$/.test(String(b?.uiTokenAmount?.amount)) ? b.uiTokenAmount.amount : 0);
    };
    const items = await Promise.all(rows.map(async (s) => {
      const tx = await this.rpc('getTransaction', [s.signature, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]).catch(() => null);
      if (!tx?.meta) return null;
      const net = held(tx.meta.postTokenBalances) - held(tx.meta.preTokenBalances);
      if (net === 0n) return null;
      return {
        asset, hash: String(s.signature), direction: net > 0n ? 'in' as const : 'out' as const,
        amount: formatAmount(net < 0n ? -net : net, token.decimals), counterparty: '',
        timestamp: Number(s.blockTime ?? Date.now() / 1000) * 1000,
        status: s.confirmationStatus === 'finalized' || s.confirmationStatus === 'confirmed' ? 'confirmed' as const : 'pending' as const,
        dust: net > 0n && net < token.dust,
      };
    }));
    return items.filter((i): i is NonNullable<typeof i> => i !== null);
  }

  async getHistory() {
    const list: any[] = await this.rpc('getSignaturesForAddress', [this.address, { limit: HISTORY_LIMIT }]);
    const rows = (Array.isArray(list) ? list : []).filter((s) => !s.err && typeof s.signature === 'string');
    const items = await Promise.all(rows.map(async (s) => {
      const tx = await this.rpc('getTransaction', [s.signature, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]).catch(() => null);
      const keys: string[] = tx?.transaction?.message?.accountKeys ?? [];
      const me = keys.indexOf(this.address);
      if (me < 0 || !tx?.meta) return null;
      const net = BigInt(tx.meta.postBalances?.[me] ?? 0) - BigInt(tx.meta.preBalances?.[me] ?? 0);
      if (net === 0n) return null;
      return {
        asset: 'SOL' as const, hash: String(s.signature), direction: net > 0n ? 'in' as const : 'out' as const,
        amount: formatAmount(net < 0n ? -net : net, 9), counterparty: '',
        timestamp: Number(s.blockTime ?? Date.now() / 1000) * 1000,
        status: s.confirmationStatus === 'finalized' || s.confirmationStatus === 'confirmed' ? 'confirmed' as const : 'pending' as const,
        dust: net > 0n && net < 1_000n,
      };
    }));
    return items.filter((i): i is NonNullable<typeof i> => i !== null);
  }
}
