// Takes part in one WabiSabi coinjoin round with this wallet's coins, the way Wasabi Wallet's client does
// (WalletWasabi, MIT licence): each input and each output request on its own Tor route, at random times, with the
// coordinator's round, inputs and transaction checked before anything is signed.
import { randomBytes, randomInt } from 'node:crypto';
import { Credential, WabiSabiClient } from './credentials';
import { readResponse, requestJson, toHex } from './messages';
import {
  EndRoundState, Phase, RoundState, SCRIPT_TYPE, TxOut, commitment, effectiveFeePerK, effectiveValue, fee, idMatches, inputVsize,
  isBlame, outpointBytes, outputVsize, ownershipProofTaproot, readRound, scriptText, scriptType, signTaprootInput, sortedInputs, sortedOutputs, unsignedTransaction, verifyOwnership,
} from './round';
import { decompose } from './decompose';

/** The coordinator's own error, with its code (WrongPhase, InputBanned, …). */
export class CoordinatorError extends Error {
  constructor(readonly code: string, message: string, readonly data?: any) { super(message); }
}

export interface Transport {
  /** POSTs JSON to /wabisabi/<path> on a Tor route of its own for each identity, and returns the parsed answer. */
  post(path: string, body: unknown, identity: string): Promise<any>;
}

export interface MixCoin { txid: string; vout: number; value: bigint; script: Uint8Array }
export interface MixOptions {
  transport: Transport;
  /** Private key for one of the coins being mixed. */
  keyFor(coin: MixCoin): Uint8Array;
  /** Never-used taproot output scripts for this round's outputs. */
  destinations(count: number): Uint8Array[];
  /** The wallet's identification key (from the seed), for ownership identifiers. */
  idKey: Uint8Array;
  /** Highest mining fee rate accepted, per 1000 vbytes. */
  maxFeePerK: bigint;
  /** Fewest inputs a coinjoin may have before this wallet signs it. */
  minInputs: number;
  network?: string;
  onStatus?(s: MixStatus): void;
  signal?: AbortSignal;
  /** For tests: how long phases wait between status checks, and how random times are spread. */
  pollMs?: number;
  now?: () => number;
  /** How long before input registration ends the last input is sent (Wasabi: a minute). */
  registrationMarginMs?: number;
}
export interface MixStatus { stage: 'waiting' | 'registering' | 'confirming' | 'outputs' | 'signing' | 'done' | 'failed'; roundId?: string; inputs?: number; detail?: string }
/** `outputs`: this wallet's, with their index in the transaction. `all`: every output of the coinjoin. */
export type MixResult = { ok: true; roundId: string; txid: string; outputs: (TxOut & { vout: number })[]; all: TxOut[]; inputs: MixCoin[] } | { ok: false; roundId?: string; reason: string; signed: boolean };

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) return reject(new Error('Stopped.'));
  const t = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, Math.max(0, ms));
  const stop = () => { clearTimeout(t); reject(new Error('Stopped.')); };
  signal?.addEventListener('abort', stop, { once: true });
});
const newIdentity = (kind: string) => `${kind}-${randomBytes(10).toString('hex')}`;
/** Random times in [start, start + span), sorted, as Wasabi spreads its requests. */
function spread(count: number, start: number, span: number): number[] {
  return Array.from({ length: count }, () => start + (span > 0 ? randomInt(Math.max(1, Math.floor(span))) : 0)).sort((a, b) => a - b);
}
const outpointHex = (c: { txid: string; vout: number }) => toHex(outpointBytes(c.txid, c.vout));

interface Alice { coin: MixCoin; id: string; identity: string; amount: Credential[]; vsize: Credential[]; confirmed: boolean; effective: bigint }

export class RoundWatcher {
  private states = new Map<string, RoundState>();
  constructor(private readonly t: Transport, private readonly identity = newIdentity('status')) {}

  async update(): Promise<RoundState[]> {
    const RoundCheckpoints = [...this.states.values()].map((s) => ({ RoundId: s.id, StateId: s.events }));
    const res = await this.t.post('status', { RoundCheckpoints }, this.identity);
    if (!Array.isArray(res?.roundStates)) throw new Error('The coordinator gave an unexpected status.');
    const next = new Map<string, RoundState>();
    for (const r of res.roundStates) {
      try {
        const known = this.states.get(r?.id);
        const isPartial = known && !r.coinjoinState?.Events?.some((e: any) => e?.Type === 'RoundCreated');
        const s = readRound(r, isPartial ? known : undefined);
        if (!idMatches(s)) continue; // a round whose ID doesn't fit its parameters is never trusted
        next.set(s.id, s);
      } catch { /* a round this wallet can't read is skipped */ }
    }
    this.states = next;
    return [...next.values()];
  }
  get(id: string): RoundState | undefined { return this.states.get(id); }
}

/** Why a round can't be used, or null when it can. */
export function unsuitable(r: RoundState, coins: MixCoin[], o: Pick<MixOptions, 'maxFeePerK' | 'network' | 'registrationMarginMs'>, now: number): string | null {
  const p = r.params;
  if (r.phase !== Phase.InputRegistration || isBlame(r)) return 'not registering';
  if (p.network !== (o.network ?? 'Main')) return 'other network';
  if (p.coordinationFee !== 0) return 'charges a coordination fee';
  if (!p.inputTypes.includes(SCRIPT_TYPE.Taproot) || !p.outputTypes.includes(SCRIPT_TYPE.Taproot)) return 'no taproot';
  if (p.feePerK > o.maxFeePerK) return 'mining fee too high';
  if (r.inputRegistrationEnd - now < (o.registrationMarginMs ?? 60_000) * 1.5) return 'registration closing';
  if (p.maxVsizePerAlice < 58 + 43) return 'too little room per input';
  const total = coins.reduce((s, c) => s + c.value, 0n);
  if (total > p.maxAmountCredential) return 'amount too large for the round';
  if (!coins.some((c) => c.value >= p.inputMin && c.value <= p.inputMax && effectiveValue(c, p.feePerK) > 0n)) return 'coins outside the allowed amounts';
  return null;
}

export async function mixOnce(coins: MixCoin[], o: MixOptions): Promise<MixResult> {
  const now = o.now ?? Date.now;
  const poll = o.pollMs ?? 5_000;
  const status = (s: MixStatus) => { try { o.onStatus?.(s); } catch { /* the screen's problem */ } };
  const watcher = new RoundWatcher(o.transport);

  // 1. A round to join.
  let round: RoundState | undefined;
  while (!round) {
    const rounds = await watcher.update().catch(() => [] as RoundState[]);
    round = rounds.filter((r) => unsuitable(r, coins, o, now()) === null).sort((a, b) => b.inputRegistrationEnd - a.inputRegistrationEnd)[0];
    if (!round) { status({ stage: 'waiting', detail: 'no suitable round' }); await sleep(Math.max(poll, 30_000 * (poll / 5_000)), o.signal); }
  }
  const roundId = round.id;
  const p = round.params;
  const mine = coins.filter((c) => c.value >= p.inputMin && c.value <= p.inputMax && effectiveValue(c, p.feePerK) > 0n && scriptType(c.script) === SCRIPT_TYPE.Taproot);
  const commit = commitment(p.coordinationId, roundId);
  const amountClient = () => new WabiSabiClient(round!.amountIssuer, p.maxAmountCredential);
  const vsizeClient = () => new WabiSabiClient(round!.vsizeIssuer, BigInt(p.maxVsizePerAlice));
  const post = async (path: string, body: unknown, identity: string) => o.transport.post(path, body, identity);
  let signedAny = false;
  const fail = (reason: string): MixResult => { status({ stage: 'failed', roundId, detail: reason }); return { ok: false, roundId, reason, signed: signedAny }; };
  const latest = () => watcher.get(roundId);
  const waitPhase = async (want: Phase, until: number): Promise<RoundState | null> => {
    for (;;) {
      const s = await watcher.update().then(() => latest()).catch(() => latest());
      if (!s) return null;
      if (s.phase >= want) return s;
      if (now() > until) return null;
      await sleep(poll, o.signal);
    }
  };

  // 2. Inputs, each on its own route at its own random time, each kept alive until connection confirmation.
  status({ stage: 'registering', roundId, inputs: mine.length });
  const regEnd = round.inputRegistrationEnd - (o.registrationMarginMs ?? 60_000);
  const times = spread(mine.length, now(), regEnd - now());
  const alices: Alice[] = [];
  let phase: Phase = round.phase;
  const ph = (): Phase => phase;
  let watching = true;
  const watch = (async () => {
    while (watching) {
      const s = await watcher.update().then(() => latest()).catch(() => latest());
      phase = s ? s.phase : Phase.Ended;
      if (phase >= Phase.OutputRegistration) return;
      await sleep(poll, o.signal).catch(() => { watching = false; });
    }
  })();

  const confirm = async (a: Alice): Promise<void> => {
    const ac = amountClient(), vc = vsizeClient();
    const realA = ac.request([a.effective], a.amount);
    const realV = vc.request([BigInt(p.maxVsizePerAlice - inputVsize(a.coin.script))], a.vsize);
    const za = ac.zeroRequest(), zv = vc.zeroRequest();
    const res = await post('connection-confirmation', {
      RoundId: roundId, AliceId: a.id,
      ZeroAmountCredentialRequests: requestJson(za.request), RealAmountCredentialRequests: requestJson(realA.request),
      ZeroVsizeCredentialRequests: requestJson(zv.request), RealVsizeCredentialRequests: requestJson(realV.request),
    }, a.identity);
    const zeroA = ac.handle(readResponse(res?.zeroAmountCredentials), za.pending);
    const zeroV = vc.handle(readResponse(res?.zeroVsizeCredentials), zv.pending);
    if (res?.realAmountCredentials && res?.realVsizeCredentials) {
      a.amount = [...ac.handle(readResponse(res.realAmountCredentials), realA.pending), ...zeroA];
      a.vsize = [...vc.handle(readResponse(res.realVsizeCredentials), realV.pending), ...zeroV];
      a.confirmed = true;
    } else {
      a.amount = zeroA;
      a.vsize = zeroV;
    }
  };
  const keepAliveMs = Math.max(poll, p.connectionConfirmationMs / 2);
  const ccDeadline = round.inputRegistrationEnd + p.connectionConfirmationMs + 30_000;
  const runAlice = async (coin: MixCoin, at: number): Promise<void> => {
    await sleep(at - now(), o.signal);
    if (ph() !== Phase.InputRegistration) return;
    const identity = newIdentity('alice');
    const proof = ownershipProofTaproot(o.keyFor(coin), coin.script, o.idKey, commit);
    const ac = amountClient(), vc = vsizeClient();
    const za = ac.zeroRequest(), zv = vc.zeroRequest();
    let a: Alice;
    try {
      const res = await post('input-registration', {
        RoundId: roundId, Input: outpointHex(coin), OwnershipProof: toHex(proof),
        ZeroAmountCredentialRequests: requestJson(za.request), ZeroVsizeCredentialRequests: requestJson(zv.request),
      }, identity);
      if (typeof res?.aliceId !== 'string') throw new Error('The coordinator gave no input ID.');
      a = { coin, id: res.aliceId, identity, amount: ac.handle(readResponse(res.amountCredentials), za.pending), vsize: vc.handle(readResponse(res.vsizeCredentials), zv.pending), confirmed: false, effective: effectiveValue(coin, p.feePerK) };
      alices.push(a);
    } catch { return; } // that coin sits this round out
    status({ stage: 'confirming', roundId, inputs: alices.length });
    let last = now();
    while (!a.confirmed && now() < ccDeadline && !o.signal?.aborted) {
      if (ph() === Phase.ConnectionConfirmation) {
        await confirm(a).catch(() => undefined);
        if (a.confirmed) return;
      } else if (ph() !== Phase.InputRegistration) return;
      else if (now() - last >= keepAliveMs) {
        last = now();
        await confirm(a).catch(() => undefined);
      }
      await sleep(poll, o.signal).catch(() => undefined);
    }
  };
  await Promise.all(mine.map((c, i) => runAlice(c, times[i]).catch(() => undefined)));
  watching = false;
  await watch.catch(() => undefined);
  if (o.signal?.aborted) return fail('Stopped.');
  const confirmed = alices.filter((a) => a.confirmed);
  if (!confirmed.length) return fail('The coordinator did not confirm any input.');

  // 3. Outputs: once every input is known, standard amounts, then credentials reshaped to fit them, all anonymously.
  const atOutputs = await waitPhase(Phase.OutputRegistration, now() + p.connectionConfirmationMs + 60_000);
  if (!atOutputs || atOutputs.phase !== Phase.OutputRegistration) return fail('The round did not reach output registration.');
  status({ stage: 'outputs', roundId, inputs: atOutputs.inputs.length });
  const outStart = now();
  const outSpan = p.outputRegistrationMs - poll;
  const outEnd = outStart + outSpan * 0.8;
  const readyEnd = outStart + outSpan;
  // The coordinator must show this wallet's inputs as registered, and every input with a valid proof for this round.
  for (const a of confirmed) {
    const seen = atOutputs.inputs.find((c) => c.txid === a.coin.txid && c.vout === a.coin.vout);
    if (!seen || seen.value !== a.coin.value || !Buffer.from(seen.script).equals(Buffer.from(a.coin.script))) return fail('The coordinator misreported this wallet\'s inputs.');
  }
  if (atOutputs.inputs.some((c) => !c.proof || !verifyOwnership(c.proof, c.script, commit))) return fail('The coordinator added an input that is not bound to this round.');
  const myEffective = confirmed.reduce((s, a) => s + a.effective, 0n);
  const allEffective = atOutputs.inputs.map((c) => { try { return effectiveValue(c, p.feePerK); } catch { return 0n; } }).filter((v) => v > 0n);
  const vsizeCreds = confirmed.flatMap((a) => a.vsize.filter((c) => c.value > 0n));
  const room = vsizeCreds.reduce((s, c) => s + Math.floor(Number(c.value) / 43) * 43, 0);
  let plan;
  try {
    plan = decompose({ feePerK: p.feePerK, outputMin: p.outputMin, outputMax: p.outputMax, availableVsize: room, mine: myEffective, all: allEffective });
  } catch (e) { return fail((e as Error).message); }
  const scripts = o.destinations(plan.length);
  const outputs: TxOut[] = plan.map((d, i) => ({ value: d.amount, script: scripts[i] }));

  const ac = amountClient(), vc = vsizeClient();
  let zerosA: Credential[] = confirmed.flatMap((a) => a.amount.filter((c) => c.value === 0n));
  let zerosV: Credential[] = confirmed.flatMap((a) => a.vsize.filter((c) => c.value === 0n));
  const takeZero = (pool: Credential[]) => { const z = pool.shift(); if (!z) throw new Error('Ran out of zero credentials.'); return z; };
  const reissue = async (amounts: [bigint, bigint], presentA: Credential[], vsizes: [bigint, bigint], presentV: Credential[]) => {
    const ra = ac.request(amounts, presentA);
    const rv = vc.request(vsizes, presentV);
    const za = ac.zeroRequest(), zv = vc.zeroRequest();
    const res = await post('credential-issuance', {
      RoundId: roundId,
      RealAmountCredentialRequests: requestJson(ra.request), RealVsizeCredentialRequests: requestJson(rv.request),
      ZeroAmountCredentialRequests: requestJson(za.request), ZeroVsizeCredentialsRequests: requestJson(zv.request),
    }, newIdentity('bob'));
    const realA = ac.handle(readResponse(res?.realAmountCredentials), ra.pending);
    const realV = vc.handle(readResponse(res?.realVsizeCredentials), rv.pending);
    zerosA.push(...ac.handle(readResponse(res?.zeroAmountCredentials), za.pending));
    zerosV.push(...vc.handle(readResponse(res?.zeroVsizeCredentials), zv.pending));
    return { realA, realV };
  };
  const registerOutput = async (out: TxOut, amount: Credential, vsize: Credential, at: number) => {
    await sleep(at - now(), o.signal);
    const ra = ac.request([], [amount, takeZero(zerosA)]);
    const rv = vc.request([], [vsize, takeZero(zerosV)]);
    await post('output-registration', { RoundId: roundId, Script: scriptText(out.script), AmountCredentialRequests: requestJson(ra.request), VsizeCredentialRequests: requestJson(rv.request) }, newIdentity('bob'));
  };

  let registered = 0;
  try {
    // Merge the amounts pairwise, in parallel, until one credential holds everything.
    let big = confirmed.map((a) => a.amount.find((c) => c.value > 0n)!).filter(Boolean);
    while (big.length > 1) {
      const pairs: [Credential, Credential][] = [];
      while (big.length >= 2) pairs.push([big.pop()!, big.pop()!]);
      const merged = await Promise.all(pairs.map(async ([x, y]) => (await reissue([x.value + y.value, 0n], [x, y], [0n, 0n], [takeZero(zerosV), takeZero(zerosV)])).realA[0]));
      big = [...big, ...merged];
    }
    let total = big[0];
    // Then carve each output out of it, with a vsize credential that has room for one more output.
    const room43 = vsizeCreds.map((c) => c);
    const times2 = spread(outputs.length, now(), outEnd - now());
    const pending: Promise<void>[] = [];
    for (let i = 0; i < outputs.length; i++) {
      const cost = plan[i].effectiveCost;
      const vi = room43.findIndex((c) => c.value >= 43n);
      if (vi < 0) throw new Error('Out of room for outputs.');
      const v = room43[vi];
      const { realA, realV } = await reissue([cost, total.value - cost], [total, takeZero(zerosA)], [43n, v.value - 43n], [v, takeZero(zerosV)]);
      total = realA[1];
      room43[vi] = realV[1];
      const out = outputs[i];
      pending.push(registerOutput(out, realA[0], realV[0], Math.max(times2[i], now())).then(() => { registered++; }));
    }
    await Promise.all(pending);
  } catch (e) {
    if (o.signal?.aborted) return fail('Stopped.');
    if (!registered) return fail(`Outputs could not be registered: ${(e as Error).message}`);
  }
  // Ready to sign, each input on its own route.
  const readyTimes = spread(confirmed.length, now(), readyEnd - now());
  await Promise.all(confirmed.map(async (a, i) => {
    await sleep(readyTimes[i] - now(), o.signal);
    await post('ready-to-sign', { RoundId: roundId, AliceId: a.id }, a.identity).catch(() => undefined);
  })).catch(() => undefined);

  // 4. Signing, only if the transaction is what this wallet expects.
  const atSigning = await waitPhase(Phase.TransactionSigning, now() + p.outputRegistrationMs + 60_000);
  if (!atSigning || atSigning.phase !== Phase.TransactionSigning || !atSigning.signing) return fail('The round did not reach signing.');
  status({ stage: 'signing', roundId, inputs: atSigning.inputs.length });
  const tx = unsignedTransaction(atSigning);
  const order = sortedInputs(atSigning.inputs);
  const mineIn = confirmed.filter((a) => order.some((c) => c.txid === a.coin.txid && c.vout === a.coin.vout));
  const problems: string[] = [];
  for (const out of outputs) {
    const got = atSigning.outputs.filter((x) => Buffer.from(x.script).equals(Buffer.from(out.script))).reduce((s, x) => s + x.value, 0n);
    if (got < out.value) problems.push('an output of this wallet is missing or short');
  }
  if (mineIn.length !== confirmed.length) problems.push('an input of this wallet is missing');
  const distinct = new Set(order.map((c) => `${c.txid}:${c.vout}`)).size;
  if (distinct !== order.length) problems.push('an input appears twice');
  if (distinct <= mineIn.length) problems.push('no one else is in the transaction');
  if (distinct < o.minInputs) problems.push('too few inputs');
  if (effectiveFeePerK(atSigning) <= p.feePerK * 9n / 10n) problems.push('the coordinator is keeping part of the fee');
  if (atSigning.inputs.some((c) => !c.proof || !verifyOwnership(c.proof, c.script, commit))) problems.push('an input is not bound to this round');
  const inSum = atSigning.inputs.reduce((s, c) => s + c.value, 0n);
  const outSum = atSigning.outputs.reduce((s, x) => s + x.value, 0n);
  if (outSum > inSum) problems.push('the outputs are more than the inputs');
  if (problems.length) return fail(`Not signed: ${problems[0]}.`);

  const signEnd = now() + p.signingMs - 10_000;
  const delay = p.delaySigning ? 50_000 : 0;
  const signTimes = spread(mineIn.length, now() + delay, Math.min(50_000, signEnd - now() - delay));
  await Promise.all(mineIn.map(async (a, i) => {
    const index = order.findIndex((c) => c.txid === a.coin.txid && c.vout === a.coin.vout);
    const witness = signTaprootInput(tx, index, o.keyFor(a.coin));
    await sleep(signTimes[i] - now(), o.signal);
    signedAny = true;
    await post('transaction-signature', { RoundId: roundId, InputIndex: index, Witness: toHex(witness) }, a.identity).catch((e) => {
      if (!(e instanceof CoordinatorError && e.code === 'WitnessAlreadyProvided')) throw e;
    });
  })).catch(() => undefined);

  // 5. The outcome.
  const ended = await waitPhase(Phase.Ended, now() + p.signingMs + 120_000);
  if (!ended || ended.phase !== Phase.Ended) return fail('The round\'s outcome is unknown.');
  if (ended.end !== EndRoundState.TransactionBroadcasted) return fail(ended.end === EndRoundState.NotAllAlicesSign ? 'Someone did not sign.' : 'The round was not completed.');
  status({ stage: 'done', roundId });
  const merged = sortedOutputs(atSigning.outputs);
  const placed = outputs.map((out) => ({ ...out, vout: merged.findIndex((m) => Buffer.from(m.script).equals(Buffer.from(out.script))) }));
  return { ok: true, roundId, txid: tx.id, outputs: placed, all: atSigning.outputs, inputs: mineIn.map((a) => a.coin) };
}

/** The mining fee a round will take from these coins, for showing before mixing. */
export function estimateCost(coins: MixCoin[], feePerK: bigint, outputs = 4): bigint {
  return coins.reduce((s, c) => s + fee(feePerK, inputVsize(c.script)), 0n) + BigInt(outputs) * fee(feePerK, outputVsize(new Uint8Array(34)));
}
