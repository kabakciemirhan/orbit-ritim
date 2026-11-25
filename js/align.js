// MP3 <-> MIDI automatic alignment via spectral-flux onset envelope cross-correlation.
// Core functions are pure (usable from Node); decodeMono needs a browser.

export const ALIGN_SR = 22050;
export const MIN_CONFIDENCE = 0.5;
export const HOP = 220; // ~9.98 ms
const FFT_N = 1024;

function fftMag(re, im) {
  // In-place iterative radix-2 FFT
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

// Spectral flux onset envelope; returns { env: Float32Array, fps }
export function onsetEnvelope(mono, sr = ALIGN_SR, hop = HOP) {
  const frames = Math.max(0, Math.floor((mono.length - FFT_N) / hop) + 1);
  const env = new Float32Array(frames);
  const win = new Float32Array(FFT_N);
  for (let i = 0; i < FFT_N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_N);
  const half = FFT_N / 2;
  let prev = new Float32Array(half);
  let cur = new Float32Array(half);
  const re = new Float32Array(FFT_N);
  const im = new Float32Array(FFT_N);
  for (let f = 0; f < frames; f++) {
    const off = f * hop;
    for (let i = 0; i < FFT_N; i++) {
      re[i] = mono[off + i] * win[i];
      im[i] = 0;
    }
    fftMag(re, im);
    let flux = 0;
    for (let k = 1; k < half; k++) {
      const m = Math.log1p(100 * Math.hypot(re[k], im[k]));
      cur[k] = m;
      const d = m - prev[k];
      if (d > 0) flux += d;
    }
    env[f] = flux;
    [prev, cur] = [cur, prev];
  }
  // Remove slow trend (moving mean ~0.5 s) and half-wave rectify, then normalize
  const w = 25;
  const out = new Float32Array(frames);
  let acc = 0;
  for (let i = 0; i < Math.min(frames, w); i++) acc += env[i];
  for (let i = 0; i < frames; i++) {
    const lo = i - w - 1;
    const hi = i + w;
    if (hi < frames) acc += env[hi];
    if (lo >= 0) acc -= env[lo];
    const cnt = Math.min(frames - 1, hi) - Math.max(0, lo + 1) + 1;
    out[i] = Math.max(0, env[i] - acc / cnt);
  }
  let max = 0;
  for (let i = 0; i < frames; i++) max = Math.max(max, out[i]);
  if (max > 0) for (let i = 0; i < frames; i++) out[i] /= max;
  return { env: out, fps: sr / hop };
}

export function gaussianBlur(arr, sigma = 1.5) {
  const r = Math.ceil(sigma * 3);
  const k = [];
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k.push(v);
    sum += v;
  }
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    let a = 0;
    for (let j = -r; j <= r; j++) {
      const x = i + j;
      if (x >= 0 && x < arr.length) a += arr[x] * k[j + r];
    }
    out[i] = a / sum;
  }
  return out;
}

// Merge MIDI notes to onset times (35 ms) with weights
export function midiOnsets(notes, win = 0.035) {
  const sorted = notes.slice().sort((a, b) => a.time_s - b.time_s);
  const out = [];
  let cur = null;
  for (const n of sorted) {
    if (cur && n.time_s - cur.t < win) cur.w += 1;
    else {
      cur = { t: n.time_s, w: 1 };
      out.push(cur);
    }
  }
  for (const o of out) o.w = Math.sqrt(o.w);
  return out;
}

const sample = (arr, x) => {
  const i = Math.floor(x);
  if (i < 0 || i + 1 >= arr.length) return 0;
  const f = x - i;
  return arr[i] * (1 - f) + arr[i + 1] * f;
};

function scoreAt(envB, fps, onsets, scale, offset) {
  let s = 0;
  for (const o of onsets) s += o.w * sample(envB, (scale * o.t + offset) * fps);
  return s;
}

// audioTime = scale * midiTime + offset
export function alignEnvelope(env, fps, notes, opts = {}) {
  const range = opts.range ?? 3;
  const sMin = opts.scaleMin ?? 0.97;
  const sMax = opts.scaleMax ?? 1.03;
  const sStep = opts.scaleStep ?? 0.0025;
  const envB = gaussianBlur(env, opts.sigma ?? 1.5);
  const onsets = midiOnsets(notes);
  const step = 1 / fps;
  let best = { score: -Infinity, offset: 0, scale: 1 };
  for (let sc = sMin; sc <= sMax + 1e-9; sc += sStep) {
    for (let off = -range; off <= range + 1e-9; off += step) {
      const s = scoreAt(envB, fps, onsets, sc, off);
      if (s > best.score) best = { score: s, offset: off, scale: sc };
    }
  }
  // Recompute curve at best scale for confidence + sub-frame refinement
  const curve = [];
  for (let off = -range; off <= range + 1e-9; off += step) curve.push(scoreAt(envB, fps, onsets, best.scale, off));
  const bi = Math.round((best.offset + range) / step);
  if (bi > 0 && bi < curve.length - 1) {
    const a = curve[bi - 1];
    const b = curve[bi];
    const c = curve[bi + 1];
    const den = a - 2 * b + c;
    if (den < 0) best.offset += (0.5 * (a - c) / den) * step;
  }
  const mean = curve.reduce((x, y) => x + y, 0) / curve.length;
  const sd = Math.sqrt(curve.reduce((x, y) => x + (y - mean) ** 2, 0) / curve.length) || 1;
  const z = (best.score - mean) / sd;
  // Second-best peak outside ±60 ms
  let second = -Infinity;
  const excl = Math.round(0.06 / step);
  curve.forEach((v, i) => { if (Math.abs(i - bi) > excl) second = Math.max(second, v); });
  const ratio = second > 0 ? best.score / second : 2;
  const map = linearMap(best.offset, best.scale);
  const q = matchQuality(env, fps, notes, map);
  return { method: 'linear', offset: best.offset, scale: best.scale, z, ratio, map, ...q };
}


// ---- Time maps: list of anchors {m, a} (MIDI time -> audio time), piecewise linear ----

export function linearMap(offset, scale) {
  return [{ m: 0, a: offset }, { m: 1000, a: offset + scale * 1000 }];
}

export function applyMap(map, m) {
  if (map.length === 1) return map[0].a + (m - map[0].m);
  let lo = 0;
  let hi = map.length - 2;
  if (m <= map[0].m) hi = 0;
  else if (m >= map[map.length - 1].m) lo = map.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (map[mid].m <= m) lo = mid;
    else hi = mid - 1;
  }
  const p = map[lo];
  const q = map[lo + 1];
  return p.a + ((m - p.m) * (q.a - p.a)) / (q.m - p.m);
}

// Fine adjustment on top of a map: shift + stretch around the first note
export function adjustMap(map, fineOffset, fineScale, pivotMidi) {
  const pa = applyMap(map, pivotMidi);
  return map.map((k) => ({ m: k.m, a: pa + (k.a - pa) * fineScale + fineOffset }));
}

function pickPeaks(env, fps, thr = 0.1) {
  const peaks = [];
  for (let i = 2; i < env.length - 2; i++) {
    const v = env[i];
    if (v > thr && v >= env[i - 1] && v >= env[i + 1] && v >= env[i - 2] && v >= env[i + 2]) peaks.push(i / fps);
  }
  return peaks;
}

// Fraction of MIDI onsets with an audio onset within ±tol, vs chance level
export function matchQuality(env, fps, notes, map, tol = 0.03) {
  const peaks = pickPeaks(env, fps);
  const onsets = midiOnsets(notes);
  const dur = env.length / fps;
  const near = (t) => {
    let lo = 0;
    let hi = peaks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (peaks[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    const d1 = Math.abs(peaks[lo] - t);
    const d2 = lo > 0 ? Math.abs(peaks[lo - 1] - t) : Infinity;
    return Math.min(d1, d2);
  };
  let hit = 0;
  let total = 0;
  let inside = 0;
  for (const o of onsets) {
    const a = applyMap(map, o.t);
    if (a < 0 || a > dur) continue;
    inside++;
    total += o.w;
    if (peaks.length && near(a) <= tol) hit += o.w;
  }
  const hitRate = total ? hit / total : 0;
  const coverage = onsets.length ? inside / onsets.length : 0;
  // Chance: fraction of the (active) timeline covered by ±tol windows around peaks
  const chance = Math.min(0.95, (peaks.length * 2 * tol) / Math.max(1, dur));
  const confidence = Math.max(0, Math.min(1, ((hitRate - chance) / (1 - chance)) * coverage));
  return { hitRate, chance, coverage, confidence };
}

// ---- Flexible alignment: chroma DTW + onset refinement ----

const CH_HOP = 1024;
const CH_N = 4096;

function audioChroma(mono, sr) {
  const frames = Math.max(0, Math.floor((mono.length - CH_N) / CH_HOP) + 1);
  const out = new Float32Array(frames * 12);
  const energy = new Float32Array(frames);
  const re = new Float32Array(CH_N);
  const im = new Float32Array(CH_N);
  const win = new Float32Array(CH_N);
  for (let i = 0; i < CH_N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / CH_N);
  const binClass = new Int8Array(CH_N / 2).fill(-1);
  for (let k = 1; k < CH_N / 2; k++) {
    const f = (k * sr) / CH_N;
    if (f < 50 || f > 4200) continue;
    const pitch = 69 + 12 * Math.log2(f / 440);
    binClass[k] = ((Math.round(pitch) % 12) + 12) % 12;
  }
  for (let fr = 0; fr < frames; fr++) {
    const off = fr * CH_HOP;
    for (let i = 0; i < CH_N; i++) {
      re[i] = mono[off + i] * win[i];
      im[i] = 0;
    }
    fftMag(re, im);
    let e = 0;
    for (let k = 1; k < CH_N / 2; k++) {
      const c = binClass[k];
      if (c < 0) continue;
      const m = re[k] * re[k] + im[k] * im[k];
      out[fr * 12 + c] += m;
      e += m;
    }
    energy[fr] = e;
  }
  normalizeChroma(out, frames, energy);
  return { chroma: out, frames, fps: sr / CH_HOP };
}

function normalizeChroma(ch, frames, energy) {
  let maxE = 0;
  for (let i = 0; i < frames; i++) maxE = Math.max(maxE, energy[i]);
  for (let f = 0; f < frames; f++) {
    let n = 0;
    for (let c = 0; c < 12; c++) {
      const v = Math.sqrt(ch[f * 12 + c]);
      ch[f * 12 + c] = v;
      n += v * v;
    }
    n = Math.sqrt(n);
    const silent = energy[f] < maxE * 1e-4 || n === 0;
    for (let c = 0; c < 12; c++) ch[f * 12 + c] = silent ? 0.2887 : ch[f * 12 + c] / n;
  }
}

function midiChroma(notes, fps, t0, t1) {
  const frames = Math.ceil((t1 - t0) * fps) + 1;
  const out = new Float32Array(frames * 12);
  const energy = new Float32Array(frames);
  for (const n of notes) {
    const f0 = Math.max(0, Math.floor((n.time_s - t0) * fps));
    const len = Math.max(n.dur_s, 0.1) + 0.3;
    const f1 = Math.min(frames - 1, Math.ceil((n.time_s + len - t0) * fps));
    const c = n.pitch % 12;
    for (let f = f0; f <= f1; f++) {
      const dt = f / fps + t0 - n.time_s;
      const w = (n.vel / 127) * Math.exp(-Math.max(0, dt) / 0.6);
      out[f * 12 + c] += w * w;
      energy[f] += w * w;
    }
  }
  normalizeChroma(out, frames, energy);
  return { chroma: out, frames };
}

// Subsequence DTW: whole MIDI range matched to a free sub-range of the audio
function dtw(A, na, B, nb) {
  // A: midi (rows), B: audio (cols)
  const dir = new Uint8Array(na * nb);
  let prev = new Float32Array(nb);
  let cur = new Float32Array(nb);
  const cost = (i, j) => {
    let d = 0;
    for (let c = 0; c < 12; c++) d += A[i * 12 + c] * B[j * 12 + c];
    return 1 - d;
  };
  for (let j = 0; j < nb; j++) prev[j] = cost(0, j);
  for (let i = 1; i < na; i++) {
    for (let j = 0; j < nb; j++) {
      const c = cost(i, j);
      let best = prev[j] + c * 1.5; // vertical (midi advances, audio holds)
      let d = 1;
      if (j > 0) {
        const diag = prev[j - 1] + c;
        if (diag <= best) { best = diag; d = 0; }
        const hor = cur[j - 1] + c * 1.5; // audio advances, midi holds
        if (hor < best) { best = hor; d = 2; }
      }
      cur[j] = best;
      dir[i * nb + j] = d;
    }
    [prev, cur] = [cur, prev];
  }
  let bj = 0;
  for (let j = 1; j < nb; j++) if (prev[j] < prev[bj]) bj = j;
  const path = [];
  let i = na - 1;
  let j = bj;
  while (i >= 0 && j >= 0) {
    path.push([i, j]);
    if (i === 0) break;
    const d = dir[i * nb + j];
    if (d === 0) { i--; j--; } else if (d === 1) i--; else j--;
  }
  path.reverse();
  return path;
}

function medianOf(a) {
  const s = a.slice().sort((x, y) => x - y);
  return s[s.length >> 1];
}

// Returns a piecewise-linear map MIDI time -> audio time
export async function flexAlign(mono, env, fps, notes, sr = ALIGN_SR, onProgress = () => {}) {
  const sorted = notes.slice().sort((a, b) => a.time_s - b.time_s);
  const tFirst = sorted[0].time_s;
  let tLast = 0;
  for (const n of sorted) tLast = Math.max(tLast, n.time_s + n.dur_s);
  const ac = audioChroma(mono, sr);
  onProgress(0.25);
  await new Promise((r) => setTimeout(r, 0));
  const t0 = Math.max(0, tFirst - 0.5);
  const mc = midiChroma(sorted, ac.fps, t0, tLast);
  const path = dtw(mc.chroma, mc.frames, ac.chroma, ac.frames);
  onProgress(0.6);
  await new Promise((r) => setTimeout(r, 0));

  // Coarse anchors every ~1 s of MIDI time, from the path row at each anchor frame
  const block = Math.round(ac.fps);
  const rows = new Map();
  for (const [i, j] of path) {
    if (!rows.has(i)) rows.set(i, []);
    rows.get(i).push(j);
  }
  const coarse = [];
  const iFirst = Math.round((tFirst - t0) * ac.fps);
  for (let ic = iFirst; ic < mc.frames; ic += block) {
    const js = rows.get(ic);
    if (!js) continue;
    coarse.push({ m: t0 + ic / ac.fps, a: medianOf(js) / ac.fps + CH_N / 2 / sr });
  }
  // Enforce monotonic audio times
  for (let k = 1; k < coarse.length; k++) if (coarse[k].a <= coarse[k - 1].a) coarse[k].a = coarse[k - 1].a + 0.01;

  // Refine anchors with onset-envelope correlation: coarse pass, then a dense pass
  const envB = gaussianBlur(env, 1.5);
  const onsets = midiOnsets(sorted);
  const refine = (base, anchorsM, win, range, taps) => {
    const deltas = anchorsM.map((m) => {
      const local = onsets.filter((o) => Math.abs(o.t - m) < win);
      if (!local.length) return 0;
      let bestD = 0;
      let bestS = -Infinity;
      for (let d = -range; d <= range + 1e-9; d += 1 / fps) {
        let s = 0;
        for (const o of local) {
          const wgt = 1 - Math.abs(o.t - m) / win;
          s += o.w * wgt * sample(envB, (applyMap(base, o.t) + d) * fps);
        }
        if (s > bestS + 1e-9 || (Math.abs(s - bestS) <= 1e-9 && Math.abs(d) < Math.abs(bestD))) { bestS = s; bestD = d; }
      }
      return bestD;
    });
    const h = taps >> 1;
    const smooth = deltas.map((_, i) => medianOf(deltas.slice(Math.max(0, i - h), i + h + 1)));
    const out = anchorsM.map((m, i) => ({ m, a: applyMap(base, m) + smooth[i] }));
    for (let k = 1; k < out.length; k++) if (out[k].a <= out[k - 1].a) out[k].a = out[k - 1].a + 0.005;
    return out;
  };
  const map1 = refine(coarse, coarse.map((k) => k.m), 2.0, 0.25, 5);
  // Dense anchors on MIDI onsets at least 0.3 s apart
  const dense = [];
  for (const o of onsets) if (!dense.length || o.t - dense[dense.length - 1] >= 0.3) dense.push(o.t);
  const map = refine(map1, dense, 0.6, 0.1, 3);
  onProgress(1);
  const q = matchQuality(env, fps, sorted, map);
  return { method: 'flex', map, ...q };
}

// ---- Browser helpers ----

// Resample an AudioBuffer to mono at ALIGN_SR via OfflineAudioContext
export async function toMono(buf) {
  const len = Math.ceil(buf.duration * ALIGN_SR);
  const off = new OfflineAudioContext(1, len, ALIGN_SR);
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  return rendered.getChannelData(0);
}

// Full pipeline: linear (spec) first, flexible warp if linear is not confident
export async function autoAlign(mono, notes, onProgress = () => {}) {
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const { env, fps } = onsetEnvelope(mono);
  onProgress(0.15);
  await tick();
  const linear = alignEnvelope(env, fps, notes);
  onProgress(0.3);
  await tick();
  if (linear.confidence >= MIN_CONFIDENCE) return { best: linear, linear, flex: null };
  const flex = await flexAlign(mono, env, fps, notes, ALIGN_SR, (p) => onProgress(0.3 + 0.7 * p));
  const best = flex.confidence > linear.confidence ? flex : linear;
  return { best, linear, flex };
}
