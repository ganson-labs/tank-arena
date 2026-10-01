// Test shooter «Упредитель»: exact linear lead (quadratic, muzzle offset), fires whenever aligned and
// the lead point is in line of sight. Holds a distance band (globalThis.__LEAD_DIST, default 420),
// grid BFS pathing when there is no line of sight. Only for checking the replica's pre-emptive dodge.
const D = globalThis.__LEAD_DIST ?? 420;
const norm = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const CELL = 25;
let grid = null, gridMap = null, path = [], pathTick = -99;
function segHits(x1, y1, x2, y2, r, pad) {
  const minX = r.x - pad, maxX = r.x + r.w + pad, minY = r.y - pad, maxY = r.y + r.h + pad;
  let t0 = 0, t1 = 1; const dx = x2 - x1, dy = y2 - y1;
  const clip = (p, q) => { if (Math.abs(p) < 1e-12) return q >= 0; const t = q / p; if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; } return true; };
  return clip(-dx, x1 - minX) && clip(dx, maxX - x1) && clip(-dy, y1 - minY) && clip(dy, maxY - y1);
}
const clear = (walls, x1, y1, x2, y2, pad) => !walls.some((w) => segHits(x1, y1, x2, y2, w, pad));
function build(arena) {
  const cols = Math.ceil(arena.width / CELL), rows = Math.ceil(arena.height / CELL), free = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const x = c * CELL + CELL / 2, y = r * CELL + CELL / 2;
    free[r * cols + c] = x > 26 && x < arena.width - 26 && y > 26 && y < arena.height - 26 && !arena.walls.some((w) => x > w.x - 26 && x < w.x + w.w + 26 && y > w.y - 26 && y < w.y + w.h + 26) ? 1 : 0;
  }
  return { cols, rows, free };
}
function cellOf(g, x, y) { const c = Math.max(0, Math.min(g.cols - 1, Math.floor(x / CELL))), r = Math.max(0, Math.min(g.rows - 1, Math.floor(y / CELL))); return r * g.cols + c; }
function bfs(g, from, to) {
  const prev = new Int32Array(g.cols * g.rows).fill(-1); const q = [from]; prev[from] = from;
  for (let i = 0; i < q.length; i++) { const u = q[i]; if (u === to) break; const r = (u / g.cols) | 0, c = u % g.cols;
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const rr = r + dr, cc = c + dc; if (rr < 0 || cc < 0 || rr >= g.rows || cc >= g.cols) continue; const v = rr * g.cols + cc; if (!g.free[v] || prev[v] !== -1) continue; prev[v] = u; q.push(v); } }
  if (prev[to] === -1) return [];
  const out = []; for (let n = to; n !== from; n = prev[n]) out.push({ x: (n % g.cols) * CELL + CELL / 2, y: ((n / g.cols) | 0) * CELL + CELL / 2 }); return out.reverse();
}
export default {
  name: 'Упредитель',
  motto: 'Линейное упреждение.',
  stats: { armor: 0, engine: 0, gun: 5, reload: 5 },
  init() { grid = null; path = []; pathTick = -99; },
  tick(s) {
    const { me, enemy, arena } = s;
    if (!grid || gridMap !== arena.mapName) { grid = build(arena); gridMap = arena.mapName; }
    const vb = me.stats.bulletSpeed;
    const Dx = enemy.x - me.x, Dy = enemy.y - me.y;
    const a = enemy.vx * enemy.vx + enemy.vy * enemy.vy - vb * vb;
    const b = 2 * (Dx * enemy.vx + Dy * enemy.vy) - 2 * 34 * vb;
    const c = Dx * Dx + Dy * Dy - 34 * 34;
    let t = Math.hypot(Dx, Dy) / vb;
    const disc = b * b - 4 * a * c;
    if (disc >= 0) { const r = (-b - Math.sqrt(disc)) / (2 * a); if (r > 0) t = r; }
    const ax = enemy.x + enemy.vx * t, ay = enemy.y + enemy.vy * t;
    const want = Math.atan2(ay - me.y, ax - me.x);
    const diff = norm(want - me.turret);
    const turretTurn = Math.max(-1, Math.min(1, diff / (2.8 / 30)));
    const mx = me.x + Math.cos(me.turret + turretTurn * 2.8 / 30) * 34, my = me.y + Math.sin(me.turret + turretTurn * 2.8 / 30) * 34;
    const los = clear(arena.walls, me.x, me.y, enemy.x, enemy.y, 6);
    const fire = Math.abs(diff) <= 2.8 / 30 && clear(arena.walls, mx, my, ax, ay, 6);
    // movement: hold the band when in line of sight, otherwise path toward the enemy
    const dist = Math.hypot(Dx, Dy);
    let tx = enemy.x, ty = enemy.y;
    if (!los || dist > D + 60) {
      if (s.tick - pathTick > 10 || !path.length) { path = bfs(grid, cellOf(grid, me.x, me.y), cellOf(grid, enemy.x, enemy.y)); pathTick = s.tick; }
      while (path.length > 1 && clear(arena.walls, me.x, me.y, path[1].x, path[1].y, 24)) path.shift();
      if (path.length) { tx = path[0].x; ty = path[0].y; if (Math.hypot(tx - me.x, ty - me.y) < 14) path.shift(); }
    }
    const face = Math.atan2(ty - me.y, tx - me.x);
    const hd = norm(face - me.heading);
    const turn = Math.max(-1, Math.min(1, hd * 3));
    let throttle = Math.cos(hd) > 0.5 ? 1 : 0.1;
    if (los && dist < D + 60) throttle = dist < D - 40 ? -1 : 0;
    if (Math.hypot(me.x - s.zone.x, me.y - s.zone.y) > s.zone.radius - 60) { const zf = norm(Math.atan2(s.zone.y - me.y, s.zone.x - me.x) - me.heading); return { throttle: 1, turn: Math.max(-1, Math.min(1, zf * 3)), turretTurn, fire }; }
    return { throttle, turn, turretTurn, fire };
  },
};
