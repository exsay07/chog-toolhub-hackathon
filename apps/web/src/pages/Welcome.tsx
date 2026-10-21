import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { BookOpen } from 'lucide-react';
import { Guide, useGuideDone } from '../components/Guide';
import { NETWORKS, NETWORK_IDS, shortAddress } from '@chog/shared';
import { useAuth } from '../lib/auth';
import { ChogTv } from '../components/ChogTv';
import { Icon } from '../components/Icon';
import { Badge, glitchPhase, NetworkBadge, Panel } from '../components/ui';

/** Start page after sign-in: who you are, what each section does, and where trading is live. */

const SECTIONS: Array<{
  group: string;
  items: Array<{ to: string; label: string; icon: string; text: string }>;
}> = [
  {
    group: 'Memecoins',
    items: [
      {
        to: '/terminal',
        label: 'Token Terminal',
        icon: 'terminal',
        text: 'Search any token or paste a contract — chart, pools, trades and one-click swaps.',
      },
      {
        to: '/sniper',
        label: 'Token Sniper',
        icon: 'sniper',
        text: 'Watch for new pools and buy (or alert) the moment they match your filters.',
      },
      {
        to: '/tracker',
        label: 'Wallet Tracker',
        icon: 'tracker',
        text: 'Follow wallets across networks, get their trades live and copy them.',
      },
    ],
  },
  {
    group: 'NFT',
    items: [
      {
        to: '/nft',
        label: 'NFT Sniper',
        icon: 'nft',
        text: 'Pre-arm public mints and fire them from your local wallet the second they open.',
      },
      {
        to: '/nft/top',
        label: 'Top Collections',
        icon: 'top',
        text: 'Collections ranked by 24h volume, sales or floor — with floor moves and owners.',
      },
      {
        to: '/nft/mints',
        label: 'Mint Tracker',
        icon: 'mints',
        text: 'Live mints read straight from the chain, hottest first, with bot-farm flags.',
      },
    ],
  },
  {
    group: 'Perps',
    items: [
      {
        to: '/perps',
        label: 'Perps Farm',
        icon: 'perps',
        text: 'Farm volume on Perpl and Bulk with bots that run right in this tab.',
      },
    ],
  },
  {
    group: 'Account',
    items: [
      {
        to: '/portfolio',
        label: 'Portfolio',
        icon: 'portfolio',
        text: 'Balances, realized PnL calendar and shareable PnL cards.',
      },
      {
        to: '/settings',
        label: 'Settings',
        icon: 'settings',
        text: 'Theme, risk limits, notifications and active sessions.',
      },
    ],
  },
];

const STATUS: Record<string, { label: string; tone: 'up' | 'info' | 'neutral' }> = {
  verified: { label: 'Trading', tone: 'up' },
  'implemented-unverified': { label: 'Trading · beta', tone: 'info' },
  'data-only': { label: 'Data only', tone: 'neutral' },
};

export default function Welcome() {
  const { me } = useAuth();
  const guide = useGuideDone();
  const [guideOpen, setGuideOpen] = useState(false);
  // First visit: the guide opens by itself; once closed it is remembered (server-side) and never auto-opens again.
  useEffect(() => {
    if (guide.loaded && !guide.done) setGuideOpen(true);
  }, [guide.loaded, guide.done]);
  const closeGuide = () => {
    setGuideOpen(false);
    guide.markDone();
  };
  return (
    <div className="page-stagger p-4 grid grid-cols-12 gap-3 auto-rows-min">
      <Guide open={guideOpen} onClose={closeGuide} />
      <section className="lux relative col-span-12 flex items-center gap-8 border border-line rounded-[var(--radius)] bg-surface px-8 py-6">
        <button
          onClick={() => setGuideOpen(true)}
          className="absolute top-4 right-4 h-8 px-3 rounded-[var(--radius-sm)] border border-line text-[12px] text-text-2 hover:text-text hover:bg-surface-2 inline-flex items-center gap-1.5"
          title="Open the guide again"
        >
          <BookOpen className="size-3.5" />
          Guide
        </button>
        <ChogTv size={168} className="shrink-0" />
        <div className="min-w-0">
          <div className="crt-text crt-scan">
            <h2 className="crt-glitch text-[44px] leading-none" style={glitchPhase('welcome')}>
              WELCOME TO CHOG TOOLHUB
            </h2>
            <p className="crt-dim text-[20px] leading-snug mt-3 max-w-[640px]">
              Memecoin trading, NFT tools and farming in one terminal — for Chog Genesis holders. Pick a
              section below or from the sidebar.
            </p>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2 text-[13px]">
            <span className="num text-text">{shortAddress(me?.address ?? '')}</span>
            {me?.accessBasis === 'holder' ? (
              <Badge tone="up">Holder · {me.session.nftBalance} Chog Genesis</Badge>
            ) : (
              <Badge tone={me?.accessBasis === 'judge' ? 'accent' : 'warn'}>
                {me?.accessBasis === 'judge' ? 'Judge access' : 'Dev access'}
              </Badge>
            )}
            <span className="text-muted">Ownership re-checked on-chain every few minutes.</span>
          </div>
        </div>
      </section>

      {SECTIONS.map((s) => (
        <Panel key={s.group} title={s.group} className="col-span-6" dense>
          <div className="divide-y divide-line">
            {s.items.map((it) => (
              <Link
                key={it.to}
                to={it.to}
                className="group flex items-center gap-3 px-4 py-3 hover:bg-surface-2 transition-colors"
              >
                <span className="size-8 grid place-items-center rounded-[var(--radius-sm)] border border-line text-text-2 group-hover:text-text">
                  <Icon name={it.icon} size={16} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] text-text">{it.label}</span>
                  <span className="block text-[12px] text-muted leading-snug">{it.text}</span>
                </span>
                <Icon name="chevron" size={15} className="text-muted group-hover:text-text" />
              </Link>
            ))}
          </div>
        </Panel>
      ))}

      <Panel title="Networks" className="col-span-12" dense>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] [&>*]:border-b [&>*]:border-r [&>*]:border-line">
          {NETWORK_IDS.map((id) => {
            const st = STATUS[NETWORKS[id].tradingStatus] ?? STATUS['data-only']!;
            return (
              <div key={id} className="px-4 py-3 flex flex-col gap-1.5">
                <span className="flex items-center gap-2">
                  <NetworkBadge id={id} />
                  <span className="text-[13px]">{NETWORKS[id].name}</span>
                </span>
                <span>
                  <Badge tone={st.tone}>{st.label}</Badge>
                </span>
              </div>
            );
          })}
        </div>
      </Panel>
    </div>
  );
}
