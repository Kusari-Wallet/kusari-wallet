import { bip39Seed } from './seed';
import type { Agent } from 'node:http';
import { InsightDraft, InsightUtxo, InsightWallet } from './insight';

const { HDKey } = require('@scure/bip32');
const btc = require('@scure/btc-signer');

export const DASH_PATH = "m/44'/5'/0'";
export const DASH_NET = { bech32: 'dash', pubKeyHash: 0x4c, scriptHash: 0x10, wif: 0xcc };
const FEE_DUFFS_PER_BYTE = 2n; // double the default relay rate
const DUST = 5_460n;
const SIZE_BASE = 10n;
const SIZE_INPUT = 148n;
const SIZE_OUTPUT = 34n;

export type DashDraft = InsightDraft;

export function dashAccountXpub(mnemonic: string): string {
  return HDKey.fromMasterSeed(bip39Seed(mnemonic)).derive(DASH_PATH).publicExtendedKey;
}

export function isDashAddress(address: string): boolean {
  if (!/^[X7][1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) return false;
  try { btc.Address(DASH_NET).decode(address); return true; } catch { return false; }
}

export const typicalDashFee = (): bigint => (SIZE_BASE + SIZE_INPUT + SIZE_OUTPUT * 2n) * FEE_DUFFS_PER_BYTE;

export class DashClient extends InsightWallet<'DASH'> {
  private readonly account: any;
  constructor(xpub: string, apis: string[], agent?: Agent, timeoutMs = 30_000) {
    super({ symbol: 'DASH', dust: DUST, feePerByte: FEE_DUFFS_PER_BYTE, base: SIZE_BASE, input: SIZE_INPUT, output: SIZE_OUTPUT, sign: signDashDraft }, apis, agent, timeoutMs);
    this.account = HDKey.fromExtendedKey(xpub);
  }
  addressAt(chain: number, index: number): string {
    return btc.p2pkh(this.account.deriveChild(chain).deriveChild(index).publicKey, DASH_NET).address;
  }
}

/** Plain P2PKH with Bitcoin's legacy signature hash, which Dash shares. */
export function signDashDraft(draft: InsightDraft, mnemonic: string): { hex: string; id: string } {
  if (!isDashAddress(draft.to)) throw new Error('The receiving address is not a DASH address.');
  const totalIn = draft.inputs.reduce((s, u) => s + u.value, 0n);
  if (totalIn - draft.amount - draft.change !== draft.fee) throw new Error('The amounts do not add up, so signing was stopped.');
  const account = HDKey.fromMasterSeed(bip39Seed(mnemonic)).derive(DASH_PATH);
  const tx = new btc.Transaction({ allowLegacyWitnessUtxo: true, version: 2 });
  const keys: Uint8Array[] = [];
  for (const u of draft.inputs) {
    const child = account.deriveChild(u.chain).deriveChild(u.index);
    const pay = btc.p2pkh(child.publicKey, DASH_NET);
    if (pay.address !== u.address) throw new Error('An input address does not match this wallet\'s keys, so signing was stopped.');
    tx.addInput({ txid: u.txid, index: u.vout, witnessUtxo: { script: pay.script, amount: u.value } });
    keys.push(child.privateKey);
  }
  tx.addOutputAddress(draft.to, draft.amount, DASH_NET);
  if (draft.change > 0n) {
    const change = account.deriveChild(1).deriveChild(draft.changeIndex);
    if (btc.p2pkh(change.publicKey, DASH_NET).address !== draft.changeAddress) throw new Error('The change address does not match this wallet\'s keys, so signing was stopped.');
    tx.addOutputAddress(draft.changeAddress, draft.change, DASH_NET);
  }
  keys.forEach((k, i) => tx.signIdx(k, i));
  tx.finalize();
  return { hex: tx.hex, id: tx.id };
}

/**
 * Several outputs from this wallet's own coins, with change, for splitting coins into the CoinJoin account.
 * Checked like a single payment: the sums, and every input and the change belonging to this wallet.
 */
export function signDashOutputs(inputs: InsightUtxo[], outputs: { address: string; value: bigint }[], change: { address: string; index: number; value: bigint } | null, fee: bigint, mnemonic: string): { hex: string; id: string } {
  const totalIn = inputs.reduce((s, u) => s + u.value, 0n);
  const totalOut = outputs.reduce((s, o) => s + o.value, 0n) + (change?.value ?? 0n);
  if (totalIn - totalOut !== fee || fee < 0n) throw new Error('The amounts do not add up, so signing was stopped.');
  if (outputs.some((o) => !isDashAddress(o.address) || o.value < DUST)) throw new Error('An output is not a usable DASH address or amount, so signing was stopped.');
  const account = HDKey.fromMasterSeed(bip39Seed(mnemonic)).derive(DASH_PATH);
  const tx = new btc.Transaction({ allowLegacyWitnessUtxo: true, version: 2 });
  const keys: Uint8Array[] = [];
  for (const u of inputs) {
    const child = account.deriveChild(u.chain).deriveChild(u.index);
    const pay = btc.p2pkh(child.publicKey, DASH_NET);
    if (pay.address !== u.address) throw new Error('An input address does not match this wallet\'s keys, so signing was stopped.');
    tx.addInput({ txid: u.txid, index: u.vout, witnessUtxo: { script: pay.script, amount: u.value } });
    keys.push(child.privateKey);
  }
  for (const o of outputs) tx.addOutputAddress(o.address, o.value, DASH_NET);
  if (change && change.value > 0n) {
    if (btc.p2pkh(account.deriveChild(1).deriveChild(change.index).publicKey, DASH_NET).address !== change.address) throw new Error('The change address does not match this wallet\'s keys, so signing was stopped.');
    tx.addOutputAddress(change.address, change.value, DASH_NET);
  }
  keys.forEach((k, i) => tx.signIdx(k, i));
  tx.finalize();
  return { hex: tx.hex, id: tx.id };
}

export const DASH_DUST = DUST;
export const dashFee = (inputs: number, outputs: number): bigint => (SIZE_BASE + SIZE_INPUT * BigInt(inputs) + SIZE_OUTPUT * BigInt(outputs)) * FEE_DUFFS_PER_BYTE;
