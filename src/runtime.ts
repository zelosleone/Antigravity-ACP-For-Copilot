import { execFile } from 'node:child_process';
import { chmodSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream } from 'node:stream/web';
import { promisify } from 'node:util';

// Google publishes its ACP server through the ACP registry, the same source Zed and JetBrains install from.
const REGISTRY = 'https://raw.githubusercontent.com/agentclientprotocol/registry/main/antigravity-acp/agent.json';
const DOWNLOADS = 'https://dl.google.com/';
const PLATFORMS: Record<string, string> = {
  'win32-x64': 'windows-x86_64',
  'win32-arm64': 'windows-aarch64',
  'darwin-arm64': 'darwin-aarch64',
  'darwin-x64': 'darwin-x86_64',
  'linux-x64': 'linux-x86_64',
  'linux-arm64': 'linux-aarch64',
};
const MARKER = 'server.json';
const run = promisify(execFile);

export interface Server {
  version: string;
  command: string;
  args: string[];
}

interface Target {
  archive: string;
  cmd: string;
  args?: string[];
}

interface Entry {
  version: string;
  distribution: { binary: Record<string, Target | undefined> };
}

/** The newest server already unpacked under root. */
export function installedServer(root: string): Server | undefined {
  const versions = existsSync(root) ? readdirSync(root).filter((name) => existsSync(join(root, name, MARKER))) : [];
  const newest = versions.sort(compareVersions).at(-1);
  return newest ? (JSON.parse(readFileSync(join(root, newest, MARKER), 'utf8')) as Server) : undefined;
}

/** Downloads the registry's current server for this platform, unless it is already here, and drops older ones. */
export async function installServer(root: string, onProgress?: (fraction: number) => void): Promise<Server> {
  const entry = (await (await fetch(REGISTRY)).json()) as Entry;
  const target = entry.distribution.binary[PLATFORMS[`${process.platform}-${process.arch}`] ?? ''];
  if (!target) throw new Error(`Google publishes no Antigravity ACP server for ${process.platform}-${process.arch}.`);
  if (!target.archive.startsWith(DOWNLOADS)) throw new Error(`Refusing to download from ${target.archive}.`);
  const dir = join(root, entry.version);
  const marker = join(dir, MARKER);
  if (existsSync(marker)) return JSON.parse(readFileSync(marker, 'utf8')) as Server;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const zip = join(dir, 'server.zip');
  await download(target.archive, zip, onProgress);
  await unzip(zip, dir);
  rmSync(zip);
  const server: Server = { version: entry.version, command: join(dir, target.cmd), args: target.args ?? [] };
  writeFileSync(marker, JSON.stringify(server));
  prune(root, entry.version);
  return server;
}

async function download(url: string, file: string, onProgress?: (fraction: number) => void): Promise<void> {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`Downloading ${url} failed with HTTP ${response.status}.`);
  const total = Number(response.headers.get('content-length')) || 0;
  let received = 0;
  const body = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
  body.on('data', (chunk: Buffer) => {
    received += chunk.length;
    if (total > 0) onProgress?.(received / total);
  });
  await pipeline(body, createWriteStream(file));
}

// Windows and macOS ship bsdtar, which reads zip archives; Linux has unzip.
async function unzip(zip: string, dir: string): Promise<void> {
  if (process.platform === 'linux') await run('unzip', ['-o', '-q', zip, '-d', dir]);
  else await run('tar', ['-xf', zip, '-C', dir]);
  if (process.platform === 'win32') return;
  for (const name of readdirSync(dir)) chmodSync(join(dir, name), 0o755);
}

// A server still running from an older version can't be deleted on Windows; that one goes next time.
function prune(root: string, keep: string): void {
  for (const name of readdirSync(root)) {
    if (name === keep) continue;
    try {
      rmSync(join(root, name), { recursive: true, force: true });
    } catch {
      // in use
    }
  }
}

function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
