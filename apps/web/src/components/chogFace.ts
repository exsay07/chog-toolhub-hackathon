/**
 * Life for the pixel Chog (58×58 cell map): swaying hair and three random expressions — a smile,
 * a (double) blink and a yawn — plus natural blinking. Everything is drawn in map cells on top of
 * the static figure, so it inherits the CRT treatment (fringing, scanlines, noise) for free.
 *
 * Map landmarks (measured on the artwork): face skin ≈ 230 grey, outlines ≈ 20, hair ≈ 60–90;
 * eyes x26–31 / x38–45 × y30–35; mouth a short dark line on y39 (x34–38) under the nose.
 */

export interface Cell {
  x: number;
  y: number;
  v: number;
}

export interface HairCell extends Cell {
  /** 0 at the roots → 1 at the tips: how far it sways. */
  w: number;
  /** Wave phase, so the sway travels along a lock instead of moving it rigidly. */
  ph: number;
  color: string;
}

const FACE_SEED = { x: 35, y: 33 };
/** Below this row it's neck / shirt, not hair. */
const BODY_FROM_Y = 44;

/**
 * Hair = the mid-dark cells outside the face. The face is found by flood-filling the light skin from
 * its centre; its row spans (plus the outline) are excluded, so blush, nose and outline never move.
 */
export function splitHair(cells: Cell[]): { hair: HairCell[]; isHair: (x: number, y: number) => boolean } {
  const at = new Map(cells.map((c) => [c.y * 64 + c.x, c.v]));
  const light = (x: number, y: number) => (at.get(y * 64 + x) ?? 0) >= 150;
  const face = new Set<number>();
  const stack = [FACE_SEED];
  while (stack.length) {
    const p = stack.pop()!;
    const k = p.y * 64 + p.x;
    if (face.has(k) || !light(p.x, p.y)) continue;
    face.add(k);
    stack.push(
      { x: p.x + 1, y: p.y },
      { x: p.x - 1, y: p.y },
      { x: p.x, y: p.y + 1 },
      { x: p.x, y: p.y - 1 },
    );
  }
  const span = new Map<number, [number, number]>();
  for (const k of face) {
    const x = k % 64;
    const y = (k - x) / 64;
    const s = span.get(y);
    span.set(y, s ? [Math.min(s[0], x), Math.max(s[1], x)] : [x, x]);
  }
  const inFace = (x: number, y: number) => {
    const s = span.get(y);
    return !!s && x >= s[0] - 1 && x <= s[1] + 1;
  };
  const hairSet = new Set<number>();
  const hair: HairCell[] = [];
  for (const c of cells) {
    // Includes the soft light edge pixels of the hair silhouette, so no ghost outline stays behind.
    if (c.y >= BODY_FROM_Y || c.v < 45 || c.v > 205 || inFace(c.x, c.y)) continue;
    // Top tuft sways from its tip (row 2) down to the crown (row 14); side locks from row 24 down.
    const w = c.y <= 14 ? (14 - c.y) / 12 : c.y <= 24 ? 0.12 : Math.min(1, (c.y - 24) / 18);
    const ph = c.y <= 14 ? (14 - c.y) * 0.45 : c.y * 0.32;
    hair.push({ ...c, w, ph, color: `rgb(${c.v},${c.v},${c.v})` });
    hairSet.add(c.y * 64 + c.x);
  }
  return { hair, isHair: (x, y) => hairSet.has(y * 64 + x) };
}

/** Horizontal / vertical sway of one hair cell at time `t` (seconds), in cells. */
export function hairOffset(h: HairCell, t: number): [number, number] {
  const gust = 0.55 + 0.45 * Math.sin(t * 0.37); // the "wind" breathes
  const dx = h.w * gust * (0.9 * Math.sin(t * 1.7 + h.ph) + 0.35 * Math.sin(t * 0.83 + h.ph * 0.6));
  const dy = h.w * 0.25 * Math.sin(t * 1.3 + h.ph + 1.1);
  return [dx, dy];
}

/* ---------------------------------------------------------------------------- expressions ---- */

export type Expression = 'smile' | 'blink' | 'yawn';
export interface FaceState {
  /** 0 open → 1 eyes shut. */
  lids: number;
  /** 0 → 1 smile. */
  smile: number;
  /** 0 → 1 mouth wide open. */
  yawn: number;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);
/** Rise over `a`, hold, fall over the last `a` of a 0..1 timeline. */
const envelope = (p: number, a = 0.2) =>
  p <= 0 || p >= 1 ? 0 : p < a ? ease(p / a) : p > 1 - a ? ease((1 - p) / a) : 1;
const ease = (x: number) => x * x * (3 - 2 * x);

/**
 * Picks a random expression every 5–11 s (smile, double blink or yawn) and blinks naturally every
 * 2.5–6 s in between. `force()` plays one immediately (used for testing / previews).
 */
export function createExpressions(now: number) {
  let act: { kind: Expression; t0: number; dur: number } | null = null;
  let nextAct = now + rand(3500, 7000);
  let blinkAt = now + rand(1500, 4000);
  const DUR: Record<Expression, number> = { smile: 2200, blink: 520, yawn: 2800 };

  const start = (kind: Expression, t: number) => {
    act = { kind, t0: t, dur: DUR[kind] };
  };

  return {
    force: (kind: Expression, t: number) => start(kind, t),
    update(t: number): FaceState {
      if (act && t > act.t0 + act.dur) {
        act = null;
        nextAct = t + rand(5000, 11000);
        blinkAt = t + rand(1200, 3500);
      }
      if (!act && t >= nextAct)
        start((['smile', 'blink', 'yawn'] as const)[Math.floor(Math.random() * 3)]!, t);
      // Natural single blink (not during a yawn or smile).
      let lids = 0;
      if (!act && t >= blinkAt) {
        const p = (t - blinkAt) / 170;
        if (p >= 1) blinkAt = t + rand(2500, 6000);
        else lids = Math.sin(Math.PI * p);
      }
      const s: FaceState = { lids, smile: 0, yawn: 0 };
      if (!act) return s;
      const a = act as { kind: Expression; t0: number; dur: number };
      const p = (t - a.t0) / a.dur;
      if (a.kind === 'blink') {
        // Two quick blinks.
        const q = p < 0.5 ? p / 0.5 : (p - 0.5) / 0.5;
        s.lids = Math.sin(Math.PI * Math.min(1, q * 1.15));
      } else if (a.kind === 'smile') {
        s.smile = envelope(p, 0.18);
        s.lids = 0.35 * s.smile; // happy squint
      } else {
        // Yawn: slow open, hold, a little slower close; eyes squeeze shut with it.
        s.yawn = envelope(p, 0.32);
        s.lids = Math.min(1, s.yawn * 1.15);
      }
      return s;
    },
  };
}

/* ------------------------------------------------------------------------------- drawing ---- */

const SKIN = 'rgb(230,230,230)';
const LINE = 'rgb(24,24,24)';
const MOUTH_IN = 'rgb(70,70,70)';
const TONGUE = 'rgb(150,150,150)';

/** Eye boxes (inner area that lids cover), map cells. */
const LIDS = [
  { x0: 27, x1: 30, y0: 30, y1: 34, sides: [26, 31] },
  { x0: 39, x1: 44, y0: 30, y1: 34, sides: [38, 45] },
];

/**
 * Paints lids / mouth over the composed figure. `cell(x, y, style)` fills one map cell.
 */
export function drawFace(
  cell: (x: number, y: number, style: string, w?: number, h?: number) => void,
  f: FaceState,
) {
  // Lids come down from the top; when (almost) shut, a lash line sits low in the socket.
  if (f.lids > 0.02) {
    for (const e of LIDS) {
      const rows = Math.round(f.lids * (e.y1 - e.y0 + 1));
      for (let y = e.y0; y < e.y0 + rows; y++) for (let x = e.x0; x <= e.x1; x++) cell(x, y, SKIN);
      // Mostly shut: the socket walls disappear under the lid too (no "box" around a closed eye).
      if (f.lids > 0.6) for (const x of e.sides) for (let y = e.y0 + 1; y <= e.y1; y++) cell(x, y, SKIN);
      const lash = Math.min(e.y1, e.y0 + rows);
      if (f.lids > 0.85)
        for (let x = e.x0 - 1; x <= e.x1 + 1; x++)
          cell(x, lash - (x === e.x0 - 1 || x === e.x1 + 1 ? 1 : 0), LINE);
      else if (rows > 0) for (let x = e.x0; x <= e.x1; x++) cell(x, e.y0 + rows - 1, 'rgb(120,120,120)');
    }
  }

  if (f.smile > 0.05 || f.yawn > 0.05) {
    // Clear the resting mouth.
    for (let y = 38; y <= 42; y++) for (let x = 32; x <= 40; x++) cell(x, y, SKIN);
  }
  if (f.yawn > 0.05) {
    // Open oval growing with the yawn.
    const rx = 1.2 + 1.6 * f.yawn;
    const ry = 0.6 + 2.2 * f.yawn;
    const cx = 36;
    const cy = 39.6 + 0.6 * f.yawn;
    for (let y = 37; y <= 43; y++)
      for (let x = 32; x <= 40; x++) {
        const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
        if (d <= 1) cell(x, y, d > 0.55 ? LINE : y > cy + ry * 0.35 ? TONGUE : MOUTH_IN);
      }
  } else if (f.smile > 0.05) {
    // Corners rise and the line curves into a grin; a little open mouth at full smile.
    const lift = f.smile > 0.5 ? 1 : 0;
    cell(33, 38 - lift, LINE);
    cell(39, 38 - lift, LINE);
    cell(34, 39 - lift * 0.5, LINE);
    cell(38, 39 - lift * 0.5, LINE);
    for (let x = 35; x <= 37; x++) cell(x, 39 + lift * 0.4, LINE);
    if (f.smile > 0.6) {
      for (let x = 35; x <= 37; x++) cell(x, 38.6, MOUTH_IN);
      cell(36, 39.2, TONGUE);
    }
  }
}
