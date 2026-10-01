// Самые медленные тики: один процесс, мой мозг против соперника, замер каждой фазы.
//   node lab/tools/slow.mjs --vs lab/sparring/champ-v4-full --rounds 4
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import * as eng from '../../arena/engine.js';
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const argv = process.argv.slice(2);
const o = { vs: 'hunter', rounds: 4 };
for (let i = 0; i < argv.length; i += 2) o[argv[i].replace(/^--/, '')] = isNaN(Number(argv[i + 1])) ? argv[i + 1] : Number(argv[i + 1]);
const bDir = [resolve(root, o.vs), join(root, 'arena', 'sparring', o.vs)].find((d) => existsSync(join(d, 'bot.js')));
const B = (await import(pathToFileURL(join(bDir, 'bot.js')).href)).default;
const A = (await import(pathToFileURL(join(root, 'tank', 'bot.js')).href)).default;
const all = [];
for (let i = 0; i < o.rounds; i++) {
  const pl = eng.roundPlan(i);
  const side = pl.swap ? 1 : 0;
  const bySide = side === 0 ? [A, B] : [B, A];
  const round = eng.createRound({ mapIndex: pl.mapIndex, tanks: bySide.map((b) => ({ name: b.name, stats: b.stats })) });
  for (let s = 0; s < 2; s++) bySide[s].init?.({ round: i, side: s, mapName: round.map.name, view: eng.botView(round, s) });
  while (!round.over) {
    const v = [eng.botView(round, 0), eng.botView(round, 1)];
    const t0 = performance.now();
    const a = bySide[side].tick(v[side]);
    const dt = performance.now() - t0;
    all.push({ dt, t: round.time, map: round.map.name, nb: v[side].bullets.length, reload: v[side].me.reloadLeft });
    const b = bySide[1 - side].tick(v[1 - side]);
    eng.stepRound(round, side === 0 ? [a, b] : [b, a]);
  }
}
all.sort((x, y) => y.dt - x.dt);
console.log('тиков', all.length, 'среднее', (all.reduce((p, q) => p + q.dt, 0) / all.length).toFixed(2), 'мс');
for (const q of [0.5, 0.9, 0.99, 0.999]) console.log(`p${q * 100}`, all[Math.floor(all.length * (1 - q))].dt.toFixed(1));
console.log('худшие:', all.slice(0, 12).map((x) => `${x.dt.toFixed(1)}мс t${x.t.toFixed(1)} ${x.map} пуль${x.nb} перезар${x.reload.toFixed(2)}`).join('\n  '));
