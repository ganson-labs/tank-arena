// Trace one round: node lab/sparring/champ-dev/trace.mjs --map Лабиринт --vs hunter [--side 1] [--every 30] [--from 0] [--to 120]
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MAPS, createRound, stepRound, botView } from '../../../arena/engine.js';
import { prepWalls } from './physics.js';
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const a = process.argv.slice(2);
const o = { map: 'Полигон', vs: 'hunter', side: 0, every: 30, from: 0, to: 121, me: 'lab/sparring/champ-dev', jitter: null, round: null };
for (let i = 0; i < a.length; i++) { const k = a[i].replace(/^--/, ''); o[k] = isNaN(+a[i + 1]) ? a[i + 1] : +a[i + 1]; i++; }
const dirOf = (spec) => [resolve(root, spec), join(root, 'arena/sparring', spec)].find((c) => existsSync(join(c, 'bot.js')));
const A = (await import(pathToFileURL(join(dirOf(o.me), 'bot.js')).href + '?t0')).default;
const B = (await import(pathToFileURL(join(dirOf(o.vs), 'bot.js')).href + '?t1')).default;
if (A.debug) A.debug.trace = true;
import { roundPlan } from '../../../arena/engine.js';
let mi = MAPS.findIndex((m) => m.name === o.map);
if (o.round !== null) { const pl = roundPlan(o.round - 1); mi = pl.mapIndex; o.side = pl.swap ? 1 : 0; }
const bots = o.side === 0 ? [A, B] : [B, A];
let round = createRound({ mapIndex: mi, tanks: bots.map((b) => ({ name: b.name, stats: b.stats })) });
if (o.jitter !== null) {
  let seed = o.jitter;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  for (let r = 0; r < (o.round ?? 1); r++) {
    const pl = roundPlan(r);
    const rr = createRound({ mapIndex: pl.mapIndex, tanks: bots.map((b) => ({ name: b.name, stats: b.stats })) });
    for (const t of rr.tanks) {
      for (let tries = 0; tries < 50; tries++) {
        const x = t.x + (rnd() * 2 - 1) * 60, y = t.y + (rnd() * 2 - 1) * 160;
        if (!rr.map.walls.some((w) => x > w.x - 30 && x < w.x + w.w + 30 && y > w.y - 30 && y < w.y + w.h + 30) && y > 30 && y < 870) { t.x = x; t.y = y; break; }
      }
    }
    if (r === (o.round ?? 1) - 1) round = rr;
  }
}
bots.forEach((b, s) => b.init?.({ round: 0, side: s, mapName: round.map.name, view: botView(round, s) }));
const me = o.side, op = 1 - o.side;
while (!round.over) {
  const acts = [0, 1].map((s) => bots[s].tick(botView(round, s)));
  const ev = stepRound(round, acts);
  const t = round.tanks[me], e = round.tanks[op];
  for (const x of ev) if (x.type === 'hit' && x.cause !== 'zone') console.log(`  ${round.time.toFixed(2)} HIT on ${x.side === me ? 'ME' : 'enemy'} ${x.damage.toFixed(0)}${x.ricochet ? ' ric' : ''}${x.cause === 'self' ? ' SELF' : ''}`);
  if (round.tick % o.every === 0 && round.time >= o.from && round.time <= o.to) {
    const d = A.debug.last || {};
    const W = round.map.walls; const los = !W.some((w) => segRect(t.x, t.y, e.x, e.y, w, 5));
    console.log(`${round.time.toFixed(1).padStart(5)} me(${t.x.toFixed(0)},${t.y.toFixed(0)} h${t.heading.toFixed(2)} v${t.speed.toFixed(0)} hp${t.hp.toFixed(0)}) en(${e.x.toFixed(0)},${e.y.toFixed(0)} hp${e.hp.toFixed(0)}) d${Math.hypot(t.x - e.x, t.y - e.y).toFixed(0)} ${los ? 'LOS' : 'nolos'} erl${e.reloadLeft.toFixed(2)} zone${round.zone.radius.toFixed(0)} ${JSON.stringify(d)}`);
  }
}
console.log('winner', round.winner === me ? 'ME' : round.winner === null ? 'draw' : 'enemy', round.endReason, round.time.toFixed(1), 'tally me', JSON.stringify(round.tanks[me].tally), 'enemy', JSON.stringify(round.tanks[op].tally));

function segRect(x1, y1, x2, y2, r, pad) {
  const minX = r.x - pad, maxX = r.x + r.w + pad, minY = r.y - pad, maxY = r.y + r.h + pad;
  let t0 = 0, t1 = 1; const dx = x2 - x1, dy = y2 - y1;
  const clip = (p, q) => { if (Math.abs(p) < 1e-12) return q >= 0; const t = q / p; if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; } return true; };
  return clip(-dx, x1 - minX) && clip(dx, maxX - x1) && clip(-dy, y1 - minY) && clip(dy, maxY - y1);
}
