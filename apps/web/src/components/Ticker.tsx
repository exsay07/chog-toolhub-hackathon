import { useEffect, useRef } from 'react';
import { cx } from './ui';

/**
 * A number that rolls to its new value like a split-flap / odometer, and briefly glows green or
 * red when it goes up or down. Works on the already-formatted text ("$1,234.56", "+3.2%"), so any
 * formatter keeps working: digits roll, everything else stays put. Columns are keyed from the right,
 * so units stay aligned when the length changes. Reduced motion → plain text, no flash.
 */

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

/** Numeric reading of formatted text, for the up/down flash ("$1.2K" → 1.2 is fine: same unit). */
function reading(s: string): number | null {
  const m = s.replace(/[,\s]/g, '').match(/[-−]?\d+(\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0].replace('−', '-'));
  return Number.isFinite(n) ? n : null;
}

function reducedMotion() {
  const pref = document.documentElement.dataset.motion;
  if (pref === 'on') return true;
  if (pref === 'off') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function Ticker({ text, className }: { text: string; className?: string }) {
  const prev = useRef(text);
  const el = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const before = prev.current;
    prev.current = text;
    if (before === text || !el.current || reducedMotion()) return;
    const a = reading(before);
    const b = reading(text);
    if (a === null || b === null || a === b) return;
    // A short phosphor glow in the direction of the move, fading back to the normal colour.
    const c = b > a ? 'var(--up)' : 'var(--down)';
    el.current.animate(
      [
        { color: c, textShadow: `0 0 10px ${c}` },
        { color: c, textShadow: `0 0 6px ${c}`, offset: 0.25 },
        { color: 'inherit', textShadow: 'inherit' },
      ],
      { duration: 1100, easing: 'ease-out' },
    );
  }, [text]);

  const chars = [...text];
  return (
    <span ref={el} className={cx('ticker num inline-flex items-baseline whitespace-nowrap', className)}>
      {/* The real value (copy, screen readers, tests); the rolling columns below are drawing only. */}
      <span className="sr-only">{text}</span>
      <span aria-hidden className="inline-flex items-baseline">
        {chars.map((c, i) => {
          const key = chars.length - i; // stable from the right
          const d = DIGITS.indexOf(c);
          return d < 0 ? (
            <span key={`s${key}`}>{c}</span>
          ) : (
            <span key={`d${key}`} className="ticker-col">
              <span className="ticker-stack" style={{ transform: `translateY(${-d * 10}%)` }} />
            </span>
          );
        })}
      </span>
    </span>
  );
}
