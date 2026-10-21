import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DEFAULT_SETTINGS, type Settings } from '@chog/shared';
import { get, put } from './api';
import { applyCustomBackground } from './background';

const LOCAL_KEY = 'chog.appearance';

/** Non-sensitive appearance cache so the correct theme paints before login. */
function readLocal(): Settings['appearance'] | null {
  try {
    const v = localStorage.getItem(LOCAL_KEY);
    return v ? ({ ...DEFAULT_SETTINGS.appearance, ...JSON.parse(v) } as Settings['appearance']) : null;
  } catch {
    return null;
  }
}

function writeLocal(a: Settings['appearance']) {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(a));
  } catch {
    /* storage unavailable */
  }
}

export function applyAppearance(a: Settings['appearance']) {
  const root = document.documentElement;
  const theme =
    a.theme === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : a.theme;
  root.dataset.theme = theme;
  root.dataset.accent = a.accent;
  root.dataset.motion = a.reducedMotion;
  root.dataset.bg = a.background;
  root.dataset.density = a.density;
  void applyCustomBackground(a.background === 'chog');
}

interface Ctx {
  settings: Settings;
  loaded: boolean;
  update: (fn: (s: Settings) => Settings) => Promise<void>;
  setAppearanceLocal: (a: Partial<Settings['appearance']>) => void;
}

const SettingsCtx = createContext<Ctx | null>(null);

export function SettingsProvider({ children, authed }: { children: ReactNode; authed: boolean }) {
  const qc = useQueryClient();
  const [local, setLocal] = useState<Settings['appearance']>(
    () => readLocal() ?? DEFAULT_SETTINGS.appearance,
  );
  const q = useQuery({
    queryKey: ['settings'],
    queryFn: () => get<Settings>('/api/settings'),
    enabled: authed,
    staleTime: 60_000,
  });
  const m = useMutation({
    mutationFn: (s: Settings) => put<Settings>('/api/settings', s),
    onMutate: async (s) => {
      await qc.cancelQueries({ queryKey: ['settings'] });
      const prev = qc.getQueryData<Settings>(['settings']);
      qc.setQueryData(['settings'], s);
      return { prev };
    },
    onError: (_e, _s, c) => c?.prev && qc.setQueryData(['settings'], c.prev),
    onSuccess: (s) => qc.setQueryData(['settings'], s),
  });

  const settings = useMemo<Settings>(() => {
    const s = q.data ?? DEFAULT_SETTINGS;
    return authed && q.data ? s : { ...s, appearance: local };
  }, [q.data, local, authed]);

  useEffect(() => {
    applyAppearance(settings.appearance);
    writeLocal(settings.appearance);
    if (settings.appearance.theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const fn = () => applyAppearance(settings.appearance);
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, [settings.appearance]);

  // First login: adopt the browser's time zone instead of UTC.
  useEffect(() => {
    if (q.data && q.data.timeZone === 'UTC') {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (tz && tz !== 'UTC') m.mutate({ ...q.data, timeZone: tz });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data?.timeZone]);

  const update = useCallback(
    async (fn: (s: Settings) => Settings) => {
      const next = fn(settings);
      setLocal(next.appearance);
      if (authed) await m.mutateAsync(next);
    },
    [settings, authed, m],
  );

  const setAppearanceLocal = useCallback(
    (a: Partial<Settings['appearance']>) => setLocal((p) => ({ ...p, ...a })),
    [],
  );

  return (
    <SettingsCtx.Provider value={{ settings, loaded: !authed || q.isSuccess, update, setAppearanceLocal }}>
      {children}
    </SettingsCtx.Provider>
  );
}

export function useSettings() {
  const c = useContext(SettingsCtx);
  if (!c) throw new Error('SettingsProvider missing');
  return c;
}
