// The wallet service, second layer: sends, fees, Tornado Cash, coin control, private transfers and settings.
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import { formatAmount, parseAmount } from './amount';
import { Asset, BTC_EXPLORER_TX, DECIMALS, FIRO_EXPLORER_TX, SOL_EXPLORER_TX, BUY_PAGE, BCH_EXPLORER_TX, LTC_EXPLORER_TX, SCRT_EXPLORER_TX, DOGE_EXPLORER_TX, DASH_EXPLORER_TX, ARRR_EXPLORER_TX, KSR_EXPLORER_TX, ZANO_EXPLORER_TX, ZEC_EXPLORER_TX, NETWORKS, OWN_SERVER_COINS, Settings } from './config';
import { TronTransfer, deriveTronAccount, isTronAddress } from './tron';
import { requestJson } from './request';
import { isScrtAddress } from './scrt';
import { isSilentAddress } from './btc-silent';
import { type BtcClient, type BtcDraft, LITECOIN, coinId, estimateVbytes, isBtcAddress, isLtcAddress } from './btc';
import { DEPOSIT_GAS, TORNADO_POOLS, TornadoNote, TornadoStore, WITHDRAW_GAS, abi as tornadoAbi, checkRelayerUrl, denomination, noteSecrets, noteText, relayerFee, relayerStatus, relayerSubmit, tornadoEngineCheck } from './tornado';
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
import { ADA_EXPLORER_TX, isAdaAddress } from './ada';
import { isBchAddress, normalBchAddress, typicalBchFee } from './bch';
import { SOL_FEE, SPL_TOKENS, isSolAddress } from './sol';
import { DASH_DUST, dashFee, isDashAddress, signDashOutputs, typicalDashFee } from './dash';
import { DashMixer, MIX_ROUNDS } from './dash-mix';
import { COINJOIN_COORDINATORS, MIX_TARGETS } from './btc-mix';
import type { InsightUtxo } from './insight';
import { chainOf, deriveEthAccount, isEthAddress } from './eth';
import { TOR_BRIDGES, TorBridge, parseCustomBridges } from './tor-bridges';
import { checkOwnServer, COIN_ID, EVM_EXPLORER, isEvm, isSpl, Preview, PREVIEW_TTL_MS, withTimeoutValue } from './service-common';
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
      if (asset === 'DOGE') return [typicalDogeFee(), 8, 'DOGE'];
      if (asset === 'ADA') return [180_000n, 6, 'ADA'];
      if (asset === 'BCH') return [typicalBchFee(), 8, 'BCH'];
      if (asset === 'SCRT') return [25_000n, 6, 'SCRT']; // about 100k gas at 0.25 uscrt
      if (asset === 'SSCRT') return [50_000n, 6, 'SCRT']; // a contract call, about 200k gas
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

  // ---- Tornado Cash: fixed ETH pools on mainnet ----

  protected get tornadoStore() { return new TornadoStore(this.dir, this.baseDir, this.records); }
  protected get tornadoPoolMap(): Record<string, string> { return this.dev.tornadoPools ?? TORNADO_POOLS; }
  protected poolAddress(pool: string): string {
    const address = this.tornadoPoolMap[pool];
    if (!address) throw new Error('No such pool.');
    return address;
  }

  async tornadoInfo() {
    const store = await this.tornadoStore.read();
    return { pools: Object.keys(this.tornadoPoolMap).sort((a, b) => Number(a) - Number(b)), notes: store.notes, relayer: this.settings.tornadoRelayer };
  }

  /** Fails early and visibly if the proof engine can't start on this device. */
  async tornadoCheck(): Promise<boolean> { await tornadoEngineCheck(); return true; }

  async tornadoDepositPrepare(pool: string) {
    const { eth } = this.session();
    const to = this.poolAddress(pool);
    const draft = await eth.draftCall(to, denomination(pool), DEPOSIT_GAS);
    const preview = this.storePreview({ asset: 'ETH', to, amount: draft.amount, fee: draft.expectedFee, eth: draft });
    return { id: preview.id, pool, to, amount: formatAmount(draft.amount, 18), fee: formatAmount(draft.expectedFee, 18), feeAsset: 'ETH' };
  }

  async tornadoDepositConfirm(id: string, pool: string, password: string): Promise<TornadoNote> {
    const { eth } = this.session();
    const preview = this.previews.get(id);
    if (!preview?.eth || preview.expires < Date.now() || preview.to !== this.poolAddress(pool)) throw new Error('The review expired. Try again.');
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
    const note: TornadoNote = { id: randomUUID(), pool, index, commitment, status: 'sending', createdAt: Date.now() };
    store.next = index + 1;
    store.notes.unshift(note);
    await this.tornadoStore.write(store);
    try {
      note.txHash = await eth.send({ ...preview.eth, data: tornadoAbi.encodeFunctionData('deposit', [commitment]) }, deriveEthAccount(secrets.tronMnemonic).wallet);
      note.status = 'deposited';
    } catch (e) {
      store.notes = store.notes.filter((n) => n.id !== note.id);
      await this.tornadoStore.write(store);
      throw e;
    }
    await this.tornadoStore.write(store);
    this.emit('balance-changed');
    return note;
  }

  async tornadoExport(noteId: string, password: string): Promise<string> {
    const store = await this.tornadoStore.read();
    const note = store.notes.find((n) => n.id === noteId);
    if (!note) throw new Error('No such deposit.');
    const secrets = await this.vault.open(password);
    return noteText(note.pool, noteSecrets(secrets.tronMnemonic, note.index));
  }

  /** Fee and amounts for the review screen. Nothing heavy, nothing sent. */
  async tornadoWithdrawQuote(noteId: string, recipientInput: string, relayerInput: string) {
    const { eth } = this.session();
    const store = await this.tornadoStore.read();
    const note = store.notes.find((n) => n.id === noteId);
    if (!note) throw new Error('No such deposit.');
    const recipient = recipientInput.trim();
    if (!isEthAddress(recipient)) throw new Error('The receiving address is not an Ethereum address.');
    if (recipient.toLowerCase() === eth.address.toLowerCase()) throw new Error('Receiving at the deposit address gives no privacy benefit. Enter a new address.');
    const total = denomination(note.pool);
    if (!relayerInput.trim()) {
      const gas = (await eth.gasPrice()) * WITHDRAW_GAS;
      return { mode: 'self' as const, pool: note.pool, recipient, fee: formatAmount(gas, 18), feeFrom: 'wallet' as const, receive: formatAmount(total, 18) };
    }
    const url = checkRelayerUrl(relayerInput, Boolean(this.dev.tornadoLocalRelayer));
    const info = await relayerStatus(url, this.priceAgent);
    const fee = relayerFee(note.pool, info.feePercent, await eth.gasPrice());
    return { mode: 'relayer' as const, pool: note.pool, recipient, relayer: info.rewardAccount, fee: formatAmount(fee, 18), feeFrom: 'note' as const, receive: formatAmount(total - fee, 18) };
  }

  async tornadoWithdraw(noteId: string, recipientInput: string, relayerInput: string, password: string) {
    const { eth } = this.session();
    const say = (m: string) => this.emit('tornado-progress', m);
    const tor = this.tornadoStore;
    const store = await tor.read();
    const note = store.notes.find((n) => n.id === noteId);
    if (!note) throw new Error('No such deposit.');
    const secrets = await this.vault.open(password);
    const quote = await this.tornadoWithdrawQuote(noteId, recipientInput, relayerInput);
    const address = this.poolAddress(note.pool);
    const keys = noteSecrets(secrets.tronMnemonic, note.index);
    const [{ commitment, nullifierHash }] = await runTornado('commit', { notes: [keys] });
    if (commitment !== note.commitment) throw new Error('This deposit is not from this seed.');
    const spent = tornadoAbi.decodeFunctionResult('isSpent', await eth.call(address, tornadoAbi.encodeFunctionData('isSpent', [nullifierHash])));
    if (spent[0]) { note.status = 'withdrawn'; await tor.write(store); throw new Error('This deposit was already withdrawn.'); }

    const leaves = await tor.leaves(note.pool, address, eth, { seed: !this.dev.tornadoPools, agent: this.priceAgent, progress: say });
    const leafIndex = leaves.findIndex((l) => l.toLowerCase() === commitment.toLowerCase());
    if (leafIndex < 0) throw new Error('The deposit isn\'t confirmed on the chain yet. Try again after it confirms.');
    const relayer = quote.mode === 'relayer' ? quote.relayer as string : `0x${'0'.repeat(40)}`;
    const fee = quote.mode === 'relayer' ? parseAmount(quote.fee, 18) : 0n;
    const { proof, args } = await runTornado('prove', { leaves, leafIndex, ...keys, recipient: quote.recipient, relayer, fee: fee.toString() }, (stage) => {
      say(stage === 'tree' ? `Building the Merkle tree… ${leaves.length} deposits, so this can take a few minutes.` : 'Making the zero-knowledge proof… The screen may seem to freeze. Don\'t close the app.');
    });
    const known = tornadoAbi.decodeFunctionResult('isKnownRoot', await eth.call(address, tornadoAbi.encodeFunctionData('isKnownRoot', [args[0]])));
    if (!known[0]) throw new Error('The deposit records don\'t match the chain, so this was stopped. Your coins are safe. Try again.');

    note.status = 'withdrawing';
    note.recipient = quote.recipient;
    await tor.write(store);
    say('Sending the withdrawal…');
    try {
      let txHash: string;
      if (quote.mode === 'relayer') {
        txHash = await relayerSubmit(await relayerStatus(checkRelayerUrl(relayerInput, Boolean(this.dev.tornadoLocalRelayer)), this.priceAgent), address, proof, args, this.priceAgent, this.dev.tornadoLocalRelayer ? 200 : 5000);
      } else {
        const draft = await eth.draftCall(address, 0n, WITHDRAW_GAS);
        const data = tornadoAbi.encodeFunctionData('withdraw', [proof, args[0], args[1], quote.recipient, relayer, 0n, 0n]);
        txHash = await eth.send({ ...draft, data }, deriveEthAccount(secrets.tronMnemonic).wallet);
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
    for (const [pool, address] of Object.entries(this.tornadoPoolMap)) {
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

  async prepareSend(asset: Asset, to: string, amountInput: string, opts: { coins?: string[]; fromMixed?: boolean } = {}) {
    const { tron, monero, btc, eth, dash } = this.session();
    if (this.torNotReady) throw new Error('Tor is connecting. Try again once it connects.');
    const address = to.trim();
    const isMax = amountInput.trim().toLowerCase() === 'max';
    const decimals = DECIMALS[asset];
    const warnings: string[] = [];
    let preview: Preview;

    if (asset === 'ARRR') {
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
    } else if (asset === 'ADA') {
      if (!isAdaAddress(address)) throw new Error('Not a Cardano address. Use a Shelley address starting with addr1.');
      const draft = await this.ada!.draft(address, isMax ? 'max' : parseAmount(amountInput, decimals));
      preview = this.storePreview({ asset, to: address, amount: draft.amount, fee: draft.fee, ada: draft });
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
    } else if (asset === 'SCRT') {
      if (!isScrtAddress(address)) throw new Error('Not a Secret Network address. Only addresses starting with secret1 can be used.');
      const draft = await this.scrt!.draft(address, isMax ? 'max' : parseAmount(amountInput, decimals));
      preview = this.storePreview({ asset, to: address, amount: draft.amount, fee: draft.fee, scrt: draft });
    } else if (asset === 'SSCRT') {
      const draft = await this.scrt!.draftPrivate('transfer', address, isMax ? 'max' : parseAmount(amountInput, decimals));
      preview = this.storePreview({ asset, to: address, amount: draft.amount, fee: draft.fee, scrt: draft });
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
        preview = this.storePreview({ asset, to: address, amount: draft.amount, fee: draft.fee, btc: draft });
      }
    } else if (isEvm(asset)) {
      if (!isEthAddress(address)) throw new Error('Not an Ethereum address. Only addresses starting with 0x can be used.');
      if (address.toLowerCase() === eth.address.toLowerCase() || address.toLowerCase() === this.evm(asset).address.toLowerCase()) throw new Error('You cannot send to your own address.');
      const chain = chainOf(asset);
      const draft = await this.evm(asset).draft(asset, address, isMax ? 'max' : parseAmount(amountInput, decimals));
      if (asset === chain.native && isMax) warnings.push(`If the actual fee is lower than expected, a little ${chain.symbol} stays behind.`);
      if (chain.id !== 1n) warnings.push(`This sends on ${chain.name}. Make sure the receiver accepts ${chain.name}: the same 0x address on another network won't show it.`);
      preview = this.storePreview({ asset, to: address, amount: draft.amount, fee: draft.expectedFee, eth: draft });
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
        const probe = await tron.estimateFee({ asset, to: address, amount: 1n });
        const amount = isMax ? trx - probe.feeSun : parseAmount(amountInput, decimals);
        if (amount <= 0n) throw new Error('No TRX left to send after the fee.');
        if (amount + probe.feeSun > trx) throw new Error('Not enough TRX to cover the amount and fee.');
        if (probe.recipientIsNew) warnings.push('This is a new address, so an activation fee is included.');
        preview = this.storePreview({ asset, to: address, amount, fee: probe.feeSun, tron: { asset, to: address, amount } });
      }
    }
    // Coins spent together are tied together on the chain; say so, unless the person picked the coins themselves.
    const utxoDraft: { inputs?: unknown[] } | undefined = preview.btc ?? preview.ltc ?? preview.doge ?? preview.bch ?? preview.dash ?? preview.firo;
    const picked = Array.isArray(opts.coins) && opts.coins.length > 0;
    if (!picked && (utxoDraft?.inputs?.length ?? 0) > 1) warnings.push(`This spends ${utxoDraft!.inputs!.length} of your coins together, which shows on the chain that they belong to one person. Sending a smaller amount that one coin covers, or choosing coins yourself, keeps them apart.`);
    // A look-alike of an address used before is the mark of address poisoning.
    const imitated = lookalikeOf(address, [...(await this.recipients()), ...Object.values(await this.addresses().catch(() => ({}))).filter((x): x is string => typeof x === 'string')]);
    const lookalike = imitated ? { address: imitated } : null;
    if (imitated) warnings.unshift(`Careful: this address starts and ends like ${imitated}, which you used before, but the middle is different. Scammers send tiny amounts from look-alike addresses so one gets copied from the history. Check every character before sending.`);
    return {
      id: preview.id, asset, to: address, lookalike,
      amount: formatAmount(preview.amount, decimals),
      fee: formatAmount(preview.fee, preview.eth ? 18 : asset === 'XMR' ? 12 : asset === 'ZANO' || asset === 'KSR' ? 12 : asset === 'SCRT' || asset === 'SSCRT' || asset === 'ADA' ? 6 : asset === 'SOL' || isSpl(asset) ? 9 : asset === 'DOGE' || asset === 'BCH' || asset === 'LTC' || asset === 'BTC' || asset === 'DASH' || asset === 'FIRO' || asset === 'ZEC' || asset === 'ARRR' ? 8 : 6),
      feeAsset: preview.eth ? chainOf(preview.eth.asset).native : isSpl(asset) ? 'SOL' : asset === 'SSCRT' ? 'SCRT' : asset === 'SOL' || asset === 'ADA' || asset === 'DOGE' || asset === 'BCH' || asset === 'LTC' || asset === 'SCRT' || asset === 'XMR' || asset === 'BTC' || asset === 'DASH' || asset === 'FIRO' || asset === 'ZEC' || asset === 'ZANO' || asset === 'KSR' || asset === 'ARRR' ? asset : 'TRX',
      feeIsEstimate: asset !== 'SOL' && !isSpl(asset) && asset !== 'ADA' && asset !== 'DOGE' && asset !== 'BCH' && asset !== 'LTC' && asset !== 'SCRT' && asset !== 'SSCRT' && asset !== 'XMR' && asset !== 'BTC' && asset !== 'DASH' && asset !== 'FIRO' && asset !== 'ZEC' && asset !== 'ZANO' && asset !== 'KSR' && asset !== 'ARRR',
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

  // ---- delayed sends (Bitcoin) ----
  // A send signed now goes out at a random moment within the chosen time, so its timing doesn't tie it to what
  // happened just before (a swap, a CoinJoin, a payment received). The signed transaction is kept encrypted with
  // the wallet's records until then, also across a lock or a restart; the seed is not kept.

  protected delayedTimers = new Map<string, ReturnType<typeof setTimeout>>();
  protected override async afterBtcReady(): Promise<void> { for (const e of await this.delayedList()) this.armDelayed(e); }
  protected override onLock(): void { for (const t of this.delayedTimers.values()) clearTimeout(t); this.delayedTimers.clear(); }
  protected get delayedPath(): string { return path.join(this.dir, 'btc-delayed.json'); }

  protected async scheduleSend(preview: Preview, mnemonic: string, minutes: number) {
    const draft = preview.btc ?? preview.btcMixed;
    if (!draft) throw new Error('Only Bitcoin sends can go out later.');
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
    if (preview.doge) return { hashes: [await this.doge!.send(preview.doge, secrets.tronMnemonic)] };
    if (preview.ada) return { hashes: [await this.ada!.send(preview.ada, secrets.tronMnemonic)] };
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
    if (preview.scrt) return { hashes: [await this.scrt!.send(preview.scrt, secrets.tronMnemonic)] };
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
    if (preview.btc) {
      return { hashes: [await btc.send(preview.btc, secrets.tronMnemonic)] };
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

  /**
   * wrap: SCRT into private sSCRT. unwrap: back to plain SCRT. key: sets the viewing key once, so the private balance
   * can be read. Each is a transaction, confirmed with confirmSend like any other.
   */
  async prepareScrtPrivate(kind: 'wrap' | 'unwrap' | 'key', amountInput: string) {
    this.session();
    if (this.torNotReady) throw new Error('Tor is connecting. Try again once it connects.');
    const isMax = amountInput.trim().toLowerCase() === 'max';
    const amount = kind === 'key' ? 0n : isMax ? 'max' as const : parseAmount(amountInput, 6);
    const draft = await this.scrt!.draftPrivate(kind, this.scrt!.address, amount);
    const asset: Asset = kind === 'unwrap' ? 'SCRT' : 'SSCRT';
    const preview = this.storePreview({ asset, to: draft.to, amount: draft.amount, fee: draft.fee, scrt: draft });
    return {
      id: preview.id, asset, to: draft.to, kind,
      amount: formatAmount(draft.amount, 6), fee: formatAmount(draft.fee, 6), feeAsset: 'SCRT', feeIsEstimate: false,
      warnings: kind === 'wrap' ? ['How much you make private is visible on the chain. What you do with sSCRT afterwards is not.']
        : kind === 'unwrap' ? ['How much you make public is visible on the chain.']
        : ['If another wallet set a viewing key for this address, this replaces it there.'],
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
    if (typeof patch.autoLockMinutes === 'number' && patch.autoLockMinutes >= 1 && patch.autoLockMinutes <= 240) {
      next.autoLockMinutes = Math.floor(patch.autoLockMinutes);
    }
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
    if (asset === 'SSCRT') throw new Error('This coin can\'t be bought here.');
    return BUY_PAGE;
  }

  explorerUrl(asset: Asset, hash: string): string {
    if (isEvm(asset)) {
      if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error('Invalid transaction hash.');
      return EVM_EXPLORER[String(chainOf(asset).id)] + hash;
    }
    if (!/^[0-9a-fA-F]{64}$/.test(hash)) throw new Error('Invalid transaction hash.');
    const net = NETWORKS[this.settings.network];
    if (asset === 'DASH') return DASH_EXPLORER_TX + hash;
    if (asset === 'FIRO') return FIRO_EXPLORER_TX + hash;
    if (asset === 'SOL' || isSpl(asset)) return SOL_EXPLORER_TX + hash;
    if (asset === 'DOGE') return DOGE_EXPLORER_TX + hash;
    if (asset === 'ADA') return ADA_EXPLORER_TX + hash;
    if (asset === 'BCH') return BCH_EXPLORER_TX + hash;
    if (asset === 'ZEC') return ZEC_EXPLORER_TX + hash;
    if (asset === 'ZANO') return ZANO_EXPLORER_TX + hash;
    if (asset === 'KSR') {
      if (!KSR_EXPLORER_TX) throw new Error('Kusari has no public explorer yet.');
      return KSR_EXPLORER_TX + hash;
    }
    if (asset === 'ARRR') return ARRR_EXPLORER_TX + hash;
    if (asset === 'BTC') return BTC_EXPLORER_TX + hash;
    if (asset === 'LTC') return LTC_EXPLORER_TX + hash;
    if (asset === 'SCRT' || asset === 'SSCRT') {
      if (!/^[0-9A-F]{64}$/i.test(hash)) throw new Error('Private transfers have no public page. Only the sender and receiver can see them.');
      return SCRT_EXPLORER_TX + hash;
    }
    return (asset === 'XMR' ? net.monero.explorerTx : net.tron.explorerTx) + hash;
  }
}

/** How long a delayed Bitcoin send may wait: it goes out at a random moment within it. */
export const DELAY_CHOICES = [10, 60, 240];
