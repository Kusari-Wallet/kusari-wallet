// Starts the native Zano engine and talks to it one line at a time.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export interface ZanoEngine {
  /** Answers are text, because amounts can pass what a JSON number holds exactly. */
  call(method: string, instance: number | string, params: string): Promise<string>;
  /** Where the engine keeps its wallet files. */
  dir: string;
  close(): void;
}

const EXE = process.platform === 'win32' ? 'zano-bridge.exe' : 'zano-bridge';

function findEngine(override?: string): string | null {
  const candidates = [override, (process as any).resourcesPath && path.join((process as any).resourcesPath, 'zano', EXE)];
  return candidates.find((c): c is string => Boolean(c) && existsSync(c as string)) ?? null;
}

export const zanoEngineAvailable = (override?: string): boolean => findEngine(override) !== null;
export const zanoEngineInfo = (override?: string): string => findEngine(override) ?? 'Engine file not found';

export function startZanoEngine(override: string | undefined, dir: string): ZanoEngine {
  const file = findEngine(override);
  if (!file) throw new Error('This build has no Zano engine.');
  const home = path.join(dir, 'zano');
  mkdirSync(home, { recursive: true });
  const child = spawn(file, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, cwd: home });
  const waiting = new Map<number, { resolve: (v: string) => void; reject: (e: Error) => void }>();
  let next = 1;
  let buffer = '';
  let dead: Error | null = null;
  const die = (e: Error) => {
    dead = e;
    for (const w of waiting.values()) w.reject(e);
    waiting.clear();
  };
  child.on('error', (e) => die(e));
  child.on('exit', () => die(new Error('Zano engine stopped.')));
  child.stdin.on('error', () => undefined);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      const tab = line.indexOf('\t');
      const w = waiting.get(Number(line.slice(0, tab)));
      if (tab < 0 || !w) continue;
      waiting.delete(Number(line.slice(0, tab)));
      w.resolve(line.slice(tab + 1));
    }
  });
  return {
    dir: home,
    call(method, instance, params) {
      if (dead) return Promise.reject(dead);
      const id = next++;
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        child.stdin.write(`${id}\t${method}\t${instance}\t${params}\n`);
      });
    },
    close() { child.stdin.end(); setTimeout(() => child.kill(), 4000).unref?.(); },
  };
}
