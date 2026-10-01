// Hit forensics: for every bullet that hits bot A, did A's planner foresee it?
//   node lab/sparring/champ-dev/hits.mjs --vs hunter --rounds 16 [--jitter seed] [--quiet]
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MAPS, createRound, stepRound, botView, roundPlan } from '../../../arena/engine.js';
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const a = process.argv.slice(2);
const o = { vs: 'hunter', rounds: 16, jitter: null, me: 'lab/sparring/champ-dev', quiet: false, detail: 0 };
for (let i = 0; i < a.length; i++) { const k = a[i].replace(/^--/, ''); if (k === 'quiet') { o.quiet = true; continue; } o[k] = isNaN(+a[i + 1]) ? a[i + 1] : +a[i + 1]; i++; }
const dirOf = (spec) => [resolve(root, spec), join(root, 'arena/sparring', spec)].find((c) => existsSync(join(c, 'bot.js')));
const A = (await import(pathToFileURL(join(dirOf(o.me), 'bot.js')).href + '?h0')).default;
const B = (await import(pathToFileURL(join(dirOf(o.vs), 'bot.js')).href + '?h1')).default;
A.debug.trace = true;
let seed = o.jitter ?? 1;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
const buckets = {}; const shotDist = new Map();
const selfLog = []; const myKind = new Map();
const summary = { selfHits: 0, hits: 0, foreseenAtFirstSight: 0, foreseenLast: 0, surprise: 0, ric: 0, shotsB: 0 };
for (let r = 0; r < o.rounds; r++) {
  const plan = roundPlan(r);
  const aSide = plan.swap ? 1 : 0;
  const bots = aSide === 0 ? [A, B] : [B, A];
  const round = createRound({ mapIndex: plan.mapIndex, tanks: bots.map((b) => ({ name: b.name, stats: b.stats })) });
  if (o.jitter !== null) for (const t of round.tanks) {
    for (let tries = 0; tries < 50; tries++) {
      const x = t.x + (rnd() * 2 - 1) * 60, y = t.y + (rnd() * 2 - 1) * 160;
      if (!round.map.walls.some((w) => x > w.x - 30 && x < w.x + w.w + 30 && y > w.y - 30 && y < w.y + w.h + 30) && y > 30 && y < 870) { t.x = x; t.y = y; break; }
    }
  }
  bots.forEach((b, s) => b.init?.({ round: r, side: s, mapName: round.map.name, view: botView(round, s) }));
  const first = new Map(); // bullet id -> {tick, dist, fireX, fireY}
  const pred = new Map(); // bullet id -> [tick of predictions where A's best plan is hit by it]
  const seenBy = new Map(); // bullet id -> first tick A saw it
  const ring = [];
  while (!round.over) {
    const viewA = botView(round, aSide);
    const acts = [0, 1].map((s) => bots[s].tick(s === aSide ? viewA : botView(round, s)));
    const d = A.debug.last;
    { const t = round.tanks[aSide], f = round.tanks[1 - aSide]; ring.push(`   tick ${round.tick} me(${t.x.toFixed(0)},${t.y.toFixed(0)} h${t.heading.toFixed(2)} v${t.speed.toFixed(0)}) en(${f.x.toFixed(0)},${f.y.toFixed(0)} h${f.heading.toFixed(2)} v${f.speed.toFixed(0)} tur${f.turret.toFixed(2)} rl${f.reloadLeft.toFixed(2)}) d${Math.hypot(t.x - f.x, t.y - f.y).toFixed(0)} act(${acts[aSide].throttle},${acts[aSide].turn}) ${d ? `${d.mode} want${d.want} min${d.minD} jr${d.jr} cost${d.cost} thr${d.threat ? d.threat.id + '@' + d.threat.k : '-'}` : ''}`); if (ring.length > 30) ring.shift(); }
    for (const b of viewA.bullets) if (!b.mine && !seenBy.has(b.id)) seenBy.set(b.id, round.tick);
    if (d && d.threat) { if (!pred.has(d.threat.id)) pred.set(d.threat.id, []); pred.get(d.threat.id).push(round.tick); }
    const before = round.bullets.map((b) => ({ id: b.id, owner: b.owner, x: b.x, y: b.y, bounced: b.bounced }));
    const kindNow = acts[aSide] && acts[aSide].fire ? A.debug.fireKind : null;
    A.debug.fireKind = null;
    const ev = stepRound(round, acts);
    if (kindNow) for (const b of round.bullets) if (b.owner === aSide && !before.some((q) => q.id === b.id)) myKind.set(r + ':' + b.id, { kind: kindNow, tick: round.tick - 1, d: Math.hypot(round.tanks[0].x - round.tanks[1].x, round.tanks[0].y - round.tanks[1].y) });
    for (const e of ev) if (e.type === 'hit' && e.cause === 'self' && e.side === aSide) {
      const alive = new Set(round.bullets.map((b) => b.id));
      const me = round.tanks[aSide];
      const cand = before.filter((b) => b.owner === aSide && !alive.has(b.id)).sort((p, q) => Math.hypot(p.x - me.x, p.y - me.y) - Math.hypot(q.x - me.x, q.y - me.y))[0];
      const info = cand ? myKind.get(r + ':' + cand.id) : null;
      summary.selfHits++;
      console.log(`SELF R${r + 1} ${round.map.name} t=${round.time.toFixed(2)} bullet ${cand ? cand.id : '?'} kind ${info ? info.kind : '?'} fired@${info ? info.tick : '?'} (flight ${info ? round.tick - info.tick : '?'} ticks) dist-at-fire ${info ? info.d.toFixed(0) : '?'}`);
    }
    for (const e of ev) if (e.type === 'shot' && e.side !== aSide) {
      const t = round.tanks[aSide], f = round.tanks[1 - aSide];
      summary.shotsB++;
      const nb = round.bullets.find((b) => b.owner !== aSide && !before.some((q) => q.id === b.id));
      const dd = Math.hypot(t.x - f.x, t.y - f.y);
      const bk = Math.min(9, Math.floor(dd / 50)) * 50;
      buckets[bk] = buckets[bk] || { shots: 0, hits: 0 };
      buckets[bk].shots++;
      if (nb) shotDist.set(r + ':' + nb.id, bk);
    }
    for (const e of ev) {
      if (e.type !== 'hit' || e.cause === 'zone' || e.side !== aSide || e.by === aSide) continue;
      const alive = new Set(round.bullets.map((b) => b.id));
      const me = round.tanks[aSide];
      const cand = before.filter((b) => b.owner !== aSide && !alive.has(b.id)).sort((p, q) => Math.hypot(p.x - me.x, p.y - me.y) - Math.hypot(q.x - me.x, q.y - me.y))[0];
      const id = cand ? cand.id : (round.nextBulletId - 1);
      const seen = seenBy.get(id);
      const pr = pred.get(id) || [];
      const atFirst = seen !== undefined && pr.includes(seen);
      const last = pr.includes(round.tick - 1) || pr.includes(round.tick);
      summary.hits++;
      { const bk = shotDist.get(r + ':' + id); if (bk !== undefined) buckets[bk].hits++; }
      if (atFirst) summary.foreseenAtFirstSight++;
      if (last) summary.foreseenLast++;
      if (!last) summary.surprise++;
      if (e.ricochet) summary.ric++;
      const dist = Math.hypot(round.tanks[0].x - round.tanks[1].x, round.tanks[0].y - round.tanks[1].y);
      if (o.detail) console.log(ring.slice(-(Math.min(30, (seen === undefined ? 10 : round.tick - seen + 8)))).join('\n'));
      if (!o.quiet) console.log(`R${r + 1} ${round.map.name} t=${round.time.toFixed(2)} bullet ${id}${e.ricochet ? ' ric' : ''} seen@${seen} hit@${round.tick} flight ${seen === undefined ? '?' : round.tick - seen + 1} dist ${dist.toFixed(0)} | predicted ticks ${pr.length ? pr[0] + '..' + pr[pr.length - 1] + ' (' + pr.length + ')' : 'none'} firstSight ${atFirst ? 'HIT' : 'miss'} last ${last ? 'HIT' : 'miss'}`);
    }
  }
}
console.log(JSON.stringify(summary));
console.log('by fire distance:', Object.entries(buckets).sort((a,b)=>a[0]-b[0]).map(([k,v])=>`${k}-${+k+50}: ${v.hits}/${v.shots}`).join('  '));
