// The wallet service, second layer: sends, fees, Tornado Cash, coin control, private transfers and settings.
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import { formatAmount, parseAmount } from './amount';
import { Asset, BTC_EXPLORER_TX, DECIMALS, FIRO_EXPLORER_TX, SOL_EXPLORER_TX, BUY_PAGE, BCH_EXPLORER_TX, LTC_EXPLORER_TX, DOGE_EXPLORER_TX, DASH_EXPLORER_TX, ARRR_EXPLORER_TX, KSR_EXPLORER_TX, ZANO_EXPLORER_TX, ZEC_EXPLORER_TX, NETWORKS, OWN_SERVER_COINS, Settings } from './config';
import { TronTransfer, deriveTronAccount, isTronAddress } from './tron';
import { requestJson, getJson, requestBinary, socksAgent, isolatedAgent } from './request';
import { parseOhttpKeys, parsePayjoin, payjoinUri, type OhttpKeys, type Post } from './payjoin';
import { PAYJOIN_DIRECTORIES, btcAddressOf, btcScriptOf, coinKey, newReceiverKey, payjoinPay, receiveStep } from './btc-payjoin';
import { isSilentAddress } from './btc-silent';
import { type BtcClient, type BtcDraft, LITECOIN, V0_CHAIN, coinId, estimateVbytes, isBtcAddress, isLtcAddress } from './btc';
import { DEPOSIT_GAS, TORNADO_CHAINS, TORNADO_POOLS, type TornadoChain, TornadoNote, chainOfNote, isTornadoChain, TornadoStore, WITHDRAW_GAS, abi as tornadoAbi, checkRelayerUrl, denomination, noteSecrets, noteText, pickRelayer, relayerFee, relayerHost, relayerStatus, relayerSubmit, splitPlan, tornadoEngineCheck } from './tornado';
import { runTornado } from './tornado-run';
import { isArrrAddress } from './arrr';
import { arrrEngineInfo } from './arrr-process';
import { isMwebAddress } from './mweb';
import { isSparkAddress } from './spark';
import { isZanoAddress, isKsrAddress, ZANO_FEE, KSR_FEE } from './zano';
import { zanoEngineInfo, ksrEngineInfo } from './zano-process';
import { isZecAddress, zecHeightForDate } from './zec';
import { zecEngineInfo } from './zec-process';
import { isFiroAddress, typicalFiroFee } from './firo';
import { isDogeAddress, typicalDogeFee } from './doge';
import { DCR_EXPLORER_TX, DCR_MIXED_PATH, DCR_PATH, DcrClient, isDcrAddress, typicalDcrFee, dcrNet } from './dcr';
import { MAX_TICKETS, TICKET_FEE, VSP_LIST_URL, VspClient, commitmentKey, feeFundFor, feeTx, parseVspList, planTickets, ticketExpiry, vspFee, vspOrigin, votingKey } from './dcr-stake';
import { isBchAddress, normalBchAddress, typicalBchFee } from './bch';
import { SOL_FEE, SPL_TOKENS, isSolAddress, solSecret } from './sol';
import type { EthClient } from './eth';
import { POOL_TOKENS, type PoolAsset } from './sol-privacy';
import { DASH_DUST, dashFee, isDashAddress, signDashOutputs, typicalDashFee } from './dash';
import { DashMixer, MIX_ROUNDS } from './dash-mix';
import { COINJOIN_COORDINATORS, MIX_TARGETS } from './btc-mix';
import type { InsightUtxo } from './insight';
import { ETH_EXTRA_FIRST, chainOf, deriveEthAccount, isEthAddress } from './eth';
import { TOR_BRIDGES, TorBridge, parseCustomBridges } from './tor-bridges';
import { ACCOUNT_COINS, checkOwnServer, isLocalServer, COIN_ID, EVM_EXPLORER, isEvm, isSpl, Preview, PREVIEW_TTL_MS, withTimeoutValue } from './service-common';
import { ServiceCore, btcBirthdayFor } from './service-core';
import { lookalikeOf, rememberRecipient } from './lookalike';
import type { Secrets } from './vault';

export class SendService extends ServiceCore {
  async flush(): Promise<void> { await this.monero?.flush(); }

  async moneroAddresses() { return this.session().monero.listAddresses(); }
  async newSubaddress() { return this.session().monero.createSubaddress(); }

  async qr(text: string): Promise<string> {
    // A Zcash unified address runs past 200 characters.
    if (text.length > 500) throw new Error('This value can\'t be made into a QR code.');
    return QRCode.toDataURL(text, { margin: 1, width: 320, errorCorrectionLevel: 'M', color: { dark: '#16302b', light: '#ffffff' } });
  }

  // ---- what a transfer costs right now ----

  protected feeCache = new Map<Asset, { at: number; value: { fee: string; asset: string; usd: number | null } }>();

  /** A typical transfer of this coin. Null when it can't be told, never a made-up number. */
  async feeEstimate(asset: Asset): Promise<{ fee: string; asset: string; usd: number | null } | null> {
    const cached = this.feeCache.get(asset);
    if (cached && Date.now() - cached.at < 60_000) return cached.value;
    const { tron, btc } = this.session();
    const read = async (): Promise<[bigint, number, string]> => {
      if (asset === 'BTC') return [estimateVbytes(1, 2) * (await btc.feeRate()), 8, 'BTC'];
      if (asset === 'LTC') return [estimateVbytes(1, 2, LITECOIN.inputVb, LITECOIN.outputVb) * (await this.ltc!.feeRate()), 8, 'LTC'];
      if (asset === 'DASH') return [typicalDashFee(), 8, 'DASH'];
      if (asset === 'FIRO') return [typicalFiroFee(), 8, 'FIRO'];
      if (asset === 'SOL' || isSpl(asset)) return [SOL_FEE, 9, 'SOL'];
      if (ACCOUNT_COINS[asset]) { const c = ACCOUNT_COINS[asset]!; return [c.typicalFee, DECIMALS[c.feeAsset], c.feeAsset]; }
      if (asset === 'DOGE') return [typicalDogeFee(), 8, 'DOGE'];
      if (asset === 'DCR') return [typicalDcrFee(), 8, 'DCR'];
      if (asset === 'BCH') return [typicalBchFee(), 8, 'BCH'];
      if (asset === 'ZEC') return [15_000n, 8, 'ZEC']; // ZIP-317, a typical transfer
      if (asset === 'ZANO') return [ZANO_FEE, 12, 'ZANO'];
      if (asset === 'KSR') return [KSR_FEE, 12, 'KSR'];
      if (asset === 'ARRR') return [10_000n, 8, 'ARRR'];
      if (isEvm(asset)) {
        const chain = chainOf(asset);
        return [await this.evm(asset).typicalFee(asset === chain.native ? 21_000n : 65_000n), 18, chain.native];
      }
      if (asset === 'USDT') return [await tron.typicalUsdtFee(), 6, 'TRX'];
      if (asset === 'TRX') return [(await tron.estimateFee({ asset, to: tron.address, amount: 1n })).feeSun, 6, 'TRX'];
      for (const node of this.moneroNodes()) {
        try {
          const res = await requestJson(`${node}/json_rpc`, { method: 'POST', body: { jsonrpc: '2.0', id: '0', method: 'get_fee_estimate' }, agent: this.priceAgent, timeoutMs: this.torActive ? 60_000 : 10_000 });
          const perByte = res.body?.result?.fee;
          if (Number.isSafeInteger(perByte) && perByte > 0) return [BigInt(perByte) * 2200n, 12, 'XMR'];
        } catch { /* next node */ }
      }
      throw new Error('no node');
    };
    try {
      const [fee, decimals, feeAsset] = await withTimeoutValue(read(), 15_000);
      const key = feeAsset as Asset;
      const price = (await this.prices())?.[key]?.usd;
      const fmt = formatAmount(fee, decimals);
      const value = { fee: fmt, asset: feeAsset, usd: typeof price === 'number' ? Number(fmt) * price : null };
      this.feeCache.set(asset, { at: Date.now(), value });
      return value;
    } catch {
      return null;
    }
  }

  // ---- Tornado Cash: fixed pools on Ethereum, BNB Chain, Polygon and Arbitrum ----

  protected get tornadoStore() { return new TornadoStore(this.dir, this.baseDir, this.records); }
  protected tornadoPoolMap(chain: TornadoChain = 'eth'): Record<string, string> { return chain === 'eth' ? this.dev.tornadoPools ?? TORNADO_POOLS : TORNADO_CHAINS[chain].pools; }
  protected poolAddress(pool: string, chain: TornadoChain = 'eth'): string {
    const address = this.tornadoPoolMap(chain)[pool];
    if (!address) throw new Error('No such pool.');
    return address;
  }
  protected tornadoChain(input: unknown): TornadoChain {
    if (input === undefined || input === null || input === '') return 'eth';
    if (!isTornadoChain(input)) throw new Error('No Tornado pools on this network.');
    return input;
  }
  /** The chain's client and the key that signs from this wallet there. */
  protected tornadoClient(chain: TornadoChain): EthClient { return chain === 'eth' ? this.session().eth : this.evm(TORNADO_CHAINS[chain].asset); }
  protected tornadoSigner(chain: TornadoChain, mnemonic: string) { return chain === 'eth' ? deriveEthAccount(mnemonic).wallet : this.evmAccount(TORNADO_CHAINS[chain].asset, mnemonic).wallet; }

  async tornadoInfo(chainInput?: string) {
    const chain = this.tornadoChain(chainInput);
    const store = await this.tornadoStore.read();
    const c = TORNADO_CHAINS[chain];
    return {
      chain, symbol: c.symbol, label: c.label, chains: Object.keys(TORNADO_CHAINS),
      pools: Object.keys(this.tornadoPoolMap(chain)).sort((a, b) => Number(a) - Number(b)),
      notes: store.notes.filter((n) => chainOfNote(n) === chain), relayer: chain === 'eth' ? this.settings.tornadoRelayer : '',
    };
  }

  /** Fails early and visibly if the proof engine can't start on this device. */
  async tornadoCheck(): Promise<boolean> { await tornadoEngineCheck(); return true; }

  async tornadoDepositPrepare(pool: string, chainInput?: string) {
    const chain = this.tornadoChain(chainInput);
    const eth = this.tornadoClient(chain);
    const to = this.poolAddress(pool, chain);
    const draft = await eth.draftCall(to, denomination(pool), DEPOSIT_GAS);
    const asset = TORNADO_CHAINS[chain].asset;
    const preview = this.storePreview({ asset, to, amount: draft.amount, fee: draft.expectedFee, eth: draft });
    return { id: preview.id, pool, chain, to, amount: formatAmount(draft.amount, 18), fee: formatAmount(draft.expectedFee, 18), feeAsset: asset };
  }

  /**
   * `sendTo`: an address to send it on to, through a relayer, at a random time 1 to 24 hours after the deposit
   * (while the wallet is open). The note's keys wait sealed with the wallet's records until then.
   */
  async tornadoDepositConfirm(id: string, pool: string, password: string, opts: { chain?: string; sendTo?: string } = {}): Promise<TornadoNote> {
    const chain = this.tornadoChain(opts.chain);
    const eth = this.tornadoClient(chain);
    const preview = this.previews.get(id);
    if (!preview?.eth || preview.expires < Date.now() || preview.to !== this.poolAddress(pool, chain)) throw new Error('The review expired. Try again.');
    const sendTo = opts.sendTo?.trim() ? await this.foreign(this.tornadoRecipient(opts.sendTo, eth)) : undefined;
    const secrets = await this.vault.open(password);
    this.previews.delete(id);
    const store = await this.tornadoStore.read();
    // After restoring from the seed the counter may be behind what's on chain. A used secret would waste the gas.
    let index = store.next;
    let commitment = '';
    for (;; index++) {
      [{ commitment }] = await runTornado('commit', { notes: [noteSecrets(secrets.tronMnemonic, index)] });
      const used = tornadoAbi.decodeFunctionResult('commitments', await eth.call(preview.to, tornadoAbi.encodeFunctionData('commitments', [commitment])));
      if (!used[0]) break;
    }
    // Saved before anything is sent: a crash can never leave money without its record.
    const note: TornadoNote = { id: randomUUID(), pool, index, commitment, status: 'sending', createdAt: Date.now(), ...(chain === 'eth' ? {} : { chain }), ...(sendTo ? { sendTo } : {}) };
    store.next = index + 1;
    store.notes.unshift(note);
    await this.tornadoStore.write(store);
    try {
      note.txHash = await eth.send({ ...preview.eth, data: tornadoAbi.encodeFunctionData('deposit', [commitment]) }, this.tornadoSigner(chain, secrets.tronMnemonic));
      note.status = 'deposited';
    } catch (e) {
      store.notes = store.notes.filter((n) => n.id !== note.id);
      await this.tornadoStore.write(store);
      throw e;
    }
    await this.tornadoStore.write(store);
    if (sendTo) {
      const entry = { id: note.id, kind: 'send-on' as const, at: randomLater(), keys: noteSecrets(secrets.tronMnemonic, index), to: sendTo };
      note.at = entry.at;
      await this.tornadoStore.write(store);
      await this.records.write(this.tornadoLaterPath, [...(await this.tornadoLater()).filter((e) => e.id !== note.id), entry]);
      this.armTornado(entry);
    }
    this.emit('balance-changed');
    return note;
  }

  /** A mixer's typed receiving address must not be one of this wallet's own: that links both ends again. */
  protected async foreign(address: string): Promise<string> {
    const own = new Set(Object.values(await this.addresses().catch(() => ({}))).filter((v): v is string => typeof v === 'string').map((v) => v.toLowerCase()));
    for (const c of this.ethExtra.values()) own.add(c.address.toLowerCase());
    if (own.has(address.toLowerCase())) throw new Error('This address belongs to this wallet, which gives no privacy benefit. Enter an address from another wallet.');
    return address;
  }

  protected tornadoRecipient(input: string, eth: EthClient): string {
    const r = input.trim();
    if (!isEthAddress(r)) throw new Error('The receiving address is not an Ethereum address (0x…).');
    if (r.toLowerCase() === eth.address.toLowerCase()) throw new Error('Receiving at the deposit address gives no privacy benefit. Enter a new address.');
    return r;
  }

  async tornadoExport(noteId: string, password: string): Promise<string> {
    const store = await this.tornadoStore.read();
    const note = store.notes.find((n) => n.id === noteId);
    if (!note) throw new Error('No such deposit.');
    const secrets = await this.vault.open(password);
    return noteText(note.pool, noteSecrets(secrets.tronMnemonic, note.index), chainOfNote(note));
  }

  /**
   * Working relayers from the registry, each asked for its status over Tor; kept for an hour per chain. Ones that
   * don't answer, are for another network, or ask more than 1% are left out. The registry and ENS are on Ethereum.
   */
  protected relayerLists = new Map<TornadoChain, { at: number; list: { url: string; feePercent: number; rewardAccount: string }[] }>();
  async tornadoRelayers(chainInput?: string): Promise<{ url: string; feePercent: number }[]> {
    const chain = this.tornadoChain(chainInput);
    const { eth } = this.session();
    const cached = this.relayerLists.get(chain);
    if (cached && Date.now() - cached.at < 3600_000) return cached.list;
    const say = (m: string) => this.emit('tornado-progress', m);
    const names: { name: string; address: string; url?: string }[] = this.dev.tornadoRelayerNames ?? await this.tornadoStore.relayerNames(eth, say);
    say(`Checking ${names.length} registered relayers…`);
    const c = TORNADO_CHAINS[chain];
    const hosts: string[] = [];
    for (const r of names) {
      const host = this.dev.tornadoRelayerNames ? r.url ?? null : await relayerHost(eth, r.name, c.ensKey).catch(() => null);
      if (host && !hosts.includes(host)) hosts.push(host);
    }
    const list: { url: string; feePercent: number; rewardAccount: string }[] = [];
    for (let i = 0; i < hosts.length; i += 6) {
      const batch = await Promise.all(hosts.slice(i, i + 6).map((url) => relayerStatus(url, this.priceAgent, this.dev.tornadoRelayerNames ? 1 : c.netId).catch(() => null)));
      for (const info of batch) if (info && info.feePercent <= 1) list.push(info);
    }
    this.relayerLists.set(chain, { at: Date.now(), list });
    return list;
  }

  /**
   * Fee and amounts for the review screen. Nothing heavy, nothing sent. recipientInput "new": a never used address of
   * this wallet (made when the withdrawal goes ahead; Ethereum only). relayerInput "auto": one picked as the site does.
   */
  async tornadoWithdrawQuote(noteId: string, recipientInput: string, relayerInput: string, opts: { madeHere?: boolean } = {}) {
    const store = await this.tornadoStore.read();
    const note = store.notes.find((n) => n.id === noteId);
    if (!note) throw new Error('No such deposit.');
    const chain = chainOfNote(note);
    const c = TORNADO_CHAINS[chain];
    const eth = this.tornadoClient(chain);
    const fresh = recipientInput.trim() === 'new';
    let recipient = recipientInput.trim();
    if (fresh) {
      if (chain !== 'eth') throw new Error('Enter the receiving address.');
      const list = await this.ethExtraList();
      if (!this.ethNode) throw new Error('The wallet is locked.');
      recipient = this.ethNode.addressAt(list.length ? Math.max(...list) + 1 : 0);
    }
    // A new address this wallet made for this withdrawal is meant to be its own; a typed one must not be.
    recipient = fresh || opts.madeHere ? this.tornadoRecipient(recipient, eth) : await this.foreign(this.tornadoRecipient(recipient, eth));
    const total = denomination(note.pool);
    // How hidden the deposit is by now: deposits after it, and time.
    const after = await this.tornadoStore.depositsAfter(note.pool, note.commitment, chain);
    const hours = Math.floor((Date.now() - note.createdAt) / 3600_000);
    const warnings: string[] = [];
    if (hours < 24) warnings.push('This deposit is less than a day old. Withdrawing soon after depositing makes the two easy to match by time. Waiting days or longer helps.');
    if (after !== null && after < 20) warnings.push(`Only ${after} deposits have been made to this pool since yours, so it hides among few. Waiting for more helps.`);
    const base = { pool: note.pool, chain, symbol: c.symbol, recipient, fresh, after, hours, warnings };
    if (!relayerInput.trim()) {
      const gas = (await eth.gasPrice()) * c.withdrawGas;
      return { ...base, mode: 'self' as const, fee: formatAmount(gas, 18), feeFrom: 'wallet' as const, receive: formatAmount(total, 18), relayerUrl: '' };
    }
    let url: string;
    if (relayerInput.trim() === 'auto') {
      const chosen = pickRelayer(await this.tornadoRelayers(chain));
      if (!chosen) throw new Error('No working relayer was found right now. Enter one yourself, or try again later.');
      url = chosen.url;
    } else url = checkRelayerUrl(relayerInput, Boolean(this.dev.tornadoLocalRelayer));
    const info = await relayerStatus(url, this.priceAgent, this.dev.tornadoRelayerNames || this.dev.tornadoLocalRelayer ? 1 : c.netId);
    const fee = relayerFee(note.pool, info.feePercent, await eth.gasPrice(), c.withdrawGas);
    return { ...base, mode: 'relayer' as const, relayer: info.rewardAccount, relayerUrl: url, fee: formatAmount(fee, 18), feeFrom: 'note' as const, receive: formatAmount(total - fee, 18) };
  }

  /** Builds the proof for a note: the pool's deposit list, the Merkle path, the zero-knowledge proof. */
  protected async tornadoProve(note: TornadoNote, keys: { nullifier: string; secret: string }, recipient: string, relayer: string, fee: bigint, say: (m: string) => void) {
    const chain = chainOfNote(note);
    const eth = this.tornadoClient(chain);
    const address = this.poolAddress(note.pool, chain);
    const leaves = await this.tornadoStore.leaves(note.pool, address, eth, { seed: chain !== 'eth' || !this.dev.tornadoPools, agent: this.priceAgent, progress: say, chain });
    const leafIndex = leaves.findIndex((l) => l.toLowerCase() === note.commitment.toLowerCase());
    if (leafIndex < 0) throw new Error('The deposit isn\'t confirmed on the chain yet. Try again after it confirms.');
    const { proof, args } = await runTornado('prove', { leaves, leafIndex, ...keys, recipient, relayer, fee: fee.toString() }, (stage) => {
      say(stage === 'tree' ? `Building the Merkle tree… ${leaves.length} deposits, so this can take a few minutes.` : 'Making the zero-knowledge proof… The screen may seem to freeze. Don\'t close the app.');
    });
    const known = tornadoAbi.decodeFunctionResult('isKnownRoot', await eth.call(address, tornadoAbi.encodeFunctionData('isKnownRoot', [args[0]])));
    if (!known[0]) throw new Error('The deposit records don\'t match the chain, so this was stopped. Your coins are safe. Try again.');
    return { proof, args, address };
  }

  /** delayMinutes: any value other than 0 means later, at a random time 1 to 24 hours from now. */
  async tornadoWithdraw(noteId: string, recipientInput: string, relayerInput: string, password: string, opts: { delayMinutes?: number } = {}) {
    const say = (m: string) => this.emit('tornado-progress', m);
    const tor = this.tornadoStore;
    const store = await tor.read();
    const note = store.notes.find((n) => n.id === noteId);
    if (!note) throw new Error('No such deposit.');
    if (note.status === 'scheduled' || note.status === 'sending') throw new Error('This deposit is not ready to withdraw.');
    const chain = chainOfNote(note);
    const eth = this.tornadoClient(chain);
    const later = (Number(opts.delayMinutes) || 0) > 0;
    if (later && !relayerInput.trim()) throw new Error('A withdrawal can only wait for later through a relayer.');
    const secrets = await this.vault.open(password);
    // A new address of this wallet: made now, so it is kept even if the withdrawal stops midway.
    const madeHere = recipientInput.trim() === 'new';
    if (madeHere) recipientInput = (await this.ethAddressNew()).address;
    const quote = await this.tornadoWithdrawQuote(noteId, recipientInput, relayerInput, { madeHere });
    if (quote.mode === 'relayer') relayerInput = quote.relayerUrl;
    const address = this.poolAddress(note.pool, chain);
    const keys = noteSecrets(secrets.tronMnemonic, note.index);
    const [{ commitment, nullifierHash }] = await runTornado('commit', { notes: [keys] });
    if (commitment !== note.commitment) throw new Error('This deposit is not from this seed.');
    const spent = tornadoAbi.decodeFunctionResult('isSpent', await eth.call(address, tornadoAbi.encodeFunctionData('isSpent', [nullifierHash])));
    if (spent[0]) { note.status = 'withdrawn'; await tor.write(store); throw new Error('This deposit was already withdrawn.'); }
    const relayer = quote.mode === 'relayer' ? quote.relayer as string : `0x${'0'.repeat(40)}`;
    const fee = quote.mode === 'relayer' ? parseAmount(quote.fee, 18) : 0n;

    if (later) {
      // The proof is made then, not now: a proof's root expires after 30 more deposits, which a day can bring.
      // The note's keys wait sealed with the wallet's records; the relayer gets it at a random later time.
      const at = randomLater();
      note.status = 'scheduled'; note.scheduledKind = 'withdraw'; note.at = at; note.recipient = quote.recipient; delete note.problem;
      await tor.write(store);
      const entry = { id: note.id, kind: 'send-on' as const, at, keys, to: quote.recipient, url: relayerInput, ...(madeHere ? { madeHere: true } : {}) };
      await this.records.write(this.tornadoLaterPath, [...(await this.tornadoLater()).filter((e) => e.id !== note.id), entry]);
      this.armTornado(entry);
      return note;
    }

    const { proof, args } = await this.tornadoProve(note, keys, quote.recipient, relayer, fee, say);
    note.status = 'withdrawing';
    note.recipient = quote.recipient;
    await tor.write(store);
    say('Sending the withdrawal…');
    try {
      let txHash: string;
      if (quote.mode === 'relayer') {
        txHash = await relayerSubmit(await relayerStatus(checkRelayerUrl(relayerInput, Boolean(this.dev.tornadoLocalRelayer)), this.priceAgent, this.dev.tornadoLocalRelayer ? 1 : TORNADO_CHAINS[chain].netId), address, proof, args, this.priceAgent, this.dev.tornadoLocalRelayer ? 200 : 5000);
      } else {
        const draft = await eth.draftCall(address, 0n, TORNADO_CHAINS[chain].withdrawGas);
        const data = tornadoAbi.encodeFunctionData('withdraw', [proof, args[0], args[1], quote.recipient, relayer, 0n, 0n]);
        txHash = await eth.send({ ...draft, data }, this.tornadoSigner(chain, secrets.tronMnemonic));
      }
      note.status = 'withdrawn';
      note.withdrawTx = txHash;
    } catch (e) {
      note.status = 'deposited';
      await tor.write(store);
      throw e;
    }
    await tor.write(store);
    this.emit('balance-changed');
    return note;
  }

  // ---- Tornado: things that go out later ----

  protected get tornadoLaterPath(): string { return path.join(this.dir, 'tornado-later.json'); }
  protected tornadoTimers = new Map<string, ReturnType<typeof setTimeout>>();
  protected async tornadoLater(): Promise<any[]> {
    const j = await this.records.read(this.tornadoLaterPath).catch(() => undefined);
    return Array.isArray(j) ? j.filter((e: any) => typeof e?.id === 'string' && Number.isFinite(e?.at) && (e.kind === 'withdraw' || e.kind === 'deposit' || e.kind === 'send-on')) : [];
  }
  protected armTornado(e: any): void {
    clearTimeout(this.tornadoTimers.get(e.id));
    const wait = Math.max(e.at - Date.now(), 5_000 + Math.random() * 55_000);
    const t = setTimeout(() => void this.fireTornado(e.id), wait);
    (t as any).unref?.();
    this.tornadoTimers.set(e.id, t);
  }
  protected async tornadoDone(id: string, update: (n: TornadoNote) => void): Promise<void> {
    const store = await this.tornadoStore.read();
    const note = store.notes.find((n) => n.id === id);
    if (note) { update(note); await this.tornadoStore.write(store); }
    await this.records.write(this.tornadoLaterPath, (await this.tornadoLater()).filter((e) => e.id !== id)).catch(() => undefined);
    this.emit('balance-changed');
  }
  protected async fireTornado(id: string): Promise<void> {
    this.tornadoTimers.delete(id);
    const e = (await this.tornadoLater()).find((x) => x.id === id);
    if (!e || !this.eth) return;
    const retry = (minutes = 5) => { const t = setTimeout(() => void this.fireTornado(id), minutes * 60_000); (t as any).unref?.(); this.tornadoTimers.set(id, t); };
    const note = (await this.tornadoStore.read()).notes.find((n) => n.id === id);
    const chain: TornadoChain = note ? chainOfNote(note) : 'eth';
    let eth: EthClient;
    try { eth = this.tornadoClient(chain); } catch { return; }
    if (e.kind === 'deposit') {
      try {
        await eth.sendRaw(e.raw);
        await this.tornadoDone(id, (n) => { n.status = 'deposited'; n.txHash = e.hash; delete n.at; delete n.scheduledKind; });
      } catch (err) {
        // Another send from this address took its place in line: nothing was spent, and the note goes.
        if (/nonce too low|replacement|already used/i.test((err as Error).message)) {
          const store = await this.tornadoStore.read();
          store.notes = store.notes.filter((n) => n.id !== id);
          await this.tornadoStore.write(store);
          await this.records.write(this.tornadoLaterPath, (await this.tornadoLater()).filter((x) => x.id !== id)).catch(() => undefined);
          this.emit('balance-changed');
          return;
        }
        retry();
      }
      return;
    }
    if (e.kind === 'send-on') {
      // Proven now, sent now, through a relayer picked now (or the one chosen at the time).
      if (!note) { await this.records.write(this.tornadoLaterPath, (await this.tornadoLater()).filter((x) => x.id !== id)).catch(() => undefined); return; }
      const say = (m: string) => this.emit('tornado-progress', m);
      try {
        const address = this.poolAddress(note.pool, chain);
        const [{ nullifierHash }] = await runTornado('commit', { notes: [e.keys] });
        const spent = tornadoAbi.decodeFunctionResult('isSpent', await eth.call(address, tornadoAbi.encodeFunctionData('isSpent', [nullifierHash])));
        if (spent[0]) { await this.tornadoDone(id, (n) => { n.status = 'withdrawn'; delete n.at; delete n.scheduledKind; }); return; }
        const quote = await this.tornadoWithdrawQuote(id, e.to, e.url || 'auto', { madeHere: e.madeHere === true });
        if (quote.mode !== 'relayer') throw new Error('No relayer.');
        // Nobody reviews this fee: past 2% of the amount (a busy network or a greedy relayer), wait and try again.
        const fee = parseAmount(quote.fee, 18);
        if (fee * 100n > denomination(note.pool) * UNATTENDED_FEE_PERCENT) throw new Error(`The relayer's fee is over ${UNATTENDED_FEE_PERCENT}% right now.`);
        const { proof, args } = await this.tornadoProve(note, e.keys, quote.recipient, quote.relayer as string, fee, say);
        this.renewTorRoute('ETH');
        const hash = await relayerSubmit(await relayerStatus(quote.relayerUrl, this.priceAgent, this.dev.tornadoLocalRelayer ? 1 : TORNADO_CHAINS[chain].netId), address, proof, args, this.priceAgent, this.dev.tornadoLocalRelayer ? 200 : 5000);
        await this.tornadoDone(id, (n) => { n.status = 'withdrawn'; n.withdrawTx = hash; n.recipient = quote.recipient; delete n.at; delete n.scheduledKind; delete n.problem; });
      } catch (err) {
        const store = await this.tornadoStore.read();
        const n = store.notes.find((x) => x.id === id);
        if (n) { n.problem = `The send-on will be tried again: ${(err as Error).message}`.slice(0, 300); await this.tornadoStore.write(store); }
        retry(20);
      }
      return;
    }
    try {
      const spent = tornadoAbi.decodeFunctionResult('isSpent', await eth.call(e.contract, tornadoAbi.encodeFunctionData('isSpent', [e.args[1]])));
      if (spent[0]) { await this.tornadoDone(id, (n) => { n.status = 'withdrawn'; delete n.at; delete n.scheduledKind; }); return; }
      const known = tornadoAbi.decodeFunctionResult('isKnownRoot', await eth.call(e.contract, tornadoAbi.encodeFunctionData('isKnownRoot', [e.args[0]])));
      if (!known[0]) {
        // Too many deposits since the proof was made: it no longer counts. The coins are still in the pool.
        await this.tornadoDone(id, (n) => { n.status = 'deposited'; delete n.at; delete n.scheduledKind; n.problem = 'The scheduled withdrawal waited too long and its proof expired. Nothing was lost: withdraw again.'; });
        return;
      }
      this.renewTorRoute('ETH');
      const hash = await relayerSubmit(await relayerStatus(e.url, this.priceAgent), e.contract, e.proof, e.args, this.priceAgent, this.dev.tornadoLocalRelayer ? 200 : 5000);
      await this.tornadoDone(id, (n) => { n.status = 'withdrawn'; n.withdrawTx = hash; delete n.at; delete n.scheduledKind; });
    } catch { retry(); }
  }
  protected armAllTornado = async (): Promise<void> => { for (const e of await this.tornadoLater()) this.armTornado(e); };

  /** Deposits for an amount that isn't one of the pools' own: as many fixed amounts as make it up. */
  async tornadoSplitPrepare(amountInput: string, spread: boolean) {
    const { eth } = this.session();
    const amount = parseAmount(amountInput, 18);
    const plan = splitPlan(amount, Object.keys(this.tornadoPoolMap()));
    if (!plan.pools.length) throw new Error(`The smallest deposit is ${Object.keys(this.tornadoPoolMap()).sort((a, b) => Number(a) - Number(b))[0]} ETH.`);
    const total = plan.pools.reduce((s2, p) => s2 + denomination(p), 0n);
    const one = await eth.draftCall(this.poolAddress(plan.pools[0]), 0n, DEPOSIT_GAS);
    const fees = one.expectedFee * BigInt(plan.pools.length);
    if (total + one.maxCost * BigInt(plan.pools.length) > await eth.nativeBalance()) throw new Error('Not enough ETH for these deposits and their fees.');
    const preview = this.storePreview({ asset: 'ETH', to: 'tornado', amount: total, fee: fees, tornadoSplit: { pools: plan.pools, spread } });
    return { id: preview.id, pools: plan.pools, spread, total: formatAmount(total, 18), left: formatAmount(plan.left, 18), fee: formatAmount(fees, 18) };
  }

  /**
   * Makes each deposit's record, then sends the first now. Spread: the rest are signed now (in order, one after
   * another) and go out at random times over the next hours; otherwise all go now.
   */
  async tornadoSplitConfirm(id: string, password: string): Promise<TornadoNote[]> {
    const { eth } = this.session();
    const preview = this.previews.get(id);
    if (!preview?.tornadoSplit || preview.expires < Date.now()) throw new Error('The review expired. Try again.');
    const secrets = await this.vault.open(password);
    this.previews.delete(id);
    const wallet = deriveEthAccount(secrets.tronMnemonic).wallet;
    const store = await this.tornadoStore.read();
    let index = store.next;
    const made: TornadoNote[] = [];
    let nonce = await eth.pendingNonce();
    let at = Date.now();
    const later: any[] = [];
    for (const [i, pool] of preview.tornadoSplit.pools.entries()) {
      const contract = this.poolAddress(pool);
      let commitment = '';
      for (;; index++) {
        [{ commitment }] = await runTornado('commit', { notes: [noteSecrets(secrets.tronMnemonic, index)] });
        const used = tornadoAbi.decodeFunctionResult('commitments', await eth.call(contract, tornadoAbi.encodeFunctionData('commitments', [commitment])));
        if (!used[0]) break;
      }
      const draft = await eth.draftCall(contract, denomination(pool), DEPOSIT_GAS);
      const note: TornadoNote = { id: randomUUID(), pool, index, commitment, status: 'sending', createdAt: Date.now() };
      index++;
      store.next = index;
      store.notes.unshift(note);
      await this.tornadoStore.write(store);
      const call = { ...draft, data: tornadoAbi.encodeFunctionData('deposit', [commitment]) };
      if (i === 0 || !preview.tornadoSplit.spread) {
        note.txHash = await eth.send(call, wallet).catch(async (e) => { store.notes = store.notes.filter((n) => n.id !== note.id); await this.tornadoStore.write(store); throw e; });
        note.status = 'deposited';
        nonce += 1n; // the one just sent took this place in line
      } else {
        // Between half an hour and four hours apart.
        at += Math.round((30 + Math.random() * 210) * 60_000);
        const { raw, hash } = await eth.signOnly(call, wallet, nonce++);
        note.status = 'scheduled'; note.scheduledKind = 'deposit'; note.at = at;
        later.push({ id: note.id, kind: 'deposit', at, raw, hash });
      }
      await this.tornadoStore.write(store);
      made.push(note);
    }
    if (later.length) {
      await this.records.write(this.tornadoLaterPath, [...(await this.tornadoLater()), ...later]);
      for (const e of later) this.armTornado(e);
    }
    this.emit('balance-changed');
    return made;
  }

  /** After restoring from the seed: looks through the pools for this seed's deposits. */
  async tornadoRecover(password: string) {
    const { eth } = this.session();
    const say = (m: string) => this.emit('tornado-progress', m);
    const secrets = await this.vault.open(password);
    const tor = this.tornadoStore;
    const store = await tor.read();
    const limit = store.next + 30;
    const keys = Array.from({ length: limit }, (_, i) => noteSecrets(secrets.tronMnemonic, i));
    const commits: { commitment: string; nullifierHash: string }[] = await runTornado('commit', { notes: keys });
    let found = 0;
    for (const [pool, address] of Object.entries(this.tornadoPoolMap())) {
      const leaves = new Set((await tor.leaves(pool, address, eth, { seed: !this.dev.tornadoPools, agent: this.priceAgent, progress: say })).map((l) => l.toLowerCase()));
      for (let index = 0; index < limit; index++) {
        const c = commits[index];
        if (!leaves.has(c.commitment.toLowerCase()) || store.notes.some((n) => n.commitment === c.commitment)) continue;
        const spent = tornadoAbi.decodeFunctionResult('isSpent', await eth.call(address, tornadoAbi.encodeFunctionData('isSpent', [c.nullifierHash])));
        store.notes.push({ id: randomUUID(), pool, index, commitment: c.commitment, status: spent[0] ? 'withdrawn' : 'deposited', createdAt: Date.now() });
        store.next = Math.max(store.next, index + 1);
        found++;
      }
    }
    await tor.write(store);
    return { found };
  }

  // ---- sending ----

  /** Bitcoin coins one by one: amount, whether confirmed, your label, frozen or not. Largest first. */
  async btcCoins() {
    const { btc } = this.session();
    if (this.torNotReady) throw new Error('Tor is connecting. Try again once it connects.');
    const [coins, notes] = await Promise.all([btc.coins(), this.btcCoinNotes()]);
    const frozen = new Set(notes.frozen);
    return coins.sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0)).map((u) => ({
      id: coinId(u), amount: formatAmount(u.value, 8), address: u.address, change: u.chain === 1, confirmed: u.confirmed,
      label: notes.labels[coinId(u)] ?? '', frozen: frozen.has(coinId(u)),
    }));
  }

  /** Sets a coin's label and whether it's frozen. */
  async btcCoinSet(id: string, change: { label?: string; frozen?: boolean }) {
    this.session();
    if (typeof id !== 'string' || !COIN_ID.test(id)) throw new Error('Not a coin.');
    const notes = await this.btcCoinNotes();
    if (typeof change.label === 'string') {
      const label = change.label.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 80);
      if (label) notes.labels[id] = label; else delete notes.labels[id];
    }
    if (typeof change.frozen === 'boolean') notes.frozen = change.frozen ? [...new Set([...notes.frozen, id])] : notes.frozen.filter((k) => k !== id);
    await fs.mkdir(this.dir, { recursive: true });
    await this.records.write(this.btcCoinsPath, notes);
    return { ok: true };
  }

  async prepareSend(asset: Asset, to: string, amountInput: string, opts: { coins?: string[]; fromMixed?: boolean; fromAddress?: number; memo?: string; payjoin?: { pj?: unknown; pjos?: unknown } } = {}) {
    const { tron, monero, btc, eth, dash } = this.session();
    if (this.torNotReady) throw new Error('Tor is connecting. Try again once it connects.');
    const address = to.trim();
    const isMax = amountInput.trim().toLowerCase() === 'max';
    const decimals = DECIMALS[asset];
    const warnings: string[] = [];
    let preview: Preview;

    if (this.accounts.has(asset)) {
      const draft = await this.accounts.get(asset)!.draft(address, isMax ? 'max' : parseAmount(amountInput, decimals), typeof opts.memo === 'string' ? opts.memo : undefined);
      preview = this.storePreview({ asset, to: draft.to, amount: draft.amount, fee: draft.fee, account: { asset, draft } });
    } else if (asset === 'ARRR') {
      if (!this.arrr) throw new Error('Pirate Chain is not available on this device.');
      if (!isArrrAddress(address)) throw new Error('Not a Pirate Chain address. It should start with zs1 or pirate1.');
      if (address === this.arrr.receive) throw new Error('You cannot send to your own address.');
      const draft = await this.arrr.draft(address, isMax ? 'max' : parseAmount(amountInput, decimals));
      preview = this.storePreview({ asset, to: address, amount: draft.value, fee: draft.fee, arrr: draft });
    } else if (asset === 'ZANO') {
      if (!this.zano) throw new Error('Zano is not available on this device.');
      if (!isZanoAddress(address)) throw new Error('Not a Zano address.');
      if (address === this.zano.receive) throw new Error('You cannot send to your own address.');
      const draft = await this.zano.draft(address, isMax ? 'max' : parseAmount(amountInput, decimals));
      preview = this.storePreview({ asset, to: address, amount: draft.value, fee: draft.fee, zano: draft });
    } else if (asset === 'KSR') {
      if (!this.ksr) throw new Error('Kusari is not available on this device.');
      if (!isKsrAddress(address)) throw new Error('Not a Kusari address. It should start with K.');
      if (address === this.ksr.receive) throw new Error('You cannot send to your own address.');
      const draft = await this.ksr.draft(address, isMax ? 'max' : parseAmount(amountInput, decimals));
      preview = this.storePreview({ asset, to: address, amount: draft.value, fee: draft.fee, ksr: draft });
    } else if (asset === 'ZEC') {
      if (!this.zec) throw new Error('Zcash is not available on this device.');
      if (!isZecAddress(address)) throw new Error('Not a Zcash address. Only addresses starting with u1, zs1 or t1 can be used.');
      const receive = this.zec.receive;
      if (address === receive?.unified || address === receive?.transparent) throw new Error('You cannot send to your own address.');
      const draft = await this.zec.draft(address, isMax ? 'max' : parseAmount(amountInput, decimals));
      if (/^t/.test(address)) warnings.push('Sending to a transparent address makes the recipient and amount public on the chain.');
      preview = this.storePreview({ asset, to: address, amount: draft.value, fee: draft.fee, zec: draft });
    } else if (asset === 'SOL') {
      if (!isSolAddress(address)) throw new Error('Not a Solana address.');
      if (address === this.sol!.receiveAddress) throw new Error('You cannot send to your own address.');
      const draft = await this.sol!.draft(address, isMax ? 'max' : parseAmount(amountInput, decimals));
      preview = this.storePreview({ asset, to: address, amount: draft.amount, fee: draft.fee, sol: draft });
    } else if (isSpl(asset)) {
      if (!isSolAddress(address)) throw new Error('Not a Solana address.');
      const draft = await this.sol!.draftUsdt(address, isMax ? 'max' : parseAmount(amountInput, decimals), asset);
      if (draft.create) warnings.push(`The receiver has no ${SPL_TOKENS[asset].symbol} account on Solana yet, so the fee includes a deposit of about 0.002 SOL to open one.`);
      preview = this.storePreview({ asset, to: address, amount: draft.amount, fee: draft.fee, solUsdt: draft });
    } else if (asset === 'BCH') {
      if (!isBchAddress(address)) throw new Error('Not a Bitcoin Cash address. Use the CashAddr form, starting with bitcoincash:q or q. Old-style addresses look like Bitcoin ones, so they are refused.');
      const to = normalBchAddress(address);
      if (to === this.bch!.receiveAddress) throw new Error('You cannot send to your own address.');
      const draft = await this.bch!.draft(to, isMax ? 'max' : parseAmount(amountInput, decimals));
      preview = this.storePreview({ asset, to, amount: draft.amount, fee: draft.fee, bch: draft });
    } else if (asset === 'DCR') {
      if (!isDcrAddress(address)) throw new Error('Not a Decred address. Use a mainnet address starting with Ds.');
      if (address === this.dcr!.receiveAddress || address === this.dcrMixed?.receiveAddress) throw new Error('You cannot send to your own address.');
      // From the mixed account alone, never together with unmixed coins.
      const client = opts.fromMixed === true ? this.dcrMixed : this.dcr;
      if (!client) throw new Error('Mixed DCR is not available.');
      const draft = await client.draft(address, isMax ? 'max' : parseAmount(amountInput, decimals));
      // Change from mixed coins goes back to the regular account, to be mixed again (as dcrwallet's --changeaccount
      // does), so it never ties this payment to the next mixed one.
      if (opts.fromMixed === true && draft.change > 0n) {
        const i = Math.max(this.dcr!.changeTarget().index, this.dcrAddrs.change);
        Object.assign(draft, { changeAddress: this.dcr!.addressAt(1, i), changeIndex: i, changePath: DCR_PATH });
      }
      preview = this.storePreview({ asset, to: address, amount: draft.amount, fee: draft.fee, ...(opts.fromMixed === true ? { dcrMixed: draft } : { dcr: draft }) });
    } else if (asset === 'DOGE') {
      if (!isDogeAddress(address)) throw new Error('Not a Dogecoin address.');
      if (address === this.doge!.receiveAddress) throw new Error('You cannot send to your own address.');
      const draft = await this.doge!.draft(address, isMax ? 'max' : parseAmount(amountInput, decimals));
      preview = this.storePreview({ asset, to: address, amount: draft.amount, fee: draft.fee, doge: draft });
    } else if (asset === 'FIRO' && isSparkAddress(address)) {
      // To a Spark address: paid from the private balance, so the amount and both addresses stay hidden.
      if (!this.spark) throw new Error('Private (Spark) FIRO isn\'t available on this device.');
      const draft = await this.spark.draft(address, isMax ? 'max' : parseAmount(amountInput, decimals));
      preview = this.storePreview({ asset, to: address, amount: draft.amount, fee: draft.fee, spark: draft });
    } else if (asset === 'FIRO') {
      if (!isFiroAddress(address)) throw new Error('Not a Firo address. Use a transparent address starting with a, or a Spark address starting with sm1.');
      const want = isMax ? 'max' as const : parseAmount(amountInput, decimals);
      const pub = await this.firo!.getBalance().catch(() => null);
      const priv = this.spark?.balance();
      // Public coins pay first. Only when they can't cover it does the private balance pay, which makes it public.
      if (want !== 'max' && pub && pub.spendable < want && priv && priv.spendable >= want) {
        const draft = await this.spark!.draft(address, want);
        warnings.push('This is paid from your private (Spark) balance. Sending to a transparent address makes this amount and the receiving address public.');
        preview = this.storePreview({ asset, to: address, amount: draft.amount, fee: draft.fee, spark: draft });
      } else {
        if (address === this.firo!.receiveAddress) throw new Error('You cannot send to your own address.');
        const draft = await this.firo!.draft(address, want);
        warnings.push('This is paid from your public FIRO: the addresses and the amount are visible on the chain. Payments to a Spark address (sm1…) come from the private balance and stay hidden.');
        preview = this.storePreview({ asset, to: address, amount: draft.amount, fee: draft.fee, firo: draft });
      }
    } else if (asset === 'DASH') {
      if (!isDashAddress(address)) throw new Error('Not a Dash address. Only addresses starting with X can be used.');
      if (address === dash.receiveAddress) throw new Error('You cannot send to your own address.');
      const draft = await dash.draft(address, isMax ? 'max' : parseAmount(amountInput, decimals));
      preview = this.storePreview({ asset, to: address, amount: draft.amount, fee: draft.fee, dash: draft });
    } else if (asset === 'LTC' && isMwebAddress(address)) {
      // To an MWEB address: paid from the private balance, so amount and both addresses stay hidden.
      if (!this.mweb) throw new Error('Private (MWEB) Litecoin isn\'t available on this device.');
      const draft = await this.mweb.draft(address, isMax ? 'max' : parseAmount(amountInput, decimals), Number(await this.ltc!.feeRate()) * 1000);
      preview = this.storePreview({ asset, to: address, amount: draft.amount, fee: draft.fee, mweb: draft });
    } else if (asset === 'LTC') {
      if (!isLtcAddress(address)) throw new Error('Not a Litecoin address. Use one starting with ltc1, L or M. Addresses starting with 3 look like Bitcoin ones, so they are refused.');
      if (address === this.ltc!.receiveAddress) throw new Error('You cannot send to your own address.');
      const want = isMax ? 'max' as const : parseAmount(amountInput, decimals);
      const pub = await this.ltc!.getBalance().catch(() => null);
      const priv = this.mweb?.balance();
      // Public coins pay first. Only when they can't cover it does the private balance pay, as a peg-out.
      if (want !== 'max' && pub && pub.spendable < want && priv && priv.spendable >= want) {
        const draft = await this.mweb!.draft(address, want, Number(await this.ltc!.feeRate()) * 1000);
        warnings.push('This is paid from your private (MWEB) balance. Sending to an ordinary address makes this amount and the receiving address public.');
        preview = this.storePreview({ asset, to: address, amount: draft.amount, fee: draft.fee, mweb: draft });
      } else {
        const draft = await this.ltc!.draft(address, want);
        preview = this.storePreview({ asset, to: address, amount: draft.amount, fee: draft.fee, ltc: draft });
      }
    } else if (asset === 'BTC') {
      const silent = isSilentAddress(address);
      if (!isBtcAddress(address) && !silent) throw new Error('Not a Bitcoin address.');
      if (silent && address.toLowerCase().startsWith('tsp')) throw new Error('This is a test-network Silent Payments address.');
      if (silent) warnings.push('This is a Silent Payments address: the payment goes to a new address made from it and the coins you spend, so nobody can tie it to this sp1 address. The recipient\'s wallet must scan for Silent Payments to see it.');
      if (opts.fromMixed === true) {
        // Only mixed coins pay, and the change stays in the CoinJoin account.
        if (!this.btcMixed) throw new Error('CoinJoin is not available.');
        const draft = await this.btcMixed.draft(address, isMax ? 'max' : parseAmount(amountInput, decimals));
        if (draft.fee * 2n > draft.amount) warnings.push('The fee is more than half of the amount being sent.');
        if (draft.inputs.length > 1) warnings.push('This spends more than one mixed coin together, which shows they belong to one person. Sending each coin on its own keeps them apart.');
        preview = this.storePreview({ asset, to: address, amount: draft.amount, fee: draft.fee, btcMixed: draft });
      } else {
        const use = Array.isArray(opts.coins) ? opts.coins.filter((c) => typeof c === 'string' && COIN_ID.test(c)) : [];
        const draft = await btc.draft(address, isMax ? 'max' : parseAmount(amountInput, decimals), { use, frozen: new Set((await this.btcCoinNotes()).frozen) });
        if (draft.fee * 2n > draft.amount) warnings.push('The fee is more than half of the amount being sent.');
        const payjoin = opts.payjoin ? this.payjoinTarget(opts.payjoin, draft, silent, warnings) : undefined;
        preview = this.storePreview({ asset, to: address, amount: draft.amount, fee: draft.fee, btc: draft, ...(payjoin ? { payjoin } : {}) });
      }
    } else if (isEvm(asset)) {
      if (!isEthAddress(address)) throw new Error('Not an Ethereum address. Only addresses starting with 0x can be used.');
      // From one of the extra Ethereum addresses: that address pays, fee included, and nothing else is touched.
      const from = Number.isInteger(opts.fromAddress) && (opts.fromAddress as number) >= 0 && (asset === 'ETH' || asset === 'USDTE') ? opts.fromAddress as number : undefined;
      if (from !== undefined && !(await this.ethExtraList()).includes(from)) throw new Error('That address is not in this wallet.');
      const client = from !== undefined ? this.ethExtraClient(from) : this.evm(asset);
      if (address.toLowerCase() === client.address.toLowerCase()) throw new Error('You cannot send to your own address.');
      if (from === undefined && address.toLowerCase() === eth.address.toLowerCase()) throw new Error('You cannot send to your own address.');
      if (asset === 'ETH' || asset === 'USDTE') {
        const mine = [eth.address, ...(await this.ethExtraList()).map((n) => this.ethExtraClient(n).address)];
        if (mine.some((a) => a.toLowerCase() === address.toLowerCase())) warnings.push('This is another address of this wallet. Sending between them ties the two together on the chain for anyone to see.');
      }
      const chain = chainOf(asset);
      const draft = await client.draft(asset, address, isMax ? 'max' : parseAmount(amountInput, decimals));
      if (asset === chain.native && isMax) warnings.push(`If the actual fee is lower than expected, a little ${chain.symbol} stays behind.`);
      if (chain.id !== 1n) warnings.push(`This sends on ${chain.name}. Make sure the receiver accepts ${chain.name}: the same 0x address on another network won't show it.`);
      preview = this.storePreview({ asset, to: address, amount: draft.amount, fee: draft.expectedFee, eth: draft, ethFrom: from });
    } else if (asset === 'XMR') {
      if (!(await monero.isValidAddress(address))) throw new Error('Not a Monero address on this network.');
      const amount = isMax ? 'max' as const : parseAmount(amountInput, decimals);
      const draft = await monero.draft(address, amount);
      preview = this.storePreview({ asset, to: address, amount: draft.amount, fee: draft.fee, monero: draft });
    } else {
      if (!isTronAddress(address)) throw new Error('Not a Tron address. Only addresses starting with T can be used.');
      if (address === tron.address) throw new Error('You cannot send to your own address.');
      const trx = await tron.getTrxBalance();
      if (asset === 'USDT') {
        const usdt = await tron.getUsdtBalance();
        const amount = isMax ? usdt : parseAmount(amountInput, decimals);
        if (amount <= 0n) throw new Error('No USDT to send.');
        if (amount > usdt) throw new Error('Not enough USDT.');
        const fee = await tron.estimateFee({ asset, to: address, amount });
        if (fee.feeSun > trx) {
          throw new Error(`Not enough TRX for the fee. About ${formatAmount(fee.feeSun, 6)} TRX is needed, and there is ${formatAmount(trx, 6)} TRX.`);
        }
        if (fee.recipientIsNew) warnings.push('The receiving address isn\'t activated yet, so the fee may be higher.');
        preview = this.storePreview({
          asset, to: address, amount, fee: fee.feeSun,
          tron: { asset, to: address, amount, feeLimit: fee.feeLimitSun },
        });
      } else {
        const probe = await tron.estimateFee({ asset: asset as 'TRX', to: address, amount: 1n });
        const amount = isMax ? trx - probe.feeSun : parseAmount(amountInput, decimals);
        if (amount <= 0n) throw new Error('No TRX left to send after the fee.');
        if (amount + probe.feeSun > trx) throw new Error('Not enough TRX to cover the amount and fee.');
        if (probe.recipientIsNew) warnings.push('This is a new address, so an activation fee is included.');
        preview = this.storePreview({ asset, to: address, amount, fee: probe.feeSun, tron: { asset: asset as 'TRX', to: address, amount } });
      }
    }
    // Coins spent together are tied together on the chain; say so, unless the person picked the coins themselves.
    const utxoDraft: { inputs?: unknown[] } | undefined = preview.btc ?? preview.ltc ?? preview.doge ?? preview.dcr ?? preview.dcrMixed ?? preview.bch ?? preview.dash ?? preview.firo;
    const picked = Array.isArray(opts.coins) && opts.coins.length > 0;
    if (!picked && (utxoDraft?.inputs?.length ?? 0) > 1) warnings.push(`This spends ${utxoDraft!.inputs!.length} of your coins together, which shows on the chain that they belong to one person. Sending a smaller amount that one coin covers, or choosing coins yourself, keeps them apart.`);
    // A look-alike of an address used before is the mark of address poisoning.
    const imitated = lookalikeOf(address, [...(await this.recipients()), ...Object.values(await this.addresses().catch(() => ({}))).filter((x): x is string => typeof x === 'string')]);
    const lookalike = imitated ? { address: imitated } : null;
    if (imitated) warnings.unshift(`Careful: this address starts and ends like ${imitated}, which you used before, but the middle is different. Scammers send tiny amounts from look-alike addresses so one gets copied from the history. Check every character before sending.`);
    return {
      id: preview.id, asset, to: address, lookalike,
      amount: formatAmount(preview.amount, decimals),
      fee: formatAmount(preview.fee, preview.account ? DECIMALS[ACCOUNT_COINS[asset]!.feeAsset] : preview.eth ? 18 : asset === 'XMR' ? 12 : asset === 'ZANO' || asset === 'KSR' ? 12 : asset === 'SOL' || isSpl(asset) ? 9 : asset === 'DOGE' || asset === 'DCR' || asset === 'BCH' || asset === 'LTC' || asset === 'BTC' || asset === 'DASH' || asset === 'FIRO' || asset === 'ZEC' || asset === 'ARRR' ? 8 : 6),
      feeAsset: preview.account ? ACCOUNT_COINS[asset]!.feeAsset : preview.eth ? chainOf(preview.eth.asset).native : isSpl(asset) ? 'SOL' : asset === 'SOL' || asset === 'DCR' || asset === 'DOGE' || asset === 'BCH' || asset === 'LTC' || asset === 'XMR' || asset === 'BTC' || asset === 'DASH' || asset === 'FIRO' || asset === 'ZEC' || asset === 'ZANO' || asset === 'KSR' || asset === 'ARRR' ? asset : 'TRX',
      feeIsEstimate: asset !== 'SOL' && !isSpl(asset) && asset !== 'DCR' && asset !== 'DOGE' && asset !== 'BCH' && asset !== 'LTC' && asset !== 'XMR' && asset !== 'BTC' && asset !== 'DASH' && asset !== 'FIRO' && asset !== 'ZEC' && asset !== 'ZANO' && asset !== 'KSR' && asset !== 'ARRR',
      ...(preview.account?.draft?.comment ? { memo: String(preview.account.draft.comment), memoKind: 'comment' } : {}),
      ...(preview.payjoin ? { payjoin: true } : {}),
      warnings,
    };
  }

  /**
   * Speeds up a waiting Bitcoin transaction: a send from this wallet is replaced with one paying more (RBF), a
   * payment to it is pulled along by spending its coins with a higher fee (CPFP). Confirmed like any send.
   */
  async btcSpeedUp(txid: string) {
    const { btc } = this.session();
    if (!/^[0-9a-f]{64}$/.test(txid)) throw new Error('Not a transaction ID.');
    const mixed = this.btcMixed;
    let draft: BtcDraft; let fromMixed = false;
    if (btc.canReplace(txid)) draft = await btc.bumpDraft(txid);
    else if (mixed?.canReplace(txid)) { draft = await mixed.bumpDraft(txid); fromMixed = true; }
    else draft = await btc.cpfpDraft(txid);
    const preview = this.storePreview({ asset: 'BTC', to: draft.to, amount: draft.amount, fee: draft.fee, ...(fromMixed ? { btcMixed: draft } : { btc: draft }) });
    const warnings = [draft.replaces
      ? 'This replaces your waiting send with the same one paying a higher fee, taken from its change. Only one of the two can confirm.'
      : 'This sends the waiting coins to your own wallet with a fee high enough for both transactions together, so miners take them sooner.'];
    return {
      id: preview.id, asset: 'BTC', to: draft.to, lookalike: null, speedUp: draft.replaces ? 'replace' : 'cpfp',
      amount: formatAmount(draft.amount, 8), fee: formatAmount(draft.fee, 8), feeAsset: 'BTC', feeIsEstimate: false, warnings,
    };
  }

  protected storePreview(p: Omit<Preview, 'id' | 'expires'>): Preview {
    const preview = { ...p, id: randomUUID(), expires: Date.now() + PREVIEW_TTL_MS };
    this.previews.set(preview.id, preview);
    return preview;
  }

  cancelSend(id: string): void { this.previews.delete(id); this.pendingSwaps.delete(id); }

  /** Password is checked here so an unattended unlocked app can't move funds. */
  async confirmSend(id: string, password: string, opts: { delayMinutes?: number } = {}) {
    this.session();
    const preview = this.previews.get(id);
    if (!preview || preview.expires < Date.now()) {
      this.previews.delete(id);
      throw new Error('The review expired. Try again.');
    }
    const secrets = await this.vault.open(password);
    this.previews.delete(id); // one shot: a retry must go through a fresh preview
    const delay = Number(opts.delayMinutes ?? 0);
    if (delay > 0) return this.scheduleSend(preview, secrets.tronMnemonic, delay);
    this.balanceMemo.clear(); // money is about to move
    this.forgetViews();
    // The send leaves on a Tor route of its own, and lookups carry on on yet another one afterwards, so the server
    // that takes the transaction can't tie it to the addresses this wallet just looked up.
    this.renewTorRoute(preview.asset);
    // Monero's wallet keeps its connection to the node: it reconnects on a new circuit before the send goes out.
    if (preview.asset === 'XMR' && this.torActive) await this.monero?.renewRoute().catch(() => undefined);
    let result;
    try { result = await this.broadcastPreview(preview, secrets); } finally {
      this.renewTorRoute(preview.asset);
      if (preview.asset === 'XMR' && this.torActive) void this.monero?.renewRoute().catch(() => undefined);
    }
    await this.records.write(this.recipientsPath, rememberRecipient(await this.records.read(this.recipientsPath), preview.to)).catch(() => undefined);
    return result;
  }

  // ---- Decred tickets ----
  // Bought through a VSP (dcr-stake.ts). Records are sealed in dcr-tickets.json: each ticket, its VSP and the VSP's
  // key, where its stake returns, and the fee transaction. The seed isn't kept: paying a fee that didn't go through
  // asks for the password again. Status comes from the chain alone (the ticket, the fee transaction), so checking
  // it needs no key.

  protected get dcrTicketsPath(): string { return path.join(this.dir, 'dcr-tickets.json'); }
  protected dcrCheckedAt = 0;

  protected async dcrStakeRead(): Promise<{ tickets: any[]; nextChange: number; nextMixedChange: number; nextVoting: number; vsp: string }> {
    const j = await this.records.read(this.dcrTicketsPath).catch(() => undefined);
    const tickets = Array.isArray(j?.tickets) ? j.tickets.filter((t: any) => /^[0-9a-f]{64}$/.test(t?.hash ?? '')) : [];
    const int = (v: unknown) => (Number.isInteger(v) ? v as number : 0);
    return { tickets, nextChange: int(j?.nextChange), nextMixedChange: int(j?.nextMixedChange), nextVoting: int(j?.nextVoting), vsp: typeof j?.vsp === 'string' ? j.vsp : '' };
  }

  /** The account a purchase is paid from: the regular one, or the mixed one (its stake and reward return there). */
  private dcrAccount(mixed: boolean): { client: DcrClient; path: string; next: 'nextChange' | 'nextMixedChange' } {
    if (mixed) { if (!this.dcrMixed) throw new Error('Mixed DCR is not available.'); return { client: this.dcrMixed, path: DCR_MIXED_PATH, next: 'nextMixedChange' }; }
    return { client: this.dcr!, path: DCR_PATH, next: 'nextChange' };
  }

  protected async dcrStakeWrite(f: { tickets: any[]; nextChange: number; nextMixedChange: number; nextVoting: number; vsp: string }): Promise<void> {
    await this.records.write(this.dcrTicketsPath, f);
    this.dcrHold(f);
  }

  /** The fee coins of tickets whose fee isn't settled stay out of sends; the addresses used stay out of change. */
  private dcrStakeHolding: { regular: string[]; mixed: string[] } = { regular: [], mixed: [] };
  protected dcrHold(f: { tickets: any[]; nextChange: number; nextMixedChange?: number }): void {
    if (!this.dcr) return;
    this.dcr.setChangeFloor(f.nextChange);
    this.dcrMixed?.setChangeFloor(f.nextMixedChange ?? 0);
    const open = f.tickets.filter((t) => t.state === 'new' || (t.state === 'paid' && !t.feeConfirmed));
    this.dcrStakeHolding = {
      regular: open.filter((t) => !t.mixed).map((t) => `${t.fund.txid}:${t.fund.vout}`),
      mixed: open.filter((t) => t.mixed).map((t) => `${t.fund.txid}:${t.fund.vout}`),
    };
    this.dcrMixed?.reserve(this.dcrStakeHolding.mixed);
    this.dcrHoldAll();
  }
  protected override dcrStakeHeld(): string[] { return this.dcrStakeHolding.regular; }

  protected override dcrStakeLoad = async (): Promise<void> => { this.dcrHold(await this.dcrStakeRead()); };

  private vspClient(url: string, pubkey: string | null): VspClient {
    const agent = this.torRoute('dcr-vsp');
    return new VspClient(url, pubkey, () => this.isolated('dcr-vsp', agent, isLocalServer(url)));
  }

  /** Open VSPs from Decred's public list, in random order (so not everyone picks the first). */
  async dcrVspList(): Promise<{ url: string; feePercentage: number; voting: number }[]> {
    this.session();
    const j = await getJson(VSP_LIST_URL, { agent: this.torRoute('dcr-vsp'), timeoutMs: 45_000 });
    const list = parseVspList(j, dcrNet.name);
    for (let i = list.length - 1; i > 0; i--) { const k = Math.floor(Math.random() * (i + 1)); [list[i], list[k]] = [list[k], list[i]]; }
    return list;
  }

  /** The ticket price now, whether a ticket can be bought this moment, and this wallet's tickets. */
  async dcrStakeInfo() {
    this.session();
    if (!this.dcr) throw new Error('Decred is not available.');
    const { height, price } = await this.dcr.stakeState();
    const f = await this.dcrStakeRead();
    return { price: formatAmount(price, 8), height, canBuy: ticketExpiry(height) !== null, vsp: f.vsp, max: MAX_TICKETS, tickets: await this.dcrTickets() };
  }

  private async dcrQuoteRaw(count: number, vspUrl: string) {
    if (!this.dcr) throw new Error('Decred is not available.');
    if (!Number.isInteger(count) || count < 1 || count > MAX_TICKETS) throw new Error(`Buy 1 to ${MAX_TICKETS} tickets at a time.`);
    const url = vspOrigin(vspUrl);
    const vsp = this.vspClient(url, null);
    const [info, state] = await Promise.all([vsp.info(), this.dcr.stakeState()]);
    if (info.network !== dcrNet.name) throw new Error(`This VSP is on ${info.network}, not Decred ${dcrNet.name}.`);
    if (info.closed) throw new Error(`This VSP isn't taking new tickets${info.closedMessage ? `: ${info.closedMessage}` : '.'}`);
    if (!(info.feePercentage >= 0 && info.feePercentage <= 20)) throw new Error('This VSP asks for an unusual fee, so it isn\'t used.');
    const expiry = ticketExpiry(state.height);
    if (expiry === null) throw new Error('The ticket price changes with the next block. Try again in a few minutes.');
    const fee = vspFee(state.price, state.height, info.feePercentage);
    return { url, info, price: state.price, height: state.height, expiry, fee, fund: feeFundFor(fee) };
  }

  /** What buying `count` tickets through this VSP costs, before the password. */
  async dcrStakeQuote(count: number, vspUrl: string, fromMixed = false) {
    this.session();
    const q = await this.dcrQuoteRaw(count, vspUrl);
    const coins = await this.dcrAccount(fromMixed).client.confirmedUtxos();
    const have = coins.filter((u) => u.tree !== 1).reduce((s, u) => s + u.value, 0n);
    const n = BigInt(count);
    const locked = n * q.price;
    const fees = n * (TICKET_FEE + q.fee);
    return {
      vsp: q.url, vspFeePercent: q.info.feePercentage, price: formatAmount(q.price, 8), count,
      locked: formatAmount(locked, 8), vspFee: formatAmount(n * q.fee, 8), ticketFees: formatAmount(n * TICKET_FEE, 8),
      total: formatAmount(locked + fees, 8), held: formatAmount(n * (q.price + TICKET_FEE + q.fund), 8),
      enough: have >= n * (q.price + TICKET_FEE + q.fund) + 10_000n, fromMixed,
    };
  }

  /** Signs the split and tickets, hands each ticket to the VSP (which broadcasts it) and pays its fee. */
  async dcrStakeBuy(count: number, vspUrl: string, password: string, fromMixed = false) {
    this.session();
    const secrets = await this.vault.open(password);
    const q = await this.dcrQuoteRaw(count, vspUrl);
    const acct = this.dcrAccount(fromMixed);
    const dcr = acct.client;
    const coins = (await dcr.confirmedUtxos()).filter((u) => u.tree !== 1);
    const f = await this.dcrStakeRead();
    const first = Math.max(dcr.changeTarget().index, f[acct.next]);
    const addresses = Array.from({ length: 2 * count + 1 }, (_, i) => ({ address: dcr.addressAt(1, first + i), index: first + i }));
    const plan = planTickets({ mnemonic: secrets.tronMnemonic, coins, price: q.price, count, expiry: q.expiry, feeFund: q.fund, addresses, votingFirst: f.nextVoting, path: acct.path });
    const now = Date.now();
    const records = plan.tickets.map((t) => ({
      hash: t.hash, hex: t.hex, parentHex: plan.split.hex, splitId: plan.split.id, price: q.price.toString(), expiry: q.expiry, boughtAt: now,
      vsp: { url: q.url, pubkey: q.info.pubkey, feePercentage: q.info.feePercentage },
      voting: t.voting, commitment: t.commitment, fund: { ...t.fund, value: t.fund.value.toString() },
      state: 'new', status: 'unmined', ...(fromMixed ? { mixed: true } : {}),
    }));
    f.tickets.push(...records);
    f[acct.next] = first + 2 * count + 1;
    f.nextVoting += count;
    f.vsp = q.url;
    await this.dcrStakeWrite(f);
    const problems: string[] = [];
    for (const r of records) {
      const e = await this.dcrPayFee(r.hash, secrets.tronMnemonic);
      if (e) problems.push(e);
    }
    this.emit('balance-changed');
    return { bought: records.length, paid: records.length - problems.length, problem: problems[0] ?? '' };
  }

  /** Pays the fees that didn't go through when the tickets were bought. */
  async dcrStakeFinish(password: string) {
    this.session();
    const secrets = await this.vault.open(password);
    const problems: string[] = [];
    for (const t of (await this.dcrStakeRead()).tickets.filter((x) => x.state === 'new')) {
      const e = await this.dcrPayFee(t.hash, secrets.tronMnemonic);
      if (e) problems.push(e);
    }
    this.emit('balance-changed');
    return { problem: problems[0] ?? '' };
  }

  /** One ticket: fee address from the VSP, the fee transaction, and the fee with the voting key. Returns a problem. */
  protected async dcrPayFee(hash: string, mnemonic: string): Promise<string> {
    const f = await this.dcrStakeRead();
    const t = f.tickets.find((x) => x.hash === hash);
    if (!t || t.state !== 'new') return '';
    try {
      const vsp = this.vspClient(t.vsp.url, t.vsp.pubkey);
      const acct = this.dcrAccount(!!t.mixed);
      const key = commitmentKey(mnemonic, t.commitment.index, acct.path);
      const fa = await vsp.feeAddress({ hash: t.hash, hex: t.hex, parentHex: t.parentHex }, key);
      // The fee is a share of a vote's reward, which is less than the ticket's price: anything near the price is wrong.
      const cap = ((BigInt(t.price) + 10_000n) * BigInt(Math.ceil(t.vsp.feePercentage * 100))) / 10_000n + 1n;
      if (fa.amount > cap) throw new Error('The VSP asked for more than its stated fee, so it wasn\'t paid.');
      const change = Math.max(f[acct.next], acct.client.changeTarget().index);
      const tx = feeTx({ mnemonic, fund: { ...t.fund, value: BigInt(t.fund.value) }, feeAddress: fa.address, amount: fa.amount, change: { address: acct.client.addressAt(1, change), index: change }, path: acct.path });
      f[acct.next] = change + 1;
      await vsp.payFee({ hash: t.hash, feeHex: tx.hex, votingWif: votingKey(mnemonic, t.voting).wif }, key);
      Object.assign(t, { state: 'paid', fee: { address: fa.address, amount: fa.amount.toString(), id: tx.id, hex: tx.hex }, error: undefined });
      await this.dcrStakeWrite(f);
      return '';
    } catch (e) {
      t.error = String((e as Error).message ?? e).slice(0, 300);
      await this.dcrStakeWrite(f);
      return t.error;
    }
  }

  /** This wallet's tickets, their status read from the chain at most every two minutes. */
  async dcrTickets(force = false) {
    this.session();
    const f = await this.dcrStakeRead();
    if (this.dcr && (force || Date.now() - this.dcrCheckedAt > 2 * 60_000) && f.tickets.some((t) => t.state === 'new' || t.state === 'paid')) {
      this.dcrCheckedAt = Date.now();
      try {
        const { height } = await this.dcr.stakeState();
        for (const t of f.tickets.filter((x) => x.state === 'new' || x.state === 'paid')) {
          const conf = await this.dcr.txConfirmations(t.hash);
          if (conf === null || conf < 1) {
            t.status = 'unmined';
            // Not in a block by its expiry: the split's outputs are plain coins of this wallet again.
            if (height >= t.expiry && conf === null) { t.state = 'failed'; t.error = t.error ?? 'The ticket was not mined before its price window ended.'; }
            continue;
          }
          t.status = await this.dcr.ticketStatus(t.hash).catch(() => t.status);
          if (t.fee) t.feeConfirmed = ((await this.dcr.txConfirmations(t.fee.id)) ?? 0) > 0;
          if (t.status === 'voted' || t.status === 'revoked') t.state = 'done';
        }
        await this.dcrStakeWrite(f);
      } catch { /* shown as last read */ }
    }
    return f.tickets.map((t) => ({
      hash: t.hash, state: t.state, status: t.status ?? '', price: formatAmount(BigInt(t.price), 8), boughtAt: t.boughtAt,
      vsp: new URL(t.vsp.url).host, fee: t.fee ? formatAmount(BigInt(t.fee.amount), 8) : '', feeConfirmed: !!t.feeConfirmed, error: t.error ?? '',
    })).sort((a, b) => b.boughtAt - a.boughtAt);
  }

  // ---- delayed sends (Bitcoin) ----
  // A send signed now goes out at a random moment within the chosen time, so its timing doesn't tie it to what
  // happened just before (a swap, a CoinJoin, a payment received). The signed transaction is kept encrypted with
  // the wallet's records until then, also across a lock or a restart; the seed is not kept.

  protected delayedTimers = new Map<string, ReturnType<typeof setTimeout>>();
  protected override async afterBtcReady(): Promise<void> {
    for (const e of await this.delayedList()) this.armDelayed(e);
    await this.armAllTornado().catch(() => undefined);
    for (const e of await this.poolLaterList().catch(() => [])) this.armPoolLater(e);
  }
  protected override onLock(): void {
    for (const t of this.delayedTimers.values()) clearTimeout(t); this.delayedTimers.clear();
    for (const t of this.tornadoTimers.values()) clearTimeout(t); this.tornadoTimers.clear();
    for (const t of this.poolTimers.values()) clearTimeout(t); this.poolTimers.clear();
    this.poolScanState.clear();
  }

  // ---- Solana private pool (PrivacyCash) ----
  // Deposits are signed here and go into the pool's program; the private balance is found by trying to open every
  // note the pool publishes; sends out of the pool go through its relayer, which signs and pays for them. Tor only.

  protected poolTimers = new Map<string, ReturnType<typeof setTimeout>>();
  protected poolScanState = new Map<PoolAsset, { running: boolean; at: number; done?: number; total?: number; error?: string }>();
  protected get poolHistoryPath(): string { return path.join(this.dir, 'sol-pool-history.json'); }
  protected get poolLaterPath(): string { return path.join(this.dir, 'sol-pool-later.json'); }

  protected poolAsset(asset: string): PoolAsset {
    if (!Object.prototype.hasOwnProperty.call(POOL_TOKENS, asset)) throw new Error('The private pool takes SOL, USDC and USDT on Solana.');
    return asset as PoolAsset;
  }
  protected poolOpen() {
    this.session();
    if (!this.solPool || !this.sol) throw new Error('Solana is not available.');
    if (!this.torActive && !this.dev.solPoolRelayer) throw new Error('The private pool needs Tor. Turn it on in Settings first.');
    return { pool: this.solPool, sol: this.sol };
  }

  /** Looks for new notes in the background (at most every two minutes per coin). */
  protected poolScan(asset: PoolAsset, force = false): void {
    const st = this.poolScanState.get(asset);
    if (st?.running || (!force && st && Date.now() - st.at < 120_000)) return;
    const pool = this.solPool;
    if (!pool) return;
    const state = { running: true, at: Date.now(), done: st?.done, total: st?.total } as { running: boolean; at: number; done?: number; total?: number; error?: string };
    this.poolScanState.set(asset, state);
    void pool.scan(asset, (done, total) => { state.done = done; state.total = total; this.emit('sol-pool-progress', `scan:${asset}:${done}:${total}`); })
      .then((found) => { if (found) this.emit('balance-changed'); })
      .catch((e) => { state.error = (e as Error).message; })
      .finally(() => { state.running = false; state.at = Date.now(); if (this.solPool === pool) this.emit('sol-pool-progress', `scanned:${asset}`); });
  }

  async solPoolInfo(asset: string) {
    const a = this.poolAsset(asset);
    this.session();
    const pool = this.solPool;
    if (!pool) throw new Error('Solana is not available.');
    const t = POOL_TOKENS[a];
    const enabled = await pool.enabled(a);
    if (enabled && (this.torActive || this.dev.solPoolRelayer)) this.poolScan(a);
    const b = await pool.balance(a);
    const st = this.poolScanState.get(a);
    const later = (await this.poolLaterList()).filter((e) => e.asset === a).map((e) => ({ id: e.id, at: e.at, amount: formatAmount(BigInt(e.amount.replace(/^deposit:/, '')), t.decimals), afterDeposit: e.amount.startsWith('deposit:'), to: e.to }));
    return {
      asset: a, symbol: t.symbol, enabled, tor: this.torActive || !!this.dev.solPoolRelayer,
      ready: formatAmount(b.ready, t.decimals), arriving: formatAmount(b.arriving, t.decimals), notes: b.notes,
      scanning: !!st?.running, scanDone: st?.done ?? b.scannedTo, scanTotal: st?.total ?? null, error: st?.error ?? null, later,
    };
  }

  /** Starts looking for this coin's notes: from now on, or (`fromStart`) through the whole pool, for notes made
   *  before (with this wallet or on the pool's site with the same SOL key). */
  async solPoolEnable(asset: string, fromStart: boolean): Promise<void> {
    const a = this.poolAsset(asset);
    const { pool } = this.poolOpen();
    await pool.enable(a, fromStart === true);
    this.poolScan(a, true);
  }

  protected async poolHistory(): Promise<{ kind: 'in' | 'out'; asset: string; amount: string; at: number }[]> {
    const j = await this.records.read(this.poolHistoryPath).catch(() => undefined);
    return Array.isArray(j) ? j.filter((e: any) => (e?.kind === 'in' || e?.kind === 'out') && typeof e.amount === 'string' && Number.isFinite(e.at)) : [];
  }
  protected async poolRemember(kind: 'in' | 'out', asset: PoolAsset, amount: bigint): Promise<void> {
    const list = [...(await this.poolHistory()), { kind, asset, amount: String(amount), at: Date.now() }].slice(-200);
    await this.records.write(this.poolHistoryPath, list).catch(() => undefined);
  }

  async solPoolDepositQuote(asset: string, amountText: string) {
    const a = this.poolAsset(asset);
    const { pool, sol } = this.poolOpen();
    const t = POOL_TOKENS[a];
    const amount = parseAmount(amountText, t.decimals);
    if (amount <= 0n) throw new Error('Enter an amount.');
    const { fee, max } = await pool.depositCost(a);
    if (amount > max) throw new Error(`The pool takes at most ${formatAmount(max, t.decimals)} ${t.symbol} in one deposit.`);
    const { spendable } = await sol.getBalance();
    if (a === 'SOL') { if (amount + fee > spendable) throw new Error(`Not enough SOL: this needs ${formatAmount(amount + fee, 9)} SOL with the network costs.`); }
    else {
      if ((await sol.getUsdtBalance(a)) < amount) throw new Error(`Not enough ${t.symbol}.`);
      if (fee > spendable) throw new Error(`Not enough SOL for the network costs (${formatAmount(fee, 9)} SOL).`);
    }
    // Amounts like other people's (round ones) are harder to match with a withdrawal.
    const digits = amount.toString().replace(/0+$/, '').length;
    return { asset: a, symbol: t.symbol, amount: formatAmount(amount, t.decimals), cost: formatAmount(fee, 9), round: digits <= 2 };
  }

  /** `sendTo`: sent on from the pool to this address at a random time 1 to 24 hours later (while the app is open). */
  async solPoolDeposit(asset: string, amountText: string, password: string, opts: { sendTo?: string } = {}) {
    const a = this.poolAsset(asset);
    await this.solPoolDepositQuote(a, amountText);
    const sendTo = opts.sendTo?.trim() ? await this.foreign(this.poolRecipient(opts.sendTo)) : undefined;
    const { pool, sol } = this.poolOpen();
    const secrets = await this.vault.open(password);
    const amount = parseAmount(amountText, POOL_TOKENS[a].decimals);
    if (!(await pool.enabled(a))) await pool.enable(a);
    this.emit('sol-pool-progress', 'proof');
    const id = await pool.deposit(a, amount, solSecret(secrets.tronMnemonic));
    await this.poolRemember('in', a, amount);
    if (sendTo) {
      const entry = { id: randomUUID(), asset: a, amount: `deposit:${amount}`, to: sendTo, at: randomLater() };
      await this.records.write(this.poolLaterPath, [...(await this.poolLaterList()), entry]);
      this.armPoolLater(entry);
    }
    void sol.getBalance().catch(() => undefined);
    setTimeout(() => this.poolScan(a, true), 45_000).unref?.();
    this.emit('balance-changed');
    return { id, url: SOL_EXPLORER_TX + id };
  }

  protected poolRecipient(to: string): string {
    const r = to.trim();
    if (!isSolAddress(r)) throw new Error('The receiving address is not a SOL address.');
    if (r === this.sol?.address) throw new Error('Sending to this wallet\'s own address would link it to the deposit. Use another address.');
    return r;
  }

  async solPoolWithdrawQuote(asset: string, amountText: string, to: string) {
    const a = this.poolAsset(asset);
    const { pool } = this.poolOpen();
    const t = POOL_TOKENS[a];
    const recipient = await this.foreign(this.poolRecipient(to));
    const q = await pool.withdrawQuote(a, amountText === 'max' ? 'max' : parseAmount(amountText, t.decimals));
    // The relayer and anyone watching the chain see this amount and time: close to a deposit's, they can be paired.
    const deposits = (await this.poolHistory()).filter((e) => e.kind === 'in' && e.asset === a);
    const near = deposits.some((e) => { const d = BigInt(e.amount); const diff = d > q.amount ? d - q.amount : q.amount - d; return diff * 100n <= d * 2n; });
    const recent = deposits.some((e) => Date.now() - e.at < 6 * 3600_000);
    return {
      asset: a, symbol: t.symbol, to: recipient, amount: formatAmount(q.amount, t.decimals), fee: formatAmount(q.fee, t.decimals),
      total: formatAmount(q.amount + q.fee, t.decimals), max: formatAmount(q.max, t.decimals), matchesDeposit: near, soonAfterDeposit: recent,
    };
  }

  async solPoolWithdraw(asset: string, amountText: string, to: string, password: string, opts: { delayMinutes?: number } = {}) {
    const a = this.poolAsset(asset);
    const q = await this.solPoolWithdrawQuote(a, amountText, to);
    await this.vault.open(password);
    const amount = parseAmount(q.amount, POOL_TOKENS[a].decimals);
    const delay = Number(opts.delayMinutes) || 0;
    if (delay) {
      const entry = { id: randomUUID(), asset: a, amount: String(amount), to: q.to, at: randomLater() };
      await this.records.write(this.poolLaterPath, [...(await this.poolLaterList()), entry]);
      this.armPoolLater(entry);
      return { scheduledAt: entry.at };
    }
    const id = await this.poolSend(a, amount, q.to);
    return { id, url: SOL_EXPLORER_TX + id };
  }

  protected async poolSend(a: PoolAsset, amount: bigint, to: string): Promise<string> {
    const { pool } = this.poolOpen();
    const id = await pool.withdraw(a, amount, to, (stage) => this.emit('sol-pool-progress', stage));
    await this.poolRemember('out', a, amount);
    setTimeout(() => this.poolScan(a, true), 45_000).unref?.();
    this.emit('balance-changed');
    return id;
  }

  protected async poolLaterList(): Promise<{ id: string; asset: PoolAsset; amount: string; to: string; at: number }[]> {
    const j = await this.records.read(this.poolLaterPath).catch(() => undefined);
    return Array.isArray(j) ? j.filter((e: any) => typeof e?.id === 'string' && Object.prototype.hasOwnProperty.call(POOL_TOKENS, e.asset) && /^(deposit:)?\d+$/.test(e.amount) && isSolAddress(e.to) && Number.isFinite(e.at)) : [];
  }
  /** Runs while the wallet is open; one that came due while it was closed goes out within a minute of opening. */
  protected armPoolLater(e: { id: string; at: number }): void {
    clearTimeout(this.poolTimers.get(e.id));
    const t = setTimeout(() => void this.firePoolLater(e.id), Math.max(e.at - Date.now(), 5_000 + Math.random() * 55_000));
    (t as any).unref?.();
    this.poolTimers.set(e.id, t);
  }
  protected async firePoolLater(id: string): Promise<void> {
    this.poolTimers.delete(id);
    const e = (await this.poolLaterList()).find((x) => x.id === id);
    if (!e || !this.solPool) return;
    const drop = async () => this.records.write(this.poolLaterPath, (await this.poolLaterList()).filter((x) => x.id !== id)).catch(() => undefined);
    try {
      let amount: bigint;
      if (e.amount.startsWith('deposit:')) {
        // Sent on after a deposit: what the deposit holds, less the relayer's fee. The note must have been found.
        await this.solPool.scan(e.asset);
        amount = (await this.solPool.quoteWithin(e.asset, BigInt(e.amount.slice(8)))).amount;
      } else amount = BigInt(e.amount);
      // Nobody reviews this fee: more than 2% of the amount plus the relayer's usual fixed part, and it waits.
      const q = await this.solPool.withdrawQuote(e.asset, amount);
      const fixed = e.asset === 'SOL' ? 2_000_000n : 10n ** BigInt(POOL_TOKENS[e.asset].decimals);
      if (q.fee * 100n > amount * UNATTENDED_FEE_PERCENT + fixed * 100n) throw new Error(`The pool relayer's fee is over ${UNATTENDED_FEE_PERCENT}% right now.`);
      await this.poolSend(e.asset, amount, e.to);
      await drop();
    } catch (err) {
      const m = (err as Error).message;
      // Refusals that waiting won't fix end it; anything else (offline, relayer busy) tries again later.
      if (/refused|More than one|less than|nothing in the private pool|not a SOL address/i.test(m) && !e.amount.startsWith('deposit:')) { await drop(); this.emit('sol-pool-progress', `failed:${m}`); return; }
      const t = setTimeout(() => void this.firePoolLater(id), 10 * 60_000); (t as any).unref?.(); this.poolTimers.set(id, t);
    }
  }
  async solPoolCancelLater(id: string): Promise<void> {
    this.session();
    clearTimeout(this.poolTimers.get(id)); this.poolTimers.delete(id);
    await this.records.write(this.poolLaterPath, (await this.poolLaterList()).filter((x) => x.id !== String(id)));
  }
  // ---- receiving with Payjoin (BIP77) ----
  // A request lives while the wallet is unlocked, for up to an hour: the coin this wallet adds is held out of other
  // sends meanwhile, and its key is kept in memory only.

  protected get pjSeenPath(): string { return path.join(this.dir, 'payjoin-seen.json'); }

  async payjoinReceiveStart(password: string, amountInput?: string) {
    const { btc } = this.session();
    if (!this.torActive) throw new Error('Payjoin needs Tor. Turn it on in Settings first.');
    const amount = typeof amountInput === 'string' && amountInput.trim() ? formatAmount(parseAmount(amountInput.trim(), 8), 8) : undefined;
    const frozen = new Set((await this.btcCoinNotes()).frozen);
    const coins = (await btc.coins()).filter((u) => u.confirmed && u.chain !== V0_CHAIN && u.value >= 10_000n && !frozen.has(coinId(u)) && !btc.reserved.has(coinId(u)));
    if (!coins.length) throw new Error('Payjoin needs a confirmed, unfrozen coin of at least 0.0001 BTC in this wallet, to add to the payment.');
    // The smallest: the payer sees the coin added, so the least is shown.
    const coin = coins.sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0))[0];
    const secrets = await this.vault.open(password);
    const ck = coinKey(secrets.tronMnemonic, coin.chain, coin.index);
    if (Buffer.compare(Buffer.from(ck.script), Buffer.from(btcScriptOf(coin.address))) !== 0) throw new Error('A coin does not match this wallet\'s keys.');
    const get = this.payjoinGet();
    let directory = ''; let ohttp: OhttpKeys | null = null;
    for (const d of PAYJOIN_DIRECTORIES) {
      try { ohttp = parseOhttpKeys((await get(`${d}/.well-known/ohttp-gateway`)).body); directory = d; break; } catch { /* the next one */ }
    }
    if (!ohttp) throw new Error('No Payjoin directory could be reached over Tor. Try again later.');
    this.payjoinReceiveStop();
    const { sk, pub } = newReceiverKey();
    const address = btc.receiveAddress;
    const expires = Math.floor(Date.now() / 1000) + 3600;
    const uri = payjoinUri({ address, amount, directory, receiverKey: pub, ohttp, expires });
    btc.reserved.add(coinId(coin));
    this.pjRecv = {
      coinId: coinId(coin), post: this.payjoinPost(), gen: this.sessionGen,
      s: { id: randomUUID(), address, amount, directory, ohttp, receiverSk: sk, expires, uri, status: 'waiting', coin: { txid: coin.txid, vout: coin.vout, amount: coin.value, chain: coin.chain, index: coin.index, ...ck } },
    };
    this.pjPoll();
    return this.payjoinReceiveStatus();
  }

  payjoinReceiveStatus() {
    const r = this.pjRecv;
    if (!r) return null;
    return { uri: r.s.uri, address: r.s.address, amount: r.s.amount ?? null, expires: r.s.expires * 1000, status: r.s.status, error: r.error ?? null };
  }

  protected pjPoll(): void {
    const r = this.pjRecv;
    const btc = this.btc;
    if (!r || !btc || r.gen !== this.sessionGen || r.s.status !== 'waiting') return;
    if (Date.now() / 1000 > r.s.expires) { r.s.status = 'expired'; this.pjRelease(r); return; }
    const next = (ms: number) => { r.timer = setTimeout(() => this.pjPoll(), ms); (r.timer as any).unref?.(); };
    const isOurs = (script: Uint8Array): boolean => { try { return btc.ownsAddress(btcAddressOf(script)); } catch { return false; } };
    void (async () => {
      const seen = await this.pjSeenList();
      const seenBefore = (outpoints: string[]): boolean => {
        const dup = outpoints.some((o) => seen.includes(o));
        void this.records.write(this.pjSeenPath, [...new Set([...outpoints, ...seen])].slice(0, 500)).catch(() => undefined);
        return dup;
      };
      return receiveStep(r.post, r.s, isOurs, seenBefore);
    })().then((res) => {
      if (this.pjRecv !== r || r.gen !== this.sessionGen) return;
      r.error = undefined;
      if (res === 'none') { next(3_000); return; }
      r.s.status = res === 'answered' ? 'answered' : 'failed';
      this.emit('balance-changed');
      // If the payer never sends either version, its ordinary payment goes out from here (it pays this wallet).
      // Once the Payjoin is out, this one is refused as a conflict, which is fine.
      const original = r.s.original?.hex;
      r.fallback = setTimeout(() => { if (original && this.btc) void this.btc.relay(original); this.pjRelease(r); }, 10 * 60_000);
      (r.fallback as any).unref?.();
    }, (e) => {
      if (this.pjRecv !== r) return;
      r.error = 'The Payjoin directory could not be reached. Retrying.';
      void e;
      next(15_000);
    });
  }

  protected async pjSeenList(): Promise<string[]> {
    const j = await this.records.read(this.pjSeenPath).catch(() => undefined);
    return Array.isArray(j) ? j.filter((x) => typeof x === 'string') : [];
  }

  /** The coin goes back to ordinary use and its key is wiped; the request's status stays on screen. */
  protected pjRelease(r: NonNullable<typeof this.pjRecv>): void {
    this.btc?.reserved.delete(r.coinId);
    r.s.coin.key.fill(0);
    r.s.receiverSk.fill(0);
  }

  async payjoinReceiveEnd(): Promise<void> { this.payjoinReceiveStop(); }

  /** Payjoin's directory lookups, through Tor. */
  protected payjoinGet(): (url: string) => Promise<{ status: number; body: Uint8Array }> {
    const agent = this.torProxy ? isolatedAgent(socksAgent(this.torProxy)) : undefined;
    const route = `payjoin-${randomUUID().slice(0, 8)}`;
    return async (url) => {
      if (!this.torActive) throw new Error('Payjoin needs Tor.');
      const res = await requestBinary(url, { method: 'GET', agent, timeoutMs: 60_000, route });
      if (res.status !== 200) throw new Error(`The Payjoin directory answered ${res.status}.`);
      return res;
    };
  }

  /** A Payjoin link checked for this send; a reason in the warnings when it is set aside. */
  protected payjoinTarget(given: { pj?: unknown; pjos?: unknown }, draft: BtcDraft, silent: boolean, warnings: string[]) {
    const pj = typeof given.pj === 'string' && given.pj.length < 2000 ? parsePayjoin(given.pj, typeof given.pjos === 'string' ? given.pjos : null) : null;
    if (!pj) { warnings.push('This Payjoin link can\'t be used safely, so this goes out as an ordinary payment.'); return undefined; }
    if (pj.kind === 'v2' && pj.expires * 1000 < Date.now()) { warnings.push('This Payjoin link has expired, so this goes out as an ordinary payment.'); return undefined; }
    if (!this.torActive) { warnings.push('Payjoin needs Tor, so this goes out as an ordinary payment. Turn on Tor in Settings to use it.'); return undefined; }
    if (silent || draft.inputs.some((u) => u.chain === V0_CHAIN)) { warnings.push('Payjoin can\'t be used with these coins, so this goes out as an ordinary payment.'); return undefined; }
    warnings.push('Payjoin: the recipient can add a coin of theirs to this payment, so the chain doesn\'t show which coins were yours or how much was paid. If they don\'t answer within a minute, the ordinary payment goes out instead.');
    return pj;
  }

  /** Payjoin's requests, through Tor on a route of their own. */
  protected payjoinPost(): Post {
    const agent = this.torProxy ? isolatedAgent(socksAgent(this.torProxy)) : undefined;
    const route = `payjoin-${randomUUID().slice(0, 8)}`;
    return async (url, body, contentType, timeoutMs) => {
      if (!this.torActive) throw new Error('Payjoin needs Tor.');
      return requestBinary(url, { method: 'POST', body, contentType, agent, timeoutMs, route });
    };
  }

  protected get delayedPath(): string { return path.join(this.dir, 'btc-delayed.json'); }

  protected async scheduleSend(preview: Preview, mnemonic: string, minutes: number) {
    const draft = preview.btc ?? preview.btcMixed;
    if (!draft) throw new Error('Only Bitcoin sends can go out later.');
    if (preview.payjoin) throw new Error('A Payjoin payment goes out right away: the recipient answers while it is made.');
    if (!DELAY_CHOICES.includes(minutes)) throw new Error('Choose when to send.');
    const client = preview.btcMixed ? this.btcMixed! : this.session().btc;
    const { hex, id } = client.sign(draft, mnemonic);
    const at = Date.now() + Math.round((0.1 + Math.random() * 0.9) * minutes * 60_000);
    const entry = { id, hex, at, mixed: Boolean(preview.btcMixed), draft: JSON.parse(JSON.stringify(draft, (_, v) => (typeof v === 'bigint' ? v.toString() : v))) };
    const list = [...(await this.delayedList()), entry];
    await this.records.write(this.delayedPath, list);
    await this.records.write(this.recipientsPath, rememberRecipient(await this.records.read(this.recipientsPath), preview.to)).catch(() => undefined);
    this.armDelayed(entry);
    return { hashes: [id], scheduledAt: at };
  }

  protected async delayedList(): Promise<any[]> {
    const j = await this.records.read(this.delayedPath).catch(() => undefined);
    return Array.isArray(j) ? j.filter((e: any) => typeof e?.id === 'string' && typeof e?.hex === 'string' && Number.isFinite(e?.at)) : [];
  }

  /** Reserves the coins and sets the timer; one already due goes out within a minute, at a random moment. */
  protected armDelayed(e: any): void {
    const client = e.mixed ? this.btcMixed : this.btc;
    if (!client) return;
    const draft: BtcDraft = { ...e.draft, amount: BigInt(e.draft.amount), fee: BigInt(e.draft.fee), change: BigInt(e.draft.change), inputs: e.draft.inputs.map((u: any) => ({ ...u, value: BigInt(u.value) })) };
    for (const u of draft.inputs) client.reserved.add(coinId(u));
    clearTimeout(this.delayedTimers.get(e.id));
    const wait = Math.max(e.at - Date.now(), 5_000 + Math.random() * 55_000);
    this.delayedTimers.set(e.id, setTimeout(() => void this.fireDelayed(e.id, client, draft, e.hex), wait));
  }

  protected async fireDelayed(id: string, client: BtcClient, draft: BtcDraft, hex: string): Promise<void> {
    this.delayedTimers.delete(id);
    try {
      this.renewTorRoute('BTC');
      await client.sendSigned(draft, hex, id);
    } catch (e) {
      // Already in the chain or the mempool counts as sent; anything else tries again in a few minutes.
      if (!/already|known|in block|duplicate/i.test((e as Error).message)) {
        this.delayedTimers.set(id, setTimeout(() => void this.fireDelayed(id, client, draft, hex), 5 * 60_000));
        return;
      }
    }
    for (const u of draft.inputs) client.reserved.delete(coinId(u));
    await this.records.write(this.delayedPath, (await this.delayedList()).filter((e) => e.id !== id)).catch(() => undefined);
    this.emit('balance-changed');
  }

  /** Sends waiting to go out later, for the screen. */
  async delayedSends() {
    this.session();
    return (await this.delayedList()).map((e) => ({ id: e.id, at: e.at, amount: formatAmount(BigInt(e.draft.amount), 8), to: e.draft.to }));
  }

  /** Addresses sent to before, kept encrypted with the wallet's other records. */
  protected get recipientsPath(): string { return path.join(this.dir, 'recipients.json'); }
  protected async recipients(): Promise<string[]> {
    const j = await this.records.read(this.recipientsPath).catch(() => undefined);
    return Array.isArray(j) ? j.filter((x: unknown): x is string => typeof x === 'string') : [];
  }

  protected async broadcastPreview(preview: Preview, secrets: Secrets) {
    const { tron, monero, btc, dash } = this.session();

    if (preview.arrr) {
      if (!this.arrr) throw new Error('The Pirate Chain engine is off.');
      return { hashes: [await this.arrr.send(preview.arrr)] };
    }
    if (preview.zano) {
      if (!this.zano) throw new Error('The Zano engine is off.');
      return { hashes: [await this.zano.send(preview.zano)] };
    }
    if (preview.ksr) {
      if (!this.ksr) throw new Error('The Kusari engine is off.');
      return { hashes: [await this.ksr.send(preview.ksr)] };
    }
    if (preview.zec) {
      if (!this.zec) throw new Error('The Zcash engine is off.');
      return { hashes: await this.zec.send(preview.zec, secrets.tronMnemonic) };
    }
    if (preview.sol) return { hashes: [await this.sol!.send(preview.sol, secrets.tronMnemonic)] };
    if (preview.solUsdt) return { hashes: [await this.sol!.sendUsdt(preview.solUsdt, secrets.tronMnemonic)] };
    if (preview.account) return { hashes: [await this.accounts.get(preview.account.asset)!.send(preview.account.draft, secrets.tronMnemonic)] };
    if (preview.doge) return { hashes: [await this.doge!.send(preview.doge, secrets.tronMnemonic)] };
    if (preview.dcr) return { hashes: [await this.dcr!.send(preview.dcr, secrets.tronMnemonic)] };
    if (preview.dcrMixed) {
      const d = preview.dcrMixed;
      if (d.changePath) { this.dcrAddrs.change = Math.max(this.dcrAddrs.change, d.changeIndex + 1); this.dcr!.setChangeFloor(this.dcrAddrs.change); this.dcrAddrsSave(); }
      const h = await this.dcrMixed!.send(d, secrets.tronMnemonic);
      this.dcrMixedBalance = null;
      void this.dcr!.refresh(true).catch(() => undefined);
      return { hashes: [h] };
    }
    if (preview.bch) return { hashes: [await this.bch!.send(preview.bch, secrets.tronMnemonic)] };
    if (preview.firo) return { hashes: [await this.firo!.send(preview.firo, secrets.tronMnemonic)] };
    if (preview.dash) return { hashes: [await dash.send(preview.dash, secrets.tronMnemonic)] };
    if (preview.dashMix) {
      const m = preview.dashMix;
      if (!this.mixer) throw new Error('CoinJoin is not available.');
      const { hex, id: txid } = signDashOutputs(m.inputs, m.plan.outputs, m.change, m.fee, secrets.tronMnemonic);
      await this.mixer.commitSplit(m.plan);
      // Not handed back on failure: a send that timed out may still have gone through.
      await dash.broadcastSigned(hex, txid);
      // Mixing starts once these coins confirm; the mixer waits for that itself.
      if (this.mixer && !(await this.mixer.paused())) this.mixer.start();
      return { hashes: [txid] };
    }
    if (preview.dashPrivate) {
      if (!this.mixer) throw new Error('CoinJoin is not available.');
      return { hashes: [await this.mixer.sendPrivate(preview.dashPrivate)] };
    }
    if (preview.ltc) return { hashes: [await this.ltc!.send(preview.ltc, secrets.tronMnemonic)] };
    if (preview.mweb) return { hashes: [await this.mweb!.send(preview.mweb, secrets.tronMnemonic)] };
    if (preview.pegin) return { hashes: [await this.mweb!.pegin(preview.pegin, secrets.tronMnemonic)] };
    if (preview.spark) return { hashes: [await this.spark!.send(preview.spark)] };
    if (preview.mint) return { hashes: [await this.spark!.mint(preview.mint, secrets.tronMnemonic, (hex, id) => this.firo!.broadcastSigned(hex, id))] };
    if (preview.btcMixed) {
      const hash = await this.btcMixed!.send(preview.btcMixed, secrets.tronMnemonic);
      this.btcMixedBalance = null;
      return { hashes: [hash] };
    }
    if (preview.btc && preview.payjoin) {
      // The recipient gets up to a minute to add a coin; otherwise, or if anything about it is off, the ordinary
      // payment goes out. Either way the payment is made.
      const r = await payjoinPay({ draft: preview.btc, mnemonic: secrets.tronMnemonic, target: preview.payjoin, post: this.payjoinPost(), waitMs: 60_000 });
      if (r.payjoin) {
        try { return { hashes: [await btc.sendSigned(r.draft, r.hex, r.id)], payjoin: true }; } catch {
          // The recipient's coin may have been spent meanwhile: the ordinary payment, then.
        }
      }
      const plain = btc.sign(preview.btc, secrets.tronMnemonic);
      return { hashes: [await btc.sendSigned(preview.btc, plain.hex, plain.id)], payjoin: false, payjoinProblem: r.problem ?? 'The recipient\'s Payjoin could not be sent.' };
    }
    if (preview.btc) {
      return { hashes: [await btc.send(preview.btc, secrets.tronMnemonic)] };
    }
    if (preview.eth && preview.ethFrom !== undefined) {
      return { hashes: [await this.ethExtraClient(preview.ethFrom).send(preview.eth, deriveEthAccount(secrets.tronMnemonic, ETH_EXTRA_FIRST + preview.ethFrom).wallet)] };
    }
    if (preview.eth) {
      return { hashes: [await this.evm(preview.eth.asset).send(preview.eth, this.evmAccount(preview.eth.asset, secrets.tronMnemonic).wallet)] };
    }
    if (preview.monero) {
      const hashes = await monero.relay(preview.monero);
      return { hashes };
    }
    const account = deriveTronAccount(secrets.tronMnemonic);
    if (account.address !== tron.address) throw new Error('The wallet address does not match, so this was stopped.');
    const txid = await tron.send(preview.tron as TronTransfer, account.privateKey);
    void tron.waitForResult(txid).then((status) => this.emit('tron-tx', { txid, status, asset: preview.asset }));
    return { hashes: [txid] };
  }

  // ---- Zcash ----

  arrrInfo() {
    return { available: this.arrrAvailable, started: this.arrr !== null, error: this.arrr?.lastError ?? null, phase: this.arrr?.phase ?? null, detail: arrrEngineInfo(this.dev.arrrBin) };
  }

  /** date: YYYY-MM-DD. The earlier the date, the longer the scan. */
  async arrrRescan(date: string, password: string): Promise<void> {
    if (!this.arrr) throw new Error('Pirate Chain is not available on this device.');
    const parsed = /^\d{4}-\d{2}-\d{2}$/.test(date.trim()) ? new Date(date.trim() + 'T00:00:00Z') : null;
    if (!parsed || Number.isNaN(parsed.getTime())) throw new Error('Enter the date as YYYY-MM-DD.');
    await this.vault.open(password);
    await this.arrr.rescan(date.trim());
  }

  zanoInfo() {
    return { available: this.zanoAvailable, started: this.zano !== null, error: this.zano?.lastError ?? null, phase: this.zano?.phase ?? null, detail: zanoEngineInfo(this.dev.zanoBin) };
  }

  /** As zanoInfo, for Kusari; hasNode says whether a node is set (there's no public one before launch). */
  ksrInfo() {
    return { available: this.ksrAvailable, hasNode: Boolean(this.ksrNode), started: this.ksr !== null, error: this.ksr?.lastError ?? null, phase: this.ksr?.phase ?? null, detail: ksrEngineInfo(this.dev.ksrBin) };
  }

  /** For a screenshot when ZEC doesn't show up: holds no addresses, balances or keys. */
  zecInfo() {
    return {
      available: this.zecAvailable,
      started: this.zec !== null,
      error: this.zec?.lastError ?? null,
      phase: this.zec?.phase ?? null,
      detail: zecEngineInfo(this.dev.zecBin),
    };
  }

  /** Moves every confirmed public LTC coin into the private (MWEB) balance. Confirmed with confirmSend. */
  async prepareLtcPrivate() {
    this.session();
    if (this.torNotReady) throw new Error('Tor is connecting. Try again once it connects.');
    if (!this.mweb) throw new Error('Private (MWEB) Litecoin isn\'t available on this device.');
    const [inputs, rate] = await Promise.all([this.ltc!.confirmedUtxos(), this.ltc!.feeRate()]);
    const draft = await this.mweb.peginDraft(inputs, Number(rate) * 1000);
    const preview = this.storePreview({ asset: 'LTC', to: draft.to, amount: draft.amount, fee: draft.fee, pegin: draft });
    return {
      id: preview.id, asset: 'LTC' as Asset, to: draft.to, amount: formatAmount(draft.amount, 8), fee: formatAmount(draft.fee, 8), feeAsset: 'LTC', feeIsEstimate: false,
      warnings: ['How much you make private is visible on the chain. Where it goes from the private balance is not.'],
    };
  }

  /**
   * Splits regular DASH into CoinJoin's standard sizes, on the CoinJoin account, plus a few small collateral
   * coins. Confirmed with confirmSend; mixing then runs by itself while the wallet is unlocked.
   */
  async prepareDashMix(amountInput: string) {
    const { dash } = this.session();
    if (this.torNotReady) throw new Error('Tor is connecting. Try again once it connects.');
    if (!this.mixer) throw new Error('CoinJoin is not available.');
    const coins = (await dash.confirmedUtxos()).sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0));
    const have = coins.reduce((s, c) => s + c.value, 0n);
    if (!coins.length) throw new Error('No DASH available to mix. Deposits can be used after 1 confirmation.');
    const isMax = amountInput.trim().toLowerCase() === 'max';
    // What a split of `want` costs in all: its sizes, collateral, and the fee for every coin it spends.
    const build = async (want: bigint) => {
      const plan = await this.mixer!.planSplit(want);
      const outs = plan.outputs.reduce((s, o) => s + o.value, 0n);
      const inputs: InsightUtxo[] = [];
      let sum = 0n;
      for (const c of coins) {
        inputs.push(c);
        sum += c.value;
        const withChange = dashFee(inputs.length, plan.outputs.length + 1);
        if (sum >= outs + withChange + DASH_DUST) return { plan, inputs, fee: withChange, change: sum - outs - withChange };
        const noChange = dashFee(inputs.length, plan.outputs.length);
        if (sum >= outs + noChange) return { plan, inputs, fee: sum - outs, change: 0n };
      }
      return null;
    };
    let draft = null;
    if (isMax) {
      // Every coin, less the fee and collateral, rounded down to the sizes; the rest stays as change.
      let want = have;
      for (let i = 0; i < 6 && !draft; i++) {
        const fee = dashFee(coins.length, DashMixer.split(want).length + 4);
        want = have - fee - 3n * 40_000n;
        if (want <= 0n) break;
        draft = await build(want);
        if (!draft) want -= 100_001n;
      }
    } else {
      draft = await build(parseAmount(amountInput, 8));
    }
    if (!draft) throw new Error('Not enough DASH for that amount, collateral and fee.');
    const change = draft.change > 0n ? { ...dash.changeTarget(), value: draft.change } : null;
    const preview = this.storePreview({ asset: 'DASH', to: 'CoinJoin', amount: draft.plan.mixable, fee: draft.fee, dashMix: { plan: draft.plan, inputs: draft.inputs, change, fee: draft.fee } });
    const collateral = draft.plan.outputs.reduce((s, o) => s + o.value, 0n) - draft.plan.mixable;
    return {
      id: preview.id, asset: 'DASH' as Asset, to: 'CoinJoin', amount: formatAmount(draft.plan.mixable, 8), fee: formatAmount(draft.fee, 8), feeAsset: 'DASH', feeIsEstimate: false,
      coins: draft.plan.outputs.length, collateral: formatAmount(collateral, 8),
      warnings: [
        `Splits into ${draft.plan.outputs.length} coins of CoinJoin's standard sizes${collateral > 0n ? `, ${formatAmount(collateral, 8)} DASH of it small collateral coins` : ''}. Mixing then takes ${MIX_ROUNDS} rounds with masternodes while the wallet is open, which can take hours.`,
        'This split is visible on the chain. After mixing, which coin is which is not.',
      ],
    };
  }

  /** A payment from fully mixed DASH: no change, and the fixed sizes may overpay the fee a little. */
  async prepareDashPrivate(to: string, amountInput: string) {
    this.session();
    if (this.torNotReady) throw new Error('Tor is connecting. Try again once it connects.');
    if (!this.mixer) throw new Error('CoinJoin is not available.');
    const address = to.trim();
    if (!isDashAddress(address)) throw new Error('Not a Dash address. Only addresses starting with X can be used.');
    const isMax = amountInput.trim().toLowerCase() === 'max';
    const draft = await this.mixer.draftPrivate(address, isMax ? 'max' : parseAmount(amountInput, 8));
    const preview = this.storePreview({ asset: 'DASH', to: address, amount: draft.amount, fee: draft.fee, dashPrivate: draft });
    return {
      id: preview.id, asset: 'DASH' as Asset, to: address, amount: formatAmount(draft.amount, 8), fee: formatAmount(draft.fee, 8), feeAsset: 'DASH', feeIsEstimate: false,
      warnings: ['Paid from mixed coins only, with no change. Mixed coins come in fixed sizes, so a small rest goes to the fee.'],
    };
  }

  async coinjoinPause(paused: boolean): Promise<void> {
    this.session();
    if (!this.mixer) throw new Error('CoinJoin is not available.');
    await this.mixer.setPaused(paused);
  }

  /** Moves every confirmed public FIRO coin into the private (Spark) balance. Confirmed with confirmSend. */
  async prepareFiroPrivate() {
    this.session();
    if (this.torNotReady) throw new Error('Tor is connecting. Try again once it connects.');
    if (!this.spark) throw new Error('Private (Spark) FIRO isn\'t available on this device.');
    const draft = await this.spark.mintDraft(await this.firo!.confirmedUtxos());
    const preview = this.storePreview({ asset: 'FIRO', to: draft.to, amount: draft.amount, fee: draft.fee, mint: draft });
    return {
      id: preview.id, asset: 'FIRO' as Asset, to: draft.to, amount: formatAmount(draft.amount, 8), fee: formatAmount(draft.fee, 8), feeAsset: 'FIRO', feeIsEstimate: false,
      warnings: ['How much you make private is visible on the chain. Where it goes from the private balance is not.'],
    };
  }

  async zecShield(password: string) {
    if (!this.zec) throw new Error('Zcash is not available on this device.');
    if (this.torNotReady) throw new Error('Tor is connecting. Try again once it connects.');
    const secrets = await this.vault.open(password);
    return { hashes: await this.zec.shield(secrets.tronMnemonic) };
  }

  /** date: YYYY-MM-DD. The earlier the date, the longer the scan. */
  async zecRescan(date: string, password: string): Promise<void> {
    if (!this.zec) throw new Error('Zcash is not available on this device.');
    const parsed = /^\d{4}-\d{2}-\d{2}$/.test(date.trim()) ? new Date(date.trim() + 'T00:00:00Z') : null;
    if (!parsed || Number.isNaN(parsed.getTime())) throw new Error('Enter the date as YYYY-MM-DD.');
    const secrets = await this.vault.open(password);
    await this.zec.rescan(secrets.tronMnemonic, zecHeightForDate(parsed));
  }

  // ---- security & settings ----

  async revealSeeds(password: string) {
    const s = await this.vault.open(password);
    return { tronMnemonic: s.tronMnemonic, moneroSeed: s.moneroSeed, ...(s.passphrase ? { passphrase: s.passphrase } : {}) };
  }

  async changePassword(current: string, next: string): Promise<void> {
    const secrets = await this.vault.open(current);
    await this.vault.save(next, secrets);
  }

  /** Locks if anything that affects connections changed. Returns whether it did. */
  async updateSettings(patch: Partial<Settings>): Promise<boolean> {
    const next: Settings = { ...this.settings };
    if (typeof patch.customMoneroNode === 'string') {
      const node = patch.customMoneroNode.trim();
      if (node && !/^https?:\/\/[^\s/]+(:\d+)?\/?$/.test(node)) throw new Error('Enter the node address as http://host:port.');
      next.customMoneroNode = node;
    }
    if (typeof patch.customBtcServer === 'string') next.customBtcServer = checkOwnServer(patch.customBtcServer);
    if (patch.customServers && typeof patch.customServers === 'object') {
      const servers: Record<string, string> = {};
      for (const { coin, blockbook } of OWN_SERVER_COINS) {
        const raw = String((patch.customServers as Record<string, unknown>)[coin] ?? '').trim();
        if (!raw) continue;
        const bb = blockbook && raw.startsWith('blockbook+');
        try { servers[coin] = (bb ? 'blockbook+' : '') + checkOwnServer(bb ? raw.slice('blockbook+'.length) : raw); } catch (e) { throw new Error(`${coin}: ${(e as Error).message}`); }
      }
      next.customServers = servers;
    }
    if (patch.coinjoinTarget !== undefined) {
      if (!MIX_TARGETS.includes(Number(patch.coinjoinTarget))) throw new Error('Choose how many others to hide each coin among.');
      next.coinjoinTarget = Number(patch.coinjoinTarget);
    }
    if (typeof patch.coinjoinCoordinator === 'string') {
      const c = patch.coinjoinCoordinator.trim();
      const known = COINJOIN_COORDINATORS.some((k) => k.url === c);
      const own = known ? c : checkOwnServer(c);
      if (!own) throw new Error('Choose a CoinJoin coordinator.');
      if (!known && !/^https:\/\//.test(own) && !/\.onion(:\d+)?(\/|$)/.test(new URL(own).host + '/')) throw new Error('A CoinJoin coordinator has to be https:// or an .onion address.');
      next.coinjoinCoordinator = known ? c : `${own.replace(/\/+$/, '')}/`;
    }
    if (typeof patch.customZanoNode === 'string') {
      const node = patch.customZanoNode.trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
      if (node && !/^[A-Za-z0-9.-]+:\d{2,5}$/.test(node)) throw new Error('Enter the Zano node as host:port, for example 192.168.1.5:11211.');
      next.customZanoNode = node;
    }
    if (typeof patch.customKsrNode === 'string') {
      const node = patch.customKsrNode.trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
      if (node && !/^[A-Za-z0-9.-]+:\d{2,5}$/.test(node)) throw new Error('Enter the Kusari node as host:port, for example 192.168.1.5:21081.');
      next.customKsrNode = node;
    }
    if (typeof patch.showPrices === 'boolean') next.showPrices = patch.showPrices;
    if (typeof patch.tornadoRelayer === 'string') next.tornadoRelayer = patch.tornadoRelayer.trim();
    if (typeof patch.simpleSwapKey === 'string') next.simpleSwapKey = patch.simpleSwapKey.trim();
    if (typeof patch.ghostSwapKey === 'string') next.ghostSwapKey = patch.ghostSwapKey.trim();
    if (typeof patch.torEnabled === 'boolean') {
      if (patch.torEnabled && !this.tor.isInstalled()) throw new Error('Install Tor first.');
      next.torEnabled = patch.torEnabled;
    }
    if (typeof patch.torBridge === 'string' || typeof patch.torBridgeLines === 'string') {
      const bridge = (patch.torBridge ?? next.torBridge) as TorBridge;
      if (!TOR_BRIDGES.includes(bridge)) throw new Error('Unknown Tor connection method.');
      const lines = typeof patch.torBridgeLines === 'string' ? patch.torBridgeLines : next.torBridgeLines;
      if (bridge === 'custom') parseCustomBridges(lines); // says what's wrong before anything is saved
      next.torBridge = bridge;
      next.torBridgeLines = lines.trim();
    }
    if (typeof patch.tronApiKey === 'string') next.tronApiKey = patch.tronApiKey.trim();
    // Each EVM chain on its own address, or all on one: the wallet reopens with the other addresses.
    const evmChanged = typeof patch.evmSeparate === 'boolean' && Boolean(this.tron) && patch.evmSeparate !== this.evmSplit;
    if (evmChanged) await this.writeEvmLayout(patch.evmSeparate as boolean);
    // Private Bitcoin sync: on or off, and from which date. The wallet reopens to start it over.
    let btcSyncChanged = false;
    if (Boolean(this.tron) && (typeof patch.btcFilters === 'boolean' || typeof patch.btcFiltersFrom === 'string')) {
      const now = await this.readBtcSync();
      const on = typeof patch.btcFilters === 'boolean' ? patch.btcFilters : now.filters;
      let from = typeof patch.btcFiltersFrom === 'string' ? patch.btcFiltersFrom.trim() : now.from ?? '';
      if (on && !from) throw new Error('Choose the date this wallet was first used.');
      let birthday = now.birthday;
      if (from) {
        const date = new Date(from + 'T00:00:00Z');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || Number.isNaN(date.getTime()) || date.getTime() > Date.now() + 86_400_000) throw new Error('Enter the date as YYYY-MM-DD.');
        birthday = btcBirthdayFor(date);
      } else from = '';
      if (on !== now.filters || birthday !== now.birthday) {
        await this.writeBtcSync({ filters: on, birthday, from: from || undefined });
        btcSyncChanged = true;
      }
    }
    const reconnect = next.network !== this.settings.network
      || next.customMoneroNode !== this.settings.customMoneroNode
      || next.customBtcServer !== this.settings.customBtcServer
      || JSON.stringify(next.customServers ?? {}) !== JSON.stringify(this.settings.customServers ?? {})
      || next.customZanoNode !== this.settings.customZanoNode
      || next.customKsrNode !== this.settings.customKsrNode
      || next.tronApiKey !== this.settings.tronApiKey
      || next.torEnabled !== this.settings.torEnabled
      || evmChanged || btcSyncChanged;
    const bridgeChanged = next.torBridge !== this.settings.torBridge || next.torBridgeLines !== this.settings.torBridgeLines;
    this.settings = next;
    await fs.mkdir(this.dir, { recursive: true });
    const { evmSeparate: _perWallet, developer: _build, btcFilters: _btcSync, btcFiltersFrom: _btcFrom, passphrase: _pass, ...saved } = next;
    await fs.writeFile(this.settingsPath, JSON.stringify(saved, null, 2), { mode: 0o600 });
    // A new way in only restarts Tor; the wallet stays open, and traffic waits for Tor as at any restart.
    if (bridgeChanged && this.torActive) this.applyBridge();
    if (reconnect && this.tron) await this.lock();
    return reconnect;
  }

  /** Removes the wallet from this PC. Funds stay on chain and need the seeds to recover. */
  /** Returns which wallet was removed, so the Android side can clear what it keeps elsewhere. */
  async deleteWallet(password: string): Promise<string> {
    // A wallet whose file is already gone has nothing left to protect, so it goes without a password.
    if (await this.vault.exists()) await this.vault.open(password);
    const cap = (p: Promise<unknown>, ms: number) => Promise.race([p.catch(() => undefined), new Promise((r) => setTimeout(r, ms))]);
    // From a decoy session only the decoy goes; the real wallet's files and place in the list stay.
    if (this.duressOf) {
      const real = this.duressOf;
      const decoyDir = this.dir;
      const decoyVault = this.vault;
      await cap(this.lock(), 5000);
      await cap(this.engineStops, 5000);
      await decoyVault.destroy().catch(() => undefined);
      await fs.rm(decoyDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => this.rememberLeftovers([decoyDir]));
      await fs.rm(path.join(this.walletDir(real), 'duress.json'), { force: true }).catch(() => undefined);
      return real;
    }
    // Never stuck behind an engine or a sync step: they are stopped, and given a few seconds to let go of files.
    await cap(this.lock(), 5000);
    await cap(this.engineStops, 5000);
    const id = this.walletId;
    const dir = this.dir;
    // Its hidden wallet goes with it, or a new wallet made in its place would open the old decoy.
    await this.slotting;
    await this.duressDrop(dir);
    await fs.rm(path.join(dir, 'duress-state.json'), { force: true }).catch(() => undefined);
    // Off the list first, so the wallet is gone even if Windows still holds one of its files.
    const r = await this.walletRegistry();
    const left = r.list.filter((w) => w.id !== id);
    const next = left.length ? { active: left[0].id, list: left } : { active: 'main', list: [{ id: 'main', name: 'My wallet' }] };
    await this.vault.destroy();
    await this.walletRegistrySave(next);
    this.activate(next.active);
    const targets = id === 'main'
      // The app's shared files live next to this wallet's, so only its own are removed.
      ? [path.join(dir, 'xmr'), ...['swaps.json', 'privacy-swaps.json', 'tornado.json', 'zec-state.json', 'mode.json', 'walletconnect.json', 'spark-servers.json', 'coinjoin.json'].map((f) => path.join(dir, f))]
      : [dir];
    const stuck: string[] = [];
    for (const t of targets) {
      try { await fs.rm(t, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { stuck.push(t); }
    }
    if (stuck.length) await this.rememberLeftovers(stuck);
    return id;
  }

  protected get leftoversPath() { return path.join(this.baseDir, 'leftovers.json'); }

  /** Files a deleted wallet left behind because something still had them open. Removed at the next start. */
  protected async rememberLeftovers(paths: string[]): Promise<void> {
    let list: string[] = [];
    try { list = JSON.parse(await fs.readFile(this.leftoversPath, 'utf8') as unknown as string); } catch { list = []; }
    await fs.writeFile(this.leftoversPath, JSON.stringify([...new Set([...list, ...paths])]));
  }

  async removeLeftovers(): Promise<void> {
    let list: string[] = [];
    try { list = JSON.parse(await fs.readFile(this.leftoversPath, 'utf8') as unknown as string); } catch { return; }
    const r = await this.walletRegistry();
    const inUse = new Set(r.list.filter((w) => w.id !== 'main').map((w) => path.resolve(this.walletDir(w.id))));
    const mainInUse = await fs.access(path.join(this.baseDir, 'vault.json')).then(() => true, () => false);
    const left: string[] = [];
    for (const p of list) {
      const full = path.resolve(p);
      // Only below this app's folder, and never a wallet that is on the list again.
      if (!full.startsWith(path.resolve(this.baseDir) + path.sep) || inUse.has(full)) continue;
      if (mainInUse && !full.startsWith(path.resolve(this.baseDir, 'wallets') + path.sep)) continue;
      try { await fs.rm(p, { recursive: true, force: true }); } catch { left.push(p); }
    }
    if (left.length) await fs.writeFile(this.leftoversPath, JSON.stringify(left)); else await fs.rm(this.leftoversPath, { force: true });
  }

  /**
   * LocalCoinSwap's P2P marketplace: coins are bought from other people, with payment methods the sellers offer.
   * The wallet only opens the page; nothing about this wallet is put in the link.
   */
  buyUrl(asset: Asset): string {
    return BUY_PAGE;
  }

  explorerUrl(asset: Asset, hash: string): string {
    if (isEvm(asset)) {
      if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error('Invalid transaction hash.');
      return EVM_EXPLORER[String(chainOf(asset).id)] + hash;
    }
    // Each chain's own ID format, so nothing but an ID can be put after the explorer's address.
    const b58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
    const ok = asset === 'SOL' || isSpl(asset) ? b58.test(hash) && hash.length >= 64 && hash.length <= 90
      : asset === 'GRAM' || asset === 'USDTT' ? /^[0-9a-fA-F]{64}$/.test(hash) || /^[A-Za-z0-9_-]{43}=?$/.test(hash)
      : /^[0-9a-fA-F]{64}$/.test(hash);
    if (!ok) throw new Error('Invalid transaction hash.');
    const net = NETWORKS[this.settings.network];
    if (asset === 'DASH') return DASH_EXPLORER_TX + hash;
    if (asset === 'FIRO') return FIRO_EXPLORER_TX + hash;
    if (asset === 'SOL' || isSpl(asset)) return SOL_EXPLORER_TX + hash;
    if (asset === 'DOGE') return DOGE_EXPLORER_TX + hash;
    if (asset === 'DCR') return DCR_EXPLORER_TX + hash;
    if (asset === 'BCH') return BCH_EXPLORER_TX + hash;
    if (asset === 'ZEC') return ZEC_EXPLORER_TX + hash;
    if (asset === 'ZANO') return ZANO_EXPLORER_TX + hash;
    if (asset === 'KSR') {
      if (!KSR_EXPLORER_TX) throw new Error('Kusari has no public explorer yet.');
      return KSR_EXPLORER_TX + hash;
    }
    if (ACCOUNT_COINS[asset]) return ACCOUNT_COINS[asset]!.explorerTx + hash;
    if (asset === 'ARRR') return ARRR_EXPLORER_TX + hash;
    if (asset === 'BTC') return BTC_EXPLORER_TX + hash;
    if (asset === 'LTC') return LTC_EXPLORER_TX + hash;
    return (asset === 'XMR' ? net.monero.explorerTx : net.tron.explorerTx) + hash;
  }
}

/** The most a send nobody reviews (a mixer's send-on at a random time) may pay its relayer, in percent. */
export const UNATTENDED_FEE_PERCENT = 2n;

/** How long a delayed Bitcoin send may wait: it goes out at a random moment within it. */
export const DELAY_CHOICES = [10, 60, 240];
/** When a mixer send goes out later: a random moment 1 to 24 hours from now (the wallet has to be open then). */
export function randomLater(now = Date.now()): number { return now + Math.round((60 + Math.random() * 23 * 60) * 60_000); }
