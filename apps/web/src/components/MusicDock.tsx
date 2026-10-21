import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { ListMusic, Pause, Play, SkipBack, SkipForward } from 'lucide-react';
import { cx } from './ui';
import { initMusic, musicActions as actions, usePlayer } from '../lib/music';

/**
 * Music dock (sidebar, and the same corner of the sign-in page). At rest it is a card (cover + title);
 * on hover/focus it morphs into a compact player bar (cover, scrolling title, time, prev/play/next,
 * scrubber with time preview, segmented volume with a live percentage, track list). Playback state lives in lib/music.ts, so it
 * survives route changes and the sign-in ↔ app switch.
 *
 * `mini` (collapsed sidebar): the dock is a small cover tile; clicking it switches the player on
 * beside it like the old CRT — a bright line that opens into the picture — and off again.
 */

/** Volume moves in 10 % steps: the lit bars and the percentage always agree. */
const VOL_STEPS = 10;
const CARD = { w: 208, h: 176 };
/** The open player stays inside the card's width (never crosses the sidebar edge). */
const BAR = { w: CARD.w, h: 118 };
/** On short screens the card turns into a low row (cover beside the title) so the sidebar menu fits. */
const SHORT_SCREEN = '(max-height: 780px)';
const CARD_SHORT = { w: CARD.w, h: BAR.h };
const MINI = { w: 40, h: 40 };

function useShortScreen() {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(SHORT_SCREEN);
      m.addEventListener('change', cb);
      return () => m.removeEventListener('change', cb);
    },
    () => window.matchMedia(SHORT_SCREEN).matches,
  );
}

const fmt = (s: number) => {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

function reducedMotion() {
  const pref = document.documentElement.dataset.motion;
  if (pref === 'on') return true;
  if (pref === 'off') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Little equalizer that dances while music plays and settles when it pauses. The audio itself lives in
 * a cross-origin SoundCloud frame (no samples to analyse), so each bar runs its own loop with a
 * different length — never in sync, like a real meter.
 */
export function Equalizer({
  playing,
  bars = 4,
  height = 12,
  className,
}: {
  playing: boolean;
  bars?: number;
  height?: number;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cx('inline-flex items-end gap-[2px] shrink-0', playing && 'eq-on', className)}
      style={{ height }}
    >
      {Array.from({ length: bars }, (_, i) => (
        <span
          key={i}
          className="eq-bar w-[3px] h-full rounded-[1px] bg-accent origin-bottom"
          style={{
            animationDuration: `${[0.82, 1.14, 0.68, 1.36, 0.95][i % 5]}s`,
            animationDelay: `${-i * 0.23}s`,
          }}
        />
      ))}
    </span>
  );
}

/* ------------------------------------------------------------------------------ component ---- */

export function MusicDock({ mini = false }: { mini?: boolean }) {
  const p = usePlayer();
  const [open, setOpen] = useState(false);
  const [list, setList] = useState(false);
  const [pop, setPop] = useState(false);
  const leaveTimer = useRef<number | null>(null);
  const tile = useRef<HTMLDivElement>(null);
  const short = useShortScreen();
  const card = mini ? MINI : short ? CARD_SHORT : CARD;
  useEffect(() => void initMusic(), []);
  // Switching between the card and the mini tile resets the hover / pop-out state.
  useEffect(() => {
    setPop(false);
    setOpen(false);
    setList(false);
  }, [mini]);

  const track = p.tracks[p.index];
  const enter = useCallback(() => {
    if (mini) return;
    if (leaveTimer.current) window.clearTimeout(leaveTimer.current);
    setOpen(true);
  }, [mini]);
  const leave = useCallback(() => {
    // Small grace period so moving the pointer across the edge doesn't flicker.
    leaveTimer.current = window.setTimeout(() => {
      setOpen(false);
      setList(false);
    }, 180);
  }, []);

  const cover = (size: string) =>
    track?.cover ? (
      <img
        referrerPolicy="no-referrer"
        src={track.cover}
        alt=""
        className={cx(
          'rounded-[4px] object-cover border border-line shrink-0',
          p.playing && 'music-glow',
          size,
        )}
      />
    ) : (
      <div className={cx('rounded-[4px] bg-surface-3 shrink-0 grid place-items-center text-muted', size)}>
        <ListMusic className="size-4" />
      </div>
    );

  return (
    // Hover is tracked on this wrapper, which keeps the full card size: the card shrinks into the
    // shorter player bar on hover, and tracking the shrinking element itself made a pointer near the
    // middle fall outside it — close, grow back under the pointer, open again (flicker).
    <div
      className="relative shrink-0 px-2 pb-2"
      style={{ height: card.h + 8 }}
      onMouseEnter={enter}
      onMouseLeave={leave}
      onFocus={enter}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && leave()}
    >
      <div
        ref={tile}
        className="absolute left-2 bottom-2 z-50 border border-line-strong rounded-[var(--radius)] bg-surface/45 overflow-hidden transition-[width,height,box-shadow] duration-[220ms] ease-[var(--ease)]"
        style={{
          width: open ? BAR.w : card.w,
          height: open ? BAR.h : card.h,
          boxShadow: open ? 'var(--shadow-lg)' : 'none',
        }}
        aria-label="Music player"
        role="region"
      >
        {mini ? (
          <button
            className="absolute inset-0 grid place-items-center"
            onClick={() => setPop((v) => !v)}
            aria-label={pop ? 'Hide player' : 'Show player'}
            aria-expanded={pop}
            title={track ? track.title : 'Music'}
          >
            {cover('size-full border-0 rounded-none')}
            {p.playing && (
              <span className="absolute inset-x-0 bottom-0 flex justify-center pb-1 pt-2 bg-gradient-to-t from-black/70 to-transparent">
                <Equalizer playing bars={4} height={10} />
              </span>
            )}
          </button>
        ) : (
          <>
            {/* Card face */}
            <div
              className={cx(
                'absolute inset-0 flex px-3 transition-opacity duration-150',
                short ? 'flex-row items-center gap-3' : 'flex-col items-center pt-3',
                open ? 'opacity-0 pointer-events-none' : 'opacity-100',
              )}
            >
              {cover(short ? 'size-[72px]' : 'size-[112px]')}
              <div
                className={cx(
                  'text-[12px] text-text leading-tight uppercase tracking-wide',
                  short ? 'line-clamp-4 min-w-0' : 'mt-2 text-center line-clamp-2',
                )}
              >
                {track ? track.title : 'No tracks'}
              </div>
              {p.playing && (
                <div
                  className="absolute top-2 right-2 px-1.5 py-1 rounded-[4px] bg-black/55 backdrop-blur-[2px]"
                  title="Playing"
                >
                  <Equalizer playing bars={4} height={10} />
                </div>
              )}
            </div>

            {/* Player face: two rows that fit inside the card width. */}
            <div
              className={cx(
                'absolute inset-0 flex flex-col justify-center gap-1.5 px-3 transition-opacity duration-150',
                open ? 'opacity-100 delay-100' : 'opacity-0 pointer-events-none',
              )}
            >
              <PlayerControls list={list} onList={() => setList((v) => !v)} marquee={open} />
            </div>
          </>
        )}
      </div>

      {/* Track list pops up above the bar while the player is open. */}
      {!mini && open && list && (
        <div
          className="absolute left-2 z-50 border border-line-strong rounded-[var(--radius)] bg-surface/45 shadow-[var(--shadow-lg)] py-1 max-h-64 overflow-auto"
          style={{ bottom: BAR.h + 14, width: BAR.w }}
        >
          <TrackList />
        </div>
      )}

      {mini && pop && <PopOutPlayer anchor={tile} onClose={() => setPop(false)} />}
    </div>
  );
}

/* --------------------------------------------------------------------- pop-out (mini mode) ---- */

/**
 * The player beside the mini tile, switched on like the old TV: a bright line grows out of the
 * tile, opens vertically into the picture with an over-exposed flash; closing runs it backwards.
 */
function PopOutPlayer({
  anchor,
  onClose,
}: {
  anchor: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [list, setList] = useState(false);
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);
  const closing = useRef(false);
  const placed = pos !== null;

  useLayoutEffect(() => {
    const place = () => {
      const r = anchor.current?.getBoundingClientRect();
      if (r) setPos({ left: r.right + 10, bottom: window.innerHeight - r.bottom });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [anchor]);

  // Power-on, once it has a position.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !placed || reducedMotion()) return;
    el.animate(
      [
        { transform: 'scale(0.15, 0.03)', filter: 'brightness(3) contrast(1.6)', opacity: 0.5 },
        { transform: 'scale(1, 0.03)', filter: 'brightness(2.6) contrast(1.5)', opacity: 1, offset: 0.45 },
        { transform: 'scale(1, 1.03)', filter: 'brightness(1.5)', offset: 0.8 },
        { transform: 'none', filter: 'none' },
      ],
      { duration: 340, easing: 'cubic-bezier(.2,.7,.2,1)' },
    );
  }, [placed]);

  const close = useCallback(() => {
    const el = ref.current;
    if (closing.current) return;
    closing.current = true;
    if (!el || reducedMotion()) return onClose();
    el.animate(
      [
        { transform: 'none', filter: 'none' },
        { transform: 'scale(1, 0.03)', filter: 'brightness(2.6)', offset: 0.55 },
        { transform: 'scale(0.1, 0.03)', filter: 'brightness(3)', opacity: 0 },
      ],
      { duration: 220, easing: 'ease-in', fill: 'forwards' },
    ).onfinish = onClose;
  }, [onClose]);

  // Click outside (not on the tile, which toggles itself) or Escape closes it.
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor.current?.contains(t)) return;
      close();
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('keydown', key);
    };
  }, [anchor, close]);

  if (!pos) return null;
  // Origin = the tile's centre, so the line grows out of it.
  const origin = `0px ${BAR.h - MINI.h / 2}px`;
  return createPortal(
    <div
      ref={ref}
      className="fixed z-[60]"
      style={{ left: pos.left, bottom: pos.bottom, width: BAR.w, transformOrigin: origin }}
      role="dialog"
      aria-label="Music player controls"
    >
      {list && (
        <div className="mb-2 border border-line-strong rounded-[var(--radius)] bg-surface/90 shadow-[var(--shadow-lg)] py-1 max-h-64 overflow-auto">
          <TrackList />
        </div>
      )}
      <div
        className="relative flex flex-col justify-center gap-1.5 px-3 border border-line-strong rounded-[var(--radius)] bg-surface/90 shadow-[var(--shadow-lg)] overflow-hidden"
        style={{ height: BAR.h }}
      >
        <PlayerControls list={list} onList={() => setList((v) => !v)} marquee />
        {/* Faint scanlines, like the rest of the CRT bits. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-40"
          style={{
            background: 'repeating-linear-gradient(to bottom, rgba(0,0,0,0.35) 0 1px, transparent 1px 3px)',
          }}
        />
      </div>
    </div>,
    document.body,
  );
}

/* -------------------------------------------------------------------------- shared pieces ---- */

function PlayerControls({ list, onList, marquee }: { list: boolean; onList: () => void; marquee: boolean }) {
  const p = usePlayer();
  const track = p.tracks[p.index];
  /** Where the scrubber points (0..1) while hovered or dragged — shown in the time line. */
  const [preview, setPreview] = useState<number | null>(null);
  const steps = Math.round(p.volume * VOL_STEPS);
  const pct = steps * (100 / VOL_STEPS);
  const setSteps = (n: number) => actions.volume(Math.min(VOL_STEPS, Math.max(0, n)) / VOL_STEPS);
  // Pointer over bar i (0-based) selects i + 1 steps; the sliver left of the first bar is mute.
  const volFromPointer = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    setSteps(x < 0.03 ? 0 : Math.ceil(x * VOL_STEPS));
  };
  return (
    <>
      <div className="flex items-center gap-2.5 min-w-0">
        {track?.cover ? (
          <img
            referrerPolicy="no-referrer"
            src={track.cover}
            alt=""
            className="size-10 rounded-[4px] object-cover border border-line shrink-0"
          />
        ) : (
          <div className="size-10 rounded-[4px] bg-surface-3 shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <div className="overflow-hidden whitespace-nowrap text-[12px] uppercase tracking-wide leading-tight">
            <span
              className={cx('inline-block', marquee && track && track.title.length > 12 && 'music-marquee')}
            >
              {track ? track.title : 'No tracks'}
            </span>
          </div>
          <div className="num text-[11px] text-muted leading-tight mt-0.5 flex items-center gap-1.5">
            <Equalizer playing={p.playing} bars={4} height={9} />
            {preview !== null && p.duration ? (
              <span className="text-accent">{fmt(preview * p.duration)}</span>
            ) : (
              fmt(p.time)
            )}{' '}
            / {fmt(p.duration)}
          </div>
        </div>
        <button
          className={cx(
            'size-6 grid place-items-center rounded-[4px] hover:bg-surface-2 shrink-0',
            list ? 'text-text' : 'text-muted',
          )}
          onClick={onList}
          aria-label="Track list"
          title="Track list"
        >
          <ListMusic className="size-4" />
        </button>
      </div>
      <Scrubber onPreview={setPreview} />
      <div className="flex items-center gap-1">
        <button
          className="size-7 grid place-items-center rounded-[4px] text-muted hover:text-text hover:bg-surface-2"
          onClick={actions.prev}
          aria-label="Previous track"
        >
          <SkipBack className="size-3.5" />
        </button>
        <button
          className="size-7 grid place-items-center rounded-[4px] border border-line-strong text-text hover:bg-surface-2"
          onClick={actions.toggle}
          aria-label={p.playing ? 'Pause' : 'Play'}
        >
          {p.playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
        </button>
        <button
          className="size-7 grid place-items-center rounded-[4px] text-muted hover:text-text hover:bg-surface-2"
          onClick={actions.next}
          aria-label="Next track"
        >
          <SkipForward className="size-3.5" />
        </button>
        {/* Segmented volume (10 % steps): click/drag, scroll wheel, or arrow keys. */}
        <div
          role="slider"
          tabIndex={0}
          aria-label="Volume"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-valuetext={`${pct}%`}
          className="ml-auto flex items-end gap-[2px] h-5 px-0.5 cursor-pointer select-none touch-none"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            volFromPointer(e);
          }}
          onPointerMove={(e) => e.buttons === 1 && volFromPointer(e)}
          data-wheel
          onWheel={(e) => setSteps(steps + (e.deltaY < 0 ? 1 : -1))}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight' || e.key === 'ArrowUp') setSteps(steps + 1);
            if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') setSteps(steps - 1);
          }}
        >
          {Array.from({ length: VOL_STEPS }, (_, i) => (
            <span
              key={i}
              className={cx(
                'w-[5px] rounded-[1px] transition-colors duration-100',
                i < steps ? 'bg-accent' : 'bg-surface-3',
              )}
              style={{ height: 6 + i * 1.4 }}
            />
          ))}
        </div>
        <span className="num text-[11px] text-text-2 w-8 text-right" aria-hidden>
          {pct}%
        </span>
      </div>
    </>
  );
}

/**
 * Scrubber: a generous hit area around a thin track. Hover shows the time under the pointer (in the
 * time line above, highlighted); drag to
 * scrub (the position previews while dragging and is applied on release, so the stream is not
 * re-buffered on every pixel). Arrow keys skip 5 s.
 */
function Scrubber({ onPreview }: { onPreview: (f: number | null) => void }) {
  const p = usePlayer();
  const [hover, setHover] = useState<number | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  useEffect(() => onPreview(drag ?? hover), [drag, hover, onPreview]);
  const frac = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  };
  const played = drag ?? (p.duration ? Math.min(1, p.time / p.duration) : 0);
  const tip = drag ?? hover;
  const active = hover !== null || drag !== null;
  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.round(p.duration)}
      aria-valuenow={Math.round(p.time)}
      aria-valuetext={`${fmt(p.time)} of ${fmt(p.duration)}`}
      className={cx(
        'relative h-4 flex items-center select-none touch-none outline-none',
        p.duration ? 'cursor-pointer' : 'cursor-default opacity-60',
      )}
      onPointerEnter={(e) => p.duration && setHover(frac(e))}
      onPointerMove={(e) => {
        if (!p.duration) return;
        setHover(frac(e));
        if (drag !== null) setDrag(frac(e));
      }}
      onPointerLeave={() => setHover(null)}
      onPointerDown={(e) => {
        if (!p.duration) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        setDrag(frac(e));
      }}
      onPointerUp={(e) => {
        if (drag === null) return;
        actions.seek(frac(e));
        setDrag(null);
      }}
      onPointerCancel={() => setDrag(null)}
      onKeyDown={(e) => {
        if (!p.duration) return;
        if (e.key === 'ArrowRight') actions.seek(Math.min(1, (p.time + 5) / p.duration));
        if (e.key === 'ArrowLeft') actions.seek(Math.max(0, (p.time - 5) / p.duration));
      }}
    >
      <div
        className={cx(
          'relative w-full rounded-full bg-surface-3 overflow-hidden transition-[height] duration-150',
          active ? 'h-[6px]' : 'h-[3px]',
        )}
      >
        {tip !== null && (
          <div className="absolute inset-y-0 left-0 bg-text/15" style={{ width: `${tip * 100}%` }} />
        )}
        {/* Scaled, not resized: runs on the compositor and glides between the once-a-second updates. */}
        <div
          className={cx(
            'absolute inset-0 bg-accent origin-left',
            drag === null && 'transition-transform duration-1000 ease-linear',
          )}
          style={{ transform: `scaleX(${played})` }}
        />
      </div>
      <span
        aria-hidden
        className={cx(
          'absolute top-1/2 size-3 -ml-1.5 -mt-1.5 rounded-full bg-text shadow transition-opacity duration-150',
          active ? 'opacity-100' : 'opacity-0',
        )}
        style={{ left: `${played * 100}%` }}
      />
    </div>
  );
}

function TrackList() {
  const p = usePlayer();
  return (
    <>
      {p.tracks.length === 0 && (
        <div className="px-3 py-2 text-[12px] text-muted">Add tracks to /music/tracks.json</div>
      )}
      {p.tracks.map((t, i) => (
        <button
          key={t.id}
          onClick={() => actions.pick(i)}
          className={cx(
            'w-full flex items-center gap-2.5 px-3 h-9 text-left text-[13px] hover:bg-surface-2',
            i === p.index ? 'text-text' : 'text-text-2',
          )}
        >
          <span className="num text-[11px] text-muted w-5">{String(i + 1).padStart(2, '0')}</span>
          <span className="truncate flex-1 uppercase tracking-wide">{t.title}</span>
          {i === p.index && p.playing && <Equalizer playing bars={3} height={9} />}
        </button>
      ))}
    </>
  );
}
