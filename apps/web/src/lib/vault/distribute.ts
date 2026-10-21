import { formatEther, parseEther } from 'viem';
import { NETWORKS, type NetworkId } from '@chog/shared';
import { feeOverrides, publicClient, walletClient, withNonceLock } from '../trade/evm';
import { evmSignerFor } from './vault';

/**
 * Moving native gas money between the vault's own EVM wallets: fund the extra wallets from the main
 * one, and sweep them back. Only ever sends between addresses of this vault.
 */

export interface TransferResult {
  wallet: string;
  ok: boolean;
  hash?: string;
  amount?: string;
  error?: string;
}

const short = (e: unknown) => (e as Error).message.split('\n')[0]!.slice(0, 140);

/** Sends `amountEach` native from the main wallet to each target, one after another. */
export async function fundWallets(
  network: NetworkId,
  targets: string[],
  amountEach: string,
): Promise<TransferResult[]> {
  if (NETWORKS[network].kind !== 'evm') throw new Error('EVM networks only');
  const value = parseEther(amountEach);
  if (value <= 0n) throw new Error('Amount must be positive');
  const main = evmSignerFor(null).address;
  const pc = publicClient(network);
  const need = value * BigInt(targets.length);
  const have = await pc.getBalance({ address: main });
  if (have < need)
    throw new Error(
      `Main wallet has ${formatEther(have)} ${NETWORKS[network].nativeSymbol}, needs ${formatEther(need)} + gas`,
    );
  const out: TransferResult[] = [];
  for (const to of targets) {
    if (to.toLowerCase() === main.toLowerCase()) continue;
    evmSignerFor(to); // must be one of ours
    try {
      const fees = await feeOverrides(network, 'low');
      const hash = await withNonceLock(network, (nonce) =>
        walletClient(network).sendTransaction({ to: to as `0x${string}`, value, nonce, ...fees } as never),
      );
      out.push({ wallet: to, ok: true, hash, amount: amountEach });
    } catch (e) {
      out.push({ wallet: to, ok: false, error: short(e) });
    }
  }
  return out;
}

/** Sends each wallet's native balance (minus a gas reserve) back to the main wallet. */
export async function sweepToMain(network: NetworkId, wallets: string[]): Promise<TransferResult[]> {
  if (NETWORKS[network].kind !== 'evm') throw new Error('EVM networks only');
  const main = evmSignerFor(null).address;
  const pc = publicClient(network);
  const out: TransferResult[] = [];
  for (const w of wallets) {
    if (w.toLowerCase() === main.toLowerCase()) continue;
    const from = evmSignerFor(w).address;
    try {
      const bal = await pc.getBalance({ address: from });
      const fees = await pc.estimateFeesPerGas().catch(() => null);
      const price = fees?.maxFeePerGas ?? (await pc.getGasPrice());
      const gas = await pc.estimateGas({ account: from, to: main, value: 1n }).catch(() => 21_000n);
      // L2s also charge an L1 data fee that the gas estimate does not show: keep a margin.
      const reserve = gas * price * 2n + parseEther('0.00002');
      const value = bal - reserve;
      if (value <= 0n) {
        out.push({ wallet: w, ok: true, amount: '0', error: 'nothing to sweep' });
        continue;
      }
      const hash = await withNonceLock(
        network,
        (nonce) =>
          walletClient(network, from).sendTransaction({
            to: main,
            value,
            gas,
            nonce,
            ...(fees?.maxFeePerGas
              ? { maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas }
              : { gasPrice: price }),
          } as never),
        from,
      );
      out.push({ wallet: w, ok: true, hash, amount: formatEther(value) });
    } catch (e) {
      out.push({ wallet: w, ok: false, error: short(e) });
    }
  }
  return out;
}
