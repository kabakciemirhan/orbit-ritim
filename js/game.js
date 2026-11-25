// Game loop state, input judging and modes. Time source: AudioEngine (audio clock).

export const WINDOWS = { perfect: 0.045, ok: 0.090, too: 0.140 };
export const JUDGE = {
  perfect: { label: 'Perfect', score: 1 },
  early: { label: 'Early', score: 0.75 },
  late: { label: 'Late', score: 0.75 },
  tooEarly: { label: 'Too Early', score: 0.4 },
  tooLate: { label: 'Too Late', score: 0.4 },
  miss: { label: 'Miss', score: 0 },
};

// Classify a real-time offset (seconds, negative = early). null = ignored press.
export function judge(diff) {
  if (diff < -WINDOWS.too) return null;
  const a = Math.abs(diff);
  if (a <= WINDOWS.perfect) return 'perfect';
  if (a <= WINDOWS.ok) return diff < 0 ? 'early' : 'late';
  if (a <= WINDOWS.too) return diff < 0 ? 'tooEarly' : 'tooLate';
  return 'miss';
}

function countdownBeat(tiles) {
  const gaps = [];
  for (let i = 1; i < Math.min(tiles.length - 1, 6); i++) gaps.push(tiles[i + 1].t - tiles[i].t);
  gaps.sort((a, b) => a - b);
  const g = gaps.length ? gaps[gaps.length >> 1] : 0.6;
  let b = g;
  while (b < 0.35) b *= 2;
  while (b > 0.9) b /= 2;
  return b;
}

export class Game {
  constructor({ chart, audio, buffer, mode = 'normal', rate = 1, inputOffset = 0, onEvent = () => {} }) {
    this.chart = chart;
    this.tiles = chart.tiles;
    this.audio = audio;
    this.buffer = buffer;
    this.mode = mode; // normal | practice | auto
    this.rate = mode === 'practice' ? rate : 1;
    this.inputOffset = inputOffset; // seconds, positive = player presses late
    this.onEvent = onEvent;
    this.beat = countdownBeat(this.tiles);
    this.state = 'idle';
    this.checkpoint = 0;
    this.resetStats();
    this.hitTimes = new Float64Array(this.tiles.length).fill(-1);
    this.hitKinds = new Array(this.tiles.length).fill(null);
  }

  resetStats() {
    this.stats = { perfect: 0, early: 0, late: 0, tooEarly: 0, tooLate: 0, miss: 0, sumDiff: 0, nDiff: 0, score: 0, judged: 0, maxCombo: 0, deaths: 0 };
    this.combo = 0;
    this.cpSnap = { stats: { ...this.stats }, combo: 0 };
  }

  get lastTile() { return this.tiles.length - 1; }

  // Start (or restart) with the pivot on tile `from`
  start(from = 0) {
    this.cur = from;
    this.hitTimes.fill(-1);
    this.hitKinds.fill(null);
    for (let i = 0; i <= from; i++) this.hitTimes[i] = -1e9;
    const target = this.tiles[Math.min(from + 1, this.lastTile)].t;
    const lead = from === 0 ? 3 * this.beat + 0.25 : 2 * this.beat;
    this.songFrom = Math.min(this.tiles[from].t, target - lead);
    this.countdownEnd = target;
    this.countdownShow = from === 0;
    this.audio.play(this.buffer, { songFrom: this.songFrom, rate: this.rate });
    this.state = 'playing';
    this.deadAt = 0;
    this.onEvent({ type: 'start', from });
  }

  restart() {
    this.resetStats();
    this.checkpoint = 0;
    this.start(0);
  }

  now(perf) { return this.audio.songTime(perf); }

  // Real-time difference between song time t and tile i (input offset applied)
  diffFor(i, t) {
    return (t - this.inputOffset * this.rate - this.tiles[i].t) / this.rate;
  }

  pause() {
    if (this.state !== 'playing') return;
    this.pausedAt = this.now();
    this.audio.stop();
    this.state = 'paused';
  }

  resume() {
    if (this.state !== 'paused') return;
    const from = this.pausedAt - 1.5 * this.beat;
    this.audio.play(this.buffer, { songFrom: from, rate: this.rate });
    this.countdownEnd = this.pausedAt;
    this.countdownShow = true;
    this.state = 'playing';
  }

  stop() {
    this.audio.stop();
    this.state = 'idle';
  }

  record(i, kind, diff, t) {
    const s = this.stats;
    s[kind]++;
    s.judged++;
    s.score += JUDGE[kind].score;
    if (kind !== 'miss') {
      s.sumDiff += diff;
      s.nDiff++;
    }
    if (kind === 'perfect' || kind === 'early' || kind === 'late') this.combo++;
    else this.combo = 0;
    s.maxCombo = Math.max(s.maxCombo, this.combo);
    this.hitTimes[i] = t;
    this.hitKinds[i] = kind;
    this.onEvent({ type: 'judge', tile: i, kind, diff, combo: this.combo });
  }

  advance(kind, diff, t) {
    const i = this.cur + 1;
    this.record(i, kind, diff, t);
    this.cur = i;
    if (this.tiles[i].checkpoint && this.mode === 'normal') {
      this.checkpoint = i;
      this.cpSnap = { stats: { ...this.stats }, combo: this.combo };
      this.onEvent({ type: 'checkpoint', tile: i });
    }
    if (this.cur >= this.lastTile) {
      this.state = 'finishing';
      this.finishAt = t + 1.2 * this.rate;
    }
  }

  // Player input with a performance.now()-based timestamp
  press(perf) {
    if (this.state !== 'playing') return;
    const t = this.now(perf);
    this.update(t);
    if (this.state !== 'playing' || this.mode === 'auto') return;
    const i = this.cur + 1;
    if (i > this.lastTile) return;
    const diff = this.diffFor(i, t);
    const kind = judge(diff);
    if (!kind || kind === 'miss') return;
    this.advance(kind, diff, t);
  }

  // Called every frame (and before each input) with the current song time
  update(t) {
    if (this.state === 'finishing') {
      if (t >= this.finishAt) {
        this.state = 'done';
        this.audio.stop();
        this.onEvent({ type: 'done' });
      }
      return;
    }
    if (this.state === 'dead') {
      if (performance.now() >= this.deadAt) {
        const deaths = this.stats.deaths;
        this.stats = { ...this.cpSnap.stats, deaths };
        this.combo = this.cpSnap.combo;
        this.start(this.checkpoint);
      }
      return;
    }
    if (this.state !== 'playing') return;
    while (this.state === 'playing' && this.cur < this.lastTile) {
      const i = this.cur + 1;
      if (this.mode === 'auto') {
        if (t < this.tiles[i].t) break;
        this.advance('perfect', 0, this.tiles[i].t);
        continue;
      }
      const diff = this.diffFor(i, t);
      if (diff <= WINDOWS.too) break;
      if (this.mode === 'normal') {
        this.stats.miss++;
        this.stats.deaths++;
        this.combo = 0;
        this.hitKinds[i] = 'miss';
        this.state = 'dead';
        this.deadAt = performance.now() + 900;
        this.audio.stop();
        this.onEvent({ type: 'death', tile: i });
        return;
      }
      this.advance('miss', diff, t);
    }
  }

  accuracy() {
    const s = this.stats;
    return s.judged ? (100 * s.score) / s.judged : 100;
  }

  progress() {
    return this.cur / Math.max(1, this.lastTile);
  }

  // Mover angle at song time t (pivot = this.cur)
  moverAngle(t) {
    const tiles = this.tiles;
    const a = tiles[this.cur];
    const b = tiles[this.cur + 1];
    if (!b) return a.aIn + a.dir * Math.PI * ((t - a.t) / 0.6);
    const frac = (t - a.t) / (b.t - a.t);
    return a.aIn + b.dir * b.thetaVis * frac;
  }
}
