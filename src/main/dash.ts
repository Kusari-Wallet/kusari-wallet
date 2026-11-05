import type { Agent } from 'node:http';
import { InsightDraft, InsightWallet } from './insight';

const { HDKey } = require('@scure/bip32');
const { mnemonicToSeedSync } = require('@scure/bip39');
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
  return HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic)).derive(DASH_PATH).publicExtendedKey;
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
  if (!isDashAddress(draft.to)) throw new Error('받는 주소가 DASH 주소가 아니야.');
  const totalIn = draft.inputs.reduce((s, u) => s + u.value, 0n);
  if (totalIn - draft.amount - draft.change !== draft.fee) throw new Error('금액 계산이 맞지 않아서 서명을 중단했어.');
  const account = HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic)).derive(DASH_PATH);
  const tx = new btc.Transaction({ allowLegacyWitnessUtxo: true, version: 2 });
  const keys: Uint8Array[] = [];
  for (const u of draft.inputs) {
    const child = account.deriveChild(u.chain).deriveChild(u.index);
    const pay = btc.p2pkh(child.publicKey, DASH_NET);
    if (pay.address !== u.address) throw new Error('입력 주소가 내 키와 맞지 않아서 서명을 중단했어.');
    tx.addInput({ txid: u.txid, index: u.vout, witnessUtxo: { script: pay.script, amount: u.value } });
    keys.push(child.privateKey);
  }
  tx.addOutputAddress(draft.to, draft.amount, DASH_NET);
  if (draft.change > 0n) {
    const change = account.deriveChild(1).deriveChild(draft.changeIndex);
    if (btc.p2pkh(change.publicKey, DASH_NET).address !== draft.changeAddress) throw new Error('잔돈 주소가 내 키와 맞지 않아서 서명을 중단했어.');
    tx.addOutputAddress(draft.changeAddress, draft.change, DASH_NET);
  }
  keys.forEach((k, i) => tx.signIdx(k, i));
  tx.finalize();
  return { hex: tx.hex, id: tx.id };
}
