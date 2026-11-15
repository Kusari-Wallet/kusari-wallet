// Settings, and starting the app: wallet events and the first screen. Loaded last.
// ---- settings ----

async function renderSettings(): Promise<void> {
  const s = await wallet.getSettings();
  const netBox = errorBox(), pwBox = errorBox(), seedBox = errorBox(), delBox = errorBox();
  const node = h('input', { id: 'set-node', value: s.customMoneroNode, placeholder: 'http://127.0.0.1:18081', spellcheck: 'false' });
  const btcServer = h('input', { id: 'set-btc-server', value: s.customBtcServer ?? '', placeholder: 'http://umbrel.local:3006/api', spellcheck: 'false' });
  // A server of one's own for the other coins (the kinds as in OWN_SERVER_COINS on the main side).
  const OWN: [string, string, string][] = [['ETH', 'JSON-RPC', 'http://192.168.1.20:8545'], ['BSC', 'JSON-RPC', 'https://bsc.example/rpc'], ['POL', 'JSON-RPC', 'https://polygon.example/rpc'], ['ARB', 'JSON-RPC', 'https://arbitrum.example/rpc'], ['SOL', 'JSON-RPC', 'http://192.168.1.20:8899'], ['TRX', 'java-tron HTTP API', 'http://192.168.1.20:8090'], ['LTC', 'Esplora or Blockbook', 'http://umbrel.local:3006/api'], ['BCH', 'Bitcore or Blockbook', 'blockbook+https://bch.example'], ['DASH', 'Insight API', 'http://192.168.1.20:3001/insight-api'], ['FIRO', 'Insight API', 'http://192.168.1.20:3001/insight-api-zcoin'], ['DCR', 'Insight API (dcrdata)', 'http://192.168.1.20:7777/insight/api'], ['SCRT', 'REST (LCD)', 'https://secret.example'], ['ZEC', 'lightwalletd', 'https://192.168.1.20:9067'], ['ARRR', 'lightwalletd', 'https://192.168.1.20:9067']];
  const ownInputs = OWN.map(([coin, , example]) => [coin, h('input', { id: `set-own-${coin}`, value: s.customServers?.[coin] ?? '', placeholder: example, spellcheck: 'false' }) as HTMLInputElement] as const);
  const ownSection = h('details', { class: 'own-servers', id: 'own-servers', ...(Object.values(s.customServers ?? {}).some(Boolean) ? { open: true } : {}) },
    h('summary', {}, 'Your own servers for other coins'),
    h('p', { class: 'small muted' }, 'A server you run is asked instead of the public ones, so only it learns those addresses. Use https://, an .onion address, or an address on your own network (reached directly, not through Tor). Ethereum-type chains still read history from Blockscout. Empty uses public servers.'),
    ...ownInputs.map(([coin, input], i) => h('label', { class: 'field' }, h('span', {}, `${coinName(coin as Asset)} (${OWN[i][1]})`), input)));
  const zanoNode = h('input', { id: 'set-zano-node', value: s.customZanoNode ?? '', placeholder: '192.168.1.5:11211', spellcheck: 'false' });
  const ksrNode = h('input', { id: 'set-ksr-node', value: s.customKsrNode ?? '', placeholder: '192.168.1.5:21081', spellcheck: 'false' });
  const known = COORDINATORS.some(([url]) => url === s.coinjoinCoordinator);
  const coordinator = h('select', { id: 'set-coordinator' }, ...COORDINATORS.map(([url, name]) => h('option', { value: url, selected: url === (known ? s.coinjoinCoordinator : COORDINATORS[0][0]) }, name)), h('option', { value: 'custom', selected: !known && Boolean(s.coinjoinCoordinator) }, 'Another coordinator')) as HTMLSelectElement;
  const coordinatorUrl = h('input', { id: 'set-coordinator-url', value: known ? '' : s.coinjoinCoordinator ?? '', placeholder: 'https://coordinator.example/', spellcheck: 'false' }) as HTMLInputElement;
  const coordinatorRow = h('label', { class: 'field', id: 'set-coordinator-url-row', hidden: coordinator.value !== 'custom' }, h('span', {}, 'Coordinator address'), coordinatorUrl);
  const mixTarget = h('select', { id: 'set-cj-target' },
    h('option', { value: '1', selected: s.coinjoinTarget === 1 }, 'Mix once'),
    h('option', { value: '5', selected: (s.coinjoinTarget ?? 5) === 5 }, 'Until each coin hides among 5 others'),
    h('option', { value: '10', selected: s.coinjoinTarget === 10 }, 'Until each coin hides among 10 others')) as HTMLSelectElement;
  coordinator.addEventListener('change', () => { coordinatorRow.hidden = coordinator.value !== 'custom'; });
  const key = h('input', { id: 'set-key', value: s.tronApiKey, spellcheck: 'false', autocomplete: 'off' });
  const auto = h('input', { id: 'set-auto', type: 'number', min: '1', max: '240', value: String(s.autoLockMinutes) });
  const showPrices = h('input', { type: 'checkbox', id: 'set-prices', checked: s.showPrices });
  const evmSeparate = h('input', { type: 'checkbox', id: 'set-evm-separate', checked: Boolean(s.evmSeparate) });
  const btcFilters = h('input', { type: 'checkbox', id: 'set-btc-filters', checked: Boolean(s.btcFilters) }) as HTMLInputElement;
  const btcFrom = h('input', { id: 'set-btc-filters-from', type: 'date', value: s.btcFiltersFrom ?? '' }) as HTMLInputElement;
  const btcFromRow = h('label', { class: 'field', id: 'set-btc-filters-from-row' }, h('span', {}, 'Bitcoin first used on'), btcFrom,
    h('div', { class: 'hint' }, 'Blocks are checked from this date. Earlier means more to download: roughly 100 MB for each month, through Tor. Choose a date a little before your first Bitcoin was received.'));
  const showBtcFrom = () => { btcFromRow.style.display = btcFilters.checked ? '' : 'none'; };
  btcFilters.addEventListener('change', showBtcFrom);
  showBtcFrom();
  const zecInfo = await wallet.zecInfo();
  const zanoInfo = await wallet.zanoInfo();
  const ksrInfo = await wallet.ksrInfo();
  const arrrInfo = await wallet.arrrInfo();
  const tor = await wallet.torInfo();
  const torBox = errorBox();
  const useTor = h('input', { type: 'checkbox', id: 'set-tor', checked: tor.setting ?? tor.enabled });
  const torProgress = h('div', { class: 'tor-status', id: 'tor-status' });
  const BRIDGE_NAMES: Record<string, string> = { auto: 'Automatic (recommended)', none: 'Tor directly', snowflake: 'Snowflake', obfs4: 'obfs4 bridges', custom: 'My own bridges' };
  const ROUTE_DONE: Record<string, string> = { snowflake: 'Connected through Snowflake.', obfs4: 'Connected through obfs4 bridges.', custom: 'Connected through your bridges.' };
  const routeConnecting = (route: string, percent: number) => route === 'snowflake' ? `Connecting through Snowflake ${percent}%` : route === 'obfs4' ? `Connecting through obfs4 bridges ${percent}%` : route === 'custom' ? `Connecting through your bridges ${percent}%` : `Connecting ${percent}%`;
  const torRouteNote = h('div', { class: 'tor-status', id: 'tor-route' });
  const bridge = h('select', { id: 'set-tor-bridge' }, ...Object.entries(BRIDGE_NAMES).map(([v, n]) => h('option', { value: v, selected: v === (s.torBridge ?? 'auto') }, n))) as HTMLSelectElement;
  const bridgeLines = h('textarea', { id: 'set-tor-bridge-lines', rows: '3', spellcheck: 'false', placeholder: 'obfs4 1.2.3.4:443 FINGERPRINT cert=… iat-mode=0' }, s.torBridgeLines ?? '') as HTMLTextAreaElement;
  const bridgeLinesRow = h('label', { class: 'field', id: 'set-tor-bridge-lines-row', hidden: bridge.value !== 'custom' }, h('span', {}, 'Bridge lines'), bridgeLines,
    h('div', { class: 'hint' }, 'One per line. Get them from bridges.torproject.org or from the Tor Project\'s Telegram bot @GetBridgesBot.'));
  bridge.addEventListener('change', () => { bridgeLinesRow.hidden = bridge.value !== 'custom'; });
  const paintTor = (info: { enabled: boolean; installed: boolean; state: any }) => {
    const st = info.state;
    let text = info.installed ? `Ready${st.installedVersion ? ` (bundled ${st.installedVersion})` : ''}. It's off.` : 'Not installed yet. Turning it on downloads the official files and checks their signature before installing.';
    if (info.enabled && st.phase === 'starting') text = `Connecting ${st.percent}%`;
    if (info.enabled && st.phase === 'error') text = st.error ?? 'Connection failed';
    if (info.enabled && st.phase === 'starting' && st.route) text = routeConnecting(st.route, st.percent);
    if (info.enabled && st.phase === 'ready') {
      text = st.verified === true ? `Tor connection verified. Visible IP: ${st.exitIp}`
        : st.verified === false ? 'Warning: the check service says this isn\'t a Tor connection.' : 'Connected. Waiting for the Tor check service to answer.';
    }
    torProgress.textContent = text;
    torRouteNote.textContent = info.enabled && st.phase === 'ready' ? ROUTE_DONE[st.route] ?? '' : '';
  };
  paintTor(tor);
  onTorInstallMessage = (m) => { torProgress.textContent = m; };
  onTorState = (st) => paintTor({ enabled: tor.enabled, installed: tor.installed, state: st });
  const updateTor = h('button', { class: 'ghost', id: 'tor-update', hidden: !tor.installed || tor.updatable === false, onclick: () => busy(updateTor, 'Downloading…', torBox, async () => {
    await wallet.installTor();
    toast('Downloaded the latest Tor. It applies when you reopen the wallet.');
    if (tor.enabled) await wallet.lock();
  }) }, 'Update Tor');
  const copyLog = h('button', { class: 'ghost', id: 'copy-connection-log', onclick: async () => {
    await wallet.copy(await wallet.connectionLog());
    toast('Copied. It has no addresses, amounts or IP addresses.');
  } }, 'Copy connection log');
  const saved = h('span', { class: 'small muted', role: 'status' });
  const saveBtn = h('button', { id: 'save-settings', onclick: () => busy(saveBtn, 'Saving…', netBox, async () => {
    if (tor.allowed !== false && useTor.checked && !tor.installed) {
      await wallet.installTor();
      tor.installed = true;
    }
    const relocked = await wallet.updateSettings({ customMoneroNode: node.value, customBtcServer: btcServer.value, customServers: Object.fromEntries(ownInputs.map(([coin, input]) => [coin, input.value])), customZanoNode: zanoNode.value, customKsrNode: ksrNode.value, coinjoinCoordinator: coordinator.value === 'custom' ? coordinatorUrl.value : coordinator.value, coinjoinTarget: Number(mixTarget.value), tronApiKey: key.value, autoLockMinutes: Number(auto.value), showPrices: showPrices.checked, evmSeparate: evmSeparate.checked, btcFilters: btcFilters.checked, ...(btcFilters.checked ? { btcFiltersFrom: btcFrom.value } : {}), ...(tor.allowed === false ? {} : { torEnabled: useTor.checked, torBridge: bridge.value, torBridgeLines: bridgeLines.value }) });
    if (!relocked) { saved.textContent = 'Saved.'; void refresh(); }
  }) }, 'Save');

  const curPw = h('input', { type: 'password', autocomplete: 'current-password' });
  const newPw = h('input', { type: 'password', autocomplete: 'new-password' });
  const chgDone = h('span', { class: 'small muted', role: 'status' });
  const chg = h('button', { onclick: () => busy(chg, 'Changing…', pwBox, async () => {
    await wallet.changePassword(curPw.value, newPw.value);
    await wallet.biometric?.disable();
    curPw.value = ''; newPw.value = ''; chgDone.textContent = 'Password changed.';
  }) }, 'Change password');

  // A duress password opens a decoy wallet instead of this one.
  const duressBox = errorBox();
  const duress = await wallet.duressStatus().catch(() => ({ set: false }));
  const duressCur = h('input', { type: 'password', autocomplete: 'current-password', id: 'duress-current' }) as HTMLInputElement;
  const duressNew = h('input', { type: 'password', autocomplete: 'new-password', id: 'duress-new' }) as HTMLInputElement;
  const duressAgain = h('input', { type: 'password', autocomplete: 'new-password', id: 'duress-again' }) as HTMLInputElement;
  const duressState = h('p', { class: 'small', id: 'duress-state' }, duress.set ? 'A duress password is set.' : 'No duress password is set.');
  const duressSet = h('button', { id: 'duress-set', onclick: () => busy(duressSet, 'Setting up…', duressBox, async () => {
    if (duressNew.value !== duressAgain.value) throw new Error('The two duress passwords don\'t match.');
    await wallet.duressSet(duressCur.value, duressNew.value);
    duressCur.value = ''; duressNew.value = ''; duressAgain.value = '';
    duressState.textContent = 'A duress password is set.';
  }) }, duress.set ? 'Replace duress password' : 'Set duress password');
  const duressOff = h('button', { class: 'ghost', id: 'duress-remove', onclick: () => busy(duressOff, 'Removing…', duressBox, async () => {
    await wallet.duressRemove(duressCur.value);
    duressCur.value = '';
    duressState.textContent = 'No duress password is set.';
  }) }, 'Remove');

  const seedPw = h('input', { type: 'password', autocomplete: 'current-password', id: 'seed-pw' });
  const seedOut = h('div', {});
  const rev = h('button', { id: 'reveal', onclick: () => busy(rev, 'Opening…', seedBox, async () => {
    const seeds = await wallet.revealSeeds(seedPw.value);
    seedPw.value = '';
    setKids(seedOut, h('br'), seedCard('BTC·ETH·Tron seed', '', seeds.tronMnemonic),
      seeds.passphrase && h('div', { class: 'panel', id: 'seed-passphrase' }, h('h3', {}, 'Passphrase of the 12 words'), h('p', { class: 'mono' }, seeds.passphrase), h('p', { class: 'small muted' }, 'Needed with the 12 words to restore. The seed QR code doesn\'t include it.')),
      seedCard('Monero seed', '', seeds.moneroSeed), seedQrCard(seeds),
      h('button', { class: 'ghost', onclick: () => setKids(seedOut) }, 'Hide'));
  }) }, 'Show seeds');

  let bioSection: Child = null;
  if (wallet.biometric && await wallet.biometric.available()) {
    const bioBox = errorBox();
    const bioPw = h('input', { type: 'password', autocomplete: 'current-password', id: 'bio-pw' });
    const bioArea = h('div', {});
    const paintBio = async () => {
      if (await wallet.biometric.enabled()) {
        const off = h('button', { class: 'ghost', id: 'bio-off', onclick: async () => { await wallet.biometric.disable(); await paintBio(); } }, 'Turn off fingerprint login');
        setKids(bioArea, h('p', { class: 'small muted' }, 'Fingerprint login is on. You can also open with your password.'), h('br'), off);
      } else {
        const on = h('button', { id: 'bio-on', onclick: () => busy(on, 'Touch the fingerprint sensor…', bioBox, async () => {
          await wallet.revealSeeds(bioPw.value); // confirms the password before it is protected
          await wallet.biometric.enable(bioPw.value);
          bioPw.value = '';
          await paintBio();
        }) }, 'Turn on fingerprint login');
        setKids(bioArea, h('label', { class: 'field' }, h('span', {}, 'Password'), bioPw), on);
      }
    };
    await paintBio();
    bioSection = h('div', { class: 'section' }, h('h3', {}, 'Fingerprint login'), bioBox.el, bioArea,
      h('p', { class: 'hint' }, 'For opening the wallet. Sending coins still needs your password. Enrolling a new fingerprint on the phone turns this off for security.'));
  }

  // Android: the home screen can show a plain "Tools" icon instead of the wallet's.
  let plainSection: Child = null;
  if (wallet.plainLauncher) {
    const plain = h('input', { type: 'checkbox', id: 'plain-launcher', checked: await wallet.plainLauncher.get() }) as HTMLInputElement;
    const note = h('p', { class: 'small muted', id: 'plain-launcher-note', role: 'status' });
    plain.addEventListener('change', async () => {
      await wallet.plainLauncher.set(plain.checked);
      note.textContent = plain.checked ? 'The home screen now shows "Tools". It can take a moment, and a shortcut you made before may need to be added again.' : 'The home screen shows Kusari Wallet again.';
    });
    plainSection = h('div', { class: 'section' }, h('h3', {}, 'App icon'),
      h('label', { class: 'check' }, plain, h('span', {}, 'Show as "Tools" with a plain icon')),
      h('p', { class: 'hint' }, 'Someone glancing at your phone won\'t see a crypto wallet on the home screen. The app list in the phone\'s settings still names it.'), note);
  }

  const delPw = h('input', { type: 'password', autocomplete: 'current-password', id: 'del-pw' });
  const del = h('button', { class: 'danger', id: 'delete', onclick: () => busy(del, 'Deleting…', delBox, async () => {
    deleting = true;
    try {
      await wallet.deleteWallet(delPw.value);
      await boot();
    } finally {
      deleting = false;
    }
  }) }, 'Delete wallet from this device');

  show('send',
    h('div', { class: 'bar' }, h('span', {}), h('h2', {}, 'Settings'), h('span', {})),
    h('div', { class: 'scroll' },
      h('div', { class: 'section', id: 'sync-note' }, h('h3', {}, 'Why syncing takes a while'),
        h('p', { class: 'small' }, 'To keep your coins private, every connection goes through Tor (three relays around the world), each coin and each group of addresses has a Tor route of its own, sends leave on yet another, and Zcash, Pirate Chain, Zano, Litecoin MWEB and Firo Spark read the blockchain on this device instead of asking a server.'),
        h('p', { class: 'small' }, 'So after opening the wallet, the first sync takes at least a few minutes (usually 2 to 5). The first sync of Zcash and Pirate Chain on a new device can take 30 minutes or more. After that, your last balances show at once and updates come faster.')),
      h('div', { class: 'section', id: 'language-section' }, h('h3', {}, 'Language'),
        h('select', { id: 'set-language', 'aria-label': 'Language', 'data-no-translate': '', onchange: (e: Event) => (window as any).kusariI18n.set((e.target as HTMLSelectElement).value) },
          ...(window as any).kusariI18n.languages.map(([code, name]: [string, string]) => h('option', { value: code, selected: code === (window as any).kusariI18n.current() }, name)))),
      h('div', { class: 'section' }, h('h3', {}, 'Connections'), netBox.el,
        h('label', { class: 'field' }, h('span', {}, 'Your own Bitcoin server'), btcServer, h('div', { class: 'hint' }, 'The Esplora or mempool API of your own node (for example on Umbrel or Start9), as https://, .onion, or an address on your network. Then only your server learns your Bitcoin addresses. Empty uses public servers.')),
        ownSection,
        h('label', { class: 'field' }, h('span', {}, 'Your own Zano node'), zanoNode, h('div', { class: 'hint' }, 'host:port of a Zano node you run. Empty uses the public node.')),
        // KSR launches later: a build without its engine shows nothing of it.
        ksrInfo.available && h('label', { class: 'field' }, h('span', {}, 'Kusari node'), ksrNode, h('div', { class: 'hint' }, 'host:port of a Kusari (KSR) node. There is no public node before the chain launches: KSR shows its address already, and its balance once a node is set. It is reached through Tor like every other server.')),
        h('label', { class: 'field' }, h('span', {}, 'Bitcoin CoinJoin coordinator'), coordinator, h('div', { class: 'hint' }, 'The server that runs the CoinJoin rounds. It sees which coins are in a round, but not which outputs belong to whom. These charge no fee.')),
        coordinatorRow,
        h('label', { class: 'field' }, h('span', {}, 'How much to mix Bitcoin'), mixTarget, h('div', { class: 'hint' }, 'Mixed coins go round again until each one shares its amount with that many others. Each round costs a little mining fee.')),
        h('label', { class: 'field' }, h('span', {}, 'Custom Monero node'), node, h('div', { class: 'hint' }, 'Enter your own node if you have one. Empty chooses a public node automatically. Public nodes can see your IP.')),
        h('label', { class: 'field' }, h('span', {}, 'TronGrid API key'), key, h('div', { class: 'hint' }, 'Works without one. Add a free key if lookups are often limited.')),
        h('label', { class: 'field' }, h('span', {}, 'Auto-lock (minutes)'), auto),
        h('label', { class: 'check' }, showPrices, h('span', {}, 'Show USD prices', h('div', { class: 'hint' }, 'Prices come from CoinGecko, then from other price services and exchanges if it\'s blocked or a coin is missing. Addresses and balances aren\'t sent, but your IP can be seen.'))),
        h('label', { class: 'check' }, btcFilters, h('span', {}, 'Private Bitcoin sync',
          h('div', { class: 'hint' }, 'Instead of asking servers about your addresses, the wallet downloads compact block filters from Bitcoin nodes over Tor and checks them on this device, so no server or node learns which addresses are yours. Two nodes must agree on every filter. It needs Tor, uses more data, and incoming payments show after their first confirmation. New wallets use it from the start. Switching reopens the wallet.'))),
        btcFromRow,
        h('label', { class: 'check' }, evmSeparate, h('span', {}, 'A separate address for each EVM chain', h('div', { class: 'hint' }, 'BNB Chain, Polygon and Arbitrum each get an address of their own instead of sharing your Ethereum address, so one address doesn\'t link your activity on all four. Switching changes those receiving addresses and reopens the wallet. Coins on the other addresses show again when you switch back, so move them first.'))),
        tor.allowed === false ? copyLog : h('div', { class: 'tor-block', id: 'tor-block' },
          h('h3', {}, 'Tor'), torBox.el, torProgress, torRouteNote,
          h('label', { class: 'check' }, useTor, h('span', {}, 'Connect through Tor',
            h('div', { class: 'hint' }, 'Sends node, TronGrid and price connections through Tor to hide your IP. It doesn\'t hide public Tron history, and lookups and sync get slower.'),
            h('div', { class: 'hint' }, tor.updatable === false ? 'If Tor drops, connections stop rather than falling back to the plain internet.' : 'If Tor drops, connections stop rather than falling back to the plain internet. Only the first install uses the plain internet, to download the files.'))),
          h('label', { class: 'field', id: 'set-tor-bridge-row' }, h('span', {}, 'How Tor connects'), bridge,
            h('div', { class: 'hint', id: 'tor-bridge-note' }, 'Automatic connects to Tor directly and switches to Snowflake, then obfs4, only if Tor is blocked where you are. Snowflake makes Tor look like a video call, so it gets through censorship, but connections are slower while it\'s in use. Your IP stays hidden from the servers either way.')),
          bridgeLinesRow,
          updateTor, copyLog),
        h('div', { class: 'row' }, saveBtn, saved),
        h('p', { class: 'hint' }, tor.allowed === false ? 'Changing the node or API key locks the wallet. It applies when reopened.' : 'Changing the node, API key or Tor locks the wallet. It applies when reopened.')),
      bioSection,
      plainSection,
      h('div', { class: 'section', id: 'arrr-info' }, h('h3', {}, 'Pirate Chain engine'),
        h('p', { class: 'small', id: 'arrr-info-state' }, arrrInfo.available ? (arrrInfo.started ? `Running: ${arrrInfo.phase}` : 'Found but not running') : 'Not found'),
        arrrInfo.error && h('p', { class: 'small' }, arrrInfo.error)),
      h('div', { class: 'section', id: 'zano-info' }, h('h3', {}, 'Zano engine'),
        h('p', { class: 'small', id: 'zano-info-state' }, zanoInfo.available ? (zanoInfo.started ? `Running: ${zanoInfo.phase}` : 'Found but not running') : 'Not found'),
        zanoInfo.error && h('p', { class: 'small' }, zanoInfo.error)),
      ksrInfo.available && h('div', { class: 'section', id: 'ksr-info' }, h('h3', {}, 'Kusari engine'),
        h('p', { class: 'small', id: 'ksr-info-state' }, !ksrInfo.available ? 'Not found' : !ksrInfo.hasNode ? 'Found, waiting for a Kusari node' : ksrInfo.started ? `Running: ${ksrInfo.phase}` : 'Found but not running'),
        ksrInfo.error && h('p', { class: 'small' }, ksrInfo.error)),
      h('div', { class: 'section', id: 'zec-info' }, h('h3', {}, 'Zcash engine'),
        h('p', { class: 'small', id: 'zec-info-state' }, zecInfo.available ? (zecInfo.started ? `Running: ${zecInfo.phase}` : 'Found but not running') : 'Not found'),
        zecInfo.error && h('p', { class: 'small' }, zecInfo.error),
        h('p', { class: 'small', id: 'zec-info-list' }, `List: ${ASSETS.includes('ZEC') ? 'includes ZEC' : 'no ZEC'} / balance check: ${refreshNote}`),
        h('p', { class: 'muted small mono' }, zecInfo.detail)),
      h('div', { class: 'section' }, h('h3', {}, 'Seed backup'), seedBox.el,
        h('label', { class: 'field' }, h('span', {}, 'Password'), seedPw), rev, seedOut),
      h('div', { class: 'section' }, h('h3', {}, 'Change password'), pwBox.el,
        h('label', { class: 'field' }, h('span', {}, 'Current password'), curPw),
        h('label', { class: 'field' }, h('span', {}, 'New password (at least 10 characters)'), newPw),
        h('div', { class: 'row' }, chg, chgDone)),
      h('div', { class: 'section', id: 'duress-section' }, h('h3', {}, 'Duress password'), duressBox.el,
        h('p', { class: 'small muted' }, 'If someone forces you to open the wallet, unlock it with this password instead: a separate decoy wallet with its own seed opens in its place, under the same name. Your real wallet and its coins stay hidden behind your usual password. Put a small amount in the decoy so it looks used. Fingerprint unlock opens the wallet it was turned on in. Someone who examines this device\'s files closely could tell that a second wallet exists.'),
        duressState,
        h('label', { class: 'field' }, h('span', {}, 'Your wallet password'), duressCur),
        h('label', { class: 'field' }, h('span', {}, 'Duress password (at least 10 characters)'), duressNew),
        h('label', { class: 'field' }, h('span', {}, 'Duress password again'), duressAgain),
        h('div', { class: 'row' }, duressSet, duressOff)),
      h('div', { class: 'section', id: 'support-section' }, h('h3', {}, 'Support'),
        h('button', { class: 'ghost', id: 'support', 'aria-expanded': 'false', onclick: (e: Event) => {
          const note = document.getElementById('support-note');
          if (!note) return;
          note.hidden = !note.hidden;
          (e.currentTarget as HTMLElement).setAttribute('aria-expanded', String(!note.hidden));
        } }, 'Support'),
        h('p', { class: 'small', id: 'support-note', hidden: true }, 'Need help? Email kusari_wallet@proton.me, or message @Kusari_Wallet on Telegram.')),
      h('div', { class: 'section' }, h('h3', {}, 'Delete wallet'), delBox.el,
        h('p', { class: 'muted small' }, 'Coins stay on the blockchain, but can never be reached without the seeds. Check your seeds before deleting.'), h('br'),
        h('label', { class: 'field' }, h('span', {}, 'Password'), delPw), del)),
    bottomNav('settings'));
}

// ---- boot ----

let deleting = false;
let onTorInstallMessage: ((m: string) => void) | null = null;
let onTorState: ((s: any) => void) | null = null;
wallet.on('tor-install', (m: string) => onTorInstallMessage?.(m));
wallet.on('tor-state', (s: any) => {
  if (torState) torState = s;
  onTorState?.(s);
  onData?.();
});

wallet.on('monero-state', (m: any) => {
  if (overview) { overview.monero = m; onData?.(); }
});
wallet.on('balance-changed', () => void refresh());
wallet.on('locked', () => {
  closeScanner?.();
  document.querySelectorAll('.modal').forEach((m) => m.remove());
  window.clearInterval(pollTimer);
  pollTimer = undefined;
  overview = null;
  addresses = null;
  torState = null;
  prices = null;
  if (!deleting) void boot();
});
for (const type of ['mousedown', 'keydown']) {
  let last = 0;
  window.addEventListener(type, () => {
    const now = Date.now();
    if (now - last > 30_000) { last = now; void wallet.activity(); }
  }, { passive: true });
}

async function boot(first = false): Promise<void> {
  const [s] = await Promise.all([wallet.status(), first ? new Promise((r) => setTimeout(r, 900)) : null]);
  if (!s.hasWallet) welcome();
  else if (s.unlocked) await enterWallet();
  else unlockScreen();
}
// The developer build says so on every screen, so it is never mistaken for the regular wallet.
void Promise.resolve(wallet.getSettings()).then((s: any) => {
  if (!s?.developer) return;
  (window as any).kusariI18n.only(['en', 'ko']);
  document.body.classList.add('developer-build');
  document.body.prepend(h('div', { class: 'developer-ribbon', id: 'developer-ribbon', role: 'note' }, 'Developer build: for trying coins and features before release. Keep only test amounts here.'));
}).catch(() => undefined);
void boot(true);
