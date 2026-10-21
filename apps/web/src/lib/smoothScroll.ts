/**
 * Smooth mouse-wheel scrolling everywhere: the page, panels, tables, lists and dialogs. Each wheel
 * notch moves the target, and the nearest scrollable box eases towards it (exponential smoothing,
 * frame-rate independent). Touchpads already scroll smoothly and keep native behaviour, as do
 * Ctrl+wheel (zoom), horizontal scrolling, and anything that handles the wheel itself (charts,
 * the volume knob). Off with Settings → Appearance → Smooth scrolling, or with reduced motion.
 */

const KEY = 'chog.smoothScroll';
/** Time constant of the easing: ~63% of the remaining distance per TAU ms. */
const TAU = 110;
const LINE = 16;

export function smoothScrollEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setSmoothScrollEnabled(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    /* ignore */
  }
}

function reducedMotion() {
  const m = document.documentElement.dataset.motion;
  return m === 'on' || (m !== 'off' && matchMedia('(prefers-reduced-motion: reduce)').matches);
}

interface Anim {
  target: number;
  /** Eased position (sub-pixel). */
  pos: number;
  raf: number;
  last: number;
}
const anims = new Map<Element, Anim>();

const maxScroll = (el: Element) => el.scrollHeight - el.clientHeight;

function canScroll(el: Element, dy: number) {
  const top = anims.get(el)?.target ?? el.scrollTop;
  return dy > 0 ? top < maxScroll(el) - 0.5 : top > 0.5;
}

/** Nearest box under the pointer that can still move in this direction (else the page). */
function scrollTarget(from: EventTarget | null, dy: number): Element | null {
  for (let n = from instanceof Element ? from : null; n && n !== document.body; n = n.parentElement) {
    if (n.closest('[data-native-scroll]')) return null;
    if (n.scrollHeight <= n.clientHeight + 1) continue;
    const oy = getComputedStyle(n).overflowY;
    if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') && canScroll(n, dy)) return n;
  }
  const page = document.scrollingElement;
  return page && page.scrollHeight > page.clientHeight + 1 && canScroll(page, dy) ? page : null;
}

/** Mouse wheels report ±120 per notch (wheelDelta); touchpads send small, uneven deltas. */
function isMouseWheel(e: WheelEvent) {
  if (e.deltaMode !== 0) return true;
  const wd = (e as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY;
  if (typeof wd === 'number' && wd !== 0) return wd % 120 === 0;
  return Math.abs(e.deltaY) >= 50;
}

/**
 * One frame: write-only. The eased position lives in `a.pos` (sub-pixel), so we never read
 * scrollTop back after setting it — a read-after-write would force a layout on every frame.
 */
function step(el: Element, a: Anim, now: number) {
  // rAF timestamps can be slightly older than the performance.now() the anim started at.
  const raw = now - a.last;
  const dt = raw > 0 ? Math.min(64, raw) : 16;
  a.last = now;
  const diff = a.target - a.pos;
  if (Math.abs(diff) < 0.5) {
    el.scrollTop = a.target;
    anims.delete(el);
    return;
  }
  a.pos += diff * (1 - Math.exp(-dt / TAU));
  el.scrollTop = a.pos;
  a.raf = requestAnimationFrame((t) => step(el, a, t));
}

function onWheel(e: WheelEvent) {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.shiftKey) return;
  // Controls that use the wheel themselves (volume, time fields): the page must not scroll too.
  if (e.target instanceof Element && e.target.closest('[data-wheel]')) return e.preventDefault();
  if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.deltaY === 0) return;
  if (!smoothScrollEnabled() || reducedMotion() || !isMouseWheel(e)) return;
  // Popups (option lists) keep the wheel: they scroll, and the page under them never does.
  const trap = e.target instanceof Element ? e.target.closest('[data-scroll-trap]') : null;
  let el = scrollTarget(e.target, e.deltaY);
  if (trap && (!el || !trap.contains(el))) {
    e.preventDefault();
    if (!isMouseWheel(e) || !canScroll(trap, e.deltaY)) return;
    el = trap;
  }
  if (!el) return;
  const dy = e.deltaMode === 1 ? e.deltaY * LINE : e.deltaMode === 2 ? e.deltaY * el.clientHeight : e.deltaY;
  e.preventDefault();
  let a = anims.get(el);
  if (!a) {
    a = { target: el.scrollTop, pos: el.scrollTop, raf: 0, last: performance.now() };
    anims.set(el, a);
    const started = a;
    a.raf = requestAnimationFrame((t) => step(el, started, t));
  }
  a.target = Math.max(0, Math.min(maxScroll(el), a.target + dy));
}

/** Any other way of scrolling (keys, scrollbar drag, scrollIntoView) cancels a running ease. */
function cancelAll() {
  for (const a of anims.values()) cancelAnimationFrame(a.raf);
  anims.clear();
}

export function installSmoothScroll() {
  // Bubble phase on window: handlers that consume the wheel (charts, knobs) run first and
  // preventDefault, which we respect.
  window.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('keydown', cancelAll, { passive: true });
  window.addEventListener('pointerdown', cancelAll, { passive: true });
}
