import { del as idbDel, get as idbGet, set as idbSet } from 'idb-keyval';

const BG_KEY = 'chog.customBackground';
export const BG_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
export const BG_MAX = 2 * 1024 * 1024;
let url: string | null = null;

/** Applies (or clears) the per-device custom background. Images never leave this browser. */
export async function applyCustomBackground(enabled: boolean) {
  if (url) URL.revokeObjectURL(url);
  url = null;
  document.body.style.removeProperty('background-image');
  if (!enabled) return;
  try {
    const b = (await idbGet(BG_KEY)) as Blob | undefined;
    if (b && BG_TYPES.includes(b.type) && b.size <= BG_MAX) {
      url = URL.createObjectURL(b);
      document.body.style.backgroundImage = `url(${url})`;
      document.body.style.backgroundSize = 'cover';
      document.body.style.backgroundAttachment = 'fixed';
    }
  } catch {
    /* storage unavailable */
  }
}

export async function saveCustomBackground(f: File) {
  if (!BG_TYPES.includes(f.type)) throw new Error('Unsupported format');
  if (f.size > BG_MAX) throw new Error('File too large');
  await idbSet(BG_KEY, f);
}

export const clearCustomBackground = () => idbDel(BG_KEY);
