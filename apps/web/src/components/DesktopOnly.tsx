import { useSyncExternalStore, type ReactNode } from 'react';
import { BRAND } from '../brand';

/**
 * Phones and small touch tablets get a deliberate notice; the terminal is NOT rendered underneath
 * (no hidden sensitive controls). Width threshold + coarse-pointer heuristic.
 */
const QUERY = '(max-width: 899px), (pointer: coarse) and (hover: none) and (max-width: 1199px)';

function subscribe(cb: () => void) {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
}

export function useIsMobile() {
  return useSyncExternalStore(subscribe, () => window.matchMedia(QUERY).matches);
}

export function DesktopOnly({ children }: { children: ReactNode }) {
  const mobile = useIsMobile();
  if (!mobile) return <>{children}</>;
  return (
    <main
      data-testid="mobile-notice"
      className="fixed inset-0 flex flex-col items-center justify-center text-center px-8 text-white"
      style={{ background: `#11131a url(${BRAND.mobileNoticeBackground}) center/cover no-repeat` }}
    >
      <img src={BRAND.mark} alt="" className="size-16 mb-6 rounded-2xl" />
      <h1 className="font-display text-3xl font-semibold leading-tight max-w-sm">
        Chog Toolhub is currently available on desktop only.
      </h1>
      <p className="mt-4 text-[15px] text-white/80 max-w-sm leading-relaxed">
        We&apos;re working on a mobile experience. Connect from your desktop to access the full trading
        terminal.
      </p>
    </main>
  );
}
