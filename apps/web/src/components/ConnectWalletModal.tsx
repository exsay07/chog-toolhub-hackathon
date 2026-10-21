import { useEffect, useRef, useState } from 'react';
import { renderSVG } from 'uqr';
import { ExternalLink, QrCode, Smartphone } from 'lucide-react';
import type { Eip1193, WalletInfo } from '../lib/wallet/eip6963';
import { notInstalled, type KnownWallet } from '../lib/wallet/catalog';
import { Modal, Notice, cx } from './ui';

/**
 * "Connect wallet": every EVM browser wallet that is installed (any brand that announces itself via
 * EIP-6963), popular wallets that are not installed yet (official download links), and phone wallets
 * through WalletConnect (QR code) when a project id is configured.
 */
export function ConnectWalletModal({
  open,
  onClose,
  wallets,
  busy,
  error,
  walletConnectProjectId,
  onConnect,
}: {
  open: boolean;
  onClose: () => void;
  wallets: WalletInfo[];
  /** Id of the wallet currently signing in (shows "Check your wallet…"). */
  busy: string | null;
  error: React.ReactNode;
  walletConnectProjectId: string | null;
  /** Called with a provider to sign in with; resolves when sign-in finished or failed. */
  onConnect: (provider: Eip1193, id: string) => Promise<void>;
}) {
  const [wc, setWc] = useState<{ uri: string | null; error: string | null } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const more = notInstalled(wallets.map((w) => w.rdns));

  // Closing the dialog cancels a pending phone pairing.
  useEffect(() => {
    if (!open) {
      abort.current?.abort();
      setWc(null);
    }
  }, [open]);

  const startWc = async () => {
    if (!walletConnectProjectId) return;
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    setWc({ uri: null, error: null });
    // The relay never answers a bad / unauthorised project id: give up with a clear message.
    let gotUri = false;
    const timer = window.setTimeout(() => {
      if (gotUri || ctl.signal.aborted) return;
      ctl.abort();
      setWc({
        uri: null,
        error: 'WalletConnect did not respond. Try again in a moment, or use a browser wallet.',
      });
    }, 20_000);
    try {
      const { connectWalletConnect } = await import('../lib/wallet/walletconnect');
      const conn = await connectWalletConnect(
        walletConnectProjectId,
        (uri) => {
          gotUri = true;
          if (!ctl.signal.aborted) setWc({ uri, error: null });
        },
        ctl.signal,
      );
      try {
        await onConnect(conn.provider, 'walletconnect');
      } finally {
        // Sign-in is all we need the phone for: don't leave a live session behind.
        void conn.disconnect();
      }
    } catch (e) {
      if (!ctl.signal.aborted)
        setWc({ uri: null, error: (e as Error).message?.split('\n')[0] || 'Connection failed' });
    } finally {
      window.clearTimeout(timer);
    }
  };

  const tile = (w: KnownWallet) => (
    <span
      className="size-7 rounded-[6px] grid place-items-center text-[13px] font-semibold text-black shrink-0"
      style={{ background: w.color }}
      aria-hidden
    >
      {w.name[0]}
    </span>
  );

  return (
    <Modal open={open} onClose={onClose} title="Connect wallet" width={440}>
      <div className="space-y-4">
        {wc ? (
          <div className="space-y-3 text-center">
            <p className="text-[13px] text-text-2">
              Scan with your phone wallet (MetaMask, Trust, Rainbow, OKX, Zerion…), approve, then sign the
              sign-in message on the phone.
            </p>
            {(wc.uri || !wc.error) && (
              <div className="mx-auto size-[248px] rounded-[var(--radius)] bg-white p-3 grid place-items-center">
                {wc.uri ? (
                  <img
                    alt="WalletConnect QR code"
                    className="size-full [image-rendering:pixelated]"
                    src={`data:image/svg+xml;utf8,${encodeURIComponent(renderSVG(wc.uri, { border: 0 }))}`}
                  />
                ) : (
                  <span className="text-[12px] text-neutral-500">{wc.error ? '—' : 'Preparing…'}</span>
                )}
              </div>
            )}
            {busy === 'walletconnect' && <div className="text-[12px] text-muted">Check your phone…</div>}
            {wc.error && <Notice tone="down">{wc.error}</Notice>}
            <div className="flex justify-center gap-3 text-[12px]">
              {wc.uri && (
                <button
                  className="text-muted hover:text-text"
                  onClick={() => void navigator.clipboard.writeText(wc.uri!)}
                >
                  Copy link
                </button>
              )}
              <button
                className="text-muted hover:text-text"
                onClick={() => {
                  abort.current?.abort();
                  setWc(null);
                }}
              >
                ← Back to wallets
              </button>
            </div>
          </div>
        ) : (
          <>
            <section>
              <h3 className="text-[11px] uppercase tracking-wide text-muted mb-1.5">
                Installed in this browser
              </h3>
              {wallets.length === 0 ? (
                <p className="text-[13px] text-text-2">
                  No browser wallet found. Install one below, or connect a phone wallet.
                </p>
              ) : (
                <div className="border border-line rounded-[var(--radius-sm)] divide-y divide-line overflow-hidden">
                  {wallets.map((w) => (
                    <button
                      key={w.uuid}
                      disabled={!!busy}
                      onClick={() => void onConnect(w.provider, w.uuid)}
                      className="w-full flex items-center gap-3 px-3 h-12 text-left text-[14px] hover:bg-surface-2 disabled:opacity-60 transition-colors"
                    >
                      {w.icon ? (
                        <img src={w.icon} alt="" className="size-7 rounded-[6px]" />
                      ) : (
                        <span className="size-7 rounded-[6px] bg-surface-3" />
                      )}
                      <span className="flex-1 font-medium">{w.name}</span>
                      {busy === w.uuid ? (
                        <span className="text-[12px] text-muted">Check your wallet…</span>
                      ) : (
                        <span className="text-[11px] text-up">Detected</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </section>

            {walletConnectProjectId && (
              <button
                disabled={!!busy}
                onClick={() => void startWc()}
                className="w-full flex items-center gap-3 px-3 h-12 text-left text-[14px] border border-line rounded-[var(--radius-sm)] hover:bg-surface-2 disabled:opacity-60"
              >
                <span className="size-7 rounded-[6px] grid place-items-center bg-[#3b99fc] text-white shrink-0">
                  <Smartphone className="size-4" />
                </span>
                <span className="flex-1">
                  <span className="font-medium">Phone wallet</span>
                  <span className="block text-[11px] text-muted">WalletConnect · scan a QR code</span>
                </span>
                <QrCode className="size-4 text-muted" />
              </button>
            )}

            {more.length > 0 && (
              <section>
                <h3 className="text-[11px] uppercase tracking-wide text-muted mb-1.5">Get a wallet</h3>
                <div className="grid grid-cols-2 gap-1.5">
                  {more.map((w) => (
                    <a
                      key={w.name}
                      href={w.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={cx(
                        'flex items-center gap-2 px-2.5 h-10 rounded-[var(--radius-sm)] border border-line',
                        'text-[13px] hover:bg-surface-2 hover:border-line-strong',
                      )}
                    >
                      {tile(w)}
                      <span className="flex-1 truncate">{w.name}</span>
                      <ExternalLink className="size-3 text-muted shrink-0" />
                    </a>
                  ))}
                </div>
                <p className="text-[11px] text-muted mt-2">
                  After installing, reload this page and the wallet appears under “Installed”.
                </p>
              </section>
            )}
          </>
        )}
        {error && <div>{error}</div>}
        <p className="text-[11px] text-muted">
          Signing in is free and grants no spending permission. Use the wallet that holds your Chog Genesis.
        </p>
      </div>
    </Modal>
  );
}
