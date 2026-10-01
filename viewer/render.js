// Canvas renderer: arena, tanks, effects, HUD and show screens. Logical frame 1920x1080.
import { ARENA, TANK_RADIUS, ROUND_SECONDS, ZONE, KIT, MAPS, STAT_KEYS, deriveStats } from '/kit/arena/engine.js';

export const VIEW_W = 1920;
export const VIEW_H = 1080;
const OX = 160;
const OY = 170;
const HEAD = '"Russo One", "Arial Black", sans-serif';
const BODY = '"Inter", "Segoe UI", sans-serif';
const STAT_LABELS = { armor: 'БРОНЯ', engine: 'ДВИГАТЕЛЬ', gun: 'ОРУДИЕ', reload: 'ПЕРЕЗАРЯДКА' };

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;
const lerpAngle = (a, b, t) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;
const easeOut = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const rgba = (hex, a) => {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
};

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export function drawTankSprite(ctx, c, x, y, heading, turret, size, opts = {}) {
  ctx.save();
  ctx.translate(x, y);
  if (opts.shadow !== false) {
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.filter = `blur(${size * 0.08}px)`;
    ctx.beginPath();
    ctx.ellipse(size * 0.06, size * 0.1, size * 0.42, size * 0.36, heading, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  const filter = opts.dead ? 'grayscale(1) brightness(0.3)' : opts.flash > 0 ? `brightness(${1 + opts.flash * 2.5})` : 'none';
  ctx.filter = filter;
  ctx.save();
  ctx.rotate(heading);
  if (c.art?.body) ctx.drawImage(c.art.body, -size / 2, -size / 2, size, size);
  else {
    ctx.fillStyle = '#222';
    ctx.fillRect(-size * 0.4, -size * 0.36, size * 0.8, size * 0.16);
    ctx.fillRect(-size * 0.4, size * 0.2, size * 0.8, size * 0.16);
    ctx.fillStyle = c.color;
    ctx.fillRect(-size * 0.36, -size * 0.24, size * 0.72, size * 0.48);
  }
  ctx.restore();
  ctx.save();
  ctx.rotate(turret + (opts.dead ? 0.5 : 0));
  ctx.translate(-(opts.recoil || 0) * size * 0.08, 0);
  if (c.art?.turret) ctx.drawImage(c.art.turret, -size / 2, -size / 2, size, size);
  else {
    ctx.fillStyle = '#333';
    ctx.fillRect(0, -size * 0.05, size * 0.46, size * 0.1);
    ctx.fillStyle = c.color;
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.18, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  ctx.restore();
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.floorCache = new Map();
    this.decals = makeCanvas(ARENA.width, ARENA.height);
    this.dctx = this.decals.getContext('2d');
    this.particles = [];
    this.popups = [];
    this.announce = [];
    this.trails = new Map();
    this.shake = 0;
    this.flashScreen = 0;
    this.contestants = [null, null];
    this.order = [0, 1];
    this.round = null;
    this.prev = null;
    this.lastStepAt = 0;
    this.tickDuration = 1000 / 30;
    this.tankFx = [0, 1].map(() => ({ flash: 0, recoil: 0, ghost: null, smokeT: 0 }));
    this.firstBlood = false;
    this.time = 0;
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(innerWidth * dpr);
    this.canvas.height = Math.round(innerHeight * dpr);
    this.scale = Math.min(this.canvas.width / VIEW_W, this.canvas.height / VIEW_H);
    this.offX = (this.canvas.width - VIEW_W * this.scale) / 2;
    this.offY = (this.canvas.height - VIEW_H * this.scale) / 2;
  }

  // Page coordinates (e.g. a mouse event) -> arena coordinates.
  toWorld(clientX, clientY) {
    const px = clientX * (this.canvas.width / innerWidth);
    const py = clientY * (this.canvas.height / innerHeight);
    return { x: (px - this.offX) / this.scale - OX, y: (py - this.offY) / this.scale - OY };
  }

  // ---------- static layers ----------

  floorFor(mapIndex) {
    if (this.floorCache.has(mapIndex)) return this.floorCache.get(mapIndex);
    const map = MAPS[mapIndex];
    const c = makeCanvas(ARENA.width, ARENA.height);
    const g = c.getContext('2d');
    const bg = g.createRadialGradient(800, 450, 80, 800, 450, 950);
    bg.addColorStop(0, '#262a30');
    bg.addColorStop(1, '#131519');
    g.fillStyle = bg;
    g.fillRect(0, 0, ARENA.width, ARENA.height);
    const rnd = rng(1234 + mapIndex * 77);
    for (let i = 0; i < 14; i++) {
      const x = rnd() * ARENA.width, y = rnd() * ARENA.height, r = 80 + rnd() * 220;
      const blob = g.createRadialGradient(x, y, 0, x, y, r);
      blob.addColorStop(0, `rgba(0,0,0,${0.08 + rnd() * 0.1})`);
      blob.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = blob;
      g.fillRect(x - r, y - r, r * 2, r * 2);
    }
    for (let i = 0; i < 9000; i++) {
      g.fillStyle = rnd() < 0.5 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.12)';
      g.fillRect(rnd() * ARENA.width, rnd() * ARENA.height, 1 + rnd() * 2, 1 + rnd() * 2);
    }
    g.lineWidth = 1;
    for (let x = 0; x <= ARENA.width; x += 50) {
      g.strokeStyle = x % 200 === 0 ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.025)';
      g.beginPath();
      g.moveTo(x + 0.5, 0);
      g.lineTo(x + 0.5, ARENA.height);
      g.stroke();
    }
    for (let y = 0; y <= ARENA.height; y += 50) {
      g.strokeStyle = y % 200 === 0 ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.025)';
      g.beginPath();
      g.moveTo(0, y + 0.5);
      g.lineTo(ARENA.width, y + 0.5);
      g.stroke();
    }
    // Spawn pads
    for (const sp of map.spawns) {
      g.strokeStyle = 'rgba(255,255,255,0.08)';
      g.setLineDash([8, 8]);
      g.lineWidth = 2;
      g.beginPath();
      g.arc(sp.x, sp.y, 44, 0, Math.PI * 2);
      g.stroke();
      g.setLineDash([]);
    }
    // Walls with drop shadow and bevel
    g.save();
    g.shadowColor = 'rgba(0,0,0,0.6)';
    g.shadowBlur = 18;
    g.shadowOffsetX = 7;
    g.shadowOffsetY = 10;
    g.fillStyle = '#30353c';
    for (const w of map.walls) g.fillRect(w.x, w.y, w.w, w.h);
    g.restore();
    for (const w of map.walls) {
      const grad = g.createLinearGradient(w.x, w.y, w.x + w.w, w.y + w.h);
      grad.addColorStop(0, '#4d545d');
      grad.addColorStop(1, '#30353c');
      g.fillStyle = grad;
      g.fillRect(w.x, w.y, w.w, w.h);
      g.fillStyle = 'rgba(255,255,255,0.07)';
      g.fillRect(w.x + 4, w.y + 4, w.w - 8, w.h - 8);
      g.strokeStyle = 'rgba(255,255,255,0.18)';
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(w.x + 0.75, w.y + w.h);
      g.lineTo(w.x + 0.75, w.y + 0.75);
      g.lineTo(w.x + w.w, w.y + 0.75);
      g.stroke();
      g.strokeStyle = 'rgba(0,0,0,0.5)';
      g.strokeRect(w.x + 0.5, w.y + 0.5, w.w - 1, w.h - 1);
      // Hazard stripe on the long side
      g.save();
      g.beginPath();
      if (w.w >= w.h) g.rect(w.x + 6, w.y + w.h / 2 - 3, w.w - 12, 6);
      else g.rect(w.x + w.w / 2 - 3, w.y + 6, 6, w.h - 12);
      g.clip();
      g.fillStyle = 'rgba(240,180,40,0.35)';
      for (let s = -900; s < 1800; s += 16) {
        g.beginPath();
        g.moveTo(w.x + s, w.y);
        g.lineTo(w.x + s + 8, w.y);
        g.lineTo(w.x + s + 8 - 900, w.y + 900);
        g.lineTo(w.x + s - 900, w.y + 900);
        g.fill();
      }
      g.restore();
    }
    // Border
    g.strokeStyle = '#4a5059';
    g.lineWidth = 6;
    g.strokeRect(3, 3, ARENA.width - 6, ARENA.height - 6);
    this.floorCache.set(mapIndex, c);
    return c;
  }

  // ---------- round lifecycle ----------

  newRound(round, order, contestants) {
    this.round = round;
    this.order = order;
    this.contestants = contestants;
    this.prev = this.snapshot(round);
    this.lastStepAt = performance.now();
    this.dctx.clearRect(0, 0, ARENA.width, ARENA.height);
    this.particles = [];
    this.popups = [];
    this.trails.clear();
    this.firstBlood = false;
    this.zoneAnnounced = false;
    for (const f of this.tankFx) Object.assign(f, { flash: 0, recoil: 0, ghost: null, smokeT: 0 });
  }

  snapshot(round) {
    return {
      tanks: round.tanks.map((t) => ({ x: t.x, y: t.y, heading: t.heading, turret: t.turret })),
      bullets: new Map(round.bullets.map((b) => [b.id, { x: b.x, y: b.y }])),
    };
  }

  beforeStep(round) {
    this.prev = this.snapshot(round);
  }

  afterStep(round, events) {
    this.lastStepAt = performance.now();
    if (round.tick % 2 === 0) this.treads(round);
    if (round.tick % 45 === 0) {
      this.dctx.save();
      this.dctx.globalCompositeOperation = 'destination-out';
      this.dctx.fillStyle = 'rgba(0,0,0,0.05)';
      this.dctx.fillRect(0, 0, ARENA.width, ARENA.height);
      this.dctx.restore();
    }
    for (const e of events) this.onEvent(e, round);
  }

  treads(round) {
    const g = this.dctx;
    for (const t of round.tanks) {
      if (!t.alive || Math.abs(t.speed) < 8) continue;
      const px = -Math.sin(t.heading), py = Math.cos(t.heading);
      g.save();
      g.fillStyle = 'rgba(0,0,0,0.2)';
      for (const s of [-17, 17]) {
        g.save();
        g.translate(t.x + px * s - Math.cos(t.heading) * 14, t.y + py * s - Math.sin(t.heading) * 14);
        g.rotate(t.heading);
        g.fillRect(-4, -4.5, 8, 9);
        g.restore();
      }
      g.restore();
    }
  }

  colorOfSide(side) {
    return this.contestants[this.order[side]]?.color || '#fff';
  }

  scorch(x, y, r, a = 0.5) {
    const g = this.dctx;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `rgba(0,0,0,${a})`);
    grad.addColorStop(0.6, `rgba(10,8,6,${a * 0.5})`);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }

  spawn(p) {
    if (this.particles.length < 1400) this.particles.push(p);
  }

  sparks(x, y, n, color, speed, dir = null, spread = Math.PI) {
    for (let i = 0; i < n; i++) {
      const a = dir == null ? Math.random() * Math.PI * 2 : dir + (Math.random() - 0.5) * spread;
      const v = speed * (0.4 + Math.random() * 0.8);
      this.spawn({ type: 'spark', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0, max: 0.2 + Math.random() * 0.35, color, size: 2 + Math.random() * 1.5, drag: 4 });
    }
  }

  smoke(x, y, n, size = 14, max = 1.2, color = '120,120,125') {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = 10 + Math.random() * 40;
      this.spawn({ type: 'smoke', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 10, life: 0, max: max * (0.6 + Math.random() * 0.8), size: size * (0.6 + Math.random() * 0.8), color, drag: 1.5 });
    }
  }

  popup(text, x, y, color, size = 30, max = 1.1) {
    this.popups.push({ text, x, y, color, size, life: 0, max });
  }

  shout(text, color, sub = '') {
    this.announce.push({ text, sub, color, life: 0, max: 1.8 });
  }

  onEvent(e, round) {
    switch (e.type) {
      case 'shot': {
        const c = this.colorOfSide(e.side);
        this.tankFx[e.side].recoil = 1;
        this.spawn({ type: 'flash', x: e.x, y: e.y, life: 0, max: 0.09, size: 34, color: '255,220,150' });
        this.sparks(e.x, e.y, 6, '255,210,120', 420, e.angle, 0.5);
        this.smoke(e.x + Math.cos(e.angle) * 6, e.y + Math.sin(e.angle) * 6, 3, 10, 0.7);
        this.shake = Math.max(this.shake, 2.5);
        break;
      }
      case 'ricochet':
        this.sparks(e.x, e.y, 10, '255,240,200', 320, Math.atan2(e.ny, e.nx), 2.2);
        this.spawn({ type: 'flash', x: e.x, y: e.y, life: 0, max: 0.08, size: 22, color: '255,255,230' });
        break;
      case 'impact':
        this.sparks(e.x, e.y, 12, '255,190,110', 260);
        this.smoke(e.x, e.y, 4, 12, 0.9);
        this.scorch(e.x, e.y, 16, 0.35);
        break;
      case 'fizzle':
        this.smoke(e.x, e.y, 2, 8, 0.5);
        break;
      case 'bump':
        this.smoke(e.x, e.y, 2, 12, 0.6, '110,100,90');
        break;
      case 'kitSpawn':
        this.spawn({ type: 'ring', x: e.x, y: e.y, life: 0, max: 0.6, size: 50, color: '93,255,160', width: 4 });
        break;
      case 'pickup':
        this.spawn({ type: 'ring', x: e.x, y: e.y, life: 0, max: 0.7, size: 80, color: '93,255,160', width: 6 });
        this.sparks(e.x, e.y, 16, '140,255,190', 200);
        this.popup(`+${Math.round(e.healed)}`, e.x, e.y - 30, '#5dffa0', 34);
        break;
      case 'clash':
        this.spawn({ type: 'flash', x: e.x, y: e.y, life: 0, max: 0.18, size: 70, color: '220,240,255' });
        this.spawn({ type: 'ring', x: e.x, y: e.y, life: 0, max: 0.45, size: 90, color: '220,240,255', width: 5 });
        this.sparks(e.x, e.y, 24, '220,240,255', 420);
        this.popup('ПЕРЕХВАТ!', e.x, e.y - 34, '#dff2ff', 34, 1.4);
        this.shake = Math.max(this.shake, 6);
        break;
      case 'hit': {
        const fx = this.tankFx[e.side];
        if (e.cause === 'zone') {
          fx.flash = Math.max(fx.flash, 0.25);
          if (Math.random() < 0.25) this.sparks(e.x, e.y, 2, '255,70,90', 120);
          break;
        }
        fx.flash = 1;
        const dir = Math.atan2(e.diry, e.dirx);
        this.sparks(e.bx, e.by_, 22, '255,200,120', 480, dir, 1.4);
        this.smoke(e.bx, e.by_, 4, 14, 0.9, '90,90,95');
        this.popup(`-${Math.round(e.damage)}`, e.x + (Math.random() - 0.5) * 20, e.y - 40, '#ffffff', 36);
        this.shake = Math.max(this.shake, 9);
        if (e.cause === 'self') this.shout('САМ СЕБЯ!', this.colorOfSide(e.side), 'рикошетом');
        else if (e.ricochet) this.popup('РИКОШЕТ!', e.x, e.y - 76, this.colorOfSide(e.by), 30, 1.3);
        if (!this.firstBlood && e.cause !== 'self') {
          this.firstBlood = true;
          this.shout('ПЕРВАЯ КРОВЬ', this.colorOfSide(e.by), this.contestants[this.order[e.by]]?.name || '');
        }
        break;
      }
      case 'death': {
        const x = e.x, y = e.y;
        this.spawn({ type: 'flash', x, y, life: 0, max: 0.35, size: 260, color: '255,210,140' });
        this.spawn({ type: 'ring', x, y, life: 0, max: 0.7, size: 260, color: '255,230,190', width: 10 });
        this.spawn({ type: 'ring', x, y, life: 0, max: 1.1, size: 380, color: '255,140,60', width: 4 });
        for (let i = 0; i < 70; i++) {
          const a = Math.random() * Math.PI * 2, v = 60 + Math.random() * 360;
          this.spawn({ type: 'fire', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0, max: 0.4 + Math.random() * 0.7, size: 10 + Math.random() * 22, drag: 3 });
        }
        for (let i = 0; i < 26; i++) {
          const a = Math.random() * Math.PI * 2, v = 120 + Math.random() * 420;
          this.spawn({ type: 'debris', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0, max: 0.8 + Math.random() * 0.9, size: 3 + Math.random() * 6, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 20, drag: 2.5, color: this.colorOfSide(e.side) });
        }
        this.sparks(x, y, 50, '255,220,150', 700);
        this.smoke(x, y, 24, 34, 2.4, '70,70,74');
        this.scorch(x, y, 90, 0.75);
        this.shake = 26;
        this.flashScreen = 0.55;
        break;
      }
      case 'zoneStart':
        this.shout('ЗОНА СУЖАЕТСЯ', '#ff4d5e', 'вне круга — урон');
        break;
    }
  }

  // ---------- per-frame ----------

  update(dt) {
    this.time += dt;
    for (const p of this.particles) {
      p.life += dt;
      if (p.vx !== undefined) {
        const k = Math.exp(-(p.drag || 0) * dt);
        p.vx *= k;
        p.vy *= k;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
      }
      if (p.vr) p.rot += p.vr * dt;
    }
    this.particles = this.particles.filter((p) => p.life < p.max);
    for (const p of this.popups) p.life += dt;
    this.popups = this.popups.filter((p) => p.life < p.max);
    for (const a of this.announce) a.life += dt;
    this.announce = this.announce.filter((a) => a.life < a.max);
    this.shake = Math.max(0, this.shake - dt * 60);
    this.flashScreen = Math.max(0, this.flashScreen - dt * 2);
    for (const f of this.tankFx) {
      f.flash = Math.max(0, f.flash - dt * 7);
      f.recoil = Math.max(0, f.recoil - dt * 6);
    }
    if (this.round) {
      for (const t of this.round.tanks) {
        const fx = this.tankFx[t.side];
        if (fx.ghost == null || fx.ghost < t.hp) fx.ghost = t.hp;
        else fx.ghost = lerp(fx.ghost, t.hp, Math.min(1, dt * 2.5));
        const hurt = t.hp / t.stats.maxHp;
        fx.smokeT -= dt;
        if ((!t.alive || hurt < 0.35) && fx.smokeT <= 0) {
          fx.smokeT = t.alive ? 0.12 : 0.07;
          this.smoke(t.x, t.y, 1, t.alive ? 12 : 20, t.alive ? 1.2 : 2, t.alive ? '80,80,85' : '50,50,54');
          if (!t.alive && Math.random() < 0.5) this.spawn({ type: 'fire', x: t.x + (Math.random() - 0.5) * 20, y: t.y + (Math.random() - 0.5) * 20, vx: 0, vy: -20, life: 0, max: 0.5, size: 10, drag: 1 });
        }
      }
    }
  }

  begin() {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#07080a';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(this.scale, 0, 0, this.scale, this.offX, this.offY);
    ctx.fillStyle = '#0c0d10';
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  }

  drawArena(alpha) {
    const ctx = this.ctx;
    const round = this.round;
    const sx = (Math.random() - 0.5) * this.shake;
    const sy = (Math.random() - 0.5) * this.shake;
    ctx.save();
    ctx.translate(OX + sx, OY + sy);
    ctx.drawImage(this.floorFor(round.mapIndex), 0, 0);
    ctx.drawImage(this.decals, 0, 0);
    this.drawKits(ctx, round);
    this.drawZone(ctx, round);

    const tanks = round.tanks.map((t, i) => {
      const p = this.prev?.tanks[i] || t;
      return {
        t,
        x: lerp(p.x, t.x, alpha),
        y: lerp(p.y, t.y, alpha),
        heading: lerpAngle(p.heading, t.heading, alpha),
        turret: lerpAngle(p.turret, t.turret, alpha),
      };
    });
    for (const k of tanks.filter((k) => !k.t.alive)) this.drawTank(ctx, k);
    for (const k of tanks.filter((k) => k.t.alive)) this.drawTank(ctx, k);
    this.drawBullets(ctx, round, alpha);
    this.drawParticles(ctx);
    for (const k of tanks) if (k.t.alive) this.drawTankTag(ctx, k);
    this.drawPopups(ctx);
    ctx.restore();
  }

  drawKits(ctx, round) {
    for (const k of round.kits) {
      if (k.active) {
        const pulse = 0.5 + 0.5 * Math.sin(this.time * 5);
        ctx.save();
        ctx.translate(k.x, k.y);
        ctx.shadowColor = '#5dffa0';
        ctx.shadowBlur = 18 + pulse * 12;
        ctx.fillStyle = 'rgba(20,60,40,0.85)';
        ctx.beginPath();
        ctx.arc(0, 0, KIT.radius + 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#5dffa0';
        ctx.lineWidth = 2.5;
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.fillStyle = '#5dffa0';
        ctx.fillRect(-3.5, -10, 7, 20);
        ctx.fillRect(-10, -3.5, 20, 7);
        ctx.rotate(this.time * 1.5);
        ctx.strokeStyle = `rgba(93,255,160,${0.3 + pulse * 0.4})`;
        ctx.setLineDash([6, 8]);
        ctx.beginPath();
        ctx.arc(0, 0, KIT.radius + 10 + pulse * 3, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      } else if (k.respawnIn < 6) {
        ctx.save();
        ctx.strokeStyle = 'rgba(93,255,160,0.35)';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(k.x, k.y, KIT.radius, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (1 - k.respawnIn / 6));
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  drawZone(ctx, round) {
    const z = round.zone;
    if (z.radius > Math.hypot(ARENA.width / 2, ARENA.height / 2) + 40) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, ARENA.width, ARENA.height);
    ctx.arc(z.x, z.y, z.radius, 0, Math.PI * 2, true);
    ctx.fillStyle = `rgba(255,40,70,${0.13 + 0.04 * Math.sin(this.time * 4)})`;
    ctx.fill('evenodd');
    ctx.beginPath();
    ctx.arc(z.x, z.y, z.radius, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,90,100,0.95)';
    ctx.lineWidth = 3;
    ctx.shadowColor = '#ff3050';
    ctx.shadowBlur = 16;
    ctx.setLineDash([22, 12]);
    ctx.lineDashOffset = -this.time * 40;
    ctx.stroke();
    ctx.restore();
  }

  drawTank(ctx, k) {
    const c = this.contestants[this.order[k.t.side]];
    const fx = this.tankFx[k.t.side];
    drawTankSprite(ctx, c, k.x, k.y, k.heading, k.turret, 64, { flash: fx.flash, recoil: fx.recoil, dead: !k.t.alive });
  }

  drawTankTag(ctx, k) {
    const t = k.t;
    const c = this.contestants[this.order[t.side]];
    const w = 58;
    const x = k.x - w / 2;
    const y = k.y - 50;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(x - 1, y - 1, w + 2, 7);
    ctx.fillStyle = c.color;
    ctx.fillRect(x, y, w * clamp(t.hp / t.stats.maxHp, 0, 1), 5);
    ctx.font = `600 13px ${BODY}`;
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.shadowColor = 'rgba(0,0,0,0.9)';
    ctx.shadowBlur = 4;
    ctx.fillText(c.name, k.x, y - 5);
    ctx.restore();
  }

  drawBullets(ctx, round, alpha) {
    const live = new Set();
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const b of round.bullets) {
      live.add(b.id);
      const p = this.prev?.bullets.get(b.id);
      const moved = p && Math.hypot(b.x - p.x, b.y - p.y) < 60;
      const x = moved ? lerp(p.x, b.x, alpha) : b.x;
      const y = moved ? lerp(p.y, b.y, alpha) : b.y;
      let trail = this.trails.get(b.id);
      if (!trail) this.trails.set(b.id, (trail = []));
      const last = trail[trail.length - 1];
      if (!last || Math.hypot(last.x - x, last.y - y) > 3) trail.push({ x, y });
      // Keep the tail a fixed length regardless of frame rate.
      let len = 0;
      for (let i = trail.length - 1; i > 0; i--) {
        len += Math.hypot(trail[i].x - trail[i - 1].x, trail[i].y - trail[i - 1].y);
        if (len > 80) {
          trail.splice(0, i - 1);
          break;
        }
      }
      const color = this.colorOfSide(b.owner);
      for (let i = 1; i < trail.length; i++) {
        const a = i / trail.length;
        ctx.strokeStyle = rgba(color, a * 0.7);
        ctx.lineWidth = 1 + a * 5;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(trail[i - 1].x, trail[i - 1].y);
        ctx.lineTo(trail[i].x, trail[i].y);
        ctx.stroke();
      }
      const glow = ctx.createRadialGradient(x, y, 0, x, y, 18);
      glow.addColorStop(0, rgba(color, 0.9));
      glow.addColorStop(1, rgba(color, 0));
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(x, y, 18, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    for (const id of this.trails.keys()) if (!live.has(id)) this.trails.delete(id);
  }

  drawParticles(ctx) {
    ctx.save();
    for (const p of this.particles) {
      const k = p.life / p.max;
      if (p.type === 'smoke') {
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = `rgba(${p.color},${0.35 * (1 - k)})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * (0.6 + k * 1.6), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    for (const p of this.particles) {
      const k = p.life / p.max;
      if (p.type === 'debris') {
        ctx.globalCompositeOperation = 'source-over';
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = k < 0.2 ? '#ffd9a0' : '#1d1d20';
        ctx.globalAlpha = 1 - k * 0.6;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
        ctx.restore();
      }
    }
    ctx.globalCompositeOperation = 'lighter';
    for (const p of this.particles) {
      const k = p.life / p.max;
      if (p.type === 'spark') {
        ctx.strokeStyle = `rgba(${p.color},${1 - k})`;
        ctx.lineWidth = p.size;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - p.vx * 0.035, p.y - p.vy * 0.035);
        ctx.stroke();
      } else if (p.type === 'fire') {
        const r = p.size * (1 - k * 0.5);
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
        g.addColorStop(0, `rgba(255,${Math.round(230 - k * 150)},${Math.round(150 - k * 150)},${0.9 * (1 - k)})`);
        g.addColorStop(1, 'rgba(255,60,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
      } else if (p.type === 'flash') {
        const r = p.size * (0.6 + k * 0.6);
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
        g.addColorStop(0, `rgba(${p.color},${1 - k})`);
        g.addColorStop(1, `rgba(${p.color},0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
      } else if (p.type === 'ring') {
        ctx.strokeStyle = `rgba(${p.color},${0.8 * (1 - k)})`;
        ctx.lineWidth = p.width * (1 - k) + 0.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * easeOut(k), 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  drawPopups(ctx) {
    ctx.save();
    ctx.textAlign = 'center';
    for (const p of this.popups) {
      const k = p.life / p.max;
      const s = k < 0.15 ? 0.6 + (k / 0.15) * 0.5 : 1.1 - Math.min(0.1, (k - 0.15));
      ctx.globalAlpha = k > 0.7 ? 1 - (k - 0.7) / 0.3 : 1;
      ctx.font = `${Math.round(p.size * s)}px ${HEAD}`;
      ctx.lineWidth = 5;
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      const y = p.y - easeOut(k) * 34;
      ctx.strokeText(p.text, p.x, y);
      ctx.fillStyle = p.color;
      ctx.fillText(p.text, p.x, y);
    }
    ctx.restore();
  }

  // ---------- HUD ----------

  drawHud(ui) {
    const ctx = this.ctx;
    const round = this.round;
    const top = ctx.createLinearGradient(0, 0, 0, 160);
    top.addColorStop(0, '#15171b');
    top.addColorStop(1, '#0c0d10');
    ctx.fillStyle = top;
    ctx.fillRect(0, 0, VIEW_W, 160);
    for (let ci = 0; ci < 2; ci++) {
      const c = this.contestants[ci];
      const side = this.order.indexOf(ci);
      const t = round.tanks[side];
      this.drawPlate(ctx, c, t, ci, ui);
    }
    // centre block
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = `600 18px ${BODY}`;
    ctx.fillText(`РАУНД ${ui.roundIndex + 1} · ${round.map.name.toUpperCase()}`, VIEW_W / 2, 44);
    const left = Math.max(0, ROUND_SECONDS - round.time);
    const mm = Math.floor(left / 60);
    const ss = Math.floor(left % 60);
    const zoneOn = round.time >= ZONE.startShrink;
    ctx.font = `64px ${HEAD}`;
    ctx.fillStyle = zoneOn ? '#ff5a6a' : '#f2f2f2';
    ctx.fillText(`${mm}:${String(ss).padStart(2, '0')}`, VIEW_W / 2, 112);
    ctx.font = `600 16px ${BODY}`;
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.fillText(`до ${ui.firstTo} побед`, VIEW_W / 2, 142);
    if (ui.speed !== 1) {
      ctx.textAlign = 'right';
      ctx.font = `28px ${HEAD}`;
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.fillText(`×${ui.speed}`, VIEW_W - 24, VIEW_H - 18);
    }
  }

  drawPlate(ctx, c, t, ci, ui) {
    const right = ci === 1;
    const dir = right ? -1 : 1;
    const edge = right ? VIEW_W - 60 : 60;
    const fx = this.tankFx[t.side];
    ctx.save();
    // colour accent bar
    const bar = ctx.createLinearGradient(edge, 0, edge + dir * 700, 0);
    bar.addColorStop(0, rgba(c.color, 0.35));
    bar.addColorStop(1, rgba(c.color, 0));
    ctx.fillStyle = bar;
    ctx.fillRect(right ? edge - 700 : edge, 20, 700, 120);
    ctx.fillStyle = c.color;
    ctx.fillRect(right ? edge - 6 : edge, 20, 6, 120);
    drawTankSprite(ctx, c, edge + dir * 70, 80, right ? Math.PI : 0, right ? Math.PI : 0, 96, { shadow: false, dead: !t.alive, flash: fx.flash });
    const tx = edge + dir * 140;
    ctx.textAlign = right ? 'right' : 'left';
    ctx.fillStyle = '#fff';
    ctx.font = `40px ${HEAD}`;
    ctx.fillText(c.name, tx, 70);
    ctx.fillStyle = c.color;
    ctx.font = `700 17px ${BODY}`;
    ctx.fillText(c.model.toUpperCase(), tx, 98);
    // HP bar
    const bw = 440;
    const bx = right ? tx - bw : tx;
    const by = 112;
    const k = clamp(t.hp / t.stats.maxHp, 0, 1);
    const g = clamp((fx.ghost ?? t.hp) / t.stats.maxHp, 0, 1);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(bx, by, bw, 16);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    if (right) ctx.fillRect(bx + bw * (1 - g), by, bw * g, 16);
    else ctx.fillRect(bx, by, bw * g, 16);
    ctx.fillStyle = c.color;
    if (right) ctx.fillRect(bx + bw * (1 - k), by, bw * k, 16);
    else ctx.fillRect(bx, by, bw * k, 16);
    ctx.font = `600 15px ${BODY}`;
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.textAlign = right ? 'right' : 'left';
    ctx.fillText(`${Math.ceil(t.hp)} / ${t.stats.maxHp}`, right ? bx - 12 : bx + bw + 12, by + 14);
    // score pips
    for (let i = 0; i < ui.firstTo; i++) {
      const x = right ? VIEW_W / 2 + 120 + i * 24 : VIEW_W / 2 - 120 - i * 24;
      ctx.beginPath();
      ctx.arc(x, 84, 9, 0, Math.PI * 2);
      ctx.fillStyle = i < ui.score[ci] ? c.color : 'rgba(255,255,255,0.1)';
      ctx.fill();
      if (i < ui.score[ci]) {
        ctx.shadowColor = c.color;
        ctx.shadowBlur = 12;
        ctx.fill();
        ctx.shadowBlur = 0;
      }
    }
    ctx.restore();
  }

  // ---------- overlays ----------

  drawAnnouncements() {
    const ctx = this.ctx;
    const a = this.announce[this.announce.length - 1];
    if (!a) return;
    const k = a.life / a.max;
    const inK = easeOut(k / 0.12);
    const alpha = k > 0.75 ? 1 - (k - 0.75) / 0.25 : 1;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.textAlign = 'center';
    const y = OY + 150;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, y - 62, VIEW_W, a.sub ? 104 : 82);
    ctx.fillStyle = a.color;
    ctx.fillRect(0, y - 62, VIEW_W * inK, 4);
    ctx.font = `${Math.round(56 * (0.8 + 0.2 * inK))}px ${HEAD}`;
    ctx.fillStyle = a.color;
    ctx.shadowColor = a.color;
    ctx.shadowBlur = 20;
    ctx.fillText(a.text, VIEW_W / 2, y);
    ctx.shadowBlur = 0;
    if (a.sub) {
      ctx.font = `600 20px ${BODY}`;
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.fillText(a.sub, VIEW_W / 2, y + 30);
    }
    ctx.restore();
  }

  drawCountdown(ui, now) {
    const ctx = this.ctx;
    const t = (now - ui.countdown.start) / 1000;
    ctx.save();
    ctx.fillStyle = 'rgba(5,6,8,0.55)';
    ctx.fillRect(OX, OY, ARENA.width, ARENA.height);
    ctx.textAlign = 'center';
    const n = 3 - Math.floor(t);
    ctx.font = `600 24px ${BODY}`;
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fillText(`РАУНД ${ui.roundIndex + 1}`, VIEW_W / 2, OY + 300);
    ctx.font = `72px ${HEAD}`;
    ctx.fillStyle = '#fff';
    ctx.fillText(this.round.map.name.toUpperCase(), VIEW_W / 2, OY + 380);
    // who starts where
    ctx.font = `700 22px ${BODY}`;
    const l = this.contestants[this.order[0]];
    const r = this.contestants[this.order[1]];
    ctx.textAlign = 'left';
    ctx.fillStyle = l.color;
    ctx.fillText(`◀ ${l.name}`, OX + 40, OY + 450 - 70);
    ctx.textAlign = 'right';
    ctx.fillStyle = r.color;
    ctx.fillText(`${r.name} ▶`, OX + ARENA.width - 40, OY + 450 - 70);
    if (n >= 1) {
      const f = t % 1;
      ctx.textAlign = 'center';
      ctx.globalAlpha = 1 - f * 0.7;
      ctx.font = `${Math.round(200 * (1.3 - easeOut(f) * 0.3))}px ${HEAD}`;
      ctx.fillStyle = '#fff';
      ctx.fillText(String(n), VIEW_W / 2, OY + 600);
    }
    ctx.restore();
  }

  drawRoundEnd(ui, now) {
    const ctx = this.ctx;
    const b = ui.banner;
    const k = (now - b.start) / 1000;
    const inK = easeOut(k / 0.35);
    const c = b.winner == null ? null : this.contestants[b.winner];
    const color = c ? c.color : '#cfcfcf';
    ctx.save();
    ctx.fillStyle = `rgba(0,0,0,${0.35 * inK})`;
    ctx.fillRect(OX, OY, ARENA.width, ARENA.height);
    const h = 190;
    const y = OY + ARENA.height / 2 - h / 2;
    ctx.fillStyle = 'rgba(8,9,12,0.9)';
    ctx.fillRect(0, y, VIEW_W * inK, h);
    ctx.fillStyle = color;
    ctx.fillRect(0, y, VIEW_W * inK, 6);
    ctx.fillRect(VIEW_W * (1 - inK), y + h - 6, VIEW_W * inK, 6);
    ctx.globalAlpha = inK;
    ctx.textAlign = 'center';
    ctx.font = `92px ${HEAD}`;
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 30;
    ctx.fillText(c ? c.name.toUpperCase() : 'НИЧЬЯ', VIEW_W / 2, y + 108);
    ctx.shadowBlur = 0;
    ctx.font = `700 24px ${BODY}`;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillText(b.reason, VIEW_W / 2, y + 152);
    ctx.restore();
  }

  drawStatBars(ctx, c, x, y, align) {
    const d = deriveStats(c.stats);
    const values = {
      armor: `${d.maxHp} HP`,
      engine: `${d.maxSpeed} px/с`,
      gun: `${d.damage} урона`,
      reload: `${d.reloadTime} с`,
    };
    STAT_KEYS.forEach((key, i) => {
      const yy = y + i * 58;
      ctx.textAlign = align;
      ctx.font = `700 16px ${BODY}`;
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.fillText(`${STAT_LABELS[key]} · ${values[key]}`, x, yy);
      for (let p = 0; p < 5; p++) {
        const px = align === 'left' ? x + p * 62 : x - 56 - p * 62;
        ctx.fillStyle = p < c.stats[key] ? c.color : 'rgba(255,255,255,0.08)';
        ctx.fillRect(px, yy + 12, 56, 14);
      }
    });
  }

  drawIntro(now, ui) {
    const ctx = this.ctx;
    const t = (now - ui.introStart) / 1000;
    const [A, B] = this.contestants;
    ctx.save();
    // diagonal split
    const gA = ctx.createLinearGradient(0, 0, VIEW_W / 2, 0);
    gA.addColorStop(0, rgba(A.color, 0.28));
    gA.addColorStop(1, rgba(A.color, 0.04));
    const gB = ctx.createLinearGradient(VIEW_W, 0, VIEW_W / 2, 0);
    gB.addColorStop(0, rgba(B.color, 0.28));
    gB.addColorStop(1, rgba(B.color, 0.04));
    const slant = 120;
    const inA = easeOut(t / 0.6);
    ctx.fillStyle = gA;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo((VIEW_W / 2 + slant) * inA, 0);
    ctx.lineTo((VIEW_W / 2 - slant) * inA, VIEW_H);
    ctx.lineTo(0, VIEW_H);
    ctx.fill();
    ctx.fillStyle = gB;
    ctx.beginPath();
    ctx.moveTo(VIEW_W, 0);
    ctx.lineTo(VIEW_W - (VIEW_W / 2 - slant) * inA, 0);
    ctx.lineTo(VIEW_W - (VIEW_W / 2 + slant) * inA, VIEW_H);
    ctx.lineTo(VIEW_W, VIEW_H);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(VIEW_W / 2 + slant, 0);
    ctx.lineTo(VIEW_W / 2 - slant, VIEW_H);
    ctx.stroke();

    const side = (c, i) => {
      const k = easeOut((t - 0.3 - i * 0.25) / 0.7);
      if (k <= 0) return;
      const right = i === 1;
      const cx = right ? VIEW_W - 480 : 480;
      ctx.save();
      ctx.globalAlpha = k;
      ctx.translate((right ? 1 : -1) * (1 - k) * 200, 0);
      const sweep = Math.sin(t * 0.9 + i) * 0.5;
      const heading = right ? Math.PI + 0.25 : -0.25;
      drawTankSprite(ctx, c, cx, 360, heading, heading + sweep, 330, {});
      ctx.textAlign = 'center';
      ctx.font = `700 22px ${BODY}`;
      ctx.fillStyle = c.color;
      ctx.fillText(c.model.toUpperCase(), cx, 590);
      ctx.font = `76px ${HEAD}`;
      ctx.fillStyle = '#fff';
      ctx.shadowColor = c.color;
      ctx.shadowBlur = 24;
      ctx.fillText(c.name.toUpperCase(), cx, 668);
      ctx.shadowBlur = 0;
      ctx.font = `italic 500 24px ${BODY}`;
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.fillText(c.motto ? `«${c.motto}»` : '', cx, 712);
      this.drawStatBars(ctx, c, cx - 155, 780, 'left');
      ctx.restore();
    };
    side(A, 0);
    side(B, 1);
    const kv = easeOut((t - 1.1) / 0.4);
    if (kv > 0) {
      ctx.save();
      ctx.globalAlpha = kv;
      ctx.textAlign = 'center';
      ctx.font = `${Math.round(150 * (1.6 - kv * 0.6))}px ${HEAD}`;
      ctx.fillStyle = '#fff';
      ctx.shadowColor = 'rgba(255,255,255,0.6)';
      ctx.shadowBlur = 30;
      ctx.fillText('VS', VIEW_W / 2, 470);
      ctx.restore();
    }
    ctx.restore();
  }

  drawMatchEnd(ui, now) {
    const ctx = this.ctx;
    const t = (now - ui.matchEnd.start) / 1000;
    const { winner, score, stats } = ui.matchEnd;
    ctx.save();
    ctx.fillStyle = 'rgba(6,7,9,0.9)';
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    const c = winner == null ? null : this.contestants[winner];
    const color = c ? c.color : '#ddd';
    const k = easeOut(t / 0.6);
    const glow = ctx.createRadialGradient(VIEW_W / 2, 330, 0, VIEW_W / 2, 330, 800);
    glow.addColorStop(0, rgba(color, 0.35 * k));
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    ctx.textAlign = 'center';
    ctx.globalAlpha = k;
    if (c) drawTankSprite(ctx, c, VIEW_W / 2, 250, -Math.PI / 2, -Math.PI / 2 + Math.sin(t) * 0.4, 230, {});
    ctx.font = `700 24px ${BODY}`;
    ctx.fillStyle = color;
    ctx.fillText(c ? `ПОБЕДИТЕЛЬ · ${c.model.toUpperCase()}` : 'ИТОГ МАТЧА', VIEW_W / 2, 420);
    ctx.font = `110px ${HEAD}`;
    ctx.fillStyle = '#fff';
    ctx.shadowColor = color;
    ctx.shadowBlur = 34;
    ctx.fillText(c ? c.name.toUpperCase() : 'НИЧЬЯ', VIEW_W / 2, 530);
    ctx.shadowBlur = 0;
    ctx.font = `84px ${HEAD}`;
    ctx.fillStyle = this.contestants[0].color;
    ctx.textAlign = 'right';
    ctx.fillText(String(score[0]), VIEW_W / 2 - 40, 640);
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.textAlign = 'center';
    ctx.fillText(':', VIEW_W / 2, 636);
    ctx.fillStyle = this.contestants[1].color;
    ctx.textAlign = 'left';
    ctx.fillText(String(score[1]), VIEW_W / 2 + 40, 640);
    this.drawStatsTable(ctx, stats, 700);
    ctx.restore();
  }

  drawStatsTable(ctx, stats, y0) {
    const rows = [
      ['Нанесено урона', (s) => Math.round(s.damageDealt)],
      ['Точность', (s) => (s.shots ? Math.round((100 * s.hits) / s.shots) + '%' : '—')],
      ['Уничтожений', (s) => s.kills],
      ['Попаданий рикошетом', (s) => s.ricochetHits],
      ['Сбито снарядов', (s) => s.intercepts],
      ['Аптечек', (s) => s.kits],
      ['Урон себе', (s) => Math.round(s.selfDamage)],
    ];
    ctx.save();
    rows.forEach(([label, fn], i) => {
      const y = y0 + i * 44;
      ctx.fillStyle = i % 2 ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.06)';
      ctx.fillRect(VIEW_W / 2 - 520, y - 30, 1040, 44);
      ctx.font = `600 20px ${BODY}`;
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.fillText(label, VIEW_W / 2, y);
      ctx.font = `30px ${HEAD}`;
      ctx.textAlign = 'right';
      ctx.fillStyle = this.contestants[0].color;
      ctx.fillText(String(fn(stats[0])), VIEW_W / 2 - 250, y + 2);
      ctx.textAlign = 'left';
      ctx.fillStyle = this.contestants[1].color;
      ctx.fillText(String(fn(stats[1])), VIEW_W / 2 + 250, y + 2);
    });
    ctx.restore();
  }

  drawTournament(ui, now) {
    const ctx = this.ctx;
    const T = ui.tournament;
    const [A, B] = this.contestants;
    ctx.save();
    ctx.fillStyle = '#0b0c0f';
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    ctx.textAlign = 'center';
    ctx.font = `600 24px ${BODY}`;
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillText(T.finished ? `ТУРНИР · ${T.n} РАУНДОВ · ИТОГ` : `ТУРНИР · РАУНД ${Math.min(T.done + 1, T.n)} ИЗ ${T.n}`, VIEW_W / 2, 80);
    // names
    ctx.font = `64px ${HEAD}`;
    ctx.textAlign = 'right';
    ctx.fillStyle = A.color;
    ctx.fillText(A.name.toUpperCase(), VIEW_W / 2 - 80, 180);
    ctx.textAlign = 'left';
    ctx.fillStyle = B.color;
    ctx.fillText(B.name.toUpperCase(), VIEW_W / 2 + 80, 180);
    ctx.font = `700 20px ${BODY}`;
    ctx.textAlign = 'right';
    ctx.fillStyle = A.color;
    ctx.fillText(A.model.toUpperCase(), VIEW_W / 2 - 80, 214);
    ctx.textAlign = 'left';
    ctx.fillStyle = B.color;
    ctx.fillText(B.model.toUpperCase(), VIEW_W / 2 + 80, 214);
    // big score
    ctx.font = `180px ${HEAD}`;
    ctx.textAlign = 'right';
    ctx.fillStyle = A.color;
    ctx.fillText(String(T.wins[0]), VIEW_W / 2 - 80, 420);
    ctx.textAlign = 'left';
    ctx.fillStyle = B.color;
    ctx.fillText(String(T.wins[1]), VIEW_W / 2 + 80, 420);
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.font = `100px ${HEAD}`;
    ctx.fillText(':', VIEW_W / 2, 400);
    ctx.font = `600 20px ${BODY}`;
    ctx.fillText(`ничьих: ${T.draws}`, VIEW_W / 2, 470);
    // Technical health: missed turns mean the result is not purely about tactics.
    (T.health || []).forEach((h, i) => {
      if (!h.missed && !h.frozen) return;
      ctx.save();
      ctx.font = `600 18px ${BODY}`;
      ctx.fillStyle = '#ff6b7a';
      ctx.textAlign = i === 0 ? 'right' : 'left';
      const text = h.frozen ? `бот отключён: не отвечал 3 с` : `пропущено ходов: ${h.missed}`;
      ctx.fillText(text, i === 0 ? VIEW_W / 2 - 80 : VIEW_W / 2 + 80, 244);
      ctx.restore();
    });
    // share bar
    const done = Math.max(1, T.done);
    const bw = 1200;
    const bx = VIEW_W / 2 - bw / 2;
    const wa = (T.wins[0] / done) * bw;
    const wb = (T.wins[1] / done) * bw;
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(bx, 500, bw, 26);
    ctx.fillStyle = A.color;
    ctx.fillRect(bx, 500, wa, 26);
    ctx.fillStyle = B.color;
    ctx.fillRect(bx + bw - wb, 500, wb, 26);
    // progress
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(bx, 548, bw, 6);
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillRect(bx, 548, (bw * T.done) / T.n, 6);
    this.drawStatsTable(ctx, T.stats, 640);
    // per-map
    ctx.font = `600 18px ${BODY}`;
    ctx.textAlign = 'center';
    const mw = 280;
    const shown = T.mapIndex == null ? T.byMap.map((m, i) => [m, i]) : [[T.byMap[T.mapIndex], T.mapIndex]];
    shown.forEach(([m, mi], i) => {
      const x = VIEW_W / 2 - (mw * shown.length) / 2 + mw * i + mw / 2;
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.fillText(MAPS[mi].name, x, 1000);
      ctx.fillStyle = A.color;
      ctx.textAlign = 'right';
      ctx.fillText(String(m.wins[0]), x - 16, 1034);
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.textAlign = 'center';
      ctx.fillText(':', x, 1034);
      ctx.fillStyle = B.color;
      ctx.textAlign = 'left';
      ctx.fillText(String(m.wins[1]), x + 16, 1034);
      ctx.textAlign = 'center';
    });
    ctx.restore();
  }

  drawMenuBackdrop() {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = 0.35;
    const n = MAPS.length;
    ctx.drawImage(this.floorFor(((Math.floor(this.time / 6) % n) + n) % n), OX, OY);
    ctx.globalAlpha = 1;
    ctx.textAlign = 'center';
    ctx.font = `110px ${HEAD}`;
    ctx.fillStyle = '#fff';
    ctx.shadowColor = 'rgba(255,170,80,0.5)';
    ctx.shadowBlur = 40;
    ctx.fillText('ТАНКОВАЯ АРЕНА', VIEW_W / 2, 250);
    ctx.restore();
  }

  drawPause() {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(OX, OY, ARENA.width, ARENA.height);
    ctx.textAlign = 'center';
    ctx.font = `80px ${HEAD}`;
    ctx.fillStyle = '#fff';
    ctx.fillText('ПАУЗА', VIEW_W / 2, OY + ARENA.height / 2 + 28);
    ctx.restore();
  }

  drawDebug(lines) {
    const ctx = this.ctx;
    ctx.save();
    ctx.font = `500 14px ${BODY}`;
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    lines.forEach((l, i) => ctx.fillText(l, 16, VIEW_H - 16 - (lines.length - 1 - i) * 18));
    ctx.restore();
  }

  frame(now, dt, ui) {
    this.update(dt * (ui.timeScale ?? 1));
    this.begin();
    const ctx = this.ctx;
    if (ui.phase === 'menu' || ui.phase === 'loading') {
      this.drawMenuBackdrop();
      return;
    }
    if (ui.phase === 'intro') {
      this.drawIntro(now, ui);
      return;
    }
    if (ui.phase === 'tournament') {
      this.drawTournament(ui, now);
      return;
    }
    if (this.round) {
      const alpha = ui.phase === 'fight' ? clamp((now - this.lastStepAt) / this.tickDuration, 0, 1) : 1;
      this.drawArena(alpha);
      this.drawHud(ui);
      if (ui.phase === 'countdown') this.drawCountdown(ui, now);
      this.drawAnnouncements();
      if (ui.phase === 'roundEnd' && ui.banner) this.drawRoundEnd(ui, now);
      if (this.flashScreen > 0) {
        ctx.fillStyle = `rgba(255,235,210,${this.flashScreen * 0.5})`;
        ctx.fillRect(0, 0, VIEW_W, VIEW_H);
      }
      if (ui.paused) this.drawPause();
    }
    if (ui.phase === 'matchEnd') this.drawMatchEnd(ui, now);
  }
}
