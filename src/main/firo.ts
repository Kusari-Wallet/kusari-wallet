import type { Agent } from 'node:http';
import { InsightDraft, InsightWallet } from './insight';

const { HDKey } = require('@scure/bip32');
const { mnemonicToSeedSync } = require('@scure/bip39');
const btc = require('@scure/btc-signer');

// Coin type 136 and these prefixes are the ones in Firo's own wallet and chain parameters.
export const FIRO_PATH = "m/44'/136'/0'";
export const FIRO_NET = { bech32: 'firo', pubKeyHash: 82, scriptHash: 7, wif: 210 };
const FEE_SATS_PER_BYTE = 2n; // double the default relay rate of 1 sat per byte
const DUST = 5_460n;
const SIZE_BASE = 10n;
const SIZE_INPUT = 148n;
const SIZE_OUTPUT = 34n;

export type FiroDraft = InsightDraft;

export function firoAccountXpub(mnemonic: string): string {
  return HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic)).derive(FIRO_PATH).publicExtendedKey;
}

export function isFiroAddress(address: string): boolean {
  if (!/^[a3][1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) return false;
  try { btc.Address(FIRO_NET).decode(address); return true; } catch { return false; }
}

export const typicalFiroFee = (): bigint => (SIZE_BASE + SIZE_INPUT + SIZE_OUTPUT * 2n) * FEE_SATS_PER_BYTE;

export class FiroClient extends InsightWallet<'FIRO'> {
  private readonly account: any;
  constructor(xpub: string, apis: string[], agent?: Agent, timeoutMs = 30_000) {
    super({ symbol: 'FIRO', dust: DUST, feePerByte: FEE_SATS_PER_BYTE, base: SIZE_BASE, input: SIZE_INPUT, output: SIZE_OUTPUT, sign: signFiroDraft }, apis, agent, timeoutMs);
    this.account = HDKey.fromExtendedKey(xpub);
  }
  addressAt(chain: number, index: number): string {
    return btc.p2pkh(this.account.deriveChild(chain).deriveChild(index).publicKey, FIRO_NET).address;
  }
}

/** Plain P2PKH, transparent only: this does not make Firo's private Spark transactions. Legacy signature hash, version 1. */
export function signFiroDraft(draft: InsightDraft, mnemonic: string): { hex: string; id: string } {
  if (!isFiroAddress(draft.to)) throw new Error('The receiving address is not a FIRO address.');
  const totalIn = draft.inputs.reduce((s, u) => s + u.value, 0n);
  if (totalIn - draft.amount - draft.change !== draft.fee) throw new Error('The amounts do not add up, so signing was stopped.');
  const account = HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic)).derive(FIRO_PATH);
  const tx = new btc.Transaction({ allowLegacyWitnessUtxo: true, version: 1 });
  const keys: Uint8Array[] = [];
  for (const u of draft.inputs) {
    const child = account.deriveChild(u.chain).deriveChild(u.index);
    const pay = btc.p2pkh(child.publicKey, FIRO_NET);
    if (pay.address !== u.address) throw new Error('An input address does not match this wallet\'s keys, so signing was stopped.');
    tx.addInput({ txid: u.txid, index: u.vout, witnessUtxo: { script: pay.script, amount: u.value } });
    keys.push(child.privateKey);
  }
  tx.addOutputAddress(draft.to, draft.amount, FIRO_NET);
  if (draft.change > 0n) {
    const change = account.deriveChild(1).deriveChild(draft.changeIndex);
    if (btc.p2pkh(change.publicKey, FIRO_NET).address !== draft.changeAddress) throw new Error('The change address does not match this wallet\'s keys, so signing was stopped.');
    tx.addOutputAddress(draft.changeAddress, draft.change, FIRO_NET);
  }
  keys.forEach((k, i) => tx.signIdx(k, i));
  tx.finalize();
  return { hex: tx.hex, id: tx.id };
}
