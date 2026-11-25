// Runs auto-alignment in Node (needs ffmpeg). Usage: node tools/test-align.mjs [mp3] [mid]
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parseMidi } from '../js/midi.js';
import { collectNotes } from '../js/chart.js';
import { autoAlign, applyMap, ALIGN_SR } from '../js/align.js';

const mp3 = process.argv[2] || 'assets/local/song.mp3';
const mid = process.argv[3] || 'assets/local/song.mid';
const pcm = execFileSync('ffmpeg', ['-v', 'quiet', '-i', mp3, '-ac', '1', '-ar', String(ALIGN_SR), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
const mono = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 4);
const notes = collectNotes(parseMidi(readFileSync(mid)), 'all');
const t0 = Date.now();
const r = await autoAlign(mono, notes);
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const show = (x) => x && console.log(
  `${x.method.padEnd(6)} hit=${pct(x.hitRate)} chance=${pct(x.chance)} coverage=${pct(x.coverage)} confidence=${pct(x.confidence)}` +
  (x.method === 'linear' ? ` offset=${(x.offset * 1000).toFixed(1)} ms scale=${x.scale.toFixed(4)} z=${x.z.toFixed(2)}` : ` anchors=${x.map.length}`),
);
console.log(`audio ${(mono.length / ALIGN_SR).toFixed(1)} s, total ${Date.now() - t0} ms`);
show(r.linear);
show(r.flex);
console.log(`chosen: ${r.best.method}`);
const m = r.best.map;
for (const t of [notes[0].time_s, 30, 60, 100, 150, 200, 250, 290]) {
  const a = applyMap(m, t);
  const sl = (applyMap(m, t + 1) - applyMap(m, t - 1)) / 2;
  console.log(`  midi ${t.toFixed(1).padStart(6)} s -> audio ${a.toFixed(2).padStart(7)} s  (local scale ${sl.toFixed(3)})`);
}
