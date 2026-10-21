import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { get } from '../../lib/api';
import { farmTotals, useFarms, volumeHistory } from '../../lib/perps/runner';
import { cx, Empty, Panel, Stat } from '../../components/ui';

/**
 * Live perps-farming overview: session totals of the bots running in this tab, a volume sparkline,
 * and the latest notable bot events from the account's automation log (survives reloads).
 */

const usd = (v: number) =>
  `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

interface LogRow {
  id: number;
  level: 'info' | 'warn' | 'error';
  message: string;
  at: string;
}

function Sparkline({ points }: { points: Array<{ t: number; v: number }> }) {
  if (points.length < 2)
    return (
      <div className="h-16 grid place-items-center text-[11px] text-muted">
        The volume curve draws itself while bots run.
      </div>
    );
  const w = 600;
  const h = 64;
  const t0 = points[0]!.t;
  const t1 = points[points.length - 1]!.t;
  const vMax = Math.max(1, ...points.map((p) => p.v));
  const xy = points.map(
    (p) => [((p.t - t0) / Math.max(1, t1 - t0)) * w, h - 4 - (p.v / vMax) * (h - 10)] as const,
  );
  const line = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className="w-full h-16"
      aria-label="Session volume"
    >
      <defs>
        <linearGradient id="spark-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--accent)" stopOpacity="0.35" />
          <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line} L${w},${h} L0,${h} Z`} fill="url(#spark-fill)" />
      <path d={line} fill="none" stroke="var(--accent)" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function FarmSummary({ className, linkToPerps }: { className?: string; linkToPerps?: boolean }) {
  useFarms(); // re-render on every bot update
  const t = farmTotals();
  const logs = useQuery({
    queryKey: ['automation-logs', 'perps'],
    queryFn: () => get<LogRow[]>('/api/automation-logs?kind=perps'),
    refetchInterval: 15_000,
  });
  const recent = (logs.data ?? []).slice(0, 7);

  return (
    <div className={cx('grid grid-cols-12 gap-3', className)}>
      <Panel
        title="Perps farming · this session"
        className="col-span-8"
        actions={
          linkToPerps ? (
            <Link to="/perps" viewTransition className="text-[11px] text-info">
              Perps Farm →
            </Link>
          ) : undefined
        }
      >
        <div className="grid grid-cols-5 gap-4">
          <Stat label="Bots running" value={t.running} />
          <Stat label="Volume" value={usd(t.volumeUsd)} />
          <Stat label="Fees" value={usd(t.feesUsd)} />
          <Stat
            label="PnL (net)"
            value={usd(t.pnlUsd)}
            tone={t.pnlUsd > 0.005 ? 'up' : t.pnlUsd < -0.005 ? 'down' : undefined}
          />
          <Stat label="Cycles" value={t.cycles} />
        </div>
        <div className="mt-3 rounded-[var(--radius-sm)] border border-line bg-bg/40 px-2 pt-2">
          <Sparkline points={volumeHistory} />
        </div>
      </Panel>
      <Panel title="Bot activity" className="col-span-4" dense>
        {recent.length === 0 ? (
          <Empty title="Quiet so far" mood="sleep" compact>
            Cycle summaries, limits and errors from your bots show up here.
          </Empty>
        ) : (
          <ul className="stagger divide-y divide-line/50">
            {recent.map((r) => (
              <li key={r.id} className="flex items-start gap-2 px-3 py-2 text-[12px]">
                <span
                  className={cx(
                    'mt-1.5 size-1.5 rounded-full shrink-0',
                    r.level === 'error' ? 'bg-down' : r.level === 'warn' ? 'bg-warn' : 'bg-up',
                  )}
                />
                <span className="flex-1 min-w-0 text-text-2 leading-snug">{r.message}</span>
                <span className="num text-[11px] text-muted shrink-0">
                  {new Date(r.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
