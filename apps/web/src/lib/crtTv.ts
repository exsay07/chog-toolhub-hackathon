/**
 * Whole-app "old CRT TV" transitions, in the same style as ChogTv's power-on.
 *
 * crtPowerOff — the TV switching off (sign-out):
 * over-exposed flash with noise and scanlines → the picture collapses into a bright horizontal
 * line → the line shrinks to a dot → the dot fades out on black.
 *
 * Resolves once the screen is dark; call the returned `release()` after the next screen (the gate)
 * has rendered so it appears from black. Reduced motion → a short fade instead.
 */

import { sfxChannel, sfxOff } from './sfx';

const FLASH_MS = 110;
const COLLAPSE_Y_MS = 200;
const COLLAPSE_X_MS = 170;
const DOT_MS = 300;

function reducedMotion() {
  const pref = document.documentElement.dataset.motion;
  if (pref === 'on') return true;
  if (pref === 'off') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * A small tile of analog noise (low res, upscaled by the browser = same crunchy look).
 * Sparse = half-transparent grain over a picture; solid = full "snow" of a dead channel.
 */
function noiseTile(solid = false) {
  const c = document.createElement('canvas');
  c.width = c.height = 96;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(96, 96);
  for (let q = 0; q < img.data.length; q += 4) {
    const v = solid ? 20 + Math.random() * 200 : Math.random() * 255;
    img.data[q] = img.data[q + 1] = img.data[q + 2] = v;
    img.data[q + 3] = solid ? 255 : Math.random() < 0.5 ? 0 : 90;
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL();
}

let running = false;

export async function crtPowerOff(): Promise<{ release: () => void }> {
  const root = document.getElementById('root');
  const noop = { release: () => {} };
  if (!root || running) return noop;
  running = true;
  sfxOff(FLASH_MS + COLLAPSE_Y_MS + COLLAPSE_X_MS + DOT_MS);

  const html = document.documentElement;
  const prevBg = html.style.background;
  const prevBodyBg = document.body.style.background;
  html.style.background = '#000';
  document.body.style.background = '#000';

  const overlay = document.createElement('div');
  overlay.setAttribute('aria-hidden', 'true');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none';
  document.body.appendChild(overlay);

  const finish = () => ({
    release: () => {
      // Two frames: let React commit the next screen while it is still dark.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          root.getAnimations().forEach((a) => a.cancel());
          overlay.remove();
          html.style.background = prevBg;
          document.body.style.background = prevBodyBg;
          running = false;
        }),
      );
    },
  });

  if (reducedMotion()) {
    await root.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, fill: 'forwards' }).finished;
    return finish();
  }

  // Noise + scanlines over the picture: strongest in the flash, gone once only the line is left.
  const fx = document.createElement('div');
  const tile = noiseTile();
  fx.style.cssText = `position:absolute;inset:0;opacity:0;mix-blend-mode:screen;
    background-image:repeating-linear-gradient(to bottom, rgba(0,0,0,0.45) 0 1px, transparent 1px 3px), url(${tile});
    background-size:auto, 288px 288px;image-rendering:auto`;
  overlay.appendChild(fx);
  const collapseMs = FLASH_MS + COLLAPSE_Y_MS + COLLAPSE_X_MS;
  const total = collapseMs;
  const o1 = FLASH_MS / total;
  const o2 = (FLASH_MS + COLLAPSE_Y_MS) / total;
  fx.animate(
    [
      { opacity: 0.25 },
      { opacity: 0.75, offset: o1 },
      { opacity: 0.35, offset: (o1 + o2) / 2 },
      { opacity: 0, offset: o2 },
    ],
    { duration: collapseMs, fill: 'forwards' },
  );

  // The bright scan line the picture collapses into (with RGB fringing), shrinking to the centre.
  const line = document.createElement('div');
  line.style.cssText = `position:absolute;left:0;right:0;top:50%;height:3px;margin-top:-1.5px;opacity:0;
    background:linear-gradient(to right, transparent, #fff 12%, #fff 88%, transparent);
    box-shadow:0 -1px 0 rgba(255,60,60,0.7), 0 1px 0 rgba(60,160,255,0.7), 0 0 10px 2px rgba(220,230,255,0.8), 0 0 36px 8px rgba(160,180,255,0.3)`;
  overlay.appendChild(line);
  line.animate(
    [
      { opacity: 0, transform: 'scaleX(1)' },
      { opacity: 0, transform: 'scaleX(1)', offset: o1 + (o2 - o1) * 0.55 },
      { opacity: 1, transform: 'scaleX(1)', offset: o2, easing: 'cubic-bezier(.6,0,.9,.4)' },
      { opacity: 1, transform: 'scaleX(0.004)' },
    ],
    { duration: collapseMs, fill: 'forwards' },
  );
  // Jumping noise (the tile shifts every few frames, like the TV's 24 fps grain).
  const jump = window.setInterval(() => {
    fx.style.backgroundPosition = `0 0, ${Math.random() * 288}px ${Math.random() * 288}px`;
  }, 42);

  const screen = root.animate(
    [
      { transform: 'none', filter: 'brightness(1) contrast(1)', easing: 'ease-out' },
      {
        transform: 'translateX(-3px) scale(1, 1)',
        filter: 'brightness(1.9) contrast(1.4)',
        offset: o1 * 0.5,
      },
      {
        transform: 'translateX(2px) scale(1, 0.96)',
        filter: 'brightness(2.4) contrast(1.6)',
        offset: o1,
        easing: 'cubic-bezier(.7,0,.9,.5)',
      },
      {
        transform: 'scale(1, 0.006)',
        filter: 'brightness(8) contrast(2)',
        offset: o2,
        easing: 'cubic-bezier(.6,0,.9,.4)',
      },
      { transform: 'scale(0.002, 0.006)', filter: 'brightness(12) contrast(2)' },
    ],
    { duration: total, fill: 'forwards' },
  );
  await screen.finished.catch(() => {});
  window.clearInterval(jump);
  fx.remove();
  line.remove();

  // The lingering phosphor dot.
  const dot = document.createElement('div');
  dot.style.cssText = `position:absolute;left:50%;top:50%;width:8px;height:8px;margin:-4px 0 0 -4px;
    border-radius:50%;background:#fff;box-shadow:0 0 8px 3px rgba(220,230,255,0.9), 0 0 28px 10px rgba(160,180,255,0.35)`;
  overlay.appendChild(dot);
  await dot
    .animate(
      [
        { transform: 'scale(1.3)', opacity: 1 },
        { transform: 'scale(0.8)', opacity: 0.9, offset: 0.35 },
        { transform: 'scale(0.15)', opacity: 0 },
      ],
      { duration: DOT_MS, easing: 'ease-in', fill: 'forwards' },
    )
    .finished.catch(() => {});
  dot.remove();
  return finish();
}

const LOSE_MS = 340;
const SNOW_MS = 260;
const TUNE_MS = 480;

/**
 * crtChannelSwitch — flipping the old TV to another channel (sign-in → app): the picture loses
 * vertical hold and rolls, tears sideways and drowns in snow; a green "CH 02" sits in the corner.
 * Resolves while the screen is pure snow; then render the next screen and call `release()`, which
 * tunes it in: the snow breaks up, the new picture rolls into place over-bright and settles.
 */
export async function crtChannelSwitch(): Promise<{ release: () => Promise<void> }> {
  const root = document.getElementById('root');
  const noop = { release: () => Promise.resolve() };
  if (!root || running) return noop;
  running = true;
  sfxChannel(LOSE_MS + SNOW_MS + TUNE_MS);

  const overlay = document.createElement('div');
  overlay.setAttribute('aria-hidden', 'true');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none;overflow:hidden';
  document.body.appendChild(overlay);
  const cleanup = () => {
    root.getAnimations().forEach((a) => a.cancel());
    overlay.remove();
    running = false;
  };

  if (reducedMotion()) {
    overlay.style.background = '#000';
    await overlay.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, fill: 'forwards' }).finished;
    return {
      release: async () => {
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        await overlay.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: 'forwards' }).finished;
        cleanup();
      },
    };
  }

  // Snow: a few opaque noise tiles swapped at ~24 fps, scanlines and a slow rolling hum bar.
  const tiles = Array.from({ length: 4 }, () => `url(${noiseTile(true)})`);
  const snow = document.createElement('div');
  snow.style.cssText = `position:absolute;inset:0;opacity:0;background-color:#777;
    background-size:288px 288px;image-rendering:auto;filter:contrast(1.3) brightness(0.9)`;
  const scan = document.createElement('div');
  scan.style.cssText = `position:absolute;inset:0;
    background:repeating-linear-gradient(to bottom, rgba(0,0,0,0.35) 0 1px, transparent 1px 3px)`;
  const bar = document.createElement('div');
  bar.style.cssText = `position:absolute;left:0;right:0;top:0;height:22%;
    background:linear-gradient(to bottom, transparent, rgba(255,255,255,0.18) 45%, rgba(0,0,0,0.25) 70%, transparent)`;
  snow.append(scan, bar);
  overlay.appendChild(snow);
  bar.animate([{ transform: 'translateY(-30vh)' }, { transform: 'translateY(110vh)' }], {
    duration: 900,
    iterations: Infinity,
  });
  let n = 0;
  const swap = () => {
    snow.style.backgroundImage = tiles[n++ % tiles.length]!;
    snow.style.backgroundPosition = `${Math.random() * 288}px ${Math.random() * 288}px`;
  };
  swap();
  const grain = window.setInterval(swap, 42);

  // On-screen display, like an old set announcing the channel.
  const osd = document.createElement('div');
  osd.textContent = 'CH 02';
  osd.style.cssText = `position:absolute;top:28px;right:36px;font-family:var(--font-body), monospace;
    font-size:44px;line-height:1;color:#5dff7a;letter-spacing:2px;font-size-adjust:none;opacity:0;
    text-shadow:2px 0 rgba(255,0,60,0.6), -2px 0 rgba(0,160,255,0.6), 0 0 12px rgba(93,255,122,0.7)`;
  overlay.appendChild(osd);
  osd.animate([{ opacity: 0 }, { opacity: 1, offset: 0.3 }, { opacity: 1 }], {
    duration: LOSE_MS + SNOW_MS,
    fill: 'forwards',
    easing: 'steps(6)',
  });

  // The old picture loses vertical hold: rolls, tears and over-brightens while snow takes over.
  const out = root.animate(
    [
      { transform: 'none', filter: 'brightness(1)' },
      {
        transform: 'translate(4px, -2%) skewX(-2deg)',
        filter: 'brightness(1.5) contrast(1.3)',
        offset: 0.15,
      },
      { transform: 'translate(-6px, 8%)', filter: 'brightness(0.8) contrast(1.6)', offset: 0.35 },
      {
        transform: 'translate(3px, -14%) skewX(3deg)',
        filter: 'brightness(1.7) contrast(1.4)',
        offset: 0.55,
      },
      { transform: 'translate(-8px, 26%)', filter: 'brightness(1.2) contrast(2)', offset: 0.8 },
      { transform: 'translate(0, 48%) skewX(-4deg)', filter: 'brightness(2.2) contrast(2)' },
    ],
    { duration: LOSE_MS, fill: 'forwards', easing: 'steps(9, end)' },
  );
  snow.animate(
    [{ opacity: 0 }, { opacity: 0.35, offset: 0.4 }, { opacity: 0.2, offset: 0.6 }, { opacity: 1 }],
    {
      duration: LOSE_MS,
      fill: 'forwards',
      easing: 'steps(8)',
    },
  );
  await out.finished.catch(() => {});
  await new Promise((r) => window.setTimeout(r, SNOW_MS));

  return {
    release: async () => {
      // Let React commit the next screen under the snow first.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      root.getAnimations().forEach((a) => a.cancel());
      const tune = root.animate(
        [
          { transform: 'translate(0, -40%) skewX(3deg)', filter: 'brightness(2.2) contrast(1.8)' },
          { transform: 'translate(-5px, 12%)', filter: 'brightness(1.6) contrast(1.4)', offset: 0.3 },
          {
            transform: 'translate(4px, -5%) skewX(-1.5deg)',
            filter: 'brightness(1.4) contrast(1.2)',
            offset: 0.55,
          },
          { transform: 'translate(-2px, 1.5%)', filter: 'brightness(1.15)', offset: 0.75 },
          { transform: 'none', filter: 'brightness(1)' },
        ],
        { duration: TUNE_MS, easing: 'cubic-bezier(.2,.7,.3,1)' },
      );
      snow.animate(
        [{ opacity: 1 }, { opacity: 0.55, offset: 0.25 }, { opacity: 0.7, offset: 0.4 }, { opacity: 0 }],
        {
          duration: TUNE_MS,
          fill: 'forwards',
          easing: 'steps(7)',
        },
      );
      osd.animate([{ opacity: 1 }, { opacity: 1, offset: 0.7 }, { opacity: 0 }], {
        duration: TUNE_MS + 500,
        fill: 'forwards',
        easing: 'steps(4)',
      });
      await tune.finished.catch(() => {});
      window.clearInterval(grain);
      await new Promise((r) => window.setTimeout(r, 500));
      cleanup();
    },
  };
}
