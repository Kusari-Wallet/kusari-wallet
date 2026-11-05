import { TronWeb, utils as tronUtils } from 'tronweb';
import type { NetworkConfig } from './config';
import type { Agent } from 'node:http';
import { formatAmount } from './amount';
import { getJson } from './request';

export const TRON_PATH = "m/44'/195'/0'/0/0";
const TRANSFER_SELECTOR = 'a9059cbb';
const FEE_LIMIT_CAP_SUN = 150_000_000n; // refuse to authorize more than 150 TRX of energy
const TRX_TX_BYTES = 270n;
const USDT_TX_BYTES = 350n;

export interface TronAccount { address: string; privateKey: string }

export function generateTronMnemonic(): string {
  const account = TronWeb.createRandom(undefined, TRON_PATH);
  const phrase = account.mnemonic?.phrase;
  if (!phrase) throw new Error('Tron 시드 생성에 실패했어.');
  return phrase;
}

export function deriveTronAccount(mnemonic: string): TronAccount {
  const normalized = mnemonic.trim().toLowerCase().split(/\s+/).join(' ');
  let account;
  try {
    account = TronWeb.fromMnemonic(normalized, TRON_PATH);
  } catch {
    throw new Error('Tron 시드 문구가 올바르지 않아.');
  }
  if (account instanceof Error) throw new Error('Tron 시드 문구가 올바르지 않아.');
  return { address: account.address, privateKey: account.privateKey.replace(/^0x/, '') };
}

export function isTronAddress(address: string): boolean {
  return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address) && TronWeb.isAddress(address);
}

export interface TronHistoryItem {
  asset: 'TRX' | 'USDT';
  hash: string;
  direction: 'in' | 'out' | 'self';
  amount: string;
  counterparty: string;
  timestamp: number;
  status: 'confirmed' | 'failed';
  dust: boolean;
}

export type TronTransfer = { asset: 'TRX' | 'USDT'; to: string; amount: bigint; feeLimit?: bigint };

export interface TronFeeEstimate {
  feeSun: bigint;
  feeLimitSun?: bigint;
  energyNeeded?: bigint;
  recipientIsNew: boolean;
}

function txError(res: { code?: string; message?: string }): string {
  let message = res.message ?? '';
  if (/^[0-9a-f]+$/i.test(message)) message = Buffer.from(message, 'hex').toString('utf8');
  return `${res.code ?? 'ERROR'} ${message}`.trim();
}

export class TronClient {
  private readonly tw: TronWeb;

  constructor(private readonly net: NetworkConfig['tron'], private readonly apiKey: string, readonly address: string, private readonly agent?: Agent, slow = false) {
    this.tw = new TronWeb({ fullHost: net.host, headers: apiKey ? { 'TRON-PRO-API-KEY': apiKey } : undefined });
    this.tw.setAddress(address);
    if (agent || slow) {
      const tw = this.tw as any;
      for (const provider of [tw.fullNode, tw.solidityNode, tw.eventServer]) {
        if (!provider?.instance) continue;
        if (agent) Object.assign(provider.instance.defaults, { httpAgent: agent, httpsAgent: agent, proxy: false });
        provider.instance.defaults.timeout = 60_000;
      }
    }
  }

  async getTrxBalance(): Promise<bigint> {
    const account = await this.tw.trx.getAccount(this.address);
    return BigInt(account.balance ?? 0);
  }

  async getUsdtBalance(): Promise<bigint> {
    const res = await this.tw.transactionBuilder.triggerConstantContract(
      this.net.usdt, 'balanceOf(address)', {}, [{ type: 'address', value: this.address }], this.address);
    const hex = res.constant_result?.[0];
    if (!res.result?.result || !hex) throw new Error('USDT 잔액을 읽지 못했어.');
    return BigInt('0x' + hex);
  }

  private async accountExists(address: string): Promise<boolean> {
    const account = await this.tw.trx.getAccount(address);
    return Boolean(account && account.address);
  }

  /**
   * A USDT transfer to someone who already holds USDT, for showing before an address is known.
   * It can't be simulated here: a transfer to myself is cheaper than a real one, and fails with no balance.
   */
  async typicalUsdtFee(): Promise<bigint> {
    const [res, params] = await Promise.all([this.tw.trx.getAccountResources(this.address), this.tw.trx.getChainParameters()]);
    const param = (key: string, fallback: bigint) => {
      const found = params.find((p: { key: string; value?: number }) => p.key === key);
      return found?.value !== undefined ? BigInt(found.value) : fallback;
    };
    const stakedEnergy = BigInt((res.EnergyLimit ?? 0) - (res.EnergyUsed ?? 0));
    const energy = 65_000n > stakedEnergy ? 65_000n - stakedEnergy : 0n;
    const freeBw = BigInt((res.freeNetLimit ?? 0) - (res.freeNetUsed ?? 0));
    const stakedBw = BigInt((res.NetLimit ?? 0) - (res.NetUsed ?? 0));
    const bw = freeBw >= USDT_TX_BYTES || stakedBw >= USDT_TX_BYTES ? 0n : USDT_TX_BYTES * param('getTransactionFee', 1000n);
    return energy * param('getEnergyFee', 100n) + bw;
  }

  async estimateFee(transfer: TronTransfer): Promise<TronFeeEstimate> {
    const [res, params, recipientExists] = await Promise.all([
      this.tw.trx.getAccountResources(this.address),
      this.tw.trx.getChainParameters(),
      this.accountExists(transfer.to),
    ]);
    const param = (key: string, fallback: bigint) => {
      const found = params.find((p: { key: string; value?: number }) => p.key === key);
      return found?.value !== undefined ? BigInt(found.value) : fallback;
    };
    const bandwidthPrice = param('getTransactionFee', 1000n);
    const energyPrice = param('getEnergyFee', 100n);
    const freeBw = BigInt((res.freeNetLimit ?? 0) - (res.freeNetUsed ?? 0));
    const stakedBw = BigInt((res.NetLimit ?? 0) - (res.NetUsed ?? 0));
    const stakedEnergy = BigInt((res.EnergyLimit ?? 0) - (res.EnergyUsed ?? 0));
    const positive = (v: bigint) => (v > 0n ? v : 0n);

    if (transfer.asset === 'TRX') {
      if (!recipientExists) {
        // New accounts: activation fee plus bandwidth, unless staked bandwidth covers it.
        const activation = param('getCreateNewAccountFeeInSystemContract', 1_000_000n);
        const bw = stakedBw >= TRX_TX_BYTES ? 0n : param('getCreateAccountFee', 100_000n);
        return { feeSun: activation + bw, recipientIsNew: true };
      }
      const bwFee = freeBw >= TRX_TX_BYTES || stakedBw >= TRX_TX_BYTES ? 0n : TRX_TX_BYTES * bandwidthPrice;
      return { feeSun: bwFee, recipientIsNew: false };
    }

    const sim = await this.tw.transactionBuilder.triggerConstantContract(
      this.net.usdt, 'transfer(address,uint256)', {},
      [{ type: 'address', value: transfer.to }, { type: 'uint256', value: transfer.amount.toString() }], this.address);
    if (!sim.result?.result || sim.energy_used === undefined) throw new Error('USDT 전송 시뮬레이션에 실패했어.');
    // A first-time USDT recipient costs roughly double; the simulation already includes that.
    const energyNeeded = BigInt(sim.energy_used);
    const burn = positive(energyNeeded - stakedEnergy) * energyPrice;
    const bwFee = freeBw >= USDT_TX_BYTES || stakedBw >= USDT_TX_BYTES ? 0n : USDT_TX_BYTES * bandwidthPrice;
    const feeLimitSun = (energyNeeded * energyPrice * 3n) / 2n;
    if (feeLimitSun > FEE_LIMIT_CAP_SUN) {
      throw new Error(`예상 수수료가 비정상적으로 높아서 중단했어 (${formatAmount(feeLimitSun, 6)} TRX 한도).`);
    }
    return { feeSun: burn + bwFee, feeLimitSun, energyNeeded, recipientIsNew: !recipientExists };
  }

  /** Builds locally, checks every field against what the user approved, signs, broadcasts. */
  async send(transfer: TronTransfer, privateKey: string): Promise<string> {
    const tx = await this.build(transfer);
    this.assertMatches(tx, transfer);
    const signed = await this.tw.trx.sign(tx, privateKey);
    const res = await this.tw.trx.sendRawTransaction(signed);
    if (!res.result) throw new Error(`전송 거부됨: ${txError(res as { code?: string; message?: string })}`);
    return tx.txID;
  }

  /** Exposed for tests: builds the unsigned transaction. */
  async build(transfer: TronTransfer) {
    if (transfer.asset === 'TRX') {
      if (transfer.amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('금액이 너무 커.');
      return this.tw.transactionBuilder.sendTrx(transfer.to, Number(transfer.amount), this.address);
    }
    if (!transfer.feeLimit) throw new Error('수수료 한도가 없어.');
    const built = await this.tw.transactionBuilder.triggerSmartContract(
      this.net.usdt, 'transfer(address,uint256)',
      { feeLimit: Number(transfer.feeLimit), callValue: 0, txLocal: true },
      [{ type: 'address', value: transfer.to }, { type: 'uint256', value: transfer.amount.toString() }], this.address);
    return built.transaction;
  }

  /** Exposed for tests: rejects a transaction that differs from the approved transfer. */
  assertMatches(tx: any, transfer: TronTransfer): void {
    if (!tronUtils.transaction.txCheck(tx)) throw new Error('거래 데이터 무결성 검사에 실패해서 서명을 중단했어.');
    const contracts = tx.raw_data.contract;
    if (contracts.length !== 1) throw new Error('거래 형식이 이상해서 서명을 중단했어.');
    const value = contracts[0].parameter.value;
    const toHex = (a: string) => TronWeb.address.toHex(a).toLowerCase();
    const fail = () => { throw new Error('거래 내용이 승인한 내용과 달라서 서명을 중단했어.'); };
    if (String(value.owner_address).toLowerCase() !== toHex(this.address)) fail();
    if (transfer.asset === 'TRX') {
      if (contracts[0].type !== 'TransferContract') fail();
      if (String(value.to_address).toLowerCase() !== toHex(transfer.to)) fail();
      if (BigInt(value.amount) !== transfer.amount) fail();
      return;
    }
    if (contracts[0].type !== 'TriggerSmartContract') fail();
    if (String(value.contract_address).toLowerCase() !== toHex(this.net.usdt)) fail();
    if (value.call_value && BigInt(value.call_value) !== 0n) fail();
    if (BigInt(tx.raw_data.fee_limit) !== transfer.feeLimit) fail();
    const data = String(value.data).toLowerCase();
    const expected = TRANSFER_SELECTOR
      + toHex(transfer.to).slice(2).padStart(64, '0')
      + transfer.amount.toString(16).padStart(64, '0');
    if (data !== expected) fail();
  }

  /** Waits for a receipt. A broadcast USDT transfer can still fail, e.g. out of energy. */
  async waitForResult(txid: string, timeoutMs = 90_000): Promise<'confirmed' | 'failed' | 'unknown'> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        const info: any = await this.tw.trx.getTransactionInfo(txid);
        if (info?.id) {
          const failed = info.result === 'FAILED' || (info.receipt?.result && info.receipt.result !== 'SUCCESS');
          return failed ? 'failed' : 'confirmed';
        }
      } catch { /* keep polling */ }
    }
    return 'unknown';
  }

  private async getJson(pathAndQuery: string): Promise<any> {
    return getJson(this.net.host + pathAndQuery, {
      headers: this.apiKey ? { 'TRON-PRO-API-KEY': this.apiKey } : {},
      agent: this.agent,
      timeoutMs: this.agent ? 60_000 : 30_000,
    });
  }

  async getHistory(asset: 'TRX' | 'USDT', limit = 30): Promise<TronHistoryItem[]> {
    const me = this.address;
    if (asset === 'USDT') {
      const json = await this.getJson(`/v1/accounts/${me}/transactions/trc20?limit=${limit}&contract_address=${this.net.usdt}`);
      return (json.data ?? [])
        .filter((t: any) => t.token_info?.address === this.net.usdt && BigInt(t.value ?? 0) > 0n)
        .map((t: any): TronHistoryItem => {
          const direction = t.from === t.to ? 'self' : t.to === me ? 'in' : 'out';
          const value = BigInt(t.value);
          return {
            asset, hash: t.transaction_id, direction, amount: formatAmount(value, 6),
            counterparty: direction === 'in' ? t.from : t.to,
            timestamp: t.block_timestamp, status: 'confirmed',
            dust: direction === 'in' && value < 10_000n,
          };
        });
    }
    const json = await this.getJson(`/v1/accounts/${me}/transactions?limit=${limit}`);
    const items: TronHistoryItem[] = [];
    for (const t of json.data ?? []) {
      const c = t.raw_data?.contract?.[0];
      if (c?.type !== 'TransferContract') continue;
      const from = TronWeb.address.fromHex(c.parameter.value.owner_address);
      const to = TronWeb.address.fromHex(c.parameter.value.to_address);
      const direction = from === to ? 'self' : to === me ? 'in' : 'out';
      const value = BigInt(c.parameter.value.amount);
      items.push({
        asset, hash: t.txID, direction, amount: formatAmount(value, 6),
        counterparty: direction === 'in' ? from : to,
        timestamp: t.block_timestamp,
        status: t.ret?.[0]?.contractRet === 'SUCCESS' ? 'confirmed' : 'failed',
        dust: direction === 'in' && value < 10_000n,
      });
    }
    return items;
  }
}
