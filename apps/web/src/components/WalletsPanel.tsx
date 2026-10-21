import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatEther } from 'viem';
import { NETWORKS, NETWORK_IDS, fmtNum, shortAddress, type NetworkId } from '@chog/shared';
import { put } from '../lib/api';
import { useVault } from '../lib/vault/useVault';
import {
  addExtraWallets,
  MAX_EXTRA_WALLETS,
  removeExtraWallet,
  walletsOf,
  type EvmWallet,
} from '../lib/vault/vault';
import { fundWallets, sweepToMain, type TransferResult } from '../lib/vault/distribute';
import { publicClient } from '../lib/trade/evm';
import { ask } from './Confirm';
import { Button, Copy, ExtLink, Field, Input, Notice, Select } from './ui';

const EVM = NETWORK_IDS.filter(
  (n) => NETWORKS[n].kind === 'evm' && NETWORKS[n].tradingStatus !== 'data-only',
);

/** Tells the server the public addresses of the extra wallets (so their trades count in Portfolio). */
export async function registerExtras(list: EvmWallet[]) {
  await put('/api/trading-wallets/extra', {
    evm: list.filter((w) => !w.primary).map((w) => ({ address: w.address, label: w.label })),
  });
}

/**
 * Multi-wallet: extra EVM wallets in the same encrypted vault, used by the NFT Sniper, Token Sniper
 * and the terminal's wallet switch. Fund them from Main and sweep back in one go.
 */
export function WalletsPanel() {
  const { vault } = useVault();
  const wallets = walletsOf(vault);
  const [net, setNet] = useState<NetworkId>('monad');
  const [pw, setPw] = useState('');
  const [count, setCount] = useState('1');
  const [label, setLabel] = useState('');
  const [importKey, setImportKey] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'info' | 'down'; text: string } | null>(null);
  const [results, setResults] = useState<TransferResult[] | null>(null);
  const n = NETWORKS[net];

  const bal = useQuery({
    queryKey: ['wallet-balances', net, wallets.map((w) => w.address).join(',')],
    queryFn: async () =>
      Object.fromEntries(
        await Promise.all(
          wallets.map(async (w) => [
            w.address,
            await publicClient(net)
              .getBalance({ address: w.address })
              .then((b) => Number(formatEther(b)))
              .catch(() => null),
          ]),
        ),
      ) as Record<string, number | null>,
    refetchInterval: 20_000,
  });

  const run = async (tag: string, fn: () => Promise<string | void>) => {
    setBusy(tag);
    setMsg(null);
    try {
      const text = await fn();
      if (text) setMsg({ tone: 'info', text });
    } catch (e) {
      setMsg({ tone: 'down', text: (e as Error).message.split('\n')[0]! });
    } finally {
      setBusy(null);
    }
  };

  const add = (opts: { count?: number; importKey?: string; label?: string }) =>
    run(opts.importKey ? 'import' : 'add', async () => {
      if (!pw) throw new Error('Enter your vault password first');
      const list = await addExtraWallets(pw, opts);
      await registerExtras(list);
      setImportKey('');
      return `Now ${list.length} wallets. Back up the new keys (Export private keys).`;
    });

  const remove = (w: EvmWallet) =>
    run(`rm:${w.address}`, async () => {
      if (!pw) throw new Error('Enter your vault password first');
      const b = bal.data?.[w.address];
      const ok = await ask(
        `Remove ${w.label} (${shortAddress(w.address)}) from this vault?${
          b
            ? ` It still holds ${fmtNum(b, 5)} ${n.nativeSymbol} on ${n.name} — sweep first or export its key.`
            : ''
        }`,
        { confirmLabel: 'Remove' },
      );
      if (!ok) return;
      const list = await removeExtraWallet(pw, w.address);
      await registerExtras(list);
      return `${w.label} removed.`;
    });

  const extras = wallets.filter((w) => !w.primary);
  const report = (r: TransferResult[]) => {
    setResults(r);
    const ok = r.filter((x) => x.ok && x.hash).length;
    setTimeout(() => void bal.refetch(), 5_000);
    return `${ok} transfer(s) sent on ${n.name}${r.some((x) => !x.ok) ? ' · some failed (see below)' : ''}.`;
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] text-muted">
          {wallets.length} wallet{wallets.length === 1 ? '' : 's'} · balances on
        </span>
        <Select value={net} onChange={(e) => setNet(e.target.value as NetworkId)} aria-label="Network">
          {EVM.map((id) => (
            <option key={id} value={id}>
              {NETWORKS[id].name}
            </option>
          ))}
        </Select>
      </div>
      <div className="border border-line rounded-[var(--radius-sm)] divide-y divide-line/60 text-[12px] max-h-[220px] overflow-auto">
        {wallets.map((w) => (
          <div key={w.address} className="flex items-center gap-2 px-2.5 py-1.5">
            <span className="w-14 shrink-0 font-medium truncate">{w.label}</span>
            <span className="num text-text-2 flex-1 min-w-0 truncate">{shortAddress(w.address, 6)}</span>
            <Copy text={w.address} />
            <span className="num w-24 text-right">
              {bal.data?.[w.address] == null ? '—' : fmtNum(bal.data[w.address]!, 5)}{' '}
              <span className="text-muted">{n.nativeSymbol}</span>
            </span>
            {!w.primary && (
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Remove ${w.label}`}
                loading={busy === `rm:${w.address}`}
                onClick={() => void remove(w)}
              >
                ×
              </Button>
            )}
          </div>
        ))}
      </div>

      <Field label="Vault password" hint="Needed to add or remove wallets (keys are re-encrypted here).">
        <Input
          type="password"
          autoComplete="current-password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
        />
      </Field>
      <div className="flex items-end gap-2">
        <Field label="New wallets">
          <Select value={count} onChange={(e) => setCount(e.target.value)} aria-label="How many">
            {[1, 2, 3, 5, 10].map((c) => (
              <option key={c} value={c} disabled={extras.length + c > MAX_EXTRA_WALLETS}>
                {c}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Label (optional)">
          <Input value={label} placeholder="e.g. Mint" onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Button
          loading={busy === 'add'}
          disabled={extras.length >= MAX_EXTRA_WALLETS}
          onClick={() => void add({ count: Number(count), label })}
        >
          Add
        </Button>
      </div>
      <div className="flex items-end gap-2">
        <Field label="Import an EVM private key">
          <Input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={importKey}
            onChange={(e) => setImportKey(e.target.value)}
          />
        </Field>
        <Button
          loading={busy === 'import'}
          disabled={!importKey}
          onClick={() => void add({ importKey, label })}
        >
          Import
        </Button>
      </div>

      {extras.length > 0 && (
        <div className="flex items-end gap-2">
          <Field label={`Fund each extra wallet (${n.nativeSymbol})`}>
            <Input
              type="number"
              min="0"
              step="any"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </Field>
          <Button
            loading={busy === 'fund'}
            disabled={!(Number(amount) > 0)}
            onClick={() =>
              void run('fund', async () => {
                const ok = await ask(
                  `Send ${amount} ${n.nativeSymbol} from Main to each of ${extras.length} wallets on ${n.name}?`,
                  { confirmLabel: 'Send' },
                );
                if (!ok) return;
                return report(
                  await fundWallets(
                    net,
                    extras.map((w) => w.address),
                    amount,
                  ),
                );
              })
            }
          >
            Fund all
          </Button>
          <Button
            loading={busy === 'sweep'}
            onClick={() =>
              void run('sweep', async () => {
                const ok = await ask(
                  `Send the ${n.nativeSymbol} of all ${extras.length} extra wallets back to Main on ${n.name}? A small gas reserve stays behind.`,
                  { confirmLabel: 'Sweep' },
                );
                if (!ok) return;
                return report(
                  await sweepToMain(
                    net,
                    extras.map((w) => w.address),
                  ),
                );
              })
            }
          >
            Sweep to Main
          </Button>
        </div>
      )}
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      {results && (
        <ul className="text-[11px] space-y-0.5">
          {results.map((r) => (
            <li key={r.wallet} className={r.ok ? 'text-text-2' : 'text-down'}>
              {wallets.find((w) => w.address === r.wallet)?.label ?? shortAddress(r.wallet)}:{' '}
              {r.hash ? (
                <ExtLink href={n.explorer.tx(r.hash)}>
                  {r.amount} {n.nativeSymbol} ↗
                </ExtLink>
              ) : (
                (r.error ?? 'skipped')
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="text-[11px] text-muted">
        Extra wallets live in the same encrypted vault and are only used where you pick them (NFT Sniper,
        Token Sniper, the terminal’s wallet switch). Up to {MAX_EXTRA_WALLETS}. Solana always uses the main
        wallet.
      </p>
    </div>
  );
}
