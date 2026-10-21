// Fails the web build when two production chunks import each other (directly or through a cycle).
// Circular chunk imports evaluate one chunk before the other is ready and crash at runtime
// (2026-10-21: Solana v3's @solana-program/* landed outside the "solana" chunk). Dev mode never shows it.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(process.argv[2] ?? 'apps/web/dist', 'assets');
const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
const deps = new Map();
for (const f of files) {
  const src = readFileSync(join(dir, f), 'utf8');
  const out = new Set();
  // Static imports only (dynamic import() is lazy and cannot deadlock evaluation).
  for (const m of src.matchAll(/(?:^|[;}\s])import\s*(?:[\w${},\s*]+from\s*)?["']\.\/([^"']+\.js)["']/g))
    out.add(m[1]);
  for (const m of src.matchAll(
    /(?:^|[;}\s])export\s*\*?\s*(?:\{[^}]*\})?\s*from\s*["']\.\/([^"']+\.js)["']/g,
  ))
    out.add(m[1]);
  deps.set(f, out);
}
const cycles = [];
const state = new Map();
const stack = [];
const visit = (f) => {
  state.set(f, 1);
  stack.push(f);
  for (const d of deps.get(f) ?? []) {
    if (state.get(d) === 1) cycles.push([...stack.slice(stack.indexOf(d)), d].join(' → '));
    else if (!state.has(d)) visit(d);
  }
  stack.pop();
  state.set(f, 2);
};
for (const f of files) if (!state.has(f)) visit(f);
if (cycles.length) {
  console.error(`Circular imports between production chunks:\n  ${cycles.join('\n  ')}`);
  console.error('Fix the codeSplitting groups in apps/web/vite.config.ts.');
  process.exit(1);
}
console.log(`chunks ok: ${files.length} files, no circular static imports`);
