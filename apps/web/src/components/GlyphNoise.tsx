import { useEffect, useRef } from 'react';
import { lite } from '../lib/polish';

/**
 * Full-screen background of ASCII glyphs that blink in and out at random positions (old-terminal
 * "signal noise"). One canvas, redrawn every 400 ms; paused while the tab is hidden; a single faint
 * static frame when reduced motion is requested.
 */
const CHARS = [
  '/',
  '\\',
  '*',
  '?',
  '1',
  '0',
  '`',
  '~',
  '&',
  '+',
  '-',
  '=',
  '|',
  '_',
  '.',
  ',',
  ';',
  ':',
  '<',
  '>',
];
const INTERVAL_MS = 400;
/** Glyphs per frame for a 1440×900 viewport; scaled by area. */
const DENSITY = 100 / (1440 * 900);

/**
 * `subtle`: the in-app version behind the panels — fewer, dimmer glyphs on a slower beat, so the
 * sign-in page's texture carries through the app without distracting from data.
 */
export function GlyphNoise({ subtle = false }: { subtle?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext('2d')!;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const resize = () => {
      cv.width = Math.round(window.innerWidth * dpr);
      cv.height = Math.round(window.innerHeight * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);
    const light = () => document.documentElement.dataset.theme === 'light';

    const draw = (alphaScale = 1) => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      ctx.clearRect(0, 0, w, h);
      const n = Math.round(w * h * DENSITY * (subtle ? 0.45 : 1));
      const lt = light();
      for (let i = 0; i < n; i++) {
        const size = 14 + Math.floor(Math.random() * 12);
        const grey = lt ? 40 + Math.floor(Math.random() * 110) : 100 + Math.floor(Math.random() * 155);
        const alpha = (0.3 + Math.random() * 0.5) * alphaScale * (subtle ? 0.32 : 1);
        ctx.font = `${size}px ui-monospace, Menlo, Consolas, monospace`;
        ctx.fillStyle = `rgba(${grey},${grey},${grey},${alpha})`;
        ctx.fillText(CHARS[Math.floor(Math.random() * CHARS.length)]!, Math.random() * w, Math.random() * h);
      }
    };

    const reduce =
      document.documentElement.dataset.motion === 'on' ||
      (document.documentElement.dataset.motion !== 'off' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    if (reduce) {
      draw(0.35);
      return () => window.removeEventListener('resize', resize);
    }

    let timer: number | null = null;
    const start = () => {
      if (timer === null) timer = window.setInterval(() => draw(), subtle ? INTERVAL_MS * 3 : INTERVAL_MS);
    };
    const stop = () => {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
    };
    const vis = () => (document.hidden ? stop() : start());
    document.addEventListener('visibilitychange', vis);
    draw();
    start();
    return () => {
      stop();
      document.removeEventListener('visibilitychange', vis);
      window.removeEventListener('resize', resize);
    };
  }, [subtle]);

  // Modest machines: the in-app texture is purely decorative, so it is skipped there.
  if (subtle && lite) return null;
  return (
    <canvas
      ref={ref}
      aria-hidden
      style={{
        position: 'fixed',
        inset: 0,
        width: '100vw',
        height: '100vh',
        pointerEvents: 'none',
        zIndex: 0,
      }}
    />
  );
}
