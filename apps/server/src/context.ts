import type { Config } from './config.js';
import type { Db } from './db/client.js';
import type { Logger } from './lib/log.js';
import type { OwnershipVerifier } from './auth/nftGate.js';
import type { SignatureVerifier } from './auth/siwe.js';
import type { MarketService } from './market/service.js';
import type { Discover } from './market/discover.js';
import type { Hub } from './ws/hub.js';
import type { EvmClients } from './chain/evm.js';
import type { SolanaRpc } from './chain/solana.js';
import type { OpenSea } from './nft/opensea.js';
import type { MintTracker } from './nft/mintTracker.js';

export interface AppContext {
  cfg: Config;
  db: Db;
  dbPing: () => Promise<boolean>;
  log: Logger;
  ownership: OwnershipVerifier;
  signatures: SignatureVerifier;
  market: MarketService;
  discover: Discover;
  hub: Hub;
  evm: EvmClients;
  sol: SolanaRpc;
  opensea: OpenSea;
  /** Null when MINTS_ENABLED=false. */
  mints: MintTracker | null;
  /** Optional background components exposed for health/metrics. */
  workers: { tracker?: { stats: unknown }; reconciler?: { stats: unknown }; mints?: { stats: unknown } };
}

export interface AuthedUser {
  id: string;
  address: string;
  sessionId: string;
  accessBasis: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthedUser;
  }
}
