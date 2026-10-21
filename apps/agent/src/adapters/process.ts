import { spawn, type ChildProcess } from 'node:child_process';
import { resolve, sep } from 'node:path';

/**
 * Runs reviewed farming software as an isolated child process:
 *  - no shell (argv array only → no command injection),
 *  - executable must live inside an explicitly authorised directory,
 *  - environment scrubbed to an allowlist (no inherited secrets, SSH agent, tokens…),
 *  - cwd = the task's private directory,
 *  - killed on abort.
 *
 * Not used by any adapter yet (software pending review).
 */
export interface IsolatedSpawnOpts {
  authorizedDir: string;
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  signal: AbortSignal;
  onLine: (stream: 'stdout' | 'stderr', line: string) => void;
}

const ENV_ALLOW = ['PATH', 'SYSTEMROOT', 'TEMP', 'TMP', 'LANG', 'TZ'];

export function spawnIsolated(o: IsolatedSpawnOpts): ChildProcess {
  const dir = resolve(o.authorizedDir);
  const exe = resolve(dir, o.executable);
  if (!exe.startsWith(dir + sep)) throw new Error('Executable outside authorised directory');
  if (o.args.some((a) => a.length > 500 || a.includes('\0'))) throw new Error('Invalid argument');
  const env: Record<string, string> = {};
  for (const k of ENV_ALLOW) if (process.env[k]) env[k] = process.env[k]!;
  for (const [k, v] of Object.entries(o.env)) if (/^[A-Z][A-Z0-9_]{0,40}$/.test(k)) env[k] = v;

  const child = spawn(exe, o.args, {
    cwd: o.cwd,
    env,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    signal: o.signal,
  });
  for (const s of ['stdout', 'stderr'] as const) {
    let buf = '';
    child[s]!.setEncoding('utf8');
    child[s]!.on('data', (d: string) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        o.onLine(s, buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
      if (buf.length > 10_000) buf = buf.slice(-10_000);
    });
  }
  return child;
}
