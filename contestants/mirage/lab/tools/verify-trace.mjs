// Сверка многотиковой трассы пуль (рикошет, взаимное уничтожение, время жизни) с движком.
import { MAPS, createRound, stepRound } from '../../arena/engine.js';
import * as S from '../../tank/sim.js';
let seed = 777;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
let checks = 0, fails = 0, skipped = 0;
const N = Number(process.argv[2] || 3000);
for (let it = 0; it < N; it++) {
  const round = createRound({ mapIndex: it % 4, tanks: [{ name: 'a', stats: { armor: 0, engine: 0, gun: 5, reload: 5 } }, { name: 'b', stats: { armor: 0, engine: 0, gun: 0, reload: 5 } }] });
  const walls = S.prepWalls(round.map.walls);
  // Танки вне поля боя пуль: в углах, пули их почти не трогают.
  round.tanks[0].x = 30; round.tanks[0].y = 30; round.tanks[1].x = 1570; round.tanks[1].y = 870;
  const nb = 2 + Math.floor(rnd() * 10);
  for (let i = 0; i < nb; i++) {
    const sp = 450 + 50 * Math.floor(rnd() * 6);
    const a = rnd() * 2 * Math.PI;
    const x = 200 + rnd() * 1200, y = 100 + rnd() * 700;
    // пары встречных пуль, чтобы проверять столкновения
    round.bullets.push({ id: round.nextBulletId++, owner: i % 2, x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, damage: 1, bouncesLeft: 1, bounced: false, age: rnd() * 2, dead: false });
    if (rnd() < 0.4) {
      const d = 30 + rnd() * 200;
      round.bullets.push({ id: round.nextBulletId++, owner: (i + 1) % 2, x: x + Math.cos(a) * d, y: y + Math.sin(a) * d, vx: -Math.cos(a + 0.02 * (rnd() - 0.5)) * sp, vy: -Math.sin(a + 0.02 * (rnd() - 0.5)) * sp, damage: 1, bouncesLeft: 1, bounced: false, age: 0, dead: false });
    }
  }
  const ids = round.bullets.map((b) => b.id);
  const tracks = S.traceBullets(round.bullets.map((b) => ({ ...b })), walls, 130);
  const idle = { throttle: 0, turn: 0, turretTurn: 0, fire: false };
  let bad = false, hitTank = false;
  for (let k = 0; k < 130 && !bad; k++) {
    const ev = stepRound(round, [idle, idle]);
    if (ev.some((e) => e.type === 'hit' && e.cause !== 'zone')) { hitTank = true; break; }
    const alive = new Map(round.bullets.map((b) => [b.id, b]));
    for (let bi = 0; bi < ids.length; bi++) {
      const tr = tracks[bi];
      const eb = alive.get(ids[bi]);
      const mineAlive = k < tr.goneAt;
      if (!!eb !== mineAlive) { bad = true; if (fails < 5) console.log('ALIVE MISMATCH', it, k, bi, !!eb, tr.deadAt); break; }
      if (!eb) continue;
      // последняя позиция тика k
      let lx = NaN, ly = NaN;
      for (let s = tr.S - 1; s >= 0; s--) { const j = k * tr.S + s; if (tr.xs[j] !== 0 || tr.ys[j] !== 0) { lx = tr.xs[j]; ly = tr.ys[j]; break; } }
      if (lx !== eb.x || ly !== eb.y) { bad = true; if (fails < 5) console.log('POS MISMATCH', it, k, bi, lx, eb.x, ly, eb.y); break; }
    }
  }
  if (hitTank) { skipped++; continue; }
  checks++;
  if (bad) fails++;
}
console.log(`трассы пуль на 130 тиков: ${checks - fails}/${checks} совпали (пропущено из-за попадания в танк: ${skipped})`);
