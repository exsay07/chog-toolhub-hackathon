import { shortAddress } from '@chog/shared';
import { CHOG_CELLS_HEX } from '../assets/chogPixels';
import { BRAND } from '../brand';

/**
 * PnL share card renderer.
 *
 * One canvas function draws the whole card for a moment `t` (seconds). The PNG is t = 0 with no
 * motion; the animated card is the same function sampled over a seamless LOOP-second cycle, so the
 * preview, the PNG and the recorded video always match.
 *
 * Look: the app's CRT terminal — near-black screen, VT323 with RGB fringing and phosphor glow,
 * scanlines, and Chog drawn tile by tile. Chog's mood follows the result:
 *   moon ≥ +100% · pump ≥ +25% · comfy ≥ 0 · cope > −25% · pain > −80% · rekt (≤ −80% or liquidated)
 * Two art packs: 'flex' (drawn moods from /public/pnl-cards/chog) and 'classic' (the sign-in Chog map
 * with a procedural face).
 */

export const CARD_W = 1200;
export const CARD_H = 675;
/** Seconds in one seamless animation cycle. */
export const LOOP = 4;
const FONT = '"VT323", ui-monospace, monospace';

export type Mood = 'moon' | 'pump' | 'comfy' | 'cope' | 'pain' | 'rekt';
export type CardTheme = 'terminal' | 'monad' | 'phosphor';
export type ArtPack = 'flex' | 'classic';
export type Venue = 'perpl' | 'bulk' | 'hyperliquid' | 'monad';

/** Aggregated PnL over a date range (Portfolio). */
export interface PeriodCard {
  kind: 'period';
  from: string;
  to: string;
  netUsd: number;
  pct: number | null;
  trades: number;
  winDays: number;
  lossDays: number;
  address: string;
  /** Some fills had no USD price: the card says so. */
  incomplete: boolean;
}

/** One closed (or liquidated) perps position. */
export interface PositionCard {
  kind: 'position';
  pair: string;
  side: 'long' | 'short';
  leverage: number;
  roe: number;
  pnlUsd: number;
  entry: number | null;
  exit: number | null;
  heldSec: number | null;
  venue?: Venue;
  liquidated?: boolean;
  closedAt?: string;
  address: string;
  ref?: string;
}

export type CardData = PeriodCard | PositionCard;

export interface RenderOptions {
  theme: CardTheme;
  pack: ArtPack;
  privacy: 'full' | 'short' | 'hidden';
  stats: boolean;
  scale: number;
  /** Animated frame at `t` seconds; false = the still frame. */
  anim?: boolean;
  t?: number;
}

const C = {
  up: '#3ee07f',
  down: '#ff4d5e',
  violet: '#8b7cf6',
  gold: '#ffc940',
  ink: '#ededef',
  ink2: '#b4b4bb',
  muted: '#7d7d87',
  tear: '#5cc8ff',
  tearHi: '#c6efff',
  skin: '#e8e8e8',
  line: '#121214',
};

export const MOODS: Record<Mood, { label: string; color: string; tint: string; captions: string[] }> = {
  moon: {
    label: 'MOON',
    color: C.up,
    tint: C.gold,
    captions: ['BIG CHOG ENERGY', 'CHOG EATS TONIGHT', 'TOLD YOU. MONAD MOON', 'WAGMI, ANON'],
  },
  pump: {
    label: 'PUMP',
    color: C.up,
    tint: C.up,
    captions: ['NUMBER GO UP', 'CHOG IS COOKING', 'GREEN CANDLES ONLY'],
  },
  comfy: {
    label: 'COMFY',
    color: C.up,
    tint: C.violet,
    captions: ['A WIN IS A WIN', 'COMFY GAINS', 'SLOW AND STEADY, CHOG'],
  },
  cope: {
    label: 'COPE',
    color: C.down,
    tint: '#ff9a3c',
    captions: ['THIS IS FINE', 'JUST A DIP, RIGHT?', 'ZOOM OUT, CHOG'],
  },
  pain: {
    label: 'PAIN',
    color: C.down,
    tint: C.tear,
    captions: ["IT'S OVER", 'CHOG IS NOT OKAY', 'WHY DID I LONG THAT'],
  },
  rekt: {
    label: 'REKT',
    color: C.down,
    tint: C.down,
    captions: ['BACK TO THE TRENCHES', 'SEE YOU NEXT CYCLE', 'GG. CHOG GOT WIPED'],
  },
};

export const THEMES: Record<CardTheme, { name: string; bg: string; bg2: string; grid: string }> = {
  terminal: { name: 'Terminal', bg: '#08080a', bg2: '#0e0e12', grid: 'rgba(255,255,255,0.035)' },
  monad: { name: 'Monad', bg: '#0d0820', bg2: '#1c1240', grid: 'rgba(160,140,255,0.06)' },
  phosphor: { name: 'Phosphor', bg: '#050705', bg2: '#0a0d0a', grid: 'rgba(255,255,255,0.04)' },
};

const VENUES: Record<Venue, { name: string; bg: string; ink: string; icon?: string }> = {
  perpl: { name: 'PERPL', bg: '#6b5ce7', ink: '#ffffff', icon: '/perps/perpl.jpg' },
  bulk: { name: 'BULK', bg: '#f2f2f2', ink: '#0a0a0a', icon: '/perps/bulk.jpg' },
  hyperliquid: { name: 'HYPERLIQUID', bg: '#97fce4', ink: '#04241d' },
  monad: { name: 'MONAD', bg: '#836ef9', ink: '#ffffff' },
};

/* ---------------------------------------------------------------------------------- helpers ---- */

const TAU = Math.PI * 2;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const ease = (x: number) => x * x * (3 - 2 * x);
const fract = (x: number) => x - Math.floor(x);
/** Cheap deterministic hash → [0, 1). */
const hash = (n: number) => fract(Math.sin(n * 127.1 + 311.7) * 43758.5453);

function hexA(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

/** The mood a card shows: position ROE, or the period % (its sign when there is no %). */
export function moodOf(d: CardData): Mood {
  if (d.kind === 'position' && d.liquidated) return 'rekt';
  const v = d.kind === 'period' ? (d.pct ?? (d.netUsd >= 0 ? 5 : -5)) : d.roe;
  if (v >= 100) return 'moon';
  if (v >= 25) return 'pump';
  if (v >= 0) return 'comfy';
  if (v > -25) return 'cope';
  if (v > -80) return 'pain';
  return 'rekt';
}

function fmtRoe(v: number) {
  const a = Math.abs(v);
  const dp = a >= 1000 ? 0 : a >= 100 ? 1 : 2;
  const s = a.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  return `${v >= 0 ? '+' : '-'}${s}%`;
}
/** Signed dollars for a share card: "+$1,234.56" (ASCII minus — VT323 has no U+2212). */
const usd = (v: number) =>
  `${v < 0 ? '-' : '+'}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
function fmtEntry(v: number | null) {
  if (v === null || !Number.isFinite(v)) return '—';
  const dp = v >= 1000 ? 1 : v >= 1 ? 3 : 6;
  return v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
function fmtHeld(sec: number | null) {
  if (sec === null) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

/* ---------------------------------------------------------------------------------- sprites ---- */

interface Sprite {
  w: number;
  h: number;
  /** Colour per cell, null = transparent. */
  px: Array<Array<string | null>>;
  /** Bluish cells (tears / sweat): they shimmer and drip when animated. */
  tears: Array<[number, number]>;
}

interface SpriteJson {
  w: number;
  h: number;
  palette: string[];
  rows: string[];
}

const CHARS = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

function decodeSprite(s: SpriteJson): Sprite {
  const px = s.rows.map((row) =>
    [...row].map((ch) => (ch === '.' ? null : (s.palette[CHARS.indexOf(ch)] ?? null))),
  );
  const tears: Array<[number, number]> = [];
  px.forEach((row, y) =>
    row.forEach((c, x) => {
      if (!c) return;
      const n = parseInt(c.slice(1), 16);
      const r = n >> 16;
      const g = (n >> 8) & 255;
      const b = n & 255;
      if (b > r + 50 && b > g + 8) tears.push([x, y]);
    }),
  );
  return { w: s.w, h: s.h, px, tears };
}

/** The sign-in Chog (58×58 map) as a sprite. */
function classicSprite(): Sprite {
  const n = 58;
  const px: Array<Array<string | null>> = Array.from({ length: n }, () => Array<string | null>(n).fill(null));
  for (let i = 0; i < CHOG_CELLS_HEX.length; i += 6) {
    const x = parseInt(CHOG_CELLS_HEX.slice(i, i + 2), 16);
    const y = parseInt(CHOG_CELLS_HEX.slice(i + 2, i + 4), 16);
    const v = parseInt(CHOG_CELLS_HEX.slice(i + 4, i + 6), 16);
    const row = px[y];
    if (row && x < n) row[x] = `rgb(${v},${v},${v})`;
  }
  return { w: n, h: n, px, tears: [] };
}

/** One bevelled tile, like the blocks of the owner's artwork. */
function block(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, color: string) {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, s, s);
  if (s < 5) return;
  const b = Math.max(1, Math.round(s * 0.12));
  ctx.fillStyle = 'rgba(255,255,255,0.13)';
  ctx.fillRect(x, y, s, b);
  ctx.fillRect(x, y, b, s);
  ctx.fillStyle = 'rgba(0,0,0,0.26)';
  ctx.fillRect(x, y + s - b, s, b);
  ctx.fillRect(x + s - b, y, b, s);
}

type Overlay = Map<string, string>;

/**
 * Face and props for the classic Chog, in map cells (eyes x26–31 / x38–45 × y30–35, mouth y39).
 * Returns a sparse override map "x,y" → colour.
 */
function faceOverlay(mood: Mood, t: number, anim: boolean): Overlay {
  const o: Overlay = new Map();
  const set = (x: number, y: number, c: string) => o.set(`${x},${y}`, c);
  const rect = (x0: number, y0: number, x1: number, y1: number, c: string) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(x, y, c);
  };
  const pts = (list: Array<[number, number]>, c: string) => list.forEach(([x, y]) => set(x, y, c));
  const L = C.line;
  const MOUTH = '#3a1418';
  const TONGUE = '#d0606a';
  const clearMouth = () => rect(31, 37, 41, 42, C.skin);
  const clearEyes = () => {
    rect(25, 29, 32, 36, C.skin);
    rect(37, 29, 46, 36, C.skin);
  };
  const blinkLids = (amt: number) => {
    if (amt < 0.05) return;
    for (const e of [
      { x0: 27, x1: 30, y0: 30, y1: 34 },
      { x0: 39, x1: 44, y0: 30, y1: 34 },
    ]) {
      const rows = Math.round(amt * (e.y1 - e.y0 + 1));
      rect(e.x0, e.y0, e.x1, e.y0 + rows - 1, C.skin);
      if (amt > 0.8) for (let x = e.x0 - 1; x <= e.x1 + 1; x++) set(x, e.y0 + rows - 1, L);
    }
  };
  // A natural blink once per loop.
  const bp = (fract(t / LOOP) - 0.62) / 0.05;
  const blink = anim && bp > 0 && bp < 1 ? Math.sin(Math.PI * bp) : 0;

  if (mood === 'moon') {
    // Pixel shades with a moving glint, a wide grin and a gold chain.
    const LENS = '#141420';
    rect(23, 29, 47, 29, L);
    rect(24, 30, 32, 33, LENS);
    rect(37, 30, 46, 33, LENS);
    rect(25, 34, 31, 34, LENS);
    rect(38, 34, 45, 34, LENS);
    rect(33, 30, 36, 30, L);
    set(22, 30, L);
    set(48, 30, L);
    pts(
      [
        [25, 30],
        [26, 30],
        [25, 31],
        [38, 30],
        [39, 30],
        [38, 31],
      ],
      '#5a5a78',
    );
    const g = anim ? fract(t / LOOP) * 1.6 - 0.3 : 0.25;
    for (let y = 30; y <= 34; y++)
      for (let x = 24; x <= 46; x++) {
        const k = (x - 24) / 22 + (y - 30) * 0.06;
        if (Math.abs(k - g) < 0.05 && o.get(`${x},${y}`) === LENS) set(x, y, '#d8d8ff');
      }
    clearMouth();
    rect(32, 38, 40, 38, L);
    pts(
      [
        [31, 37],
        [41, 37],
        [32, 39],
        [40, 39],
        [33, 40],
        [39, 40],
      ],
      L,
    );
    rect(33, 39, 39, 39, MOUTH);
    rect(34, 40, 38, 40, MOUTH);
    rect(36, 40, 37, 40, TONGUE);
    rect(34, 41, 38, 41, L);
    rect(33, 38, 39, 38, '#f5f5f5'); // teeth
    // Chain across the neck with a coin.
    const chain: Array<[number, number]> = [
      [22, 43],
      [24, 44],
      [26, 45],
      [28, 46],
      [30, 46],
      [32, 47],
      [34, 47],
      [36, 47],
      [38, 46],
      [40, 45],
      [42, 44],
    ];
    chain.forEach(([x, y], i) => set(x, y, i % 2 ? '#c99a1e' : C.gold));
    rect(31, 48, 35, 51, C.gold);
    rect(32, 49, 34, 50, '#c99a1e');
    set(33, 48, '#fff2b0');
  } else if (mood === 'pump') {
    clearEyes();
    // Happy ^ ^ eyes.
    const arcs: Array<[number, number]> = [
      [26, 34],
      [27, 33],
      [28, 32],
      [29, 32],
      [30, 33],
      [31, 34],
      [38, 34],
      [39, 33],
      [40, 32],
      [41, 32],
      [42, 32],
      [43, 32],
      [44, 33],
      [45, 34],
    ];
    for (const [x, y] of arcs) {
      set(x, y, L);
      set(x, y + 1, L);
    }
    clearMouth();
    rect(32, 38, 40, 38, L);
    pts(
      [
        [32, 39],
        [40, 39],
        [33, 40],
        [39, 40],
      ],
      L,
    );
    rect(33, 39, 39, 39, MOUTH);
    rect(34, 40, 38, 40, TONGUE);
    rect(34, 41, 38, 41, L);
  } else if (mood === 'comfy') {
    blinkLids(blink);
    clearMouth();
    pts(
      [
        [33, 38],
        [39, 38],
        [34, 39],
        [38, 39],
      ],
      L,
    );
    rect(35, 40, 37, 40, L);
    rect(35, 39, 37, 39, MOUTH);
  } else if (mood === 'cope') {
    blinkLids(blink);
    // Worried brows, a wobbly mouth and a sweat drop sliding down the temple.
    pts(
      [
        [27, 27],
        [28, 27],
        [29, 26],
        [30, 26],
        [40, 26],
        [41, 26],
        [42, 27],
        [43, 27],
      ],
      L,
    );
    clearMouth();
    pts(
      [
        [32, 39],
        [33, 40],
        [34, 39],
        [35, 40],
        [36, 39],
        [37, 40],
        [38, 39],
        [39, 40],
        [40, 39],
      ],
      L,
    );
    const dy = 24 + (anim ? Math.floor(ease(fract(t / 2)) * 6) : 1);
    set(44, dy, C.tearHi);
    rect(43, dy + 1, 45, dy + 2, C.tear);
    set(44, dy + 3, C.tear);
    set(43, dy + 1, C.tearHi);
  } else if (mood === 'pain') {
    // Sad brows and lids, tear streams, an upside-down mouth.
    pts(
      [
        [26, 28],
        [27, 28],
        [28, 27],
        [29, 27],
        [30, 26],
        [31, 26],
        [38, 26],
        [39, 26],
        [40, 27],
        [41, 27],
        [42, 28],
        [43, 28],
      ],
      L,
    );
    rect(27, 30, 30, 30, C.skin);
    rect(39, 30, 44, 30, C.skin);
    rect(27, 31, 30, 31, '#9a9aa2');
    rect(39, 31, 44, 31, '#9a9aa2');
    for (let y = 35; y <= 43; y++) {
      const w = anim && Math.floor(t * 8 + y) % 4 === 0 ? C.tearHi : C.tear;
      set(28, y, w);
      set(29, y, C.tear);
      set(41, y, C.tear);
      set(42, y, w);
    }
    clearMouth();
    pts(
      [
        [32, 41],
        [33, 40],
        [34, 39],
        [35, 39],
        [36, 39],
        [37, 39],
        [38, 40],
        [39, 41],
      ],
      L,
    );
  } else {
    // rekt: X eyes and a wobbly open mouth.
    clearEyes();
    const X = (x0: number, y0: number, n: number) => {
      for (let i = 0; i < n; i++)
        pts(
          [
            [x0 + i, y0 + i],
            [x0 + n - 1 - i, y0 + i],
            [x0 + i + 1, y0 + i],
            [x0 + n - i, y0 + i],
          ],
          L,
        );
    };
    X(26, 29, 6);
    X(39, 29, 6);
    clearMouth();
    const wob = anim ? Math.max(0, Math.round(Math.sin(t * TAU * 2))) : 0;
    rect(34, 38, 38, 38, L);
    pts(
      [
        [33, 39],
        [39, 39],
        [33, 40],
        [39, 40],
      ],
      L,
    );
    rect(34, 39, 38, 40 + wob, '#2a0c10');
    rect(34, 41 + wob, 38, 41 + wob, L);
    rect(35, 40, 36, 40, TONGUE);
  }
  return o;
}

/** Per-frame overlay for drawn art: tears and sweat shimmer as if flowing. */
function artOverlay(sp: Sprite, t: number, anim: boolean): Overlay {
  const o: Overlay = new Map();
  if (!anim) return o;
  const f = Math.floor(t * 10);
  for (const [x, y] of sp.tears) if ((y - f) % 5 === 0) o.set(`${x},${y}`, C.tearHi);
  return o;
}

const PAD = 4;
const baseCache = new WeakMap<Sprite, { cv: HTMLCanvasElement; s: number }>();

/** Cached tiles of a sprite at cell size `s`. */
function spriteBase(sp: Sprite, s: number) {
  let base = baseCache.get(sp);
  if (!base || base.s !== s) {
    const cv = document.createElement('canvas');
    cv.width = (sp.w + PAD * 2) * s;
    cv.height = (sp.h + PAD * 2) * s;
    const ctx = cv.getContext('2d')!;
    sp.px.forEach((row, y) => row.forEach((c, x) => c && block(ctx, (x + PAD) * s, (y + PAD) * s, s, c)));
    base = { cv, s };
    baseCache.set(sp, base);
  }
  return base.cv;
}

let frameCanvas: HTMLCanvasElement | null = null;
/** Sprite + this frame's overlay cells + an optional shine sweep (on a reused scratch canvas). */
function spriteFrame(sp: Sprite, s: number, overlay: Overlay, shine: number | null) {
  const base = spriteBase(sp, s);
  if (!overlay.size && shine === null) return base;
  const cv = (frameCanvas ??= document.createElement('canvas'));
  cv.width = base.width;
  cv.height = base.height;
  const ctx = cv.getContext('2d')!;
  ctx.drawImage(base, 0, 0);
  for (const [k, c] of overlay) {
    const [x = 0, y = 0] = k.split(',').map(Number);
    block(ctx, (x + PAD) * s, (y + PAD) * s, s, c);
  }
  if (shine !== null) {
    // A diagonal light band sweeping over the figure only.
    ctx.globalCompositeOperation = 'source-atop';
    const w = cv.width;
    const x = -w * 0.6 + shine * w * 2.2;
    const g = ctx.createLinearGradient(x, 0, x + w * 0.22, w * 0.22);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.5, 'rgba(255,255,255,0.28)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, cv.height);
  }
  return cv;
}

const tintCache = new WeakMap<HTMLCanvasElement, Record<string, HTMLCanvasElement>>();
/** Solid-colour silhouette of a figure, for the RGB fringe behind it. */
function tint(src: HTMLCanvasElement, color: string) {
  let m = tintCache.get(src);
  if (!m) tintCache.set(src, (m = {}));
  const hit = m[color];
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  const x = c.getContext('2d')!;
  x.drawImage(src, 0, 0);
  x.globalCompositeOperation = 'source-in';
  x.fillStyle = color;
  x.fillRect(0, 0, c.width, c.height);
  m[color] = c;
  return c;
}

/* ------------------------------------------------------------------------------- CRT pieces ---- */

interface TextOpts {
  size: number;
  color: string;
  glow?: number;
  fringe?: number;
  align?: CanvasTextAlign;
}

/** Text with RGB fringing and phosphor glow (the app's CRT type). Returns its width. */
function crtText(ctx: CanvasRenderingContext2D, str: string, x: number, y: number, o: TextOpts) {
  const { size, color, glow = 0.55, fringe = 1.4, align = 'left' } = o;
  ctx.save();
  ctx.font = `${size}px ${FONT}`;
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  if (fringe) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = 'rgba(255,40,80,0.45)';
    ctx.fillText(str, x - fringe, y);
    ctx.fillStyle = 'rgba(40,170,255,0.45)';
    ctx.fillText(str, x + fringe, y);
    ctx.globalCompositeOperation = 'source-over';
  }
  if (glow) {
    ctx.shadowColor = color;
    ctx.shadowBlur = size * 0.22 * glow;
  }
  ctx.fillStyle = color;
  ctx.fillText(str, x, y);
  const w = ctx.measureText(str).width;
  ctx.restore();
  return w;
}

function chip(
  ctx: CanvasRenderingContext2D,
  str: string,
  x: number,
  y: number,
  o: { size?: number; bg: string; ink: string; align?: 'left' | 'right'; padX?: number; h?: number },
) {
  const { size = 30, bg, ink, align = 'left', padX = 14, h = 40 } = o;
  ctx.save();
  ctx.font = `${size}px ${FONT}`;
  const w = ctx.measureText(str).width + padX * 2;
  const x0 = align === 'right' ? x - w : x;
  ctx.shadowColor = bg;
  ctx.shadowBlur = 14;
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.roundRect(x0, y, w, h, 6);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = ink;
  ctx.textBaseline = 'middle';
  ctx.fillText(str, x0 + padX, y + h / 2 + 2);
  ctx.restore();
  return w;
}

function drawBackground(ctx: CanvasRenderingContext2D, theme: CardTheme, mood: Mood) {
  const th = THEMES[theme];
  const m = MOODS[mood];
  const g = ctx.createLinearGradient(0, 0, CARD_W, CARD_H);
  g.addColorStop(0, th.bg);
  g.addColorStop(1, th.bg2);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, CARD_W, CARD_H);
  // Pixel grid, like the artwork's backdrop.
  ctx.fillStyle = th.grid;
  for (let x = 0; x < CARD_W; x += 25) ctx.fillRect(x, 0, 1, CARD_H);
  for (let y = 0; y < CARD_H; y += 25) ctx.fillRect(0, y, CARD_W, 1);
  // Mood glow behind Chog.
  const rg = ctx.createRadialGradient(930, 380, 20, 930, 380, 520);
  rg.addColorStop(0, hexA(m.tint, 0.3));
  rg.addColorStop(0.45, hexA(m.tint, 0.08));
  rg.addColorStop(1, hexA(m.tint, 0));
  ctx.fillStyle = rg;
  ctx.fillRect(0, 0, CARD_W, CARD_H);
  // Ghost word behind the character.
  ctx.save();
  ctx.font = `360px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.fillStyle = hexA(m.tint, theme === 'monad' ? 0.07 : 0.055);
  ctx.fillText(m.label, 930, 520);
  ctx.restore();
}

/* --------------------------------------------------------------------------- mood backdrops ---- */

function pixelStar(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, a: number, color: string) {
  ctx.fillStyle = hexA(color, a);
  ctx.fillRect(x - s / 2, y - s * 1.5, s, s * 3);
  ctx.fillRect(x - s * 1.5, y - s / 2, s * 3, s);
  ctx.fillStyle = `rgba(255,255,255,${a})`;
  ctx.fillRect(x - s / 2, y - s / 2, s, s);
}

function heart(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, color: string) {
  ctx.fillStyle = color;
  ['.XX.XX.', 'XXXXXXX', 'XXXXXXX', '.XXXXX.', '..XXX..', '...X...'].forEach((r, j) =>
    [...r].forEach((ch, i) => ch === 'X' && ctx.fillRect(x + i * s, y + j * s, s, s)),
  );
}

/** "This is fine": pixel flames along the bottom. */
function fire(ctx: CanvasRenderingContext2D, t: number, anim: boolean) {
  const s = 10;
  for (let i = 0; i < 62; i++) {
    const x = 560 + i * s;
    const ph = anim ? t * TAU : 0;
    const n = 0.5 + 0.5 * Math.sin(ph * 1.5 + i * 0.9) * Math.sin(ph * 0.5 + i * 0.37);
    const h = Math.round(4 + n * 9 + hash(i) * 4);
    for (let j = 0; j < h; j++) {
      const k = j / h;
      const c = k < 0.35 ? '#fff1a8' : k < 0.65 ? '#ffb02e' : k < 0.88 ? '#ff6a1f' : '#c8321d';
      ctx.fillStyle = hexA(c, 0.9 * (1 - k * 0.5));
      ctx.fillRect(x, CARD_H - (j + 1) * s, s - 1, s - 1);
    }
  }
}

function backdrop(ctx: CanvasRenderingContext2D, mood: Mood, t: number, anim: boolean) {
  const p = fract(t / LOOP);
  ctx.save();
  if (mood === 'moon') {
    // Slowly turning sunburst (two wedges per loop, so the loop is seamless).
    ctx.translate(930, 360);
    ctx.rotate(anim ? p * (TAU / 8) : 0);
    ctx.fillStyle = hexA(C.gold, 0.06);
    for (let i = 1; i < 16; i += 2) {
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, 900, (i * TAU) / 16, ((i + 1) * TAU) / 16);
      ctx.fill();
    }
    ctx.restore();
    ctx.save();
    for (let i = 0; i < 9; i++) {
      const x = 660 + hash(i) * 520;
      const y = 70 + hash(i + 40) * 420;
      const a = anim ? 0.25 + 0.75 * Math.max(0, Math.sin(TAU * (p * 2 + hash(i + 9)))) : 0.6;
      pixelStar(ctx, Math.round(x / 5) * 5, Math.round(y / 5) * 5, 5, a, C.gold);
    }
  } else if (mood === 'pump') {
    // Green candles stepping up; the last (live) one breathes.
    for (let i = 0; i < 7; i++) {
      const x = 640 + i * 78;
      const grow = anim && i === 6 ? 0.92 + 0.08 * Math.sin(p * TAU * 4) : 1;
      const top = 610 - (90 + i * 55) * grow;
      ctx.fillStyle = hexA(C.up, 0.14);
      ctx.fillRect(x + 13, top - 30, 4, 80 + i * 10 + 60);
      ctx.fillStyle = hexA(C.up, 0.22);
      ctx.fillRect(x, top, 30, 80 + i * 10);
    }
  } else if (mood === 'comfy') {
    for (let i = 0; i < 7; i++) {
      const q = fract((anim ? p : 0.4) + hash(i));
      const x = 700 + hash(i + 3) * 460;
      const y = 600 - q * 520;
      heart(
        ctx,
        Math.round(x / 4) * 4,
        Math.round(y / 4) * 4,
        4,
        hexA('#ff7aa8', Math.sin(Math.PI * q) * 0.55),
      );
    }
  } else if (mood === 'cope') {
    fire(ctx, t, anim);
  } else if (mood === 'pain') {
    // Red candles going down.
    for (let i = 0; i < 7; i++) {
      const x = 640 + i * 78;
      const top = 120 + i * 60;
      ctx.fillStyle = hexA(C.down, 0.12);
      ctx.fillRect(x + 13, top - 30, 4, 170);
      ctx.fillStyle = hexA(C.down, 0.2);
      ctx.fillRect(x, top, 30, 110);
    }
  } else {
    // rekt: one giant red candle and a crashing line.
    ctx.fillStyle = hexA(C.down, 0.12);
    ctx.fillRect(1090, 30, 10, 640);
    ctx.fillStyle = hexA(C.down, 0.22);
    ctx.fillRect(1060, 60, 70, 560);
    ctx.strokeStyle = hexA(C.down, 0.45);
    ctx.lineWidth = 5;
    ctx.beginPath();
    const line: Array<[number, number]> = [
      [620, 140],
      [700, 120],
      [760, 170],
      [820, 150],
      [880, 260],
      [930, 240],
      [990, 520],
      [1040, 600],
    ];
    line.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
  }
  ctx.restore();
}

/* --------------------------------------------------------------------------- mood particles ---- */

function bill(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, rot: number, flip: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.scale(1, flip);
  const h = w * 0.5;
  ctx.fillStyle = '#1f8a4a';
  ctx.fillRect(-w / 2, -h / 2, w, h);
  ctx.fillStyle = '#5fe08f';
  ctx.fillRect(-w / 2 + 3, -h / 2 + 3, w - 6, h - 6);
  ctx.fillStyle = '#1f8a4a';
  ctx.fillRect(-w / 2 + 6, -h / 2 + 6, w - 12, h - 12);
  ctx.fillStyle = '#a6f5c2';
  ctx.font = `${h * 0.9}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('$', 0, 1);
  ctx.restore();
}

function coin(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, spin: number) {
  const w = Math.max(2, Math.round(Math.abs(Math.cos(spin)) * 4)) * s;
  ctx.fillStyle = '#b98512';
  ctx.fillRect(x - w / 2, y - 2 * s, w, 4 * s);
  ctx.fillStyle = C.gold;
  ctx.fillRect(x - w / 2 + s * 0.5, y - 1.5 * s, Math.max(1, w - s), 3 * s);
  if (w > 2 * s) {
    ctx.fillStyle = '#fff2b0';
    ctx.fillRect(x - s * 0.5, y - s, s, 2 * s);
  }
}

function rain(ctx: CanvasRenderingContext2D, mood: Mood, t: number) {
  const p = fract(t / LOOP);
  ctx.save();
  ctx.strokeStyle = mood === 'rekt' ? 'rgba(255,90,100,0.18)' : 'rgba(120,200,255,0.16)';
  ctx.lineWidth = 2;
  for (let i = 0; i < 70; i++) {
    const x = hash(i) * (CARD_W + 200) - 100;
    const y = fract(hash(i + 70) + p * 3) * (CARD_H + 120) - 60;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - 10, y + 34);
    ctx.stroke();
  }
  ctx.restore();
}

interface Figure {
  x: number;
  y: number;
  s: number;
  sp: Sprite;
  drawn: boolean;
}

function particlesFront(ctx: CanvasRenderingContext2D, mood: Mood, t: number, anim: boolean, fig: Figure) {
  const p = fract(t / LOOP);
  if (mood === 'moon') {
    if (!anim) {
      // Still frame: a few bills around (not over) the face.
      const still: Array<[number, number, number, number]> = [
        [700, 150, -0.4, 1],
        [1135, 175, 0.5, 0.7],
        [1150, 420, -0.3, 1],
        [680, 470, 0.35, -0.8],
        [760, 610, -0.2, 1],
      ];
      for (const [x, y, r, f] of still) bill(ctx, x, y, 62, r, f);
      return;
    }
    for (let i = 0; i < 16; i++) {
      const q = fract(p + hash(i + 5));
      const x = 640 + hash(i) * 540 + Math.sin(q * TAU * 2 + i) * 22;
      bill(
        ctx,
        x,
        -60 + q * (CARD_H + 120),
        54 + hash(i + 2) * 18,
        Math.sin(q * TAU + i) * 0.6,
        Math.cos(q * TAU * 3 + i),
      );
    }
  } else if (mood === 'pump') {
    if (!anim) {
      // The drawn art has its own coins in the still frame.
      if (!fig.drawn)
        for (const [x, y, k] of [
          [690, 190, 0.3],
          [1150, 140, 1.2],
          [1160, 470, 0],
          [700, 560, 2],
        ] as const)
          coin(ctx, x, y, 5, k);
      return;
    }
    for (let i = 0; i < 10; i++) {
      const q = fract(p * 2 + hash(i + 11));
      coin(ctx, 660 + hash(i + 1) * 520, CARD_H + 20 - q * (CARD_H + 60), 5, q * TAU * 3 + i);
    }
  } else if ((mood === 'pain' || mood === 'rekt') && anim) {
    // Drops falling from the lowest tear cell of each stream (classic Chog: from the cheeks).
    const streams: Array<[number, number]> = [];
    if (fig.drawn) {
      const low = new Map<number, [number, number]>();
      for (const [x, y] of fig.sp.tears) {
        const k = x >> 2;
        const cur = low.get(k);
        if (!cur || cur[1] < y) low.set(k, [x, y]);
      }
      streams.push(...low.values());
    } else if (mood === 'pain') streams.push([28, 43], [42, 43]);
    streams.forEach(([x, y], i) => {
      const q = fract(p * 2 + hash(i) * 0.7);
      ctx.fillStyle = hexA(C.tear, 0.9 * (1 - q));
      ctx.fillRect(
        fig.x + (x + PAD) * fig.s,
        fig.y + (y + PAD + 1) * fig.s + q * 160,
        fig.s * 1.5,
        fig.s * 2,
      );
    });
  }
}

/** Scanlines, rolling glare band, noise, tearing (rekt), vignette and the Phosphor monochrome tint. */
function crtOverlay(
  ctx: CanvasRenderingContext2D,
  theme: CardTheme,
  mood: Mood,
  t: number,
  anim: boolean,
  scale: number,
) {
  const p = fract(t / LOOP);
  ctx.save();
  if (theme === 'phosphor') {
    ctx.globalCompositeOperation = 'color';
    ctx.fillStyle = MOODS[mood].color;
    ctx.fillRect(0, 0, CARD_W, CARD_H);
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  for (let y = 0; y < CARD_H; y += 3) ctx.fillRect(0, y, CARD_W, 1);
  const by = (anim ? p : 0.3) * (CARD_H + 240) - 120;
  const gb = ctx.createLinearGradient(0, by - 90, 0, by + 90);
  gb.addColorStop(0, 'rgba(255,255,255,0)');
  gb.addColorStop(0.5, 'rgba(255,255,255,0.035)');
  gb.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gb;
  ctx.fillRect(0, by - 90, CARD_W, 180);
  const seed = anim ? Math.floor(t * 24) : 1;
  ctx.fillStyle = 'rgba(255,255,255,0.035)';
  for (let i = 0; i < 900; i++)
    ctx.fillRect(hash(i * 1.37 + seed * 17.1) * CARD_W, hash(i * 2.11 + seed * 9.7) * CARD_H, 2, 2);
  if (anim && mood === 'rekt' && fract(t * 0.75) < 0.18) {
    for (let i = 0; i < 3; i++) {
      const y = hash(Math.floor(t * 12) + i) * CARD_H;
      ctx.drawImage(ctx.canvas, 0, y * scale, CARD_W * scale, 14 * scale, 18 - i * 12, y, CARD_W, 14);
    }
    ctx.fillStyle = 'rgba(255,40,60,0.07)';
    ctx.fillRect(0, 0, CARD_W, CARD_H);
  }
  const v = ctx.createRadialGradient(
    CARD_W / 2,
    CARD_H / 2,
    CARD_H * 0.45,
    CARD_W / 2,
    CARD_H / 2,
    CARD_H * 1.05,
  );
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, CARD_W, CARD_H);
  ctx.restore();
}

/* ----------------------------------------------------------------------------------- assets ---- */

export interface CardAssets {
  classic: Sprite;
  flex: Partial<Record<Mood, Sprite>>;
  images: Record<string, HTMLImageElement | null>;
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement | null>((res) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => res(null);
    i.src = src;
  });
}

let assetsPromise: Promise<CardAssets> | null = null;
/** Sprites, brand images and the VT323 face — loaded once and shared by every card. */
export function loadCardAssets(): Promise<CardAssets> {
  assetsPromise ??= (async () => {
    const moods = Object.keys(MOODS) as Mood[];
    const [flex, mark, perpl, bulk] = await Promise.all([
      Promise.all(
        moods.map(async (m) => {
          const r = await fetch(`${BRAND.pnlCardArt}/flex_${m}.json`).catch(() => null);
          return [m, r?.ok ? decodeSprite((await r.json()) as SpriteJson) : undefined] as const;
        }),
      ),
      loadImage(BRAND.mark),
      loadImage(VENUES.perpl.icon!),
      loadImage(VENUES.bulk.icon!),
      document.fonts.load(`40px ${FONT}`),
    ]);
    return {
      classic: classicSprite(),
      flex: Object.fromEntries(flex.filter(([, s]) => s)),
      images: { mark, perpl, bulk },
    };
  })();
  return assetsPromise;
}

/* ----------------------------------------------------------------------------------- render ---- */

/** Draws one frame of the card onto `cv` (resized to CARD_W×CARD_H × scale). Returns the mood. */
export function renderCard(cv: HTMLCanvasElement, d: CardData, a: CardAssets, o: RenderOptions): Mood {
  const { scale, theme } = o;
  const t = o.t ?? 0;
  const anim = !!o.anim;
  const p = fract(t / LOOP);
  const mood = moodOf(d);
  const m = MOODS[mood];
  if (cv.width !== CARD_W * scale || cv.height !== CARD_H * scale) {
    cv.width = CARD_W * scale;
    cv.height = CARD_H * scale;
  }
  const ctx = cv.getContext('2d')!;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);

  // Screen shake for rekt.
  const shake =
    anim && mood === 'rekt' ? (hash(Math.floor(t * 12)) - 0.5) * 6 * (fract(t * 0.75) < 0.18 ? 1 : 0.15) : 0;
  ctx.save();
  ctx.translate(shake, 0);

  drawBackground(ctx, theme, mood);
  backdrop(ctx, mood, t, anim);
  if (anim && (mood === 'pain' || mood === 'rekt')) rain(ctx, mood, t);

  /* ---- Chog ---- */
  const art = o.pack === 'flex' ? a.flex[mood] : undefined;
  const sp = art ?? a.classic;
  const drawn = !!art;
  // The classic map is 58 rows at 10 px; drawn art is scaled to the same on-card height.
  const s = drawn ? Math.max(6, Math.round(600 / sp.h)) : 10;
  const overlay = drawn ? artOverlay(sp, t, anim) : faceOverlay(mood, t, anim);
  // Winners get a shine sweep once per loop.
  const sw = (p - 0.08) / 0.3;
  const shine = anim && (mood === 'moon' || mood === 'pump') && sw > 0 && sw < 1 ? sw : null;
  const fig = spriteFrame(sp, s, overlay, shine);
  const bob = anim
    ? Math.round((Math.sin(p * TAU * 2) * (mood === 'moon' || mood === 'pump' ? 6 : 3)) / 2) * 2
    : 0;
  // Cope trembles. The classic Chog slumps when it hurts; drawn art keeps its props in frame.
  const jitter =
    anim && mood === 'cope' && fract(t * 1.75) < 0.3 ? (Math.floor(t * 30) % 2 ? s : -s) * 0.5 : 0;
  const sag = drawn ? -14 : mood === 'pain' || mood === 'rekt' ? 18 : 0;
  const fx = (drawn ? 915 : 930) - fig.width / 2 + jitter;
  const fy = CARD_H - fig.height + PAD * s + 24 + sag + bob;
  ctx.save();
  // RGB fringing peeks out from behind the figure, then the figure with a phosphor glow.
  ctx.globalAlpha = 0.55;
  ctx.drawImage(tint(spriteBase(sp, s), '#ff2850'), fx - 3, fy);
  ctx.drawImage(tint(spriteBase(sp, s), '#28aaff'), fx + 3, fy);
  ctx.globalAlpha = 1;
  ctx.shadowColor = hexA(m.tint, 0.5);
  ctx.shadowBlur = 40;
  ctx.drawImage(fig, fx, fy);
  ctx.restore();

  particlesFront(ctx, mood, t, anim, { x: fx, y: fy, s, sp, drawn });

  /* ---- Text column ---- */
  const X = 64;
  const mark = a.images.mark;
  if (mark) {
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(X, 46, 52, 52, 10);
    ctx.clip();
    ctx.drawImage(mark, X, 46, 52, 52);
    ctx.restore();
  }
  crtText(ctx, BRAND.name.toUpperCase(), X + 68, 85, { size: 40, color: C.ink, glow: 0.4 });
  if (d.kind === 'position' && d.venue) {
    const v = VENUES[d.venue];
    const w = chip(ctx, v.name, CARD_W - 56, 51, { bg: v.bg, ink: v.ink, align: 'right' });
    const icon = a.images[d.venue];
    if (icon) {
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(CARD_W - 56 - w - 52, 51, 40, 40, 8);
      ctx.clip();
      ctx.drawImage(icon, CARD_W - 56 - w - 52, 51, 40, 40);
      ctx.restore();
    }
  }

  const y = 168;
  if (d.kind === 'period') {
    crtText(ctx, 'NET REALIZED PNL', X, y - 10, { size: 36, color: C.ink2, glow: 0.2 });
    crtText(ctx, `${d.from} → ${d.to}`, X, y + 24, { size: 28, color: C.muted, glow: 0, fringe: 0.8 });
  } else {
    const pw = crtText(ctx, d.pair.toUpperCase(), X, y, { size: 52, color: C.ink, glow: 0.35 });
    const long = d.side === 'long';
    chip(ctx, `${long ? 'LONG' : 'SHORT'} ${d.leverage}x`, X + pw + 18, y - 38, {
      bg: long ? C.up : C.down,
      ink: '#07130b',
    });
  }

  // Hero number: ROE for positions, % for periods (falls back to $).
  const hero = d.kind === 'period' ? (d.pct !== null ? fmtRoe(d.pct) : usd(d.netUsd)) : fmtRoe(d.roe);
  let heroSize = 188;
  ctx.font = `${heroSize}px ${FONT}`;
  while (ctx.measureText(hero).width > 560 && heroSize > 110) {
    heroSize -= 6;
    ctx.font = `${heroSize}px ${FONT}`;
  }
  const glitch = anim && (mood === 'rekt' || mood === 'pain') && fract(t * 0.75) < 0.08;
  crtText(ctx, hero, X - 4 + (glitch ? 6 : 0), 352, {
    size: heroSize,
    color: m.color,
    glow: 0.9 + (anim ? 0.25 * Math.sin(p * TAU * 4) : 0),
    fringe: glitch ? 7 : 2.4,
  });
  const sub = d.kind === 'period' ? (d.pct !== null ? usd(d.netUsd) : null) : usd(d.pnlUsd);
  if (sub) crtText(ctx, sub, X, 414, { size: 58, color: C.ink, glow: 0.35 });

  if (o.stats) {
    const cols: Array<[string, string]> =
      d.kind === 'period'
        ? [
            ['FILLS', String(d.trades)],
            ['GREEN DAYS', String(d.winDays)],
            ['RED DAYS', String(d.lossDays)],
          ]
        : [
            ['ENTRY', fmtEntry(d.entry)],
            [d.liquidated ? 'LIQ PRICE' : 'EXIT', fmtEntry(d.exit)],
            ['HELD', fmtHeld(d.heldSec)],
          ];
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(X, 460, 520, 1);
    cols.forEach(([k, v], i) => {
      crtText(ctx, k, X + i * 180, 494, { size: 24, color: C.muted, glow: 0, fringe: 0.6 });
      crtText(ctx, v, X + i * 180, 532, { size: 36, color: C.ink, glow: 0.25, fringe: 0.9 });
    });
  }

  // Mood tag + caption (picked from the result, so the same card always says the same thing).
  const value = d.kind === 'period' ? d.netUsd : d.pnlUsd;
  const caption = m.captions[Math.abs(Math.round(value)) % m.captions.length]!;
  const up = mood === 'moon' || mood === 'pump' || mood === 'comfy';
  const tw = chip(ctx, `${up ? '▲' : '▼'} ${m.label}`, X, 572, {
    size: 28,
    bg: hexA(m.color, 0.16),
    ink: m.color,
    h: 38,
    padX: 12,
  });
  const caret = !anim || fract(t * 1.5) < 0.7 ? '_' : ' ';
  crtText(ctx, caption + caret, X + tw + 16, 602, { size: 30, color: C.ink2, glow: 0.3, fringe: 0.9 });

  // Footer: wallet, then when (position) or how the number was made (period).
  const addr =
    o.privacy === 'full' ? d.address : o.privacy === 'short' && d.address ? shortAddress(d.address, 4) : '';
  const tail =
    d.kind === 'period'
      ? [d.incomplete ? 'SOME FILLS UNPRICED · FEES INCLUDED' : 'FEES INCLUDED · ON-CHAIN RECONCILED']
      : [d.closedAt ?? '', d.ref ? `REF ${d.ref}` : ''];
  crtText(ctx, [addr, ...tail].filter(Boolean).join('  ·  '), X, CARD_H - 34, {
    size: 24,
    color: C.muted,
    glow: 0,
    fringe: 0.5,
  });

  if (mood === 'rekt') {
    // The LIQUIDATED / REKT stamp slams in at the start of each loop.
    const slam = anim ? ease(clamp(p * 6, 0, 1)) : 1;
    const label = d.kind === 'position' && d.liquidated ? 'LIQUIDATED' : 'REKT';
    ctx.save();
    ctx.translate(905, 318);
    ctx.rotate(-0.14);
    const k = 1 + (1 - slam) * 0.7;
    ctx.scale(k, k);
    ctx.globalAlpha = 0.25 + 0.75 * slam;
    ctx.strokeStyle = C.down;
    ctx.lineWidth = 6;
    ctx.shadowColor = C.down;
    ctx.shadowBlur = 18;
    ctx.font = `84px ${FONT}`;
    const lw = ctx.measureText(label).width + 44;
    ctx.strokeRect(-lw / 2, -48, lw, 90);
    ctx.fillStyle = C.down;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, 0, 2);
    ctx.restore();
  }

  ctx.restore(); // shake
  crtOverlay(ctx, theme, mood, t, anim, scale);
  return mood;
}

/** Plays the card in a loop on `cv` until the returned stop() is called. */
export function playCard(cv: HTMLCanvasElement, d: CardData, a: CardAssets, o: RenderOptions, fps = 30) {
  let raf = 0;
  let last = -Infinity;
  const t0 = performance.now();
  const tick = (now: number) => {
    raf = requestAnimationFrame(tick);
    if (now - last < 1000 / fps - 2) return;
    last = now;
    renderCard(cv, d, a, { ...o, anim: true, t: (now - t0) / 1000 });
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}

/** MediaRecorder type for the clip: MP4 where the browser can write it, else WebM; null = unsupported. */
export function videoType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  return (
    ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find((x) =>
      MediaRecorder.isTypeSupported(x),
    ) ?? null
  );
}

/** Records `loops` seamless cycles of the card as a video clip. */
export function recordCard(d: CardData, a: CardAssets, o: RenderOptions, loops = 2): Promise<Blob> {
  const type = videoType();
  if (!type) return Promise.reject(new Error('This browser cannot record canvas video.'));
  const cv = document.createElement('canvas');
  renderCard(cv, d, a, { ...o, anim: true, t: 0 });
  const rec = new MediaRecorder(cv.captureStream(30), { mimeType: type, videoBitsPerSecond: 8_000_000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  return new Promise((res, rej) => {
    const stop = playCard(cv, d, a, o);
    rec.onstop = () => {
      stop();
      res(new Blob(chunks, { type: type.split(';')[0] }));
    };
    rec.onerror = () => {
      stop();
      rej(new Error('Recording failed.'));
    };
    rec.start();
    setTimeout(() => rec.stop(), LOOP * loops * 1000);
  });
}
