import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Stops servers whose window is gone (each window records "<server pid>-<window pid>"); the name check keeps a reused pid from being hit. */
export async function reapOrphans(dir: string): Promise<void> {
  for (const name of existsSync(dir) ? readdirSync(dir) : []) {
    const [server, owner] = name.split('-').map(Number);
    if (alive(owner)) continue;
    if (alive(server) && (await named(server, 'agy_acp_server'))) killTree(server);
    rmSync(join(dir, name), { force: true });
  }
}

/** Stops a closed session's harness (~130 MB), which the server itself never does, unless the pid has moved on. */
export async function stopHarness(pid: number | undefined): Promise<void> {
  if (!pid || !(await named(pid, 'localharness'))) return;
  try {
    process.kill(pid);
  } catch {
    // already gone
  }
}

/** The process on the other end of a loopback connection to this one, by its port. */
export async function peerProcess(port: number | undefined): Promise<number | undefined> {
  if (!port) return undefined;
  const pids = await (process.platform === 'win32' ? netstat(port) : lsof(port)).catch(() => []);
  return pids.find((pid) => pid > 0 && pid !== process.pid);
}

/** Stops a process and its children. Synchronous, so it is done before the extension host exits. */
export function killTree(pid: number): void {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else process.kill(pid);
  } catch {
    // already gone
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function named(pid: number, name: string): Promise<boolean> {
  const listing = process.platform === 'win32' ? run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true }) : run('ps', ['-p', String(pid), '-o', 'comm=']);
  return listing.then(({ stdout }) => stdout.includes(name), () => false);
}

// "TCP  127.0.0.1:57883  127.0.0.1:61234  ESTABLISHED  45180": the local address second, the pid last.
async function netstat(port: number): Promise<number[]> {
  const { stdout } = await run('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true });
  const rows = stdout.split('\n').map((line) => line.trim().split(/\s+/));
  return rows.filter((columns) => columns[1]?.endsWith(`:${port}`)).map((columns) => Number(columns.at(-1)));
}

async function lsof(port: number): Promise<number[]> {
  const { stdout } = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:ESTABLISHED', '-Fp']);
  return stdout.split('\n').filter((line) => line.startsWith('p')).map((line) => Number(line.slice(1)));
}
