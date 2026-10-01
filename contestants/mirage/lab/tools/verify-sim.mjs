// Сверка tank/sim.js с arena/engine.js до бита на случайных состояниях.
//   node lab/tools/verify-sim.mjs [N=20000]
import { MAPS, createRound, stepRound } from '../../arena/engine.js';
import * as S from '../../tank/sim.js';

const N = Number(process.argv[2] || 20000);
let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const pick = (a) => a[Math.floor(rnd() * a.length)];

const statsPool = [
  { armor: 0, engine: 0, gun: 5, reload: 5 },
  { armor: 3, engine: 3, gun: 2, reload: 2 },
  { armor: 0, engine: 5, gun: 5, reload: 0 },
  { armor: 2, engine: 1, gun: 2, reload: 5 },
];

let tankChecks = 0, tankFail = 0, bulletChecks = 0, bulletFail = 0, hitChecks = 0, hitFail = 0, fireChecks = 0, fireFail = 0;

for (let it = 0; it < N; it++) {
  const mapIndex = it % MAPS.length;
  const round = createRound({ mapIndex, tanks: [{ name: 'a', stats: pick(statsPool) }, { name: 'b', stats: pick(statsPool) }] });
  const walls = S.prepWalls(round.map.walls);
  // Случайные танки: половина кейсов — у стен (чтобы проверять выталкивание).
  for (const t of round.tanks) {
    if (rnd() < 0.5) {
      const w = pick(round.map.walls);
      t.x = w.x - 30 + rnd() * (w.w + 60);
      t.y = w.y - 30 + rnd() * (w.h + 60);
    } else {
      t.x = 10 + rnd() * 1580;
      t.y = 10 + rnd() * 880;
    }
    t.heading = (rnd() * 2 - 1) * Math.PI;
    t.turret = (rnd() * 2 - 1) * Math.PI;
    t.speed = (rnd() * 1.6 - 0.6) * t.stats.maxSpeed;
    t.reloadLeft = rnd() < 0.5 ? 0 : rnd() * 0.6;
  }
  // Танки далеко друг от друга: столкновение танков бот не моделирует.
  const [ta, tb] = round.tanks;
  if (Math.hypot(ta.x - tb.x, ta.y - tb.y) < 160) { tb.x = ta.x < 800 ? ta.x + 700 : ta.x - 700; }
  // Случайные пули.
  const nb = Math.floor(rnd() * 8);
  for (let i = 0; i < nb; i++) {
    const sp = 450 + 50 * Math.floor(rnd() * 6);
    const a = rnd() * 2 * Math.PI;
    let x, y;
    if (rnd() < 0.5) {
      const w = pick(round.map.walls);
      x = w.x - 20 + rnd() * (w.w + 40);
      y = w.y - 20 + rnd() * (w.h + 40);
    } else { x = rnd() * 1600; y = rnd() * 900; }
    const bounced = rnd() < 0.3;
    round.bullets.push({ id: round.nextBulletId++, owner: Math.floor(rnd() * 2), x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, damage: 30, bouncesLeft: bounced ? 0 : 1, bounced, age: rnd() * 4.1, dead: false });
  }
  const actions = round.tanks.map(() => ({
    throttle: pick([-1, -0.5, 0, 0.3, 1, rnd() * 2 - 1]),
    turn: pick([-1, 0, 1, rnd() * 2 - 1]),
    turretTurn: pick([-1, 0, 1, rnd() * 2 - 1]),
    fire: rnd() < 0.4,
  }));

  // Мой прогноз.
  const pre = round.tanks.map((t) => ({ x: t.x, y: t.y, h: t.heading, v: t.speed, turret: t.turret, reload: t.reloadLeft, st: t.stats }));
  const preBullets = round.bullets.map((b) => ({ ...b }));
  const mine = pre.map((p, i) => {
    const t = { x: p.x, y: p.y, h: p.h, v: p.v };
    S.stepTank(t, actions[i].throttle, actions[i].turn, p.st, walls);
    const turret = S.norm(p.turret + actions[i].turretTurn * S.TURRET_RATE * S.DT);
    return { ...t, turret };
  });
  // Новые пули (выстрел), затем трасса всех пуль на 1 тик.
  const all = preBullets.map((b) => ({ ...b }));
  const fired = [];
  for (let i = 0; i < 2; i++) {
    const reload = Math.max(0, pre[i].reload - S.DT);
    if (actions[i].fire && reload <= 0) {
      const nb2 = S.spawnBullet(mine[i].x, mine[i].y, mine[i].turret, pre[i].st.bulletSpeed, i, walls);
      fired.push(nb2 ? 'ok' : 'blocked');
      if (nb2) all.push({ ...nb2, damage: pre[i].st.damage });
    } else fired.push('none');
  }

  const events = stepRound(round, actions);

  // Танки.
  for (let i = 0; i < 2; i++) {
    const t = round.tanks[i];
    tankChecks++;
    const m = mine[i];
    if (t.x !== m.x || t.y !== m.y || t.heading !== m.h || t.speed !== m.v || t.turret !== m.turret) {
      if (!t.alive) continue; // убит в этот тик — скорость обнулена движком
      tankFail++;
      if (tankFail <= 3) console.log('TANK MISMATCH', it, round.map.name, 'side', i, { engine: { x: t.x, y: t.y, h: t.heading, v: t.speed }, mine: m, pre0: { x: pre[0].x, y: pre[0].y }, pre1: { x: pre[1].x, y: pre[1].y }, eng0: { x: round.tanks[0].x, y: round.tanks[0].y }, eng1: { x: round.tanks[1].x, y: round.tanks[1].y } });
    }
  }
  // Выстрелы.
  const shots = events.filter((e) => e.type === 'shot').map((e) => e.side);
  for (let i = 0; i < 2; i++) {
    fireChecks++;
    const engFired = shots.includes(i);
    if (engFired !== (fired[i] !== 'none')) { fireFail++; if (fireFail <= 5) console.log('FIRE MISMATCH', i, fired[i], engFired); }
  }
  // Пули: трасса на 1 тик, попадания в танки по позициям после хода.
  const tracks = S.traceBullets(all, walls, 1);
  const hitsEngine = new Set(events.filter((e) => e.type === 'hit' && e.cause !== 'zone').map((e) => e.side + ':' + e.bx.toFixed(9) + ':' + e.by_.toFixed(9)));
  let predictedHits = 0;
  const hitByMine = new Array(all.length).fill(-1);
  for (let bi = 0; bi < all.length; bi++) {
    for (let s = 0; s < tracks[bi].S; s++) {
      const code = tracks[bi].code[s];
      if (code === 0) continue;
      let hit = -1;
      for (let side = 0; side < 2; side++) {
        const t = mine[side];
        if (code === 1 && side === all[bi].owner) continue;
        if (Math.hypot(t.x - tracks[bi].xs[s], t.y - tracks[bi].ys[s]) < S.HIT_R) { hit = side; break; }
      }
      if (hit >= 0) { hitByMine[bi] = hit; break; }
    }
    if (hitByMine[bi] >= 0) predictedHits++;
  }
  const engineHits = events.filter((e) => e.type === 'hit' && e.cause !== 'zone').length;
  hitChecks++;
  if (engineHits !== predictedHits) { hitFail++; if (hitFail <= 5) console.log('HIT COUNT MISMATCH', engineHits, predictedHits); }
  // Сравниваем выживших пуль (без попавших в танки и без столкновений, в которых участвовали попавшие).
  if (predictedHits === 0 && engineHits === 0) {
    const engineLive = round.bullets;
    const mineLive = [];
    // Симулируем состояние пуль после тика: берём последнюю позицию трассы.
    for (let bi = 0; bi < all.length; bi++) {
      if (tracks[bi].deadAt <= 1) continue;
      mineLive.push(bi);
    }
    bulletChecks++;
    if (mineLive.length !== engineLive.length) {
      bulletFail++;
      if (bulletFail <= 5) console.log('BULLET COUNT MISMATCH', mineLive.length, engineLive.length);
    } else {
      for (let q = 0; q < mineLive.length; q++) {
        const tr = tracks[mineLive[q]];
        // последний записанный подшаг
        let lx = 0, ly = 0;
        for (let s = tr.S - 1; s >= 0; s--) { if (tr.xs[s] !== 0 || tr.ys[s] !== 0) { lx = tr.xs[s]; ly = tr.ys[s]; break; } }
        const eb = engineLive[q];
        if (eb.x !== lx || eb.y !== ly) {
          bulletFail++;
          if (bulletFail <= 5) console.log('BULLET POS MISMATCH', { ex: eb.x, ey: eb.y, lx, ly });
          break;
        }
      }
    }
  }
}

console.log(`танки: ${tankChecks - tankFail}/${tankChecks} совпали`);
console.log(`выстрелы: ${fireChecks - fireFail}/${fireChecks} совпали`);
console.log(`попадания: ${hitChecks - hitFail}/${hitChecks} совпали`);
console.log(`пули (позиции после тика): ${bulletChecks - bulletFail}/${bulletChecks} совпали`);
process.exit(tankFail + fireFail + hitFail + bulletFail ? 1 : 0);
