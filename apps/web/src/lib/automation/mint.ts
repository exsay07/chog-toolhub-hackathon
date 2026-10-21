import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { encodeFunctionData, parseAbiItem, parseEther, type AbiFunction } from 'viem';
import { NETWORKS, shortAddress, type MintTask, type NetworkId } from '@chog/shared';
import { patch, post } from '../api';
import { useNotify } from '../notify';
import { evmSignerFor, isUnlocked } from '../vault/vault';
import { feeOverrides, publicClient, walletClient, withNonceLock } from '../trade/evm';
import { killSwitch } from '../trade/engine';
import { fetchMints, mintWallets, type MintRow } from '../mints';
import { autoLog } from './common';

export type { MintRow };

/** Builds calldata from a *simple* public mint signature. Placeholders: {quantity}, {recipient}. */
export function buildMintCall(t: MintTask, recipient: `0x${string}`) {
  const fn = parseAbiItem(`function ${t.functionSignature} payable`) as AbiFunction;
  if (fn.inputs.length !== t.args.length)
    throw new Error(`Signature expects ${fn.inputs.length} argument(s), got ${t.args.length}`);
  const args = fn.inputs.map((inp, i) => {
    const raw = t.args[i]!.replace('{quantity}', String(t.quantity)).replace('{recipient}', recipient);
    if (inp.type === 'address') {
      if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) throw new Error(`Arg ${i + 1} must be an address`);
      return raw as `0x${string}`;
    }
    if (inp.type === 'bytes32') {
      if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) throw new Error(`Arg ${i + 1} must be bytes32`);
      return raw as `0x${string}`;
    }
    if (!/^\d+$/.test(raw)) throw new Error(`Arg ${i + 1} must be an unsigned integer`);
    return BigInt(raw);
  });
  const data = encodeFunctionData({ abi: [fn], functionName: fn.name, args });
  const value = parseEther(String(t.unitPriceNative)) * BigInt(t.quantity);
  if (value > parseEther(String(t.maxTotalSpendNative)))
    throw new Error('Mint cost exceeds your max total spend');
  return { to: t.address as `0x${string}`, data, value };
}

/** Simulates the mint from one vault wallet (default: main). */
export async function simulateMint(t: MintTask, wallet?: string | null) {
  const from = evmSignerFor(wallet).address;
  const call = buildMintCall(t, from);
  const pc = publicClient(t.network as NetworkId);
  await pc.call({ account: from, ...call });
  const gas = await pc.estimateGas({ account: from, ...call });
  return { ...call, gas };
}

/**
 * Runs armed mint tasks from this tab, once per selected wallet. Before start time it only
 * *simulates* (no submission); each wallet submits once its simulation passes, bounded by
 * maxAttempts. It never bypasses allowlists/signatures — if the contract rejects the call, so do we.
 */
export function MintRunner() {
  const qc = useQueryClient();
  const { notify } = useNotify();
  const q = useQuery({
    queryKey: ['automations', 'mint'],
    queryFn: fetchMints,
    refetchInterval: 15_000,
  });
  const busy = useRef(new Set<string>());
  /** Per task+wallet: attempts and confirmed mints (this session). */
  const attempts = useRef(new Map<string, number>());
  const done = useRef(new Set<string>());
  const rows = useRef<MintRow[]>([]);
  rows.current = q.data ?? [];

  useEffect(() => {
    const finishTask = async (r: MintRow, status: 'done' | 'error', msg: string, level: 'info' | 'error') => {
      await patch(`/api/automations/mint/${r.id}/status`, { status });
      autoLog('mint', level, msg, r.id);
      void qc.invalidateQueries({ queryKey: ['automations', 'mint'] });
    };

    const runWallet = async (r: MintRow, wallet: string | null) => {
      const t = r.data;
      const key = `${r.id}:${wallet ?? 'main'}`;
      const who = wallet ? shortAddress(wallet) : 'main';
      let sim;
      try {
        sim = await simulateMint(t, wallet);
      } catch (e) {
        // Not open yet / sold out / not eligible: keep polling the simulation until the window passes.
        if (t.startAt && Date.now() - t.startAt > 10 * 60_000)
          throw new Error(
            `simulation still failing 10 min after start (${(e as Error).message.split('\n')[0]})`,
            { cause: e },
          );
        return false;
      }
      const n = (attempts.current.get(key) ?? 0) + 1;
      attempts.current.set(key, n);
      if (n > t.maxAttempts) throw new Error(`${who}: max attempts reached`);
      const net = t.network as NetworkId;
      const fees = await feeOverrides(net, t.priorityFee);
      const hash = await withNonceLock(
        net,
        (nonce) =>
          walletClient(net, wallet).sendTransaction({
            to: sim.to,
            data: sim.data,
            value: sim.value,
            gas: (sim.gas * 120n) / 100n,
            nonce,
            ...fees,
          } as never),
        wallet,
      );
      await post('/api/journal', {
        // Unique per send: the attempt counter restarts when a task is re-armed or the page reloads.
        idempotencyKey: `mint-${r.id.slice(0, 20)}-${(wallet ?? 'main').slice(-8)}-${n}-${Date.now().toString(36)}`,
        network: net,
        hash,
        kind: 'mint',
        source: 'mint',
        side: null,
        token: null,
        quotedUsd: null,
        ...(wallet ? { wallet } : {}),
      });
      autoLog('mint', 'info', `${t.name} [${who}]: mint submitted (attempt ${n}) ${hash}`, r.id);
      notify({
        category: 'execution',
        tone: 'info',
        title: `Mint submitted: ${t.name}`,
        body: `${who} · awaiting confirmation`,
        link: { href: NETWORKS[net].explorer.tx(hash), label: 'Explorer' },
      });
      const rc = await publicClient(net).waitForTransactionReceipt({ hash, timeout: 180_000 });
      if (rc.status === 'success') {
        done.current.add(key);
        autoLog('mint', 'info', `${t.name} [${who}]: confirmed in block ${rc.blockNumber}`, r.id);
        notify({ category: 'execution', tone: 'up', title: `Minted: ${t.name}`, body: `${who} · confirmed` });
        return true;
      }
      autoLog('mint', 'warn', `${t.name} [${who}]: mint reverted on chain (attempt ${n})`, r.id);
      notify({ category: 'failed', tone: 'down', title: `Mint reverted: ${t.name}`, body: who });
      return false;
    };

    const tick = async () => {
      // Disarmed / re-armed tasks start over (attempt counters and finished wallets).
      for (const r of rows.current.filter((x) => x.status !== 'armed'))
        for (const set of [done.current, attempts.current])
          for (const k of [...set.keys()]) if (k.startsWith(`${r.id}:`)) set.delete(k);
      for (const r of rows.current.filter((x) => x.status === 'armed')) {
        if (killSwitch.active || !isUnlocked()) continue;
        const t = r.data;
        if (t.startAt && Date.now() < t.startAt - 3000) continue; // not open yet: wait, don't submit
        const wallets = mintWallets(t);
        // Wallets mint in parallel (each has its own nonce lock); one in-flight run per wallet.
        for (const wallet of wallets) {
          const key = `${r.id}:${wallet ?? 'main'}`;
          if (busy.current.has(key) || done.current.has(key)) continue;
          busy.current.add(key);
          void runWallet(r, wallet)
            .then(async () => {
              if (wallets.every((w) => done.current.has(`${r.id}:${w ?? 'main'}`)))
                await finishTask(r, 'done', `${t.name}: all ${wallets.length} wallet(s) minted`, 'info');
            })
            .catch(async (e: Error) => {
              done.current.add(key); // stop retrying this wallet
              autoLog('mint', 'error', `${t.name}: ${e.message.split('\n')[0]}`, r.id);
              if (wallets.every((w) => done.current.has(`${r.id}:${w ?? 'main'}`)))
                await finishTask(r, 'error', `${t.name}: finished with errors`, 'error');
            })
            .finally(() => busy.current.delete(key));
        }
      }
    };
    const i = setInterval(() => void tick(), 2000);
    return () => clearInterval(i);
  }, [qc, notify]);

  return null;
}
