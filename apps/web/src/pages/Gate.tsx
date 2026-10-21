import { useState, type CSSProperties } from 'react';
import { useQuery } from '@tanstack/react-query';
import { shortAddress } from '@chog/shared';
import { useAuth } from '../lib/auth';
import { get, ApiError } from '../lib/api';
import { useInjectedWallets, type Eip1193 } from '../lib/wallet/eip6963';
import { ConnectWalletModal } from '../components/ConnectWalletModal';
import { Guide } from '../components/Guide';
import { fmtCompact } from '../lib/nft';
import { Notice, ExtLink } from '../components/ui';
import { ChogTv } from '../components/ChogTv';
import { GlyphNoise } from '../components/GlyphNoise';
import { MusicDock } from '../components/MusicDock';

/** Per-line phase offsets so every text line flickers/twitches on its own, never in sync. */
const glitch = (i: number): CSSProperties =>
  ({
    '--d': `${-((i * 0.73) % 2.4).toFixed(2)}s`,
    '--d2': `${-((i * 1.91) % 5.5).toFixed(2)}s`,
  }) as CSSProperties;

interface GateInfo {
  collection: string;
  contract: string;
  network: string;
  chainId: number;
  canonical: boolean;
  devAllowlistActive: boolean;
  walletConnectProjectId?: string | null;
  collectionUrl?: string;
  /** A reviewer pass is open (hackathon judges sign in with a code instead of the NFT). */
  judgeAccess?: boolean;
  floor?: { price: number; symbol: string } | null;
}

export function Gate() {
  const { signIn } = useAuth();
  const wallets = useInjectedWallets();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<{ msg: string; code?: string } | null>(null);
  const [picker, setPicker] = useState(false);
  const [tour, setTour] = useState(false);
  const [judgeOpen, setJudgeOpen] = useState(false);
  const [judgeCode, setJudgeCode] = useState('');
  const gate = useQuery({ queryKey: ['gate'], queryFn: () => get<GateInfo>('/api/gate') });

  const connect = async (provider: Eip1193, id: string) => {
    setBusy(id);
    setErr(null);
    try {
      await signIn(provider, judgeOpen && judgeCode.trim() ? judgeCode.trim() : undefined);
    } catch (e) {
      const code = e instanceof ApiError ? e.code : undefined;
      const msg =
        (e as { code?: number }).code === 4001
          ? 'Signature request was rejected in your wallet.'
          : (e as Error).message;
      setErr({ msg, code });
    } finally {
      setBusy(null);
    }
  };

  const errorNotice = err && (
    <Notice tone="down">
      {err.code === 'BAD_JUDGE_CODE' ? (
        'That judge access code is not valid (or the judging period has ended).'
      ) : err.code === 'NOT_HOLDER' ? (
        <>
          This wallet doesn&apos;t hold a Chog Genesis NFT. Get one on{' '}
          <ExtLink href="https://opensea.io/collection/chog-genesis">OpenSea</ExtLink>, or connect the wallet
          that does.
        </>
      ) : err.code === 'GATE_UNVERIFIABLE' ? (
        'We could not verify NFT ownership right now (Monad RPC unavailable). Access is denied rather than guessed — please retry shortly.'
      ) : (
        err.msg
      )}
    </Notice>
  );

  return (
    <div className="min-h-full flex flex-col relative">
      <GlyphNoise />
      <header className="relative z-10 h-14 px-6 flex items-center gap-2.5">
        <span className="crt-text crt-glitch text-[22px] leading-none" style={glitch(0)}>
          CHOG TOOLHUB
        </span>
      </header>

      <main className="relative z-10 flex-1 flex items-center justify-center px-6 pb-10 pt-2">
        <div className="w-[400px]">
          <div className="flex justify-center mb-2">
            <ChogTv size={window.innerHeight > 820 ? 300 : 240} />
          </div>
          <div className="crt-text crt-scan text-center mt-4">
            <h1 className="crt-glitch text-[46px] leading-none" style={glitch(1)}>
              SIGN IN
            </h1>
            <p className="crt-dim crt-glitch text-[19px] leading-snug mt-3" style={glitch(2)}>
              Holder access · connect the wallet that holds your Chog Genesis NFT and sign a message. Signing
              is free and grants no spending permission.
            </p>
          </div>

          <button
            onClick={() => (setErr(null), setPicker(true))}
            className="crt-text mt-6 w-full h-14 rounded-[var(--radius-sm)] border border-accent/60 bg-accent/15 hover:bg-accent/25 text-[26px] tracking-wide transition-colors"
          >
            <span className="crt-glitch" style={glitch(3)}>
              CONNECT WALLET
            </span>
          </button>

          {/* Not a holder yet: see what's inside, then get the pass. */}
          <div className="crt-text mt-2.5 grid grid-cols-2 gap-2.5">
            <button
              onClick={() => setTour(true)}
              className="h-11 rounded-[var(--radius-sm)] border border-line-strong bg-bg/70 hover:bg-surface-2 text-[20px] tracking-wide transition-colors"
            >
              <span className="crt-glitch" style={glitch(10)}>
                TAKE A TOUR
              </span>
            </button>
            <a
              href={gate.data?.collectionUrl ?? 'https://opensea.io/collection/chog-genesis'}
              target="_blank"
              rel="noopener noreferrer"
              className="h-11 rounded-[var(--radius-sm)] border border-line-strong bg-bg/70 hover:bg-surface-2 text-[20px] tracking-wide transition-colors flex flex-col items-center justify-center leading-none"
            >
              <span className="crt-glitch" style={glitch(11)}>
                GET CHOG GENESIS ↗
              </span>
              {gate.data?.floor && (
                <span className="crt-dim text-[15px] mt-0.5">
                  floor {fmtCompact(gate.data.floor.price)} {gate.data.floor.symbol}
                </span>
              )}
            </a>
          </div>

          {gate.data?.judgeAccess && (
            <div className="crt-text mt-3 text-center">
              {judgeOpen ? (
                <div className="flex items-center gap-2">
                  <input
                    autoFocus
                    aria-label="Judge access code"
                    placeholder="Judge access code"
                    value={judgeCode}
                    onChange={(e) => setJudgeCode(e.target.value)}
                    onKeyDown={(e) =>
                      e.key === 'Enter' && judgeCode.trim() && (setErr(null), setPicker(true))
                    }
                    spellCheck={false}
                    autoComplete="off"
                    className="flex-1 h-10 px-3 rounded-[var(--radius-sm)] bg-bg/85 border border-accent/50 text-[19px] tracking-wide outline-none focus:border-accent"
                  />
                  <button
                    onClick={() => (setErr(null), setPicker(true))}
                    disabled={!judgeCode.trim()}
                    className="h-10 px-3 rounded-[var(--radius-sm)] border border-accent/60 bg-accent/15 hover:bg-accent/25 text-[19px] disabled:opacity-50"
                  >
                    CONTINUE
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setJudgeOpen(true)}
                  className="crt-dim text-[17px] underline underline-offset-4 decoration-dotted hover:text-text"
                >
                  Hackathon judge? Enter your access code
                </button>
              )}
              {judgeOpen && (
                <p className="crt-dim text-[15px] mt-1.5">
                  Then connect any wallet and sign — no NFT or funds needed.
                </p>
              )}
            </div>
          )}

          {err && !picker && <div className="mt-3">{errorNotice}</div>}

          {gate.data && (
            <div className="crt-text mt-5 text-[17px] leading-snug space-y-0.5 text-center">
              <div className="crt-dim crt-glitch" style={glitch(5)}>
                Access requires {gate.data.collection} on Monad ·{' '}
                <ExtLink href={`https://monadscan.com/address/${gate.data.contract}`}>
                  {shortAddress(gate.data.contract, 4)}
                </ExtLink>
              </div>
              {!gate.data.canonical && (
                <div className="text-warn crt-glitch" style={glitch(6)}>
                  Non-default gate contract configured.
                </div>
              )}
              {gate.data.devAllowlistActive && (
                <div className="text-warn crt-glitch" style={glitch(7)}>
                  Development allowlist active — not a production configuration.
                </div>
              )}
            </div>
          )}
        </div>
      </main>

      <footer className="crt-text relative z-10 px-6 py-3 border-t border-line text-[17px] flex justify-between">
        <span className="crt-dim crt-glitch" style={glitch(8)}>
          No Chog Toolhub trading commission. Network and DEX fees still apply.
        </span>
        <span className="crt-dim crt-glitch" style={glitch(9)}>
          Trading is risky. Nothing here is financial advice.
        </span>
      </footer>

      <Guide
        open={tour}
        onClose={() => setTour(false)}
        cta={
          <a
            href={gate.data?.collectionUrl ?? 'https://opensea.io/collection/chog-genesis'}
            target="_blank"
            rel="noopener noreferrer"
            className="h-9 px-3 rounded-[var(--radius-sm)] border border-accent/50 bg-accent/12 hover:bg-accent/25 text-[13px] text-text inline-flex items-center gap-1.5"
          >
            Get Chog Genesis
            {gate.data?.floor && (
              <span className="text-muted num">
                · floor {fmtCompact(gate.data.floor.price)} {gate.data.floor.symbol}
              </span>
            )}
            <span aria-hidden>↗</span>
          </a>
        }
      />

      <ConnectWalletModal
        open={picker}
        onClose={() => !busy && setPicker(false)}
        wallets={wallets}
        busy={busy}
        error={errorNotice}
        walletConnectProjectId={gate.data?.walletConnectProjectId ?? null}
        onConnect={connect}
      />

      {/* Bottom-left corner, sitting 8px above the footer line. */}
      <div className="fixed left-0 bottom-[50px] z-20 w-[var(--sidebar-w)]">
        <MusicDock />
      </div>
    </div>
  );
}
