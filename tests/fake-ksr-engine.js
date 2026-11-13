#!/usr/bin/env node
// Kusari's engine is Zano's bridge built for the KSR chain, so its stand-in is Zano's with a K... address and logs
// of its own.
process.env.FAKE_ZANO_ADDRESS = 'K' + 'C'.repeat(96);
process.env.FAKE_ZANO_LOG = process.env.FAKE_KSR_LOG || '';
process.env.FAKE_ZANO_FILES = process.env.FAKE_KSR_FILES || '';
require('./fake-zano-engine.js');
