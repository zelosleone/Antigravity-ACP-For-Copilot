import { execFile } from 'node:child_process';
import { chmodSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, open, rename, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream } from 'node:stream/web';
import { promisify } from 'node:util';
import { inflate } from 'node:zlib';

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
const inflateAsync = promisify(inflate);
// The server is a PyInstaller one-file build: on every launch it unpacks ~8,000 files into a fresh temp
// folder, which takes half a minute with antivirus scanning. Unpacked once, the unchanged executable
// runs from them in PyInstaller's own already-unpacked mode, which wants a name of the form _MEI +
// 8 hex digits + suffix (18 characters on POSIX).
const UNPACKED = '_MEI00000000agyacp';
const COOKIE = Buffer.from([0x4d, 0x45, 0x49, 0x0c, 0x0b, 0x0a, 0x0b, 0x0e]);
const COOKIE_SIZE = 88;
const UNPACKED_TYPES = 'bxZ';

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

/** The folder holding the server's unpacked files, unpacking them first if needed; undefined if it isn't a PyInstaller build. */
export async function unpack(server: Server): Promise<string | undefined> {
  const dir = join(dirname(server.command), UNPACKED);
  if (existsSync(dir)) return dir;
  // Another window may be unpacking at the same time; whichever finishes first wins.
  const partial = `${dir}.${process.pid}`;
  await rm(partial, { recursive: true, force: true });
  const file = await open(server.command, 'r');
  try {
    if (!(await unpackArchive(file, partial))) return undefined;
  } finally {
    await file.close();
  }
  await rename(partial, dir).catch(() => rm(partial, { recursive: true, force: true }));
  return dir;
}

// The PyInstaller archive sits at the end of the executable, located by its cookie; its table of
// contents lists every bundled file, and the ones the bootloader would unpack are written out.
async function unpackArchive(file: FileHandle, out: string): Promise<boolean> {
  const size = (await file.stat()).size;
  const tail = await readAt(file, Math.max(0, size - 4 * 1024 * 1024), Math.min(size, 4 * 1024 * 1024));
  const at = tail.lastIndexOf(COOKIE);
  if (at < 0) return false;
  const cookie = tail.subarray(at, at + COOKIE_SIZE);
  const start = size - tail.length + at + COOKIE_SIZE - cookie.readUInt32BE(8);
  const toc = await readAt(file, start + cookie.readUInt32BE(12), cookie.readUInt32BE(16));
  const entries: Buffer[] = [];
  for (let pos = 0; pos < toc.length; pos += toc.readUInt32BE(pos)) {
    if (UNPACKED_TYPES.includes(String.fromCharCode(toc[pos + 17]))) entries.push(toc.subarray(pos, pos + toc.readUInt32BE(pos)));
  }
  // Thousands of small files: written in batches, so the disk stays busy without opening them all at once.
  for (let i = 0; i < entries.length; i += 64) await Promise.all(entries.slice(i, i + 64).map((entry) => unpackEntry(file, start, entry, out)));
  return true;
}

// One table entry: data offset, stored and full length, a compression flag, a type code and the name.
async function unpackEntry(file: FileHandle, start: number, entry: Buffer, out: string): Promise<void> {
  const target = join(out, ...entry.subarray(18).toString('utf8').replace(/\0+$/, '').split(/[\\/]/));
  const data = await readAt(file, start + entry.readUInt32BE(4), entry.readUInt32BE(8));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, entry[16] === 1 ? await inflateAsync(data) : data);
}

async function readAt(file: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  await file.read(buffer, 0, length, position);
  return buffer;
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
