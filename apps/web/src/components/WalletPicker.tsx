import { shortAddress } from '@chog/shared';
import { useVault } from '../lib/vault/useVault';
import { walletsOf } from '../lib/vault/vault';
import { cx } from './ui';

/**
 * Pick which vault EVM wallets run a task. `value` holds addresses; empty means the main wallet only.
 * Renders nothing when the vault has no extra wallets (then the main wallet is the only choice).
 */
export function WalletPicker({
  value,
  onChange,
  label = 'Wallets',
}: {
  value: string[];
  onChange: (v: string[]) => void;
  label?: string;
}) {
  const { vault } = useVault();
  const all = walletsOf(vault);
  if (all.length < 2) return null;
  const main = all[0]!.address.toLowerCase();
  const sel = new Set(value.length ? value.map((a) => a.toLowerCase()) : [main]);
  const toggle = (a: string) => {
    const next = new Set(sel);
    if (next.has(a)) next.delete(a);
    else next.add(a);
    if (next.size === 0) next.add(main);
    // Main alone is stored as "no selection" (the default).
    onChange(
      next.size === 1 && next.has(main)
        ? []
        : all.map((w) => w.address).filter((x) => next.has(x.toLowerCase())),
    );
  };
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-[12px] font-medium text-text-2">
        <span>
          {label} <span className="text-muted font-normal">({sel.size} selected)</span>
        </span>
        <span className="flex gap-2 text-[11px] font-normal">
          <button
            type="button"
            className="text-muted hover:text-text"
            onClick={() => onChange(all.map((w) => w.address))}
          >
            All
          </button>
          <button type="button" className="text-muted hover:text-text" onClick={() => onChange([])}>
            Main only
          </button>
        </span>
      </div>
      <div className="flex flex-wrap gap-1" role="group" aria-label={label}>
        {all.map((w) => {
          const on = sel.has(w.address.toLowerCase());
          return (
            <button
              key={w.address}
              type="button"
              aria-pressed={on}
              title={w.address}
              onClick={() => toggle(w.address.toLowerCase())}
              className={cx(
                'h-6 px-2 rounded-[4px] border text-[11px]',
                on ? 'border-accent/70 bg-accent/15 text-text' : 'border-line text-muted hover:text-text',
              )}
            >
              {w.label} <span className="num opacity-70">{shortAddress(w.address, 3)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
