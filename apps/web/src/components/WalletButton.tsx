import { useState } from 'react';
import { shortAddress } from '@chog/shared';
import { useVault } from '../lib/vault/useVault';
import { lock } from '../lib/vault/vault';
import { Icon } from './Icon';
import { cx } from './ui';
import { VaultModal } from './VaultModal';

/**
 * The memecoin trading wallet (local encrypted vault): set up / unlock / lock. It lives only in the
 * Token Terminal — that wallet exists for trading tokens there.
 */
export function WalletButton({
  open,
  onOpenChange,
}: {
  open?: boolean;
  onOpenChange?: (v: boolean) => void;
}) {
  const { vault, unlocked } = useVault();
  const [own, setOwn] = useState(false);
  const isOpen = open ?? own;
  const setOpen = onOpenChange ?? setOwn;
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={cx(
          'h-7 px-2.5 rounded-[var(--radius-sm)] border text-[12px] font-medium inline-flex items-center gap-1.5 transition-colors whitespace-nowrap',
          unlocked
            ? 'border-up/30 text-up hover:bg-up/8'
            : vault === null
              ? 'border-accent/40 text-text bg-accent/10 hover:bg-accent/15'
              : 'border-line-strong text-text hover:bg-surface-2',
        )}
        title="Trading wallet (local encrypted vault)"
      >
        <Icon name={unlocked ? 'unlock' : 'lock'} size={13} />
        {vault === null
          ? 'Set up trading wallet'
          : unlocked
            ? `Trading ${shortAddress(vault?.evmAddress ?? '')}`
            : 'Unlock trading wallet'}
      </button>
      {unlocked && (
        <button
          className="h-7 px-2 rounded-[var(--radius-sm)] text-[12px] text-muted hover:text-text hover:bg-surface-2"
          onClick={lock}
          title="Lock the trading wallet"
        >
          Lock
        </button>
      )}
      <VaultModal open={isOpen} onClose={() => setOpen(false)} />
    </>
  );
}
