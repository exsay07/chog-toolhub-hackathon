import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema.js';

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface DbHandle {
  db: Db;
  kind: 'pglite' | 'postgres';
  close: () => Promise<void>;
  ping: () => Promise<boolean>;
}

const here = dirname(fileURLToPath(import.meta.url));
/**
 * Migrations live in apps/server/drizzle. Resolved relative to this module so it works from
 * src/db (tsx), dist/ (bundled index.js) and dist/db (bundled migrate-cli.js); override with MIGRATIONS_DIR.
 */
export const MIGRATIONS_DIR =
  process.env.MIGRATIONS_DIR ??
  [resolve(here, '../../drizzle'), resolve(here, '../drizzle')].find((d) =>
    existsSync(resolve(d, 'meta/_journal.json')),
  ) ??
  resolve(here, '../../drizzle');

export async function openDb(opts: {
  databaseUrl: string;
  pgliteDir: string | 'memory';
  poolMax?: number;
  migrate?: boolean;
}): Promise<DbHandle> {
  if (opts.databaseUrl) {
    const pool = new pg.Pool({
      connectionString: opts.databaseUrl,
      max: opts.poolMax ?? 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 10_000,
    });
    const db = drizzlePg(pool, { schema }) as unknown as Db;
    if (opts.migrate) await migratePg(db as never, { migrationsFolder: MIGRATIONS_DIR });
    return {
      db,
      kind: 'postgres',
      close: () => pool.end(),
      ping: async () => {
        try {
          await pool.query('select 1');
          return true;
        } catch {
          return false;
        }
      },
    };
  }
  let client: PGlite;
  if (opts.pgliteDir === 'memory') client = new PGlite();
  else {
    mkdirSync(opts.pgliteDir, { recursive: true });
    client = new PGlite(opts.pgliteDir);
  }
  const pdb = drizzlePglite(client, { schema });
  if (opts.migrate ?? true) await migratePglite(pdb, { migrationsFolder: MIGRATIONS_DIR });
  const db = pdb as unknown as Db;
  return {
    db,
    kind: 'pglite',
    close: () => client.close(),
    ping: async () => {
      try {
        await client.query('select 1');
        return true;
      } catch {
        return false;
      }
    },
  };
}
