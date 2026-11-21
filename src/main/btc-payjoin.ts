// Payjoin for this wallet's Bitcoin (taproot, BIP86): paying a Payjoin link, and asking to be paid by one.
import { HDKey as HDKeyType } from '@scure/bip32';
import { bip39Seed } from './seed';
import { BTC_PATH, V0_CHAIN, signBtcDraft, type BtcDraft } from './btc';
import { isSilentAddress } from './btc-silent';
import {
  buildProposal, checkProposal, errorReply, signProposal, originalPsbt, receiveOriginal, receivePoll, receiveReply, sendV1, sendV2, senderParams,
  type OhttpKeys, type PayjoinTarget, type Post, type SenderRules,
} from './payjoin';
import { newPrivateKey, publicKeyOf } from './hpke';

const { HDKey } = require('@scure/bip32') as { HDKey: typeof HDKeyType };
const btc = require('@scure/btc-signer');
const xOnly = (pub: Uint8Array): Uint8Array => pub.slice(1);
export const btcScriptOf = (address: string): Uint8Array => btc.OutScript.encode(btc.Address(btc.NETWORK).decode(address));
export const btcAddressOf = (script: Uint8Array): string => btc.Address(btc.NETWORK).encode(btc.OutScript.decode(script));

/** Directories that hold Payjoin messages (BIP77). The first one answering is used for new requests. */
export const PAYJOIN_DIRECTORIES = ['https://payjo.in', 'https://lets.payjo.in'];

export interface PayjoinResult { hex: string; id: string; draft: BtcDraft; payjoin: boolean; problem?: string; /** For logs and tests, never the screen. */ detail?: string }

const WELL_KNOWN: Record<string, string> = {
  unavailable: 'The recipient could not take part in a Payjoin right now.',
  'not-enough-money': 'The recipient had no coin to add.',
  'version-unsupported': 'The recipient uses another Payjoin version.',
  'original-psbt-rejected': 'The recipient turned the payment down for Payjoin.',
};
/** Only the well-known error codes reach the screen (BIP78): any other text from the other side could mislead. */
export function payjoinProblem(e: unknown): string {
  const m = (e as Error)?.message ?? '';
  const code = m.startsWith('payjoin:') ? m.slice(8) : '';
  if (code) return WELL_KNOWN[code] ?? 'The recipient could not take part in a Payjoin.';
  if (/^The receiver/.test(m)) return 'The recipient\'s Payjoin proposal didn\'t pass this wallet\'s checks, so it wasn\'t signed.';
  return /^This Payjoin link has expired|^No Payjoin/.test(m) ? m : 'The Payjoin recipient could not be reached.';
}

/**
 * Pays a Payjoin link. The ordinary signed payment is made first; the recipient may add a coin of theirs. When
 * anything goes wrong or takes longer than `waitMs`, the ordinary payment is what goes out, so the payment is
 * always made.
 */
export async function payjoinPay(o: { draft: BtcDraft; mnemonic: string; target: PayjoinTarget; post: Post; waitMs: number }): Promise<PayjoinResult> {
  const { draft } = o;
  const signed = signBtcDraft(draft, o.mnemonic);
  const plain: PayjoinResult = { ...signed, draft, payjoin: false };
  if (draft.inputs.some((u) => u.chain === V0_CHAIN) || isSilentAddress(draft.to)) return { ...plain, problem: 'Payjoin was skipped for this payment.' };
  try {
    const prevouts = draft.inputs.map((u) => ({ script: btcScriptOf(u.address), amount: u.value }));
    const original = originalPsbt(signed.hex, prevouts);
    const tx = btc.Transaction.fromRaw(Buffer.from(signed.hex, 'hex'));
    const rate = Number(draft.fee) / tx.vsize;
    const changeIndex = draft.change > 0n ? (draft.changeFirst ? 0 : 1) : null;
    const rules: SenderRules = {
      original, payScript: btcScriptOf(draft.to), changeIndex,
      // What one more taproot coin costs at this fee rate, the most the change gives toward the recipient's coin.
      maxFeeContribution: changeIndex === null ? 0n : BigInt(Math.ceil(rate * 58)),
      minFeeRate: Math.max(1, Math.floor(rate * 85) / 100),
    };
    const deadline = Date.now() + o.waitMs;
    let proposal: Uint8Array | null;
    if (o.target.kind === 'v1') proposal = await sendV1(o.post, o.target.url, original, senderParams(rules, 1), o.waitMs);
    else proposal = await sendV2(o.post, o.target, original, senderParams(rules, 2), deadline);
    if (!proposal) return { ...plain, problem: 'The recipient did not answer in time.' };
    const checked = checkProposal(proposal, rules);
    const root = HDKey.fromMasterSeed(bip39Seed(o.mnemonic));
    const account = root.derive(BTC_PATH);
    const done = signProposal(checked, rules, (t, idx, k) => {
      const u = draft.inputs[k];
      const child = account.deriveChild(u.chain).deriveChild(u.index);
      t.updateInput(idx, { tapInternalKey: xOnly(child.publicKey!) }, true);
      if (!t.signIdx(child.privateKey!, idx)) throw new Error('This wallet could not sign its coin in the Payjoin.');
    });
    // The wallet's own view of the send: what it spends is the same, the change may have paid toward the fee.
    const adjusted: BtcDraft = { ...draft, change: draft.change - checked.contribution, fee: draft.fee + checked.contribution };
    return { hex: done.hex, id: done.id, draft: adjusted, payjoin: checked.added > 0 };
  } catch (e) {
    return { ...plain, problem: payjoinProblem(e), detail: (e as Error)?.message };
  }
}

// ---- receiving ----

export interface ReceiveSession {
  id: string; address: string; amount?: string; directory: string; ohttp: OhttpKeys;
  receiverSk: Uint8Array; expires: number; uri: string;
  /** The coin this wallet adds, and its key, held only in memory while the request runs. */
  coin: { txid: string; vout: number; amount: bigint; chain: number; index: number; key: Uint8Array; script: Uint8Array; tapInternalKey: Uint8Array };
  status: 'waiting' | 'answered' | 'failed' | 'expired';
  /** The sender's ordinary payment, broadcast later if the Payjoin one never shows. */
  original?: { hex: string; at: number };
}

export function newReceiverKey(): { sk: Uint8Array; pub: Uint8Array } { const sk = newPrivateKey(); return { sk, pub: publicKeyOf(sk) }; }

/** The key of one of this wallet's taproot coins, to add to a Payjoin. */
export function coinKey(mnemonic: string, chain: number, index: number): { key: Uint8Array; tapInternalKey: Uint8Array; script: Uint8Array } {
  const child = HDKey.fromMasterSeed(bip39Seed(mnemonic)).derive(BTC_PATH).deriveChild(chain).deriveChild(index);
  const pay = btc.p2tr(xOnly(child.publicKey!));
  return { key: child.privateKey!, tapInternalKey: pay.tapInternalKey, script: pay.script };
}

/**
 * One look at the mailbox: an original that came in is checked, this wallet's coin added and signed, and the
 * proposal left for the sender. Returns what happened.
 */
export async function receiveStep(post: Post, s: ReceiveSession, isOurs: (script: Uint8Array) => boolean, seenBefore: (outpoints: string[]) => boolean): Promise<'none' | 'answered' | 'refused'> {
  const got = await receivePoll(post, s);
  if (!got) return 'none';
  let reply: Uint8Array;
  let result: 'answered' | 'refused' = 'answered';
  try {
    const seen = receiveOriginal(got.body, btcScriptOf(s.address), isOurs);
    // A coin offered before means someone is probing which coins this wallet has (BIP78).
    if (seenBefore(seen.outpoints)) throw new Error('original-psbt-rejected: inputs seen before');
    s.original = { hex: seen.hex, at: Date.now() };
    const c = s.coin;
    reply = buildProposal(seen, { txid: c.txid, vout: c.vout, amount: c.amount, script: c.script, tapInternalKey: c.tapInternalKey }, (t, idx) => {
      if (!t.signIdx(c.key, idx)) throw new Error('unavailable');
    }).psbt;
  } catch (e) {
    const code = String((e as Error).message).split(':')[0];
    reply = errorReply(['original-psbt-rejected', 'not-enough-money', 'unavailable'].includes(code) ? code : 'unavailable');
    result = 'refused';
  }
  await receiveReply(post, s, got.replyPub, reply);
  return result;
}
