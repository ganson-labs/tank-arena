// Find slow ticks with a per-section breakdown: node lab/sparring/champ-dev/slow.mjs [rounds] [thresholdMs] [opponent]
import { createRound, stepRound, botView, roundPlan } from '../../../arena/engine.js';
import { performance } from 'node:perf_hooks';
const rounds = Number(process.argv[2] || 2), thr = Number(process.argv[3] || 15), opp = process.argv[4] || '../../../arena/sparring/hunter';
const A = (await import('./bot.js?a')).default;
const H = (await import(opp + '/bot.js?b')).default;
A.debug.trace = true;
const times = [];
for (let i = 0; i < rounds; i++) {
  const plan = roundPlan(i);
  const round = createRound({ mapIndex: plan.mapIndex, tanks: [{ name: 'a', stats: A.stats }, { name: 'h', stats: H.stats }] });
  A.init({ round: i, side: 0, mapName: round.map.name, view: botView(round, 0) });
  H.init?.({ round: i, side: 1, mapName: round.map.name, view: botView(round, 1) });
  while (!round.over) {
    const v = botView(round, 0);
    const t0 = performance.now();
    const a = A.tick(v);
    const dt = performance.now() - t0;
    times.push(dt);
    if (dt > thr) console.log(`round ${i} ${round.map.name} tick ${round.tick} ${dt.toFixed(1)}ms bullets ${v.bullets.length} ${JSON.stringify(A.debug.last.ms)}`);
    stepRound(round, [a, H.tick(botView(round, 1))]);
  }
}
times.sort((a, b) => a - b);
const q = (p) => times[Math.min(times.length - 1, Math.floor(p * times.length))].toFixed(2);
console.log(`ticks ${times.length} avg ${(times.reduce((a, b) => a + b, 0) / times.length).toFixed(2)} p50 ${q(0.5)} p90 ${q(0.9)} p99 ${q(0.99)} p999 ${q(0.999)} max ${q(1)}`);
