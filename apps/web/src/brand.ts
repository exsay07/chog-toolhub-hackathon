/**
 * Replaceable brand assets. Swap the files in /public/brand (or point these at new ones).
 * Avatar: pixel Chog provided by the project owner (256px copy of the original artwork).
 */
export const BRAND = {
  name: 'Chog Toolhub',
  /** App icon used everywhere (sidebar, sign-in, PnL cards, mobile notice). */
  mark: '/brand/avatar.webp',
  avatar: '/brand/avatar.webp',
  /** Full-screen background for the "desktop only" notice on phones. */
  mobileNoticeBackground: '/brand/mobile-notice-bg.svg',
  /** Drawn Chog moods for PnL cards (flex_<mood>.json sprites, see scripts/pixelize-chog-art.py). */
  pnlCardArt: '/pnl-cards/chog',
};
