/**
 * Pure aggregation for the Mint Tracker: ERC-721 mints (Transfer from 0x0) per contract over a
 * rolling one-hour window. No I/O — the worker feeds it logs, the API reads `rows()`.
 *
 *  - RATE: mints in the last 10 minutes and in the last hour.
 *  - AIR: most mints arrive in transactions that hand tokens to many different wallets at once
 *    (an airdrop, not people minting).
 *  - SUS: a thin wallet spread — lots of mints from very few wallets (bots / self-minting).
 */

export const WINDOW_MS = 60 * 60_000;
const RECENT_MS = 10 * 60_000;
/** A transaction sending tokens to at least this many different wallets counts as an airdrop. */
const AIRDROP_RECIPIENTS = 5;

export interface MintEvent {
  contract: string;
  to: string;
  tx: string;
  /** ms epoch (block time). */
  at: number;
}

interface ContractState {
  events: Array<{ at: number; to: string; air: boolean }>;
  firstSeen: number;
}

export interface MintRow {
  contract: string;
  m10: number;
  m60: number;
  wallets: number;
  /** Share of the hour's mints by the single busiest wallet (0..1). */
  topWalletShare: number;
  air: boolean;
  sus: string | null;
  firstSeen: number;
  lastMint: number;
}

export class MintAggregator {
  private byContract = new Map<string, ContractState>();

  /** Adds a batch of mints. Events from the same tx must be in the same batch (airdrop detection). */
  add(events: MintEvent[]) {
    const perTx = new Map<string, Set<string>>();
    for (const e of events) {
      let s = perTx.get(e.tx);
      if (!s) perTx.set(e.tx, (s = new Set()));
      s.add(e.to);
    }
    for (const e of events) {
      const contract = e.contract.toLowerCase();
      let st = this.byContract.get(contract);
      if (!st) this.byContract.set(contract, (st = { events: [], firstSeen: e.at }));
      st.firstSeen = Math.min(st.firstSeen, e.at);
      st.events.push({
        at: e.at,
        to: e.to.toLowerCase(),
        air: (perTx.get(e.tx)?.size ?? 0) >= AIRDROP_RECIPIENTS,
      });
    }
  }

  /** Drops everything older than the window. */
  prune(now: number) {
    const cutoff = now - WINDOW_MS;
    for (const [k, st] of this.byContract) {
      if (st.events.length && st.events[st.events.length - 1]!.at < cutoff) {
        this.byContract.delete(k);
        continue;
      }
      // Events arrive roughly in time order; trim from the front.
      let i = 0;
      while (i < st.events.length && st.events[i]!.at < cutoff) i++;
      if (i) st.events.splice(0, i);
    }
  }

  get size() {
    return this.byContract.size;
  }

  rows(now: number, minMints = 3): MintRow[] {
    const out: MintRow[] = [];
    for (const [contract, st] of this.byContract) {
      const hour = st.events.filter((e) => e.at >= now - WINDOW_MS);
      if (hour.length < minMints) continue;
      const m10 = hour.filter((e) => e.at >= now - RECENT_MS).length;
      const counts = new Map<string, number>();
      for (const e of hour) counts.set(e.to, (counts.get(e.to) ?? 0) + 1);
      const wallets = counts.size;
      const top = Math.max(...counts.values());
      const airShare = hour.filter((e) => e.air).length / hour.length;
      const air = airShare >= 0.5;
      out.push({
        contract,
        m10,
        m60: hour.length,
        wallets,
        topWalletShare: top / hour.length,
        air,
        sus: air ? null : suspicion(hour.length, wallets, top),
        firstSeen: st.firstSeen,
        lastMint: hour[hour.length - 1]!.at,
      });
    }
    return out.sort((a, b) => b.m10 - a.m10 || b.m60 - a.m60);
  }
}

/** Human-readable reason when the wallet spread is too thin to look organic, else null. */
export function suspicion(mints: number, wallets: number, topWalletMints: number): string | null {
  if (mints >= 10 && wallets <= 2)
    return `${mints} mints from only ${wallets} wallet${wallets > 1 ? 's' : ''}`;
  if (mints >= 20 && wallets / mints < 0.1) return `${mints} mints from ${wallets} wallets`;
  if (mints >= 10 && topWalletMints / mints >= 0.6)
    return `one wallet minted ${Math.round((topWalletMints / mints) * 100)}% of the last hour`;
  return null;
}
