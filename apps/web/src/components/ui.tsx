import {
  Children,
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ButtonHTMLAttributes,
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router';
import { AlertTriangle, Check, ChevronDown, Copy as CopyIcon, Info, OctagonAlert, X } from 'lucide-react';
import { NETWORKS, fmtAge, fmtPrice, type NetworkId } from '@chog/shared';
import { ChainIcon } from './ChainIcon';
import { Ticker } from './Ticker';

export const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(' ');

/**
 * Stable per-label phase for the CRT flicker/twitch, so headings never twitch in sync.
 * Used on headings only — never on prices, balances or other data.
 */
export function glitchPhase(seed: string): CSSProperties {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return {
    '--d': `${-((h % 240) / 100).toFixed(2)}s`,
    '--d2': `${-(((h >>> 8) % 550) / 100).toFixed(2)}s`,
  } as CSSProperties;
}

/** Content panel: solid surface, hairline border, compact header. */
export function Panel({
  title,
  actions,
  children,
  className,
  bodyClass,
  dense,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClass?: string;
  dense?: boolean;
}) {
  return (
    <section
      className={cx(
        'lux bg-surface border border-line rounded-[var(--radius)] shadow-[var(--shadow)] flex flex-col min-h-0',
        className,
      )}
    >
      {(title || actions) && (
        <header className="flex items-center justify-between gap-2 px-4 h-10 shrink-0 border-b border-line">
          <h2 className="text-[13px] font-medium text-text truncate">
            <span className="crt-glitch" style={glitchPhase(typeof title === 'string' ? title : '')}>
              {title}
            </span>
          </h2>
          <div className="flex items-center gap-2">{actions}</div>
        </header>
      )}
      <div className={cx(dense ? 'p-0' : 'p-4', 'min-h-0 flex-1', bodyClass)}>{children}</div>
    </section>
  );
}

type BtnVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'up' | 'down';
export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  loading,
  children,
  ...p
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: BtnVariant;
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
}) {
  const v: Record<BtnVariant, string> = {
    primary: 'bg-primary text-primary-ink border-transparent hover:opacity-90',
    secondary: 'bg-surface text-text border-line-strong hover:bg-surface-2',
    ghost: 'bg-transparent text-text-2 border-transparent hover:bg-surface-2 hover:text-text',
    danger: 'bg-transparent text-down border-down/40 hover:bg-down/10',
    up: 'bg-up text-white border-transparent hover:opacity-90',
    down: 'bg-down text-white border-transparent hover:opacity-90',
  };
  const s = {
    sm: 'h-7 px-2.5 text-[12px]',
    md: 'h-8 px-3 text-[13px]',
    lg: 'h-9 px-4 text-[13px]',
  }[size];
  return (
    <button
      {...p}
      disabled={p.disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 border rounded-[var(--radius-sm)] font-medium transition-[background-color,opacity,color] duration-[var(--dur)] disabled:opacity-40 disabled:cursor-not-allowed select-none whitespace-nowrap',
        v[variant],
        s,
        className,
      )}
    >
      {loading && (
        <span
          className="size-3 rounded-full border-[1.5px] border-current border-t-transparent animate-spin"
          aria-hidden
        />
      )}
      {children}
    </button>
  );
}

export function Badge({
  children,
  tone = 'neutral',
  title,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'up' | 'down' | 'warn' | 'accent' | 'info';
  title?: string;
}) {
  const t = {
    neutral: 'text-text-2 bg-surface-2 border-line',
    up: 'text-up bg-up/8 border-up/25',
    down: 'text-down bg-down/8 border-down/25',
    warn: 'text-warn bg-warn/8 border-warn/25',
    accent: 'text-accent bg-accent/8 border-accent/25',
    info: 'text-info bg-info/8 border-info/25',
  }[tone];
  return (
    <span
      title={title}
      className={cx(
        'inline-flex items-center gap-1 h-5 px-1.5 border rounded-[4px] text-[11px] font-medium whitespace-nowrap',
        t,
      )}
    >
      {children}
    </span>
  );
}

export function NetworkBadge({ id }: { id: NetworkId }) {
  return (
    <span
      className="inline-flex items-center gap-1 h-5 pl-[3px] pr-1.5 border border-line rounded-[4px] bg-surface-2 text-[11px] font-medium text-text-2"
      title={NETWORKS[id].name}
    >
      <ChainIcon id={id} size={13} />
      {NETWORKS[id].shortName}
    </span>
  );
}

export function Stat({
  label,
  value,
  sub,
  tone,
  hint,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'up' | 'down';
  hint?: string;
}) {
  return (
    <div className="min-w-0" title={hint}>
      <div className="text-[12px] text-muted truncate">{label}</div>
      <div
        className={cx(
          'num text-[15px] font-semibold tracking-tight truncate mt-0.5',
          tone === 'up' && 'text-up',
          tone === 'down' && 'text-down',
        )}
      >
        {typeof value === 'string' || typeof value === 'number' ? <Ticker text={String(value)} /> : value}
      </div>
      {sub && <div className="text-[12px] text-muted truncate">{sub}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('skeleton h-3', className)} aria-hidden />;
}

export function SkeletonRows({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-3 p-4" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className={i % 3 === 0 ? 'w-2/3' : 'w-full'} />
      ))}
    </div>
  );
}

/**
 * Empty state with character: a small Chog on the old TV (gently bobbing, a mood glyph beside it),
 * a one-line explanation and — where there is one — the next step as a button.
 * `compact` drops the Chog for tight spots (charts, side panels).
 */
export function Empty({
  title,
  children,
  action,
  mood = 'idle',
  compact,
}: {
  title: string;
  children?: ReactNode;
  icon?: string;
  action?: { label: string; to?: string; onClick?: () => void };
  mood?: 'idle' | 'sleep' | 'search';
  compact?: boolean;
}) {
  return (
    <div
      className={cx(
        'empty-in flex flex-col items-center justify-center text-center px-6 gap-1',
        compact ? 'py-6' : 'py-8',
      )}
    >
      {!compact && (
        <div className="empty-chog relative mb-2" aria-hidden>
          <img src="/brand/avatar.webp" alt="" className="size-14 rounded-full" />
          <span className="empty-mood">{{ idle: '…', sleep: 'z', search: '?' }[mood]}</span>
        </div>
      )}
      <div className="text-[13px] font-medium text-text-2">{title}</div>
      {children && <div className="text-[12px] text-muted max-w-sm leading-relaxed">{children}</div>}
      {action &&
        (action.to ? (
          <Link
            to={action.to}
            viewTransition
            className="mt-3 h-8 px-3 inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] border border-line-strong text-[12px] text-text hover:bg-surface-2"
          >
            {action.label} →
          </Link>
        ) : (
          <Button size="sm" className="mt-3" onClick={action.onClick}>
            {action.label}
          </Button>
        ))}
    </div>
  );
}

/** Errors that just mean "the data source is busy" — shown calmly and retried by themselves. */
const TRANSIENT = /rate limit|429|unavailable|timeout|timed out|temporar|busy|503|502|fetch failed|network/i;
const RETRY_SEC = 20;

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const msg = error instanceof Error ? error.message : 'Something went wrong';
  const transient = TRANSIENT.test(msg);
  const [left, setLeft] = useState(RETRY_SEC);
  const retryRef = useRef(retry);
  retryRef.current = retry;
  useEffect(() => {
    if (!transient || !retryRef.current) return;
    setLeft(RETRY_SEC);
    const t = setInterval(
      () =>
        setLeft((s) => {
          if (s > 1) return s - 1;
          retryRef.current?.();
          return RETRY_SEC;
        }),
      1000,
    );
    return () => clearInterval(t);
  }, [transient, msg]);

  if (transient)
    return (
      <div
        role="status"
        className="empty-in flex items-center gap-2.5 px-3 py-2.5 m-3 border border-line rounded-[var(--radius-sm)] text-[13px] bg-surface-2/40"
      >
        <span className="crt-text text-[18px] leading-none text-muted" aria-hidden>
          ⟳
        </span>
        <span className="flex-1 text-text-2">
          Live data is catching up — the source is busy for a moment.
          {retry && <span className="text-muted"> Trying again in {left}s.</span>}
        </span>
        {retry && (
          <Button size="sm" variant="ghost" onClick={retry}>
            Now
          </Button>
        )}
      </div>
    );
  return (
    <div
      role="alert"
      className="flex items-center gap-2.5 px-3 py-2.5 m-3 border border-line rounded-[var(--radius-sm)] text-[13px]"
    >
      <OctagonAlert className="size-4 text-down shrink-0" />
      <span className="flex-1 text-text-2">{msg}</span>
      {retry && (
        <Button size="sm" onClick={retry}>
          Retry
        </Button>
      )}
    </div>
  );
}

export function Notice({
  tone = 'warn',
  children,
}: {
  tone?: 'warn' | 'info' | 'down';
  children: ReactNode;
}) {
  const Icon = tone === 'info' ? Info : tone === 'down' ? OctagonAlert : AlertTriangle;
  const c = { warn: 'text-warn', info: 'text-info', down: 'text-down' }[tone];
  return (
    <div className="flex gap-2.5 rounded-[var(--radius-sm)] border border-line bg-surface-2 px-3 py-2.5 text-[12px] leading-relaxed text-text-2">
      <Icon className={cx('size-[15px] shrink-0 mt-[1px]', c)} />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** Data freshness + provenance label. Old data is never shown as live. */
export function Freshness({
  fetchedAt,
  stale,
  source,
  maxAgeMs = 60_000,
}: {
  fetchedAt?: number;
  stale?: boolean;
  source?: string;
  maxAgeMs?: number;
}) {
  const [, setT] = useState(0);
  useEffect(() => {
    const i = setInterval(() => setT((x) => x + 1), 5000);
    return () => clearInterval(i);
  }, []);
  if (!fetchedAt) return null;
  const old = stale || Date.now() - fetchedAt > maxAgeMs;
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 text-[11px] whitespace-nowrap',
        old ? 'text-warn' : 'text-muted',
      )}
      title={`Source: ${source ?? 'provider'} · fetched ${new Date(fetchedAt).toLocaleTimeString()}`}
    >
      <span className={cx('size-[5px] rounded-full', old ? 'bg-warn' : 'bg-up')} />
      {old ? 'Stale · ' : ''}
      {source ? `${source} · ` : ''}
      {fmtAge(fetchedAt)}
    </span>
  );
}

/** Labelled form control. A single child element gets an id so the label names exactly that control. */
export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
}) {
  const id = useId();
  const single = isValidElement<{ id?: string }>(children);
  const ctrlId = single ? (children.props.id ?? id) : undefined;
  return (
    <div className="block space-y-1.5">
      <label htmlFor={ctrlId} className="block text-[12px] font-medium text-text-2">
        {label}
      </label>
      {single ? cloneElement(children, { id: ctrlId }) : children}
      {error ? (
        <span className="block text-[12px] text-down" role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="block text-[12px] text-muted">{hint}</span>
      ) : null}
    </div>
  );
}

const inputCls =
  'w-full h-8 px-2.5 rounded-[var(--radius-sm)] bg-surface border border-line-strong text-text placeholder:text-muted outline-none transition-[border-color,box-shadow] duration-[var(--dur)] focus:border-accent focus:shadow-[0_0_0_3px_color-mix(in_oklab,var(--accent)_18%,transparent)]';
export function Input({ className, ...p }: ComponentProps<'input'>) {
  return <input {...p} className={cx(inputCls, p.type === 'number' && 'num', className)} />;
}
/**
 * Where pop-overs render: inside the open <dialog> when there is one (a modal dialog makes the rest of
 * the page inert, so a pop-over in <body> could be seen but not clicked), else <body>.
 */
export function popoverRoot(anchor: Element | null): Element {
  return anchor?.closest('dialog') ?? document.body;
}

/** Flattens <option value>label</option> children (incl. arrays from .map) into items. */
function optionsOf(children: ReactNode): Array<{ value: string; label: ReactNode; disabled?: boolean }> {
  const out: Array<{ value: string; label: ReactNode; disabled?: boolean }> = [];
  Children.forEach(children, (c) => {
    if (!isValidElement<{ value?: string | number; children?: ReactNode; disabled?: boolean }>(c)) return;
    if (c.type === 'option')
      out.push({ value: String(c.props.value ?? ''), label: c.props.children, disabled: c.props.disabled });
    else if (c.props.children) out.push(...optionsOf(c.props.children));
  });
  return out;
}

/**
 * Dropdown in the app's own style (the native <select> popup uses the OS font / theme). Same API as
 * a <select>: value, onChange(e) with e.target.value, <option> children, disabled, id (from Field).
 * Keyboard: ↑/↓, Enter/Space, Escape, Home/End and type-ahead.
 */
export function Select({
  className,
  children,
  value,
  onChange,
  disabled,
  id,
  'aria-label': ariaLabel,
}: SelectHTMLAttributes<HTMLSelectElement>) {
  const items = optionsOf(children);
  const cur = items.findIndex((o) => o.value === String(value ?? ''));
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(Math.max(0, cur));
  const [pos, setPos] = useState<{ left: number; top: number; width: number; up: boolean } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const typed = useRef({ s: '', at: 0 });

  const choose = (i: number) => {
    const o = items[i];
    if (!o || o.disabled) return;
    setOpen(false);
    btn.current?.focus();
    if (o.value !== String(value ?? ''))
      onChange?.({
        target: { value: o.value },
        currentTarget: { value: o.value },
      } as ChangeEvent<HTMLSelectElement>);
  };

  useLayoutEffect(() => {
    if (!open) return;
    const r = btn.current!.getBoundingClientRect();
    const h = Math.min(280, items.length * 32 + 8);
    const up = r.bottom + h + 8 > window.innerHeight && r.top > h;
    setPos({ left: r.left, top: up ? r.top - h - 4 : r.bottom + 4, width: r.width, up });
    setHi(Math.max(0, cur));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!list.current?.contains(t) && !btn.current?.contains(t)) setOpen(false);
    };
    const close = () => setOpen(false);
    // The page moving under the popup closes it; scrolling the option list itself must not.
    const onScroll = (e: Event) => {
      if (!list.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', down);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('pointerdown', down);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  useEffect(() => {
    if (open)
      list.current?.querySelector<HTMLElement>(`[data-i="${hi}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, hi]);

  const move = (d: number) => {
    let i = hi;
    for (let k = 0; k < items.length; k++) {
      i = (i + d + items.length) % items.length;
      if (!items[i]!.disabled) break;
    }
    setHi(i);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) setOpen(true);
      else move(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (open) choose(hi);
      else setOpen(true);
    } else if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        setOpen(false);
      }
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      setHi(e.key === 'Home' ? 0 : items.length - 1);
    } else if (e.key.length === 1) {
      const now = Date.now();
      typed.current = {
        s: (now - typed.current.at < 700 ? typed.current.s : '') + e.key.toLowerCase(),
        at: now,
      };
      const i = items.findIndex((o) =>
        String(typeof o.label === 'string' ? o.label : o.value)
          .toLowerCase()
          .startsWith(typed.current.s),
      );
      if (i >= 0) (open ? setHi : choose)(i);
    }
  };

  return (
    <>
      <button
        ref={btn}
        id={id}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onKey}
        className={cx(
          inputCls,
          'pr-7 cursor-pointer text-left relative disabled:opacity-50 disabled:cursor-not-allowed',
          className,
        )}
      >
        <span className="block truncate">{items[cur]?.label ?? ''}</span>
        <ChevronDown
          className={cx(
            'absolute right-2 top-1/2 -translate-y-1/2 size-3.5 text-muted transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>
      {open &&
        pos &&
        createPortal(
          <ul
            ref={list}
            role="listbox"
            aria-label={ariaLabel}
            onKeyDown={onKey}
            data-scroll-trap
            className="fixed z-[90] max-h-[280px] overflow-auto overscroll-contain py-1 bg-surface border border-line-strong rounded-[var(--radius-sm)] shadow-[var(--shadow-lg)]"
            style={{ left: pos.left, top: pos.top, minWidth: pos.width }}
          >
            {items.map((o, i) => (
              <li
                key={o.value}
                data-i={i}
                role="option"
                aria-selected={i === cur}
                aria-disabled={o.disabled}
                onMouseEnter={() => setHi(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(i)}
                className={cx(
                  'flex items-center gap-2 h-8 px-2.5 text-[13px] cursor-pointer whitespace-nowrap',
                  i === hi ? 'bg-surface-2 text-text' : 'text-text-2',
                  o.disabled && 'opacity-40 cursor-not-allowed',
                )}
              >
                <span className="flex-1">{o.label}</span>
                {i === cur && <Check className="size-3.5 text-accent" />}
              </li>
            ))}
          </ul>,
          popoverRoot(btn.current),
        )}
    </>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <span className="inline-flex items-center gap-2.5">
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx(
          'relative w-[30px] h-[18px] rounded-full transition-colors duration-[var(--dur)] disabled:opacity-40 shrink-0 border',
          checked ? 'bg-accent border-accent' : 'bg-surface-3 border-line-strong',
        )}
      >
        <span
          className={cx(
            'absolute top-[2px] size-3 rounded-full bg-white transition-[left] duration-[var(--dur)]',
            checked ? 'left-[14px]' : 'left-[2px]',
          )}
        />
      </button>
      {label && (
        <label htmlFor={id} className="text-[13px] text-text-2 cursor-pointer">
          {label}
        </label>
      )}
    </span>
  );
}

/** Segmented control. */
export function Tabs<T extends string>({
  value,
  onChange,
  items,
}: {
  value: T;
  onChange: (v: T) => void;
  items: Array<{ id: T; label: ReactNode }>;
}) {
  return (
    <div
      role="tablist"
      className="inline-flex shrink-0 p-[2px] rounded-[var(--radius-sm)] bg-surface-2 border border-line"
    >
      {items.map((it) => (
        <button
          key={it.id}
          role="tab"
          aria-selected={value === it.id}
          onClick={() => onChange(it.id)}
          className={cx(
            'h-[22px] px-2.5 rounded-[4px] text-[12px] font-medium whitespace-nowrap transition-colors duration-[var(--dur)]',
            value === it.id ? 'bg-surface-3 text-text' : 'text-muted hover:text-text',
          )}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

/** Dialog. */
export function Modal({
  open,
  onClose,
  title,
  children,
  width = 480,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  width?: number;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className="m-auto p-0 rounded-[var(--radius-lg)] bg-surface text-text border border-line-strong shadow-[var(--shadow-lg)]"
      style={{ width }}
    >
      {open && (
        <div className="flex flex-col max-h-[85vh]">
          <header className="flex items-center justify-between px-5 h-12 border-b border-line shrink-0">
            <h2 id={titleId} className="text-[14px] font-semibold">
              {title}
            </h2>
            <button
              onClick={onClose}
              className="size-7 grid place-items-center rounded-[var(--radius-sm)] text-muted hover:text-text hover:bg-surface-2"
              aria-label="Close"
            >
              <X className="size-4" />
            </button>
          </header>
          <div className="p-5 overflow-auto">{children}</div>
        </div>
      )}
    </dialog>
  );
}

export function Pct({ v }: { v: number | null | undefined }) {
  if (v === null || v === undefined || !Number.isFinite(v)) return <span className="text-muted num">—</span>;
  return (
    <span className={cx('num', v > 0 ? 'text-up' : v < 0 ? 'text-down' : 'text-text-2')}>
      {v > 0 ? '+' : ''}
      {v.toFixed(2)}%
    </span>
  );
}

export function Copy({ text, label }: { text: string; label?: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      className="inline-flex items-center gap-1 text-muted hover:text-text text-[12px]"
      title="Copy"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setOk(true);
          setTimeout(() => setOk(false), 1200);
        });
      }}
    >
      {ok ? <Check className="size-3.5 text-up" /> : label ? label : <CopyIcon className="size-3.5" />}
    </button>
  );
}

export function ExtLink({ href, children }: { href: string; children: ReactNode }) {
  const safe = /^https:\/\//.test(href) ? href : '#';
  return (
    <a
      href={safe}
      target="_blank"
      rel="noopener noreferrer"
      className="text-text-2 hover:text-text underline-offset-2 hover:underline"
    >
      {children}
    </a>
  );
}

const SUB = '₀₁₂₃₄₅₆₇₈₉';
/**
 * Renders compact tiny-price notation (0.0₅123) with a real <sub> element: subscript digit glyphs
 * are missing from many fonts and render illegibly otherwise.
 */
export function Price({
  v,
  className,
  live,
}: {
  v: number | null | undefined;
  className?: string;
  /** Roll the digits on change (headline prices; not for big tables). */
  live?: boolean;
}) {
  const s = fmtPrice(v);
  const parts = s.split(/([₀-₉]+)/);
  if (live && parts.length === 1) return <Ticker text={s} className={className} />;
  return (
    <span className={cx('num whitespace-nowrap', className)}>
      {parts.map((p, i) =>
        /^[₀-₉]+$/.test(p) ? (
          <sub key={i} className="text-[0.72em] align-[-0.2em] px-px">
            {[...p].map((c) => SUB.indexOf(c)).join('')}
          </sub>
        ) : (
          p
        ),
      )}
    </span>
  );
}
