// Validates MIDI parsing and chart generation. Usage: node tools/test-chart.mjs [path/to/song.mid]
import { readFileSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import { parseMidi } from '../js/midi.js';
import { buildChart, collectNotes, countOverlaps, pathConflicts, DIFFICULTIES } from '../js/chart.js';

const fmt = (s) => `${(s * 1000).toFixed(1)} ms`;

function checkChart(name, chart) {
  const { tiles, stats } = chart;
  assert.ok(tiles.length > 1, `${name}: tile count must be > 0`);
  for (const t of tiles) {
    for (const k of ['x', 'y', 't', 'aIn', 'thetaVis']) {
      assert.ok(Number.isFinite(t[k]), `${name}: tile ${t.i} has non-finite ${k}`);
    }
  }
  for (let i = 1; i < tiles.length; i++) {
    assert.ok(tiles[i].t > tiles[i - 1].t, `${name}: tile ${i} time not increasing`);
    const d = Math.hypot(tiles[i].x - tiles[i - 1].x, tiles[i].y - tiles[i - 1].y);
    assert.ok(Math.abs(d - 1) < 1e-9, `${name}: tile ${i} length ${d} != R`);
  }
  const ov = countOverlaps(tiles, 24, 0.3);
  const pc = pathConflicts(tiles);
  console.log(
    `  ${name.padEnd(8)} tiles=${String(tiles.length - 1).padStart(5)}  Δt min/med/max = ${fmt(stats.minGap)} / ${fmt(stats.medGap)} / ${fmt(stats.maxGap)}` +
      `  ω=${(chart.omega * 180 / Math.PI).toFixed(0)}°/s  sharp=${stats.sharp} longWait=${stats.longWait} twirls=${stats.twirls} overlaps=${ov} near=${pc.near} crossings=${pc.crossings}`,
  );
  return { ov, ...pc };
}

const midPath = process.argv[2] || new URL('../assets/local/song.mid', import.meta.url).pathname;
if (existsSync(midPath)) {
  const midi = parseMidi(readFileSync(midPath));
  const all = collectNotes(midi, 'all');
  const tempoChanges = Math.max(0, midi.tempoMap.length - 1);
  console.log(`MIDI: ${midPath}`);
  console.log(`  format=${midi.format} ppq=${midi.ppq} tracks=${midi.tracks.length} notes=${all.length} duration=${midi.duration_s.toFixed(2)} s tempoChanges=${tempoChanges}`);
  const bpms = midi.tempoMap.map((s) => s.bpm);
  console.log(`  BPM range ${Math.min(...bpms).toFixed(1)} – ${Math.max(...bpms).toFixed(1)}`);
  midi.tracks.forEach((t, i) => console.log(`  track ${i}: "${t.name}" notes=${t.notes.length}`));
  assert.ok(all.length > 0, 'MIDI has no notes');
  assert.ok(Number.isFinite(midi.duration_s) && midi.duration_s > 0, 'bad duration');
  for (const d of Object.keys(DIFFICULTIES)) checkChart(d, buildChart(all, { difficulty: d }));
  console.log('  without overlap avoidance (pure clockwise, spec geometry):');
  for (const d of Object.keys(DIFFICULTIES)) checkChart(d, buildChart(all, { difficulty: d, avoidOverlap: false }));
  console.log('  tempo twirl=on:');
  checkChart('rush+tw', buildChart(all, { difficulty: 'rush', twirl: true }));
} else {
  console.error(`${midPath} not found — put the song at assets/local/song.mid`);
  process.exit(1);
}

console.log('OK — all assertions passed');
