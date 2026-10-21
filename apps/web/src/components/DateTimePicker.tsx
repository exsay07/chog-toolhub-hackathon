import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CalendarClock, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { cx, popoverRoot } from './ui';

/**
 * Date + time picker in the app's own style and always in English — the browser's native
 * <input type="datetime-local"> follows the OS language (that's where Ukrainian placeholders came from).
 * Value: epoch ms in local time, or null = not set.
 */

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const DAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const pad = (n: number) => String(n).padStart(2, '0');

export function formatDateTime(ms: number) {
  const d = new Date(ms);
  return `${MONTHS[d.getMonth()]!.slice(0, 3)} ${d.getDate()}, ${d.getFullYear()} · ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function DateTimePicker({
  value,
  onChange,
  placeholder = 'Not set',
  minNow = true,
  'aria-label': ariaLabel,
}: {
  value: number | null;
  onChange: (ms: number | null) => void;
  placeholder?: string;
  /** Disallow picking a moment in the past. */
  minNow?: boolean;
  'aria-label'?: string;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const base = new Date(value ?? Date.now() + 10 * 60_000);
  const [view, setView] = useState({ y: base.getFullYear(), m: base.getMonth() });
  const [draft, setDraft] = useState<Date>(base);

  useLayoutEffect(() => {
    if (!open) return;
    const r = btn.current!.getBoundingClientRect();
    const h = 360;
    setPos({ left: r.left, top: r.bottom + 6 + h > window.innerHeight ? r.top - h - 6 : r.bottom + 6 });
    const d = new Date(value ?? Date.now() + 10 * 60_000);
    d.setSeconds(0, 0);
    setDraft(d);
    setView({ y: d.getFullYear(), m: d.getMonth() });
  }, [open, value]);

  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!pop.current?.contains(t) && !btn.current?.contains(t)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', down);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', down);
      document.removeEventListener('keydown', key);
    };
  }, [open]);

  const first = new Date(view.y, view.m, 1);
  const lead = (first.getDay() + 6) % 7; // Monday-first
  const days = new Date(view.y, view.m + 1, 0).getDate();
  const today = new Date();
  const sameDay = (a: Date, y: number, m: number, d: number) =>
    a.getFullYear() === y && a.getMonth() === m && a.getDate() === d;
  const past = (y: number, m: number, d: number) =>
    minNow && new Date(y, m, d, 23, 59, 59).getTime() < Date.now();
  const shift = (dm: number) =>
    setView((v) => {
      const n = new Date(v.y, v.m + dm, 1);
      return { y: n.getFullYear(), m: n.getMonth() };
    });
  const setTime = (h: number, min: number) => {
    const d = new Date(draft);
    d.setHours(Math.max(0, Math.min(23, h)), Math.max(0, Math.min(59, min)), 0, 0);
    setDraft(d);
  };
  const tooEarly = minNow && draft.getTime() < Date.now();

  return (
    <>
      <button
        ref={btn}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={ariaLabel}
        aria-expanded={open}
        className="w-full h-8 px-2.5 rounded-[var(--radius-sm)] border border-line bg-bg text-[13px] text-left inline-flex items-center gap-2 hover:border-line-strong focus-visible:outline-none focus-visible:border-accent"
      >
        <CalendarClock className="size-3.5 text-muted shrink-0" />
        <span className={cx('flex-1 truncate', value ? 'text-text' : 'text-muted')}>
          {value ? formatDateTime(value) : placeholder}
        </span>
        {value !== null && (
          <span
            role="button"
            tabIndex={-1}
            aria-label="Clear date"
            onClick={(e) => {
              e.stopPropagation();
              onChange(null);
            }}
            className="text-muted hover:text-text"
          >
            <X className="size-3.5" />
          </span>
        )}
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={pop}
            role="dialog"
            aria-label="Pick date and time"
            className="fixed z-[80] w-[272px] bg-surface border border-line-strong rounded-[var(--radius)] shadow-[var(--shadow-lg)] p-3"
            style={{ left: pos.left, top: pos.top }}
          >
            <div className="flex items-center justify-between mb-2">
              <button
                type="button"
                onClick={() => shift(-1)}
                className="size-7 grid place-items-center rounded-[var(--radius-sm)] text-muted hover:text-text hover:bg-surface-2"
                aria-label="Previous month"
              >
                <ChevronLeft className="size-4" />
              </button>
              <div className="text-[13px] font-semibold">
                {MONTHS[view.m]} {view.y}
              </div>
              <button
                type="button"
                onClick={() => shift(1)}
                className="size-7 grid place-items-center rounded-[var(--radius-sm)] text-muted hover:text-text hover:bg-surface-2"
                aria-label="Next month"
              >
                <ChevronRight className="size-4" />
              </button>
            </div>
            <div className="grid grid-cols-7 gap-0.5 text-center">
              {DAYS.map((d) => (
                <div key={d} className="text-[10px] text-muted h-6 grid place-items-center">
                  {d}
                </div>
              ))}
              {Array.from({ length: lead }, (_, i) => (
                <div key={`l${i}`} />
              ))}
              {Array.from({ length: days }, (_, i) => {
                const d = i + 1;
                const sel = sameDay(draft, view.y, view.m, d);
                const isToday = sameDay(today, view.y, view.m, d);
                const disabled = past(view.y, view.m, d);
                return (
                  <button
                    key={d}
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      const n = new Date(draft);
                      n.setFullYear(view.y, view.m, d);
                      setDraft(n);
                    }}
                    className={cx(
                      'h-8 rounded-[var(--radius-sm)] text-[12px] num transition-colors disabled:opacity-25',
                      sel
                        ? 'bg-accent text-white'
                        : isToday
                          ? 'border border-accent/50 text-text hover:bg-surface-2'
                          : 'text-text-2 hover:bg-surface-2 hover:text-text',
                    )}
                  >
                    {d}
                  </button>
                );
              })}
            </div>
            <div className="flex items-center gap-2 mt-3 pt-3 border-t border-line">
              <span className="text-[11px] text-muted uppercase tracking-wider">Time</span>
              <TimeBox
                value={draft.getHours()}
                max={23}
                onChange={(h) => setTime(h, draft.getMinutes())}
                label="Hour"
              />
              <span className="text-muted">:</span>
              <TimeBox
                value={draft.getMinutes()}
                max={59}
                onChange={(m) => setTime(draft.getHours(), m)}
                label="Minute"
              />
              <button
                type="button"
                onClick={() => {
                  const n = new Date(Date.now() + 60_000);
                  n.setSeconds(0, 0);
                  setDraft(n);
                  setView({ y: n.getFullYear(), m: n.getMonth() });
                }}
                className="ml-auto text-[12px] text-text-2 hover:text-text"
              >
                Now
              </button>
            </div>
            {tooEarly && <div className="text-[11px] text-down mt-2">That moment has already passed.</div>}
            <div className="flex justify-end gap-2 mt-3">
              <button
                type="button"
                onClick={() => {
                  onChange(null);
                  setOpen(false);
                }}
                className="h-7 px-2.5 rounded-[var(--radius-sm)] text-[12px] text-text-2 hover:text-text hover:bg-surface-2"
              >
                Clear
              </button>
              <button
                type="button"
                disabled={tooEarly}
                onClick={() => {
                  onChange(draft.getTime());
                  setOpen(false);
                }}
                className="h-7 px-3 rounded-[var(--radius-sm)] text-[12px] font-medium bg-accent text-white disabled:opacity-40"
              >
                Set
              </button>
            </div>
          </div>,
          popoverRoot(btn.current),
        )}
    </>
  );
}

/** Two-digit time field: type, arrow keys or wheel. */
function TimeBox({
  value,
  max,
  onChange,
  label,
}: {
  value: number;
  max: number;
  onChange: (v: number) => void;
  label: string;
}) {
  const [text, setText] = useState(pad(value));
  useEffect(() => setText(pad(value)), [value]);
  const step = (d: number) => onChange((value + d + max + 1) % (max + 1));
  return (
    <input
      aria-label={label}
      inputMode="numeric"
      value={text}
      onChange={(e) => {
        const t = e.target.value.replace(/\D/g, '').slice(0, 2);
        setText(t);
        if (t.length === 2) onChange(Math.min(max, Number(t)));
      }}
      onBlur={() => onChange(Math.min(max, Number(text || 0)))}
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          step(1);
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          step(-1);
        }
      }}
      data-wheel
      onWheel={(e) => step(e.deltaY < 0 ? 1 : -1)}
      className="w-10 h-7 text-center num text-[13px] rounded-[var(--radius-sm)] border border-line bg-bg focus:outline-none focus:border-accent"
    />
  );
}
