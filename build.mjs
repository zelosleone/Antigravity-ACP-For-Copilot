import { build } from 'esbuild';

// One small ESM file with no runtime dependencies (the SDKs are only used for their types); Google's
// ACP server is downloaded at runtime.
await build({
  entryPoints: ['src/extension.ts'],
  outfile: 'out/extension.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['vscode'],
  logLevel: 'warning',
});
