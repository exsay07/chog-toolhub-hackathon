import { useEffect, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Check, Lightbulb, MapPin, X } from 'lucide-react';
import { useSettings } from '../lib/settings';
import { ChogTv } from './ChogTv';
import { cx } from './ui';

/**
 * First-login guide: one step per feature — a real screenshot, where to find it, what to click, one tip.
 * Shown automatically on the Welcome page until finished or closed (then never again, stored with the
 * user's settings on the server); reopen any time with the Guide button on Welcome.
 */

interface Step {
  id: string;
  title: string;
  where?: string;
  shot?: string;
  steps: string[];
  tip?: string;
}

export const GUIDE_STEPS: Step[] = [
  {
    id: 'hello',
    title: 'Welcome aboard, holder',
    steps: [
      'Trade memecoins on 9 chains, snipe launches and NFT mints, follow wallets and farm perps volume — all from one terminal.',
      'Everything that signs runs in this browser with a wallet only you control. We never see your keys.',
      'This tour takes about two minutes. Use → / ← or the buttons below.',
    ],
    tip: 'You can reopen this guide any time from Welcome → Guide.',
  },
  {
    id: 'wallet',
    title: 'Create your trading wallet',
    where: 'Token Terminal → “Set up trading wallet” (top right)',
    shot: '/guide/wallet.webp',
    steps: [
      'Open Token Terminal and press “Set up trading wallet”.',
      'Choose “Create new wallet” (or import one), set a password of 12+ characters.',
      'Write down the recovery phrase — it is the only way back into this wallet.',
      'Send a small amount of MON / ETH / BNB / SOL to the address it shows. That’s your trading balance.',
    ],
    tip: 'Keep only trading money here — your NFT wallet is just for signing in.',
  },
  {
    id: 'discover',
    title: 'Find tokens — Discover',
    where: 'Sidebar → Memecoins → Token Terminal → DISCOVER',
    shot: '/guide/terminal.webp',
    steps: [
      'Trending tokens across all chains, refreshed every few seconds.',
      'Pick the timeframe (5M / 1H / 6H / 24H), filter chains with “All chains”, sort by any column.',
      'Set how much one click spends per chain in “Quick buy”, then hit ⚡ on any row.',
    ],
    tip: 'Paste a contract address into the search box to jump straight to a token. Press / to focus it.',
  },
  {
    id: 'token',
    title: 'Trade a token',
    where: 'Click any row in Discover, Pulse or Watchlist',
    shot: '/guide/token.webp',
    steps: [
      'Chart with live trades, market cap, liquidity and price changes at the top.',
      'Buy / Sell on the right: pick preset P1 / P2 / P3 (each has its own slippage and priority), then one click on an amount or a sell %.',
      'Hotkeys: 1–4 buy, Shift+1–4 sell. The gear next to P1–P3 edits the buttons.',
      'Limit · TP/SL places limit buys, take-profits and stop-losses; “Auto TP/SL” adds both after every buy.',
      'The risk scan flags honeypots, taxes, creator holdings and unlocked liquidity. Star ☆ to watch a token.',
    ],
    tip: 'Every trade is quoted and simulated first. With “confirm every trade” on you review it before signing.',
  },
  {
    id: 'pulse',
    title: 'Pulse — launches as they happen',
    where: 'Token Terminal → PULSE',
    shot: '/guide/pulse.webp',
    steps: [
      'New pairs: pools created moments ago.',
      'Heating up: young tokens with real buying in the last hour.',
      'Trending: what the whole market is trading right now. ⚡ buys straight from a card.',
    ],
  },
  {
    id: 'sniper',
    title: 'Token Sniper',
    where: 'Sidebar → Memecoins → Token Sniper',
    shot: '/guide/sniper.webp',
    steps: [
      'Press “New”, pick the chain and the filters a new pool must pass (liquidity, FDV, buyers, DEX).',
      'Auto-buy adds anti-rug checks: mint / freeze authority, owner powers, holder and creator share, locked LP, blacklist.',
      'Exits run by themselves: take-profit ladder, trailing stop, stop-loss — and sell-all when the creator dumps.',
      'Arm it. Open positions with live PnL are under POSITIONS.',
    ],
    tip: 'Start with alert-only to see what your filters catch before letting it buy.',
  },
  {
    id: 'tracker',
    title: 'Wallet Tracker & copy trading',
    where: 'Sidebar → Memecoins → Wallet Tracker',
    shot: '/guide/tracker.webp',
    steps: [
      'Add any wallet on any chain and give it a label.',
      'Its buys and sells stream in live, with the token and size.',
      'Turn on copy trading to mirror its buys with your own amount and limits.',
    ],
  },
  {
    id: 'nft',
    title: 'NFT Sniper',
    where: 'Sidebar → NFT → NFT Sniper → “New mint”',
    shot: '/guide/nft-sniper.webp',
    steps: [
      'Paste an OpenSea / Magic Eden / explorer link or the contract and press Detect.',
      'The chain, name, price, limits and mint function are read from the contract — check them, set quantity and a hard spending cap.',
      'Pick the start time — the task simulates until then and fires the moment the mint opens.',
    ],
    tip: 'Always copy the contract from the project’s own site or X, never from a DM.',
  },
  {
    id: 'nft-data',
    title: 'Mint Tracker & Top Collections',
    where: 'Sidebar → NFT',
    shot: '/guide/mints.webp',
    steps: [
      'Mint Tracker: live mints read from the chain, hottest first. SUS marks bot-farmed mints.',
      '“Mint task” on any row opens the NFT Sniper with that contract filled in.',
      'Top Collections: floor, volume and owners for the leading collections per chain.',
    ],
  },
  {
    id: 'perps',
    title: 'Perps Farm',
    where: 'Sidebar → Perps → Perps Farm',
    shot: '/guide/perps-config.webp',
    steps: [
      'Pick Perpl or Bulk.',
      'Choose the pair, order size, leverage, direction and how orders open and close.',
      'Press Start Bot and sign once — the bot then trades volume for you while the site is open.',
    ],
    tip: 'Use “Advanced & risk limits” to cap daily loss and runtime.',
  },
  {
    id: 'account',
    title: 'Portfolio, Settings & safety',
    where: 'Sidebar → Account',
    shot: '/guide/portfolio.webp',
    steps: [
      'Portfolio: balances, realized PnL calendar and shareable PnL cards.',
      'Settings: theme, risk limits, notifications, sounds and active sessions.',
      'Emergency stop (bottom of the sidebar) instantly disarms every automation.',
    ],
    tip: 'That’s it — you’re ready. Have fun and trade safe.',
  },
];

export function useGuideDone() {
  const { settings, loaded, update } = useSettings();
  const done = !!settings.onboarding?.guideDoneAt;
  const markDone = () => {
    if (!done) void update((s) => ({ ...s, onboarding: { guideDoneAt: Date.now() } }));
  };
  return { done, loaded, markDone };
}

export function Guide({
  open,
  onClose,
  cta,
}: {
  open: boolean;
  onClose: () => void;
  /** Extra action in the footer (the public tour shows "Get Chog Genesis"). */
  cta?: ReactNode;
}) {
  const [i, setI] = useState(0);
  const step = GUIDE_STEPS[i]!;
  const last = i === GUIDE_STEPS.length - 1;

  useEffect(() => {
    if (!open) return;
    setI(0);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') setI((x) => Math.min(GUIDE_STEPS.length - 1, x + 1));
      if (e.key === 'ArrowLeft') setI((x) => Math.max(0, x - 1));
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [open, onClose]);
  // Warm the next screenshot so steps switch instantly.
  useEffect(() => {
    const next = GUIDE_STEPS[i + 1]?.shot;
    if (open && next) new Image().src = next;
  }, [open, i]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[70] grid place-items-center bg-black/60 backdrop-blur-[2px] p-6"
      role="dialog"
      aria-modal
      aria-label="Guide"
    >
      <div className="w-full max-w-[1080px] bg-surface border border-line-strong rounded-[var(--radius-lg)] shadow-[var(--shadow-lg)] overflow-hidden flex flex-col max-h-[92vh]">
        <div className="flex items-center gap-3 px-5 h-12 border-b border-line shrink-0">
          <span className="crt-text text-[20px] leading-none">GUIDE</span>
          <span className="num text-[12px] text-muted">
            {String(i + 1).padStart(2, '0')} / {String(GUIDE_STEPS.length).padStart(2, '0')}
          </span>
          <button
            onClick={onClose}
            className="ml-auto size-8 grid place-items-center rounded-[var(--radius-sm)] text-muted hover:text-text hover:bg-surface-2"
            aria-label="Close guide"
            title="Close guide"
          >
            <X className="size-4" />
          </button>
        </div>

        <div
          key={step.id}
          className="grid grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)] min-h-0 flex-1 guide-step"
        >
          <div className="bg-bg border-r border-line p-5 grid place-items-center min-h-[380px]">
            {step.shot ? (
              <img
                src={step.shot}
                alt={`${step.title} screenshot`}
                className="max-h-[62vh] w-full object-contain rounded-[var(--radius)] border border-line shadow-[var(--shadow-lg)]"
              />
            ) : (
              <ChogTv size={220} />
            )}
          </div>
          <div className="p-6 flex flex-col min-h-0 overflow-auto">
            <h2 className="crt-text text-[32px] leading-[1.05]">{step.title.toUpperCase()}</h2>
            {step.where && (
              <div className="mt-3 inline-flex items-start gap-1.5 text-[12px] text-accent">
                <MapPin className="size-3.5 mt-px shrink-0" />
                <span>{step.where}</span>
              </div>
            )}
            <ol className="mt-5 space-y-3">
              {step.steps.map((s, n) => (
                <li key={n} className="flex gap-3 text-[14px] leading-snug text-text">
                  <span className="size-6 shrink-0 rounded-full border border-line-strong grid place-items-center num text-[11px] text-text-2">
                    {n + 1}
                  </span>
                  <span className="pt-0.5">{s}</span>
                </li>
              ))}
            </ol>
            {step.tip && (
              <div className="mt-5 flex gap-2 rounded-[var(--radius)] border border-accent/30 bg-accent/8 p-3 text-[13px] text-text-2">
                <Lightbulb className="size-4 text-accent shrink-0 mt-px" />
                <span>{step.tip}</span>
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3 px-5 h-14 border-t border-line shrink-0">
          <div className="flex items-center gap-1.5" role="tablist" aria-label="Guide steps">
            {GUIDE_STEPS.map((s, n) => (
              <button
                key={s.id}
                role="tab"
                aria-selected={n === i}
                aria-label={`Step ${n + 1}: ${s.title}`}
                onClick={() => setI(n)}
                className={cx(
                  'h-1.5 rounded-full transition-all',
                  n === i ? 'w-6 bg-accent' : n < i ? 'w-1.5 bg-text-2' : 'w-1.5 bg-surface-3',
                )}
              />
            ))}
          </div>
          <div className="ml-auto flex gap-2">
            {cta}
            {i > 0 && (
              <button
                onClick={() => setI(i - 1)}
                className="h-9 px-3 rounded-[var(--radius-sm)] border border-line text-[13px] text-text-2 hover:text-text hover:bg-surface-2 inline-flex items-center gap-1.5"
              >
                <ArrowLeft className="size-4" /> Back
              </button>
            )}
            <button
              onClick={() => (last ? onClose() : setI(i + 1))}
              className="h-9 px-4 rounded-[var(--radius-sm)] bg-accent text-white text-[13px] font-semibold inline-flex items-center gap-1.5 hover:brightness-110"
            >
              {last ? (
                <>
                  <Check className="size-4" /> Finish
                </>
              ) : (
                <>
                  Next <ArrowRight className="size-4" />
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
