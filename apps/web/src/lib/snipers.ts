import { sniperConfigOf, type SniperConfig } from '@chog/shared';
import { get } from './api';

export interface SniperRow {
  id: string;
  data: SniperConfig;
  status: string;
}

/**
 * Server rows with configs upgraded to the current shape (fields added later get their defaults).
 * Every reader of ['automations', 'sniper'] must use this, so the shared cache entry has one shape.
 */
export async function fetchSnipers(): Promise<SniperRow[]> {
  const rows = await get<Array<{ id: string; data: unknown; status: string }>>('/api/automations/sniper');
  return rows.flatMap((r) => {
    const data = sniperConfigOf(r.data);
    return data ? [{ id: r.id, status: r.status, data }] : [];
  });
}
