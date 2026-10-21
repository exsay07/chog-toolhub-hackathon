/**
 * App-wide polish helpers that need a little JS. Installed once from main.tsx.
 *  - Cards with the `lux` class get --mx / --my (pointer position inside the card) for the
 *    hover light in styles.css. One passive listener for the whole app.
 */
export function installPolish() {
  document.addEventListener(
    'pointermove',
    (e) => {
      const el = (e.target as Element | null)?.closest?.('.lux') as HTMLElement | null;
      if (!el) return;
      const r = el.getBoundingClientRect();
      el.style.setProperty('--mx', `${e.clientX - r.left}px`);
      el.style.setProperty('--my', `${e.clientY - r.top}px`);
    },
    { passive: true },
  );
}

/**
 * In-style tooltips for every element with a `title`: after a short hover the native (OS-styled)
 * tooltip is replaced by a small CRT-styled one. The title is parked in data-tip while it shows,
 * so the browser's own tooltip never appears, and restored on leave.
 */
export function installTooltips() {
  const tip = document.createElement('div');
  tip.className = 'chog-tip';
  tip.setAttribute('role', 'tooltip');
  document.body.appendChild(tip);
  let target: HTMLElement | null = null;
  let timer: number | null = null;

  const hide = () => {
    if (timer) window.clearTimeout(timer);
    timer = null;
    if (target?.dataset.tip !== undefined) {
      target.setAttribute('title', target.dataset.tip);
      delete target.dataset.tip;
    }
    target = null;
    tip.classList.remove('on');
  };
  const show = () => {
    if (!target || !target.isConnected) return hide();
    const text = target.dataset.tip;
    if (!text) return;
    tip.textContent = text;
    const r = target.getBoundingClientRect();
    tip.classList.add('on');
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let x = r.left + r.width / 2 - tw / 2;
    x = Math.max(8, Math.min(window.innerWidth - tw - 8, x));
    const below = r.top - th - 8 < 4;
    tip.style.left = `${x}px`;
    tip.style.top = `${below ? r.bottom + 8 : r.top - th - 8}px`;
  };

  document.addEventListener(
    'pointerover',
    (e) => {
      const el = (e.target as Element | null)?.closest?.('[title]') as HTMLElement | null;
      if (!el || el === target || !(el instanceof HTMLElement)) return;
      const text = el.getAttribute('title');
      if (!text) return;
      hide();
      target = el;
      el.dataset.tip = text;
      el.removeAttribute('title');
      timer = window.setTimeout(show, 380);
    },
    { passive: true },
  );
  document.addEventListener(
    'pointerout',
    (e) => {
      if (target && !target.contains(e.relatedTarget as Node | null)) hide();
    },
    { passive: true },
  );
  document.addEventListener('pointerdown', hide, { passive: true });
  window.addEventListener('scroll', hide, { passive: true, capture: true });
}

/**
 * Lite mode for modest machines (≤ 4 CPU threads or ≤ 4 GB RAM reported by the browser): the
 * decorative background stays off and the animated CRT pictures draw at half the frame rate.
 * Everything else looks the same.
 */
export const lite: boolean = (() => {
  if (typeof navigator === 'undefined') return false;
  const cores = navigator.hardwareConcurrency ?? 8;
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
  return cores <= 4 || mem <= 4;
})();
if (typeof document !== 'undefined' && lite) document.documentElement.dataset.lite = '1';
