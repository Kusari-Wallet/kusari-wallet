// A stand-in WabiSabi coordinator with one round: real credential issuance and checks, other participants faked.
const { randomBytes } = require('node:crypto');
const btc = require('@scure/btc-signer');
const { secp256k1, schnorr } = require('@noble/curves/secp256k1.js');
const C = require('../dist/main/wabisabi/credentials');
const M = require('../dist/main/wabisabi/messages');
const R = require('../dist/main/wabisabi/round');

const { G, mul, add, sub, eq, randomScalar, pointBytes, internals } = C;
const hex = (b) => Buffer.from(b).toString('hex');
const upper = (b) => hex(b).toUpperCase();

class Issuer {
  constructor(max) {
    this.max = BigInt(max);
    this.width = Math.ceil(Math.log2(Number(max)));
    [this.w, this.wp, this.x0, this.x1, this.ya] = Array.from({ length: 5 }, () => randomScalar());
    this.ip = { Cw: add(mul(this.w, G.Gw), mul(this.wp, G.Gwp)), I: sub(G.GV, add(add(mul(this.x0, G.Gx0), mul(this.x1, G.Gx1)), mul(this.ya, G.Ga))) };
    this.serials = new Set();
    this.balance = 0n;
  }
  handle(json, { zero }) {
    const req = M.readRequest(json);
    const isNull = req.presented.length === 0 && req.requested.every((q) => q.bits.length === 0);
    if (zero !== isNull) throw err('InvalidRequest', 'zero/real mismatch');
    const presentationOnly = !isNull && req.requested.length === 0;
    if (req.requested.length !== (presentationOnly ? 0 : 2)) throw err('CryptoException', 'requested count');
    if (req.presented.length !== (isNull ? 0 : 2)) throw err('CryptoException', 'presented count');
    if (this.balance + req.delta < 0n) throw err('CryptoException', 'negative balance');
    const width = isNull ? 0 : this.width;
    if (req.requested.some((q) => q.bits.length !== width)) throw err('CryptoException', 'bit commitments');
    const serials = req.presented.map((p) => hex(pointBytes(p.S)));
    if (new Set(serials).size !== serials.length || serials.some((s) => this.serials.has(s))) throw err('CryptoException', 'serial reused');
    const statements = [];
    for (const p of req.presented) {
      const Z = sub(p.CV, add(add(add(mul(this.w, G.Gw), mul(this.x0, p.Cx0)), mul(this.x1, p.Cx1)), mul(this.ya, p.Ca)));
      statements.push(internals.showCredentialStatement(p, Z, this.ip));
    }
    for (const q of req.requested) statements.push(internals.rangeProofStatement(q.Ma, q.bits, width));
    if (!isNull) {
      const d = req.delta < 0n ? C.N - (-req.delta) : req.delta;
      const sumCa = internals.sumPoints(req.presented.map((p) => p.Ca));
      const sumMa = internals.sumPoints(req.requested.map((q) => q.Ma));
      statements.push([[sub(add(mul(d, G.Gg), sumCa), sumMa), G.Ga, G.Gh]]);
    }
    const t = C.Transcript.create(`UnifiedRegistration/2/${isNull ? 'True' : 'False'}`);
    if (!internals.verify(t, statements, req.proofs)) throw err('CryptoException', 'invalid proofs');
    serials.forEach((s) => this.serials.add(s));
    this.balance += req.delta;
    const knowledge = [], macs = [];
    for (const q of req.requested) {
      const tt = randomScalar();
      const U = internals.generateU(tt);
      const V = add(add(mul(this.w, G.Gw), mul((this.x0 + this.x1 * tt) % C.N, U)), mul(this.ya, q.Ma));
      const mac = { t: tt, V };
      macs.push(mac);
      knowledge.push({ statement: internals.issuerParamsStatement(this.ip, mac, q.Ma), witness: [this.w, this.wp, this.x0, this.x1, this.ya] });
    }
    const proofs = knowledge.length ? internals.prove(t, knowledge, randomBytes) : [];
    return { response: M.responseJson({ issued: macs, proofs }), delta: req.delta };
  }
}

function err(code, description, data) {
  const e = new Error(description);
  e.coordinator = { type: 'wabisabi-protocol-violation', errorCode: code, description, exceptionData: data ?? { Type: 'EmptyExceptionData' } };
  return e;
}
const span = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 86400)}d ${Math.floor(s / 3600) % 24}h ${Math.floor(s / 60) % 60}m ${s % 60}s`; };

/**
 * opts: utxos (Map "txid:vout" → {value, script}), others (number of fake participants), expectInputs (ours),
 * tamper: { dropOutput, skimFee, badId, foreignProof }.
 */
function mockCoordinator(opts) {
  const feePerK = BigInt(opts.feePerK ?? 2000);
  const amount = new Issuer(opts.maxAmount ?? 2 ** 27);
  const vsize = new Issuer(255);
  const start = new Date(Date.now()).toISOString();
  const params = {
    Network: 'Main', MiningFeeRate: Number(feePerK), CoordinationFeeRate: { Rate: 0.0, PlebsDontPayThreshold: 0 }, MaxSuggestedAmount: Number(amount.max),
    MinInputCountByRound: 3, MaxInputCountByRound: 100, AllowedInputAmounts: { Min: 5000, Max: Number(amount.max) }, AllowedOutputAmounts: { Min: 5000, Max: Number(amount.max) },
    AllowedInputTypes: [4, 7], AllowedOutputTypes: [1, 2, 4, 5, 7],
    StandardInputRegistrationTimeout: span(opts.inputRegMs ?? 10_000), ConnectionConfirmationTimeout: span(opts.ccMs ?? 4_000),
    OutputRegistrationTimeout: span(opts.orMs ?? 12_000), TransactionSigningTimeout: span(opts.tsMs ?? 12_000), BlameInputRegistrationTimeout: '0d 0h 3m 0s',
    MinAmountCredentialValue: 5000, MaxAmountCredentialValue: Number(amount.max), MaxVsizeAllocationPerAlice: 255, CoordinationIdentifier: 'CoinJoinCoordinatorIdentifier',
    DelayTransactionSigning: false, MaxTransactionSize: 100000, MinRelayTxFee: 1000,
  };
  const state = { phase: 0, end: 0, events: [{ Type: 'RoundCreated', RoundParameters: params }], alices: new Map(), outputs: [], ready: new Set(), witnesses: new Map(), log: [], identities: [] };
  const round = { id: '', blameOf: '0'.repeat(64), amountCredentialIssuerParameters: { cw: upper(pointBytes(amount.ip.Cw)), i: upper(pointBytes(amount.ip.I)) }, vsizeCredentialIssuerParameters: { cw: upper(pointBytes(vsize.ip.Cw)), i: upper(pointBytes(vsize.ip.I)) }, inputRegistrationStart: start, inputRegistrationTimeout: params.StandardInputRegistrationTimeout };
  round.id = R.roundId(R.readRound({ ...round, id: '0'.repeat(64), phase: 0, endRoundState: 0, coinjoinState: { Type: 'ConstructionState', Events: state.events } }), Date.parse(start));
  if (opts.tamper?.badId) round.id = 'ab'.repeat(32);
  const commit = R.commitment(params.CoordinationIdentifier, round.id);

  // Other participants: taproot coins with valid proofs, outputs of common amounts.
  const others = [];
  for (let i = 0; i < (opts.others ?? 4); i++) {
    const priv = secp256k1.utils.randomSecretKey();
    const script = btc.p2tr(secp256k1.getPublicKey(priv, true).slice(1)).script;
    const value = BigInt(200000 + i * 37000);
    const txid = hex(randomBytes(32));
    const proof = opts.tamper?.foreignProof && i === 0 ? R.ownershipProofTaproot(priv, script, randomBytes(32), R.commitment('Other', 'cd'.repeat(32))) : R.ownershipProofTaproot(priv, script, randomBytes(32), commit);
    others.push({ priv, script, value, txid, vout: 0, proof });
  }
  const inputEvent = (c) => ({ Type: 'InputAdded', Coin: { Outpoint: upper(R.outpointBytes(c.txid, c.vout)), TxOut: { ScriptPubKey: R.scriptText(c.script), Value: Number(c.value) } }, OwnershipProof: upper(c.proof) });
  const outputEvent = (o) => ({ Type: 'OutputAdded', Output: { ScriptPubKey: R.scriptText(o.script), Value: Number(o.value) } });
  const roundState = () => {
    const r = R.readRound({ ...round, phase: state.phase, endRoundState: state.end, coinjoinState: { Type: state.phase >= 3 ? 'SigningState' : 'ConstructionState', Events: state.events } });
    return r;
  };
  const advance = () => {
    const ours = [...state.alices.values()];
    if (state.phase === 0 && ours.length >= opts.expectInputs) {
      state.phase = 1;
      for (const c of others) state.events.push(inputEvent(c));
    } else if (state.phase === 1 && ours.length && ours.every((a) => a.confirmed)) {
      state.phase = 2;
      for (const c of others) {
        const out = { value: c.value - R.fee(feePerK, 58) - R.fee(feePerK, 43) - 100n, script: btc.p2tr(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true).slice(1)).script };
        state.outputs.push(out);
        state.events.push(outputEvent(out));
      }
    } else if (state.phase === 2 && ours.length && ours.every((a) => state.ready.has(a.id))) {
      if (opts.tamper?.dropOutput) {
        const i = state.events.findIndex((e) => e.Type === 'OutputAdded' && state.ourOutputs?.has(e.Output.ScriptPubKey));
        if (i >= 0) state.events.splice(i, 1);
      }
      if (opts.tamper?.skimFee) state.events.push(outputEvent({ value: 30000n, script: btc.p2tr(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true).slice(1)).script }));
      state.phase = 3;
      state.tx = R.unsignedTransaction(roundState());
    } else if (state.phase === 3 && ours.every((a) => state.witnesses.has(a.index))) {
      state.phase = 4;
      state.end = 4;
    }
  };
  const transport = {
    async post(path, body, identity) {
      state.log.push({ path, identity });
      state.identities.push(identity);
      const b = JSON.parse(JSON.stringify(body));
      try {
        return handle(path, b);
      } catch (e) {
        if (e.coordinator) {
          const { CoordinatorError } = require('../dist/main/wabisabi/client');
          throw new CoordinatorError(e.coordinator.errorCode, e.coordinator.description, e.coordinator.exceptionData);
        }
        throw e;
      }
    },
  };
  const wrong = (want) => { if (!want.includes(state.phase)) throw err('WrongPhase', 'wrong phase', { Type: 'WrongPhaseExceptionData', CurrentPhase: state.phase }); };
  function handle(path, b) {
    if (path === 'status') {
      advance();
      return { roundStates: [{ ...round, phase: state.phase, endRoundState: state.end, coinjoinState: { Type: state.phase >= 3 ? 'SigningState' : 'ConstructionState', Events: state.events, ...(state.phase >= 3 ? { Witnesses: {}, IsFullySigned: false } : {}) }, inputRegistrationEnd: start, isBlame: false }], coinJoinFeeRateMedians: [] };
    }
    if (b.RoundId !== round.id) throw err('RoundNotFound', 'no round');
    if (path === 'input-registration') {
      wrong([0]);
      const op = Buffer.from(b.Input, 'hex');
      const key = `${Buffer.from(op.slice(0, 32)).reverse().toString('hex')}:${op.readUInt32LE(32)}`;
      const coin = opts.utxos.get(key);
      if (!coin) throw err('InputSpent', 'no such coin');
      if (!R.verifyOwnership(Uint8Array.from(Buffer.from(b.OwnershipProof, 'hex')), coin.script, commit)) throw err('WrongOwnershipProof', 'bad proof');
      if ([...state.alices.values()].some((a) => a.key === key)) throw err('AliceAlreadyRegistered', 'twice');
      const ra = amount.handle(b.ZeroAmountCredentialRequests, { zero: true });
      const rv = vsize.handle(b.ZeroVsizeCredentialRequests, { zero: true });
      const id = require('node:crypto').randomUUID();
      state.alices.set(id, { id, key, coin, txid: key.split(':')[0], vout: Number(key.split(':')[1]), confirmed: false, proof: b.OwnershipProof });
      return { aliceId: id, amountCredentials: ra.response, vsizeCredentials: rv.response };
    }
    if (path === 'connection-confirmation') {
      wrong([0, 1]);
      const a = state.alices.get(b.AliceId);
      if (!a) throw err('AliceNotFound', 'no alice');
      if (a.confirmed) throw err('AliceAlreadyConfirmedConnection', 'again');
      const eff = a.coin.value - R.fee(feePerK, 58);
      if (BigInt(b.RealAmountCredentialRequests.Delta) !== eff) throw err('IncorrectRequestedAmountCredentials', 'amount');
      if (b.RealVsizeCredentialRequests.Delta !== 255 - 58) throw err('IncorrectRequestedVsizeCredentials', 'vsize');
      const za = amount.handle(b.ZeroAmountCredentialRequests, { zero: true }).response;
      const zv = vsize.handle(b.ZeroVsizeCredentialRequests, { zero: true }).response;
      if (state.phase === 0) return { zeroAmountCredentials: za, zeroVsizeCredentials: zv };
      const ra = amount.handle(b.RealAmountCredentialRequests, { zero: false }).response;
      const rv = vsize.handle(b.RealVsizeCredentialRequests, { zero: false }).response;
      a.confirmed = true;
      state.events.push(inputEvent({ txid: a.txid, vout: a.vout, value: a.coin.value, script: a.coin.script, proof: Buffer.from(a.proof, 'hex') }));
      return { zeroAmountCredentials: za, zeroVsizeCredentials: zv, realAmountCredentials: ra, realVsizeCredentials: rv };
    }
    if (path === 'credential-issuance') {
      wrong([1, 2]);
      if (b.RealAmountCredentialRequests.Delta !== 0 || b.RealVsizeCredentialRequests.Delta !== 0) throw err('DeltaNotZero', 'delta');
      return {
        realAmountCredentials: amount.handle(b.RealAmountCredentialRequests, { zero: false }).response,
        realVsizeCredentials: vsize.handle(b.RealVsizeCredentialRequests, { zero: false }).response,
        zeroAmountCredentials: amount.handle(b.ZeroAmountCredentialRequests, { zero: true }).response,
        zeroVsizeCredentials: vsize.handle(b.ZeroVsizeCredentialsRequests, { zero: true }).response,
      };
    }
    if (path === 'output-registration') {
      wrong([2]);
      const script = R.parseScript(b.Script);
      if (-b.VsizeCredentialRequests.Delta !== R.outputVsize(script)) throw err('IncorrectRequestedVsizeCredentials', 'vsize');
      const value = BigInt(-b.AmountCredentialRequests.Delta) - R.fee(feePerK, R.outputVsize(script));
      if (value < 5000n) throw err('NotEnoughFunds', 'small');
      amount.handle(b.AmountCredentialRequests, { zero: false });
      vsize.handle(b.VsizeCredentialRequests, { zero: false });
      const out = { value, script };
      state.outputs.push(out);
      (state.ourOutputs ??= new Set()).add(b.Script);
      state.events.push(outputEvent(out));
      return {};
    }
    if (path === 'ready-to-sign') {
      wrong([2]);
      state.ready.add(b.AliceId);
      return {};
    }
    if (path === 'transaction-signature') {
      wrong([3]);
      const r = roundState();
      const ins = R.sortedInputs(r.inputs);
      const c = ins[b.InputIndex];
      if (!c) throw err('InvalidInput', 'index');
      const w = Uint8Array.from(Buffer.from(b.Witness, 'hex'));
      if (w[0] !== 1 || w[1] !== 64 || w.length !== 66) throw err('SignatureTooLong', 'witness');
      const tx = state.tx;
      const msg = tx.preimageWitnessV1(b.InputIndex, ins.map((x) => x.script), btc.SigHash.DEFAULT, ins.map((x) => x.value));
      if (!schnorr.verify(w.slice(2), msg, c.script.slice(2))) throw err('WrongCoinjoinSignature', 'signature');
      state.witnesses.set(b.InputIndex, w);
      for (const a of state.alices.values()) if (a.txid === c.txid && a.vout === c.vout) a.index = b.InputIndex;
      return {};
    }
    throw new Error('unknown path ' + path);
  }
  return { transport, state, round, params, commit, amount, vsize };
}

module.exports = { mockCoordinator, Issuer };
