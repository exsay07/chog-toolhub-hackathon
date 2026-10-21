"""Snaps a generated "pixel art" picture onto a real pixel grid and writes a card sprite.

Generated art is drawn on a grid but upscaled with soft edges and a slightly wobbly pitch. This finds
the pitch and phase of that grid, takes the dominant colour of each cell, keys out the flat magenta
background, snaps near-grey colours to the site's grey ramp (so Chog stays grayscale like the
original) and merges the remaining prop colours into a small palette.

The Flex PnL-card moods (apps/web/public/pnl-cards/chog/flex_<mood>.json) were made this way from
pictures generated on a flat #FF00FF background, at --rows 96.

Usage: python3 scripts/pixelize-chog-art.py <in.png> <out.json> [--preview out.png] [--rows 96 | --pitch N]
Needs Pillow and NumPy.
"""
import argparse
import json

import numpy as np
from PIL import Image

GREYS = [18, 40, 62, 78, 96, 130, 170, 205, 232, 246]
CHARS = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'


def bg_mask(a):
    r, g, b = a[..., 0].astype(int), a[..., 1].astype(int), a[..., 2].astype(int)
    return (r > 110) & (b > 110) & (g < 0.62 * np.minimum(r, b))


def find_pitch(a, lo=8, hi=48):
    """Pitch + phase of the pixel grid from where colour changes happen along each axis."""
    f = a.astype(float).sum(-1)
    out = []
    for axis in (1, 0):
        d = np.abs(np.diff(f, axis=axis)).sum(axis=1 - axis)
        d = d / (d.max() + 1e-9)
        best = None
        for p in np.arange(lo, hi, 0.05):
            n = len(d)
            idx = np.arange(n)
            ph = (idx % p) / p
            # Energy that lands on grid lines vs off them, for the best phase.
            for phase in np.linspace(0, 1, 24, endpoint=False):
                dist = np.abs(((ph - phase + 0.5) % 1) - 0.5)
                on = d[dist < 0.08].sum()
                score = on / (d.sum() + 1e-9) / 0.16
                if best is None or score > best[0]:
                    best = (score, p, phase * p)
        out.append(best)
    return out  # [(score, pitch, offset) for x, for y]


def snap(c, chroma):
    mx, mn = max(c), min(c)
    if mx - mn < chroma:
        l = sum(c) / 3
        g = min(GREYS, key=lambda v: abs(v - l))
        return (g, g, g), True
    return tuple(int(v) for v in c), False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src')
    ap.add_argument('out')
    ap.add_argument('--preview')
    ap.add_argument('--pitch', type=float)
    ap.add_argument('--rows', type=int, help='grid pitch = image height / rows')
    ap.add_argument('--chroma', type=int, default=38)
    ap.add_argument('--merge', type=int, default=44)
    ap.add_argument('--max-rows', type=int, default=0, help='drop rows below this many (crop the bottom)')
    a = ap.parse_args()

    img = np.array(Image.open(a.src).convert('RGB'))
    H, W, _ = img.shape
    (sx, px, ox), (sy, py, oy) = find_pitch(img)
    if a.rows:
        px = py = H / a.rows
    elif a.pitch:
        px = py = a.pitch
    p = (px + py) / 2
    print(f'pitch x={px:.2f} (score {sx:.2f}) y={py:.2f} (score {sy:.2f}) → {p:.2f}, offset {ox:.1f},{oy:.1f}')
    bg = bg_mask(img)

    xs = np.arange(ox % p - p, W, p)
    ys = np.arange(oy % p - p, H, p)
    cells = []
    for y0 in ys:
        row = []
        for x0 in xs:
            a0, a1 = int(round(y0 + p * 0.25)), int(round(y0 + p * 0.75))
            b0, b1 = int(round(x0 + p * 0.25)), int(round(x0 + p * 0.75))
            a0, b0 = max(a0, 0), max(b0, 0)
            a1, b1 = min(a1, H), min(b1, W)
            if a1 <= a0 or b1 <= b0:
                row.append(None)
                continue
            blk = img[a0:a1, b0:b1].reshape(-1, 3)
            m = bg[a0:a1, b0:b1].reshape(-1)
            if m.mean() >= 0.5:
                row.append(None)
                continue
            blk = blk[~m]
            q = (blk // 16).astype(int)
            keys = q[:, 0] * 256 + q[:, 1] * 16 + q[:, 2]
            k = np.bincount(keys).argmax()
            row.append(tuple(blk[keys == k].mean(0)))
        cells.append(row)

    # Trim empty borders.
    occ = np.array([[c is not None for c in r] for r in cells])
    rs, cs = np.where(occ.any(1))[0], np.where(occ.any(0))[0]
    cells = [r[cs[0]:cs[-1] + 1] for r in cells[rs[0]:rs[-1] + 1]]
    if a.max_rows:
        cells = cells[: a.max_rows]

    palette, rgbs = [], []

    def index(c):
        s, grey = snap(c, a.chroma)
        best, bd = -1, 1e18
        for i, q in enumerate(rgbs):
            d = sum((q[j] - s[j]) ** 2 for j in range(3))
            if d < bd:
                best, bd = i, d
        if best >= 0 and (bd == 0 or (not grey and bd < a.merge ** 2) or len(rgbs) >= len(CHARS)):
            return best
        rgbs.append(s)
        palette.append('#%02x%02x%02x' % s)
        return len(rgbs) - 1

    rows = [''.join('.' if c is None else CHARS[index(c)] for c in r) for r in cells]
    h, w = len(rows), len(rows[0])
    json.dump({'w': w, 'h': h, 'palette': palette, 'rows': rows}, open(a.out, 'w'), separators=(',', ':'))
    print(f'{w}x{h} cells, {len(palette)} colours')

    if a.preview:
        s = 10
        im = Image.new('RGB', (w * s, h * s), (24, 24, 28))
        px_ = im.load()
        for y, r in enumerate(rows):
            for x, ch in enumerate(r):
                if ch == '.':
                    continue
                col = rgbs[CHARS.index(ch)]
                for yy in range(s):
                    for xx in range(s):
                        px_[x * s + xx, y * s + yy] = col
        im.save(a.preview)


if __name__ == '__main__':
    main()
