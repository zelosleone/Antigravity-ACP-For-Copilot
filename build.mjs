import { build } from 'esbuild';

// One small ESM file with no runtime dependencies (the SDKs are only used for their types); Google's
// ACP server is downloaded at runtime. `node build.mjs upstream` builds the daily upstream check instead.
const upstream = process.argv[2] === 'upstream';
await build({
  entryPoints: [upstream ? 'src/upstream.ts' : 'src/extension.ts'],
  outfile: upstream ? 'out/upstream.mjs' : 'out/extension.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['vscode'],
  logLevel: 'warning',
});
