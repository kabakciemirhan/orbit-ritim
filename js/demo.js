// Original royalty-free demo level: composed note list + offline Web Audio synth.
// Rhythm is designed around a 0.6 s reference interval so angles stay readable.

const NOTE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
function p(name) {
  // e.g. "A4", "C#5", "Bb3"
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(name);
  const acc = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  return 12 * (Number(m[3]) + 1) + NOTE[m[1]] + acc;
}

// Sections: bpm + [beats, pitch] pairs. Pitch null = rest (extends previous interval).
const SECTIONS = [
  // 1. Straight line: quarters at 100 BPM (180°)
  { bpm: 100, chord: ['A2', 'F2', 'C3', 'G2'], bar: 4, mel: [
    [1, 'E4'], [1, 'A4'], [1, 'B4'], [1, 'C5'], [1, 'B4'], [1, 'A4'], [1, 'E4'], [1, 'G4'],
    [1, 'A4'], [1, 'C5'], [1, 'D5'], [1, 'E5'],
  ] },
  // 2. Dotted quarter + eighth (270° / 90°)
  { bpm: 100, chord: ['F2', 'G2', 'A2', 'E2'], bar: 4, mel: [
    [1.5, 'E5'], [0.5, 'D5'], [1.5, 'C5'], [0.5, 'A4'], [1.5, 'B4'], [0.5, 'C5'], [1.5, 'D5'], [0.5, 'B4'],
    [1.5, 'C5'], [0.5, 'A4'], [1.5, 'G4'], [0.5, 'E4'],
  ] },
  // 3. Mixed: eighth, quarter, dotted quarter, quarter (90° 180° 270° 180°)
  { bpm: 100, chord: ['A2', 'F2', 'G2'], bar: 4, mel: [
    [0.5, 'A4'], [1, 'B4'], [1.5, 'C5'], [1, 'E5'],
    [0.5, 'D5'], [1, 'C5'], [1.5, 'B4'], [1, 'G4'],
    [0.5, 'A4'], [1, 'C5'], [1.5, 'E5'], [1, 'A5'],
  ] },
  // 4. Waltz at 150 BPM: half + quarter (240° / 120°)
  { bpm: 150, chord: ['D3', 'A2', 'F2', 'E2'], bar: 3, mel: [
    [2, 'A5'], [1, 'G5'], [2, 'F5'], [1, 'E5'], [2, 'D5'], [1, 'E5'], [2, 'F5'], [1, 'A5'],
    [2, 'G5'], [1, 'F5'], [2, 'E5'], [1, 'C5'], [2, 'D5'], [1, 'B4'], [2, 'C5'], [1, 'E5'],
  ] },
  // 5. Bridge: halves at 200 BPM (still 0.6 s = 180°)
  { bpm: 200, chord: ['A2', 'G2'], bar: 4, mel: [
    [2, 'A4'], [2, 'C5'], [2, 'E5'], [2, 'G5'],
  ] },
  // 6. 200 BPM: quarter + dotted half (90° / 270°), then 90 90 270 270
  { bpm: 200, chord: ['A2', 'F2', 'C3', 'G2'], bar: 4, mel: [
    [1, 'A5'], [3, 'E5'], [1, 'G5'], [3, 'D5'], [1, 'F5'], [3, 'C5'], [1, 'E5'], [3, 'B4'],
    [1, 'C5'], [1, 'D5'], [3, 'E5'], [3, 'A4'], [1, 'B4'], [1, 'C5'], [3, 'D5'], [3, 'G4'],
    [1, 'A4'], [1, 'B4'], [3, 'C5'], [3, 'E5'],
  ] },
  // 7. 300 BPM grid: short + long (60° / 330° and 60° / 270°) — sharp corners
  { bpm: 300, chord: ['F2', 'G2', 'E2', 'A2'], bar: 6, mel: [
    [1, 'A5'], [5.5, 'E5'], [1, 'B5'], [4.5, 'E5'], [1, 'C6'], [5.5, 'E5'], [1, 'B5'], [4.5, 'G5'],
    [1, 'A5'], [5.5, 'F5'], [1, 'G5'], [4.5, 'E5'], [1, 'F5'], [5.5, 'D5'], [1, 'E5'], [4.5, 'C5'],
  ] },
  // 8. Finale: back to the straight line
  { bpm: 100, chord: ['F2', 'G2', 'A2'], bar: 4, mel: [
    [1, 'E5'], [1, 'D5'], [1, 'C5'], [1, 'B4'], [1, 'C5'], [1, 'D5'], [1, 'E5'], [1, 'G5'],
    [1, 'A5'], [1, 'E5'], [1, 'C5'], [2, 'A4'],
  ] },
];

function compose() {
  const notes = [];
  const accomp = [];
  let t = 1.2; // lead-in silence
  for (const sec of SECTIONS) {
    const beat = 60 / sec.bpm;
    const start = t;
    for (const [beats, name] of sec.mel) {
      const dur = beats * beat;
      if (name) notes.push({ time_s: t, dur_s: Math.min(dur * 0.9, 0.9), pitch: p(name), vel: 96 });
      t += dur;
    }
    // Accompaniment: bass per bar, soft ticks per beat
    const barLen = sec.bar * beat;
    let ci = 0;
    for (let bt = start; bt < t - 1e-6; bt += barLen) {
      const root = p(sec.chord[ci++ % sec.chord.length]);
      const len = Math.min(barLen, t - bt);
      accomp.push({ kind: 'bass', time_s: bt, dur_s: len * 0.95, pitch: root });
      accomp.push({ kind: 'pad', time_s: bt, dur_s: len, pitch: root + 12 + 7 });
      accomp.push({ kind: 'pad', time_s: bt, dur_s: len, pitch: root + 12 + 15 });
    }
    for (let bt = start; bt < t - 1e-6; bt += beat) accomp.push({ kind: 'tick', time_s: bt, dur_s: 0.05, pitch: 0 });
  }
  return { notes, accomp, duration: t + 2 };
}

const composed = compose();
export const DEMO_SONG = {
  id: 'demo-orbit-v1',
  title: 'Yörünge Etüdü',
  notes: composed.notes,
  accomp: composed.accomp,
  duration: composed.duration,
  bpm: 100,
};

// Midi-like object so the rest of the app treats the demo like any song
export function demoAsMidi() {
  return {
    format: 0, ppq: 480, duration_s: DEMO_SONG.duration,
    tracks: [{ name: 'Melodi', notes: DEMO_SONG.notes.map((n) => ({ ...n })) }],
    tempoMap: [{ tick: 0, time_s: 0, bpm: DEMO_SONG.bpm }],
  };
}

const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);

// Render the demo to an AudioBuffer (browser only)
export async function renderDemo(sampleRate = 44100) {
  const len = Math.ceil(DEMO_SONG.duration * sampleRate);
  const ctx = new OfflineAudioContext(2, len, sampleRate);
  const master = ctx.createGain();
  master.gain.value = 0.55;
  const comp = ctx.createDynamicsCompressor();
  master.connect(comp).connect(ctx.destination);

  const noise = ctx.createBuffer(1, Math.floor(sampleRate * 0.1), sampleRate);
  const nd = noise.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;

  const env = (g, t, a, peak, d, sustain, rel, end) => {
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + a);
    g.gain.setTargetAtTime(sustain, t + a, d);
    g.gain.setTargetAtTime(0, end, rel);
  };

  for (const n of DEMO_SONG.notes) {
    const f = hz(n.pitch);
    const g = ctx.createGain();
    const o1 = ctx.createOscillator();
    const o2 = ctx.createOscillator();
    o1.type = 'triangle';
    o2.type = 'sine';
    o1.frequency.value = f;
    o2.frequency.value = f * 2;
    const g2 = ctx.createGain();
    g2.gain.value = 0.25;
    o1.connect(g);
    o2.connect(g2).connect(g);
    g.connect(master);
    env(g, n.time_s, 0.006, 0.5, 0.12, 0.22, 0.06, n.time_s + n.dur_s);
    o1.start(n.time_s);
    o2.start(n.time_s);
    o1.stop(n.time_s + n.dur_s + 0.5);
    o2.stop(n.time_s + n.dur_s + 0.5);
  }
  for (const a of DEMO_SONG.accomp) {
    if (a.kind === 'tick') {
      const s = ctx.createBufferSource();
      s.buffer = noise;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 7000;
      const g = ctx.createGain();
      env(g, a.time_s, 0.001, 0.12, 0.02, 0, 0.01, a.time_s + 0.04);
      s.connect(hp).connect(g).connect(master);
      s.start(a.time_s);
      continue;
    }
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    if (a.kind === 'bass') {
      o.type = 'sawtooth';
      lp.frequency.value = 400;
      env(g, a.time_s, 0.01, 0.35, 0.3, 0.18, 0.08, a.time_s + a.dur_s);
    } else {
      o.type = 'sine';
      lp.frequency.value = 2000;
      env(g, a.time_s, 0.3, 0.06, 0.5, 0.05, 0.2, a.time_s + a.dur_s);
    }
    o.frequency.value = hz(a.pitch);
    o.connect(lp).connect(g).connect(master);
    o.start(a.time_s);
    o.stop(a.time_s + a.dur_s + 1);
  }
  return ctx.startRendering();
}
