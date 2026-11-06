import type { Agent } from 'node:http';
import { InsightDraft, InsightWallet } from './insight';

// A third-party library whose byte formats are pinned to dcrd but which has had no security audit.
const dcr = require('dcr-ts');

export const DCR_PATH = "m/44'/42'/0'";
const FEE_ATOMS_PER_BYTE = 20n; // twice the default relay rate, which rarely moves on Decred
const DUST = 6_100n;

// Serialized sizes, in bytes: prefix and witness counts plus version, locktime and expiry;
// a prefix input and its witness with a P2PKH signature script; an output paying P2PKH.
const SIZE_BASE = 16n;
const SIZE_INPUT = 166n;
const SIZE_OUTPUT = 36n;

export type DcrDraft = InsightDraft;

const master = (mnemonic: string) => dcr.mnemonicToMasterKey(mnemonic.trim().toLowerCase().split(/\s+/).join(' '), dcr.mainnet);

/** The account's public key: finds addresses, can't spend. */
export function dcrAccount(mnemonic: string): any { return master(mnemonic).derivePath(DCR_PATH).neuter(); }

export function isDcrAddress(address: string): boolean {
  if (!/^Ds[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) return false;
  try { return dcr.isValidAddress(address, dcr.mainnet) && dcr.decodeAddress(address, dcr.mainnet).kind === 'pubkeyhash-ecdsa'; } catch { return false; }
}

export const estimateDcrSize = (inputs: number, outputs: number): bigint => SIZE_BASE + SIZE_INPUT * BigInt(inputs) + SIZE_OUTPUT * BigInt(outputs);
export const typicalDcrFee = (): bigint => estimateDcrSize(1, 2) * FEE_ATOMS_PER_BYTE;

export class DcrClient extends InsightWallet<'DCR'> {
  private readonly receive: any;
  private readonly change: any;
  constructor(account: any, apis: string[], agent?: Agent, timeoutMs = 30_000) {
    super({ symbol: 'DCR', dust: DUST, feePerByte: FEE_ATOMS_PER_BYTE, base: SIZE_BASE, input: SIZE_INPUT, output: SIZE_OUTPUT, sign: signDcrDraft }, apis, agent, timeoutMs);
    this.receive = account.derive(0);
    this.change = account.derive(1);
  }
  addressAt(chain: number, index: number): string { return (chain === 0 ? this.receive : this.change).derive(index).address(); }
}

export function signDcrDraft(draft: DcrDraft, mnemonic: string): { hex: string; id: string } {
  const account = master(mnemonic).derivePath(DCR_PATH);
  const totalIn = draft.inputs.reduce((s, u) => s + u.value, 0n);
  if (totalIn - draft.amount - draft.change !== draft.fee) throw new Error('The amounts do not add up, so signing was stopped.');
  if (!isDcrAddress(draft.to)) throw new Error('The receiving address is not a DCR address.');
  const tx = new dcr.Transaction();
  const signers = draft.inputs.map((u, idx) => {
    const key = account.derive(u.chain).derive(u.index);
    if (key.address() !== u.address) throw new Error('An input address does not match this wallet\'s keys, so signing was stopped.');
    tx.addInput(dcr.outPointFromTxid(u.txid, u.vout), { valueIn: u.value });
    return { idx, subScript: dcr.addressToScript(u.address, dcr.mainnet), privateKey: key.privateKeyBytes() };
  });
  tx.addOutput(draft.amount, dcr.addressToScript(draft.to, dcr.mainnet));
  if (draft.change > 0n) {
    if (account.derive(1).derive(draft.changeIndex).address() !== draft.changeAddress) throw new Error('The change address does not match this wallet\'s keys, so signing was stopped.');
    tx.addOutput(draft.change, dcr.addressToScript(draft.changeAddress, dcr.mainnet));
  }
  dcr.signP2PKHInputs(tx, signers);
  return { hex: Buffer.from(tx.serialize()).toString('hex'), id: tx.txid() };
}
