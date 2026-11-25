// Chart generation: MIDI notes -> onsets -> filtered beats -> tile geometry. Pure, no DOM.

export const DIFFICULTIES = {
  easy: { label: 'Kolay', minGap: 0.300 },
  normal: { label: 'Normal', minGap: 0.160 },
  hard: { label: 'Zor', minGap: 0.090 },
  rush: { label: 'Rush', minGap: 0.050 },
};

export const MERGE_WINDOW = 0.035;
export const MIN_ANGLE = (20 * Math.PI) / 180;
const TAU = Math.PI * 2;

// Collect notes from selected tracks ('all' or index array)
export function collectNotes(midi, trackSel = 'all') {
  const out = [];
  midi.tracks.forEach((t, i) => {
    if (trackSel === 'all' || trackSel === i || (Array.isArray(trackSel) && trackSel.includes(i))) {
      for (const n of t.notes) out.push(n);
    }
  });
  out.sort((a, b) => a.time_s - b.time_s);
  return out;
}

// Merge notes closer than MERGE_WINDOW (measured from cluster start) into single onsets
export function mergeOnsets(notes, win = MERGE_WINDOW) {
  const onsets = [];
  let cur = null;
  for (const n of notes) {
    if (cur && n.time_s - cur.time < win) {
      cur.count++;
      if (n.pitch > cur.pitch || (n.pitch === cur.pitch && n.vel > cur.vel)) {
        cur.pitch = n.pitch;
      }
      cur.vel = Math.max(cur.vel, n.vel);
    } else {
      cur = { time: n.time_s, pitch: n.pitch, vel: n.vel, count: 1 };
      onsets.push(cur);
    }
  }
  return onsets;
}

const priority = (o) => o.pitch * 128 + o.vel;

// Keep beats at least minGap apart, preferring higher pitch / velocity (melody)
export function filterOnsets(onsets, minGap) {
  const kept = [];
  for (const o of onsets) {
    const last = kept[kept.length - 1];
    if (!last || o.time - last.time >= minGap - 1e-9) {
      kept.push(o);
      continue;
    }
    if (priority(o) > priority(last)) {
      const prev = kept[kept.length - 2];
      if (!prev || o.time - prev.time >= minGap - 1e-9) kept[kept.length - 1] = o;
    }
  }
  return kept;
}

export function median(arr) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Build tile geometry from beat times (seconds, ascending)
export function buildGeometry(beats, opts = {}) {
  const R = 1;
  const checkpointEvery = opts.checkpointEvery ?? 64;
  const times = beats.map((b) => b.time);
  const gaps = [];
  for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
  const dtRef = Math.max(0.03, median(gaps) || 0.5);
  const omega = Math.PI / dtRef;

  const tiles = [];
  // Tile 0: start pivot, one reference interval before the first beat (straight approach)
  tiles.push({
    i: 0, t: (times[0] ?? 0) - dtRef, x: 0, y: 0, aIn: Math.PI, dir: -1,
    thetaVis: Math.PI, thetaReal: Math.PI, rem: Math.PI, turns: 0,
    sharp: false, longWait: false, twirl: false, checkpoint: false, pitch: 60, vel: 64,
  });
  let dir = -1; // -1 = clockwise in y-up world coordinates
  let prevDt = dtRef;
  const avoid = opts.avoidOverlap ?? true;
  const W = 24;

  // Turning angle actually drawn for an interval (clamped remainder + full turns)
  const angleFor = (dt) => {
    const theta = omega * dt;
    let turns = Math.floor(theta / TAU);
    let rem = theta - turns * TAU;
    let sharp = false;
    if (rem < MIN_ANGLE) { rem = MIN_ANGLE; sharp = true; }
    else if (rem > TAU - MIN_ANGLE) { rem = TAU - MIN_ANGLE; sharp = true; }
    if (turns === 0 && theta < MIN_ANGLE) sharp = true;
    return { theta, turns, rem, sharp };
  };
  const place = (prev, rem, d) => {
    const dirOut = prev.aIn + d * rem;
    return { x: prev.x + R * Math.cos(dirOut), y: prev.y + R * Math.sin(dirOut), aIn: dirOut + Math.PI };
  };
  const orient = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  const crosses = (a, b, c, d) => orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0;
  // Conflicts of a new segment prev->p against recent tiles (extra = hypothetical tiles appended)
  const conflicts = (prev, p, extra = []) => {
    const all = extra.length ? tiles.concat(extra) : tiles;
    const n = all.length; // index p would get
    let c = 0;
    for (let j = Math.max(0, n - W); j <= n - 3; j++) {
      const q = all[j];
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      if (dx * dx + dy * dy < 0.49) c += 2;
      if (j > 0 && crosses(all[j - 1], q, prev, p)) c += 1;
    }
    return c;
  };

  for (let k = 0; k < beats.length; k++) {
    const prev = tiles[tiles.length - 1];
    const dt = Math.max(1e-4, times[k] - prev.t);
    let twirl = false;
    if (opts.twirl && k >= 1 && dt < prevDt * 0.75) {
      dir = -dir;
      twirl = true;
    }
    const { theta, turns, rem, sharp } = angleFor(dt);
    if (avoid && k >= 2) {
      // Evaluate keeping vs flipping direction, with one tile of lookahead
      const score = (d) => {
        const p = place(prev, rem, d);
        let c = conflicts(prev, p) * 4;
        if (k + 1 < beats.length) {
          const nx = angleFor(times[k + 1] - times[k]);
          const pt = { ...p, t: times[k] };
          c += Math.min(conflicts(pt, place(pt, nx.rem, d), [pt]), conflicts(pt, place(pt, nx.rem, -d), [pt]) + 0.5);
        }
        return c;
      };
      const keep = score(dir);
      if (keep > 0) {
        const flip = score(-dir);
        if (flip < keep) {
          dir = -dir;
          twirl = !twirl;
        }
      }
    }
    const p = place(prev, rem, dir);
    const idx = tiles.length;
    tiles.push({
      i: idx, t: times[k], x: p.x, y: p.y, aIn: p.aIn, dir,
      thetaVis: turns * TAU + rem, thetaReal: theta, rem, turns,
      sharp, longWait: turns >= 1, twirl,
      checkpoint: checkpointEvery > 0 && idx % checkpointEvery === 0,
      pitch: beats[k].pitch, vel: beats[k].vel,
    });
    prevDt = dt;
  }
  return { tiles, dtRef, omega, R };
}

// Mover angle at time t while pivot is tiles[i] heading to tiles[i+1]
export function moverAngle(tiles, i, t) {
  const a = tiles[i];
  const b = tiles[i + 1];
  if (!b) {
    const dt = i > 0 ? a.t - tiles[i - 1].t : 0.5;
    return a.aIn + a.dir * Math.PI * ((t - a.t) / Math.max(dt, 0.05));
  }
  const frac = (t - a.t) / (b.t - a.t);
  return a.aIn + b.dir * b.thetaVis * frac;
}

export function buildChart(notes, opts = {}) {
  const diff = DIFFICULTIES[opts.difficulty || 'normal'];
  const onsets = mergeOnsets(notes);
  const beats = filterOnsets(onsets, diff.minGap);
  const geo = buildGeometry(beats, opts);
  const gaps = [];
  for (let i = 1; i < beats.length; i++) gaps.push(beats[i].time - beats[i - 1].time);
  return {
    ...geo,
    difficulty: opts.difficulty || 'normal',
    onsetCount: onsets.length,
    stats: {
      beats: beats.length,
      minGap: gaps.length ? Math.min(...gaps) : 0,
      medGap: median(gaps),
      maxGap: gaps.length ? Math.max(...gaps) : 0,
      sharp: geo.tiles.filter((t) => t.sharp).length,
      longWait: geo.tiles.filter((t) => t.longWait).length,
      twirls: geo.tiles.filter((t) => t.twirl).length,
    },
  };
}

// Count non-adjacent tile pairs closer than minDist within a sliding window
export function countOverlaps(tiles, window = 24, minDist = 0.45) {
  let n = 0;
  const d2 = minDist * minDist;
  for (let i = 0; i < tiles.length; i++) {
    for (let j = i + 2; j < Math.min(tiles.length, i + window); j++) {
      const dx = tiles[i].x - tiles[j].x;
      const dy = tiles[i].y - tiles[j].y;
      if (dx * dx + dy * dy < d2) n++;
    }
  }
  return n;
}

// Strict readability check: non-adjacent tiles closer than minDist or crossing road segments
export function pathConflicts(tiles, window = 30, minDist = 0.7) {
  const orient = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  const cross = (a, b, c, d) => orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0;
  let near = 0;
  let crossings = 0;
  for (let i = 0; i < tiles.length; i++) {
    for (let j = i + 2; j < Math.min(tiles.length, i + window); j++) {
      if (j >= i + 3 && Math.hypot(tiles[i].x - tiles[j].x, tiles[i].y - tiles[j].y) < minDist) near++;
      if (i > 0 && j > i + 1 && cross(tiles[i - 1], tiles[i], tiles[j - 1], tiles[j])) crossings++;
    }
  }
  return { near, crossings };
}
