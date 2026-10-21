import { useEffect, useRef } from 'react';
import { lite } from '../lib/polish';

/**
 * Any logo shown "on the old CRT", like the Chog on the sign-in page: pixelated to a coarse grid,
 * softly upscaled, RGB-fringed, scanlined, with analog noise, flicker, a rolling glare band and the
 * odd horizontal tear. Powers on (bright line → picture) when it mounts and again on hover.
 * ~20 fps, paused while off-screen; reduced motion → a still frame.
 */

const GRID = 30; // logo resolution in "pixels" — the crunch
const RES = 120; // internal canvas resolution
const FPS = lite ? 10 : 20; // half rate on modest machines (lib/polish.ts)
const POWER_ON_MS = 380;

function reducedMotion() {
  const pref = document.documentElement.dataset.motion;
  if (pref === 'on') return true;
  if (pref === 'off') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const canvas = (w: number, h = w) => Object.assign(document.createElement('canvas'), { width: w, height: h });

export function CrtImage({
  src,
  size = 112,
  saturation = 0.55,
  className,
  label,
}: {
  src: string;
  size?: number;
  /** 0 = greyscale like the Chog, 1 = full brand colour. */
  saturation?: number;
  className?: string;
  label?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext('2d')!;
    cv.width = cv.height = RES;
    let disposed = false;
    let raf = 0;
    let visible = true;
    let powerAt = performance.now();
    const still = reducedMotion();

    // Pixelated source → three colour channels (for the RGB fringe).
    const pix = canvas(GRID);
    const big = canvas(RES);
    const chans = (['#ff0000', '#00ff00', '#0000ff'] as const).map((color) => ({ c: canvas(RES), color }));
    const scan = canvas(RES);
    {
      const s = scan.getContext('2d')!;
      s.fillStyle = 'rgba(0,0,0,0.42)';
      for (let y = 0; y < RES; y += 2) s.fillRect(0, y, RES, 1);
    }
    const noise = Array.from({ length: 5 }, () => {
      const c = canvas(RES);
      const x = c.getContext('2d')!;
      const img = x.createImageData(RES, RES);
      for (let q = 0; q < img.data.length; q += 4) {
        const v = Math.random() * 255;
        img.data[q] = img.data[q + 1] = img.data[q + 2] = v;
        img.data[q + 3] = Math.random() < 0.5 ? 0 : 60;
      }
      x.putImageData(img, 0, 0);
      return c;
    });

    const img = new Image();
    img.decoding = 'async';
    img.src = src;
    let ready = false;
    img.onload = () => {
      const p = pix.getContext('2d')!;
      p.imageSmoothingEnabled = true;
      p.drawImage(img, 0, 0, GRID, GRID);
      // Desaturate towards the Chog's greyscale look, keep a hint of the brand colour.
      const d = p.getImageData(0, 0, GRID, GRID);
      for (let i = 0; i < d.data.length; i += 4) {
        const [r, g, b] = [d.data[i]!, d.data[i + 1]!, d.data[i + 2]!];
        const l = 0.3 * r + 0.59 * g + 0.11 * b;
        d.data[i] = l + (r - l) * saturation;
        d.data[i + 1] = l + (g - l) * saturation;
        d.data[i + 2] = l + (b - l) * saturation;
      }
      p.putImageData(d, 0, 0);
      const bg = big.getContext('2d')!;
      bg.imageSmoothingEnabled = true; // soft upscale = the CRT "crunch"
      bg.drawImage(pix, 0, 0, RES, RES);
      for (const ch of chans) {
        const x = ch.c.getContext('2d')!;
        x.drawImage(big, 0, 0);
        x.globalCompositeOperation = 'multiply';
        x.fillStyle = ch.color;
        x.fillRect(0, 0, RES, RES);
        x.globalCompositeOperation = 'destination-in';
        x.drawImage(big, 0, 0);
      }
      ready = true;
      powerAt = performance.now();
      if (still) render(powerAt + POWER_ON_MS + 1);
    };

    let frame = 0;
    let tear: { y: number; h: number; dx: number; until: number } | null = null;
    const render = (now: number) => {
      if (!ready) return;
      const t = now - powerAt;
      ctx.clearRect(0, 0, RES, RES);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      if (t < POWER_ON_MS) {
        // Power-on: a bright line opens into an over-exposed picture.
        const p = Math.min(1, t / (POWER_ON_MS * 0.55));
        const open = p < 1 ? Math.max(0.02, p ** 2.2) : 1;
        const flash = 1 - t / POWER_ON_MS;
        ctx.filter = `brightness(${1 + flash * 3})`;
        const h = RES * open;
        for (const [i, ch] of chans.entries())
          ctx.drawImage(ch.c, (i - 1) * (2 + flash * 4), (RES - h) / 2, RES, h);
        ctx.filter = 'none';
      } else {
        const flicker = still ? 1 : 0.86 + Math.random() * 0.14;
        const jitter = !still && Math.random() < 0.08 ? (Math.random() - 0.5) * 2 : 0;
        const fringe = still ? 1.4 : 1.2 + Math.random() * 0.8;
        ctx.globalAlpha = flicker;
        for (const [i, ch] of chans.entries()) ctx.drawImage(ch.c, jitter + (i - 1) * fringe, 0);
      }
      ctx.restore();
      if (!still && t >= POWER_ON_MS) {
        if (!tear && Math.random() < 0.04)
          tear = {
            y: Math.random() * RES,
            h: 2 + Math.random() * 8,
            dx: (Math.random() - 0.5) * 10,
            until: now + 80 + Math.random() * 100,
          };
        if (tear) {
          if (now > tear.until) tear = null;
          else ctx.drawImage(cv, 0, tear.y, RES, tear.h, tear.dx, tear.y, RES, tear.h);
        }
      }
      // Scanlines, noise and a slow glare band over the picture only.
      ctx.save();
      ctx.globalCompositeOperation = 'source-atop';
      ctx.drawImage(scan, 0, 0);
      ctx.globalAlpha = 0.5;
      ctx.drawImage(noise[frame % noise.length]!, 0, 0);
      const bandY = ((now / 14) % (RES + 50)) - 25;
      const g = ctx.createLinearGradient(0, bandY - 12, 0, bandY + 12);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(0.5, 'rgba(255,255,255,0.2)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.globalAlpha = 1;
      ctx.fillStyle = g;
      ctx.fillRect(0, bandY - 12, RES, 24);
      ctx.restore();
    };

    let last = 0;
    const loop = (now: number) => {
      if (disposed) return;
      raf = requestAnimationFrame(loop);
      if (!visible || now - last < 1000 / FPS) return;
      last = now;
      frame++;
      render(now);
    };
    if (!still) raf = requestAnimationFrame(loop);
    const io = new IntersectionObserver(([e]) => (visible = !!e?.isIntersecting));
    io.observe(cv);
    const replay = () => {
      if (!still && performance.now() - powerAt > POWER_ON_MS + 600) powerAt = performance.now();
    };
    cv.parentElement?.addEventListener('mouseenter', replay);
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      io.disconnect();
      cv.parentElement?.removeEventListener('mouseenter', replay);
    };
  }, [src, saturation]);

  return (
    <span
      role="img"
      aria-label={label}
      className={className}
      style={{ display: 'inline-block', width: size, height: size, position: 'relative' }}
    >
      <canvas
        ref={ref}
        aria-hidden
        style={{
          width: size,
          height: size,
          imageRendering: 'auto',
          filter: 'contrast(1.12) drop-shadow(0 0 10px rgba(220,230,255,0.16))',
          borderRadius: Math.round(size * 0.12),
        }}
      />
    </span>
  );
}
