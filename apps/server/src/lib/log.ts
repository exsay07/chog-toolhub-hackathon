import pino from 'pino';

/**
 * Structured logger with defensive redaction. Secrets should never reach a log call in the first
 * place; redaction is a second line of defence.
 */
export const REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-agent-token"]',
  'res.headers["set-cookie"]',
  '*.privateKey',
  '*.secret',
  '*.seed',
  '*.mnemonic',
  '*.signature',
  '*.token',
  '*.password',
  '*.apiKey',
];

export function createLogger(level: string) {
  return pino({
    level,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    base: { svc: 'chog-server' },
  });
}

export type Logger = ReturnType<typeof createLogger>;

/** Strips anything that looks like a key or long secret from free-form error text. */
export function sanitizeError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw
    .replace(/0x[0-9a-fA-F]{64,}/g, '0x[redacted]')
    .replace(/[1-9A-HJ-NP-Za-km-z]{80,}/g, '[redacted]')
    .replace(/(api[_-]?key|token|secret)=([^&\s]+)/gi, '$1=[redacted]')
    .slice(0, 300);
}
