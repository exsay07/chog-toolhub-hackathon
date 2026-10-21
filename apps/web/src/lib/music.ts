import { useSyncExternalStore } from 'react';

/**
 * Music player state, shared by every MusicDock (sign-in page and the app sidebar). Tracks come from
 * /music/tracks.json: local files in public/music, or SoundCloud tracks (regenerate with
 * `node scripts/sync-soundcloud.mjs`); `"shuffle": true` plays them in random order.
 *
 * The <audio> element and the SoundCloud widget iframe live at module scope, so playback continues
 * across route changes. Starting and stopping always fade (never an abrupt cut).
 */

export interface Track {
  id: string;
  title: string;
  /** Local file under /music/ … */
  src?: string;
  /** … or a soundcloud.com track URL, streamed through the official widget. */
  sc?: string;
  cover?: string;
}

const STORE_KEY = 'chog.music';
const SC_ORIGIN = 'https://w.soundcloud.com';
/** Fade lengths (ms): pressing Play / Pause. */
const FADE_IN_MS = 600;
const FADE_OUT_MS = 900;
/** Fade-in when the music starts by itself on opening the site. */
const AUTO_FADE_MS = 2500;

/* ------------------------------------------------------------------ player state (module) ---- */

export interface PlayerState {
  tracks: Track[];
  index: number;
  playing: boolean;
  volume: number; // 0..1
  time: number;
  duration: number;
}
let state: PlayerState = { tracks: [], index: 0, playing: false, volume: 0.5, time: 0, duration: 0 };
const listeners = new Set<() => void>();
const set = (patch: Partial<PlayerState>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};
/**
 * Playback position arrives many times a second (SoundCloud PLAY_PROGRESS, <audio> timeupdate), but
 * the UI shows whole seconds: only publish when the second changes, so the player re-renders once a
 * second instead of on every event (the progress bar glides between updates in CSS).
 */
const setTime = (t: number) => {
  if (Math.floor(t) !== Math.floor(state.time) || t < state.time) set({ time: t });
};
/** Shuffled playlists start at a random track each visit, so only the volume is remembered. */
let shuffled = false;
/** The visitor paused with the button: remembered, and the site then stays quiet on later visits. */
let userPaused = false;
const persist = () => {
  try {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({
        volume: state.volume,
        ...(shuffled ? {} : { index: state.index }),
        ...(userPaused ? { off: true } : {}),
      }),
    );
  } catch {
    /* ignore */
  }
};

/** One playback backend per source kind; `load` switches between them. */
interface Engine {
  load(t: Track): void;
  play(): void;
  pause(): void;
  seek(seconds: number): void;
  volume(v: number): void;
}

/* ------------------------------------------------------------------------------ fading ---- */

/** Fade multiplier on top of the user's volume: what the engine actually gets is volume × gain. */
let gain = 1;
const applyVolume = () => engine.volume(state.volume * gain);
let fadeTimer = 0;
let fadeDone: (() => void) | null = null;
function fadeTo(target: number, ms: number): Promise<void> {
  window.clearInterval(fadeTimer);
  fadeDone?.();
  const from = gain;
  const t0 = performance.now();
  return new Promise((resolve) => {
    fadeDone = resolve;
    // setInterval (not rAF) so fades still finish in a background tab.
    fadeTimer = window.setInterval(() => {
      const k = ms <= 0 ? 1 : Math.min(1, (performance.now() - t0) / ms);
      gain = from + (target - from) * k;
      applyVolume();
      if (k >= 1) {
        window.clearInterval(fadeTimer);
        fadeDone = null;
        resolve();
      }
    }, 30);
  });
}
/** When set, the next actual playback start fades in over this many ms. */
let fadeInOnStart = 0;
/** The engine is actually producing sound (even while the button already shows "paused" mid-fade). */
let engineOn = false;
const onStarted = () => {
  engineOn = true;
  set({ playing: true });
  if (fadeInOnStart) {
    void fadeTo(1, fadeInOnStart);
    fadeInOnStart = 0;
  }
};
/** Bumped on every play request, so a fade-out that finishes late doesn't pause newer playback. */
let playToken = 0;

/* ----------------------------------------------------------------------------- engines ---- */

const audio = typeof Audio !== 'undefined' ? new Audio() : null;
if (audio) {
  audio.preload = 'metadata';
  audio.addEventListener('timeupdate', () => setTime(audio.currentTime));
  audio.addEventListener('loadedmetadata', () => set({ duration: audio.duration || 0 }));
  audio.addEventListener('playing', onStarted);
  audio.addEventListener('pause', () => {
    engineOn = false;
    set({ playing: false });
  });
  audio.addEventListener('ended', () => load(state.index + 1, true));
}
const audioEngine: Engine = {
  load: (t) => {
    if (audio) audio.src = t.src!;
  },
  play: () => void audio?.play().catch(() => set({ playing: false })),
  pause: () => audio?.pause(),
  seek: (s) => {
    if (audio) audio.currentTime = s;
  },
  volume: (v) => {
    if (audio) audio.volume = Math.min(1, Math.max(0, v));
  },
};

/**
 * SoundCloud: a hidden official widget iframe driven over its postMessage protocol (the one
 * w.soundcloud.com/player/api.js speaks), so no third-party script runs in our origin. Tracks are
 * always loaded paused and started after `ready`, once our volume is applied (a fade starts from 0).
 */
let frame: HTMLIFrameElement | null = null;
let scReady = false;
let scPendingPlay = false;
const scPost = (method: string, value?: unknown) =>
  frame?.contentWindow?.postMessage(JSON.stringify({ method, value }), SC_ORIGIN);
/**
 * Position is asked for once a second while playing, instead of subscribing to the widget's
 * playProgress event (fired many times a second — the main idle CPU cost of the music player).
 */
let scPoll: number | null = null;
const scPollStart = () => {
  if (scPoll === null) scPoll = window.setInterval(() => scPost('getPosition'), 1000);
};
const scPollStop = () => {
  if (scPoll !== null) window.clearInterval(scPoll);
  scPoll = null;
};
const scEngine: Engine = {
  load: (t) => {
    if (!frame) {
      frame = document.createElement('iframe');
      frame.title = 'SoundCloud player';
      frame.allow = 'autoplay; encrypted-media';
      frame.tabIndex = -1;
      frame.setAttribute('aria-hidden', 'true');
      frame.style.cssText =
        'position:fixed;left:-10000px;top:0;width:300px;height:166px;border:0;opacity:0;pointer-events:none';
      document.body.appendChild(frame);
    }
    scReady = false;
    scPendingPlay = false;
    scPollStop();
    const q = new URLSearchParams({
      url: t.sc!,
      auto_play: 'false',
      visual: 'false',
      show_artwork: 'false',
      show_comments: 'false',
      sharing: 'false',
      buying: 'false',
      download: 'false',
      single_active: 'false',
    });
    frame.src = `${SC_ORIGIN}/player/?${q.toString()}`;
  },
  play: () => {
    if (scReady) scPost('play');
    else scPendingPlay = true;
  },
  pause: () => {
    scPendingPlay = false;
    scPost('pause');
  },
  seek: (s) => scPost('seekTo', Math.round(s * 1000)),
  volume: (v) => scPost('setVolume', Math.round(Math.min(1, Math.max(0, v)) * 100)),
};
if (typeof window !== 'undefined') {
  // The hidden widget grabs keyboard focus on some commands (e.g. pause); hand it straight back so
  // the page (and the open dock) never notice.
  let lastFocus: HTMLElement | null = null;
  document.addEventListener('focusin', (e) => {
    if (e.target instanceof HTMLElement && e.target !== frame) lastFocus = e.target;
  });
  window.addEventListener('blur', () =>
    window.setTimeout(() => {
      if (!frame || document.activeElement !== frame) return;
      if (lastFocus?.isConnected) lastFocus.focus({ preventScroll: true });
      else frame.blur();
    }),
  );
  window.addEventListener('message', (e: MessageEvent) => {
    if (e.origin !== SC_ORIGIN || !frame || e.source !== frame.contentWindow) return;
    let msg: { method?: string; value?: unknown };
    try {
      msg = (typeof e.data === 'string' ? JSON.parse(e.data) : e.data) as typeof msg;
    } catch {
      return;
    }
    switch (msg?.method) {
      case 'ready':
        scReady = true;
        for (const ev of ['play', 'pause', 'finish', 'error']) scPost('addEventListener', ev);
        applyVolume();
        scPost('getDuration');
        if (scPendingPlay) scPost('play');
        break;
      case 'play':
        onStarted();
        scPost('getDuration');
        scPollStart();
        break;
      case 'pause':
        scPollStop();
        engineOn = false;
        set({ playing: false });
        break;
      case 'finish':
        scPollStop();
        load(state.index + 1, true);
        break;
      case 'error':
        load(state.index + 1, state.playing);
        break;
      case 'getPosition':
        if (typeof msg.value === 'number') setTime(msg.value / 1000);
        break;
      case 'getDuration':
        if (typeof msg.value === 'number') set({ duration: msg.value / 1000 });
        break;
    }
  });
}

let engine: Engine = audioEngine;

/** Starts the current engine with a fade-in from silence. */
function start(fadeMs: number) {
  playToken++;
  if (engineOn) {
    // Still audible (a fade-out was in progress): just swell back from the current level.
    set({ playing: true });
    void fadeTo(1, fadeMs);
    return;
  }
  window.clearInterval(fadeTimer);
  fadeDone?.();
  fadeDone = null;
  gain = 0;
  applyVolume();
  fadeInOnStart = Math.max(1, fadeMs);
  engine.play();
}

function load(i: number, autoplay: boolean, fadeMs = 0) {
  if (state.tracks.length === 0) return;
  const index = ((i % state.tracks.length) + state.tracks.length) % state.tracks.length;
  const t = state.tracks[index]!;
  const next = t.sc ? scEngine : audioEngine;
  if (next !== engine) engine.pause();
  engine = next;
  set({ index, time: 0, duration: 0 });
  persist();
  engineOn = false;
  engine.load(t);
  if (autoplay) start(fadeMs);
  else {
    gain = 1;
    applyVolume();
  }
}

function shuffle<T>(a: T[]) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

let initialised = false;
export async function initMusic() {
  if (initialised || typeof window === 'undefined') return;
  initialised = true;
  let saved: { volume?: number; index?: number; off?: boolean } = {};
  try {
    saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') as typeof saved;
  } catch {
    /* ignore */
  }
  try {
    const r = await fetch('/music/tracks.json', { cache: 'no-cache' });
    const j = (await r.json()) as { shuffle?: boolean; tracks?: Track[] };
    const tracks = (j.tracks ?? []).filter(
      (t) =>
        (typeof t.src === 'string' && t.src.startsWith('/music/')) ||
        (typeof t.sc === 'string' && t.sc.startsWith('https://soundcloud.com/')),
    );
    shuffled = j.shuffle === true;
    if (shuffled) shuffle(tracks);
    // Volume moves in 10 % steps; older saved values are snapped to the nearest step.
    const volume =
      typeof saved.volume === 'number' ? Math.round(Math.min(1, Math.max(0, saved.volume)) * 10) / 10 : 0.5;
    set({ tracks, volume });
    userPaused = saved.off === true;
    load(shuffled ? 0 : (saved.index ?? 0), false);
    if (!userPaused) autoStart();
  } catch {
    set({ tracks: [] });
  }
}

/**
 * Music starts on its own when the site opens. Browsers only allow sound after the visitor has
 * interacted with the page, so we try right away (allowed e.g. for often-visited sites) and otherwise
 * start on the first click / key press anywhere — except on the player itself, which handles it.
 */
function autoStart() {
  start(AUTO_FADE_MS);
  const events = ['pointerdown', 'keydown'] as const;
  const off = () => events.forEach((ev) => window.removeEventListener(ev, kick, true));
  function kick(e: Event) {
    off();
    if (userPaused || engineOn || state.playing) return;
    if (e.target instanceof Element && e.target.closest('[aria-label="Music player"]')) return;
    start(AUTO_FADE_MS);
  }
  events.forEach((ev) => window.addEventListener(ev, kick, true));
}

/**
 * Fades the music out, then pauses. Resolves when silent. Returns whether music was playing,
 * so a caller can resume afterwards.
 */
export function fadeOutAndPause(ms = FADE_OUT_MS): Promise<boolean> {
  const wasPlaying = state.playing || fadeInOnStart > 0;
  fadeInOnStart = 0;
  scPendingPlay = false;
  if (!wasPlaying) return Promise.resolve(false);
  const token = playToken;
  set({ playing: false }); // the button flips immediately; the sound tails off
  return fadeTo(0, ms).then(() => {
    if (token === playToken) engine.pause();
    return true;
  });
}

/** Starts the next track, fading in (used after signing in: new screen, new track). */
export function playNextTrack(fadeMs = 1800) {
  load(state.index + 1, true, fadeMs);
}

export const musicActions = {
  toggle: () => {
    if (state.tracks.length === 0) return;
    userPaused = state.playing;
    persist();
    if (state.playing) void fadeOutAndPause();
    else start(FADE_IN_MS);
  },
  next: () => load(state.index + 1, state.playing, FADE_IN_MS),
  prev: () => {
    if (state.time > 3) engine.seek(0);
    else load(state.index - 1, state.playing, FADE_IN_MS);
  },
  pick: (i: number) => load(i, true, FADE_IN_MS),
  volume: (v: number) => {
    set({ volume: Math.min(1, Math.max(0, v)) });
    applyVolume();
    persist();
  },
  seek: (fraction: number) => {
    if (state.duration) engine.seek(fraction * state.duration);
  },
};

export function usePlayer() {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
    () => state,
  );
}
