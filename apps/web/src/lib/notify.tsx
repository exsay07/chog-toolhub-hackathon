import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { NETWORKS, fmtNum, fmtUsd, shortAddress, type TrackerEvent } from '@chog/shared';
import { useSettings } from './settings';
import { useWsMessages } from './ws';
import { cx } from '../components/ui';
import { sfxNotify } from './sfx';

export type NotifyCategory = 'tracker' | 'execution' | 'failed' | 'sniper' | 'perps';

interface Toast {
  id: number;
  category: NotifyCategory;
  tone: 'info' | 'up' | 'down' | 'warn';
  title: string;
  body?: string;
  link?: { href: string; label: string };
  color?: string;
  /** Lifetime, drives the countdown line along the bottom. */
  ms?: number;
}

interface Ctx {
  notify: (t: Omit<Toast, 'id'>) => void;
  trackerFeed: TrackerEvent[];
}

const NotifyCtx = createContext<Ctx | null>(null);
let seq = 0;

export function NotifyProvider({ children }: { children: ReactNode }) {
  const { settings } = useSettings();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [trackerFeed, setFeed] = useState<TrackerEvent[]>([]);
  const nRef = useRef(settings.notifications);
  nRef.current = settings.notifications;

  const notify = useCallback((t: Omit<Toast, 'id'>) => {
    const n = nRef.current;
    if (!n[t.category]) return;
    const id = ++seq;
    setToasts((p) => [...p.slice(-4), { ...t, id, ms: n.durationSec * 1000 }]);
    if (n.sound) sfxNotify(t.tone);
    setTimeout(() => setToasts((p) => p.filter((x) => x.id !== id)), n.durationSec * 1000);
  }, []);

  useWsMessages(
    (m) => {
      if (m.t !== 'tracker') return;
      const e = m.event;
      setFeed((p) => [e, ...p.filter((x) => !(x.id === e.id && x.walletId === e.walletId))].slice(0, 300));
      const verb = {
        buy: 'bought',
        sell: 'sold',
        transfer_in: 'received',
        transfer_out: 'sent',
        other: 'moved',
      }[e.kind];
      const amount = e.tokenAmount !== null ? `${fmtNum(e.tokenAmount, 2)} ` : '';
      notify({
        category: 'tracker',
        tone: e.kind === 'buy' ? 'up' : e.kind === 'sell' ? 'down' : 'info',
        color: e.walletColor,
        title: `${e.walletLabel} ${verb} ${amount}${e.tokenSymbol ?? shortAddress(e.token ?? '?')} on ${NETWORKS[e.network].name}`,
        body: `${e.estUsd !== null ? `est. ${fmtUsd(e.estUsd)} (estimate, not exact fill)` : 'value unknown'} · ${new Date(e.at).toLocaleTimeString()}`,
        link: { href: e.explorerUrl, label: NETWORKS[e.network].explorer.name },
      });
    },
    [notify],
  );

  const pos = settings.notifications.position;
  return (
    <NotifyCtx.Provider value={{ notify, trackerFeed }}>
      {children}
      <div
        aria-live="polite"
        className={cx(
          'fixed z-50 flex flex-col gap-2 w-[360px] pointer-events-none',
          pos === 'top-right' && 'top-14 right-3',
          pos === 'bottom-right' && 'bottom-3 right-3',
          pos === 'bottom-left' && 'bottom-3 left-[calc(var(--sidebar-w)+12px)]',
        )}
      >
        {toasts.map((t) => {
          const c =
            t.color ??
            { info: 'var(--info)', up: 'var(--up)', down: 'var(--down)', warn: 'var(--warn)' }[t.tone];
          return (
            <div
              key={t.id}
              role="status"
              className="toast-crt lux pointer-events-auto relative overflow-hidden rounded-[var(--radius)] border border-line-strong bg-surface shadow-[var(--shadow-lg)] flex items-start gap-1 pl-3"
              style={{ '--toast-c': c } as React.CSSProperties}
            >
              <span
                className="absolute left-0 top-0 bottom-0 w-[3px]"
                style={{ background: c }}
                aria-hidden
              />
              <div
                className="mt-3.5 size-2 rounded-full shrink-0"
                style={{ background: c, boxShadow: `0 0 8px ${c}` }}
              />
              <div className="p-3 pl-1.5 min-w-0 flex-1">
                <div className="text-[13px] font-semibold leading-snug">{t.title}</div>
                {t.body && <div className="text-[11px] text-muted mt-0.5">{t.body}</div>}
                {t.link && /^https:\/\//.test(t.link.href) && (
                  <a
                    className="text-[11px] text-info hover:underline"
                    href={t.link.href}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {t.link.label} ↗
                  </a>
                )}
              </div>
              <button
                className="px-2 py-2 text-muted hover:text-text self-start"
                onClick={() => setToasts((p) => p.filter((x) => x.id !== t.id))}
                aria-label="Dismiss"
              >
                ×
              </button>
              {t.ms && (
                <span
                  className="toast-life absolute left-0 bottom-0 h-[2px]"
                  style={{ background: c, animationDuration: `${t.ms}ms` }}
                  aria-hidden
                />
              )}
            </div>
          );
        })}
      </div>
    </NotifyCtx.Provider>
  );
}

export function useNotify() {
  const c = useContext(NotifyCtx);
  if (!c) throw new Error('NotifyProvider missing');
  return c;
}

/** Re-render on an interval (for relative timestamps). */
export function useTick(ms = 10_000) {
  const [, s] = useState(0);
  useEffect(() => {
    const i = setInterval(() => s((x) => x + 1), ms);
    return () => clearInterval(i);
  }, [ms]);
}
