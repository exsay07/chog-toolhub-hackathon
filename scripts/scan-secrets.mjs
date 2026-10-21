#!/usr/bin/env node
/**
 * Lightweight secret scanner (no external service). Fails (exit 1) on likely secrets.
 * Complements, not replaces, a dedicated tool such as gitleaks in CI.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  'test-results',
  'playwright-report',
  'coverage',
  '.data',
  'drizzle',
  // User-provided software kept out of git (contains its own keys) — not project code.
  'perpl soft',
  'bulk soft',
]);
const SKIP_FILES = /\.(png|jpe?g|webp|gif|woff2?|ico|lock|zip)$|package-lock\.json$|promt\.txt$/;
// Publicly documented Hardhat/Anvil test key #0 — used only by e2e/load tests, never funded.
const ALLOW = new Set(['ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80']);

const RULES = [
  { id: 'pem-private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/ },
  { id: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  {
    id: 'hex-private-key',
    re: /(?:priv(?:ate)?[_-]?key|secret|mnemonic|seed|\bpk)\W{0,20}['"`]?(?:0x)?([0-9a-fA-F]{64})\b/i,
  },
  {
    id: 'generic-api-key',
    re: /(?:api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*['"`]([A-Za-z0-9_-]{24,})['"`]/i,
  },
  {
    id: 'bip39-like-phrase',
    re: /['"`]((?:[a-z]{3,8} ){11}[a-z]{3,8}(?: (?:[a-z]{3,8} ){11}[a-z]{3,8})?)['"`]/,
  },
  {
    id: 'db-url-with-password',
    // A `${VAR}` placeholder (docker compose interpolation) is not a password.
    re: /postgres(?:ql)?:\/\/[^:\s'"]+:(?!\$\{)[^@\s'"]{6,}@(?!localhost|127\.0\.0\.1|host\b|h\/)/,
  },
];

const findings = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(p);
      continue;
    }
    const rel = relative(ROOT, p).replaceAll('\\', '/');
    if (/^\.env($|\.)/.test(name) && name !== '.env.example')
      findings.push({ file: rel, line: 0, rule: 'env-file-present', note: 'ensure it is git-ignored' });
    if (SKIP_FILES.test(name) || st.size > 2_000_000) continue;
    const lines = readFileSync(p, 'utf8').split('\n');
    lines.forEach((l, i) => {
      for (const r of RULES) {
        const m = r.re.exec(l);
        if (!m) continue;
        const val = (m[1] ?? '').toLowerCase().replace(/^0x/, '');
        if (ALLOW.has(val)) continue;
        findings.push({ file: rel, line: i + 1, rule: r.id });
      }
    });
  }
}
walk(ROOT);
const blocking = findings.filter((f) => f.rule !== 'env-file-present');
for (const f of findings)
  console.log(`${f.rule.padEnd(22)} ${f.file}:${f.line}${f.note ? ` (${f.note})` : ''}`);
console.log(`\n${blocking.length} blocking finding(s), ${findings.length - blocking.length} warning(s).`);
process.exit(blocking.length ? 1 : 0);
