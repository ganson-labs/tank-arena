// Dev bench: both sides' tallies, tick timing, per-hit log, optional spawn jitter.
//   node lab/sparring/champ-dev/bench.mjs [botA=lab/sparring/champ-dev] --vs hunter --rounds 16 [--jitter seed] [--hits] [--map name]
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { MAPS, createRound, stepRound, botView, roundPlan } from '../../../arena/engine.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const args = process.argv.slice(2);
const opt = { a: 'lab/sparring/champ-dev', vs: 'hunter', rounds: 16, jitter: null, hits: false, map: null, quiet: false, traceRound: 0, every: 30, from: 0 };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--vs') opt.vs = args[++i];
  else if (a === '--rounds') opt.rounds = Number(args[++i]);
  else if (a === '--jitter') opt.jitter = Number(args[++i]);
  else if (a === '--hits') opt.hits = true;
  else if (a === '--map') opt.map = args[++i];
  else if (a === '--quiet') opt.quiet = true;
  else if (a === '--trace-round') opt.traceRound = Number(args[++i]);
  else if (a === '--every') opt.every = Number(args[++i]);
  else if (a === '--from') opt.from = Number(args[++i]);
  else opt.a = a;
}
function dirOf(spec) {
  for (const c of [resolve(process.cwd(), spec), resolve(root, spec), join(root, 'arena/sparring', spec)]) if (existsSync(join(c, 'bot.js'))) return c;
  throw new Error('no bot ' + spec);
}
async function load(spec, inst) {
  const mod = await import(pathToFileURL(join(dirOf(spec), 'bot.js')).href + '?i=' + inst);
  return { bot: mod.default, name: mod.default.name, tMax: 0, tSum: 0, n: 0, slow: 0 };
}
let seed = opt.jitter ?? 1;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);

const A = await load(opt.a, 0);
const B = await load(opt.vs, 1);
if (opt.traceRound && A.bot.debug) A.bot.debug.trace = true;
const mapFilter = opt.map ? MAPS.findIndex((m) => m.name === opt.map) : -1;
const score = { w: 0, l: 0, d: 0 };
const tot = [0, 1].map(() => ({ shots: 0, hits: 0, ric: 0, dealt: 0, taken: 0, self: 0, icp: 0, kits: 0, zone: 0 }));
const hitDist = [[], []];
function call(e, fn, arg) {
  const t0 = performance.now();
  try { return e.bot[fn]?.(arg); } catch (err) { console.error(e.name, fn, err.stack); return null; } finally {
    const dt = performance.now() - t0;
    if (fn === 'tick') { e.tMax = Math.max(e.tMax, dt); e.tSum += dt; e.n++; if (dt > 20) e.slow++; }
  }
}
for (let i = 0; i < opt.rounds; i++) {
  const plan = roundPlan(i);
  const mapIndex = mapFilter >= 0 ? mapFilter : plan.mapIndex;
  const aSide = plan.swap ? 1 : 0;
  const bySide = aSide === 0 ? [A, B] : [B, A];
  const round = createRound({ mapIndex, tanks: bySide.map((e) => ({ name: e.name, stats: e.bot.stats })) });
  if (opt.jitter !== null) {
    for (const t of round.tanks) {
      for (let tries = 0; tries < 50; tries++) {
        const x = t.x + (rnd() * 2 - 1) * 60, y = t.y + (rnd() * 2 - 1) * 160;
        if (!round.map.walls.some((w) => x > w.x - 30 && x < w.x + w.w + 30 && y > w.y - 30 && y < w.y + w.h + 30) && y > 30 && y < 870) { t.x = x; t.y = y; break; }
      }
    }
  }
  for (let s = 0; s < 2; s++) call(bySide[s], 'init', { round: i, side: s, mapName: round.map.name, view: botView(round, s) });
  const shotsLog = [];
  while (!round.over) {
    const acts = [0, 1].map((s) => call(bySide[s], 'tick', botView(round, s)));
    const ev = stepRound(round, acts);
    if (opt.traceRound === i + 1 && round.tick % opt.every === 0 && round.time >= opt.from) {
      const t = round.tanks[aSide], e = round.tanks[1 - aSide], d = A.bot.debug?.last || {};
      console.log(`  ${round.time.toFixed(1).padStart(5)} me(${t.x.toFixed(0)},${t.y.toFixed(0)} h${t.heading.toFixed(2)} v${t.speed.toFixed(0)} hp${t.hp.toFixed(0)}) en(${e.x.toFixed(0)},${e.y.toFixed(0)} hp${e.hp.toFixed(0)} rl${e.reloadLeft.toFixed(2)}) d${Math.hypot(t.x - e.x, t.y - e.y).toFixed(0)} zone${round.zone.radius.toFixed(0)} zd${Math.hypot(t.x - 800, t.y - 450).toFixed(0)} ${d.mode} want${d.want} min${d.minD} goal(${d.gx},${d.gy}) cost${d.cost} kit${d.kit ? 1 : 0}`);
    }
    for (const e of ev) {
      if (e.type === 'shot') shotsLog.push({ side: e.side, t: round.time, x: e.x, y: e.y });
      if (e.type === 'hit' && e.cause !== 'zone') {
        const shooter = e.by;
        const who = shooter === aSide ? 0 : 1;
        const d = Math.hypot(round.tanks[0].x - round.tanks[1].x, round.tanks[0].y - round.tanks[1].y);
        hitDist[who].push(Math.round(d));
        if (opt.hits) console.log(`   ${round.time.toFixed(1)}s ${e.cause === 'self' ? 'SELF ' : ''}${bySide[shooter].name} -> ${bySide[e.side].name} ${e.damage.toFixed(0)}${e.ricochet ? ' ric' : ''} dist ${d.toFixed(0)}`);
      }
    }
  }
  const mine = round.tanks[aSide], theirs = round.tanks[1 - aSide];
  let res;
  if (round.winner === null) { res = 'DRAW'; score.d++; } else if (round.winner === aSide) { res = 'WIN '; score.w++; } else { res = 'LOSS'; score.l++; }
  for (const [k, t] of [[0, mine], [1, theirs]]) {
    const T = tot[k], y = t.tally;
    T.shots += y.shots; T.hits += y.hits; T.ric += y.ricochetHits; T.dealt += y.damageDealt; T.taken += y.damageTaken; T.self += y.selfDamage; T.icp += y.intercepts; T.kits += y.kits; T.zone += y.zoneDamage;
  }
  if (!opt.quiet) {
    console.log(`R${String(i + 1).padStart(2)} ${round.map.name.padEnd(9)} ${aSide ? 'R' : 'L'} ${res} ${round.time.toFixed(1).padStart(5)}s ${round.endReason.padEnd(4)} HP ${Math.ceil(mine.hp)}/${mine.stats.maxHp} vs ${Math.ceil(theirs.hp)}/${theirs.stats.maxHp}` +
      ` | A ${mine.tally.hits}/${mine.tally.shots} ric ${mine.tally.ricochetHits} icp ${mine.tally.intercepts} self ${mine.tally.selfDamage.toFixed(0)} kit ${mine.tally.kits} zone ${mine.tally.zoneDamage.toFixed(0)}` +
      ` | B ${theirs.tally.hits}/${theirs.tally.shots} ric ${theirs.tally.ricochetHits} self ${theirs.tally.selfDamage.toFixed(0)}`);
  }
}
const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) + '%' : '-');
console.log(`\n${A.name} vs ${B.name}: ${score.w}W ${score.l}L ${score.d}D`);
for (const [k, e] of [[0, A], [1, B]]) {
  const T = tot[k];
  console.log(`${e.name.padEnd(16)} acc ${pct(T.hits, T.shots)} (${T.hits}/${T.shots}) ric ${T.ric} dealt ${T.dealt.toFixed(0)} taken ${T.taken.toFixed(0)} self ${T.self.toFixed(0)} icp ${T.icp} kits ${T.kits} zone ${T.zone.toFixed(0)} | tick avg ${(e.tSum / e.n).toFixed(2)}ms max ${e.tMax.toFixed(1)}ms >20ms ${e.slow}`);
  const hd = hitDist[k].sort((a, b) => a - b);
  if (hd.length) console.log(`   hit distances: median ${hd[hd.length >> 1]} min ${hd[0]} max ${hd[hd.length - 1]}`);
}
if (A.bot.debug) console.log('debug A', JSON.stringify(A.bot.debug));
