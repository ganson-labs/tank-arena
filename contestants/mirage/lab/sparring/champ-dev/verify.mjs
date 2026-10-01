// Bit-exact check of physics.js against arena/engine.js on random states.
//   node lab/sparring/champ-dev/verify.mjs [trials]
import { createRound, stepRound, MAPS, deriveStats } from '../../../arena/engine.js';
import * as P from './physics.js';

const trials = Number(process.argv[2] || 3000);
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
const pick = (a) => a[Math.floor(rnd() * a.length)];

function randStats() {
  for (;;) {
    const s = { armor: Math.floor(rnd() * 6), engine: Math.floor(rnd() * 6), gun: Math.floor(rnd() * 6), reload: Math.floor(rnd() * 6) };
    if (s.armor + s.engine + s.gun + s.reload <= 10) return s;
  }
}
const randCtl = () => (rnd() < 0.6 ? pick([-1, 0, 1]) : rnd() * 2 - 1);

let tankSteps = 0, tankFail = 0, bulletTicks = 0, bulletFail = 0, fireChecks = 0, fireFail = 0, clashes = 0, bounces = 0, tankHits = 0;
const fails = [];

// ---------- tanks ----------
for (let t = 0; t < trials; t++) {
  const mapIndex = t % MAPS.length;
  const round = createRound({ mapIndex, tanks: [{ name: 'a', stats: randStats() }, { name: 'b', stats: randStats() }] });
  const walls = P.prepWalls(round.map.walls);
  // random states; tanks placed far apart; sometimes deliberately inside/near walls or borders
  for (const tk of round.tanks) {
    if (rnd() < 0.3) {
      const w = pick(round.map.walls);
      tk.x = w.x - 30 + rnd() * (w.w + 60);
      tk.y = w.y - 30 + rnd() * (w.h + 60);
    } else if (rnd() < 0.15) {
      tk.x = rnd() < 0.5 ? rnd() * 40 : 1600 - rnd() * 40;
      tk.y = rnd() * 900;
    } else {
      tk.x = rnd() * 1600;
      tk.y = rnd() * 900;
    }
    tk.heading = (rnd() * 2 - 1) * Math.PI;
    tk.turret = (rnd() * 2 - 1) * Math.PI;
    tk.speed = -tk.stats.maxSpeed * 0.6 + rnd() * tk.stats.maxSpeed * 1.6;
    tk.hp = 1e9;
    tk.reloadLeft = 10;
  }
  if (Math.hypot(round.tanks[0].x - round.tanks[1].x, round.tanks[0].y - round.tanks[1].y) < 200) continue;
  const mine = round.tanks.map((tk) => ({ T: Float64Array.of(tk.x, tk.y, tk.heading, tk.speed), turret: tk.turret, st: tk.stats }));
  for (let step = 0; step < 40; step++) {
    const acts = [0, 1].map(() => ({ throttle: randCtl(), turn: randCtl(), turretTurn: randCtl(), fire: false }));
    for (let s = 0; s < 2; s++) {
      P.stepTank(mine[s].T, acts[s].throttle, acts[s].turn, mine[s].st.maxSpeed, mine[s].st.turnRate, walls);
      mine[s].turret = P.normAngle(mine[s].turret + acts[s].turretTurn * mine[s].st.turretRate * P.DT);
    }
    stepRound(round, acts);
    const a = round.tanks[0], b = round.tanks[1];
    if (Math.hypot(a.x - b.x, a.y - b.y) < 60) break; // tank-tank push not modelled
    for (let s = 0; s < 2; s++) {
      const e = round.tanks[s], m = mine[s];
      tankSteps++;
      if (e.x !== m.T[0] || e.y !== m.T[1] || e.heading !== m.T[2] || e.speed !== m.T[3] || e.turret !== m.turret) {
        tankFail++;
        if (fails.length < 5) fails.push({ kind: 'tank', trial: t, step, side: s, engine: [e.x, e.y, e.heading, e.speed, e.turret], mine: [...m.T, m.turret] });
        m.T[0] = e.x; m.T[1] = e.y; m.T[2] = e.heading; m.T[3] = e.speed; m.turret = e.turret;
      }
    }
  }
}

// ---------- bullets (with tanks, ricochets, clashes, lifetime) ----------
for (let t = 0; t < trials; t++) {
  const mapIndex = t % MAPS.length;
  const round = createRound({ mapIndex, tanks: [{ name: 'a', stats: randStats() }, { name: 'b', stats: randStats() }] });
  const walls = P.prepWalls(round.map.walls);
  const grid = P.buildBulletGrid(walls);
  // tanks: resting at valid positions (no wall contact) so they do not move this tick
  for (const tk of round.tanks) {
    for (;;) {
      tk.x = 30 + rnd() * 1540;
      tk.y = 30 + rnd() * 840;
      if (!walls.some((w) => P.circleRect(tk.x, tk.y, P.TANK_R + 1, w))) break;
    }
    tk.speed = 0;
    tk.hp = 1e9;
    tk.reloadLeft = 10;
  }
  if (Math.hypot(round.tanks[0].x - round.tanks[1].x, round.tanks[0].y - round.tanks[1].y) < 60) continue;
  const n = 1 + Math.floor(rnd() * 6);
  round.bullets = [];
  const list = [];
  for (let i = 0; i < n; i++) {
    const owner = rnd() < 0.5 ? 0 : 1;
    const sp = pick([450, 500, 550, 600, 650, 700]);
    const ang = (rnd() * 2 - 1) * Math.PI;
    let x, y;
    if (i > 0 && rnd() < 0.4) {
      // aim at a previous bullet to create clashes
      const o = round.bullets[Math.floor(rnd() * round.bullets.length)];
      x = o.x + (rnd() * 2 - 1) * 60;
      y = o.y + (rnd() * 2 - 1) * 60;
    } else if (rnd() < 0.3) {
      const w = pick(round.map.walls);
      x = w.x - 20 + rnd() * (w.w + 40);
      y = w.y - 20 + rnd() * (w.h + 40);
    } else {
      x = rnd() * 1600;
      y = rnd() * 900;
    }
    const bl = rnd() < 0.6 ? 1 : 0;
    const age = rnd() < 0.15 ? 3.7 + rnd() * 0.3 : rnd() * 3;
    const b = { id: i + 1, owner, x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, damage: 30, bouncesLeft: bl, bounced: bl === 0 ? rnd() < 0.8 : false, age, dead: false };
    round.bullets.push(b);
    list.push({ id: b.id, owner, B: Float64Array.of(b.x, b.y, b.vx, b.vy, b.bouncesLeft, b.bounced ? 1 : 0, b.age, 0) });
  }
  round.nextBulletId = n + 1;
  for (let step = 0; step < 90 && round.bullets.length; step++) {
    const tanks = round.tanks.map((tk) => ({ x: tk.x, y: tk.y, alive: tk.alive }));
    const before = round.bullets.length;
    const myHits = P.stepBulletsWithTanks(list, tanks, grid);
    const events = stepRound(round, [{}, {}]);
    round.over = false;
    const engHits = events.filter((e) => e.type === 'hit' && e.cause !== 'zone').map((e) => e.side);
    tankHits += engHits.length;
    clashes += events.filter((e) => e.type === 'clash').length;
    bounces += events.filter((e) => e.type === 'ricochet').length;
    bulletTicks += before;
    const liveMine = list.filter((it) => !it.B[7]);
    let bad = liveMine.length !== round.bullets.length || engHits.join() !== myHits.map((h) => h.side).join();
    if (!bad) {
      for (let i = 0; i < liveMine.length; i++) {
        const e = round.bullets[i], m = liveMine[i];
        if (e.id !== m.id || e.x !== m.B[0] || e.y !== m.B[1] || e.vx !== m.B[2] || e.vy !== m.B[3] ||
            e.bouncesLeft !== m.B[4] || (e.bounced ? 1 : 0) !== m.B[5] || e.age !== m.B[6]) { bad = true; break; }
      }
    }
    if (bad) {
      bulletFail++;
      if (fails.length < 10) fails.push({ kind: 'bullet', trial: t, step, engine: round.bullets.map((b) => [b.id, b.x, b.y]), mine: liveMine.map((m) => [m.id, m.B[0], m.B[1]]) });
      break;
    }
    for (let i = list.length - 1; i >= 0; i--) if (list[i].B[7]) list.splice(i, 1);
  }
}

// ---------- firing: spawn point, blocked muzzle, first tick of flight ----------
for (let t = 0; t < trials; t++) {
  const mapIndex = t % MAPS.length;
  const stats = randStats();
  const round = createRound({ mapIndex, tanks: [{ name: 'a', stats }, { name: 'b', stats: randStats() }] });
  const walls = P.prepWalls(round.map.walls);
  const grid = P.buildBulletGrid(walls);
  const tk = round.tanks[0];
  const w = pick(round.map.walls);
  tk.x = w.x - 60 + rnd() * (w.w + 120);
  tk.y = w.y - 60 + rnd() * (w.h + 120);
  tk.heading = (rnd() * 2 - 1) * Math.PI;
  tk.turret = (rnd() * 2 - 1) * Math.PI;
  tk.speed = rnd() * 100;
  tk.reloadLeft = rnd() < 0.5 ? 0 : P.DT * (rnd() < 0.5 ? 1 : 2);
  const o = round.tanks[1];
  o.x = tk.x > 800 ? 60 : 1540; o.y = 450; o.speed = 0; o.hp = 1e9; tk.hp = 1e9;
  const act = { throttle: randCtl(), turn: randCtl(), turretTurn: randCtl(), fire: true };
  const T = Float64Array.of(tk.x, tk.y, tk.heading, tk.speed);
  P.stepTank(T, act.throttle, act.turn, stats.maxSpeed || deriveStats(stats).maxSpeed, tk.stats.turnRate, walls);
  const turret = P.normAngle(tk.turret + act.turretTurn * tk.stats.turretRate * P.DT);
  const canFire = Math.max(0, tk.reloadLeft - P.DT) <= 0;
  const B = new Float64Array(8);
  const spawned = canFire && P.spawnBullet(B, T[0], T[1], turret, tk.stats.bulletSpeed, grid);
  let selfHit = false;
  if (spawned) {
    const hits = P.stepBulletsWithTanks([{ id: 1, owner: 0, B }], [{ x: T[0], y: T[1], alive: true }, { x: o.x, y: o.y, alive: true }], grid);
    selfHit = hits.some((h) => h.side === 0);
  }
  const events = stepRound(round, [act, {}]);
  fireChecks++;
  const shot = events.some((e) => e.type === 'shot' && e.side === 0);
  const engSelf = events.some((e) => e.type === 'hit' && e.cause === 'self');
  const eb = round.bullets.find((b) => b.owner === 0);
  let ok = shot === canFire && selfHit === engSelf;
  if (ok && spawned && !B[7]) ok = !!eb && eb.x === B[0] && eb.y === B[1] && eb.vx === B[2] && eb.vy === B[3] && eb.bouncesLeft === B[4];
  if (ok && (!spawned || B[7])) ok = !eb;
  if (!ok) { fireFail++; if (fails.length < 12) fails.push({ kind: 'fire', trial: t, canFire, spawned, eb, B: [...B] }); }
}

console.log(`tank steps ${tankSteps}, mismatches ${tankFail}`);
console.log(`bullet-ticks ${bulletTicks} (ricochets ${bounces}, clashes ${clashes}, tank hits ${tankHits}), mismatching ticks ${bulletFail}`);
console.log(`fire checks ${fireChecks}, mismatches ${fireFail}`);
if (fails.length) console.log(JSON.stringify(fails.slice(0, 6), null, 1));
process.exit(tankFail || bulletFail || fireFail ? 1 : 0);
