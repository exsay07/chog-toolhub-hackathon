import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, Field, Select, Toggle } from './ui';
import {
  CARD_H,
  CARD_W,
  LOOP,
  MOODS,
  THEMES,
  loadCardAssets,
  moodOf,
  playCard,
  recordCard,
  renderCard,
  videoType,
  type ArtPack,
  type CardData,
  type CardTheme,
  type RenderOptions,
} from './pnlRender';

export type { CardData } from './pnlRender';

/** Clips are recorded at 1920×1080: even sides for H.264 and the size X plays best. */
const VIDEO_SCALE = 1.6;
const VIDEO_LOOPS = 2;

/** The app's motion setting ("Reduce motion": on / off / system). */
function reducedMotion() {
  const pref = document.documentElement.dataset.motion;
  if (pref === 'on') return true;
  if (pref === 'off') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function fileStem(d: CardData) {
  return d.kind === 'period'
    ? `chog-pnl-${d.from}_${d.to}`.replace(/\s+/g, '-')
    : `chog-pnl-${d.pair}-${d.side}-${Math.round(d.roe)}pct`.toLowerCase();
}

/**
 * Card builder. The preview canvas is drawn by the same renderer as the exports: the PNG is the still
 * frame, the video is the animated loop, so what you see is what you share.
 */
export function PnlCardBuilder({ data }: { data: CardData }) {
  const cv = useRef<HTMLCanvasElement>(null);
  const assets = useQuery({ queryKey: ['pnl-card-assets'], queryFn: loadCardAssets, staleTime: Infinity });
  const [pack, setPack] = useState<ArtPack>('flex');
  const [theme, setTheme] = useState<CardTheme>('terminal');
  const [privacy, setPrivacy] = useState<'full' | 'short' | 'hidden'>('short');
  const [stats, setStats] = useState(true);
  const [scale, setScale] = useState(2);
  const [animate, setAnimate] = useState(() => !reducedMotion());
  const [recording, setRecording] = useState(false);
  const [recError, setRecError] = useState<string | null>(null);
  const [canRecord] = useState(() => videoType() !== null);

  // The parent rebuilds `data` on every render; restart the animation only when the numbers change.
  const key = JSON.stringify(data);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const card = useMemo(() => data, [key]);
  const mood = MOODS[moodOf(card)];

  useEffect(() => {
    const a = assets.data;
    const c = cv.current;
    if (!a || !c) return;
    const o: RenderOptions = { pack, theme, privacy, stats, scale: 1 };
    if (!animate) {
      renderCard(c, card, a, o);
      return;
    }
    return playCard(c, card, a, o);
  }, [assets.data, card, pack, theme, privacy, stats, animate]);

  const downloadPng = () => {
    if (!assets.data) return;
    const out = document.createElement('canvas');
    renderCard(out, card, assets.data, { pack, theme, privacy, stats, scale });
    out.toBlob((b) => b && saveBlob(b, `${fileStem(card)}.png`), 'image/png');
  };

  const recordVideo = async () => {
    if (!assets.data) return;
    setRecording(true);
    setRecError(null);
    try {
      const blob = await recordCard(
        card,
        assets.data,
        { pack, theme, privacy, stats, scale: VIDEO_SCALE },
        VIDEO_LOOPS,
      );
      saveBlob(blob, `${fileStem(card)}.${blob.type.includes('mp4') ? 'mp4' : 'webm'}`);
    } catch (e) {
      setRecError(e instanceof Error ? e.message : 'Recording failed.');
    } finally {
      setRecording(false);
    }
  };

  return (
    <div className="grid grid-cols-[1fr_220px] gap-3">
      <canvas
        ref={cv}
        className="w-full rounded-[var(--radius)] border border-line bg-[#08080a]"
        style={{ aspectRatio: `${CARD_W}/${CARD_H}` }}
        aria-label={`PnL card preview, Chog mood ${mood.label}`}
        data-testid="pnl-canvas"
      />
      <div className="space-y-3">
        <Field label="Chog art">
          <Select value={pack} onChange={(e) => setPack(e.target.value as ArtPack)}>
            <option value="flex">Flex (drawn moods)</option>
            <option value="classic">Classic (pixel)</option>
          </Select>
        </Field>
        <Field label="Theme">
          <Select value={theme} onChange={(e) => setTheme(e.target.value as CardTheme)}>
            {(Object.keys(THEMES) as CardTheme[]).map((k) => (
              <option key={k} value={k}>
                {THEMES[k].name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Wallet address">
          <Select value={privacy} onChange={(e) => setPrivacy(e.target.value as typeof privacy)}>
            <option value="hidden">Hidden</option>
            <option value="short">Shortened</option>
            <option value="full">Full</option>
          </Select>
        </Field>
        <Toggle checked={stats} onChange={setStats} label="Show stats" />
        <Toggle checked={animate} onChange={setAnimate} label="Animate preview" />
        <Field label="Resolution">
          <Select value={scale} onChange={(e) => setScale(Number(e.target.value))}>
            <option value={1}>1200×675</option>
            <option value={2}>2400×1350</option>
          </Select>
        </Field>
        <Button variant="primary" className="w-full" onClick={downloadPng} disabled={!assets.data}>
          Download PNG
        </Button>
        <Button
          className="w-full"
          onClick={() => void recordVideo()}
          disabled={!assets.data || !canRecord}
          loading={recording}
          title={canRecord ? undefined : 'This browser cannot record canvas video.'}
        >
          {recording ? `Recording… ${LOOP * VIDEO_LOOPS} s` : 'Record video'}
        </Button>
        {recError && <p className="text-[11px] text-down">{recError}</p>}
        <p className="text-[11px] text-muted">
          Chog&apos;s mood follows the result: <span className="text-text-2">{mood.label}</span>. Video is a{' '}
          {LOOP * VIDEO_LOOPS} s seamless loop at 1920×1080. Only aggregated PnL is drawn; keys and balances
          are never included.
        </p>
      </div>
    </div>
  );
}
