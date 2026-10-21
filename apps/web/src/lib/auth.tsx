import { createContext, useCallback, useContext, useEffect, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getAddress, toHex } from 'viem';
import { createSiweMessage } from 'viem/siwe';
import { ApiError, authEvents, get, post } from './api';
import { crtChannelSwitch, crtPowerOff } from './crtTv';
import { fadeOutAndPause, playNextTrack } from './music';
import type { Eip1193 } from './wallet/eip6963';
import { socket } from './ws';
import { syncUserKv } from './userKv';

export interface Me {
  address: string;
  accessBasis: 'holder' | 'dev-allowlist' | 'judge';
  session: { id: string; expiresAt: string; nftVerifiedAt: string; nftBalance: number };
}

interface Ctx {
  me: Me | null;
  loading: boolean;
  /** `judgeCode`: the reviewer pass typed on the sign-in page (no NFT needed). */
  signIn: (provider: Eip1193, judgeCode?: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthCtx = createContext<Ctx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await get<Me>('/api/auth/me');
      } catch (e) {
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) return null;
        throw e;
      }
    },
    staleTime: 60_000,
    retry: 1,
  });

  useEffect(() => {
    const fn = () => {
      void fadeOutAndPause();
      qc.setQueryData(['me'], null);
    };
    authEvents.addEventListener('logout', fn);
    return () => authEvents.removeEventListener('logout', fn);
  }, [qc]);

  useEffect(() => {
    if (q.data) socket.start();
    else socket.stop();
  }, [q.data]);

  // Preferences and sniper entries follow the user across devices.
  const addr = q.data?.address;
  useEffect(() => {
    if (addr) void syncUserKv(addr);
  }, [addr]);

  const signIn = useCallback(
    async (provider: Eip1193, judgeCode?: string) => {
      const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[];
      if (!accounts?.[0]) throw new Error('No account selected in wallet');
      const address = getAddress(accounts[0]);
      const c = await post<{
        nonce: string;
        domain: string;
        uri: string;
        chainId: number;
        statement: string;
      }>('/api/auth/nonce');
      if (c.domain !== location.host) throw new Error('Server domain mismatch — refusing to sign');
      const now = new Date();
      const message = createSiweMessage({
        address,
        chainId: c.chainId,
        domain: c.domain,
        nonce: c.nonce,
        uri: c.uri,
        version: '1',
        statement: c.statement,
        issuedAt: now,
        expirationTime: new Date(now.getTime() + 5 * 60_000),
      });
      const signature = (await provider.request({
        method: 'personal_sign',
        params: [toHex(message), address],
      })) as string;
      await post('/api/auth/verify', { message, signature, ...(judgeCode ? { judgeCode } : {}) });
      // Into the app like flipping an old TV to another channel; the music fades out with the old
      // picture and comes back (a new track, fading in) once the app is on screen.
      const [tv, wasPlaying] = await Promise.all([crtChannelSwitch(), fadeOutAndPause(500)]);
      try {
        // Drop any data from a previous account, then refetch identity (keep the observed 'me' query alive).
        qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
        await qc.refetchQueries({ queryKey: ['me'] });
      } finally {
        await tv.release();
      }
      if (wasPlaying) playNextTrack();
    },
    [qc],
  );

  const signOut = useCallback(async () => {
    // The screen switches off like an old CRT (the music fading with it) while the server ends the session.
    const [tv] = await Promise.all([
      crtPowerOff(),
      fadeOutAndPause(700),
      post('/api/auth/logout').catch(() => {}),
    ]);
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
    qc.setQueryData(['me'], null);
    tv.release();
  }, [qc]);

  return (
    <AuthCtx.Provider value={{ me: q.data ?? null, loading: q.isLoading, signIn, signOut }}>
      {children}
    </AuthCtx.Provider>
  );
}

export function useAuth() {
  const c = useContext(AuthCtx);
  if (!c) throw new Error('AuthProvider missing');
  return c;
}
