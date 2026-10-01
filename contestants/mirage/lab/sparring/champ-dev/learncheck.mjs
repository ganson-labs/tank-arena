// Print learned hypothesis scores after a match: node lab/sparring/champ-dev/learncheck.mjs [opponent] [rounds]
import { createRound, stepRound, botView, roundPlan } from '../../../arena/engine.js';
const opp = process.argv[2] || 'hunter', rounds = Number(process.argv[3] || 8);
const A = (await import('./bot.js?lc')).default;
const B = (await import(opp.startsWith('lab') ? '../../../' + opp + '/bot.js' : '../../../arena/sparring/' + opp + '/bot.js')).default;
const names = ['continue', 'fwd', 'fwd+L', 'fwd+R', 'stop', 'stop+L', 'stop+R', 'rev', 'rev+L', 'rev+R'];
for (let i = 0; i < rounds; i++) {
  const plan = roundPlan(i);
  const bots = plan.swap ? [B, A] : [A, B];
  const round = createRound({ mapIndex: plan.mapIndex, tanks: bots.map((b) => ({ name: b.name, stats: b.stats })) });
  bots.forEach((b, s) => b.init?.({ round: i, side: s, mapName: round.map.name, view: botView(round, s) }));
  while (!round.over) stepRound(round, [0, 1].map((s) => bots[s].tick(botView(round, s))));
  console.log(`after round ${i + 1}: ` + names.map((n, h) => `${n} ${A.hypScore[h].toFixed(2)}`).join(' | '));
}
