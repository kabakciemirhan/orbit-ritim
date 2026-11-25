// AudioContext ownership, decoding, playback and the master "heard" clock.
// All game time derives from AudioContext time; performance.now() is only used
// to interpolate between audio clock updates and to map input event timestamps.

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.source = null;
    this.gain = null;
    this.clockOffset = null; // heardCtxTime - perf/1000, smoothed
    this.playing = null; // { startCtx, songFrom, rate }
    this.listeners = new Set();
  }

  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC({ latencyHint: 'interactive' });
      this.gain = this.ctx.createGain();
      this.gain.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  async decode(arrayBuffer) {
    const ctx = this.ensure();
    return ctx.decodeAudioData(arrayBuffer.slice(0));
  }

  latency() {
    const c = this.ctx;
    return (c.outputLatency || 0) + (c.baseLatency || 0);
  }

  // Raw estimate of the AudioContext time currently audible at performance time `perf` (ms)
  rawHeard(perf) {
    const c = this.ctx;
    if (c.getOutputTimestamp) {
      const ts = c.getOutputTimestamp();
      if (ts && ts.performanceTime > 0 && Number.isFinite(ts.contextTime) && ts.contextTime > 0) {
        return ts.contextTime + (perf - ts.performanceTime) / 1000;
      }
    }
    return c.currentTime - this.latency();
  }

  // Smoothed heard clock. Tracks drift between performance.now() and the audio clock.
  heardAt(perf = performance.now()) {
    if (!this.ctx) return 0;
    const pnow = performance.now();
    const sample = this.rawHeard(pnow) - pnow / 1000;
    if (this.clockOffset === null || Math.abs(sample - this.clockOffset) > 0.03) this.clockOffset = sample;
    else this.clockOffset += (sample - this.clockOffset) * 0.02;
    return perf / 1000 + this.clockOffset;
  }

  // Song time (seconds) audible at performance time `perf`
  songTime(perf = performance.now()) {
    if (!this.playing) return 0;
    const p = this.playing;
    return p.songFrom + (this.heardAt(perf) - p.startCtx) * p.rate;
  }

  // Start buffer so that song time `songFrom` is heard after `delay` seconds. songFrom may be negative.
  play(buffer, { songFrom = 0, rate = 1, delay = 0.12, volume = 1 } = {}) {
    const ctx = this.ensure();
    this.stop();
    const startCtx = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    src.connect(this.gain);
    this.gain.gain.setValueAtTime(volume, ctx.currentTime);
    if (songFrom >= 0) {
      if (songFrom < buffer.duration) src.start(startCtx, songFrom);
    } else {
      src.start(startCtx + -songFrom / rate, 0);
    }
    this.source = src;
    this.playing = { startCtx, songFrom, rate };
    this.clockOffset = null;
    return this.playing;
  }

  stop() {
    if (this.source) {
      try { this.source.stop(); } catch { /* not started */ }
      this.source.disconnect();
      this.source = null;
    }
    this.playing = null;
  }

  // Context time at which song time `t` will be scheduled
  ctxTimeForSong(t) {
    const p = this.playing;
    return p.startCtx + (t - p.songFrom) / p.rate;
  }

  click(when, { freq = 1500, gain = 0.25, dur = 0.03 } = {}) {
    const ctx = this.ensure();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = freq;
    o.type = 'square';
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(gain, when + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    o.connect(g).connect(ctx.destination);
    o.start(when);
    o.stop(when + dur + 0.02);
  }
}

// Lookahead scheduler for many clicks against the playing song
export function clickScheduler(audio, getTimes, opts = {}) {
  let idx = 0;
  let timer = null;
  const tick = () => {
    if (!audio.playing) return;
    const times = getTimes();
    const ctxNow = audio.ctx.currentTime;
    const horizon = ctxNow + 0.25;
    while (idx < times.length) {
      const when = audio.ctxTimeForSong(times[idx]);
      if (when < ctxNow) { idx++; continue; }
      if (when > horizon) break;
      audio.click(when, opts);
      idx++;
    }
  };
  return {
    start(fromSong) {
      const times = getTimes();
      idx = 0;
      while (idx < times.length && times[idx] < fromSong) idx++;
      timer = setInterval(tick, 40);
      tick();
    },
    reset(fromSong) {
      const times = getTimes();
      idx = 0;
      while (idx < times.length && times[idx] < fromSong) idx++;
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
  };
}
