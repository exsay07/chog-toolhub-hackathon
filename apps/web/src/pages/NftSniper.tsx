import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatEther } from 'viem';
import { NETWORKS, NETWORK_IDS, shortAddress, zMintTask, type MintTask, type NetworkId } from '@chog/shared';
import { del, get, patch, post, put } from '../lib/api';
import { publicClient } from '../lib/trade/evm';
import { simulateMint } from '../lib/automation/mint';
import { fetchMints, type MintRow } from '../lib/mints';
import { WalletPicker } from '../components/WalletPicker';
import {
  describeDetection,
  detectMint,
  parseMintTarget,
  type MintCandidate,
  type MintDetection,
} from '../lib/nft/detect';
import { useVault } from '../lib/vault/useVault';
import {
  Badge,
  Button,
  cx,
  Empty,
  ErrorState,
  ExtLink,
  Field,
  Input,
  Modal,
  NetworkBadge,
  Notice,
  Panel,
  Select,
  SkeletonRows,
} from '../components/ui';
import { Icon } from '../components/Icon';
import { ask } from '../components/Confirm';
import { DateTimePicker } from '../components/DateTimePicker';

const EVM_NETS = NETWORK_IDS.filter((n) => NETWORKS[n].kind === 'evm');

const DEFAULT: MintTask = {
  name: 'Public mint',
  network: 'monad',
  address: '',
  functionSignature: 'mint(uint256)',
  args: ['{quantity}'],
  quantity: 1,
  unitPriceNative: 0,
  maxTotalSpendNative: 0,
  startAt: null,
  maxAttempts: 3,
  priorityFee: 'medium',
  wallets: [],
};

export default function NftSniper() {
  const qc = useQueryClient();
  const { unlocked } = useVault();
  const list = useQuery({
    queryKey: ['automations', 'mint'],
    queryFn: fetchMints,
    refetchInterval: 10_000,
  });
  const logs = useQuery({
    queryKey: ['logs', 'mint'],
    queryFn: () =>
      get<Array<{ id: number; level: string; message: string; at: string }>>(
        '/api/automation-logs?kind=mint',
      ),
    refetchInterval: 8_000,
  });
  // Mint Tracker links here with ?network=…&address=…&name=… to start a task for that contract.
  const [params, setParams] = useSearchParams();
  const [prefill] = useState<Partial<MintTask> | null>(() => {
    const network = params.get('network') as NetworkId | null;
    const address = params.get('address') ?? '';
    if (!network || !EVM_NETS.includes(network) || !/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
    return { network, address, name: (params.get('name') ?? '').slice(0, 60) || DEFAULT.name };
  });
  const [edit, setEdit] = useState<MintRow | 'new' | null>(prefill ? 'new' : null);
  const status = useMutation({
    mutationFn: ({ id, s }: { id: string; s: string }) =>
      patch(`/api/automations/mint/${id}/status`, { status: s }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['automations', 'mint'] }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => del(`/api/automations/mint/${id}`),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['automations', 'mint'] }),
  });

  return (
    <div className="h-full grid grid-cols-[1fr_420px] gap-3 p-4 min-h-0">
      <Panel
        title="Mint tasks"
        dense
        actions={
          <Button size="sm" variant="primary" onClick={() => setEdit('new')}>
            <Icon name="plus" size={13} /> New mint
          </Button>
        }
      >
        <div className="p-3 border-b border-line">
          <Notice tone="info">
            Public mints only. Each collection’s own contract and mint function are used as-is — allowlists,
            signatures and per-wallet limits are respected, never bypassed. Before the start time the task
            only simulates; it submits once simulation passes. Inclusion is not guaranteed.
          </Notice>
        </div>
        {list.isLoading ? (
          <SkeletonRows />
        ) : list.isError ? (
          <ErrorState error={list.error} />
        ) : (list.data?.length ?? 0) === 0 ? (
          <Empty title="No mint tasks">Configure a collection’s public mint to schedule it.</Empty>
        ) : (
          <table className="w-full text-[12px]">
            <thead className="text-muted text-[11px]">
              <tr>
                <th className="text-left px-3 py-1 font-semibold">Name</th>
                <th className="text-left font-semibold">Net</th>
                <th className="text-left font-semibold">Contract</th>
                <th className="text-left font-semibold">Call</th>
                <th className="text-right font-semibold">Qty × price</th>
                <th className="text-left font-semibold pl-3">Start</th>
                <th className="text-left font-semibold">Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.data!.map((r) => (
                <tr key={r.id} className="border-t border-line/50">
                  <td className="px-3 py-1.5 font-semibold">{r.data.name}</td>
                  <td>
                    <NetworkBadge id={r.data.network as NetworkId} />
                  </td>
                  <td className="num">
                    <ExtLink href={NETWORKS[r.data.network as NetworkId].explorer.address(r.data.address)}>
                      {shortAddress(r.data.address)}
                    </ExtLink>
                  </td>
                  <td className="num text-muted">{r.data.functionSignature}</td>
                  <td className="num text-right">
                    {r.data.quantity} × {r.data.unitPriceNative}{' '}
                    {NETWORKS[r.data.network as NetworkId].nativeSymbol}
                    {r.data.wallets.length > 1 && (
                      <span className="text-muted"> · {r.data.wallets.length} wallets</span>
                    )}
                  </td>
                  <td className="pl-3 text-muted">
                    {r.data.startAt ? new Date(r.data.startAt).toLocaleString() : 'when open'}
                  </td>
                  <td>
                    <Badge
                      tone={
                        r.status === 'armed'
                          ? 'accent'
                          : r.status === 'done'
                            ? 'up'
                            : r.status === 'error'
                              ? 'down'
                              : 'neutral'
                      }
                    >
                      {r.status}
                    </Badge>
                  </td>
                  <td className="px-3 text-right whitespace-nowrap">
                    {['idle', 'stopped', 'error'].includes(r.status) && (
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={!unlocked}
                        title={unlocked ? '' : 'Unlock trading wallet first'}
                        onClick={() => status.mutate({ id: r.id, s: 'armed' })}
                      >
                        Arm
                      </Button>
                    )}
                    {r.status === 'armed' && (
                      <Button size="sm" onClick={() => status.mutate({ id: r.id, s: 'idle' })}>
                        Disarm
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => setEdit(r)}>
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () =>
                        (await ask('Delete this mint task?', { confirmLabel: 'Delete' })) &&
                        remove.mutate(r.id)
                      }
                      aria-label="Delete"
                    >
                      <Icon name="trash" size={13} />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      <Panel title="Mint log" dense>
        {(logs.data?.length ?? 0) === 0 ? (
          <Empty title="No mint activity" mood="sleep" />
        ) : (
          <ul className="overflow-auto h-full text-[12px] num">
            {logs.data!.map((l) => (
              <li
                key={l.id}
                className={cx(
                  'px-3 py-0.5 border-b border-line/40',
                  l.level === 'error' && 'text-down',
                  l.level === 'warn' && 'text-warn',
                )}
              >
                <span className="text-muted">{new Date(l.at).toLocaleTimeString()} </span>
                {l.message}
              </li>
            ))}
          </ul>
        )}
      </Panel>
      {edit && (
        <MintForm
          row={edit === 'new' ? null : edit}
          prefill={edit === 'new' ? prefill : null}
          onClose={() => {
            setEdit(null);
            if (prefill) setParams({}, { replace: true });
          }}
        />
      )}
    </div>
  );
}

function MintForm({
  row,
  prefill,
  onClose,
}: {
  row: MintRow | null;
  prefill?: Partial<MintTask> | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { unlocked } = useVault();
  const [t, setT] = useState<MintTask>(row?.data ?? { ...DEFAULT, ...prefill });
  const [err, setErr] = useState<string | null>(null);
  const [link, setLink] = useState(prefill?.address ?? '');
  const [det, setDet] = useState<MintDetection | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [sims, setSims] = useState<Record<string, string>>({});
  const [choices, setChoices] = useState<Array<{ network: NetworkId; address: `0x${string}` }>>([]);
  const [sim, setSim] = useState<string | null>(null);
  const net = t.network as NetworkId;
  const n = (v: string) => (v === '' ? 0 : Number(v));

  /** Fills the task from a detection; values stay editable. */
  const apply = (d: MintDetection, c: MintCandidate | undefined, base: MintTask): MintTask => {
    const price = d.priceWei !== null ? Number(formatEther(d.priceWei)) : base.unitPriceNative;
    const cap = [d.perTx, d.perWallet].filter((x): x is bigint => x !== null && x > 0n && x < 1000n);
    const quantity = cap.length ? Math.min(base.quantity, ...cap.map(Number)) : base.quantity;
    return {
      ...base,
      network: d.network,
      address: d.address,
      name: base.name === DEFAULT.name && d.name ? d.name.slice(0, 60) : base.name,
      functionSignature: c?.signature ?? base.functionSignature,
      args: c?.args ?? base.args,
      quantity,
      unitPriceNative: price,
      maxTotalSpendNative: Math.max(base.maxTotalSpendNative, Number((price * quantity).toFixed(8))),
    };
  };

  const detectAt = async (network: NetworkId, address: `0x${string}`) => {
    const d = await detectMint(network, address);
    setDet(d);
    if (!d.hasCode) throw new Error(`No contract at this address on ${NETWORKS[network].name}`);
    const next = apply(d, d.candidates[0], t);
    setT(next);
    setSims({});
    if (unlocked && d.candidates.length) {
      // Check each detected function from your wallet (1 item, detected price).
      const out: Record<string, string> = {};
      for (const c of d.candidates.slice(0, 5)) {
        try {
          await simulateMint({
            ...next,
            functionSignature: c.signature,
            args: c.args,
            quantity: 1,
            maxTotalSpendNative: Math.max(next.unitPriceNative, next.maxTotalSpendNative),
          });
          out[c.signature] = 'ok';
        } catch (e) {
          out[c.signature] = (e as Error).message.split('\n')[0]!.slice(0, 90);
        }
      }
      setSims(out);
      const best = d.candidates.find((c) => out[c.signature] === 'ok');
      if (best) setT(apply(d, best, t));
    }
  };

  const detect = async () => {
    setErr(null);
    setDet(null);
    setChoices([]);
    setDetecting(true);
    try {
      const target = parseMintTarget(link);
      if (!target)
        throw new Error('Paste a contract address, explorer link, or an OpenSea / Magic Eden link');
      let found: Array<{ network: NetworkId; address: `0x${string}` }> = [];
      if (target.kind === 'slug') {
        const r = await get<{ name: string; contracts: Array<{ chain: string; address: string }> }>(
          `/api/nft/collection?slug=${encodeURIComponent(target.slug)}`,
        );
        found = r.contracts.flatMap((c) => {
          const n = parseMintTarget(`https://opensea.io/item/${c.chain}/${c.address}`);
          return n?.kind === 'address' && n.network && EVM_NETS.includes(n.network)
            ? [{ network: n.network, address: n.address }]
            : [];
        });
        if (!found.length) throw new Error(`${r.name}: no contract on a supported network`);
      } else if (target.network) found = [{ network: target.network, address: target.address }];
      else {
        // Bare address: look for code on every EVM network we support.
        const hits = await Promise.all(
          EVM_NETS.map(async (network) => {
            const code = await publicClient(network)
              .getCode({ address: target.address })
              .catch(() => undefined);
            return code && code !== '0x' ? network : null;
          }),
        );
        found = hits
          .filter((x): x is NetworkId => !!x)
          .map((network) => ({ network, address: target.address }));
        if (!found.length) throw new Error('No contract at this address on any supported network');
      }
      const pick = found.find((f) => f.network === t.network) ?? found[0]!;
      if (found.length > 1) setChoices(found);
      await detectAt(pick.network, pick.address);
    } catch (e) {
      setErr((e as Error).message.split('\n')[0]!);
    } finally {
      setDetecting(false);
    }
  };

  // Opened from the Mint Tracker with a contract: detect straight away.
  useEffect(() => {
    if (prefill?.address) void detect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const simulate = async () => {
    setSim(null);
    setErr(null);
    try {
      const p = zMintTask.safeParse(t);
      if (!p.success) throw new Error(p.error.issues[0]!.message);
      const r = await simulateMint(p.data);
      setSim(
        `Simulation passed now · value ${formatEther(r.value)} ${NETWORKS[net].nativeSymbol} · gas ~${r.gas}`,
      );
    } catch (e) {
      setSim(
        `Simulation failed now: ${(e as Error).message.split('\n')[0]} (expected if the mint is not open yet or you are not eligible)`,
      );
    }
  };

  const save = useMutation({
    mutationFn: async () => {
      const p = zMintTask.safeParse(t);
      if (!p.success)
        throw new Error(p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      return row ? put(`/api/automations/mint/${row.id}`, p.data) : post('/api/automations/mint', p.data);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['automations', 'mint'] });
      onClose();
    },
    onError: (e) => setErr((e as Error).message),
  });

  return (
    <Modal open onClose={onClose} title={row ? 'Edit mint task' : 'New mint task'} width={620}>
      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-3">
          <Field label="Name">
            <Input value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} />
          </Field>
          <Field label="Network">
            <Select value={t.network} onChange={(e) => setT({ ...t, network: e.target.value as NetworkId })}>
              {EVM_NETS.map((x) => (
                <option key={x} value={x}>
                  {NETWORKS[x].name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Start (local time)" hint="Blank = as soon as simulation passes">
            <DateTimePicker
              value={t.startAt}
              onChange={(ms) => setT({ ...t, startAt: ms })}
              placeholder="As soon as simulation passes"
            />
          </Field>
        </div>
        <Field
          label="Collection link or contract"
          hint="OpenSea / Magic Eden / explorer link or 0x… address. Verify it is the official contract."
        >
          <div className="flex gap-2">
            <Input
              value={link}
              aria-label="Collection link or contract"
              placeholder="https://opensea.io/collection/… or 0x…"
              onChange={(e) => setLink(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void detect()}
              spellCheck={false}
            />
            <Button onClick={() => void detect()} loading={detecting} disabled={!link.trim()}>
              Detect
            </Button>
          </div>
        </Field>
        {choices.length > 1 && (
          <div className="flex flex-wrap items-center gap-1 text-[12px]">
            <span className="text-muted">Also on:</span>
            {choices.map((c) => (
              <Button
                key={c.network}
                size="sm"
                variant={det?.network === c.network ? 'primary' : 'secondary'}
                onClick={() => void detectAt(c.network, c.address).catch((e) => setErr((e as Error).message))}
              >
                {NETWORKS[c.network].name}
              </Button>
            ))}
          </div>
        )}
        {det && det.hasCode && (
          <Notice tone={det.candidates.length ? 'info' : 'warn'}>
            <div>
              <b>{det.name ?? 'Unnamed'}</b> {det.symbol && `(${det.symbol})`} on {NETWORKS[det.network].name}{' '}
              · <span className="num">{shortAddress(det.address)}</span>
            </div>
            <div className="text-[12px] mt-0.5">{describeDetection(det)}</div>
            {det.candidates.length ? (
              <div className="flex flex-wrap gap-1 mt-1.5">
                {det.candidates.map((c) => {
                  const r = sims[c.signature];
                  return (
                    <button
                      key={c.signature}
                      type="button"
                      title={r && r !== 'ok' ? `Simulation: ${r}` : undefined}
                      onClick={() => setT(apply(det, c, t))}
                      className={cx(
                        'h-6 px-2 rounded-[4px] border text-[11px] num',
                        t.functionSignature === c.signature
                          ? 'border-accent/70 bg-accent/15 text-text'
                          : 'border-line text-text-2 hover:text-text',
                      )}
                    >
                      {r === 'ok' ? '✓ ' : r ? '✗ ' : ''}
                      {c.signature}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="text-[12px] mt-1">
                No simple public mint function found (it may need a signature / allowlist proof, or mint
                through a launchpad contract). Enter the function manually from the verified source.
              </div>
            )}
            {!unlocked && det.candidates.length > 0 && (
              <div className="text-[11px] text-muted mt-1">
                Unlock the trading wallet to test each function.
              </div>
            )}
          </Notice>
        )}
        <div className="grid grid-cols-3 gap-3">
          <Field label="Mint function" hint="e.g. mint(uint256), publicMint(address,uint256)">
            <Input
              className="num"
              value={t.functionSignature}
              onChange={(e) => setT({ ...t, functionSignature: e.target.value.replace(/\s/g, '') })}
            />
          </Field>
          <Field label="Arguments (comma)" hint="{quantity} / {recipient} placeholders">
            <Input
              className="num"
              value={t.args.join(',')}
              onChange={(e) =>
                setT({
                  ...t,
                  args: e.target.value === '' ? [] : e.target.value.split(',').map((s) => s.trim()),
                })
              }
            />
          </Field>
          <Field label="Quantity">
            <Input
              type="number"
              min="1"
              value={t.quantity}
              onChange={(e) => setT({ ...t, quantity: n(e.target.value) })}
            />
          </Field>
          <Field label={`Unit price (${NETWORKS[net].nativeSymbol})`}>
            <Input
              type="number"
              step="any"
              value={t.unitPriceNative}
              onChange={(e) => setT({ ...t, unitPriceNative: n(e.target.value) })}
            />
          </Field>
          <Field
            label={`Max total spend (${NETWORKS[net].nativeSymbol})`}
            hint={t.wallets.length > 1 ? 'Hard cap per wallet' : 'Hard cap on value sent'}
          >
            <Input
              type="number"
              step="any"
              value={t.maxTotalSpendNative}
              onChange={(e) => setT({ ...t, maxTotalSpendNative: n(e.target.value) })}
            />
          </Field>
          <Field label="Max attempts">
            <Input
              type="number"
              min="1"
              max="10"
              value={t.maxAttempts}
              onChange={(e) => setT({ ...t, maxAttempts: n(e.target.value) })}
            />
          </Field>
          {NETWORKS[net].supportsPriorityFee && (
            <Field label="Priority fee">
              <Select
                value={t.priorityFee}
                onChange={(e) => setT({ ...t, priorityFee: e.target.value as MintTask['priorityFee'] })}
              >
                <option value="none">Default</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </Select>
            </Field>
          )}
        </div>
        <WalletPicker
          label="Mint from wallets (each mints the quantity above)"
          value={t.wallets}
          onChange={(wallets) => setT({ ...t, wallets })}
        />
        {sim && <Notice tone={sim.startsWith('Simulation passed') ? 'info' : 'warn'}>{sim}</Notice>}
        {err && <Notice tone="down">{err}</Notice>}
        <div className="flex justify-between">
          <Button
            onClick={() => void simulate()}
            disabled={!unlocked}
            title={unlocked ? '' : 'Unlock trading wallet to simulate from your address'}
          >
            Simulate now
          </Button>
          <div className="flex gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
              Save
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
