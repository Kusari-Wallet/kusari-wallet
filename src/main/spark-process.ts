// Starts the Firo Spark engine (native/spark-bridge) and talks to it one JSON line at a time.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { readAnswer } from './spark-wire';

export interface SparkEngine {
  /** Where its caches go, below the folder it's given. */
  dir: (base: string) => string;
  call(method: string, params?: unknown): Promise<any>;
  close(): void;
}

const EXE = process.platform === 'win32' ? 'spark-bridge.exe' : 'spark-bridge';

function findEngine(override?: string): string | null {
  const candidates = [override, (process as any).resourcesPath && path.join((process as any).resourcesPath, 'spark', EXE)];
  return candidates.find((c): c is string => Boolean(c) && existsSync(c as string)) ?? null;
}

export const sparkEngineAvailable = (override?: string): boolean => findEngine(override) !== null;

export { readAnswer };

export function startSparkEngine(override?: string): SparkEngine {
  const file = findEngine(override);
  if (!file) throw new Error('This build has no Spark engine.');
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
  child.on('exit', () => die(new Error('Spark engine stopped.')));
  child.stdin.on('error', () => undefined);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      const answer = readAnswer(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      const w = answer && waiting.get(answer.id);
      if (!answer || !w) continue;
      waiting.delete(answer.id);
      if (answer.ok) w.resolve(answer.value); else w.reject(new Error(answer.value));
    }
  });
  return {
    dir: (base) => path.join(base, 'spark'),
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
