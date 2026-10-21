import { del as idbDel, get as idbGet, set as idbSet } from 'idb-keyval';
import bs58 from 'bs58';

/**
 * Bulk (perps alongside Solana) from the browser. The trading account is the user's Solana wallet
 * (Phantom); it signs ONE message that authorises an agent key. The agent is an Ed25519 key created
 * here as a non-extractable WebCrypto key — it can place and cancel orders for the account, never
 * move funds out. Bulk's API allows browser calls (CORS *), so no relay is needed.
 * Wire format / signing: bulk-keychain-wasm (official), verified on testnet (scripts/bulk-testnet-probe.mjs).
 */

export const BULK_NETWORKS = {
  mainnet: {
    label: 'Mainnet',
    api: 'https://mainnet-api1.bulk.trade/api/v1',
    ws: 'wss://mainnet-ws1.bulk.trade',
    app: 'https://bulk.trade',
  },
  testnet: {
    label: 'Testnet',
    api: 'https://exchange-api.bulk.trade/api/v1',
    ws: 'wss://exchange-ws1.bulk.trade',
    app: 'https://bulk.trade',
  },
} as const;
export type BulkNet = keyof typeof BULK_NETWORKS;

/* ------------------------------------------------------------------------ signing library ---- */

type Keychain = typeof import('bulk-keychain-wasm');
let kc: Promise<Keychain> | null = null;
/** Loads the official signing library (WASM) once, on first use. */
export function keychain(): Promise<Keychain> {
  kc ??= (async () => {
    const [mod, url] = await Promise.all([
      import('bulk-keychain-wasm'),
      import('bulk-keychain-wasm/bulk_keychain_wasm_bg.wasm?url'),
    ]);
    await mod.default({ module_or_path: url.default });
    return mod;
  })();
  return kc;
}

/* ---------------------------------------------------------------------------- markets ---- */

export interface BulkMarket {
  symbol: string;
  status: string;
  tickSize: number;
  sizeIncrement: number;
  sizeDecimals: number;
  minNotional: number;
  maxLeverage: number;
}

export async function bulkMarkets(net: BulkNet): Promise<BulkMarket[]> {
  const r = await fetch(`${BULK_NETWORKS[net].api}/exchangeInfo`, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`Bulk is unavailable (${r.status})`);
  return r.json();
}

/* ---------------------------------------------------------------------------- account ---- */

export interface BulkPosition {
  symbol: string;
  size: number;
  price: number;
  unrealizedPnl: number;
}
export interface BulkOpenOrder {
  symbol: string;
  orderId: string;
  price: number;
  size: number;
  reduceOnly: boolean;
}
export interface BulkAccount {
  authorizedAgentWallets?: string[];
  margin: {
    totalMargin: number;
    availableMargin: number;
    realizedPnl: number;
    unrealizedPnl: number;
    fees: number;
    funding: number;
  };
  positions: BulkPosition[];
  openOrders: BulkOpenOrder[];
}

/** Unsigned account query. Returns null when the account has never been funded. */
export async function bulkAccount(net: BulkNet, user: string): Promise<BulkAccount | null> {
  const r = await fetch(`${BULK_NETWORKS[net].api}/account`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'fullAccount', user }),
    signal: AbortSignal.timeout(10_000),
  });
  if (r.status === 429) throw new Error('Bulk rate limit — slowing down');
  if (!r.ok) return null;
  const j = (await r.json()) as Array<{ fullAccount?: BulkAccount }>;
  const a = j?.[0]?.fullAccount;
  if (!a) return null;
  // Numbers can come back as strings on some fields; normalise what we use.
  const n = (v: unknown) => Number(v ?? 0);
  return {
    ...a,
    margin: {
      totalMargin: n(a.margin?.totalMargin),
      availableMargin: n(a.margin?.availableMargin),
      realizedPnl: n(a.margin?.realizedPnl),
      unrealizedPnl: n(a.margin?.unrealizedPnl),
      fees: n(a.margin?.fees),
      funding: n(a.margin?.funding),
    },
    positions: (a.positions ?? []).map((p) => ({
      ...p,
      size: n(p.size),
      price: n(p.price),
      unrealizedPnl: n(p.unrealizedPnl),
    })),
    openOrders: (a.openOrders ?? []).map((o) => ({ ...o, price: n(o.price), size: n(o.size) })),
  };
}

/* ------------------------------------------------------------------------------ agent ---- */

export interface BulkAgent {
  net: BulkNet;
  owner: string;
  pubkey: string;
  /** Non-extractable Ed25519 key: signs orders, cannot be read out of the browser. */
  privateKey: CryptoKey;
  createdAt: number;
}

const agentId = (net: BulkNet, owner: string) => `chog.bulk.agent.${net}.${owner}`;
export const loadAgent = (net: BulkNet, owner: string) =>
  idbGet<BulkAgent>(agentId(net, owner)).catch(() => undefined);
export const forgetAgent = (net: BulkNet, owner: string) => idbDel(agentId(net, owner));

let lastNonce = 0n;
/** Unique, increasing nanosecond nonce (decimal string, as the library expects). */
export function nonce() {
  const now = BigInt(Date.now()) * 1_000_000n;
  lastNonce = now > lastNonce ? now : lastNonce + 1n;
  return lastNonce.toString();
}

export interface SignedTx {
  actions: unknown;
  nonce: unknown;
  account: string;
  signer: string;
  signature: string;
}

/** POST /order; returns the per-action statuses. */
export async function submit(
  net: BulkNet,
  tx: SignedTx,
  mode?: 'base58',
): Promise<Array<Record<string, Record<string, unknown>>>> {
  const r = await fetch(`${BULK_NETWORKS[net].api}/order`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(mode ? { 'x-bulk-sig-mode': mode } : {}) },
    body: JSON.stringify({
      ...tx,
      actions: typeof tx.actions === 'string' ? JSON.parse(tx.actions) : tx.actions,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (r.status === 429) throw new Error('Bulk rate limit — slowing down');
  const text = await r.text();
  let j: {
    status?: string;
    response?: { data?: { statuses?: Array<Record<string, Record<string, unknown>>> } };
    error?: string;
  };
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error(`Bulk answered ${r.status}: ${text.slice(0, 120)}`);
  }
  const st = j.response?.data?.statuses;
  if (!r.ok || !st) throw new Error(j.error || `Bulk answered ${r.status}: ${text.slice(0, 120)}`);
  return st;
}

/** Signs a prepared message with the agent key and finalises it into a transaction. */
export async function agentSign(
  agent: BulkAgent,
  prepared: { messageBytes: Uint8Array; finalize: (sig: string) => SignedTx },
) {
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: 'Ed25519' }, agent.privateKey, prepared.messageBytes as BufferSource),
  );
  return prepared.finalize(bs58.encode(sig));
}

/* ----------------------------------------------------------------------------- Phantom ---- */

interface SolanaWallet {
  isPhantom?: boolean;
  publicKey?: { toString(): string } | null;
  connect(): Promise<{ publicKey: { toString(): string } }>;
  signMessage(msg: Uint8Array, display?: 'utf8' | 'hex'): Promise<{ signature: Uint8Array }>;
}

export function phantom(): SolanaWallet | null {
  const w = window as unknown as { phantom?: { solana?: SolanaWallet }; solana?: SolanaWallet };
  return w.phantom?.solana ?? w.solana ?? null;
}

export async function connectPhantom(): Promise<string> {
  const p = phantom();
  if (!p) throw new Error('Phantom is not installed — get it at phantom.com, then reload this page');
  const r = await p.connect();
  return r.publicKey.toString();
}

/**
 * Creates the agent key and has the Solana wallet authorise it (one message signature; the
 * wallet shows it as text). Bulk only accepts this for a funded account, so testnet claims the faucet first.
 */
export async function registerAgent(net: BulkNet, owner: string): Promise<BulkAgent> {
  const p = phantom();
  if (!p) throw new Error('Phantom is not installed');
  const k = await keychain();
  const kp = (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const pubkey = bs58.encode(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)));
  const prepared = k.prepareAgentWallet(pubkey, false, {
    signatureDomain: net,
    account: owner,
    signer: owner,
    nonce: nonce(),
  });
  const w = k.prepareWalletMessage(prepared, 'base58');
  const { signature } = await p.signMessage(w.messageBytes, 'utf8');
  const tx = k.finalizeWalletMessage(w, bs58.encode(signature)) as SignedTx;
  const st = await submit(net, tx, 'base58');
  const fail = st[0]?.agentWalletFailed ?? st[0]?.error;
  if (fail || !st[0]?.agentWallet)
    throw new Error(`Bulk refused the agent: ${String(fail?.message ?? JSON.stringify(st[0]))}`);
  const agent: BulkAgent = { net, owner, pubkey, privateKey: kp.privateKey, createdAt: Date.now() };
  await idbSet(agentId(net, owner), agent);
  return agent;
}

/** Testnet only: 1 000 test USD, once per 24 h, requested by the agent for the account. */
export async function claimFaucet(agent: BulkAgent) {
  const k = await keychain();
  const tx = await agentSign(
    agent,
    k.prepareFaucet({
      signatureDomain: agent.net,
      account: agent.owner,
      signer: agent.pubkey,
      nonce: nonce(),
    }),
  );
  const st = await submit(agent.net, tx);
  const ok = st[0]?.deposit;
  if (!ok) throw new Error(String(st[0]?.depositFailed?.message ?? 'Faucet refused the request'));
  return Number(ok.amount ?? 0);
}
