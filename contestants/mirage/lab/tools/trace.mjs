// Трасса одного раунда: A — мой мозг в режиме отладки, B — любой бот.
//   node lab/tools/trace.mjs --vs tank --map Каньон --side 0 --seed 3 --every 15 [--from 80] [--to 120]
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as eng from '../../arena/engine.js';
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const argv = process.argv.slice(2);
const o = { vs: 'hunter', map: 0, side: 0, seed: 1, every: 15, from: 0, to: 121, jitter: 1 };
for (let i = 0; i < argv.length; i++) {
  const k = argv[i].replace(/^--/, '');
  o[k] = isNaN(Number(argv[i + 1])) ? argv[i + 1] : Number(argv[i + 1]);
  i++;
}
globalThis.__MIRAGE_BUDGET_SCALE = o.budget ?? 50;
const brainDir = o.brain ? resolve(root, o.brain) : resolve(root, 'tank');
const { createBrain } = await import(pathToFileURL(join(brainDir, 'brain.js')).href);
const dirs = [resolve(process.cwd(), o.vs), resolve(root, o.vs), join(root, 'arena', 'sparring', o.vs)];
const bDir = dirs.find((d) => existsSync(join(d, 'bot.js')));
const B = (await import(pathToFileURL(join(bDir, 'bot.js')).href + '?trace')).default;
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
// --round i воспроизводит раунд i стенда run.mjs (карта, сторона, сдвиг старта).
if (o.round !== undefined) { if (o.replay !== 0) replayPrefix(o.round, A, B, o.W ?? 16); const pl = eng.roundPlan(o.round); o.map = pl.mapIndex; o.side = pl.swap ? 1 : 0; }
const mapIndex = typeof o.map === 'number' ? o.map : eng.MAPS.findIndex((m) => m.name === o.map);
const bySide = o.side === 0 ? [A, B] : [B, A];
const round = eng.createRound({ mapIndex, tanks: bySide.map((b) => ({ name: b.name, stats: b.stats })) });
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rng = mulberry(o.seed * 100003 + (o.round ?? 0) * 7919);
if (o.jitter) for (const t of round.tanks) {
  const x0 = t.x, y0 = t.y;
  for (let tries = 0; tries < 50; tries++) {
    const x = x0 + (rng() * 2 - 1) * 60 * o.jitter, y = y0 + (rng() * 2 - 1) * 200 * o.jitter;
    if (x < 30 || x > 1570 || y < 30 || y > 870) continue;
    if (round.map.walls.some((w) => x > w.x - 30 && x < w.x + w.w + 30 && y > w.y - 30 && y < w.y + w.h + 30)) continue;
    t.x = x; t.y = y; t.heading = eng.normalizeAngle(t.heading + (rng() * 2 - 1) * 0.6 * o.jitter); t.turret = t.heading; break;
  }
}
for (let s = 0; s < 2; s++) bySide[s].init?.({ round: o.round ?? 0, side: s, mapName: round.map.name, view: eng.botView(round, s) });
const me = o.side;
const f1 = (v) => (typeof v === 'number' ? v.toFixed(1) : v);
while (!round.over) {
  const va = eng.botView(round, 0), vb = eng.botView(round, 1);
  const acts = [bySide[0].tick(va), bySide[1].tick(vb)];
  const d = brain.mem.debug;
  if (o.dump !== undefined && Math.abs(round.time - o.dump) < 1e-6 && d?.all) {
    const top = [...d.all].sort((a, b) => a.cost - b.cost).slice(0, 12);
    for (const p of top) console.log('   plan', p.pi, p.desc, 'cost', p.cost.toFixed(1), `B${p.cB.toFixed(1)} Z${p.cZ.toFixed(1)} E${p.cE.toFixed(1)} V${p.cV.toFixed(1)} D${p.cD.toFixed(1)} G${p.cG.toFixed(1)} K${p.cK.toFixed(1)} end(${p.xe.toFixed(0)},${p.ye.toFixed(0)})`);
    const worst = [...d.all].sort((a, b) => b.cost - a.cost).slice(0, 3);
    for (const p of worst) console.log('   worst', p.pi, p.desc, 'cost', p.cost.toFixed(1), `G${p.cG.toFixed(1)} end(${p.xe.toFixed(0)},${p.ye.toFixed(0)})`);
  }
  const ev = eng.stepRound(round, acts);
  const t = round.time;
  const m = round.tanks[me], e = round.tanks[1 - me];
  const interesting = ev.some((x) => (x.type === 'hit' && x.cause !== 'zone') || x.type === 'shot' || x.type === 'clash' || x.type === 'pickup');
  if (t >= o.from && t <= o.to && (round.tick % o.every === 0 || interesting)) {
    const dist = Math.hypot(m.x - e.x, m.y - e.y);
    const evs = ev.filter((x) => x.type !== 'hit' || x.cause !== 'zone').map((x) => x.type === 'hit' ? `HIT${x.side === me ? '-ME' : '-EN'}${x.ricochet ? 'r' : ''}` : x.type === 'shot' ? `shot${x.side === me ? 'Me' : 'En'}` : x.type).join(',');
    const b = d?.best;
    console.log(`${t.toFixed(2).padStart(6)} me(${m.x.toFixed(0)},${m.y.toFixed(0)} h${m.heading.toFixed(2)} v${m.speed.toFixed(0)} hp${m.hp.toFixed(0)}) en(${e.x.toFixed(0)},${e.y.toFixed(0)} h${e.heading.toFixed(2)} v${e.speed.toFixed(0)} hp${e.hp.toFixed(0)} r${e.reloadLeft.toFixed(2)}) d${dist.toFixed(0)} z${round.zone.radius.toFixed(0)} | goal ${d?.goal?.kind}(${d?.goal?.x},${d?.goal?.y}) cost ${f1(b?.cost)} [B${f1(b?.cB)} Z${f1(b?.cZ)} E${f1(b?.cE)} V${f1(b?.cV)} D${f1(b?.cD)} G${f1(b?.cG)} K${f1(b?.cK)}] aim ${d?.aim ? d.aim.kind + ' ' + (d.aim.coverage ?? 0).toFixed(2) : '-'}${d?.fire ? ' FIRE' : ''} ${evs}`);
  }
}
console.log('winner', round.winner === null ? 'draw' : round.winner === me ? 'ME' : 'ENEMY', round.endReason, round.time.toFixed(1), 'hp', round.tanks[me].hp.toFixed(0), round.tanks[1 - me].hp.toFixed(0));
