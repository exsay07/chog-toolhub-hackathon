import { zMintTask, type MintTask } from '@chog/shared';
import { get } from './api';

export interface MintRow {
  id: string;
  data: MintTask;
  status: string;
}

/** Mint tasks with configs upgraded to the current shape (fields added later get their defaults). */
export async function fetchMints(): Promise<MintRow[]> {
  const rows = await get<Array<{ id: string; data: unknown; status: string }>>('/api/automations/mint');
  return rows.flatMap((r) => {
    const p = zMintTask.safeParse(r.data);
    return p.success ? [{ id: r.id, status: r.status, data: p.data }] : [];
  });
}

/** Wallets a task mints from (main when none are picked). */
export const mintWallets = (t: MintTask): Array<string | null> => (t.wallets.length ? t.wallets : [null]);
