// App flow: screens, song loading, settings, alignment, calibration and the play loop.
import { AudioEngine, clickScheduler } from './audio.js';
import { parseMidi } from './midi.js';
import { buildChart, collectNotes, countOverlaps, pathConflicts, DIFFICULTIES } from './chart.js';
import { autoAlign, toMono, applyMap, adjustMap, midiOnsets } from './align.js';
import { Game, JUDGE } from './game.js';
import { Renderer, COLORS } from './render.js';
import { DEMO_SONG, demoAsMidi, renderDemo } from './demo.js';
import { load, save, hashBytes } from './storage.js';

const $ = (id) => document.getElementById(id);
const audio = new AudioEngine();
const renderer = new Renderer($('stage'));
const params = new URLSearchParams(location.search);

const settings = {
  difficulty: 'normal', mode: 'normal', speed: 1, checkpoint: 64, twirl: false, avoidOverlap: true, reduceFx: false, inputOffset: 0,
  ...load('settings', {}),
};
const persist = () => save('settings', settings);

const app = {
  screen: 'menu',
  song: null, // { id, title, kind, buffer, midi, align }
  chart: null,
  game: null,
  raf: 0,
  lastT: 0,
  aligning: null,
  frameErrors: 0,
};

// ---------- Screens ----------
function show(name) {
  for (const s of document.querySelectorAll('.screen')) s.classList.remove('active');
  $(`screen-${name}`).classList.add('active');
  if (name === 'pause' || name === 'results') $('screen-game').classList.add('active');
  app.screen = name;
  document.body.classList.toggle('playing', name === 'game');
  $('fullscreen').classList.toggle('hidden', name === 'game');
}

let toastTimer = 0;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function loading(text) {
  $('loading-text').textContent = text;
  show('loading');
}

for (const b of document.querySelectorAll('[data-go]')) {
  b.addEventListener('click', () => {
    stopPreview();
    if (b.dataset.go === 'prep') openPrep();
    else show(b.dataset.go);
  });
}

$('fullscreen').addEventListener('click', () => {
  const el = document.documentElement;
  if (document.fullscreenElement || document.webkitFullscreenElement) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  else (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el);
});

// ---------- Song loading ----------
async function loadDemo() {
  loading('Demo sentezleniyor…');
  audio.ensure();
  const buffer = await renderDemo(audio.ctx.sampleRate);
  app.song = { id: DEMO_SONG.id, title: DEMO_SONG.title, kind: 'demo', buffer, midi: demoAsMidi(), align: null };
  openPrep();
}

async function loadSongBytes(audioBytes, midiBytes, title, kind) {
  loading('Ses çözülüyor…');
  audio.ensure();
  const midi = parseMidi(new Uint8Array(midiBytes));
  if (!midi.tracks.length) throw new Error('MIDI dosyasında nota bulunamadı');
  const buffer = await audio.decode(audioBytes);
  const id = hashBytes(new Uint8Array(midiBytes), `-${audioBytes.byteLength.toString(36)}`);
  app.song = { id, title, kind, buffer, midi, align: load(`align:${id}`, null), mono: null };
  openPrep();
  if (!app.song.align) runAlign();
}

async function loadLocal() {
  loading('Yerel şarkı yükleniyor…');
  const [a, m] = await Promise.all([fetch('assets/local/song.mp3'), fetch('assets/local/song.mid')]);
  if (!a.ok || !m.ok) throw new Error('Yerel dosyalar bulunamadı');
  await loadSongBytes(await a.arrayBuffer(), await m.arrayBuffer(), 'Yerel şarkı', 'local');
}

async function detectLocal() {
  try {
    const opts = { method: 'HEAD', cache: 'no-store' };
    const [a, m] = await Promise.all([fetch('assets/local/song.mp3', opts), fetch('assets/local/song.mid', opts)]);
    if (a.ok && m.ok) $('card-local').classList.remove('hidden');
  } catch {
    // not available (e.g. GitHub Pages) — keep hidden
  }
}

const guard = (fn) => async (...args) => {
  try {
    await fn(...args);
  } catch (err) {
    console.error(err);
    show('menu');
    toast(`Hata: ${err.message || err}`);
  }
};

$('card-demo').addEventListener('click', guard(loadDemo));
$('card-local').addEventListener('click', guard(loadLocal));
$('card-upload').addEventListener('click', () => show('upload'));

// Upload screen
const picked = { audio: null, midi: null };
function setPicked(file) {
  const name = file.name.toLowerCase();
  if (/\.(mid|midi)$/.test(name) || file.type.includes('midi')) picked.midi = file;
  else if (file.type.startsWith('audio/') || /\.(mp3|ogg|wav|m4a|aac|flac)$/.test(name)) picked.audio = file;
  $('f-audio').innerHTML = `Ses: ${picked.audio ? `<b>${escapeHtml(picked.audio.name)}</b>` : '<span class="muted">seçilmedi</span>'}`;
  $('f-midi').innerHTML = `MIDI: ${picked.midi ? `<b>${escapeHtml(picked.midi.name)}</b>` : '<span class="muted">seçilmedi</span>'}`;
  $('upload-go').disabled = !(picked.audio && picked.midi);
}
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
$('file-audio').addEventListener('change', (e) => e.target.files[0] && setPicked(e.target.files[0]));
$('file-midi').addEventListener('change', (e) => e.target.files[0] && setPicked(e.target.files[0]));
const drop = $('drop');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  for (const f of e.dataTransfer.files) setPicked(f);
});
$('upload-go').addEventListener('click', guard(async () => {
  $('upload-error').textContent = '';
  const title = picked.audio.name.replace(/\.[^.]+$/, '');
  await loadSongBytes(await picked.audio.arrayBuffer(), await picked.midi.arrayBuffer(), title, 'upload');
}));

// ---------- Alignment ----------
function songAlignKey() { return `align:${app.song.id}`; }

function firstNoteTime() {
  const all = collectNotes(app.song.midi, 'all');
  return all.length ? all[0].time_s : 0;
}

function effectiveMap() {
  const al = app.song.align;
  if (!al) return null;
  return adjustMap(al.map, (al.fineOffset || 0) / 1000, al.fineScale || 1, firstNoteTime());
}

async function runAlign() {
  const song = app.song;
  if (!song || song.kind === 'demo') return;
  const job = {};
  app.aligning = job;
  renderAlignInfo('Hizalanıyor… %0');
  try {
    if (!song.mono) song.mono = await toMono(song.buffer);
    const notes = collectNotes(song.midi, 'all');
    const res = await autoAlign(song.mono, notes, (p) => {
      if (app.aligning === job) renderAlignInfo(`Hizalanıyor… %${Math.round(p * 100)}`);
    });
    if (app.aligning !== job || app.song !== song) return;
    const b = res.best;
    song.align = {
      method: b.method,
      map: b.map.map((k) => ({ m: +k.m.toFixed(4), a: +k.a.toFixed(4) })),
      hitRate: b.hitRate,
      confidence: b.confidence,
      linear: { offset: res.linear.offset, scale: res.linear.scale, confidence: res.linear.confidence, hitRate: res.linear.hitRate },
      flex: res.flex ? { confidence: res.flex.confidence, hitRate: res.flex.hitRate } : null,
      fineOffset: 0,
      fineScale: 1,
    };
    save(songAlignKey(), song.align);
    console.info('[ORBIT] alignment', song.align.method, song.align);
  } catch (err) {
    console.error(err);
    renderAlignInfo(`Hizalama başarısız: ${err.message}`);
  } finally {
    if (app.aligning === job) app.aligning = null;
  }
  rebuildChart();
  renderAlignInfo();
  if (app.screen === 'align') renderAlignScreen();
}

function alignSummary() {
  const al = app.song.align;
  if (!al) return '';
  const pct = (x) => `%${Math.round(x * 100)}`;
  const lin = al.linear;
  const method = al.method === 'flex' ? 'Esnek (tempo eğrisi)' : 'Doğrusal';
  let html = `Hizalama: <b>${method}</b> · güven <b>${pct(al.confidence)}</b> · eşleşen onset ${pct(al.hitRate)}`;
  if (lin) html += `<br>Doğrusal sonuç: ofset ${(lin.offset * 1000).toFixed(0)} ms, ölçek ${lin.scale.toFixed(4)}, güven ${pct(lin.confidence)}`;
  if (al.method === 'flex') {
    const m0 = firstNoteTime();
    html += `<br>İlk nota: MIDI ${m0.toFixed(2)} s → MP3 ${applyMap(effectiveMap(), m0).toFixed(2)} s`;
    if (lin && lin.confidence < 0.5) html += '<br><span class="muted">MIDI ile kayıt aynı tempoda değil; doğrusal hizalama yetersiz kaldığı için esnek hizalama kullanıldı.</span>';
  }
  if (al.fineOffset || al.fineScale !== 1) html += `<br>Elle ayar: ${al.fineOffset > 0 ? '+' : ''}${al.fineOffset} ms, ölçek ${al.fineScale.toFixed(4)}`;
  if (al.confidence < 0.3) html += '<br><span class="muted">Güven düşük — hizalama ekranından kontrol et.</span>';
  return html;
}

function renderAlignInfo(progress) {
  const el = $('align-info');
  if (!app.song || app.song.kind === 'demo') {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = progress ? `<span class="muted">${progress}</span>` : alignSummary();
}

// ---------- Prepare ----------
function segment(id, value, onChange) {
  const seg = $(id);
  for (const b of seg.querySelectorAll('button')) {
    b.classList.toggle('on', b.dataset.v === String(value));
    b.onclick = () => {
      for (const x of seg.querySelectorAll('button')) x.classList.remove('on');
      b.classList.add('on');
      onChange(b.dataset.v);
    };
  }
}

function trackSel() {
  const v = load(`track:${app.song.id}`, 'all');
  return v === 'all' ? 'all' : Number(v);
}

function songNotes() {
  const song = app.song;
  let notes = collectNotes(song.midi, trackSel());
  const map = song.kind === 'demo' ? null : effectiveMap();
  if (map) {
    notes = notes.map((n) => {
      const a = applyMap(map, n.time_s);
      const b = applyMap(map, n.time_s + n.dur_s);
      return { ...n, time_s: a, dur_s: Math.max(0, b - a) };
    });
  }
  const dur = song.buffer.duration;
  return notes.filter((n) => n.time_s >= 0 && n.time_s < dur);
}

function rebuildChart() {
  if (!app.song) return;
  const notes = songNotes();
  if (!notes.length) {
    app.chart = null;
    $('chart-info').innerHTML = 'Seçili track’te ses süresi içinde nota yok.';
    $('prep-start').disabled = true;
    return;
  }
  app.chart = buildChart(notes, { difficulty: settings.difficulty, twirl: settings.twirl, avoidOverlap: settings.avoidOverlap, checkpointEvery: settings.checkpoint });
  const c = app.chart;
  const dur = c.tiles[c.tiles.length - 1].t - c.tiles[1].t;
  $('chart-info').innerHTML =
    `<b>${c.tiles.length - 1}</b> tile · ${Math.floor(dur / 60)}:${String(Math.round(dur % 60)).padStart(2, '0')} · ` +
    `Δt min/medyan ${(c.stats.minGap * 1000).toFixed(0)} / ${(c.stats.medGap * 1000).toFixed(0)} ms · ` +
    `keskin dönüş ${c.stats.sharp} · uzun bekleme ${c.stats.longWait} · twirl ${c.stats.twirls}`;
  $('prep-start').disabled = !!app.aligning && app.song.kind !== 'demo';
}

function openPrep() {
  const song = app.song;
  show('prep');
  $('prep-title').textContent = song.title;
  $('prep-sub').textContent = song.kind === 'demo'
    ? 'Telifsiz demo · Web Audio ile sentezlendi'
    : `${song.midi.tracks.length} track · ses ${song.buffer.duration.toFixed(1)} s · MIDI ${song.midi.duration_s.toFixed(1)} s`;
  segment('seg-diff', settings.difficulty, (v) => { settings.difficulty = v; persist(); rebuildChart(); });
  segment('seg-mode', settings.mode, (v) => { settings.mode = v; persist(); syncSpeed(); });
  segment('seg-speed', settings.speed, (v) => { settings.speed = Number(v); persist(); });
  const syncSpeed = () => $('field-speed').classList.toggle('hidden', settings.mode !== 'practice');
  syncSpeed();
  const sel = $('sel-track');
  sel.innerHTML = '';
  const all = collectNotes(song.midi, 'all').length;
  sel.add(new Option(`Tümü (${all} nota)`, 'all'));
  song.midi.tracks.forEach((t, i) => sel.add(new Option(`${t.name} (${t.notes.length} nota)`, String(i))));
  sel.value = String(trackSel());
  sel.onchange = () => { save(`track:${song.id}`, sel.value); rebuildChart(); };
  $('field-track').classList.toggle('hidden', song.midi.tracks.length < 2);
  const cp = $('sel-cp');
  cp.value = String(settings.checkpoint);
  cp.onchange = () => { settings.checkpoint = Number(cp.value); persist(); rebuildChart(); };
  const tw = $('chk-twirl');
  tw.checked = settings.twirl;
  tw.onchange = () => { settings.twirl = tw.checked; persist(); rebuildChart(); };
  const av = $('chk-avoid');
  av.checked = settings.avoidOverlap;
  av.onchange = () => { settings.avoidOverlap = av.checked; persist(); rebuildChart(); };
  const fx = $('chk-fx');
  fx.checked = settings.reduceFx;
  fx.onchange = () => { settings.reduceFx = fx.checked; persist(); };
  $('prep-align').classList.toggle('hidden', song.kind === 'demo');
  rebuildChart();
  renderAlignInfo(app.aligning ? 'Hizalanıyor…' : undefined);
}

$('prep-start').addEventListener('click', () => startGame());
$('prep-align').addEventListener('click', () => { show('align'); renderAlignScreen(); });
$('prep-calib').addEventListener('click', () => openCalib('prep'));
$('menu-calib').addEventListener('click', () => openCalib('menu'));

// ---------- Align screen ----------
let preview = null;

function renderAlignScreen() {
  const al = app.song.align;
  $('align-result').innerHTML = app.aligning ? '<span class="muted">Hizalanıyor…</span>' : (alignSummary() || 'Hizalama yok.');
  const off = $('rng-offset');
  const sc = $('rng-scale');
  const pp = $('rng-ppos');
  off.value = al ? al.fineOffset : 0;
  sc.value = al ? al.fineScale : 1;
  pp.max = Math.floor(app.song.buffer.duration);
  if (!Number(pp.value) && al) pp.value = Math.max(0, Math.floor(applyMap(effectiveMap(), firstNoteTime()) - 1));
  updateAlignLabels();
}

function updateAlignLabels() {
  const o = Number($('rng-offset').value);
  $('v-offset').textContent = `${o > 0 ? '+' : ''}${o} ms`;
  $('v-scale').textContent = Number($('rng-scale').value).toFixed(4);
  $('v-ppos').textContent = `${$('rng-ppos').value} s`;
}

function setFine(offset, scale) {
  const al = app.song.align;
  if (!al) return;
  al.fineOffset = Math.max(-500, Math.min(500, Math.round(offset)));
  al.fineScale = Math.max(0.97, Math.min(1.03, scale));
  $('rng-offset').value = al.fineOffset;
  $('rng-scale').value = al.fineScale;
  updateAlignLabels();
  $('align-result').innerHTML = alignSummary();
  refreshPreviewTimes();
}

$('rng-offset').addEventListener('input', (e) => setFine(Number(e.target.value), app.song.align?.fineScale ?? 1));
$('rng-scale').addEventListener('input', (e) => setFine(app.song.align?.fineOffset ?? 0, Number(e.target.value)));
$('rng-ppos').addEventListener('input', updateAlignLabels);
$('align-reset').addEventListener('click', () => setFine(0, 1));
$('align-rerun').addEventListener('click', () => { stopPreview(); app.song.align = null; runAlign(); renderAlignScreen(); });
$('align-save').addEventListener('click', () => {
  if (app.song.align) save(songAlignKey(), app.song.align);
  stopPreview();
  toast('Hizalama kaydedildi');
  openPrep();
});

function previewTimes() {
  const map = effectiveMap();
  if (!map) return [];
  return midiOnsets(collectNotes(app.song.midi, trackSel())).map((o) => applyMap(map, o.t));
}

function refreshPreviewTimes() {
  if (!preview) return;
  preview.times = previewTimes();
  preview.sched.reset(audio.songTime() + 0.3);
}

function stopPreview() {
  if (!preview) return;
  preview.sched.stop();
  audio.stop();
  preview = null;
  $('align-preview').textContent = '▶ Tık sesiyle önizle';
}

$('align-preview').addEventListener('click', () => {
  if (preview) return stopPreview();
  if (!app.song.align) return;
  const from = Number($('rng-ppos').value);
  audio.play(app.song.buffer, { songFrom: from, volume: 0.7 });
  preview = { times: previewTimes() };
  preview.sched = clickScheduler(audio, () => preview.times, { freq: 2200, gain: 0.2 });
  preview.sched.start(from);
  $('align-preview').textContent = '■ Durdur';
});

// ---------- Calibration ----------
const calib = { back: 'menu', running: false, taps: [], beats: [], result: null };

function openCalib(back) {
  calib.back = back;
  calib.result = null;
  $('calib-save').disabled = true;
  $('calib-value').textContent = '—';
  $('calib-status').textContent = `Mevcut gecikme: ${Math.round(settings.inputOffset * 1000)} ms`;
  const dots = $('calib-beats');
  dots.innerHTML = '';
  for (let i = 0; i < 20; i++) {
    const d = document.createElement('i');
    if (i < 4) d.className = 'lead';
    dots.appendChild(d);
  }
  show('calib');
}

$('calib-back').addEventListener('click', () => {
  calib.running = false;
  if (calib.back === 'prep' && app.song) openPrep();
  else show('menu');
});

$('calib-start').addEventListener('click', (e) => {
  e.stopPropagation();
  const ctx = audio.ensure();
  const period = 0.6;
  const t0 = ctx.currentTime + 0.4;
  calib.beats = [];
  calib.taps = [];
  for (let i = 0; i < 20; i++) {
    const t = t0 + i * period;
    calib.beats.push(t);
    audio.click(t, { freq: i < 4 ? 1760 : 1100, gain: 0.35, dur: 0.05 });
  }
  calib.running = true;
  $('calib-status').textContent = 'Dinle… sonra mavi noktalardan sonra bas';
  const dots = [...$('calib-beats').children];
  dots.forEach((d) => d.classList.remove('on'));
  const tick = () => {
    if (!calib.running) return;
    const now = audio.heardAt();
    dots.forEach((d, i) => d.classList.toggle('on', now >= calib.beats[i]));
    if (now > calib.beats[19] + 0.6) {
      calib.running = false;
      finishCalib();
      return;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

function calibTap(perf) {
  const t = audio.heardAt(perf);
  let best = null;
  for (let i = 4; i < 20; i++) {
    const d = t - calib.beats[i];
    if (Math.abs(d) < 0.3 && (best === null || Math.abs(d) < Math.abs(best))) best = d;
  }
  if (best !== null) calib.taps.push(best);
  $('calib-value').textContent = best === null ? '—' : `${best > 0 ? '+' : ''}${Math.round(best * 1000)} ms`;
}

function finishCalib() {
  const taps = calib.taps.slice().sort((a, b) => a - b);
  if (taps.length < 6) {
    $('calib-status').textContent = `Yeterli vuruş yok (${taps.length}/16). Tekrar dene.`;
    return;
  }
  const med = taps[taps.length >> 1];
  const kept = taps.filter((x) => Math.abs(x - med) < 0.08);
  const mean = kept.reduce((a, b) => a + b, 0) / kept.length;
  calib.result = mean;
  $('calib-value').textContent = `${mean > 0 ? '+' : ''}${Math.round(mean * 1000)} ms`;
  $('calib-status').textContent = `${kept.length} vuruş ortalaması · ${mean > 0 ? 'geç' : 'erken'} basıyorsun. Kaydet ile uygula.`;
  $('calib-save').disabled = false;
}

$('calib-save').addEventListener('click', (e) => {
  e.stopPropagation();
  if (calib.result === null) return;
  settings.inputOffset = calib.result;
  persist();
  $('calib-status').textContent = `Kaydedildi: ${Math.round(settings.inputOffset * 1000)} ms`;
  $('calib-save').disabled = true;
});
$('calib-zero').addEventListener('click', (e) => {
  e.stopPropagation();
  settings.inputOffset = 0;
  persist();
  $('calib-status').textContent = 'Mevcut gecikme: 0 ms';
});

// ---------- Game ----------
function onGameEvent(ev) {
  const g = app.game;
  if (ev.type === 'judge') {
    const tile = g.tiles[ev.tile];
    if (ev.kind === 'perfect') renderer.burst(tile, ev.tile % 2 === 0 ? COLORS.fire : COLORS.ice);
    showJudge(ev.kind, ev.diff);
  } else if (ev.type === 'death') {
    showJudge('miss', null);
    $('hud-center').textContent = 'Kaçırdın';
  } else if (ev.type === 'start') {
    renderer.snapCamera(g);
    $('hud-center').textContent = '';
  } else if (ev.type === 'checkpoint') {
    // silent; the diamond marker shows it
  } else if (ev.type === 'done') {
    finishGame();
  }
}

let judgeTimer = 0;
function showJudge(kind, diff) {
  const el = $('hud-judge');
  const label = $('hud-label');
  label.className = `j-${kind}`;
  label.textContent = JUDGE[kind].label;
  $('hud-ms').textContent = diff === null || kind === 'miss' ? '' : `${diff > 0 ? '+' : diff < 0 ? '−' : '±'}${Math.abs(Math.round(diff * 1000))} ms`;
  el.classList.add('show');
  clearTimeout(judgeTimer);
  judgeTimer = setTimeout(() => el.classList.remove('show'), 600);
}

function startGame() {
  if (!app.chart) return;
  audio.ensure();
  stopPreview();
  if (app.game) app.game.stop();
  renderer.reduceEffects = settings.reduceFx;
  app.game = new Game({
    chart: app.chart,
    audio,
    buffer: app.song.buffer,
    mode: settings.mode,
    rate: settings.speed,
    inputOffset: settings.inputOffset,
    onEvent: onGameEvent,
  });
  app.frameErrors = 0;
  const modeLabel = { normal: 'Normal', practice: `Pratik · %${Math.round(settings.speed * 100)}`, auto: 'Otomatik' }[settings.mode];
  $('hud-mode').textContent = `${DIFFICULTIES[settings.difficulty].label} · ${modeLabel}`;
  show('game');
  renderer.resize();
  app.game.restart();
  cancelAnimationFrame(app.raf);
  app.raf = requestAnimationFrame(frame);
}

let hudCache = {};
function setText(id, v) {
  if (hudCache[id] !== v) {
    hudCache[id] = v;
    $(id).textContent = v;
  }
}

function frame(perf) {
  const g = app.game;
  if (!g) return;
  const t = audio.playing ? audio.songTime(perf) : app.lastT;
  app.lastT = t;
  if (!Number.isFinite(t)) app.frameErrors++;
  try {
    g.update(t);
    renderer.draw(g, t, perf);
  } catch (err) {
    app.frameErrors++;
    if (app.frameErrors < 5) console.error(err);
  }
  // HUD
  $('hud-progress').style.width = `${(g.progress() * 100).toFixed(2)}%`;
  setText('hud-acc', `${g.accuracy().toFixed(2)}%`);
  setText('hud-combo', String(g.combo));
  if (g.state === 'playing') {
    const left = (g.countdownEnd - t) / g.beat;
    let c = '';
    if (left > 0 && g.countdownShow) c = g.cur === 0 ? (left <= 3.2 ? String(Math.ceil(left)) : '') : 'Hazır';
    setText('hud-center', c);
  }
  app.raf = requestAnimationFrame(frame);
}

function pauseGame() {
  const g = app.game;
  if (!g || g.state !== 'playing') return;
  g.pause();
  show('pause');
}

$('hud-pause').addEventListener('click', (e) => { e.stopPropagation(); pauseGame(); });
$('hud-pause').addEventListener('touchstart', (e) => { e.stopPropagation(); }, { passive: true });
$('pause-resume').addEventListener('click', () => { show('game'); app.game.resume(); });
$('pause-restart').addEventListener('click', () => { show('game'); app.game.restart(); });
$('pause-menu').addEventListener('click', () => quitGame('menu'));

function quitGame(to) {
  cancelAnimationFrame(app.raf);
  if (app.game) app.game.stop();
  app.game = null;
  hudCache = {};
  if (to === 'prep') openPrep();
  else show('menu');
}

function finishGame() {
  const g = app.game;
  const s = g.stats;
  const acc = g.accuracy();
  const mean = s.nDiff ? (s.sumDiff / s.nDiff) * 1000 : 0;
  const key = `best:${app.song.id}:${settings.difficulty}:${settings.mode}${settings.mode === 'practice' ? `:${settings.speed}` : ''}`;
  const prev = load(key, null);
  let bestText = '';
  if (settings.mode !== 'auto') {
    if (prev === null || acc > prev) {
      save(key, acc);
      bestText = prev === null ? 'İlk skor kaydedildi' : `Yeni rekor! (önceki ${prev.toFixed(2)}%)`;
    } else bestText = `En iyi: ${prev.toFixed(2)}%`;
  } else bestText = 'Otomatik mod — skor kaydedilmez';
  $('res-kicker').textContent = `${app.song.title} · ${DIFFICULTIES[settings.difficulty].label}`;
  $('res-title').textContent = 'Tamamlandı';
  $('res-acc').textContent = `${acc.toFixed(2)}%`;
  $('res-best').textContent = bestText;
  const cells = [
    ['Perfect', s.perfect], ['Early', s.early], ['Late', s.late],
    ['Too Early', s.tooEarly], ['Too Late', s.tooLate], ['Miss', s.miss],
    ['Maks combo', s.maxCombo], ['Ort. sapma', `${mean > 0 ? '+' : ''}${mean.toFixed(1)} ms`], ['Ölüm', s.deaths],
  ];
  $('res-grid').innerHTML = cells.map(([k, v]) => `<div><b>${v}</b>${k}</div>`).join('');
  let comment = 'Zamanlaman dengeli.';
  if (s.nDiff >= 5 && mean < -12) comment = `Ortalamada ${Math.abs(mean).toFixed(0)} ms erken basıyorsun.`;
  if (s.nDiff >= 5 && mean > 12) comment = `Ortalamada ${mean.toFixed(0)} ms geç basıyorsun.`;
  if (Math.abs(mean) > 25) comment += ' Kalibrasyonu denemek isteyebilirsin.';
  $('res-comment').textContent = comment;
  show('results');
  if (testHook) testHook.results.push({ difficulty: settings.difficulty, mode: settings.mode, tiles: g.tiles.length - 1, acc, stats: { ...s }, frameErrors: app.frameErrors + renderer.errors });
}

$('res-retry').addEventListener('click', () => startGame());
$('res-prep').addEventListener('click', () => quitGame('prep'));
$('res-menu').addEventListener('click', () => quitGame('menu'));

// ---------- Input ----------
function validStamp(ts) {
  const now = performance.now();
  return ts > 0 && ts <= now + 5 && now - ts < 1000 ? ts : now;
}

window.addEventListener('keydown', (e) => {
  if (app.screen === 'game') {
    if (e.key === 'Escape') {
      e.preventDefault();
      pauseGame();
      return;
    }
    if (e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    if (e.repeat) return;
    app.game?.press(validStamp(e.timeStamp));
    return;
  }
  if (app.screen === 'pause' && e.key === 'Escape') {
    show('game');
    app.game.resume();
    return;
  }
  if (app.screen === 'calib' && calib.running && !e.repeat && e.key !== 'Escape') {
    e.preventDefault();
    calibTap(validStamp(e.timeStamp));
    return;
  }
  if (app.screen === 'align' && app.song?.align && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
    e.preventDefault();
    const al = app.song.align;
    const step = e.shiftKey ? 10 : 1;
    if (e.key === 'ArrowLeft') setFine(al.fineOffset - step, al.fineScale);
    if (e.key === 'ArrowRight') setFine(al.fineOffset + step, al.fineScale);
    if (e.key === 'ArrowUp') setFine(al.fineOffset, al.fineScale + 0.0025);
    if (e.key === 'ArrowDown') setFine(al.fineOffset, al.fineScale - 0.0025);
  }
});

const stage = $('screen-game');
const pressFromPointer = (ts) => {
  if (app.screen === 'game') app.game?.press(validStamp(ts));
  else if (app.screen === 'calib' && calib.running) calibTap(validStamp(ts));
};
window.addEventListener('touchstart', (e) => {
  if (app.screen !== 'game' && !(app.screen === 'calib' && calib.running)) return;
  if (e.target.closest('button')) return;
  e.preventDefault();
  for (let i = 0; i < e.changedTouches.length; i++) pressFromPointer(e.timeStamp);
}, { passive: false });
window.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || e.target.closest('button')) return;
  if (app.screen === 'game' || (app.screen === 'calib' && calib.running)) pressFromPointer(e.timeStamp);
});
stage.addEventListener('contextmenu', (e) => e.preventDefault());

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (app.screen === 'game') pauseGame();
    stopPreview();
  }
});

// ---------- Test hook (only with ?test) ----------
const testHook = params.has('test') ? { results: [] } : null;
if (testHook) {
  Object.assign(testHook, {
    app, settings, renderer, audio,
    loadDemo: guard(loadDemo),
    loadLocal: guard(loadLocal),
    start: (opts = {}) => { Object.assign(settings, opts); rebuildChart(); startGame(); },
    overlaps: () => (app.chart ? { overlaps: countOverlaps(app.chart.tiles, 24, 0.3), ...pathConflicts(app.chart.tiles), stats: app.chart.stats, tiles: app.chart.tiles.length - 1 } : null),
    snapshot: () => {
      const g = app.game;
      return g && { state: g.state, cur: g.cur, last: g.lastTile, acc: g.accuracy(), stats: { ...g.stats }, frameErrors: app.frameErrors + renderer.errors, drawn: renderer.drawnTiles };
    },
  });
  // eslint-disable-next-line no-underscore-dangle
  window.__orbit = testHook;
}

detectLocal();
