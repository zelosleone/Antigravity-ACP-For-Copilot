// The daily check of Google's newest Antigravity ACP server (.github/workflows/upstream.yml): this
// extension's own download, unpacking and start code, signed out. It fails when a new release changes
// something the extension relies on, so the change is caught before users meet it.
import type * as acp from '@agentclientprotocol/sdk';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killTree } from './processes.js';
import { Connection, RpcError } from './rpc.js';
import { fastStartEnv, installServer, unpack, type Server } from './runtime.js';

const AUTH_REQUIRED = -32000;
const GOOGLE_SIGN_IN = 'oauth-personal';
let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
}

// One start, fast (from the unpacked files) or the usual way, as the extension does it.
async function start(server: Server, unpacked: string | undefined): Promise<void> {
  const label = unpacked ? 'fast start' : 'usual start';
  const home = mkdtempSync(join(tmpdir(), 'agy-home-'));
  const env: NodeJS.ProcessEnv = { ...process.env, GEMINI_HOME: home, ...(unpacked ? fastStartEnv(server, unpacked) : {}) };
  delete env.PYTHONHOME;
  delete env.PYTHONPATH;
  const started = Date.now();
  const child = spawn(server.command, server.args, { cwd: home, env, stdio: 'pipe', windowsHide: true });
  const connection = new Connection(child, () => undefined);
  child.once('exit', (code) => connection.close(new Error(`the server exited (code ${code})`)));
  try {
    const clientInfo = { name: 'antigravity-acp-for-copilot', title: 'Antigravity for Copilot', version: 'upstream-check' };
    const capabilities = { fs: { readTextFile: false, writeTextFile: false }, terminal: false };
    const init = await connection.request<acp.InitializeResponse>('initialize', { protocolVersion: 1, clientCapabilities: capabilities, clientInfo });
    console.log(`${label}: initialize answered in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    check(`${label}: speaks ACP version 1`, init.protocolVersion === 1, String(init.protocolVersion));
    const methods = (init.authMethods ?? []).map((method) => method.id);
    check(`${label}: offers Google sign-in (${GOOGLE_SIGN_IN})`, methods.includes(GOOGLE_SIGN_IN), methods.join(', '));
    const signedOut = await connection.request('session/new', { cwd: home, mcpServers: [] }).then(
      () => undefined,
      (error: unknown) => error,
    );
    check(`${label}: a signed-out session asks for sign-in`, signedOut instanceof RpcError && signedOut.code === AUTH_REQUIRED, String(signedOut));
  } catch (error) {
    check(label, false, String(error));
  } finally {
    if (child.pid !== undefined) killTree(child.pid);
  }
}

const server = await installServer(mkdtempSync(join(tmpdir(), 'agy-runtime-')));
console.log(`Antigravity ACP server ${server.version} for ${process.platform}-${process.arch}`);
const unpacked = await unpack(server);
// Without a PyInstaller archive (a one-folder build, say) the extension simply starts it the usual way.
console.log(unpacked ? 'unpacked for fast starts' : 'no PyInstaller archive: only the usual start applies');
if (unpacked) await start(server, unpacked);
await start(server, undefined);
console.log(failures === 0 ? 'ALL PASSED' : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
