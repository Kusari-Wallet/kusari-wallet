// How Tor gets into its network where it's blocked: Snowflake (looks like a video call) or obfs4 (looks like
// noise), both run by lyrebird, the program that ships in the Tor Project's own bundle. The default bridges come
// from the bundle's pt_config.json, so they're signed with Tor and current with each Tor update.

/** none = straight to Tor; auto = straight first, then Snowflake, then obfs4 when Tor can't get through. */
export type TorBridge = 'auto' | 'none' | 'snowflake' | 'obfs4' | 'custom';
export const TOR_BRIDGES: TorBridge[] = ['auto', 'none', 'snowflake', 'obfs4', 'custom'];
/** What actually runs: auto is never one of these. */
export type TorRoute = Exclude<TorBridge, 'auto'>;

export interface DefaultBridges { snowflake: string[]; obfs4: string[] }

const TRANSPORTS = ['obfs4', 'webtunnel', 'snowflake', 'meek_lite'] as const;
/** At most this many custom bridges, and each line this long. */
const MAX_CUSTOM = 20;
const MAX_LINE = 1500;

/** The bridge lines in a pt_config.json, only the transports used here, each checked. */
export function readPtConfig(text: string): DefaultBridges {
  const j = JSON.parse(text);
  const pick = (k: 'snowflake' | 'obfs4') => (Array.isArray(j?.bridges?.[k]) ? j.bridges[k] : []).filter((l: unknown): l is string => typeof l === 'string' && cleanLine(l)?.startsWith(`${k} `) === true).map((l: string) => cleanLine(l)!);
  return { snowflake: pick('snowflake'), obfs4: pick('obfs4') };
}

/** One bridge line as Tor takes it, or null. "Bridge " in front, as people often paste it, is fine. */
function cleanLine(raw: string): string | null {
  const l = raw.trim().replace(/^Bridge\s+/i, '').replace(/\s+/g, ' ');
  if (!l || l.length > MAX_LINE || /[^\x20-\x7e]/.test(l)) return null;
  const [kind, addr] = l.split(' ');
  if (!(TRANSPORTS as readonly string[]).includes(kind) || !addr) return null;
  // An address and port (IPv4 or [IPv6]); webtunnel and snowflake use placeholder addresses, which still look like this.
  if (!/^(\d{1,3}(\.\d{1,3}){3}|\[[0-9a-fA-F:]+\]):\d{1,5}$/.test(addr)) return null;
  return l;
}

/** Custom bridges typed or pasted in, one per line. Throws with what's wrong, so the screen can say so. */
export function parseCustomBridges(text: string): string[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) throw new Error('Enter at least one bridge line.');
  if (lines.length > MAX_CUSTOM) throw new Error(`Enter at most ${MAX_CUSTOM} bridge lines.`);
  return lines.map((l, i) => {
    const ok = cleanLine(l);
    if (!ok) throw new Error(`Bridge line ${i + 1} isn't one this wallet can use. It should look like "obfs4 1.2.3.4:443 FINGERPRINT cert=… iat-mode=0".`);
    return ok;
  });
}

/**
 * Tor's options for a route. `plugin` is lyrebird's path, relative to Tor's working folder when possible: Tor
 * splits this option on spaces, and a user's folder name may have one.
 */
export function bridgeArgs(route: TorRoute, defaults: DefaultBridges, custom: string[], plugin: string): string[] {
  if (route === 'none') return [];
  const lines = route === 'custom' ? custom : defaults[route];
  if (!lines.length) throw new Error(route === 'custom' ? 'Enter at least one bridge line.' : `This Tor has no ${route} bridges.`);
  const kinds = [...new Set(lines.map((l) => l.split(' ')[0]))];
  if (/\s/.test(plugin)) throw new Error('The Tor folder has a space in its path, so bridges can\'t be started.');
  return ['--UseBridges', '1', '--ClientTransportPlugin', `${kinds.join(',')} exec ${plugin}`, ...lines.flatMap((l) => ['--Bridge', l])];
}

/** In auto, how long a route may take to finish starting before the next one is tried. */
export const AUTO_WAIT_MS: Record<TorRoute, number> = { none: 60_000, snowflake: 150_000, obfs4: 120_000, custom: 150_000 };
const AUTO_ORDER: TorRoute[] = ['none', 'snowflake', 'obfs4'];

/** The route auto starts with: the one that last worked. */
export const autoFirst = (lastWorked: TorRoute | null): TorRoute => (lastWorked && AUTO_ORDER.includes(lastWorked) ? lastWorked : 'none');
/** The route auto tries after this one failed to connect in time. */
export const autoNext = (current: TorRoute): TorRoute => AUTO_ORDER[(AUTO_ORDER.indexOf(current) + 1) % AUTO_ORDER.length];
