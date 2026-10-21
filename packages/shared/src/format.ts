/**
 * Intl formatters are expensive to construct (~0.5 ms each) and tables format thousands of numbers:
 * build each one once and reuse it.
 */
const nf = new Map<string, Intl.NumberFormat>();
function numberFormat(min: number, max: number) {
  const k = `${min}:${max}`;
  let f = nf.get(k);
  if (!f)
    nf.set(
      k,
      (f = new Intl.NumberFormat('en-US', { minimumFractionDigits: min, maximumFractionDigits: max })),
    );
  return f;
}

/** 12345 → "12,345" (cached formatter). */
export const fmtInt = (v: number) => numberFormat(0, 0).format(v);

export function fmtUsd(
  v: number | null | undefined,
  opts: { compact?: boolean; sign?: boolean } = {},
): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  const sign = v < 0 ? '−' : opts.sign && v > 0 ? '+' : '';
  if (opts.compact && abs >= 1000) {
    const units: Array<[number, string]> = [
      [1e12, 'T'],
      [1e9, 'B'],
      [1e6, 'M'],
      [1e3, 'K'],
    ];
    for (const [d, s] of units)
      if (abs >= d) return `${sign}$${(abs / d).toFixed(abs / d >= 100 ? 0 : 1)}${s}`;
  }
  if (abs > 0 && abs < 0.01) return `${sign}$${fmtSmall(abs)}`;
  return `${sign}${numberFormat(2, 2).format(abs)}`;
}

/** Formats tiny prices like 0.0₅123 (subscript zero count), as token terminals do. */
export function fmtSmall(v: number): string {
  if (v === 0) return '0';
  if (v >= 0.01) return v.toPrecision(4);
  // toExponential avoids binary-float artefacts of toFixed (0.00123 → "0.00122999…").
  const [mant, exp] = v.toExponential(3).split('e') as [string, string];
  const zeros = -Number(exp) - 1;
  const digits = mant.replace('.', '').replace(/0+$/, '') || '0';
  if (zeros < 4) return `0.${'0'.repeat(zeros)}${digits}`;
  const sub = String(zeros).replace(/\d/g, (d) => '₀₁₂₃₄₅₆₇₈₉'[Number(d)]!);
  return `0.0${sub}${digits}`;
}

export function fmtPrice(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  if (v >= 1) return `${numberFormat(0, 4).format(v)}`;
  return `$${fmtSmall(v)}`;
}

export function fmtPct(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(digits)}%`;
}

export function fmtNum(v: number | null | undefined, digits = 4): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return numberFormat(0, digits).format(v);
}

export function fmtAge(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
