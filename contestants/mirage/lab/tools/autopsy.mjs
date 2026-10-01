// Вскрытие попаданий: при первом «неизбежном» попадании в плане ищем уход расширенным перебором
// (случайные планы из 2–5 отрезков) по точной физике. Если уход был — виновато семейство планов;
// если нет — виновата позиция до выстрела.
//   node lab/tools/autopsy.mjs --vs lab/sparring/champ --round 15 [--seed 1] [--n 20000]
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as eng from '../../arena/engine.js';
import * as S from '../../tank/sim.js';
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const argv = process.argv.slice(2);
const o = { vs: 'hunter', seed: 1, round: 0, n: 20000, jitter: 1, max: 12 };
for (let i = 0; i < argv.length; i += 2) o[argv[i].replace(/^--/, '')] = isNaN(Number(argv[i + 1])) ? argv[i + 1] : Number(argv[i + 1]);
globalThis.__MIRAGE_BUDGET_SCALE = o.budget ?? 50;
const brainDir = o.brain ? resolve(root, o.brain) : resolve(root, 'tank');
const { createBrain } = await import(pathToFileURL(join(brainDir, 'brain.js')).href);
const dirs = [resolve(process.cwd(), o.vs), resolve(root, o.vs), join(root, 'arena', 'sparring', o.vs)];
const bDir = dirs.find((d) => existsSync(join(d, 'bot.js')));
const B = (await import(pathToFileURL(join(bDir, 'bot.js')).href + '?autopsy')).default;
const brain = createBrain({ debug: true });
const A = { name: 'Мираж', stats: { armor: 0, engine: 0, gun: 5, reload: 5 }, init: brain.init, tick: brain.tick };
// Проигрыш предыдущих раундов того же потока стенда (обучение соперника между раундами).
function mulberryR(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function setupRound(i, Abot, Bbot) {
  const pl = eng.roundPlan(i);
  const side = pl.swap ? 1 : 0;
  const bySide = side === 0 ? [Abot, Bbot] : [Bbot, Abot];
  const round = eng.createRound({ mapIndex: pl.mapIndex, tanks: bySide.map((b) => ({ name: b.name, stats: b.stats })) });
  const rng = mulberryR((o.seed ?? 1) * 100003 + i * 7919);
  const jit = o.jitter ?? 1;
  if (jit) for (const t of round.tanks) {
    const x0 = t.x, y0 = t.y;
    for (let tries = 0; tries < 50; tries++) {
      const x = x0 + (rng() * 2 - 1) * 60 * jit, y = y0 + (rng() * 2 - 1) * 200 * jit;
      if (x < 30 || x > 1570 || y < 30 || y > 870) continue;
      if (round.map.walls.some((w) => x > w.x - 30 && x < w.x + w.w + 30 && y > w.y - 30 && y < w.y + w.h + 30)) continue;
      t.x = x; t.y = y; t.heading = eng.normalizeAngle(t.heading + (rng() * 2 - 1) * 0.6 * jit); t.turret = t.heading; break;
    }
  }
  for (let s2 = 0; s2 < 2; s2++) bySide[s2].init?.({ round: i, side: s2, mapName: round.map.name, view: eng.botView(round, s2) });
  return { round, bySide, side };
}
function replayPrefix(target, Abot, Bbot, W = 16) {
  for (let i = target % W; i < target; i += W) {
    const { round, bySide } = setupRound(i, Abot, Bbot);
    while (!round.over) eng.stepRound(round, [bySide[0].tick(eng.botView(round, 0)), bySide[1].tick(eng.botView(round, 1))]);
  }
}
if (o.replay !== 0) replayPrefix(o.round, A, B, o.W ?? 16);
const pl = eng.roundPlan(o.round);
const side = pl.swap ? 1 : 0;
const bySide = side === 0 ? [A, B] : [B, A];
const round = eng.createRound({ mapIndex: pl.mapIndex, tanks: bySide.map((b) => ({ name: b.name, stats: b.stats })) });
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rng = mulberry(o.seed * 100003 + o.round * 7919);
if (o.jitter) for (const t of round.tanks) {
  const x0 = t.x, y0 = t.y;
  for (let tries = 0; tries < 50; tries++) {
    const x = x0 + (rng() * 2 - 1) * 60 * o.jitter, y = y0 + (rng() * 2 - 1) * 200 * o.jitter;
    if (x < 30 || x > 1570 || y < 30 || y > 870) continue;
    if (round.map.walls.some((w) => x > w.x - 30 && x < w.x + w.w + 30 && y > w.y - 30 && y < w.y + w.h + 30)) continue;
    t.x = x; t.y = y; t.heading = eng.normalizeAngle(t.heading + (rng() * 2 - 1) * 0.6 * o.jitter); t.turret = t.heading; break;
  }
}
for (let s = 0; s < 2; s++) bySide[s].init?.({ round: o.round, side: s, mapName: round.map.name, view: eng.botView(round, s) });
const walls = S.prepWalls(round.map.walls);
const srng = mulberry(99);
let inHit = false, reported = 0;
const HZ = 60;
function search(view) {
  const me = view.me;
  const bl = view.bullets.map((b) => ({ x: b.x, y: b.y, vx: b.vx, vy: b.vy, bouncesLeft: b.bouncesLeft, bounced: b.canHitOwner, age: 0, owner: b.mine ? side : 1 - side, damage: b.damage }));
  const tracks = S.traceBullets(bl, walls, HZ);
  const st = { x: 0, y: 0, h: 0, v: 0 };
  let ok = 0, bestK = -1;
  for (let n = 0; n < o.n; n++) {
    const segs = 2 + Math.floor(srng() * 4);
    const acts = [];
    for (let q = 0; q < segs; q++) acts.push({ thr: [1, 0, -1, 0.5, -0.5][Math.floor(srng() * 5)], trn: [-1, 0, 1, 0.5, -0.5][Math.floor(srng() * 5)], len: 1 + Math.floor(srng() * 20) });
    st.x = me.x; st.y = me.y; st.h = me.heading; st.v = me.speed;
    let q = 0, left = acts[0].len, hit = false, k;
    for (k = 0; k < HZ && !hit; k++) {
      const a = acts[Math.min(q, acts.length - 1)];
      S.stepTank(st, a.thr, a.trn, me.stats, walls);
      if (--left <= 0 && q < acts.length - 1) { q++; left = acts[q].len; }
      for (const tr of tracks) if (S.trackHitAt(tr, k, st.x, st.y, side)) { hit = true; break; }
    }
    if (!hit) ok++;
    else if (k > bestK) bestK = k;
  }
  return { ok, n: o.n, nb: bl.length, bullets: bl.map((b) => `(${b.x.toFixed(0)},${b.y.toFixed(0)} v${Math.atan2(b.vy, b.vx).toFixed(2)} ${b.owner === side ? 'MINE' : 'EN'}${b.bounced ? ' bounced' : ''} bl${b.bouncesLeft})`) };
}
while (!round.over && reported < o.max) {
  const va = eng.botView(round, 0), vb = eng.botView(round, 1);
  const acts = [bySide[0].tick(va), bySide[1].tick(vb)];
  const d = brain.mem.debug;
  const view = side === 0 ? va : vb;
  if (d && d.bestHits > 0 && !inHit) {
    inHit = true;
    const r = search(view);
    const m = view.me, e = view.enemy;
    console.log(`t=${view.time.toFixed(2)} неизбежно по плану: me(${m.x.toFixed(0)},${m.y.toFixed(0)} h${m.heading.toFixed(2)} v${m.speed.toFixed(0)}) en(${e.x.toFixed(0)},${e.y.toFixed(0)}) d${Math.hypot(m.x - e.x, m.y - e.y).toFixed(0)} · расширенный перебор: уходов ${r.ok}/${r.n} · пуль ${r.nb}: ${r.bullets.join(' ')}`);
    reported++;
  } else if (d && d.bestHits === 0) inHit = false;
  const ev = eng.stepRound(round, acts);
  for (const x of ev) if (x.type === 'hit' && x.cause !== 'zone' && x.side === side) console.log(`   ${round.time.toFixed(2)} ПОПАДАНИЕ по мне${x.ricochet ? ' (рикошет)' : ''}${x.cause === 'self' ? ' (свой)' : ''}`);
}
