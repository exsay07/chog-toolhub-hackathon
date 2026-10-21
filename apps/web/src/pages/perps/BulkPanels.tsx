import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Coins, KeyRound, Wallet, Zap } from 'lucide-react';
import type { PerpsTaskConfig } from '@chog/shared';
import {
  BULK_NETWORKS,
  bulkAccount,
  claimFaucet,
  connectPhantom,
  forgetAgent,
  loadAgent,
  phantom,
  registerAgent,
} from '../../lib/perps/bulk';
import { farmNet, startBulkFarm } from '../../lib/perps/runner';
import { ask } from '../../components/Confirm';
import { Button, ExtLink, Modal, Notice } from '../../components/ui';
import { Step } from './PerplPanels';

const OWNER_KEY = 'chog.bulk.owner';
const savedOwner = () => {
  try {
    return localStorage.getItem(OWNER_KEY) ?? '';
  } catch {
    return '';
  }
};

/**
 * Bulk launch checklist: Phantom (the Bulk account) → authorise the bot key (one message
 * signature) → funds (testnet: free faucet) → start.
 */
export function BulkSetup({
  bot,
  onClose,
}: {
  bot: { id: string; cfg: PerpsTaskConfig } | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const net = farmNet('bulk');
  const [owner, setOwner] = useState(savedOwner);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const agent = useQuery({
    queryKey: ['bulk', 'agent', net, owner],
    queryFn: async () => (await loadAgent(net, owner)) ?? null,
    enabled: !!bot && !!owner,
  });
  const acct = useQuery({
    queryKey: ['bulk', 'account', net, owner],
    queryFn: () => bulkAccount(net, owner),
    enabled: !!bot && !!owner,
    refetchInterval: 10_000,
  });
  const authorised = !!agent.data && !!acct.data?.authorizedAgentWallets?.includes(agent.data.pubkey);
  const free = acct.data?.margin.availableMargin ?? 0;
  const margin = bot ? bot.cfg.sizeUsd / bot.cfg.leverage : 0;
  const funded = free >= margin * 1.05;

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setErr(null);
    setNote(null);
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      const m = (e as Error).message;
      setErr(/reject|denied|cancel/i.test(m) ? 'You declined the request in Phantom.' : m);
    } finally {
      setBusy(null);
      void qc.invalidateQueries({ queryKey: ['bulk'] });
    }
  };

  return (
    <Modal
      open={!!bot}
      onClose={onClose}
      title={`Start on Bulk${net === 'testnet' ? ' testnet' : ''}`}
      width={560}
    >
      {bot && (
        <div className="space-y-3">
          <p className="text-[13px] text-text-2">
            Bulk accounts are Solana wallets. The bot trades your Phantom account through a key that lives
            only in this browser — it can place and cancel orders, never withdraw. Keep this tab open while it
            runs.
          </p>

          <Step n={1} icon={<Wallet className="size-4" />} title="Phantom wallet" done={!!owner}>
            {owner ? (
              <div className="flex items-center gap-2 text-[12px] text-muted">
                <span className="num text-text">
                  {owner.slice(0, 4)}…{owner.slice(-4)}
                </span>
                <button
                  className="ml-auto underline hover:text-text"
                  onClick={() =>
                    run('connect', async () => {
                      const pk = await connectPhantom();
                      localStorage.setItem(OWNER_KEY, pk);
                      setOwner(pk);
                    })
                  }
                >
                  Switch
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                {!phantom() && (
                  <div className="text-[12px] text-down">
                    Phantom is not installed. Get it at{' '}
                    <ExtLink href="https://phantom.com">phantom.com</ExtLink>, then reload.
                  </div>
                )}
                <Button
                  variant="primary"
                  loading={busy === 'connect'}
                  disabled={!!busy || !phantom()}
                  onClick={() =>
                    run('connect', async () => {
                      const pk = await connectPhantom();
                      localStorage.setItem(OWNER_KEY, pk);
                      setOwner(pk);
                    })
                  }
                >
                  Connect Phantom
                </Button>
              </div>
            )}
          </Step>

          <Step
            n={2}
            icon={<KeyRound className="size-4" />}
            title="Authorise the bot"
            done={authorised}
            loading={!!owner && (agent.isLoading || acct.isLoading)}
          >
            {authorised ? (
              <div className="flex items-center gap-2 text-[12px] text-muted">
                Bot key authorised {new Date(agent.data!.createdAt).toLocaleDateString('en-US')} · stored only
                in this browser.
                <button
                  className="ml-auto underline hover:text-text"
                  onClick={async () =>
                    (await ask('Forget the bot key on this device?', {
                      detail: 'Running Bulk bots stop working. You can authorise a new one any time.',
                      confirmLabel: 'Forget key',
                    })) && run('forget', () => forgetAgent(net, owner))
                  }
                >
                  Forget
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="text-[12px] text-text-2">
                  Phantom shows one message to sign. It allows this bot key to trade for your account and
                  nothing else. No transaction, no fee.
                </div>
                <Button
                  variant="primary"
                  loading={busy === 'agent'}
                  disabled={!!busy || !owner}
                  onClick={() => run('agent', () => registerAgent(net, owner))}
                >
                  Authorise (1 signature)
                </Button>
              </div>
            )}
          </Step>

          <Step n={3} icon={<Coins className="size-4" />} title="Margin on Bulk" done={funded}>
            {!owner ? (
              <div className="text-[12px] text-muted">Connect Phantom first.</div>
            ) : (
              <div className="space-y-2">
                <div className="text-[12px] text-text-2">
                  Free margin: <span className="num text-text">${free.toFixed(2)}</span> · this bot needs
                  about <span className="num">${(margin * 1.05).toFixed(2)}</span>.
                </div>
                {!funded &&
                  (net === 'testnet' ? (
                    <Button
                      variant="primary"
                      loading={busy === 'faucet'}
                      disabled={!!busy || !authorised}
                      onClick={() =>
                        run('faucet', async () => {
                          const amt = await claimFaucet(agent.data!);
                          setNote(`Received ${amt} test USD.`);
                        })
                      }
                    >
                      Get 1,000 test USD
                    </Button>
                  ) : (
                    <div className="text-[12px] text-text-2">
                      Deposit USDC to your Bulk account at{' '}
                      <ExtLink href={BULK_NETWORKS[net].app}>bulk.trade</ExtLink>, then come back.
                    </div>
                  ))}
              </div>
            )}
          </Step>

          <Step n={4} icon={<Zap className="size-4" />} title="Start" done={false}>
            <div className="text-[12px] text-text-2">
              {bot.cfg.pair} · ${bot.cfg.sizeUsd} @ {bot.cfg.leverage}x · {bot.cfg.entry}/{bot.cfg.exit}
            </div>
          </Step>

          {note && <Notice tone="info">{note}</Notice>}
          {err && <Notice tone="down">{err}</Notice>}
          <Button
            variant="primary"
            size="lg"
            className="w-full"
            disabled={!authorised || !funded || !!busy}
            loading={busy === 'start'}
            onClick={() =>
              run('start', async () => {
                await startBulkFarm(bot.id, bot.cfg, owner, net);
                onClose();
              })
            }
          >
            Start bot
          </Button>
        </div>
      )}
    </Modal>
  );
}
