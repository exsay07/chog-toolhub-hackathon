import { useEffect, useRef } from 'react';
import { lite } from '../lib/polish';
import { CHOG_CELLS_HEX, CHOG_GRID } from '../assets/chogPixels';
import { createExpressions, drawFace, hairOffset, splitHair, type Cell, type Expression } from './chogFace';

/**
 * The owner's pixel Chog on an "old CRT TV":
 *  - power-on: a bright horizontal line snaps open into an over-exposed frame (~0.4 s);
 *  - persistent afterwards: low-res "crunchy" image, RGB fringing, scanlines, analog noise,
 *    brightness flicker, a rolling glare band, slow vertical drift and occasional tearing;
 *  - the pupils follow the mouse cursor anywhere on the page;
 *  - the hair sways, and now and then he smiles, double-blinks or yawns (plus natural blinking).
 *
 * Rendered at a deliberately low internal resolution and upscaled by the browser (soft, lo-fi look).
 * Runs at ~24 fps; paused while the tab is hidden; static frame if reduced motion is requested.
 */

const RES = 172; // internal resolution of the figure (px) — the "low quality" knob
const PAD = 0.1; // spare room around the figure for fringing / tearing
const FPS = lite ? 12 : 24; // half rate on modest machines (lib/polish.ts)
const POWER_ON_MS = 420;

/** Eye sockets on the 58×58 pixel map (inclusive). Dark cells inside are the movable pupils. */
const EYES = [
  { x0: 26, x1: 31, y0: 30, y1: 35 },
  { x0: 38, x1: 45, y0: 30, y1: 35 },
];
const SCLERA = 236; // grey level painted where a pupil used to be
const PUPIL_MAX = { x: 1.8, y: 1.3 }; // max pupil travel, in pixel-map cells

function reducedMotion() {
  const pref = document.documentElement.dataset.motion;
  if (pref === 'on') return true;
  if (pref === 'off') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function makeCanvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

const inEye = (x: number, y: number) => EYES.some((e) => x >= e.x0 && x <= e.x1 && y >= e.y0 && y <= e.y1);

/** Figure without pupils and hair, a pupils-only sprite, the hair cells, scanlines and noise frames. */
function buildLayers(full: number, off: number) {
  const cell = RES / CHOG_GRID;
  const base = makeCanvas(full, full);
  const pupils = makeCanvas(full, full);
  const b = base.getContext('2d')!;
  const p = pupils.getContext('2d')!;
  const cells: Cell[] = [];
  for (let i = 0; i < CHOG_CELLS_HEX.length; i += 6)
    cells.push({
      x: parseInt(CHOG_CELLS_HEX.slice(i, i + 2), 16),
      y: parseInt(CHOG_CELLS_HEX.slice(i + 2, i + 4), 16),
      v: parseInt(CHOG_CELLS_HEX.slice(i + 4, i + 6), 16),
    });
  // Hair is drawn per frame (it sways), so it stays out of the static base.
  const { hair, isHair } = splitHair(cells);
  for (const { x, y, v } of cells) {
    if (isHair(x, y)) continue;
    const px = off + x * cell;
    const py = off + y * cell;
    const s = Math.ceil(cell);
    if (inEye(x, y) && v < 120) {
      // Dark eye cell → part of the pupil sprite; the socket underneath becomes white.
      p.fillStyle = `rgb(${v},${v},${v})`;
      p.fillRect(px, py, s, s);
      b.fillStyle = `rgb(${SCLERA},${SCLERA},${SCLERA})`;
    } else {
      b.fillStyle = `rgb(${v},${v},${v})`;
    }
    b.fillRect(px, py, s, s);
  }
  const scan = makeCanvas(full, full);
  const sc = scan.getContext('2d')!;
  sc.fillStyle = 'rgba(0,0,0,0.38)';
  for (let y = 0; y < full; y += 2) sc.fillRect(0, y, full, 1);
  const noise = Array.from({ length: 6 }, () => {
    const c = makeCanvas(full, full);
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(full, full);
    for (let q = 0; q < img.data.length; q += 4) {
      const v = Math.random() * 255;
      img.data[q] = img.data[q + 1] = img.data[q + 2] = v;
      img.data[q + 3] = Math.random() < 0.5 ? 0 : 70;
    }
    ctx.putImageData(img, 0, 0);
    return c;
  });
  return { base, pupils, hair, scan, noise, cell };
}

export function ChogTv({ size = 300, className }: { size?: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const off = Math.round(RES * PAD);
    const full = RES + off * 2;
    cv.width = full;
    cv.height = full;
    const ctx = cv.getContext('2d')!;
    const L = buildLayers(full, off);
    // Per-frame scratch: composed grey figure + its three colour channels.
    const fig = makeCanvas(full, full);
    const fctx = fig.getContext('2d')!;
    const chans = (['#ff0000', '#00ff00', '#0000ff'] as const).map((color) => {
      const c = makeCanvas(full, full);
      return { c, x: c.getContext('2d')!, color };
    });

    // Gaze: target from the mouse, eased each frame.
    const gaze = { x: 0, y: 0, tx: 0, ty: 0 };
    const onMove = (e: MouseEvent) => {
      const r = cv.getBoundingClientRect();
      const ex = r.left + r.width / 2;
      const ey = r.top + r.height * 0.55; // roughly eye height
      const dx = e.clientX - ex;
      const dy = e.clientY - ey;
      const d = Math.hypot(dx, dy) || 1;
      // Direction from the eyes to the cursor, saturating within ~240 px.
      const k = Math.min(1, d / 240);
      gaze.tx = (dx / d) * k;
      gaze.ty = (dy / d) * k;
    };
    window.addEventListener('mousemove', onMove);

    let raf = 0;
    const t0 = performance.now();
    let last = 0;
    let frame = 0;
    let tear: { y: number; h: number; dx: number; until: number } | null = null;
    const face = createExpressions(t0);
    const still = reducedMotion();
    // Lets a preview / test trigger an expression: window.dispatchEvent(new CustomEvent('chog:face', { detail: 'yawn' })).
    const onFace = (e: Event) => face.force((e as CustomEvent<Expression>).detail, performance.now());
    window.addEventListener('chog:face', onFace);

    /** Composes figure + pupils (offset by gaze, clipped to the sockets) and splits RGB channels. */
    const compose = (now: number) => {
      gaze.x += (gaze.tx - gaze.x) * 0.35;
      gaze.y += (gaze.ty - gaze.y) * 0.35;
      const c = L.cell;
      const s = Math.ceil(c);
      fctx.clearRect(0, 0, full, full);
      fctx.drawImage(L.base, 0, 0);
      // Hair, swaying (still when reduced motion is on).
      const t = now / 1000;
      for (const h of L.hair) {
        const [dx, dy] = still ? [0, 0] : hairOffset(h, t);
        fctx.fillStyle = h.color;
        fctx.fillRect(off + (h.x + dx) * c, off + (h.y + dy) * c, s, s);
      }
      fctx.save();
      fctx.beginPath();
      for (const e of EYES)
        fctx.rect(off + e.x0 * c, off + e.y0 * c, (e.x1 - e.x0 + 1) * c, (e.y1 - e.y0 + 1) * c);
      fctx.clip();
      fctx.drawImage(L.pupils, gaze.x * PUPIL_MAX.x * c, gaze.y * PUPIL_MAX.y * c);
      fctx.restore();
      if (!still)
        drawFace((x, y, style) => {
          fctx.fillStyle = style;
          fctx.fillRect(off + x * c, off + y * c, s, s);
        }, face.update(now));
      for (const ch of chans) {
        ch.x.globalCompositeOperation = 'source-over';
        ch.x.clearRect(0, 0, full, full);
        ch.x.drawImage(fig, 0, 0);
        ch.x.globalCompositeOperation = 'multiply';
        ch.x.fillStyle = ch.color;
        ch.x.fillRect(0, 0, full, full);
        ch.x.globalCompositeOperation = 'destination-in';
        ch.x.drawImage(fig, 0, 0);
      }
    };

    const drawFigure = (dx: number, dy: number, scaleY: number, fringe: number, alpha: number) => {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.globalCompositeOperation = 'lighter';
      const h = full * scaleY;
      const y = (full - h) / 2 + dy;
      ctx.drawImage(chans[0]!.c, dx - fringe, y, full, h);
      ctx.drawImage(chans[1]!.c, dx, y, full, h);
      ctx.drawImage(chans[2]!.c, dx + fringe, y, full, h);
      ctx.restore();
    };

    const overlay = (now: number) => {
      // Effects only over the lit figure (source-atop keeps the page background clean).
      ctx.save();
      ctx.globalCompositeOperation = 'source-atop';
      ctx.drawImage(L.scan, 0, 0);
      ctx.globalAlpha = 0.55;
      ctx.drawImage(L.noise[frame % L.noise.length]!, 0, 0);
      const bandY = ((now / 12) % (full + 60)) - 30;
      const g = ctx.createLinearGradient(0, bandY - 16, 0, bandY + 16);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(0.5, 'rgba(255,255,255,0.22)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.globalAlpha = 1;
      ctx.fillStyle = g;
      ctx.fillRect(0, bandY - 16, full, 32);
      ctx.restore();
    };

    let lastGaze = { x: NaN, y: NaN };
    const render = (now: number) => {
      const t = now - t0;
      // The figure (hair sway, gaze, expressions) moves slowly: recompose it on every other frame,
      // or at once when the eyes are moving. The cheap CRT effects still run every frame.
      const eyesMoving = Math.abs(gaze.tx - lastGaze.x) + Math.abs(gaze.ty - lastGaze.y) > 0.002;
      if (lite || frame % 2 === 0 || eyesMoving || t < POWER_ON_MS) {
        compose(now);
        lastGaze = { x: gaze.x, y: gaze.y };
      }
      ctx.clearRect(0, 0, full, full);
      if (t < POWER_ON_MS) {
        const p = Math.min(1, t / (POWER_ON_MS * 0.55));
        const open = p < 1 ? Math.max(0.012, p ** 2.2) : 1;
        const flash = 1 - Math.min(1, t / POWER_ON_MS);
        ctx.filter = `brightness(${1 + flash * 3}) contrast(${1 + flash})`;
        drawFigure(0, 0, open, 2 + flash * 4, 1);
        ctx.filter = 'none';
        if (p < 1) {
          ctx.fillStyle = `rgba(255,255,255,${0.9 * (1 - p)})`;
          ctx.fillRect(0, full / 2 - 1, full, 2);
        }
        overlay(now);
        return;
      }
      const dy = Math.sin(now / 700) * 0.9 + (Math.random() < 0.02 ? (Math.random() - 0.5) * 6 : 0);
      const jitter = Math.random() < 0.1 ? (Math.random() - 0.5) * 3 : 0;
      const flicker = 0.84 + Math.random() * 0.16;
      drawFigure(jitter, dy, 1, 1.4 + Math.random() * 0.8, flicker);
      if (!tear && Math.random() < 0.05) {
        tear = {
          y: Math.random() * full,
          h: 3 + Math.random() * 12,
          dx: (Math.random() - 0.5) * 14,
          until: now + 60 + Math.random() * 120,
        };
      }
      if (tear) {
        if (now > tear.until) tear = null;
        else ctx.drawImage(cv, 0, tear.y, full, tear.h, tear.dx, tear.y, full, tear.h);
      }
      overlay(now);
    };

    // Paused while scrolled out of view (requestAnimationFrame already stops in background tabs).
    let visible = true;
    const io = new IntersectionObserver(([e]) => (visible = !!e?.isIntersecting));
    io.observe(cv);
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (!visible || now - last < 1000 / FPS) return;
      last = now;
      frame++;
      render(now);
    };

    if (reducedMotion()) {
      // Static frame; eyes still follow the cursor (redraw only on mouse move).
      render(t0 + POWER_ON_MS + 1);
      const still = () => {
        gaze.x = gaze.tx;
        gaze.y = gaze.ty;
        render(performance.now() + POWER_ON_MS);
      };
      window.addEventListener('mousemove', still);
      return () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('chog:face', onFace);
        window.removeEventListener('mousemove', still);
      };
    }
    raf = requestAnimationFrame(loop);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('chog:face', onFace);
    };
  }, []);

  const display = size * (1 + PAD * 2);
  return (
    <div
      role="img"
      aria-label="Chog"
      className={className}
      style={{ position: 'relative', width: size, height: size }}
    >
      <canvas
        ref={ref}
        aria-hidden
        style={{
          position: 'absolute',
          left: -PAD * size,
          top: -PAD * size,
          width: display,
          height: display,
          pointerEvents: 'none',
          // Smooth upscaling of a low-res frame = the soft, crunchy CRT look; plus phosphor glow.
          imageRendering: 'auto',
          filter: 'contrast(1.15) drop-shadow(0 0 10px rgba(220,230,255,0.18))',
        }}
      />
    </div>
  );
}
