import { Suspense, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { GlyphNoise } from './GlyphNoise';
import { useQueryClient } from '@tanstack/react-query';
import { discoverQuery, pulseQuery, terminalPrefs } from '../lib/discover';
import { sfxTab } from '../lib/sfx';
import { useGuideDone } from './Guide';
import { NavLink, Outlet, useLocation } from 'react-router';
import { shortAddress } from '@chog/shared';
import { useAuth } from '../lib/auth';
import { useSettings } from '../lib/settings';
import { useSocketStatus, socket } from '../lib/ws';
import { killSwitch } from '../lib/killSwitch';
import { post } from '../lib/api';
import { useNotify } from '../lib/notify';
import { BRAND } from '../brand';
import { Icon } from './Icon';
import { cx, glitchPhase, SkeletonRows } from './ui';
import { MusicDock } from './MusicDock';

interface NavItem {
  to: string;
  label: string;
  icon: string;
  end?: boolean;
}
const NAV_GROUPS: Array<{ label: string | null; items: NavItem[] }> = [
  {
    label: null,
    items: [
      { to: '/', label: 'Welcome', icon: 'welcome', end: true },
      { to: '/dashboard', label: 'Dashboard', icon: 'dashboard' },
    ],
  },
  {
    label: 'Memecoins',
    items: [
      { to: '/terminal', label: 'Token Terminal', icon: 'terminal' },
      { to: '/sniper', label: 'Token Sniper', icon: 'sniper' },
      { to: '/tracker', label: 'Wallet Tracker', icon: 'tracker' },
    ],
  },
  {
    label: 'NFT',
    items: [
      { to: '/nft', label: 'NFT Sniper', icon: 'nft', end: true },
      { to: '/nft/top', label: 'Top Collections', icon: 'top' },
      { to: '/nft/mints', label: 'Mint Tracker', icon: 'mints' },
    ],
  },
  { label: 'Perps', items: [{ to: '/perps', label: 'Perps Farm', icon: 'perps' }] },
  {
    label: 'Account',
    items: [
      { to: '/portfolio', label: 'Portfolio', icon: 'portfolio' },
      { to: '/settings', label: 'Settings', icon: 'settings' },
    ],
  },
];
const NAV_ITEMS = NAV_GROUPS.flatMap((g) => g.items);
/** Page title: the nav item with the longest path that matches the URL ('/nft/top' beats '/nft'). */
const titleFor = (path: string) =>
  NAV_ITEMS.filter((i) => (i.to === '/' ? path === '/' : path === i.to || path.startsWith(i.to + '/'))).sort(
    (a, b) => b.to.length - a.to.length,
  )[0]?.label ?? 'Welcome';

const SIDEBAR_KEY = 'chog.sidebar.collapsed';
const SIDEBAR_W = { open: 224, closed: 56 };

/** Collapsed sidebar (icons only), remembered per browser. */
function useSidebarCollapsed() {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_KEY) === '1';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [collapsed]);
  // Things placed beside the sidebar (bottom-left toasts) follow its width.
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--sidebar-w', `${collapsed ? SIDEBAR_W.closed : SIDEBAR_W.open}px`);
    return () => void root.style.removeProperty('--sidebar-w');
  }, [collapsed]);
  return [collapsed, setCollapsed] as const;
}

/** Text in the sidebar that fades out (and stops taking clicks) when it collapses. */
const fade = (collapsed: boolean) =>
  cx(
    'whitespace-nowrap transition-opacity duration-200',
    collapsed ? 'opacity-0 pointer-events-none' : 'opacity-100 delay-75',
  );

export function useKillSwitch() {
  return useSyncExternalStore(
    (cb) => {
      killSwitch.listeners.add(cb);
      return () => killSwitch.listeners.delete(cb);
    },
    () => killSwitch.active,
  );
}

export function Shell() {
  const { me, signOut } = useAuth();
  const { update } = useSettings();
  const ws = useSocketStatus();
  const killed = useKillSwitch();
  const { notify } = useNotify();
  const loc = useLocation();
  const [collapsed, setCollapsed] = useSidebarCollapsed();
  const guide = useGuideDone();
  /** Until the guide is read, Welcome glows and carries a NEW badge. */
  const guideWaiting = guide.loaded && !guide.done;
  // The active-item highlight glides between menu items instead of jumping.
  const menu = useRef<HTMLDivElement>(null);
  const [pill, setPill] = useState({ top: 0, visible: false, ready: false });
  useLayoutEffect(() => {
    const a = menu.current?.querySelector<HTMLElement>('a[aria-current="page"]');
    setPill((p) => ({ top: a ? a.offsetTop : p.top, visible: !!a, ready: p.visible }));
  }, [loc.pathname, collapsed]);
  const qc = useQueryClient();
  // Token Terminal opens instantly: its Discover table is fetched as soon as the app is up.
  useEffect(() => {
    const p = terminalPrefs();
    void qc.prefetchQuery(discoverQuery(p.chains, p.view, p.tf));
    void qc.prefetchQuery(pulseQuery(p.chains));
    // Load the terminal's code in the background too (charts, trading engine) — the click is then instant.
    void import('../pages/Terminal');
  }, [qc]);
  const health = useSyncExternalStore(
    (cb) => socket.onStatus(cb),
    () => socket.health,
  );
  const degraded = Object.entries(health)
    .filter(([, h]) => !h.ok)
    .map(([k]) => k);
  const dark = document.documentElement.dataset.theme !== 'light';
  const title = titleFor(loc.pathname);

  const emergencyStop = async () => {
    killSwitch.set(true);
    try {
      await post('/api/automations/emergency-stop');
      notify({
        category: 'failed',
        tone: 'warn',
        title: 'Emergency stop active',
        body: 'All automations disarmed. Copy trading disabled. Re-arm manually.',
      });
    } catch {
      notify({
        category: 'failed',
        tone: 'down',
        title: 'Local automations stopped',
        body: 'Server-side disarm failed — check your connection.',
      });
    }
  };

  return (
    <>
      <GlyphNoise subtle />
      <div
        className="relative z-[1] h-full grid grid-rows-[var(--topbar-h)_1fr] transition-[grid-template-columns] duration-[280ms] ease-[var(--ease)]"
        style={{ gridTemplateColumns: `${collapsed ? SIDEBAR_W.closed : SIDEBAR_W.open}px 1fr` }}
      >
        <aside className="row-span-2 border-r border-line flex flex-col min-h-0 min-w-0 overflow-hidden bg-sidebar">
          <div className="h-[var(--topbar-h)] flex items-center pl-4 pr-3 shrink-0">
            <div className={cx('flex items-center gap-2.5 min-w-0 flex-1 overflow-hidden', fade(collapsed))}>
              <img src={BRAND.mark} alt="" className="size-6 rounded-[6px] shrink-0" />
              <span
                className="crt-glitch text-[14px] font-semibold tracking-tight"
                style={glitchPhase('brand')}
              >
                Chog Toolhub
              </span>
            </div>
            {/* Collapse / expand: the same spot in both states. */}
            <button
              onClick={() => {
                sfxTab();
                setCollapsed((v) => !v);
              }}
              className="size-7 grid place-items-center shrink-0 rounded-[var(--radius-sm)] text-muted hover:text-text hover:bg-surface-2"
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            >
              <Icon name={collapsed ? 'sidebar-open' : 'sidebar-close'} size={16} />
            </button>
          </div>

          {/* The menu sits centred between the brand and the player when there is room; scrolls when not. */}
          <nav className="flex-1 overflow-y-auto overflow-x-hidden px-2 flex flex-col" aria-label="Main">
            <div ref={menu} className="relative my-auto py-1">
              <span
                aria-hidden
                className={cx(
                  'absolute top-0 left-0 right-0 h-7 rounded-[var(--radius-sm)] bg-surface-3 pointer-events-none',
                  pill.ready &&
                    'transition-[transform,opacity] duration-300 ease-[cubic-bezier(.22,.9,.24,1)]',
                )}
                style={{ transform: `translateY(${pill.top}px)`, opacity: pill.visible ? 1 : 0 }}
              />
              {NAV_GROUPS.map((g, gi) => (
                <div key={gi} className={cx(gi > 0 && 'mt-3')}>
                  {g.label && (
                    <div className="relative h-4 mb-0.5">
                      <div className={cx('px-3 text-[11px] font-medium text-muted', fade(collapsed))}>
                        {g.label}
                      </div>
                      {/* Collapsed: a short rule stands in for the group name. */}
                      <div
                        className={cx(
                          'absolute left-3 top-1/2 h-px w-4 bg-line-strong transition-opacity duration-200',
                          collapsed ? 'opacity-100 delay-100' : 'opacity-0',
                        )}
                      />
                    </div>
                  )}
                  <div className="space-y-px">
                    {g.items.map((n) => (
                      <NavLink
                        key={n.to}
                        to={n.to}
                        end={n.end}
                        title={collapsed ? n.label : undefined}
                        onClick={() => titleFor(loc.pathname) !== n.label && sfxTab()}
                        viewTransition
                        className={({ isActive }) =>
                          cx(
                            n.to === '/' && guideWaiting && 'guide-glow',
                            'relative z-[1] flex items-center gap-2.5 h-7 px-3 rounded-[var(--radius-sm)] text-[13px] overflow-hidden transition-colors duration-200',
                            isActive
                              ? 'text-text font-medium'
                              : 'text-text-2 hover:bg-surface-2/60 hover:text-text',
                          )
                        }
                      >
                        {({ isActive }) => (
                          <>
                            <Icon
                              name={n.icon}
                              size={15}
                              className={cx('shrink-0', isActive ? 'text-text' : 'text-muted')}
                            />
                            <span className={fade(collapsed)}>{n.label}</span>
                            {n.to === '/' && guideWaiting && (
                              <span
                                className={cx(
                                  'ml-auto h-4 px-1.5 rounded-full bg-accent text-white text-[10px] font-semibold leading-4',
                                  collapsed && 'absolute right-1 top-1 h-2 w-2 p-0 ml-0',
                                )}
                                title="Start here: a quick guide is waiting"
                              >
                                {collapsed ? '' : 'NEW'}
                              </span>
                            )}
                          </>
                        )}
                      </NavLink>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </nav>

          <MusicDock mini={collapsed} />
          <div className="p-2 border-t border-line space-y-1 shrink-0">
            <button
              onClick={() => (killed ? killSwitch.set(false) : void emergencyStop())}
              className={cx(
                'w-full h-8 px-3 rounded-[var(--radius-sm)] text-[13px] flex items-center gap-2.5 overflow-hidden transition-colors',
                killed ? 'bg-down text-white' : 'text-down hover:bg-down/10',
              )}
              title={
                killed
                  ? 'Click to release (automations stay disarmed until re-armed)'
                  : 'Stop all automated trading immediately'
              }
            >
              <Icon name="stop" size={15} className="shrink-0" />
              <span className={fade(collapsed)}>{killed ? 'Stopped — release' : 'Emergency stop'}</span>
            </button>
            <div className={cx('flex items-center gap-2.5 h-10', collapsed ? 'px-1' : 'px-2.5')}>
              <img
                src={BRAND.avatar}
                alt=""
                className={cx('size-6 rounded-full shrink-0', collapsed && 'hidden')}
              />
              <div className={cx('min-w-0 flex-1', collapsed && 'hidden')}>
                <div className="num text-[12px] text-text truncate" title={me?.address}>
                  {shortAddress(me?.address ?? '')}
                </div>
                <div className="text-[11px] text-muted truncate">
                  {me?.accessBasis === 'holder'
                    ? `${me.session.nftBalance} Chog Genesis`
                    : me?.accessBasis === 'judge'
                      ? 'Judge access'
                      : 'Dev access'}
                </div>
              </div>
              <button
                className="size-7 grid place-items-center rounded-[var(--radius-sm)] text-muted hover:text-text hover:bg-surface-2"
                onClick={() => void signOut()}
                aria-label="Sign out"
                title="Sign out"
              >
                <Icon name="logout" size={15} />
              </button>
            </div>
          </div>
        </aside>

        <header className="flex items-center gap-3 px-5 border-b border-line min-w-0">
          <h1
            className="text-[14px] font-semibold tracking-tight truncate"
            style={{ viewTransitionName: 'page-title' }}
          >
            <span className="crt-glitch" style={glitchPhase(title)}>
              {title}
            </span>
          </h1>
          {me?.accessBasis === 'judge' && (
            <span className="h-5 px-1.5 rounded-[4px] border border-accent/40 bg-accent/10 text-accent text-[11px] font-medium inline-flex items-center">
              JUDGE ACCESS
            </span>
          )}
          {me?.accessBasis === 'dev-allowlist' && (
            <span className="h-5 px-1.5 rounded-[4px] border border-warn/30 bg-warn/8 text-warn text-[11px] font-medium inline-flex items-center">
              DEV ACCESS (NFT gate bypassed)
            </span>
          )}
          <div className="flex-1" />
          <span
            className={cx(
              'inline-flex items-center gap-1.5 text-[12px]',
              ws === 'open' ? 'text-muted' : ws === 'connecting' ? 'text-warn' : 'text-down',
            )}
            title={degraded.length ? `Degraded providers: ${degraded.join(', ')}` : 'Realtime connection'}
          >
            <span
              className={cx(
                'size-[6px] rounded-full',
                ws === 'open'
                  ? degraded.length
                    ? 'bg-warn'
                    : 'bg-up'
                  : ws === 'connecting'
                    ? 'bg-warn'
                    : 'bg-down',
              )}
            />
            {ws === 'open'
              ? degraded.length
                ? 'Degraded'
                : 'Live'
              : ws === 'connecting'
                ? 'Connecting…'
                : 'Offline'}
          </span>
          <span className="w-px h-4 bg-line" />
          <button
            className="size-7 grid place-items-center rounded-[var(--radius-sm)] text-muted hover:text-text hover:bg-surface-2"
            onClick={() =>
              void update((s) => ({ ...s, appearance: { ...s.appearance, theme: dark ? 'light' : 'dark' } }))
            }
            aria-label="Toggle theme"
            title="Toggle theme"
          >
            <Icon name={dark ? 'sun' : 'moon'} size={15} />
          </button>
        </header>

        <main className="min-h-0 min-w-0 overflow-auto" style={{ viewTransitionName: 'page' }}>
          <Suspense fallback={<SkeletonRows rows={10} />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    </>
  );
}
