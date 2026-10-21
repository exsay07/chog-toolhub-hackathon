import { loadConfig } from '../config.js';
import { openDb } from './client.js';

const cfg = loadConfig();
const h = await openDb({ databaseUrl: cfg.DATABASE_URL, pgliteDir: cfg.PGLITE_DIR, migrate: true });
console.log(`migrations applied (${h.kind})`);
await h.close();
