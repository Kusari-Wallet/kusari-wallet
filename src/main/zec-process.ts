// Starts the native Zcash engine and talks to it one JSON line at a time.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export interface ZecEngine {
  call(method: string, params?: unknown): Promise<any>;
  close(): void;
}

const EXE = process.platform === 'win32' ? 'zec-bridge.exe' : 'zec-bridge';

function findEngine(override?: string): string | null {
  const candidates = [override, (process as any).resourcesPath && path.join((process as any).resourcesPath, 'zec', EXE)];
  return candidates.find((c): c is string => Boolean(c) && existsSync(c as string)) ?? null;
}

export const zecEngineAvailable = (override?: string): boolean => findEngine(override) !== null;

export function startZecEngine(override?: string): ZecEngine {
  const file = findEngine(override);
  if (!file) throw new Error('이 빌드에는 Zcash 엔진이 없어.');
  const child = spawn(file, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  const waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  let next = 1;
  let buffer = '';
  let dead: Error | null = null;
  const die = (e: Error) => {
    dead = e;
    for (const w of waiting.values()) w.reject(e);
    waiting.clear();
  };
  child.on('error', (e) => die(e));
  child.on('exit', () => die(new Error('Zcash 엔진이 종료됐어.')));
  child.stdin.on('error', () => undefined);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      let answer: any;
      try { answer = JSON.parse(line); } catch { continue; }
      const w = waiting.get(answer.id);
      if (!w) continue;
      waiting.delete(answer.id);
      if ('error' in answer) w.reject(new Error(String(answer.error))); else w.resolve(answer.result);
    }
  });
  return {
    call(method, params = {}) {
      if (dead) return Promise.reject(dead);
      const id = next++;
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        child.stdin.write(JSON.stringify({ id, m: method, p: params }) + '\n');
      });
    },
    close() { child.stdin.end(); setTimeout(() => child.kill(), 3000).unref?.(); },
  };
}
