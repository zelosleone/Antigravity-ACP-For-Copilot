import { build } from 'esbuild';

// One ESM file: the ACP client, the MCP server and zod are bundled; Google's ACP server is downloaded at runtime.
await build({
  entryPoints: ['src/extension.ts'],
  outfile: 'out/extension.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['vscode'],
  // Bundled CommonJS code still calls require() for Node built-ins.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: 'warning',
});
