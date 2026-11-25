// Canvas 2D renderer: camera, culled tile drawing, planets and light effects.

const COLORS = {
  bg: '#26281d',
  cream: '#cfc9ac',
  light: '#f8f8f8',
  fire: '#ff6a3d',
  fireGlow: 'rgba(255,106,61,',
  ice: '#58b4ff',
  iceGlow: 'rgba(88,180,255,',
  sharp: '#ffb25c',
  long: '#9d8cff',
  miss: '#ff4d4d',
};

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cam = { x: 0, y: 0, zoom: 1 };
    this.particles = [];
    this.reduceEffects = false;
    this.reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    this.lastFrame = 0;
    this.errors = 0;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.w = w;
    this.h = h;
    this.dpr = dpr;
  }

  snapCamera(game) {
    const p = game.tiles[game.cur];
    this.cam.x = p.x;
    this.cam.y = p.y;
    this.cam.zoom = 1;
    this.particles.length = 0;
  }

  burst(tile, color) {
    if (this.reduceEffects) return;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2 + Math.random() * 0.4;
      const sp = 0.9 + Math.random() * 0.6;
      this.particles.push({ x: tile.x, y: tile.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.45, max: 0.45, color });
    }
  }

  // Tiles to consider for drawing: a short past window + a time/count-limited future window
  visibleRange(game, t) {
    const tiles = game.tiles;
    const lo = Math.max(0, game.cur - 6);
    let hi = Math.min(game.cur + 1, tiles.length - 1);
    const horizon = t + 2.2 * game.rate;
    while (hi < tiles.length - 1 && (hi - game.cur < 8 || tiles[hi + 1].t < horizon) && hi - game.cur < 90) hi++;
    return [lo, hi];
  }

  draw(game, t, perfNow) {
    const ctx = this.ctx;
    const dt = Math.min(0.1, Math.max(0, (perfNow - (this.lastFrame || perfNow)) / 1000));
    this.lastFrame = perfNow;
    const tiles = game.tiles;
    const [lo, hi] = this.visibleRange(game, t);

    // Camera: follow pivot, look slightly ahead, zoom out in dense passages
    const pivot = tiles[game.cur];
    let ax = 0;
    let ay = 0;
    let n = 0;
    for (let i = game.cur; i <= Math.min(hi, game.cur + 4); i++) {
      ax += tiles[i].x;
      ay += tiles[i].y;
      n++;
    }
    const tx = pivot.x * 0.55 + (ax / n) * 0.45;
    const ty = pivot.y * 0.55 + (ay / n) * 0.45;
    const ahead = tiles[Math.min(tiles.length - 1, game.cur + 8)].t - pivot.t;
    const density = ahead > 0 ? 8 / (ahead / game.rate) : 0; // tiles per second
    const tz = 1 / (1 + Math.min(0.45, Math.max(0, density - 3) * 0.05));
    const k = 1 - Math.exp(-dt * (this.reduceMotion ? 14 : 6));
    this.cam.x += (tx - this.cam.x) * k;
    this.cam.y += (ty - this.cam.y) * k;
    this.cam.zoom += (tz - this.cam.zoom) * (1 - Math.exp(-dt * 2));

    const unit = (Math.min(this.w, this.h) / 6.2) * this.cam.zoom;
    const cx = this.w / 2;
    const cy = this.h / 2;
    const sx = (x) => cx + (x - this.cam.x) * unit;
    const sy = (y) => cy - (y - this.cam.y) * unit;
    const margin = unit * 0.8;
    const onScreen = (x, y) => {
      const X = sx(x);
      const Y = sy(y);
      return X > -margin && X < this.w + margin && Y > -margin && Y < this.h + margin;
    };

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const alphaFor = (i) => {
      if (i <= game.cur) return Math.max(0, 0.32 * (1 - (game.cur - i) / 6));
      const d = i - game.cur;
      const dtA = (tiles[i].t - t) / game.rate;
      const byTime = dtA < 1.6 ? 1 : Math.max(0.2, 1 - (dtA - 1.6) / 0.8);
      return d <= 10 ? 1 : Math.max(0.2, byTime * (1 - (d - 10) / 100));
    };

    // Draw far-future first, then nearer, so the next tiles are always on top; past tiles underneath
    const order = [];
    for (let i = lo; i <= game.cur; i++) order.push(i);
    for (let i = hi; i > game.cur; i--) order.push(i);
    let drawn = 0;
    for (const i of order) {
      const tile = tiles[i];
      const prev = tiles[i - 1];
      const visible = onScreen(tile.x, tile.y) || (prev && onScreen(prev.x, prev.y));
      if (!visible) continue;
      const a = alphaFor(i);
      if (a <= 0.01) continue;
      drawn++;
      ctx.globalAlpha = a;
      // Road segment from previous tile
      if (prev && i > lo) {
        ctx.strokeStyle = tile.longWait ? 'rgba(157,140,255,0.55)' : 'rgba(207,201,172,0.30)';
        ctx.lineWidth = unit * 0.30;
        ctx.beginPath();
        ctx.moveTo(sx(prev.x), sy(prev.y));
        ctx.lineTo(sx(tile.x), sy(tile.y));
        ctx.stroke();
      }
      // Angle arc at this tile: from incoming direction to the next tile direction
      const next = tiles[i + 1];
      if (next && i >= game.cur && i < hi) {
        const r = unit * 0.36;
        const start = -tile.aIn; // screen y is flipped
        const sweep = next.rem * next.dir;
        ctx.strokeStyle = next.sharp ? COLORS.sharp : 'rgba(248,248,248,0.55)';
        ctx.lineWidth = Math.max(1.2, unit * (next.sharp ? 0.05 : 0.03));
        ctx.beginPath();
        ctx.arc(sx(tile.x), sy(tile.y), r, start, start - sweep, sweep > 0);
        ctx.stroke();
      }
      // Tile pad
      const hitT = game.hitTimes[i];
      const glow = hitT > -1e8 && t >= hitT ? Math.min(1, Math.max(0, 1 - (t - hitT) / (0.35 * game.rate))) : 0;
      const kind = game.hitKinds[i];
      let fill = 'rgba(207,201,172,0.92)';
      if (tile.longWait) fill = 'rgba(157,140,255,0.92)';
      if (kind === 'miss') fill = COLORS.miss;
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.arc(sx(tile.x), sy(tile.y), unit * 0.17, 0, Math.PI * 2);
      ctx.fill();
      if (glow > 0 && !this.reduceEffects) {
        ctx.globalAlpha = a * glow * 0.7;
        ctx.fillStyle = COLORS.light;
        ctx.beginPath();
        ctx.arc(sx(tile.x), sy(tile.y), unit * (0.2 + 0.08 * (1 - glow)), 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = a;
      }
      if (tile.checkpoint) {
        ctx.strokeStyle = COLORS.light;
        ctx.lineWidth = 1.5;
        const s = unit * 0.1;
        ctx.beginPath();
        ctx.moveTo(sx(tile.x), sy(tile.y) - s);
        ctx.lineTo(sx(tile.x) + s, sy(tile.y));
        ctx.lineTo(sx(tile.x), sy(tile.y) + s);
        ctx.lineTo(sx(tile.x) - s, sy(tile.y));
        ctx.closePath();
        ctx.stroke();
      }
      if (tile.turns >= 1 && i > game.cur) {
        ctx.fillStyle = COLORS.bg;
        ctx.font = `600 ${Math.max(9, unit * 0.13)}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${tile.turns + 1}×`, sx(tile.x), sy(tile.y));
      }
      if (tile.twirl && i > game.cur) {
        ctx.strokeStyle = COLORS.bg;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(sx(tile.x), sy(tile.y), unit * 0.08, 0, Math.PI * 1.5);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    this.drawnTiles = drawn;

    // Planets
    const ang = game.moverAngle(t);
    const mx = pivot.x + Math.cos(ang);
    const my = pivot.y + Math.sin(ang);
    if (!Number.isFinite(mx) || !Number.isFinite(my)) this.errors++;
    const pivotIsFire = game.cur % 2 === 0;
    const pivotColor = pivotIsFire ? COLORS.fire : COLORS.ice;
    const moverColor = pivotIsFire ? COLORS.ice : COLORS.fire;
    const moverGlow = pivotIsFire ? COLORS.iceGlow : COLORS.fireGlow;

    // Faint orbit ring
    ctx.strokeStyle = 'rgba(248,248,248,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(sx(pivot.x), sy(pivot.y), unit, 0, Math.PI * 2);
    ctx.stroke();

    if (!this.reduceEffects) {
      // Trail behind the mover
      const next = tiles[game.cur + 1];
      const dir = next ? next.dir : -1;
      for (let s = 1; s <= 6; s++) {
        const a2 = ang - dir * s * 0.09;
        ctx.fillStyle = `${moverGlow}${(0.28 * (1 - s / 7)).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(sx(pivot.x + Math.cos(a2)), sy(pivot.y + Math.sin(a2)), unit * 0.15 * (1 - s / 10), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    const planet = (x, y, color) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(sx(x), sy(y), unit * 0.16, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.beginPath();
      ctx.arc(sx(x) - unit * 0.05, sy(y) - unit * 0.05, unit * 0.05, 0, Math.PI * 2);
      ctx.fill();
    };
    planet(pivot.x, pivot.y, pivotColor);
    planet(mx, my, moverColor);

    // Particles
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.particles.splice(i, 1);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      ctx.globalAlpha = p.life / p.max;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(sx(p.x), sy(p.y), Math.max(1.2, unit * 0.025), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}

export { COLORS };
