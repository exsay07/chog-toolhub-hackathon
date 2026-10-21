import { del, get as idbGet, set as idbSet } from 'idb-keyval';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { Keypair } from '@solana/web3.js';
import { base58Decode, base58Encode } from '@chog/shared';
import { decryptVault, encryptVault, type EncryptedVault, type VaultSecrets } from './crypto';

const KEY = 'chog.vault.v1';

/**
 * Unlocked key material lives only in this module-scope closure — never in React state, the
 * query cache, localStorage, logs or network requests. Locking drops the references.
 */
let unlocked: {
  evm: PrivateKeyAccount;
  sol: Keypair;
  extras: Array<{ account: PrivateKeyAccount; label: string }>;
} | null = null;
let autoLockTimer: number | null = null;
let autoLockMs = 15 * 60_000;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function onVaultChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

export async function loadVault(): Promise<EncryptedVault | null> {
  try {
    return ((await idbGet(KEY)) as EncryptedVault | undefined) ?? null;
  } catch {
    return null;
  }
}

export async function generateSecrets(): Promise<
  VaultSecrets & { evmAddress: string; solanaAddress: string }
> {
  const evmPrivateKey = generatePrivateKey();
  const kp = await Keypair.generate();
  return {
    evmPrivateKey,
    solanaSecretKey: btoa(String.fromCharCode(...kp.secretKey)),
    evmAddress: privateKeyToAccount(evmPrivateKey).address,
    solanaAddress: kp.publicKey.toBase58(),
  };
}

/** Parses user-supplied keys for import. Accepts Solana secret as base58 (Phantom export) or JSON array. */
export async function parseImport(
  evmKey: string,
  solKey: string,
): Promise<VaultSecrets & { evmAddress: string; solanaAddress: string }> {
  const e = evmKey.trim().startsWith('0x') ? evmKey.trim() : `0x${evmKey.trim()}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(e)) throw new Error('EVM private key must be 32 bytes hex');
  let sk: Uint8Array | null;
  const s = solKey.trim();
  if (s.startsWith('[')) sk = Uint8Array.from(JSON.parse(s) as number[]);
  else sk = base58Decode(s);
  if (!sk || sk.length !== 64) throw new Error('Solana secret key must be 64 bytes (base58 or JSON array)');
  const kp = await Keypair.fromSecretKey(sk); // validates that the public half matches
  return {
    evmPrivateKey: e as `0x${string}`,
    solanaSecretKey: btoa(String.fromCharCode(...kp.secretKey)),
    evmAddress: privateKeyToAccount(e as `0x${string}`).address,
    solanaAddress: kp.publicKey.toBase58(),
  };
}

export async function saveNewVault(s: Awaited<ReturnType<typeof generateSecrets>>, password: string) {
  const enc = await encryptVault(
    { evmPrivateKey: s.evmPrivateKey, solanaSecretKey: s.solanaSecretKey },
    password,
    s,
  );
  await idbSet(KEY, enc);
  emit();
  return enc;
}

export async function unlock(password: string) {
  const v = await loadVault();
  if (!v) throw new Error('No trading wallet on this device');
  const sec = await decryptVault(v, password);
  const evm = privateKeyToAccount(sec.evmPrivateKey);
  const sol = await Keypair.fromSecretKey(Uint8Array.from(atob(sec.solanaSecretKey), (c) => c.charCodeAt(0)));
  if (evm.address !== v.evmAddress || sol.publicKey.toBase58() !== v.solanaAddress)
    throw new Error('Vault integrity check failed');
  const extras = (sec.extraEvm ?? []).map((x) => ({ account: privateKeyToAccount(x.key), label: x.label }));
  if (
    extras.length !== (v.extras ?? []).length ||
    extras.some((x, i) => x.account.address !== v.extras![i]!.address)
  )
    throw new Error('Vault integrity check failed (extra wallets)');
  unlocked = { evm, sol, extras };
  touch();
  emit();
}

export function lock() {
  unlocked = null;
  if (autoLockTimer) clearTimeout(autoLockTimer);
  autoLockTimer = null;
  emit();
}

/** Extends the auto-lock deadline (called on user activity / signing). */
export function touch() {
  if (!unlocked) return;
  if (autoLockTimer) clearTimeout(autoLockTimer);
  autoLockTimer = window.setTimeout(lock, autoLockMs);
}

export function setAutoLockMinutes(m: number) {
  autoLockMs = Math.max(1, Math.min(240, m)) * 60_000;
  touch();
}

export const isUnlocked = () => unlocked !== null;

/** Signing handles. Callers must not persist these. */
export function evmSigner(): PrivateKeyAccount {
  return evmSignerFor(null);
}

export function solanaSigner(): Keypair {
  if (!unlocked) throw new Error('Trading wallet is locked');
  touch();
  return unlocked.sol;
}

/** Deliberate export flow: requires the password again even when unlocked. */
export async function exportSecrets(password: string) {
  const v = await loadVault();
  if (!v) throw new Error('No vault');
  const s = await decryptVault(v, password);
  return {
    evmPrivateKey: s.evmPrivateKey,
    solanaSecretKeyBase58: base58Encode(Uint8Array.from(atob(s.solanaSecretKey), (c) => c.charCodeAt(0))),
    extraEvm: (s.extraEvm ?? []).map((x) => ({
      label: x.label,
      address: privateKeyToAccount(x.key).address,
      key: x.key,
    })),
  };
}

/* ------------------------------------------------------------------- multi-wallet ---- */

export const MAX_EXTRA_WALLETS = 20;

export interface EvmWallet {
  address: `0x${string}`;
  label: string;
  primary: boolean;
}

/** Every EVM wallet of the vault (public data — available while locked too). */
export function walletsOf(v: EncryptedVault | null | undefined): EvmWallet[] {
  if (!v) return [];
  return [
    { address: v.evmAddress as `0x${string}`, label: 'Main', primary: true },
    ...(v.extras ?? []).map((x) => ({ address: x.address as `0x${string}`, label: x.label, primary: false })),
  ];
}

/** Signer for one of the vault's EVM wallets; no address = the main wallet. */
export function evmSignerFor(address?: string | null): PrivateKeyAccount {
  if (!unlocked) throw new Error('Trading wallet is locked');
  touch();
  if (!address || address.toLowerCase() === unlocked.evm.address.toLowerCase()) return unlocked.evm;
  const x = unlocked.extras.find((e) => e.account.address.toLowerCase() === address.toLowerCase());
  if (!x) throw new Error(`Wallet ${address} is not in this vault`);
  return x.account;
}

/** Re-encrypts the vault with a changed extra-wallet list (password required, keys never leave here). */
async function rewriteExtras(
  password: string,
  change: (
    list: Array<{ key: `0x${string}`; label: string }>,
  ) => Array<{ key: `0x${string}`; label: string }>,
) {
  const v = await loadVault();
  if (!v) throw new Error('No trading wallet on this device');
  const sec = await decryptVault(v, password);
  const extraEvm = change(sec.extraEvm ?? []);
  if (extraEvm.length > MAX_EXTRA_WALLETS) throw new Error(`At most ${MAX_EXTRA_WALLETS} extra wallets`);
  const enc = await encryptVault({ ...sec, extraEvm }, password, v);
  enc.extras = extraEvm.map((x) => ({ address: privateKeyToAccount(x.key).address, label: x.label }));
  enc.createdAt = v.createdAt;
  await idbSet(KEY, enc);
  if (unlocked)
    unlocked = {
      ...unlocked,
      extras: extraEvm.map((x) => ({ account: privateKeyToAccount(x.key), label: x.label })),
    };
  emit();
  return walletsOf(enc);
}

/** Adds `count` new wallets, or one imported key. Labels default to W2, W3, … */
export function addExtraWallets(
  password: string,
  opts: { count?: number; importKey?: string; label?: string },
) {
  return rewriteExtras(password, (list) => {
    const keys: `0x${string}`[] = [];
    if (opts.importKey) {
      const k = opts.importKey.trim().startsWith('0x') ? opts.importKey.trim() : `0x${opts.importKey.trim()}`;
      if (!/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error('EVM private key must be 32 bytes hex');
      keys.push(k as `0x${string}`);
    } else
      for (let i = 0; i < Math.max(1, Math.min(10, opts.count ?? 1)); i++) keys.push(generatePrivateKey());
    const have = new Set([
      unlocked?.evm.address.toLowerCase(),
      ...list.map((x) => privateKeyToAccount(x.key).address.toLowerCase()),
    ]);
    const added = keys.map((key, i) => {
      if (have.has(privateKeyToAccount(key).address.toLowerCase())) throw new Error('Wallet already added');
      const label = (opts.label?.trim() || `W${list.length + i + 2}`).slice(0, 24);
      return { key, label: keys.length > 1 && opts.label ? `${label} ${i + 1}` : label };
    });
    return [...list, ...added];
  });
}

export function removeExtraWallet(password: string, address: string) {
  return rewriteExtras(password, (list) =>
    list.filter((x) => privateKeyToAccount(x.key).address.toLowerCase() !== address.toLowerCase()),
  );
}

export async function destroyVault() {
  lock();
  await del(KEY);
  emit();
}
