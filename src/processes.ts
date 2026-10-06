import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
// Before servers were recorded with their name (until 0.4.1).
const SERVER_NAME = 'agy_acp_server';

interface Tracked {
  file: string;
  server: number;
  owner: number;
  name: string;
  version?: string;
}

/** Records the server a window started as "<server pid>-<window pid>", with its executable and version. */
export function trackServer(dir: string, pid: number, command: string, version: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${pid}-${process.pid}`), JSON.stringify({ name: basename(command, '.exe'), version }));
}

/** Stops servers whose window is gone; the name check keeps a reused pid from being hit. */
export async function reapOrphans(dir: string): Promise<void> {
  for (const tracked of trackedServers(dir)) {
    if (alive(tracked.owner)) continue;
    if (alive(tracked.server) && (await named(tracked.server, tracked.name))) killTree(tracked.server);
    rmSync(tracked.file, { force: true });
  }
}

/** The server versions open windows are running. */
export function versionsInUse(dir: string): string[] {
  return trackedServers(dir).flatMap((tracked) => (tracked.version && alive(tracked.owner) && alive(tracked.server) ? [tracked.version] : []));
}

/**
 * Stops a closed session's harness (~130 MB), which the server itself never does, unless the pid has
 * moved on. Never the server itself, should it ever be the one on the other end.
 */
export async function stopHarness(pid: number | undefined, server: number | undefined): Promise<void> {
  if (!pid || pid === server || !(await named(pid, 'harness'))) return;
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
  return listing.then(({ stdout }) => stdout.toLowerCase().includes(name.toLowerCase()), () => false);
}

function trackedServers(dir: string): Tracked[] {
  return (existsSync(dir) ? readdirSync(dir) : []).map((file) => {
    const [server, owner] = file.split('-').map(Number);
    const recorded = readRecord(join(dir, file));
    return { file: join(dir, file), server, owner, name: recorded.name || SERVER_NAME, version: recorded.version };
  });
}

function readRecord(file: string): { name?: string; version?: string } {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as { name?: string; version?: string };
  } catch {
    return {};
  }
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
