// Splits what's registered into standard amounts that other participants are likely to have too, so outputs can't be
// told apart. A port of Wasabi Wallet's AmountDecomposer (WalletWasabi, MIT licence), for taproot outputs only.
import { randomInt } from 'node:crypto';
import { fee, P2TR_OUTPUT_VSIZE } from './round';

const P2TR_INPUT_VSIZE = 58;
export interface Output { amount: bigint; fee: bigint; inputFee: bigint; effectiveCost: bigint; effectiveAmount: bigint }

function output(amount: bigint, feePerK: bigint, isEffectiveCost: boolean): Output {
  const f = fee(feePerK, P2TR_OUTPUT_VSIZE);
  const a = isEffectiveCost ? amount - f : amount;
  return { amount: a, fee: f, inputFee: fee(feePerK, P2TR_INPUT_VSIZE), effectiveCost: a + f, effectiveAmount: a - f };
}

/** Powers of 2 and 3, twice the powers of 3, and 1, 2, 5 times the powers of 10, within the allowed range. */
export function denominations(min: bigint, max: bigint): bigint[] {
  const set = new Set<bigint>();
  const series = (base: bigint, times: bigint) => {
    for (let v = 1n; v * times <= max; v *= base) if (v * times >= min) set.add(v * times);
  };
  series(2n, 1n); series(3n, 1n); series(3n, 2n); series(10n, 1n); series(10n, 2n); series(10n, 5n);
  return [...set];
}

const pick = <T>(xs: T[]): T | undefined => (xs.length ? xs[randomInt(xs.length)] : undefined);
function shuffle<T>(xs: T[]): T[] { for (let i = xs.length - 1; i > 0; i--) { const j = randomInt(i + 1); [xs[i], xs[j]] = [xs[j], xs[i]]; } return xs; }
const keyOf = (os: Output[]) => [...os].sort((a, b) => (a.effectiveCost < b.effectiveCost ? -1 : a.effectiveCost > b.effectiveCost ? 1 : 0)).map((o) => o.amount).join(',');
const sum = (xs: bigint[]) => xs.reduce((s, x) => s + x, 0n);

/** Wasabi's exhaustive search for sets of denominations that come within `tolerance` of the target. */
function combinations(target: bigint, tolerance: bigint, maxCount: number, denoms: bigint[]): bigint[][] {
  const out: bigint[][] = [];
  const search = (value: bigint, ds: bigint[]) => { let i = 0; while (i < ds.length && ds[i] > value) i++; return i; };
  // An exact match ends the branch it was found in, up to the first denomination, as Wasabi's TakeUntil does.
  const walk = (head: bigint[], s: bigint, k: number, ds: bigint[], top: boolean): boolean => {
    const remaining = target - s;
    if (k === 0 || remaining < tolerance) { out.push(head); return s === target; }
    const nd = ds.slice(search(remaining, ds));
    for (let i = 0; i < nd.length && out.length < 10_000; i++) {
      const d = nd[i];
      if (BigInt(k) * d < remaining - tolerance) break;
      if (walk([...head, d], s + d, k - 1, nd.slice(i), false) && !top) return true;
    }
    return false;
  };
  walk([], 0n, maxCount, denoms, true);
  return out;
}

export interface DecomposeArgs {
  feePerK: bigint; outputMin: bigint; outputMax: bigint;
  /** Room for outputs, in vbytes. */
  availableVsize: number;
  /** What this wallet registered, after input fees. */
  mine: bigint;
  /** Every input's effective value in the round, this wallet's included. */
  all: bigint[];
}

export function decompose(a: DecomposeArgs): Output[] {
  const { feePerK, outputMin } = a;
  const all = denominations(a.outputMin, a.outputMax).map((d) => output(d, feePerK, false)).sort((x, y) => (y.effectiveAmount > x.effectiveAmount ? 1 : y.effectiveAmount < x.effectiveAmount ? -1 : 0));
  const changeFee = fee(feePerK, P2TR_OUTPUT_VSIZE);
  const minChange = outputMin + changeFee;
  const ov = P2TR_OUTPUT_VSIZE;

  // How often each denomination shows up when every input is broken down greedily.
  const second = [...a.all].sort((x, y) => (y > x ? 1 : y < x ? -1 : 0))[1];
  if (second === undefined) throw new Error('Not enough coins in the round to choose amounts.');
  const affordable = all.filter((d) => d.effectiveCost <= second);
  const freq = new Map<bigint, { o: Output; n: number }>();
  for (const v of a.all) {
    let rem = v;
    for (const d of affordable) {
      if (d.amount < outputMin || rem < minChange) break;
      while (d.effectiveCost <= rem) {
        const f = freq.get(d.amount) ?? { o: d, n: 0 };
        f.n++;
        freq.set(d.amount, f);
        rem -= d.effectiveCost;
      }
    }
    if (rem >= minChange) {
      const c = output(rem, feePerK, true);
      const f = freq.get(c.amount) ?? { o: c, n: 0 };
      f.n++;
      freq.set(c.amount, f);
    }
  }
  const pre = [...freq.values()].filter((f) => f.n > 1).map((f) => f.o).sort((x, y) => (y.effectiveCost > x.effectiveCost ? 1 : y.effectiveCost < x.effectiveCost ? -1 : 0));
  const increment = 0.5 / pre.length;
  const denoms: Output[] = [];
  let len = pre.length;
  for (const d of pre) {
    const severity = 1 + len * increment;
    if (!denoms.length || Number(d.amount) <= Math.floor(Number(denoms[denoms.length - 1].amount) / severity)) denoms.push(d);
    len--;
  }
  if (!denoms.length) throw new Error('No common amounts in this round yet.');
  if (denoms.reduce((m, d) => (d.effectiveCost < m ? d.effectiveCost : m), denoms[0].effectiveCost) > a.mine) throw new Error('Too little registered to make a common amount.');
  const maxOutputs = Math.min(Math.floor(a.availableVsize / ov), 10);
  const cost = (os: Output[]) => sum(os.map((o) => o.fee + o.inputFee));
  const candidates = new Map<string, { d: Output[]; cost: bigint }>();
  const add = (d: Output[], c: bigint) => { const k = keyOf(d); if (!candidates.has(k)) candidates.set(k, { d, cost: c }); };

  const withChange = (set: Output[], remaining: bigint) => {
    let loss = 0n;
    if (remaining >= minChange) set.push(output(remaining, feePerK, true)); else loss = remaining;
    return loss;
  };
  const stop = (remaining: bigint, room: number, d: Output) => (remaining < d.effectiveCost + minChange && room < ov) || (remaining >= d.effectiveCost + minChange && room < ov + ov);

  // The plain greedy breakdown.
  {
    let room = a.availableVsize, remaining = a.mine;
    const set: Output[] = [];
    outer: for (const d of denoms) {
      if (d.amount > remaining) continue;
      while (d.effectiveCost <= remaining) {
        if (stop(remaining, room, d)) break outer;
        set.push(d); remaining -= d.effectiveCost; room -= ov;
        if (set.length >= maxOutputs - 1) break outer;
      }
    }
    const loss = withChange(set, remaining);
    if (!set.length) set.push(output(remaining, feePerK, true));
    add(set, loss + cost(set));
  }
  // Random breakdowns.
  for (let i = 0; i < 10_000; i++) {
    let room = a.availableVsize, remaining = a.mine;
    const set: Output[] = [];
    for (;;) {
      const d = pick(denoms.filter((x) => x.effectiveCost <= remaining && x.effectiveCost >= remaining / 3n)) ?? denoms.find((x) => x.effectiveCost <= remaining);
      if (!d || stop(remaining, room, d)) break;
      set.push(d); remaining -= d.effectiveCost; room -= ov;
      if (set.length >= maxOutputs - 1) break;
    }
    const loss = withChange(set, remaining);
    add(set, loss + cost(set));
  }
  // Sets with no change at all.
  if (maxOutputs > 1 && a.mine > outputMin + changeFee) {
    const std = denoms.map((d) => d.effectiveCost).filter((x) => x <= a.mine);
    for (const combo of combinations(a.mine, outputMin + changeFee, Math.min(maxOutputs, 8), std)) {
      const set = combo.map((c) => denoms.find((d) => d.effectiveCost === c)!);
      if (set.length * ov > a.availableVsize) continue;
      add(set, a.mine - sum(set.map((d) => d.effectiveCost)) + cost(set));
    }
  }

  const standard = new Set(denoms.map((d) => d.amount));
  const change = (d: Output[]) => sum(d.filter((o) => !standard.has(o.amount)).map((o) => o.amount));
  let list = shuffle([...candidates.values()]);
  const changeless = list.filter((c) => c.d.every((o) => standard.has(o.amount)));
  const avoided = changeless.length > 0;
  if (avoided) list = changeless;
  list.sort((x, y) => { const cx = change(x.d), cy = change(y.d); if (cx !== cy) return cx < cy ? -1 : 1; return x.cost < y.cost ? -1 : x.cost > y.cost ? 1 : 0; });
  let final: Output[][];
  if (avoided) {
    const tol = list[0].cost * 12n / 10n;
    final = list.filter((c) => c.cost <= tol).map((c) => c.d);
  } else {
    const best = change(list[0].d);
    const tol = [a.mine / 10n, best * 12n / 10n, 100_000n].reduce((m, x) => (x > m ? x : m));
    final = list.filter((c) => change(c.d) <= tol).map((c) => c.d);
  }
  const largest = pick([...new Set(final.map((d) => d[0].amount))])!;
  const chosen = pick(final.filter((d) => d[0].amount === largest))!;
  const total = sum(chosen.map((o) => o.effectiveCost));
  if (total > a.mine) throw new Error('The amounts add up to more than was registered.');
  if (total + outputMin + changeFee < a.mine) throw new Error('The amounts leave too much unused.');
  if (chosen.length * ov > a.availableVsize) throw new Error('Too many outputs for the room there is.');
  return chosen;
}
