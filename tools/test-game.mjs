// Simulates the game loop with a fake audio clock. Usage: node tools/test-game.mjs
import { readFileSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import { Game, judge } from '../js/game.js';
import { buildChart, collectNotes, DIFFICULTIES } from '../js/chart.js';
import { parseMidi } from '../js/midi.js';
import { DEMO_SONG } from '../js/demo.js';

globalThis.performance ??= { now: () => Date.now() };

function fakeAudio() {
  return {
    t: 0, playing: null,
    play(_b, { songFrom = 0, rate = 1 }) { this.playing = { songFrom, rate }; this.t = songFrom; },
    stop() { this.playing = null; },
    songTime() { return this.t; },
  };
}

// Judge window checks
assert.equal(judge(0), 'perfect');
assert.equal(judge(0.045), 'perfect');
assert.equal(judge(-0.06), 'early');
assert.equal(judge(0.08), 'late');
assert.equal(judge(-0.12), 'tooEarly');
assert.equal(judge(0.13), 'tooLate');
assert.equal(judge(-0.15), null);
assert.equal(judge(0.15), 'miss');

function run(name, chart, mode, pressFn, rate = 1) {
  const audio = fakeAudio();
  let done = false;
  const g = new Game({ chart, audio, buffer: null, mode, rate, onEvent: (e) => { if (e.type === 'done') done = true; } });
  g.restart();
  const step = 1 / 240;
  const end = chart.tiles[chart.tiles.length - 1].t + 3;
  let nextPress = 1;
  const angles = [];
  while (audio.t < end && !done) {
    audio.t += step * g.rate;
    if (pressFn) {
      while (nextPress < chart.tiles.length) {
        const at = pressFn(chart.tiles[nextPress].t, nextPress, g.rate);
        if (at > audio.t) break;
        audio.t = Math.max(audio.t - step * g.rate, at);
        g.press(0);
        nextPress++;
      }
    }
    g.update(audio.t);
    if (g.state === 'playing') {
      const a = g.moverAngle(audio.t);
      if (!Number.isFinite(a)) angles.push(audio.t);
    }
  }
  const s = g.stats;
  console.log(`  ${name.padEnd(22)} done=${done} acc=${g.accuracy().toFixed(2)}% P/E/L/TE/TL/M=${s.perfect}/${s.early}/${s.late}/${s.tooEarly}/${s.tooLate}/${s.miss} nanAngles=${angles.length}`);
  assert.equal(angles.length, 0, `${name}: NaN mover angle`);
  return { g, done };
}

const songs = [['demo', DEMO_SONG.notes]];
const mid = new URL('../assets/local/song.mid', import.meta.url).pathname;
if (existsSync(mid)) songs.push(['local(raw midi time)', collectNotes(parseMidi(readFileSync(mid)), 'all')]);

for (const [label, notes] of songs) {
  console.log(label);
  for (const d of Object.keys(DIFFICULTIES)) {
    const chart = buildChart(notes, { difficulty: d });
    const { g, done } = run(`auto ${d}`, chart, 'auto');
    assert.ok(done, 'auto run must finish');
    assert.equal(g.stats.perfect, chart.tiles.length - 1, 'bot must be 100% perfect');
    assert.equal(g.accuracy(), 100);
  }
  const chart = buildChart(notes, { difficulty: 'normal' });
  // Human-ish player: +30 ms late on every tile -> all perfect
  const r1 = run('practice +30ms', chart, 'practice', (t) => t + 0.03);
  assert.equal(r1.g.stats.perfect, chart.tiles.length - 1);
  // Player 70 ms late -> all Late
  const r2 = run('practice +70ms', chart, 'practice', (t) => t + 0.07);
  assert.equal(r2.g.stats.late, chart.tiles.length - 1);
  // Half speed practice: real-time offset of +30 ms => song offset 15 ms -> still perfect
  const r3 = run('practice 50% +60ms real', chart, 'practice', (t) => t + 0.06 * 0.5, 0.5);
  assert.equal(r3.g.stats.late, chart.tiles.length - 1);
  // No input in practice -> all misses, still completes
  const r4 = run('practice no input', chart, 'practice', null);
  assert.equal(r4.g.stats.miss, chart.tiles.length - 1);
  assert.ok(r4.done);
}
console.log('OK — game simulation passed');
