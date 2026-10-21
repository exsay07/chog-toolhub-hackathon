import { formatUnits } from 'viem';
import { PublicKey } from '@solana/web3.js';
import { NETWORKS, type NetworkId } from '@chog/shared';
import { post } from '../api';
import { ERC20_ABI, publicClient } from '../trade/evm';
import { solConnection } from '../trade/jupiter';
import { evmSigner, solanaSigner } from '../vault/vault';

export type AutoKind = 'sniper' | 'mint' | 'perps' | 'copy' | 'system' | 'trade';

/** Sanitised execution log persisted server-side (never includes keys or raw payloads). */
export function autoLog(
  kind: AutoKind,
  level: 'info' | 'warn' | 'error',
  message: string,
  automationId: string | null = null,
) {
  const msg = message
    .replace(/0x[0-9a-fA-F]{64,}/g, (m) => (m.length === 66 ? m : '0x[redacted]'))
    .slice(0, 500);
  void post('/api/automation-logs', { automationId, kind, level, message: msg }).catch(() => {});
}

/** On-chain token balance (decimals applied) of the trading wallet, or of `holder` when given. */
export async function tokenBalance(network: NetworkId, token: string, holder?: string): Promise<number> {
  if (NETWORKS[network].kind === 'evm') {
    const pc = publicClient(network);
    const owner = (holder ?? evmSigner().address) as `0x${string}`;
    const [bal, dec] = await Promise.all([
      pc.readContract({
        address: token as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [owner],
      }),
      pc.readContract({ address: token as `0x${string}`, abi: ERC20_ABI, functionName: 'decimals' }),
    ]);
    return Number(formatUnits(bal, Number(dec)));
  }
  const r = await solConnection().getParsedTokenAccountsByOwner(
    holder ? new PublicKey(holder) : solanaSigner().publicKey,
    {
      mint: new PublicKey(token),
    },
  );
  return r.value.reduce(
    (s, a) =>
      s +
      ((a.account.data as { parsed: { info: { tokenAmount: { uiAmount: number | null } } } }).parsed.info
        .tokenAmount.uiAmount ?? 0),
    0,
  );
}

export async function nativeBalance(network: NetworkId): Promise<number> {
  if (NETWORKS[network].kind === 'evm')
    return Number(formatUnits(await publicClient(network).getBalance({ address: evmSigner().address }), 18));
  return Number(await solConnection().getBalance(solanaSigner().publicKey)) / 1e9;
}
