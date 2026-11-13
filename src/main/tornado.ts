import { Interface, Mnemonic, computeHmac, id as keccakId, isAddress, toUtf8Bytes } from 'ethers';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Agent } from 'node:http';
import { getJson, requestJson } from './request';
import { EthClient } from './eth';
import { runTornado } from './tornado-run';
import { Records, plainRecords } from './records';

/** The original immutable mainnet pools. */
export const TORNADO_POOLS: Record<string, string> = {
  0.1: '0x12D66f87A04A9E220743712cE6d9bB1B5616B8Fc',
  1: '0x47CE0C6eD5B0Ce3d3A51fdb1C52DC66a7c3c2936',
  10: '0x910Cbd523D972eb0a6f4cAe4618aD62622b39DbF',
  100: '0xA160cdAB225685dA1d56aa342Ad8841c3b53f291',
};
const SEED_BASE = 'https://raw.githubusercontent.com/tornadocash/tornado-cli/378ddf8b8b92a4924037d7b64a94dbfd5a7dd6e8/cache/ethereum/deposits_eth_';
const DEPOSIT_TOPIC = keccakId('Deposit(bytes32,uint32,uint256)');
const DEPOSIT_GAS = 1_300_000n;
const WITHDRAW_GAS = 500_000n;
const MAX_RELAYER_FEE_PERCENT = 5n;
export const abi = new Interface([
  'function deposit(bytes32 commitment) payable',
  'function withdraw(bytes proof, bytes32 root, bytes32 nullifierHash, address recipient, address relayer, uint256 fee, uint256 refund) payable',
  'function isSpent(bytes32) view returns (bool)',
  'function commitments(bytes32) view returns (bool)',
  'function isKnownRoot(bytes32) view returns (bool)',
]);

export interface TornadoNote { id: string; pool: string; index: number; commitment: string; status: 'sending' | 'deposited' | 'withdrawing' | 'withdrawn'; txHash?: string; withdrawTx?: string; recipient?: string; createdAt: number }
interface Store { next: number; notes: TornadoNote[] }

export const denomination = (pool: string): bigint => BigInt(Math.round(Number(pool) * 10)) * 10n ** 17n;

/** Secrets come from the seed, so a deposit can be found again after restoring the wallet. */
export function noteSecrets(mnemonic: string, index: number): { nullifier: string; secret: string } {
  const seed = Mnemonic.fromPhrase(mnemonic.trim().toLowerCase().split(/\s+/).join(' ')).computeSeed();
  const mac = computeHmac('sha512', seed, toUtf8Bytes(`shinobi/tornado/v1/${index}`)).slice(2);
  return { nullifier: mac.slice(0, 62), secret: mac.slice(62, 124) };
}

/** The standard note text, usable in other Tornado tools. */
export function noteText(pool: string, secrets: { nullifier: string; secret: string }): string {
  return `tornado-eth-${pool}-1-0x${secrets.nullifier}${secrets.secret}`;
}

export async function tornadoEngineCheck(): Promise<void> {
  const [r] = await runTornado('commit', { notes: [{ nullifier: '01'.repeat(31), secret: '02'.repeat(31) }] });
  if (!/^0x[0-9a-f]{64}$/.test(r.commitment)) throw new Error('The proof engine isn\'t working properly.');
}

export class TornadoStore {
  constructor(private readonly dir: string, private readonly cacheDir: string = dir, private readonly records: Records = plainRecords) {}
  private get file() { return path.join(this.dir, 'tornado.json'); }
  async read(): Promise<Store> {
    const s = await this.records.read(this.file).catch(() => undefined);
    return s && Number.isInteger(s.next) && Array.isArray(s.notes) ? s : { next: 0, notes: [] };
  }
  async write(store: Store): Promise<void> {
    await this.records.write(this.file, store);
  }
  /** Every commitment ever deposited: an old snapshot, then logs since. The final root check catches any bad data. */
  async leaves(pool: string, address: string, eth: EthClient, opts: { seed: boolean; agent?: Agent; progress: (m: string) => void }): Promise<string[]> {
    const file = path.join(this.cacheDir, `tornado-cache-${pool}.json`);
    let cache: { block: number; leaves: string[] } = { block: -1, leaves: [] };
    try { cache = JSON.parse(await fs.readFile(file, 'utf8') as unknown as string); } catch { /* first time */ }
    if (cache.block < 0 && opts.seed) {
      opts.progress('Downloading the deposit list…');
      const rows: any[] = await getJson(`${SEED_BASE}${pool}.json`, { agent: opts.agent, timeoutMs: 180_000 });
      rows.forEach((r, i) => { if (r.leafIndex !== i || !/^0x[0-9a-f]{64}$/i.test(r.commitment)) throw new Error('The deposit list file isn\'t valid.'); });
      cache = { block: rows[rows.length - 1].blockNumber, leaves: rows.map((r) => r.commitment) };
    }
    const latest = await eth.blockNumber();
    let from = cache.block + 1;
    let span = 50_000;
    while (from <= latest) {
      const to = Math.min(from + span - 1, latest);
      let logs: any[];
      try {
        logs = await eth.logs(address, DEPOSIT_TOPIC, from, to);
      } catch (e) {
        if (span <= 200) throw e;
        span = Math.floor(span / 2);
        continue;
      }
      for (const log of logs) {
        const index = Number(BigInt(`0x${String(log.data).slice(2, 66)}`));
        if (index < cache.leaves.length) continue; // overlap at a range edge
        if (index !== cache.leaves.length || !/^0x[0-9a-f]{64}$/i.test(log.topics?.[1])) throw new Error('The Ethereum node\'s deposit records have a gap. Try again later.');
        cache.leaves.push(log.topics[1]);
      }
      cache.block = to;
      from = to + 1;
      if (span < 50_000 && logs.length < 2000) span = Math.min(span * 2, 50_000);
      opts.progress(`Reading deposit records… ${Math.round((to / latest) * 100)}% (${cache.leaves.length})`);
      await fs.mkdir(this.cacheDir, { recursive: true });
      await fs.writeFile(file, JSON.stringify(cache), { mode: 0o600 });
    }
    return cache.leaves;
  }
}

export interface RelayerInfo { url: string; rewardAccount: string; feePercent: number }

export function checkRelayerUrl(input: string, allowLocal: boolean): string {
  const url = input.trim().replace(/\/+$/, '');
  if (/^https:\/\/[^/\s]+$/i.test(url) || /^http:\/\/[a-z2-7]{56}\.onion$/i.test(url)) return url;
  if (allowLocal && /^http:\/\/127\.0\.0\.1:\d+$/.test(url)) return url;
  throw new Error('A relayer address must be https:// or .onion.');
}

export async function relayerStatus(url: string, agent?: Agent): Promise<RelayerInfo> {
  const s = await getJson(`${url}/status`, { agent, timeoutMs: 60_000 });
  if (s?.netId !== 1 && s?.netId !== '*') throw new Error('This is not an Ethereum mainnet relayer.');
  if (typeof s.rewardAccount !== 'string' || !isAddress(s.rewardAccount)) throw new Error('The relayer gave an unexpected answer.');
  const feePercent = Number(s.tornadoServiceFee);
  if (!Number.isFinite(feePercent) || feePercent < 0) throw new Error('The relayer gave an unexpected answer.');
  return { url, rewardAccount: s.rewardAccount, feePercent };
}

/** What the relayer keeps. The proof commits to this, the recipient and the relayer, so it can't take more. */
export function relayerFee(pool: string, feePercent: number, gasPrice: bigint): bigint {
  const total = denomination(pool);
  const fee = gasPrice * WITHDRAW_GAS + (total * BigInt(Math.round(feePercent * 1000))) / 100_000n;
  if (fee * 100n > total * MAX_RELAYER_FEE_PERCENT) throw new Error(`The fee is over ${MAX_RELAYER_FEE_PERCENT}% of the amount, so this was stopped. Try again when gas is low.`);
  return fee;
}

export async function relayerSubmit(info: RelayerInfo, contract: string, proof: string, args: string[], agent?: Agent, pollMs = 5000): Promise<string> {
  const post = await requestJson(`${info.url}/v1/tornadoWithdraw`, { method: 'POST', body: { contract, proof, args }, agent, timeoutMs: 120_000 });
  if (post.status >= 400 || typeof post.body?.id !== 'string' || !/^[\w-]{1,80}$/.test(post.body.id)) throw new Error(`The relayer refused: ${String(post.body?.error ?? post.status).slice(0, 200)}`);
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    const job = await getJson(`${info.url}/v1/jobs/${post.body.id}`, { agent, timeoutMs: 60_000 }).catch(() => null);
    if (job?.status === 'CONFIRMED' && typeof job.txHash === 'string') return job.txHash;
    if (job?.status === 'FAILED') throw new Error(`The relayer's send failed: ${String(job.failedReason ?? '').slice(0, 200)}`);
  }
  throw new Error('The relayer is slow to answer. Check the status shortly. The app can check again whether it was withdrawn.');
}

export { DEPOSIT_GAS, WITHDRAW_GAS };
