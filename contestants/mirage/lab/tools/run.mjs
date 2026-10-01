#!/usr/bin/env node
// Параллельный стенд: A против B, много раундов, случайный сдвиг старта с фиксированным сидом.
//   node lab/tools/run.mjs tank lab/sparring/champ --rounds 64 --workers 16 --seed 1 [--map Каньон] [--jitter 1] [--out name]
// Каждый поток — отдельный «матч»: модули ботов грузятся один раз, раунды идут подряд (как в турнире).
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

function resolveBotDir(spec) {
  const c = [resolve(process.cwd(), spec), resolve(root, spec), join(root, 'arena', 'sparring', spec)];
  for (const d of c) if (existsSync(join(d, 'bot.js'))) return d;
  throw new Error('нет bot.js для ' + spec);
}

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

if (isMainThread) {
  const argv = process.argv.slice(2);
  const opts = { a: 'tank', b: 'hunter', rounds: 32, workers: 16, seed: 1, map: null, jitter: 1, out: null, quiet: false, tag: '', budget: 50 };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--rounds') opts.rounds = Number(argv[++i]);
    else if (x === '--workers') opts.workers = Number(argv[++i]);
    else if (x === '--seed') opts.seed = Number(argv[++i]);
    else if (x === '--map') opts.map = argv[++i];
    else if (x === '--jitter') opts.jitter = Number(argv[++i]);
    else if (x === '--out') opts.out = argv[++i];
    else if (x === '--quiet') opts.quiet = true;
    else if (x === '--budget') opts.budget = Number(argv[++i]);
    else pos.push(x);
  }
  if (pos[0]) opts.a = pos[0];
  if (pos[1]) opts.b = pos[1];
  const aDir = resolveBotDir(opts.a);
  const bDir = resolveBotDir(opts.b);
  const W = Math.max(1, Math.min(opts.workers, opts.rounds));
  const jobs = Array.from({ length: W }, () => []);
  for (let i = 0; i < opts.rounds; i++) jobs[i % W].push(i);
  const t0 = performance.now();
  const results = [];
  let done = 0;
  await Promise.all(jobs.map((rounds, wi) => new Promise((res, rej) => {
    const w = new Worker(fileURLToPath(import.meta.url), { workerData: { aDir, bDir, rounds, seed: opts.seed, map: opts.map, jitter: opts.jitter, wi, budget: opts.budget } });
    w.on('message', (m) => {
      if (m.type === 'round') {
        results.push(m.r);
        done++;
        if (!opts.quiet && process.stderr.isTTY) process.stderr.write(`\r${done}/${opts.rounds}`);
      } else if (m.type === 'error') console.error(m.error);
    });
    w.on('error', rej);
    w.on('exit', () => res());
  })));
  if (!opts.quiet && process.stderr.isTTY) process.stderr.write('\r');
  results.sort((x, y) => x.i - y.i);
  summarize(results, opts, (performance.now() - t0) / 1000);
  if (opts.out) {
    mkdirSync(join(root, 'lab', 'results'), { recursive: true });
    writeFileSync(join(root, 'lab', 'results', opts.out + '.json'), JSON.stringify({ opts, results }, null, 0));
  }
} else {
  const { aDir, bDir, rounds, seed, map, jitter, wi, budget } = workerData;
  globalThis.__MIRAGE_BUDGET_SCALE = budget;
  const eng = await import(pathToFileURL(join(root, 'arena', 'engine.js')).href);
  const load = async (dir, inst) => {
    const mod = await import(pathToFileURL(join(dir, 'bot.js')).href + `?w=${wi}&i=${inst}`);
    return mod.default ?? mod;
  };
  const A = await load(aDir, 'a');
  const B = await load(bDir, 'b');
  const mapFilter = map == null ? -1 : eng.MAPS.findIndex((m, i) => m.name === map || String(i) === String(map));
  for (const i of rounds) {
    try {
      parentPort.postMessage({ type: 'round', r: playRound(eng, A, B, i, seed, mapFilter, jitter) });
    } catch (e) {
      parentPort.postMessage({ type: 'error', error: String(e?.stack || e) });
    }
  }
}

function placeFree(eng, round, t, rng, jitter) {
  const walls = round.map.walls;
  const x0 = t.x, y0 = t.y;
  for (let tries = 0; tries < 50; tries++) {
    const x = x0 + (rng() * 2 - 1) * 60 * jitter;
    const y = y0 + (rng() * 2 - 1) * 200 * jitter;
    if (x < 30 || x > 1570 || y < 30 || y > 870) continue;
    const bad = walls.some((w) => x > w.x - 30 && x < w.x + w.w + 30 && y > w.y - 30 && y < w.y + w.h + 30);
    if (bad) continue;
    t.x = x; t.y = y;
    t.heading = eng.normalizeAngle(t.heading + (rng() * 2 - 1) * 0.6 * jitter);
    t.turret = t.heading;
    return;
  }
}

function playRound(eng, A, B, i, seed, mapFilter, jitter) {
  const plan = eng.roundPlan(i);
  const mapIndex = mapFilter >= 0 ? mapFilter : plan.mapIndex;
  const aSide = plan.swap ? 1 : 0;
  const bySide = aSide === 0 ? [A, B] : [B, A];
  const round = eng.createRound({ mapIndex, tanks: bySide.map((b) => ({ name: b.name, stats: b.stats })) });
  const rng = mulberry(seed * 100003 + i * 7919);
  if (jitter > 0) for (const t of round.tanks) placeFree(eng, round, t, rng, jitter);
  const times = [[], []];
  const call = (s, fn, arg) => {
    const t0 = performance.now();
    let r = null;
    try { r = bySide[s][fn]?.(arg); } catch (e) { r = null; if (fn === 'tick') errs[s]++; }
    if (fn === 'tick') times[s].push(performance.now() - t0);
    return r;
  };
  const errs = [0, 0];
  for (let s = 0; s < 2; s++) call(s, 'init', { round: i, side: s, mapName: round.map.name, view: eng.botView(round, s) });
  const aBrain = A._brain?.mem;
  if (aBrain) aBrain.shotLog = [];
  const outcome = new Map(); // id пули A -> 'hit' | 'clash' | 'gone'
  const spawnInfo = new Map();
  const hits = [];
  const hpAt = {};
  let prevBullets = new Map();
  while (!round.over) {
    const views = [eng.botView(round, 0), eng.botView(round, 1)];
    const acts = [call(0, 'tick', views[0]), call(1, 'tick', views[1])];
    const before = new Set(round.bullets.map((b) => b.id));
    const snap = round.tanks.map((t) => ({ x: t.x, y: t.y, h: t.heading, v: t.speed, reload: t.reloadLeft }));
    const ev = eng.stepRound(round, acts);
    for (const b of round.bullets) {
      if (!before.has(b.id) && !spawnInfo.has(b.id)) {
        const sh = round.tanks[b.owner], tg = round.tanks[1 - b.owner];
        spawnInfo.set(b.id, { t: round.time, owner: b.owner, sx: sh.x, sy: sh.y, tx: tg.x, ty: tg.y, th: tg.heading, tv: tg.speed, dist: Math.hypot(sh.x - tg.x, sh.y - tg.y) });
      }
    }
    const nowIds = new Set(round.bullets.map((b) => b.id));
    // точки рикошета: ближайшая пуля того же владельца
    for (const e of ev) {
      if (e.type !== 'ricochet') continue;
      let best = null, bd = Infinity;
      for (const b of round.bullets) { if (b.owner !== e.owner) continue; const d = Math.hypot(b.x - e.x, b.y - e.y); if (d < bd) { bd = d; best = b; } }
      if (best && spawnInfo.has(best.id) && bd < 30) spawnInfo.get(best.id).bounce = [Math.round(e.x), Math.round(e.y)];
    }
    for (const e of ev) {
      if (e.type !== 'hit' || e.cause === 'zone') continue;
      // Найти пулю: исчезнувшая, того же владельца, ближайшая к точке попадания.
      let best = null, bd = Infinity;
      for (const [id, pb] of prevBullets) {
        if (nowIds.has(id) || pb.owner !== e.by) continue;
        const d = Math.hypot(pb.x - e.bx, pb.y - e.by_);
        if (d < bd) { bd = d; best = id; }
      }
      // или пуля, выпущенная в этот же тик
      if (best === null || bd > 60) {
        for (const [id, si] of spawnInfo) if (si.t === round.time && si.owner === e.by && !nowIds.has(id)) best = id;
      }
      const si = best !== null ? spawnInfo.get(best) : null;
      const victim = e.side;
      hits.push({
        t: +round.time.toFixed(2), victimIsA: victim === aSide, self: e.cause === 'self', ricochet: !!e.ricochet,
        fireDist: si ? Math.round(si.dist) : null, flight: si ? +(round.time - si.t).toFixed(3) : null,
        victimAtFire: si ? { h: +si.th.toFixed(3), v: Math.round(si.tv), losAngle: +Math.atan2(si.ty - si.sy, si.tx - si.sx).toFixed(3), x: Math.round(si.tx), y: Math.round(si.ty), sx: Math.round(si.sx), sy: Math.round(si.sy) } : null,
        at: [Math.round(round.tanks[victim].x), Math.round(round.tanks[victim].y)], bounce: si?.bounce || null,
      });
    }
    // исходы пуль A: попадание в B, взаимное уничтожение, иначе исчезла
    for (const e of ev) {
      if (e.type === 'hit' && e.cause === 'bullet' && e.by === aSide) {
        let best = null, bd = Infinity;
        for (const [id, pb] of prevBullets) { if (nowIds.has(id) || pb.owner !== aSide) continue; const d = Math.hypot(pb.x - e.bx, pb.y - e.by_); if (d < bd) { bd = d; best = id; } }
        if (best === null || bd > 60) for (const [id, si] of spawnInfo) if (si.t === round.time && si.owner === aSide && !nowIds.has(id)) best = id;
        if (best !== null) outcome.set(best, 'hit');
      }
      if (e.type === 'clash') {
        for (const [id, pb] of prevBullets) { if (nowIds.has(id) || pb.owner !== aSide || outcome.has(id)) continue; if (Math.hypot(pb.x - e.x, pb.y - e.y) < 60) { outcome.set(id, 'clash'); break; } }
      }
    }
    prevBullets = new Map(round.bullets.map((b) => [b.id, { x: b.x, y: b.y, owner: b.owner }]));
    for (const T of [30, 60, 90, 100]) if (round.tick === T * 30) hpAt[T] = [Math.ceil(round.tanks[aSide].hp), Math.ceil(round.tanks[1 - aSide].hp)];
    // пули, выпущенные в этот тик и уже исчезнувшие, тоже учтены через spawnInfo
    void snap;
  }
  const a = round.tanks[aSide], b = round.tanks[1 - aSide];
  const tstat = (arr) => {
    if (!arr.length) return { avg: 0, max: 0, p99: 0 };
    const s = [...arr].sort((x, y) => x - y);
    return { avg: arr.reduce((p, q) => p + q, 0) / arr.length, max: s[s.length - 1], p99: s[Math.floor(s.length * 0.99)] };
  };
  // сопоставление выстрелов A (по тику) с исходами
  let shots = null;
  if (aBrain?.shotLog) {
    const byTime = new Map();
    for (const [id, si] of spawnInfo) if (si.owner === aSide) byTime.set(Math.round(si.t * 30), id);
    shots = aBrain.shotLog.map((sh) => { const id = byTime.get(sh.tick + 1); return { ...sh, out: id === undefined ? 'nospawn' : outcome.get(id) || 'miss' }; });
  }
  return {
    i, map: round.map.name, aSide, shots, winner: round.winner === null ? 'draw' : round.winner === aSide ? 'A' : 'B', reason: round.endReason, time: +round.time.toFixed(1),
    aHp: Math.ceil(a.hp), bHp: Math.ceil(b.hp), aMax: a.stats.maxHp, bMax: b.stats.maxHp,
    aT: a.tally, bT: b.tally, hits, hpAt, timeA: tstat(times[aSide]), timeB: tstat(times[1 - aSide]), errA: errs[aSide], errB: errs[1 - aSide],
  };
}

function summarize(rs, opts, secs) {
  const n = rs.length;
  const w = rs.filter((r) => r.winner === 'A').length;
  const l = rs.filter((r) => r.winner === 'B').length;
  const d = n - w - l;
  const sum = (f) => rs.reduce((p, r) => p + f(r), 0);
  const pct = (x, y) => (y ? ((100 * x) / y).toFixed(1) + '%' : '—');
  console.log(`\n${opts.a}  vs  ${opts.b}   ${n} раундов, сид ${opts.seed}, сдвиг ${opts.jitter}, ${secs.toFixed(1)} с`);
  console.log(`ИТОГ: ${w} побед, ${l} поражений, ${d} ничьих  (${pct(w, n)} / ${pct(l, n)})`);
  const maps = [...new Set(rs.map((r) => r.map))];
  for (const m of maps) {
    const mr = rs.filter((r) => r.map === m);
    const mw = mr.filter((r) => r.winner === 'A').length, ml = mr.filter((r) => r.winner === 'B').length;
    const kills = mr.filter((r) => r.reason === 'kill').length;
    console.log(`  ${m.padEnd(9)} ${String(mw).padStart(3)}-${String(ml).padStart(3)}-${String(mr.length - mw - ml).padStart(3)}  уничтожений ${kills}/${mr.length}, ср. время ${(mr.reduce((p, r) => p + r.time, 0) / mr.length).toFixed(0)}с`);
  }
  const aShots = sum((r) => r.aT.shots), aHits = sum((r) => r.aT.hits), bShots = sum((r) => r.bT.shots), bHits = sum((r) => r.bT.hits);
  console.log(`A: выстрелов ${aShots} (${(aShots / n).toFixed(1)}/раунд), попаданий ${aHits} (${pct(aHits, aShots)}), рикошетом ${sum((r) => r.aT.ricochetHits)}, урон себе ${sum((r) => r.aT.selfDamage).toFixed(0)}, перехватов ${sum((r) => r.aT.intercepts)}, аптечек ${sum((r) => r.aT.kits)}, зона ${sum((r) => r.aT.zoneDamage).toFixed(0)}`);
  console.log(`B: выстрелов ${bShots} (${(bShots / n).toFixed(1)}/раунд), попаданий ${bHits} (${pct(bHits, bShots)}), рикошетом ${sum((r) => r.bT.ricochetHits)}, урон себе ${sum((r) => r.bT.selfDamage).toFixed(0)}, перехватов ${sum((r) => r.bT.intercepts)}, аптечек ${sum((r) => r.bT.kits)}, зона ${sum((r) => r.bT.zoneDamage).toFixed(0)}`);
  // Попадания по A: дистанция выстрела и время
  const onA = rs.flatMap((r) => r.hits.filter((h) => h.victimIsA && !h.self));
  const onB = rs.flatMap((r) => r.hits.filter((h) => !h.victimIsA && !h.self));
  const hist = (hs) => {
    const bins = [0, 150, 250, 300, 350, 400, 450, 500, 600, 800, 5000];
    const c = new Array(bins.length - 1).fill(0);
    for (const h of hs) { if (h.fireDist == null) continue; for (let k = 0; k < bins.length - 1; k++) if (h.fireDist >= bins[k] && h.fireDist < bins[k + 1]) c[k]++; }
    return bins.slice(0, -1).map((b, k) => (c[k] ? `${b}+:${c[k]}` : '')).filter(Boolean).join(' ');
  };
  const tHist = (hs) => {
    const c = {};
    for (const h of hs) { const k = h.t < 60 ? '<60' : h.t < 90 ? '60-90' : h.t < 100 ? '90-100' : '100+'; c[k] = (c[k] || 0) + 1; }
    return Object.entries(c).map(([k, v]) => `${k}:${v}`).join(' ');
  };
  console.log(`по A: ${onA.length} попаданий (рикошет ${onA.filter((h) => h.ricochet).length}) · дистанции ${hist(onA)} · время ${tHist(onA)}`);
  console.log(`по B: ${onB.length} попаданий (рикошет ${onB.filter((h) => h.ricochet).length}) · дистанции ${hist(onB)} · время ${tHist(onB)}`);
  const ta = rs.map((r) => r.timeA), tb = rs.map((r) => r.timeB);
  const agg = (ts) => ({ avg: ts.reduce((p, q) => p + q.avg, 0) / ts.length, max: Math.max(...ts.map((q) => q.max)), p99: Math.max(...ts.map((q) => q.p99)) });
  const A = agg(ta), B = agg(tb);
  console.log(`время тика A: ср ${A.avg.toFixed(2)} мс, p99 ${A.p99.toFixed(1)}, макс ${A.max.toFixed(1)}; ошибок ${sum((r) => r.errA)}`);
  console.log(`время тика B: ср ${B.avg.toFixed(2)} мс, p99 ${B.p99.toFixed(1)}, макс ${B.max.toFixed(1)}; ошибок ${sum((r) => r.errB)}`);
  const hpA = sum((r) => r.aHp / r.aMax) / n, hpB = sum((r) => r.bHp / r.bMax) / n;
  console.log(`средняя доля HP в конце: A ${(100 * hpA).toFixed(0)}%, B ${(100 * hpB).toFixed(0)}%`);
}
