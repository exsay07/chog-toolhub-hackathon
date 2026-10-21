import { del as idbDel, get as idbGet, set as idbSet } from 'idb-keyval';
import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  formatUnits,
  getAddress,
  hashTypedData,
  http,
  parseAbi,
  type TypedDataDefinition,
} from 'viem';
import { PERPL_NETWORKS, type PerplNet } from '@chog/shared';
import { ApiError, get, post } from '../api';
import type { Eip1193 } from '../wallet/eip6963';

/**
 * Perpl client pieces that run in the browser: the API key (an Ed25519 key that never leaves this
 * device), wallet-signed key enrollment, and the one-time on-chain setup (exchange account and
 * One-Click Trading). Network traffic goes through our relay (/api/perpl/…) because Perpl does not
 * accept browser connections from other sites; the relay only forwards what is signed here.
 */

/* ------------------------------------------------------------------------- market context ---- */

export interface PerplMarket {
  id: number;
  symbol: string;
  name?: string;
  size_units?: string;
  config: {
    is_open: boolean;
    price_decimals: number;
    size_decimals: number;
    initial_margin: number;
    maker_fee: number;
    taker_fee: number;
  };
  order_ttl_blocks: number;
  state?: { mid: number; bid: number; ask: number; mrk: number };
}
export interface PerplContext {
  instances: Array<{ address: string; min_account_open_amount: string }>;
  tokens: Array<{ symbol: string; decimals: number; address?: string }>;
  markets: PerplMarket[];
}

export const perplContext = (net: PerplNet) => get<PerplContext>(`/api/perpl/${net}/context`);

/** Ticker of a market — mainnet leaves `symbol` empty on some markets, so fall back to its units/name. */
export const marketSymbol = (m: PerplMarket) =>
  (m.symbol || m.size_units || (m.name ?? '').split(' ')[0] || '').toUpperCase();

/** Max leverage a market allows (initial margin 1000 = 10% → 10x), capped at 10x like the original bot. */
export const marketMaxLeverage = (m: PerplMarket) =>
  Math.max(1, Math.min(10, Math.floor((10_000 / Math.max(1, m.config.initial_margin)) * 10) / 10));

/* ---------------------------------------------------------------------------- API key ------ */

export interface PerplKey {
  net: PerplNet;
  address: string;
  apiKey: string;
  /** Non-extractable WebCrypto Ed25519 key: usable for signing, impossible to read out. */
  privateKey: CryptoKey;
  publicKeyHex: string;
  source: 'enrolled' | 'pasted';
  createdAt: number;
}

const keyId = (net: PerplNet, address: string) => `chog.perpl.key.${net}.${address.toLowerCase()}`;

export const loadKey = (net: PerplNet, address: string) =>
  idbGet<PerplKey>(keyId(net, address)).catch(() => undefined);
export const forgetKey = (net: PerplNet, address: string) => idbDel(keyId(net, address));

const hex = (u: Uint8Array) => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16));
export const b64url = (u: Uint8Array) =>
  btoa(String.fromCharCode(...u))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

function ed25519Supported() {
  return typeof crypto?.subtle?.generateKey === 'function';
}

async function newKeyPair() {
  if (!ed25519Supported()) throw new Error('This browser cannot create Ed25519 keys — update it');
  const kp = (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']).catch(() => {
    throw new Error(
      'This browser does not support Ed25519 signing — use a current Chrome, Edge, Firefox or Safari',
    );
  })) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  return { privateKey: kp.privateKey, publicKeyHex: hex(pub) };
}

// PKCS#8 DER prefix for a raw 32-byte Ed25519 seed (RFC 8410).
const PKCS8_PREFIX = unhex('302e020100300506032b657004220420');

/** Key created on app.perpl.xyz/apikeys: token + 64-hex private key. Imported non-extractable. */
export async function importPastedKey(net: PerplNet, address: string, apiKey: string, secretHex: string) {
  const s = secretHex.trim().replace(/^0x/i, '');
  if (/\s\S+\s/.test(secretHex.trim()))
    throw new Error('That looks like a seed phrase. Never paste a seed phrase — paste the API private key');
  if (!/^[0-9a-fA-F]{64}$/.test(s)) throw new Error('The private key must be 64 hex characters');
  if (apiKey.trim().length < 8) throw new Error('Paste the API key token');
  const seed = unhex(s);
  const der = new Uint8Array(PKCS8_PREFIX.length + 32);
  der.set(PKCS8_PREFIX);
  der.set(seed, PKCS8_PREFIX.length);
  try {
    const privateKey = await crypto.subtle.importKey('pkcs8', der, { name: 'Ed25519' }, false, ['sign']);
    const k: PerplKey = {
      net,
      address: getAddress(address),
      apiKey: apiKey.trim(),
      privateKey,
      publicKeyHex: '',
      source: 'pasted',
      createdAt: Date.now(),
    };
    await idbSet(keyId(net, address), k);
    return k;
  } finally {
    seed.fill(0);
    der.fill(0);
  }
}

export async function signEd25519(key: CryptoKey, data: Uint8Array) {
  return new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, data as BufferSource));
}

export function newNonce() {
  return b64url(crypto.getRandomValues(new Uint8Array(16)));
}

/** First frame on the trading socket (websocket.md → API-key sign-in). */
export async function signInFrame(k: PerplKey) {
  const chainId = PERPL_NETWORKS[k.net].chainId;
  const timestamp = String(Date.now());
  const nonce = newNonce();
  const canonical = [chainId, 'trading-ws-signin', timestamp, nonce].join('\n');
  const sig = await signEd25519(k.privateKey, new TextEncoder().encode(canonical));
  return { mt: 29, chain_id: chainId, api_key: k.apiKey, timestamp, nonce, signature: b64url(sig) };
}

/**
 * Creates a trade-scoped API key for the connected wallet: one EIP-712 signature in the wallet
 * (it can trade, it can never withdraw), plus a proof-of-possession signed by the new key.
 */
export async function enrollKey(net: PerplNet, address: string, provider: Eip1193): Promise<PerplKey> {
  const n = PERPL_NETWORKS[net];
  const addr = getAddress(address);
  const { privateKey, publicKeyHex } = await newKeyPair();
  const { typed_data, mac } = await post<{ typed_data: TypedPayload; mac: string }>(
    `/api/perpl/${net}/enroll/payload`,
    {
      chain_id: n.chainId,
      address: addr,
      public_key: '0x' + publicKeyHex,
      scope_mask: 3,
      label: 'Chog Toolhub farm',
    },
  );
  const { EIP712Domain: domainFields = [], ...types } = typed_data.types;
  // Perpl sends integers as hex strings; viem must see them as numbers to hash them canonically.
  const ints = (fields: Array<{ name: string; type: string }>, o: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(o).map(([k, v]) => [
        k,
        /^u?int/.test(fields.find((f) => f.name === k)?.type ?? '') ? BigInt(v as string) : v,
      ]),
    );
  const def = {
    domain: ints(domainFields, typed_data.domain),
    types,
    primaryType: typed_data.primaryType,
    message: ints(types[typed_data.primaryType] ?? [], typed_data.message),
  } as unknown as TypedDataDefinition;
  const wallet = walletClient(net, provider, addr);
  await ensureChain(net, provider);
  const signature = await wallet.signTypedData({ account: addr, ...def } as Parameters<
    typeof wallet.signTypedData
  >[0]);
  const digest = hashTypedData(def);
  const pop = await signEd25519(privateKey, unhex(digest.slice(2)));
  const r = await post<{ api_key: { api_key: string } }>(`/api/perpl/${net}/enroll/key`, {
    chain_id: n.chainId,
    address: addr,
    typed_data,
    mac,
    signature,
    pop_signature: '0x' + hex(pop),
  }).catch((e: unknown) => {
    const st = e instanceof ApiError ? e.status : 0;
    if (st === 404)
      throw new Error('Perpl has no account for this wallet yet — make the first deposit, then try again');
    if (st === 423)
      throw new Error(`Your wallet already has 16 API keys — revoke unused ones at ${n.app}/apikeys`);
    if (st === 400) throw new Error('Perpl refused the key request — try again');
    throw e;
  });
  const k: PerplKey = {
    net,
    address: addr,
    apiKey: r.api_key.api_key,
    privateKey,
    publicKeyHex,
    source: 'enrolled',
    createdAt: Date.now(),
  };
  await idbSet(keyId(net, addr), k);
  return k;
}
interface TypedPayload {
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  domain: Record<string, unknown>;
  message: Record<string, unknown>;
}

/* ------------------------------------------------------------------------ on-chain setup ---- */

const EXCHANGE_ABI = parseAbi([
  'function getAccountByAddr(address) view returns (uint256)',
  'function createAccount(uint256 amountCNS) returns (uint256)',
  'function allowOrderForwarding(bool allow)',
]);
const ERC20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
]);

const chainOf = (net: PerplNet) => {
  const n = PERPL_NETWORKS[net];
  return defineChain({
    id: n.chainId,
    name: net === 'mainnet' ? 'Monad' : 'Monad Testnet',
    nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
    rpcUrls: { default: { http: [n.rpc] } },
  });
};
const pub = (net: PerplNet) =>
  createPublicClient({ chain: chainOf(net), transport: http(PERPL_NETWORKS[net].rpc) });
const walletClient = (net: PerplNet, provider: Eip1193, address: `0x${string}`) =>
  createWalletClient({ chain: chainOf(net), transport: custom(provider), account: address });

async function ensureChain(net: PerplNet, provider: Eip1193) {
  const want = PERPL_NETWORKS[net].chainId;
  const cur = Number(await provider.request({ method: 'eth_chainId' }));
  if (cur === want) return;
  const id = '0x' + want.toString(16);
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: id }] });
  } catch {
    const c = chainOf(net);
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: id,
          chainName: c.name,
          nativeCurrency: c.nativeCurrency,
          rpcUrls: [PERPL_NETWORKS[net].rpc],
        },
      ],
    });
  }
}

export interface AccountInfo {
  accountId: bigint | null;
  collateral: number;
  collateralSymbol: string;
  minDeposit: number;
  gas: number;
}

export async function accountInfo(net: PerplNet, address: string): Promise<AccountInfo> {
  const n = PERPL_NETWORKS[net];
  const pc = pub(net);
  const addr = getAddress(address);
  const ctx = await perplContext(net);
  const [id, bal, gas] = await Promise.all([
    pc
      .readContract({
        address: n.exchange,
        abi: EXCHANGE_ABI,
        functionName: 'getAccountByAddr',
        args: [addr],
      })
      .then((v) => (v > 0n ? v : null))
      .catch(() => null),
    pc.readContract({ address: n.collateral, abi: ERC20, functionName: 'balanceOf', args: [addr] }),
    pc.getBalance({ address: addr }),
  ]);
  return {
    accountId: id,
    collateral: Number(formatUnits(bal, 6)),
    collateralSymbol: ctx.tokens[0]?.symbol ?? 'USD',
    minDeposit: Number(ctx.instances[0]?.min_account_open_amount ?? '10000000') / 1e6,
    gas: Number(formatUnits(gas, 18)),
  };
}

/** Approve + createAccount(deposit): opens the Perpl exchange account with the first deposit. */
export async function createExchangeAccount(
  net: PerplNet,
  address: string,
  provider: Eip1193,
  depositUsd: number,
  onStep?: (s: string) => void,
) {
  const n = PERPL_NETWORKS[net];
  const addr = getAddress(address);
  const amount = BigInt(Math.round(depositUsd * 1e6));
  await ensureChain(net, provider);
  const wc = walletClient(net, provider, addr);
  const pc = pub(net);
  const allowance = await pc.readContract({
    address: n.collateral,
    abi: ERC20,
    functionName: 'allowance',
    args: [addr, n.exchange],
  });
  if (allowance < amount) {
    onStep?.('Approve the deposit in your wallet…');
    const h = await wc.writeContract({
      address: n.collateral,
      abi: ERC20,
      functionName: 'approve',
      args: [n.exchange, amount],
    });
    await pc.waitForTransactionReceipt({ hash: h });
  }
  onStep?.('Confirm account creation in your wallet…');
  const h = await wc.writeContract({
    address: n.exchange,
    abi: EXCHANGE_ABI,
    functionName: 'createAccount',
    args: [amount],
  });
  const r = await pc.waitForTransactionReceipt({ hash: h });
  if (r.status !== 'success') throw new Error('Account creation failed on-chain');
}

/** One-Click Trading: lets Perpl forward the API orders of this account (never withdrawals). */
export async function enableForwarding(net: PerplNet, address: string, provider: Eip1193) {
  const n = PERPL_NETWORKS[net];
  const addr = getAddress(address);
  await ensureChain(net, provider);
  const h = await walletClient(net, provider, addr).writeContract({
    address: n.exchange,
    abi: EXCHANGE_ABI,
    functionName: 'allowOrderForwarding',
    args: [true],
  });
  const r = await pub(net).waitForTransactionReceipt({ hash: h });
  if (r.status !== 'success') throw new Error('Enabling One-Click Trading failed on-chain');
}

/* ------------------------------------------------------------------------ relay sockets ---- */

export function relayUrl(net: PerplNet, kind: 'trading' | 'market-data') {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/api/perpl/${net}/ws/${kind}`;
}
