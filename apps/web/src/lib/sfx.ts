/**
 * Interface sounds in the site's "old CRT TV" style, synthesised with Web Audio (no audio files):
 *  - tab: a soft detent "tick", like an old set's channel knob;
 *  - channel: relay clunk → a hush of static under the channel-switch animation → a gentle tone as the
 *    picture locks in (sign-in);
 *  - off: the faint falling whine of a tube switching off (sign-out).
 * Everything is quiet on purpose (master ≈ −20 dB) with soft attacks, and can be turned off in Settings.
 */

const KEY = 'chog.sfx';
const MASTER = 0.1;

let ctx: AudioContext | null = null;
let out: GainNode | null = null;
let noiseBuf: AudioBuffer | null = null;

export function sfxEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setSfxEnabled(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    /* ignore */
  }
}

/** Lazily created on first use (always inside a click, so browsers allow it). */
function audio(): { ac: AudioContext; dst: GainNode } | null {
  if (!sfxEnabled() || typeof AudioContext === 'undefined') return null;
  if (!ctx) {
    ctx = new AudioContext();
    out = ctx.createGain();
    out.gain.value = MASTER;
    // A gentle low-pass keeps everything warm, never harsh.
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 5200;
    out.connect(lp).connect(ctx.destination);
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return { ac: ctx, dst: out! };
}

function noise(ac: AudioContext) {
  if (!noiseBuf) {
    noiseBuf = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const s = ac.createBufferSource();
  s.buffer = noiseBuf;
  s.loop = true;
  return s;
}

/** A short enveloped tone. */
function tone(
  ac: AudioContext,
  dst: AudioNode,
  at: number,
  o: { type?: OscillatorType; from: number; to?: number; dur: number; gain: number; attack?: number },
) {
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = o.type ?? 'sine';
  osc.frequency.setValueAtTime(o.from, at);
  if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, at + o.dur);
  const a = o.attack ?? 0.004;
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(o.gain, at + a);
  g.gain.exponentialRampToValueAtTime(0.0001, at + o.dur);
  osc.connect(g).connect(dst);
  osc.start(at);
  osc.stop(at + o.dur + 0.02);
}

let lastTick = -1; // audio time of the last tick (the context clock starts at 0)

/** Tab / section change: a soft knob detent. */
export function sfxTab() {
  const a = audio();
  if (!a) return;
  const { ac, dst } = a;
  const t = ac.currentTime;
  if (t - lastTick < 0.06) return; // no machine-gun ticks
  lastTick = t;
  const jitter = 1 + (Math.random() - 0.5) * 0.06;
  // Body of the click: a damped triangle "tock" …
  tone(ac, dst, t, { type: 'triangle', from: 1450 * jitter, to: 900 * jitter, dur: 0.045, gain: 0.55 });
  // … with a tiny filtered-noise transient for the mechanical feel.
  const n = noise(ac);
  const bp = ac.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 3200;
  bp.Q.value = 1.2;
  const g = ac.createGain();
  g.gain.setValueAtTime(0.25, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.02);
  n.connect(bp).connect(g).connect(dst);
  n.start(t);
  n.stop(t + 0.03);
}

/** Sign-in: relay clunk, a hush of static for `ms`, then a soft tone as the picture locks in. */
export function sfxChannel(ms = 1100) {
  const a = audio();
  if (!a) return;
  const { ac, dst } = a;
  const t = ac.currentTime;
  const len = ms / 1000;
  // Relay / knob clunk.
  tone(ac, dst, t, { type: 'sine', from: 140, to: 70, dur: 0.09, gain: 0.7 });
  tone(ac, dst, t, { type: 'triangle', from: 1100, to: 700, dur: 0.03, gain: 0.25 });
  // Static: band-passed noise that swells, flutters and fades — quiet, airy, not a hiss blast.
  const n = noise(ac);
  const bp = ac.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = 0.7;
  bp.frequency.setValueAtTime(2400, t);
  bp.frequency.linearRampToValueAtTime(1600, t + len);
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.32, t + 0.12);
  g.gain.setValueAtTime(0.32, t + len * 0.55);
  g.gain.exponentialRampToValueAtTime(0.0001, t + len);
  // Flutter, like a set hunting for the signal.
  const lfo = ac.createOscillator();
  const lfoGain = ac.createGain();
  lfo.frequency.value = 9;
  lfoGain.gain.value = 0.08;
  lfo.connect(lfoGain).connect(g.gain);
  n.connect(bp).connect(g).connect(dst);
  n.start(t);
  n.stop(t + len + 0.05);
  lfo.start(t);
  lfo.stop(t + len + 0.05);
  // Picture locks in: two soft sine notes (a fifth apart).
  const lock = t + len * 0.78;
  tone(ac, dst, lock, { from: 660, dur: 0.28, gain: 0.35, attack: 0.02 });
  tone(ac, dst, lock + 0.07, { from: 990, dur: 0.34, gain: 0.25, attack: 0.02 });
}

/** Sign-out: the faint falling whine of a tube switching off. */
export function sfxOff(ms = 780) {
  const a = audio();
  if (!a) return;
  const { ac, dst } = a;
  const t = ac.currentTime;
  const len = ms / 1000;
  tone(ac, dst, t, { from: 1700, to: 140, dur: len * 0.8, gain: 0.22, attack: 0.01 });
  // Soft "pop" of the collapsing picture.
  tone(ac, dst, t + len * 0.55, { from: 220, to: 60, dur: 0.12, gain: 0.45 });
}

/**
 * Notification chime: two soft sine notes (rising for good news, falling for bad), with a whisper of
 * static at the start like a set warming up. Plays even outside a click if audio was unlocked before.
 */
export function sfxNotify(kind: 'up' | 'down' | 'info' | 'warn' = 'info') {
  const a = audio();
  if (!a) return;
  const { ac, dst } = a;
  const t = ac.currentTime;
  const [n1, n2] =
    kind === 'up' ? [660, 990] : kind === 'down' ? [520, 390] : kind === 'warn' ? [600, 600] : [740, 880];
  tone(ac, dst, t, { from: n1, dur: 0.18, gain: 0.32, attack: 0.012 });
  tone(ac, dst, t + 0.09, { from: n2, dur: 0.32, gain: 0.26, attack: 0.015 });
  const n = noise(ac);
  const bp = ac.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 2600;
  const g = ac.createGain();
  g.gain.setValueAtTime(0.05, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
  n.connect(bp).connect(g).connect(dst);
  n.start(t);
  n.stop(t + 0.1);
}
