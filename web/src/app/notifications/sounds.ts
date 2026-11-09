// SPDX-License-Identifier: AGPL-3.0-only
// Notification sounds. The built-in ones are made with the Web Audio API
// (no audio files, nothing to license); people's own sounds are played from
// the server.

type Note = {
  freq: number;
  at: number; // seconds after the start
  dur: number; // seconds
  type?: OscillatorType;
  gain?: number;
  /** Ends at this frequency (a glide). */
  to?: number;
};

export const BUILTIN_SOUNDS = [
  'chime',
  'bell',
  'pop',
  'ding',
  'marimba',
  'glass',
  'drop',
  'pulse',
  'harp',
  'knock',
  'bubble',
  'twinkle',
  'whistle',
  'tap',
  'blip',
  'kalimba',
  'arcade',
  'breeze',
  'echo',
  'gong',
  'sparkle',
  'notify',
  'woodblock',
  'soft',
] as const;
export type BuiltinSound = (typeof BUILTIN_SOUNDS)[number];

export const SOUNDS: Record<BuiltinSound, Note[]> = {
  chime: [
    { freq: 880, at: 0, dur: 0.35 },
    { freq: 1318.5, at: 0.12, dur: 0.5 },
  ],
  bell: [
    { freq: 659.3, at: 0, dur: 0.9, gain: 0.8 },
    { freq: 1318.5, at: 0, dur: 0.6, gain: 0.25 },
    { freq: 1975.5, at: 0, dur: 0.4, gain: 0.1 },
  ],
  pop: [{ freq: 520, to: 260, at: 0, dur: 0.12, type: 'triangle' }],
  ding: [{ freq: 1046.5, at: 0, dur: 0.6 }],
  marimba: [
    { freq: 523.3, at: 0, dur: 0.25, type: 'triangle' },
    { freq: 784, at: 0.1, dur: 0.25, type: 'triangle' },
    { freq: 1046.5, at: 0.2, dur: 0.35, type: 'triangle' },
  ],
  glass: [
    { freq: 1567.98, at: 0, dur: 0.7, gain: 0.6 },
    { freq: 2349.3, at: 0.03, dur: 0.5, gain: 0.25 },
  ],
  drop: [{ freq: 1200, to: 400, at: 0, dur: 0.25 }],
  pulse: [
    { freq: 740, at: 0, dur: 0.08, type: 'square', gain: 0.25 },
    { freq: 740, at: 0.14, dur: 0.08, type: 'square', gain: 0.25 },
  ],
  harp: [
    { freq: 392, at: 0, dur: 0.5, type: 'triangle' },
    { freq: 493.9, at: 0.07, dur: 0.5, type: 'triangle' },
    { freq: 587.3, at: 0.14, dur: 0.5, type: 'triangle' },
    { freq: 784, at: 0.21, dur: 0.7, type: 'triangle' },
  ],
  knock: [
    { freq: 180, to: 90, at: 0, dur: 0.07, type: 'triangle', gain: 1 },
    { freq: 180, to: 90, at: 0.16, dur: 0.07, type: 'triangle', gain: 1 },
  ],
  bubble: [
    { freq: 300, to: 900, at: 0, dur: 0.12 },
    { freq: 450, to: 1300, at: 0.1, dur: 0.12, gain: 0.4 },
  ],
  twinkle: [
    { freq: 1568, at: 0, dur: 0.18, gain: 0.4 },
    { freq: 2093, at: 0.07, dur: 0.18, gain: 0.35 },
    { freq: 2637, at: 0.14, dur: 0.3, gain: 0.3 },
  ],
  whistle: [{ freq: 1200, to: 1800, at: 0, dur: 0.28, gain: 0.45 }],
  tap: [{ freq: 900, to: 600, at: 0, dur: 0.06, type: 'triangle', gain: 0.9 }],
  blip: [
    { freq: 1320, at: 0, dur: 0.06, type: 'square', gain: 0.2 },
    { freq: 1760, at: 0.07, dur: 0.06, type: 'square', gain: 0.18 },
  ],
  kalimba: [
    { freq: 1046.5, at: 0, dur: 0.45, type: 'triangle' },
    { freq: 1568, at: 0.09, dur: 0.45, type: 'triangle', gain: 0.45 },
  ],
  arcade: [
    { freq: 523.3, to: 1046.5, at: 0, dur: 0.1, type: 'square', gain: 0.2 },
    { freq: 1568, at: 0.11, dur: 0.14, type: 'square', gain: 0.18 },
  ],
  breeze: [
    { freq: 440, to: 660, at: 0, dur: 0.5, gain: 0.35 },
    { freq: 660, to: 880, at: 0.12, dur: 0.5, gain: 0.25 },
  ],
  echo: [
    { freq: 987.8, at: 0, dur: 0.2 },
    { freq: 987.8, at: 0.18, dur: 0.2, gain: 0.3 },
    { freq: 987.8, at: 0.36, dur: 0.25, gain: 0.12 },
  ],
  gong: [
    { freq: 196, at: 0, dur: 1.3, gain: 0.9 },
    { freq: 392, at: 0, dur: 0.9, gain: 0.3 },
    { freq: 587.3, at: 0, dur: 0.5, gain: 0.1 },
  ],
  sparkle: [
    { freq: 2093, at: 0, dur: 0.12, gain: 0.35 },
    { freq: 2637, at: 0.05, dur: 0.12, gain: 0.3 },
    { freq: 3136, at: 0.1, dur: 0.2, gain: 0.25 },
  ],
  notify: [
    { freq: 659.3, at: 0, dur: 0.16 },
    { freq: 987.8, at: 0.15, dur: 0.32 },
  ],
  woodblock: [
    { freq: 1000, to: 700, at: 0, dur: 0.045, type: 'triangle', gain: 1 },
    { freq: 1300, to: 900, at: 0.1, dur: 0.045, type: 'triangle', gain: 0.9 },
  ],
  soft: [
    { freq: 523.3, at: 0, dur: 0.6, gain: 0.35 },
    { freq: 659.3, at: 0.06, dur: 0.6, gain: 0.25 },
  ],
};

let context: AudioContext | undefined;

function audio(): AudioContext | undefined {
  if (typeof window === 'undefined' || typeof window.AudioContext === 'undefined') return undefined;
  context ??= new window.AudioContext();
  if (context.state === 'suspended') void context.resume().catch(() => undefined);
  return context;
}

function playNotes(notes: Note[], volume: number) {
  const ctx = audio();
  if (!ctx) return;
  const start = ctx.currentTime + 0.01;
  const master = ctx.createGain();
  master.gain.value = Math.max(0, Math.min(1, volume / 100)) * 0.35;
  master.connect(ctx.destination);
  for (const n of notes) {
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = n.type ?? 'sine';
    osc.frequency.setValueAtTime(n.freq, start + n.at);
    if (n.to) osc.frequency.exponentialRampToValueAtTime(n.to, start + n.at + n.dur);
    // A soft attack and a natural fade, no clicks.
    env.gain.setValueAtTime(0.0001, start + n.at);
    env.gain.exponentialRampToValueAtTime(n.gain ?? 0.6, start + n.at + 0.01);
    env.gain.exponentialRampToValueAtTime(0.0001, start + n.at + n.dur);
    osc.connect(env).connect(master);
    osc.start(start + n.at);
    osc.stop(start + n.at + n.dur + 0.05);
  }
}

const ownSounds = new Map<string, Promise<string>>();

async function playOwn(id: string, volume: number) {
  let url = ownSounds.get(id);
  if (!url) {
    url = fetch(`/api/sounds/${id}`, { credentials: 'same-origin' }).then(async (res) => {
      if (!res.ok) throw new Error(`sound ${res.status}`);
      return URL.createObjectURL(await res.blob());
    });
    ownSounds.set(id, url);
  }
  const el = new Audio(await url);
  el.volume = Math.max(0, Math.min(1, volume / 100));
  await el.play();
}

/** Plays a sound id: built in, "user:<id>" or "none". */
export function playSound(id: string, volume: number): void {
  if (!id || id === 'none' || volume <= 0) return;
  if (id.startsWith('user:')) {
    void playOwn(id.slice(5), volume).catch(() => undefined);
    return;
  }
  const notes = SOUNDS[id as BuiltinSound];
  if (notes) playNotes(notes, volume);
}
