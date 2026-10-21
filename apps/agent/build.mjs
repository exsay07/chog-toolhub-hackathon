import { build } from 'esbuild';

// Single self-contained file: easier to sign, hash and audit than a node_modules tree.
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: { js: '' },
});
console.log('agent built');
