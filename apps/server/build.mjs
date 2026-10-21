import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
// Bundle workspace code (@chog/shared); keep real npm dependencies external.
const external = Object.keys(pkg.dependencies).filter((d) => !d.startsWith('@chog/'));

await build({
  entryPoints: ['src/index.ts', 'src/db/migrate-cli.ts'],
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  external,
  outbase: 'src',
});
console.log('server built');
