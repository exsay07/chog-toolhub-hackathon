import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, KeyRound, Loader2, Wallet, Zap } from 'lucide-react';
import { PERPL_NETWORKS, type PerplNet, type PerpsTaskConfig } from '@chog/shared';
import { useAuth } from '../../lib/auth';
import {
  accountInfo,
  createExchangeAccount,
  enableForwarding,
  enrollKey,
  forgetKey,
  importPastedKey,
  loadKey,
} from '../../lib/perps/perpl';
import type { FarmSnapshot } from '../../lib/perps/perplFarmer';
import { forgetFarm, perplNet, startPerplFarm, stopFarm, useFarms } from '../../lib/perps/runner';
import { findProvider } from '../../lib/wallet/eip6963';
import { ask } from '../../components/Confirm';
import { Badge, Button, cx, ExtLink, Input, Modal, Notice, Stat } from '../../components/ui';

/**
 * Perpl launch checklist: exchange account (first deposit) → API key (one wallet signature, or
 * paste one) → start. One-Click Trading is offered once the bot sees it is off.
 */
export function PerplSetup({
  bot,
  onClose,
}: {
  bot: { id: string; cfg: PerpsTaskConfig } | null;
  onClose: () => void;
}) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const net: PerplNet = perplNet();
  const n = PERPL_NETWORKS[net];
  const address = me?.address ?? '';
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [deposit, setDeposit] = useState('');
  const [paste, setPaste] = useState(false);
  const [pKey, setPKey] = useState('');
  const [pSecret, setPSecret] = useState('');
  const [note, setNote] = useState('');

  const acct = useQuery({
    queryKey: ['perpl', 'account', net, address],
    queryFn: () => accountInfo(net, address),
    enabled: !!bot && !!address,
    refetchInterval: 15_000,
  });
  const key = useQuery({
    queryKey: ['perpl', 'key', net, address],
    queryFn: async () => (await loadKey(net, address)) ?? null,
    enabled: !!bot && !!address,
  });
  const a = acct.data;
  const hasAccount = !!a?.accountId;
  const hasKey = !!key.data;
  const margin = bot ? bot.cfg.sizeUsd / bot.cfg.leverage : 0;
  useEffect(() => {
    if (a && !deposit) setDeposit(String(Math.max(a.minDeposit, Math.ceil(margin * 1.5))));
  }, [a, deposit, margin]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setErr(null);
    setNote('');
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      const m = (e as { shortMessage?: string; message?: string }).shortMessage ?? (e as Error).message;
      setErr(/reject|denied|cancel/i.test(m) ? 'You declined the request in your wallet.' : m);
    } finally {
      setBusy(null);
      void qc.invalidateQueries({ queryKey: ['perpl'] });
    }
  };

  const start = () =>
    run('start', async () => {
      await startPerplFarm(bot!.id, bot!.cfg, address, net);
      onClose();
    });

  return (
    <Modal
      open={!!bot}
      onClose={onClose}
      title={`Start on Perpl ${net === 'testnet' ? 'testnet' : ''}`}
      width={560}
    >
      {bot && (
        <div className="space-y-3">
          <p className="text-[13px] text-text-2">
            The bot trades from your signed-in wallet{' '}
            <span className="num text-text">
              {address.slice(0, 6)}…{address.slice(-4)}
            </span>{' '}
            and runs in this tab — keep it open. It can place and cancel orders only; it can never withdraw.
          </p>

          <Step
            n={1}
            icon={<Wallet className="size-4" />}
            title="Perpl exchange account"
            done={hasAccount}
            loading={acct.isLoading}
          >
            {acct.isError ? (
              <Notice tone="down">Could not read your Perpl account: {(acct.error as Error).message}</Notice>
            ) : a && hasAccount ? (
              <div className="text-[12px] text-muted">Account #{String(a.accountId)} found.</div>
            ) : a ? (
              <div className="space-y-2">
                <div className="text-[12px] text-text-2">
                  Your first deposit opens the account (min {a.minDeposit} {a.collateralSymbol}). Wallet:{' '}
                  <span className="num">
                    {a.collateral.toFixed(2)} {a.collateralSymbol}
                  </span>{' '}
                  · <span className="num">{a.gas.toFixed(3)} MON</span> for gas.
                </div>
                <div className="flex gap-2">
                  <Input
                    type="number"
                    min={a.minDeposit}
                    value={deposit}
                    onChange={(e) => setDeposit(e.target.value)}
                    aria-label="Deposit amount"
                    className="w-32"
                  />
                  <Button
                    variant="primary"
                    loading={busy === 'deposit'}
                    disabled={!!busy || Number(deposit) < a.minDeposit || Number(deposit) > a.collateral}
                    onClick={() =>
                      run('deposit', async () =>
                        createExchangeAccount(
                          net,
                          address,
                          await findProvider(address),
                          Number(deposit),
                          setNote,
                        ),
                      )
                    }
                  >
                    Deposit &amp; open account
                  </Button>
                </div>
                {Number(deposit) > a.collateral && (
                  <div className="text-[12px] text-down">Not enough {a.collateralSymbol} in this wallet.</div>
                )}
              </div>
            ) : null}
          </Step>

          <Step
            n={2}
            icon={<KeyRound className="size-4" />}
            title="Trading key"
            done={hasKey}
            loading={key.isLoading}
          >
            {hasKey ? (
              <div className="flex items-center gap-2 text-[12px] text-muted">
                {key.data!.source === 'enrolled' ? 'Created' : 'Imported'}{' '}
                {new Date(key.data!.createdAt).toLocaleDateString('en-US')} · stored only in this browser.
                <button
                  className="ml-auto underline hover:text-text"
                  onClick={async () =>
                    (await ask('Forget this key on this device?', {
                      detail: `Running bots stop working. Revoke it for good at ${n.app}/apikeys.`,
                      confirmLabel: 'Forget key',
                    })) && run('forget', () => forgetKey(net, address))
                  }
                >
                  Forget
                </button>
              </div>
            ) : paste ? (
              <div className="space-y-2">
                <div className="text-[12px] text-text-2">
                  Create a key with <b>Trade</b> scope at{' '}
                  <ExtLink href={`${n.app}/apikeys`}>{n.app.replace('https://', '')}/apikeys</ExtLink> and
                  paste both parts. Never paste a seed phrase.
                </div>
                <Input placeholder="API key token" value={pKey} onChange={(e) => setPKey(e.target.value)} />
                <Input
                  placeholder="API private key (64 hex characters)"
                  type="password"
                  autoComplete="off"
                  value={pSecret}
                  onChange={(e) => setPSecret(e.target.value)}
                />
                <div className="flex gap-2">
                  <Button
                    variant="primary"
                    loading={busy === 'paste'}
                    disabled={!!busy}
                    onClick={() =>
                      run('paste', async () => {
                        await importPastedKey(net, address, pKey, pSecret);
                        setPSecret('');
                        setPKey('');
                      })
                    }
                  >
                    Save key
                  </Button>
                  <Button variant="ghost" onClick={() => setPaste(false)}>
                    Back
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="text-[12px] text-text-2">
                  One signature in your wallet creates a key that can trade but never withdraw. The private
                  part is generated and locked inside this browser.
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="primary"
                    loading={busy === 'enroll'}
                    disabled={!!busy || !hasAccount}
                    onClick={() =>
                      run('enroll', async () => enrollKey(net, address, await findProvider(address)))
                    }
                  >
                    Create key (1 signature)
                  </Button>
                  <Button variant="ghost" onClick={() => setPaste(true)}>
                    Paste a key instead
                  </Button>
                </div>
              </div>
            )}
          </Step>

          <Step n={3} icon={<Zap className="size-4" />} title="Start" done={false}>
            <div className="text-[12px] text-text-2">
              {bot.cfg.pair} · ${bot.cfg.sizeUsd} @ {bot.cfg.leverage}x · needs about ${margin.toFixed(2)}{' '}
              free margin on Perpl.
            </div>
          </Step>

          {note && busy && <div className="text-[12px] text-muted">{note}</div>}
          {err && <Notice tone="down">{err}</Notice>}
          <Button
            variant="primary"
            size="lg"
            className="w-full"
            disabled={!hasAccount || !hasKey || !!busy}
            loading={busy === 'start'}
            onClick={start}
          >
            Start bot
          </Button>
        </div>
      )}
    </Modal>
  );
}

export function Step({
  n,
  icon,
  title,
  done,
  loading,
  children,
}: {
  n: number;
  icon: React.ReactNode;
  title: string;
  done: boolean;
  loading?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cx(
        'rounded-[var(--radius)] border p-3',
        done ? 'border-up/30 bg-up/5' : 'border-line bg-surface-2/50',
      )}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span
          className={cx(
            'size-6 rounded-full grid place-items-center text-[11px] num',
            done ? 'bg-up text-white' : 'border border-line-strong text-text-2',
          )}
        >
          {done ? <Check className="size-3.5" /> : n}
        </span>
        <span className="text-muted">{icon}</span>
        <span className="text-[13px] font-semibold">{title}</span>
        {loading && <Loader2 className="size-3.5 animate-spin text-muted ml-auto" />}
      </div>
      {children}
    </div>
  );
}

const STATE_LABEL: Record<FarmSnapshot['state'], string> = {
  connecting: 'connecting',
  'needs-forwarding': 'needs One-Click Trading',
  idle: 'waiting',
  opening: 'opening',
  holding: 'holding',
  closing: 'closing',
  stopping: 'stopping',
  stopped: 'stopped',
  error: 'error',
};
const usd = (v: number) =>
  `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
const ago = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60
    ? `${s}s`
    : s < 3600
      ? `${Math.floor(s / 60)}m ${s % 60}s`
      : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};

/** Live view of a bot running in this tab. */
export function FarmCard({ id }: { id: string }) {
  const farms = useFarms();
  const { me } = useAuth();
  const f = farms.get(id);
  const [logs, setLogs] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  if (!f) return null;
  const s = f.state;
  const live = !['stopped', 'error'].includes(s.state);
  const tone =
    s.state === 'error' ? 'down' : !live ? 'neutral' : s.state === 'needs-forwarding' ? 'warn' : 'up';

  const enable = async () => {
    setBusy(true);
    setErr(null);
    try {
      await enableForwarding(perplNet(), me!.address, await findProvider(me!.address));
      f.recheck();
    } catch (e) {
      const m = (e as { shortMessage?: string }).shortMessage ?? (e as Error).message;
      setErr(/reject|denied/i.test(m) ? 'You declined the transaction.' : m);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 rounded-[var(--radius-sm)] border border-line bg-bg/60 p-2.5 space-y-2.5">
      <div className="flex items-center gap-2">
        <Badge tone={tone}>{STATE_LABEL[s.state]}</Badge>
        {live && s.state !== 'needs-forwarding' && (
          <span className="text-[12px] text-muted">
            {s.state === 'idle' && s.nextAt
              ? `next ${s.side} in ${ago(s.nextAt - Date.now())}`
              : `${s.side} · cycle ${s.cycles + 1}`}
          </span>
        )}
        <span className="ml-auto text-[11px] text-muted num">up {ago(Date.now() - s.startedAt)}</span>
      </div>
      <div className="grid grid-cols-4 gap-3">
        <Stat
          label="Volume"
          value={usd(s.volumeUsd)}
          sub={s.volumeUsd ? `${Math.round((s.makerVolumeUsd / s.volumeUsd) * 100)}% maker` : undefined}
        />
        <Stat label="Fees" value={usd(s.feesUsd)} />
        <Stat
          label="PnL (net)"
          value={usd(s.pnlUsd)}
          tone={s.pnlUsd > 0.005 ? 'up' : s.pnlUsd < -0.005 ? 'down' : undefined}
        />
        <Stat
          label="Cycles"
          value={s.cycles}
          sub={s.availableUsd !== null ? `free ${usd(s.availableUsd)}` : undefined}
        />
      </div>
      {s.position && (
        <div className="text-[12px] text-text-2 num">
          Position:{' '}
          <span className={s.position.side === 'long' ? 'text-up' : 'text-down'}>{s.position.side}</span>{' '}
          {usd(s.position.sizeUsd)} @ {s.position.entry.toLocaleString('en-US')}
          {s.mid !== null && <span className="text-muted"> · mid {s.mid.toLocaleString('en-US')}</span>}
        </div>
      )}
      {s.state === 'needs-forwarding' && (
        <Notice tone="warn">
          Perpl only accepts bot orders after you turn on <b>One-Click Trading</b> for your account (one
          transaction, revocable any time).{' '}
          <Button size="sm" variant="primary" loading={busy} onClick={enable} className="ml-1">
            Enable One-Click Trading
          </Button>
        </Notice>
      )}
      {(s.error || s.stopReason) && !live && (
        <div className={cx('text-[12px]', s.error ? 'text-down' : 'text-muted')}>
          {s.error ?? s.stopReason}
        </div>
      )}
      {err && <div className="text-[12px] text-down">{err}</div>}
      <div className="flex gap-1">
        {live ? (
          <Button size="sm" variant="danger" disabled={s.state === 'stopping'} onClick={() => stopFarm(id)}>
            {s.state === 'stopping' ? 'Stopping…' : 'Stop & close'}
          </Button>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => forgetFarm(id)}>
            Dismiss
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => setLogs((v) => !v)}>
          {logs ? 'Hide log' : 'Log'}
        </Button>
      </div>
      {logs && (
        <div className="max-h-56 overflow-auto rounded-[var(--radius-sm)] border border-line bg-bg p-2 num text-[11px] leading-relaxed">
          {f.logs
            .slice()
            .reverse()
            .map((l, i) => (
              <div
                key={i}
                className={
                  l.level === 'error' ? 'text-down' : l.level === 'warn' ? 'text-warn' : 'text-text-2'
                }
              >
                <span className="text-muted">{new Date(l.t).toLocaleTimeString('en-GB')}</span> {l.msg}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
