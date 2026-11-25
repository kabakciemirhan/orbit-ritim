// Standard MIDI File parser (format 0 and 1). Pure, no DOM.

class Reader {
  constructor(bytes) {
    this.b = bytes;
    this.p = 0;
  }
  u8() { return this.b[this.p++]; }
  u16() { const v = (this.b[this.p] << 8) | this.b[this.p + 1]; this.p += 2; return v; }
  u32() {
    const v = ((this.b[this.p] << 24) >>> 0) + (this.b[this.p + 1] << 16) + (this.b[this.p + 2] << 8) + this.b[this.p + 3];
    this.p += 4;
    return v;
  }
  str(n) {
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.b[this.p + i]);
    this.p += n;
    return s;
  }
  vlq() {
    let v = 0;
    for (let i = 0; i < 4; i++) {
      const c = this.u8();
      v = (v << 7) | (c & 0x7f);
      if (!(c & 0x80)) break;
    }
    return v;
  }
}

function parseTrack(r, end) {
  const events = [];
  let tick = 0;
  let status = 0;
  let name = '';
  while (r.p < end) {
    tick += r.vlq();
    let b = r.u8();
    if (b === 0xff) {
      const type = r.u8();
      const len = r.vlq();
      const start = r.p;
      if (type === 0x51 && len === 3) {
        const mpq = (r.b[start] << 16) | (r.b[start + 1] << 8) | r.b[start + 2];
        events.push({ tick, kind: 'tempo', mpq });
      } else if (type === 0x03 && !name) {
        name = r.str(len).replace(/\0/g, '').trim();
      } else if (type === 0x2f) {
        r.p = start + len;
        break;
      }
      r.p = start + len;
      continue;
    }
    if (b === 0xf0 || b === 0xf7) {
      r.p += r.vlq();
      continue;
    }
    // Running status: data byte reuses previous status
    let d1;
    if (b & 0x80) {
      status = b;
      d1 = r.u8();
    } else {
      if (!status) throw new Error('Running status without prior status byte');
      d1 = b;
    }
    const hi = status & 0xf0;
    const ch = status & 0x0f;
    if (hi === 0xc0 || hi === 0xd0) {
      continue; // one data byte
    }
    const d2 = r.u8();
    if (hi === 0x90 && d2 > 0) events.push({ tick, kind: 'on', ch, pitch: d1, vel: d2 });
    else if (hi === 0x80 || hi === 0x90) events.push({ tick, kind: 'off', ch, pitch: d1 });
  }
  return { name, events };
}

// Build a tempo map: segments [{tick, time_s, mpq}] sorted by tick
function buildTempoMap(tempoEvents, ppq) {
  const sorted = tempoEvents.slice().sort((a, b) => a.tick - b.tick);
  const map = [{ tick: 0, time_s: 0, mpq: 500000 }];
  for (const e of sorted) {
    const last = map[map.length - 1];
    const t = last.time_s + ((e.tick - last.tick) * last.mpq) / (ppq * 1e6);
    if (e.tick === last.tick) {
      last.mpq = e.mpq;
    } else {
      map.push({ tick: e.tick, time_s: t, mpq: e.mpq });
    }
  }
  return map;
}

function tickToSeconds(map, tick, ppq) {
  // Binary search for last segment with seg.tick <= tick
  let lo = 0;
  let hi = map.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (map[mid].tick <= tick) lo = mid;
    else hi = mid - 1;
  }
  const s = map[lo];
  return s.time_s + ((tick - s.tick) * s.mpq) / (ppq * 1e6);
}

export function parseMidi(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const r = new Reader(bytes);
  if (r.str(4) !== 'MThd') throw new Error('Geçersiz MIDI dosyası (MThd yok)');
  const hlen = r.u32();
  const format = r.u16();
  const ntracks = r.u16();
  const division = r.u16();
  r.p = 8 + hlen;
  if (format > 1) throw new Error('Yalnızca MIDI format 0 ve 1 destekleniyor');
  if (division & 0x8000) throw new Error('SMPTE zaman bölümü desteklenmiyor');
  const ppq = division;

  const raw = [];
  for (let i = 0; i < ntracks && r.p < bytes.length; i++) {
    const id = r.str(4);
    const len = r.u32();
    const end = Math.min(r.p + len, bytes.length);
    if (id !== 'MTrk') { r.p = end; continue; }
    raw.push(parseTrack(r, end));
    r.p = end;
  }

  const tempoEvents = [];
  for (const t of raw) for (const e of t.events) if (e.kind === 'tempo') tempoEvents.push(e);
  const tempoMap = buildTempoMap(tempoEvents, ppq);

  let duration = 0;
  const tracks = [];
  raw.forEach((t, idx) => {
    const open = new Map(); // key ch*128+pitch -> stack of {tick, vel}
    const notes = [];
    for (const e of t.events) {
      if (e.kind === 'on') {
        const k = e.ch * 128 + e.pitch;
        if (!open.has(k)) open.set(k, []);
        open.get(k).push({ tick: e.tick, vel: e.vel });
      } else if (e.kind === 'off') {
        const k = e.ch * 128 + e.pitch;
        const st = open.get(k);
        if (st && st.length) {
          const on = st.shift();
          const t0 = tickToSeconds(tempoMap, on.tick, ppq);
          const t1 = tickToSeconds(tempoMap, e.tick, ppq);
          notes.push({ time_s: t0, dur_s: Math.max(0, t1 - t0), pitch: e.pitch, vel: on.vel });
        }
      }
    }
    // Close dangling notes with a short duration
    for (const [k, st] of open) {
      for (const on of st) {
        notes.push({ time_s: tickToSeconds(tempoMap, on.tick, ppq), dur_s: 0.1, pitch: k % 128, vel: on.vel });
      }
    }
    notes.sort((a, b) => a.time_s - b.time_s || a.pitch - b.pitch);
    for (const n of notes) duration = Math.max(duration, n.time_s + n.dur_s);
    if (notes.length) tracks.push({ name: t.name || `Track ${idx + 1}`, notes });
  });

  return {
    format,
    ppq,
    tracks,
    duration_s: duration,
    tempoMap: tempoMap.map((s) => ({ tick: s.tick, time_s: s.time_s, bpm: 60e6 / s.mpq })),
  };
}
