import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ChevronDown } from 'lucide-react';
import { perpsConfigViolations, zPerpsTaskConfig, type PerpsTaskConfig } from '@chog/shared';
import { del, get, post, put } from '../lib/api';
import { CrtImage } from '../components/CrtImage';
import { marketMaxLeverage, marketSymbol, perplContext } from '../lib/perps/perpl';
import { bulkMarkets } from '../lib/perps/bulk';
import { farmNet, runningFarms, setFarmNet, useFarms } from '../lib/perps/runner';
import { FarmCard, PerplSetup } from './perps/PerplPanels';
import { BulkSetup } from './perps/BulkPanels';
import { FarmSummary } from './perps/FarmSummary';
import { ask } from '../components/Confirm';
import {
  Badge,
  Button,
  cx,
  Empty,
  ErrorState,
  ExtLink,
  Field,
  Input,
  Notice,
  Panel,
  SkeletonRows,
} from '../components/ui';

interface PerpsRow {
  id: string;
  data: PerpsTaskConfig;
  status: string;
}
type PlatformId = PerpsTaskConfig['platform'];

/** Platform cards are data-driven: add an entry here (and a farmer in lib/perps) to support more venues. */
const PLATFORMS: Array<{
  id: PlatformId;
  name: string;
  tagline: string;
  site: string;
  docs: string;
  logo: string;
  /** How much of the brand colour survives the CRT treatment (0 = greyscale). */
  saturation: number;
}> = [
  {
    id: 'perpl',
    name: 'Perpl',
    tagline: 'On-chain perps on Monad',
    site: 'https://perpl.xyz',
    docs: 'https://github.com/PerplFoundation/dex-sdk',
    logo: '/perps/perpl.jpg',
    saturation: 0.6,
  },
  {
    id: 'bulk',
    name: 'Bulk',
    tagline: 'Low-latency perps alongside Solana',
    site: 'https://bulk.trade',
    docs: 'https://docs.bulk.trade',
    logo: '/perps/bulk.jpg',
    saturation: 0.2,
  },
];
const platformOf = (id: string | null) => PLATFORMS.find((p) => p.id === id) ?? null;

/** Markets offered in the configure panel. */
const PAIRS = ['BTC', 'MON', 'ETH', 'SOL', 'HYPE', 'ZEC', 'LIT'] as const;
/**
 * Leverage applied when a pair is picked (order size is never touched): the market's own maximum on
 * Perpl (read live from the exchange), capped at 10x like the original bot. These are the fallbacks.
 */
const LEVERAGE_PRESETS: Record<(typeof PAIRS)[number], number> = {
  BTC: 6.6,
  ETH: 8.3,
  SOL: 8.3,
  HYPE: 10,
  MON: 10,
  ZEC: 10,
  LIT: 10,
};

const DEFAULT: PerpsTaskConfig = {
  platform: 'perpl',
  pair: 'BTC-USD',
  direction: 'alternate',
  sizeUsd: 100,
  leverage: 6.6,
  entry: 'limit',
  exit: 'limit',
  limitOffsetBps: 5,
  holdSec: 30,
  intervalSec: 60,
  risk: {
    maxNotionalUsd: 500,
    maxLeverage: 10,
    maxOpenPositions: 1,
    maxConcurrentOrders: 2,
    maxDailyLossUsd: 25,
    maxRuntimeMin: 240,
  },
};

function usePerpsBots() {
  return useQuery({
    queryKey: ['automations', 'perps'],
    queryFn: () => get<PerpsRow[]>('/api/automations/perps'),
  });
}

export default function Perps() {
  const [params, setParams] = useSearchParams();
  const selected = platformOf(params.get('p'));
  const open = (id: PlatformId | null) => setParams(id ? { p: id } : {}, { viewTransition: true });

  return (
    <div className="page-stagger p-4 space-y-3">
      <Notice tone="down">
        Leveraged, automated perpetual trading can lose some or all of the allocated collateral — including
        through liquidation, funding and fees. Points programs are discretionary: farming does not guarantee
        points, eligibility or any future reward.
      </Notice>
      {selected ? (
        <PlatformView p={selected} onBack={() => open(null)} />
      ) : (
        <>
          <PlatformGrid onOpen={open} />
          <FarmSummary />
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------- platform cards ---- */

function PlatformGrid({ onOpen }: { onOpen: (id: PlatformId) => void }) {
  const tasks = usePerpsBots();
  useFarms();
  const live = runningFarms();
  return (
    <div className="grid grid-cols-[1fr_1fr_340px] gap-3 items-start">
      {PLATFORMS.map((p) => {
        const rows = (tasks.data ?? []).filter((t) => t.data.platform === p.id);
        const running = live.filter((f) => rows.some((r) => r.id === f.id)).length;
        return (
          <button
            key={p.id}
            onClick={() => onOpen(p.id)}
            className="lux group text-left bg-surface border border-line rounded-[var(--radius)] p-5 hover:border-line-strong transition-colors"
          >
            <div className="flex items-start gap-5">
              <CrtImage src={p.logo} size={112} saturation={p.saturation} label={`${p.name} logo`} />
              <div className="min-w-0 flex-1 pt-1">
                <div className="crt-text crt-glitch text-[30px] leading-none">{p.name.toUpperCase()}</div>
                <div className="text-[13px] text-muted mt-2">{p.tagline}</div>
                <div className="flex flex-wrap gap-1.5 mt-3">
                  <Badge tone="info">{farmNet(p.id)}</Badge>
                  <Badge tone={running ? 'up' : 'neutral'}>
                    {running ? `${running} bot${running > 1 ? 's' : ''} running` : `${rows.length} saved`}
                  </Badge>
                </div>
              </div>
            </div>
            <div className="flex items-center justify-between mt-5 pt-4 border-t border-line text-[12px]">
              <span className="flex gap-3 text-muted" onClick={(e) => e.stopPropagation()}>
                <ExtLink href={p.site}>site</ExtLink>
                <ExtLink href={p.docs}>docs</ExtLink>
              </span>
              <span className="text-text-2 group-hover:text-text">Configure &amp; start →</span>
            </div>
          </button>
        );
      })}
      <Panel title="How it works">
        <ol className="space-y-2 text-[12px] text-text-2 list-decimal pl-4">
          <li>Pick a venue, then set pair, size, leverage, direction and order types.</li>
          <li>
            Press <b>Start Bot</b> and sign once: Perpl uses your signed-in wallet, Bulk your Phantom wallet.
          </li>
          <li>The bot trades in this tab. Its key can place and cancel orders — never withdraw.</li>
        </ol>
        <div className="mt-3 text-[12px] text-muted">
          {live.length
            ? `${live.length} bot${live.length > 1 ? 's' : ''} running now.`
            : 'Keep the tab open while bots run.'}
        </div>
      </Panel>
    </div>
  );
}

/* ------------------------------------------------------------------------ platform view ---- */

function PlatformView({ p, onBack }: { p: (typeof PLATFORMS)[number]; onBack: () => void }) {
  const qc = useQueryClient();
  const tasks = usePerpsBots();
  const rows = (tasks.data ?? []).filter((t) => t.data.platform === p.id);
  const [editing, setEditing] = useState<PerpsRow | null>(null);
  const [launch, setLaunch] = useState<{ id: string; cfg: PerpsTaskConfig } | null>(null);
  const farms = useFarms();
  const remove = useMutation({
    mutationFn: (id: string) => del(`/api/automations/perps/${id}`),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['automations', 'perps'] }),
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-4">
        <button
          onClick={onBack}
          className="size-8 grid place-items-center rounded-[var(--radius-sm)] border border-line text-muted hover:text-text hover:bg-surface-2"
          aria-label="Back to platforms"
          title="Back to platforms"
        >
          <ArrowLeft className="size-4" />
        </button>
        <CrtImage src={p.logo} size={52} saturation={p.saturation} label={`${p.name} logo`} />
        <div>
          <div className="crt-text crt-glitch text-[26px] leading-none">{p.name.toUpperCase()}</div>
          <div className="text-[12px] text-muted mt-1">
            {p.tagline} · <ExtLink href={p.site}>site</ExtLink> · <ExtLink href={p.docs}>docs</ExtLink>
          </div>
        </div>
        <div className="ml-auto flex gap-1.5">
          <Badge tone="info">runs in this tab · {farmNet(p.id)}</Badge>
        </div>
      </div>

      <div className="grid grid-cols-[minmax(0,640px)_minmax(0,1fr)] gap-3 items-start">
        <ConfigureStart
          key={editing?.id ?? 'new'}
          platform={p.id}
          row={editing}
          onDone={() => setEditing(null)}
          onLaunch={setLaunch}
        />
        <div className="space-y-3">
          <Panel title={`Bots (${rows.length})`}>
            {tasks.isLoading ? (
              <SkeletonRows rows={3} />
            ) : tasks.isError ? (
              <ErrorState error={tasks.error} />
            ) : rows.length === 0 ? (
              <Empty title="No bots yet">Configure one on the left and press Start Bot.</Empty>
            ) : (
              <ul className="stagger space-y-2">
                {rows.map((r) => {
                  const f = farms.get(r.id);
                  const running = !!f && !['stopped', 'error'].includes(f.state.state);
                  return (
                    <li
                      key={r.id}
                      className="rounded-[var(--radius-sm)] border border-line p-2.5 bg-surface-2/50"
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-[14px]">{r.data.pair}</span>
                        <Badge
                          tone={
                            r.data.direction === 'long'
                              ? 'up'
                              : r.data.direction === 'short'
                                ? 'down'
                                : 'info'
                          }
                        >
                          {r.data.direction === 'alternate' ? 'both' : r.data.direction}
                        </Badge>
                        {!f && <Badge tone="neutral">not running</Badge>}
                        <span className="ml-auto num text-xs">
                          ${r.data.sizeUsd} @ {r.data.leverage}x · {r.data.entry}/{r.data.exit}
                        </span>
                      </div>
                      {f && <FarmCard id={r.id} />}
                      {!running && (
                        <div className="flex gap-1 mt-2">
                          <Button
                            size="sm"
                            variant="primary"
                            onClick={() => setLaunch({ id: r.id, cfg: r.data })}
                          >
                            Start
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setEditing(r)}>
                            Edit
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={async () =>
                              (await ask('Delete this bot config?', { confirmLabel: 'Delete' })) &&
                              remove.mutate(r.id)
                            }
                          >
                            Delete
                          </Button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
          <Notice tone="info">
            Bots trade through a key that lives only in this browser. Keep this tab open while they run —
            closing it stops them (open positions stay on {p.name}).
          </Notice>
        </div>
      </div>
      {p.id === 'perpl' ? (
        <PerplSetup bot={launch} onClose={() => setLaunch(null)} />
      ) : (
        <BulkSetup bot={launch} onClose={() => setLaunch(null)} />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------- configure & start ---- */

function Choice({
  on,
  title,
  sub,
  onClick,
  disabled,
}: {
  on: boolean;
  title: string;
  sub: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={on}
      className={cx(
        'h-full min-w-0 flex flex-col justify-start text-left rounded-[var(--radius)] border px-3.5 py-2.5 transition-colors disabled:opacity-40',
        on
          ? 'border-accent bg-accent/15 shadow-[0_0_0_1px_var(--color-accent)_inset]'
          : 'border-line bg-surface-2/50 hover:border-line-strong hover:bg-surface-2',
      )}
    >
      <div className="text-[14px] font-semibold text-text">{title}</div>
      <div className="text-[12px] text-muted mt-0.5 leading-snug">{sub}</div>
    </button>
  );
}

const label = 'text-[11px] font-medium tracking-wider text-muted uppercase mb-2';

/**
 * The bot launcher (layout of docs/reference/perps-configure-panel.png): pair, order size, leverage,
 * direction and how positions open / close. Start Bot saves the config and starts it on the local agent.
 */
function ConfigureStart({
  platform,
  row,
  onDone,
  onLaunch,
}: {
  platform: PlatformId;
  row: PerpsRow | null;
  onDone: () => void;
  /** Opens the venue's launch checklist for the saved bot. */
  onLaunch: (bot: { id: string; cfg: PerpsTaskConfig }) => void;
}) {
  const qc = useQueryClient();
  const [c, setC] = useState<PerpsTaskConfig>(row?.data ?? { ...DEFAULT, platform });
  const [presetNote, setPresetNote] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'info' | 'down'; text: string } | null>(null);
  const n = (v: string) => (v === '' ? 0 : Number(v));
  const base = c.pair.split('-')[0] as (typeof PAIRS)[number];
  const entryTypes = ['market', 'limit'];
  const exitTypes = ['market', 'limit'];
  const violations = perpsConfigViolations(c);
  const r = c.risk;
  const [net, setNet] = useState(farmNet(platform));
  /** Live market list of the venue: which pairs are open, and their leverage caps. */
  const ctx = useQuery({
    queryKey: ['perps', 'markets', platform, net],
    queryFn: async (): Promise<Array<{ base: string; maxLev: number; minNotional: number }>> =>
      platform === 'perpl'
        ? (await perplContext(net)).markets
            .filter((m) => m.config.is_open)
            .map((m) => ({ base: marketSymbol(m), maxLev: marketMaxLeverage(m), minNotional: 0 }))
        : (await bulkMarkets(net))
            .filter((m) => m.status === 'TRADING')
            .map((m) => ({
              base: m.symbol.split('-')[0]!,
              maxLev: Math.min(10, m.maxLeverage),
              minNotional: m.minNotional,
            })),
    staleTime: 60_000,
  });
  const marketOf = (p: string) => ctx.data?.find((m) => m.base === p);
  const minNotional = marketOf(base)?.minNotional ?? 0;

  const pick = (p: (typeof PAIRS)[number]) => {
    const m = marketOf(p);
    const lev = m ? m.maxLev : LEVERAGE_PRESETS[p];
    setC((x) => ({
      ...x,
      pair: `${p}-USD`,
      leverage: lev,
      risk: { ...x.risk, maxLeverage: Math.max(x.risk.maxLeverage, lev) },
    }));
    setPresetNote(`Applied ${p} preset: ${lev}x leverage.`);
  };

  const start = useMutation({
    mutationFn: async () => {
      const parsed = zPerpsTaskConfig.safeParse(c);
      if (!parsed.success)
        throw new Error(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      if (violations.length) throw new Error(violations.join('; '));
      if (minNotional && parsed.data.sizeUsd < minNotional)
        throw new Error(`Minimum order on ${parsed.data.pair} is $${minNotional}`);
      const saved = row
        ? await put<PerpsRow>(`/api/automations/perps/${row.id}`, parsed.data)
        : await post<PerpsRow>('/api/automations/perps', parsed.data);
      const id = row?.id ?? saved?.id;
      if (!id) throw new Error('Could not save the bot');
      onLaunch({ id, cfg: parsed.data });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['automations', 'perps'] });
      setMsg(null);
      onDone();
    },
    onError: (e) => setMsg({ tone: 'down', text: (e as Error).message }),
  });

  return (
    <section className="lux bg-surface border border-line rounded-[var(--radius-lg)] p-5 space-y-4">
      <h2 className="text-[15px] font-semibold">{row ? 'Edit & restart' : 'Configure & start'}</h2>

      <div>
        <div className={label}>Pair</div>
        <div className="flex flex-wrap gap-2">
          {PAIRS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => pick(p)}
              disabled={!!ctx.data && !marketOf(p)}
              title={
                ctx.data && !marketOf(p)
                  ? `${p} is not open on ${platform === 'perpl' ? 'Perpl' : 'Bulk'} ${net}`
                  : undefined
              }
              aria-pressed={base === p}
              className={cx(
                'h-9 min-w-[54px] px-3 rounded-[var(--radius)] border text-[12px] font-semibold transition-colors disabled:opacity-30',
                base === p
                  ? 'border-accent bg-accent text-white shadow-[0_0_14px_-2px_var(--color-accent)]'
                  : 'border-line bg-surface-2/60 text-text-2 hover:text-text hover:border-line-strong',
              )}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <div className={label}>Order size (USD)</div>
          <Input
            type="number"
            min="1"
            className="h-11 text-[15px]"
            value={c.sizeUsd}
            onChange={(e) => setC({ ...c, sizeUsd: n(e.target.value) })}
          />
        </div>
        <div>
          <div className={label}>Leverage</div>
          <Input
            type="number"
            min="1"
            max={c.risk.maxLeverage}
            className="h-11 text-[15px]"
            value={c.leverage}
            onChange={(e) => setC({ ...c, leverage: n(e.target.value) })}
          />
        </div>
      </div>

      <div>
        <div className={label}>Direction</div>
        <div className="grid grid-cols-3 gap-3">
          <Choice
            on={c.direction === 'alternate'}
            title="Both"
            sub="Long + short"
            onClick={() => setC({ ...c, direction: 'alternate' })}
          />
          <Choice
            on={c.direction === 'long'}
            title="Long"
            sub="Long only"
            onClick={() => setC({ ...c, direction: 'long' })}
          />
          <Choice
            on={c.direction === 'short'}
            title="Short"
            sub="Short only"
            onClick={() => setC({ ...c, direction: 'short' })}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        {(
          [
            ['Open', 'entry', entryTypes],
            ['Close', 'exit', exitTypes],
          ] as const
        ).map(([title, key, types]) => (
          <div key={key}>
            <div className={label}>{title}</div>
            <div className="grid grid-cols-2 gap-2.5">
              <Choice
                on={c[key] === 'limit'}
                title="Limit"
                sub="Maker · rests on book"
                disabled={!types.includes('limit')}
                onClick={() => setC({ ...c, [key]: 'limit' })}
              />
              <Choice
                on={c[key] === 'market'}
                title="Market"
                sub="Instant · taker"
                disabled={!types.includes('market')}
                onClick={() => setC({ ...c, [key]: 'market' })}
              />
            </div>
          </div>
        ))}
      </div>

      {presetNote && <div className="text-[12px] text-muted">{presetNote}</div>}

      <div>
        <button
          type="button"
          onClick={() => setAdvanced((v) => !v)}
          className="inline-flex items-center gap-1 text-[12px] text-text-2 hover:text-text"
          aria-expanded={advanced}
        >
          <ChevronDown className={cx('size-3.5 transition-transform', advanced && 'rotate-180')} />
          Advanced & risk limits
        </button>
        {advanced && (
          <div className="grid grid-cols-3 gap-3 mt-3">
            {
              <Field label="Network">
                <div className="grid grid-cols-2 gap-1.5">
                  {(['mainnet', 'testnet'] as const).map((nn) => (
                    <button
                      key={nn}
                      type="button"
                      aria-pressed={net === nn}
                      onClick={() => {
                        setFarmNet(platform, nn);
                        setNet(nn);
                      }}
                      className={cx(
                        'h-8 rounded-[var(--radius-sm)] border text-[12px] capitalize',
                        net === nn
                          ? 'border-accent bg-accent/15 text-text'
                          : 'border-line text-text-2 hover:text-text',
                      )}
                    >
                      {nn}
                    </button>
                  ))}
                </div>
              </Field>
            }
            <Field label="Re-quote after (bps)">
              <Input
                type="number"
                value={c.limitOffsetBps}
                onChange={(e) => setC({ ...c, limitOffsetBps: n(e.target.value) })}
              />
            </Field>
            <Field label="Hold position (s)">
              <Input
                type="number"
                value={c.holdSec}
                onChange={(e) => setC({ ...c, holdSec: n(e.target.value) })}
              />
            </Field>
            <Field label="New cycle every (s)">
              <Input
                type="number"
                value={c.intervalSec}
                onChange={(e) => setC({ ...c, intervalSec: n(e.target.value) })}
              />
            </Field>
            <Field label="Max notional $">
              <Input
                type="number"
                value={r.maxNotionalUsd}
                onChange={(e) => setC({ ...c, risk: { ...r, maxNotionalUsd: n(e.target.value) } })}
              />
            </Field>
            <Field label="Max leverage">
              <Input
                type="number"
                value={r.maxLeverage}
                onChange={(e) => setC({ ...c, risk: { ...r, maxLeverage: n(e.target.value) } })}
              />
            </Field>
            <Field label="Max daily loss $">
              <Input
                type="number"
                value={r.maxDailyLossUsd}
                onChange={(e) => setC({ ...c, risk: { ...r, maxDailyLossUsd: n(e.target.value) } })}
              />
            </Field>
            <Field label="Max open positions">
              <Input
                type="number"
                value={r.maxOpenPositions}
                onChange={(e) => setC({ ...c, risk: { ...r, maxOpenPositions: n(e.target.value) } })}
              />
            </Field>
            <Field label="Max concurrent orders">
              <Input
                type="number"
                value={r.maxConcurrentOrders}
                onChange={(e) => setC({ ...c, risk: { ...r, maxConcurrentOrders: n(e.target.value) } })}
              />
            </Field>
            <Field label="Max runtime (min)">
              <Input
                type="number"
                value={r.maxRuntimeMin}
                onChange={(e) => setC({ ...c, risk: { ...r, maxRuntimeMin: n(e.target.value) } })}
              />
            </Field>
          </div>
        )}
      </div>

      {violations.length > 0 && <Notice tone="down">{violations.join(' · ')}</Notice>}
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}

      <button
        type="button"
        onClick={() => start.mutate()}
        disabled={start.isPending || violations.length > 0}
        className="w-full h-12 rounded-[var(--radius)] bg-accent text-white text-[15px] font-semibold shadow-[0_6px_24px_-8px_var(--color-accent)] hover:brightness-110 active:brightness-95 disabled:opacity-50 transition"
      >
        {start.isPending ? 'Starting…' : row ? 'Save & restart' : 'Start Bot'}
      </button>

      <p className="text-[12px] text-muted leading-relaxed">
        Leverage auto-fills from a preset when one exists for the selected pair — Order Size always stays as
        you set it. Direction + Open/Close mode let you pick any combination — e.g. Both/Limit/Limit is the
        two-sided maker quoting; Long/Market/Limit opens longs instantly then rests a limit order to close
        each one; Both + Market alternates long/short each cycle since a single account can&apos;t be both at
        once.
      </p>
    </section>
  );
}
