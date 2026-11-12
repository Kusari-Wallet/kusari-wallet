// Android has no Kusari engine yet (kusari-wallet-rpc isn't built for it), so KSR isn't listed there.
import type { KusariEngine, KusariEngineOptions } from '../main/kusari-process';

export type { KusariEngine, KusariEngineOptions };

export const kusariEngineAvailable = (_?: string): boolean => false;
export const kusariEngineInfo = (_?: string): string => 'Not built for Android';

export async function startKusariEngine(_: string | undefined, __: string, ___: KusariEngineOptions): Promise<KusariEngine> {
  throw new Error('Kusari is not available on this device.');
}
