// The networks private block-filter sync (BIP157/158) runs on: Bitcoin and Litecoin share the protocol, and differ
// in magic bytes, port, seeds, proof-of-work hash and difficulty rule.
import { dsha, nextTarget, nextTargetLtc, LTC_POW_LIMIT, POW_LIMIT } from './btc-block';
import { BTC_ONION_SEEDS } from './btc-seeds';
import { LTC_SEEDS } from './ltc-seeds';

const { scrypt } = require('@noble/hashes/scrypt.js');

export interface P2pNet {
  /** For messages: "Bitcoin", "Litecoin". */
  name: string;
  /** Prefix of the sync's files in the wallet folder. */
  id: 'btc' | 'ltc';
  magic: Buffer;
  port: number;
  seeds: string[];
  /**
   * Over Tor, Bitcoin uses onion nodes only. Litecoin has few, so it also uses IPv4 nodes, reached through Tor exits:
   * they learn no more than an onion node would (not the device's address), and filters are still checked by two.
   */
  ipv4: boolean;
  /** The hash a header's work is judged by (little-endian, as compared with the target). */
  powHash: (header: Uint8Array) => Uint8Array;
  powLimit: bigint;
  /** The next period's `bits` from the last block of this one and the first block counted. */
  nextBits: (lastBits: number, firstTime: number, lastTime: number) => number;
  /** How far before a retarget height the block whose time starts the period is (Bitcoin 2016, Litecoin 2017). */
  firstBack: number;
}

export const BTC_P2P: P2pNet = {
  name: 'Bitcoin', id: 'btc', magic: Buffer.from('f9beb4d9', 'hex'), port: 8333, seeds: BTC_ONION_SEEDS, ipv4: false,
  powHash: (h) => dsha(h), powLimit: POW_LIMIT, nextBits: nextTarget, firstBack: 2016,
};

/** Native scrypt where there is one (desktop): about twice as fast as the JavaScript one, for the same bytes. */
let nodeScrypt: ((h: Uint8Array) => Uint8Array) | null | undefined;
function scryptPow(h: Uint8Array): Uint8Array {
  if (nodeScrypt === undefined) {
    try {
      const c = require('node:crypto');
      nodeScrypt = typeof c?.scryptSync === 'function' ? (x: Uint8Array) => new Uint8Array(c.scryptSync(x, x, 32, { N: 1024, r: 1, p: 1 })) : null;
    } catch { nodeScrypt = null; }
  }
  return nodeScrypt ? nodeScrypt(h) : scrypt(h, h, { N: 1024, r: 1, p: 1, dkLen: 32 });
}

export const LTC_P2P: P2pNet = {
  name: 'Litecoin', id: 'ltc', magic: Buffer.from('fbc0b6db', 'hex'), port: 9333, seeds: LTC_SEEDS, ipv4: true,
  powHash: scryptPow, powLimit: LTC_POW_LIMIT, nextBits: nextTargetLtc, firstBack: 2017,
};
