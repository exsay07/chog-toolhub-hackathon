import { useEffect, useState, type ReactNode } from 'react';
import { setSmoothScrollEnabled, smoothScrollEnabled } from '../lib/smoothScroll';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  applyCustomBackground,
  BG_TYPES,
  clearCustomBackground,
  saveCustomBackground,
} from '../lib/background';
import {
  NETWORKS,
  NETWORK_IDS,
  shortAddress,
  zSettings,
  type NetworkId,
  type Settings as S,
} from '@chog/shared';
import { get, post } from '../lib/api';
import { useSettings } from '../lib/settings';
import { useAuth } from '../lib/auth';
import { useAgent } from '../lib/agent';
import { useVault } from '../lib/vault/useVault';
import { useKillSwitch } from '../components/Shell';
import { killSwitch } from '../lib/trade/engine';
import { setSfxEnabled, sfxChannel, sfxEnabled, sfxTab } from '../lib/sfx';
import { Badge, Button, cx, Field, Input, Notice, Panel, Select, Toggle } from '../components/ui';

const SECTIONS = ['Appearance', 'Trading', 'Notifications', 'Risk limits', 'Privacy & security'] as const;
type Section = (typeof SECTIONS)[number];

export default function Settings() {
  const [sec, setSec] = useState<Section>('Appearance');
  const [sounds, setSounds] = useState(sfxEnabled);
  const [smooth, setSmooth] = useState(smoothScrollEnabled);
  const { settings, update } = useSettings();
  const [draft, setDraft] = useState<S>(settings);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => setDraft(settings), [settings]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);

  const save = async () => {
    const p = zSettings.safeParse(draft);
    if (!p.success) return setErr(p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    setErr(null);
    try {
      await update(() => p.data);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const set = <K extends keyof S>(k: K, v: Partial<S[K]>) =>
    setDraft((d) => ({ ...d, [k]: { ...(d[k] as object), ...v } }));
  const num = (v: string) => (v === '' ? 0 : Number(v));

  return (
    <div className="p-4 grid grid-cols-[200px_1fr] gap-4 max-w-6xl">
      <nav className="space-y-0.5">
        {SECTIONS.map((s) => (
          <button
            key={s}
            onClick={() => setSec(s)}
            className={cx(
              'w-full text-left h-8 px-3 rounded-[var(--radius-sm)] font-display font-semibold',
              sec === s ? 'bg-surface-2 text-text' : 'text-muted hover:text-text',
            )}
          >
            {s}
          </button>
        ))}
      </nav>
      <Panel
        title={sec}
        actions={
          sec !== 'Privacy & security' && (
            <>
              {saved && <span className="text-up text-xs">Saved</span>}
              <Button size="sm" disabled={!dirty} onClick={() => setDraft(settings)}>
                Reset
              </Button>
              <Button size="sm" variant="primary" disabled={!dirty} onClick={() => void save()}>
                Save
              </Button>
            </>
          )
        }
      >
        {err && <Notice tone="down">{err}</Notice>}
        {sec === 'Appearance' && (
          <Grid>
            <Field label="Theme">
              <Select
                value={draft.appearance.theme}
                onChange={(e) => set('appearance', { theme: e.target.value as S['appearance']['theme'] })}
              >
                <option value="dark">Dark</option>
                <option value="light">Light</option>
                <option value="system">System</option>
              </Select>
            </Field>
            <Field label="Accent">
              <div className="flex gap-1.5 pt-1">
                {(['pink', 'blue', 'violet', 'lime', 'cyan', 'amber'] as const).map((a) => (
                  <button
                    key={a}
                    onClick={() => set('appearance', { accent: a })}
                    className={cx(
                      'size-7 rounded-full border-2',
                      draft.appearance.accent === a ? 'border-text' : 'border-transparent',
                    )}
                    style={{
                      background: {
                        pink: '#ff3e9a',
                        blue: '#0a84ff',
                        violet: '#8e5cf7',
                        lime: '#30c759',
                        cyan: '#32ade6',
                        amber: '#ff9f0a',
                      }[a],
                    }}
                    aria-label={a}
                  />
                ))}
              </div>
            </Field>
            <Field label="Reduce motion">
              <Select
                value={draft.appearance.reducedMotion}
                onChange={(e) =>
                  set('appearance', { reducedMotion: e.target.value as S['appearance']['reducedMotion'] })
                }
              >
                <option value="system">Follow system</option>
                <option value="on">Always reduce</option>
                <option value="off">Never reduce</option>
              </Select>
            </Field>
            <Field
              label="Interface sounds"
              hint="Soft clicks on tabs and the TV sounds on sign-in / sign-out. Saved on this device."
            >
              <div className="flex items-center gap-3 pt-1">
                <Toggle
                  checked={sounds}
                  onChange={(v) => {
                    setSfxEnabled(v);
                    setSounds(v);
                    if (v) sfxTab();
                  }}
                  label={sounds ? 'On' : 'Off'}
                />
                <Button size="sm" variant="ghost" disabled={!sounds} onClick={() => sfxChannel()}>
                  Preview
                </Button>
              </div>
            </Field>
            <Field
              label="Smooth scrolling"
              hint="The mouse wheel glides instead of jumping (touchpads stay native). Saved on this device."
            >
              <div className="pt-1">
                <Toggle
                  checked={smooth}
                  onChange={(v) => {
                    setSmoothScrollEnabled(v);
                    setSmooth(v);
                  }}
                  label={smooth ? 'On' : 'Off'}
                />
              </div>
            </Field>
            <Field label="Density">
              <Select
                value={draft.appearance.density}
                onChange={(e) => set('appearance', { density: e.target.value as S['appearance']['density'] })}
              >
                <option value="compact">Compact</option>
                <option value="comfortable">Comfortable</option>
              </Select>
            </Field>
            <Field label="Background">
              <Select
                value={draft.appearance.background}
                onChange={(e) =>
                  set('appearance', { background: e.target.value as S['appearance']['background'] })
                }
              >
                <option value="none">Plain</option>
                <option value="grid">Wallpaper</option>
                <option value="chog">Custom image (this device)</option>
              </Select>
            </Field>
            {draft.appearance.background === 'chog' && <CustomBackground />}
          </Grid>
        )}
        {sec === 'Trading' && (
          <div className="space-y-4">
            <Grid>
              <Field label="Default network">
                <Select
                  value={draft.trading.defaultNetwork}
                  onChange={(e) => set('trading', { defaultNetwork: e.target.value as NetworkId })}
                >
                  {NETWORK_IDS.map((n) => (
                    <option key={n} value={n}>
                      {NETWORKS[n].name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Quick-buy slippage (bps)" hint="100 bps = 1% · Discover / Pulse ⚡ buttons">
                <Input
                  type="number"
                  value={draft.trading.defaultSlippageBps}
                  onChange={(e) => set('trading', { defaultSlippageBps: num(e.target.value) })}
                />
              </Field>
              <Field label="Priority fee" hint="Applies on networks that support it">
                <Select
                  value={draft.trading.priorityFee}
                  onChange={(e) =>
                    set('trading', { priorityFee: e.target.value as S['trading']['priorityFee'] })
                  }
                >
                  <option value="none">Default</option>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </Select>
              </Field>
            </Grid>
            <Toggle
              checked={draft.trading.confirmEveryTrade}
              onChange={(v) => set('trading', { confirmEveryTrade: v })}
              label="Always show a confirmation before manual trades"
            />
            <p className="text-[12px] text-muted">
              Off = instant trade: one-click buttons send at once unless the risk check warns. Trade presets
              (P1/P2/P3: buy amounts, sell %, slippage, priority, hotkeys, auto TP/SL) are edited in the Token
              Terminal, next to the Buy / Sell panel.
            </p>
          </div>
        )}
        {sec === 'Notifications' && (
          <div className="space-y-3">
            {(
              [
                ['tracker', 'Wallet tracker alerts'],
                ['execution', 'Trade execution alerts'],
                ['failed', 'Failed transaction alerts'],
                ['sniper', 'Sniper events'],
                ['perps', 'Perps Farm events'],
                ['sound', 'Sound'],
              ] as const
            ).map(([k, l]) => (
              <div key={k}>
                <Toggle
                  checked={draft.notifications[k]}
                  onChange={(v) => set('notifications', { [k]: v })}
                  label={l}
                />
              </div>
            ))}
            <Grid>
              <Field label="Duration (seconds)">
                <Input
                  type="number"
                  value={draft.notifications.durationSec}
                  onChange={(e) => set('notifications', { durationSec: num(e.target.value) })}
                />
              </Field>
              <Field label="Position">
                <Select
                  value={draft.notifications.position}
                  onChange={(e) =>
                    set('notifications', { position: e.target.value as S['notifications']['position'] })
                  }
                >
                  <option value="top-right">Top right</option>
                  <option value="bottom-right">Bottom right</option>
                  <option value="bottom-left">Bottom left</option>
                </Select>
              </Field>
              <Field label="Time zone (PnL day boundaries)">
                <Input
                  value={draft.timeZone}
                  onChange={(e) => setDraft({ ...draft, timeZone: e.target.value })}
                />
              </Field>
            </Grid>
          </div>
        )}
        {sec === 'Risk limits' && (
          <div className="space-y-3">
            <Notice tone="info">
              These limits gate every trade (manual and automated). Automated trades are blocked when a limit
              cannot be enforced (e.g. unknown USD value).
            </Notice>
            <Grid>
              <Field label="Max per trade (USD)">
                <Input
                  type="number"
                  value={draft.risk.maxTradeUsd}
                  onChange={(e) => set('risk', { maxTradeUsd: num(e.target.value) })}
                />
              </Field>
              <Field label="Max automated buys / 24h (USD)">
                <Input
                  type="number"
                  value={draft.risk.maxDailyExposureUsd}
                  onChange={(e) => set('risk', { maxDailyExposureUsd: num(e.target.value) })}
                />
              </Field>
              <Field label="Max slippage (bps)">
                <Input
                  type="number"
                  value={draft.risk.maxSlippageBps}
                  onChange={(e) => set('risk', { maxSlippageBps: num(e.target.value) })}
                />
              </Field>
              <Field label="Max price impact (%)">
                <Input
                  type="number"
                  value={draft.risk.maxPriceImpactPct}
                  onChange={(e) => set('risk', { maxPriceImpactPct: num(e.target.value) })}
                />
              </Field>
              <Field label="Min liquidity (USD)">
                <Input
                  type="number"
                  value={draft.risk.minLiquidityUsd}
                  onChange={(e) => set('risk', { minLiquidityUsd: num(e.target.value) })}
                />
              </Field>
              <Field label="Automation cooldown per token (s)">
                <Input
                  type="number"
                  value={draft.risk.cooldownSec}
                  onChange={(e) => set('risk', { cooldownSec: num(e.target.value) })}
                />
              </Field>
            </Grid>
            <Field label="Networks allowed for trading">
              <div className="flex flex-wrap gap-3 pt-1">
                {NETWORK_IDS.map((n) => (
                  <label key={n} className="flex items-center gap-1.5 text-sm">
                    <input
                      type="checkbox"
                      checked={draft.risk.allowNetworks.includes(n)}
                      disabled={NETWORKS[n].tradingStatus === 'data-only'}
                      onChange={(e) =>
                        set('risk', {
                          allowNetworks: e.target.checked
                            ? [...draft.risk.allowNetworks, n]
                            : draft.risk.allowNetworks.filter((x) => x !== n),
                        })
                      }
                    />
                    {NETWORKS[n].name}
                    {NETWORKS[n].tradingStatus === 'data-only' && (
                      <span className="text-muted text-xs">(data only)</span>
                    )}
                  </label>
                ))}
              </div>
            </Field>
            <Field label="Blocked tokens (network:address, comma separated)">
              <Input
                value={draft.risk.blockTokens.join(',')}
                onChange={(e) =>
                  set('risk', {
                    blockTokens: e.target.value
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
              />
            </Field>
          </div>
        )}
        {sec === 'Privacy & security' && <Security />}
      </Panel>
    </div>
  );
}

const Grid = ({ children }: { children: ReactNode }) => (
  <div className="grid grid-cols-3 gap-3 max-w-3xl">{children}</div>
);

function CustomBackground() {
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <Field label="Image (PNG/JPEG/WEBP, ≤ 2 MB, stored only on this device)" error={msg}>
      <div className="flex gap-2">
        <input
          type="file"
          accept={BG_TYPES.join(',')}
          className="text-xs"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            saveCustomBackground(f)
              .then(() => (setMsg(null), applyCustomBackground(true)))
              .catch((x: Error) => setMsg(x.message));
          }}
        />
        <Button
          size="sm"
          onClick={() => void clearCustomBackground().then(() => applyCustomBackground(false))}
        >
          Clear
        </Button>
      </div>
    </Field>
  );
}

function Security() {
  const qc = useQueryClient();
  const { me, signOut } = useAuth();
  const agent = useAgent();
  const { vault, unlocked } = useVault();
  const killed = useKillSwitch();
  const sessions = useQuery({
    queryKey: ['sessions'],
    queryFn: () =>
      get<
        Array<{
          id: string;
          createdAt: string;
          lastSeenAt: string | null;
          userAgent: string | null;
          current: boolean;
        }>
      >('/api/auth/sessions'),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => post(`/api/auth/sessions/${id}/revoke`),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['sessions'] }),
  });
  const revokeOthers = useMutation({
    mutationFn: () => post('/api/auth/sessions/revoke-others'),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['sessions'] }),
  });
  return (
    <div className="space-y-5 max-w-3xl">
      <section>
        <h3 className="font-display font-semibold mb-1">Connected wallet (access)</h3>
        <div className="text-sm num">{me?.address}</div>
        <div className="text-xs text-muted">
          {me?.accessBasis === 'holder'
            ? `Holds ${me.session.nftBalance} Chog Genesis — re-verified on-chain every few minutes. If you sell or transfer it, access ends at the next check.`
            : me?.accessBasis === 'judge'
              ? 'Judge access (reviewer pass): no NFT required while the pass is open.'
              : 'Development allowlist access.'}
        </div>
        <Button size="sm" className="mt-2" onClick={() => void signOut()}>
          Sign out
        </Button>
      </section>
      <section>
        <div className="flex items-center justify-between mb-1">
          <h3 className="font-display font-semibold">Active sessions</h3>
          <Button size="sm" onClick={() => revokeOthers.mutate()}>
            Sign out other sessions
          </Button>
        </div>
        <ul className="text-xs divide-y divide-line border border-line rounded-[var(--radius-sm)]">
          {(sessions.data ?? []).map((s) => (
            <li key={s.id} className="flex items-center gap-3 px-3 py-2">
              <span className="truncate flex-1 text-text-2" title={s.userAgent ?? ''}>
                {s.userAgent?.slice(0, 70) ?? 'unknown device'}
              </span>
              <span className="text-muted">
                last seen {s.lastSeenAt ? new Date(s.lastSeenAt).toLocaleString() : '—'}
              </span>
              {s.current ? (
                <Badge tone="up">this session</Badge>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => revoke.mutate(s.id)}>
                  Revoke
                </Button>
              )}
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h3 className="font-display font-semibold mb-1">Trading wallet</h3>
        <div className="text-xs text-muted">
          {vault ? (
            <>
              Local vault · EVM {shortAddress(vault.evmAddress, 6)} · SOL{' '}
              {shortAddress(vault.solanaAddress, 6)} ·{' '}
              {unlocked ? <span className="text-up">unlocked</span> : 'locked'}
            </>
          ) : (
            'Not set up on this device.'
          )}
        </div>
      </section>
      <section>
        <h3 className="font-display font-semibold mb-1">Local agent</h3>
        <div className="text-xs text-muted">
          Status: {agent.status}
          {agent.version && ` · v${agent.version} · ${agent.mode} mode`}
        </div>
      </section>
      <section>
        <h3 className="font-display font-semibold mb-1">Automation permissions</h3>
        <p className="text-xs text-muted mb-2">
          Automations only run from an open tab with your vault unlocked (or from the paired local agent for
          Perps Farm). Signing in never grants spending permission.
        </p>
        <Button
          variant={killed ? 'secondary' : 'danger'}
          onClick={() =>
            killed
              ? killSwitch.set(false)
              : void post('/api/automations/emergency-stop').finally(() => killSwitch.set(true))
          }
        >
          {killed ? 'Release emergency stop' : 'Emergency stop all automation'}
        </Button>
      </section>
      <Notice tone="warn">
        <b>Security reminders.</b> Chog Toolhub will never ask for your seed phrase. Only sign messages you
        understand. Browser extensions with “read and change all data” permission can see this page — use a
        dedicated browser profile for trading. Keep only trading funds in the trading wallet.
      </Notice>
    </div>
  );
}
