// Exact copy of the arena physics (tank step with walls, bullets with substeps,
// one ricochet, lifetime, bullet-bullet clashes). Every arithmetic operation is
// written in the same order as the engine so results are bit-identical;
// verify.mjs checks this against arena/engine.js on random states.
// No allocations in the hot paths: contact results go through the shared C array.

export const DT = 1 / 30;
export const AW = 1600;
export const AH = 900;
export const TANK_R = 24;
export const BULLET_R = 5;
export const BULLET_LIFE = 4;
export const MUZZLE = TANK_R + 10;
export const ACCEL = 420;
export const REVERSE = 0.6;
export const TURRET_RATE = 2.8;
export const HIT_R = TANK_R + BULLET_R; // 29
export const CLASH_R = BULLET_R * 2 + 2; // 12
export const KIT_R = 16;
export const KIT_PICK_R = TANK_R + KIT_R; // 40
export const ZONE_START_R = Math.hypot(AW / 2, AH / 2) + 60;
export const ZONE_T0 = 60;
export const ZONE_T1 = 100;
export const ZONE_R1 = 170;
export const ZONE_DPS = 20;

// Contact output of circleRect / boundsHit: normal x, normal y, depth.
export const C = new Float64Array(3);

export function normAngle(a) {
  a = (a + Math.PI) % (2 * Math.PI);
  if (a < 0) a += 2 * Math.PI;
  return a - Math.PI;
}

export function zoneRadiusAt(t) {
  if (t <= ZONE_T0) return ZONE_START_R;
  let k = (t - ZONE_T0) / (ZONE_T1 - ZONE_T0);
  k = k < 0 ? 0 : k > 1 ? 1 : k;
  return ZONE_START_R + (ZONE_R1 - ZONE_START_R) * k;
}

// Walls with precomputed far edges (x + w and y + h are the same doubles the engine computes).
export function prepWalls(walls) {
  return walls.map((w, i) => ({ x: w.x, y: w.y, w: w.w, h: w.h, x2: w.x + w.w, y2: w.y + w.h, i }));
}

export function circleRect(cx, cy, r, w) {
  const px = cx < w.x ? w.x : cx > w.x2 ? w.x2 : cx;
  const py = cy < w.y ? w.y : cy > w.y2 ? w.y2 : cy;
  const dx = cx - px;
  const dy = cy - py;
  const d2 = dx * dx + dy * dy;
  if (d2 >= r * r) return false;
  if (d2 > 1e-9) {
    const d = Math.sqrt(d2);
    C[0] = dx / d;
    C[1] = dy / d;
    C[2] = r - d;
    return true;
  }
  const left = cx - w.x;
  const right = w.x2 - cx;
  const top = cy - w.y;
  const bottom = w.y2 - cy;
  const m = Math.min(left, right, top, bottom);
  if (m === left) { C[0] = -1; C[1] = 0; C[2] = left + r; }
  else if (m === right) { C[0] = 1; C[1] = 0; C[2] = right + r; }
  else if (m === top) { C[0] = 0; C[1] = -1; C[2] = top + r; }
  else { C[0] = 0; C[1] = 1; C[2] = bottom + r; }
  return true;
}

// Arena border contact for a bullet (radius BULLET_R).
export function boundsHitB(x, y) {
  const r = BULLET_R;
  if (x < r) { C[0] = 1; C[1] = 0; C[2] = r - x; return true; }
  if (x > AW - r) { C[0] = -1; C[1] = 0; C[2] = x - (AW - r); return true; }
  if (y < r) { C[0] = 0; C[1] = 1; C[2] = r - y; return true; }
  if (y > AH - r) { C[0] = 0; C[1] = -1; C[2] = y - (AH - r); return true; }
  return false;
}

// Tank state T = Float64Array [x, y, heading, speed].
export function resolveTank(T, walls) {
  let x = T[0];
  let y = T[1];
  let bumped = false;
  const n = walls.length;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < n; i++) {
      if (circleRect(x, y, TANK_R, walls[i])) {
        x += C[0] * C[2];
        y += C[1] * C[2];
        bumped = true;
      }
    }
    const nx = x < TANK_R ? TANK_R : x > AW - TANK_R ? AW - TANK_R : x;
    const ny = y < TANK_R ? TANK_R : y > AH - TANK_R ? AH - TANK_R : y;
    if (nx !== x || ny !== y) bumped = true;
    x = nx;
    y = ny;
  }
  T[0] = x;
  T[1] = y;
  if (bumped) T[3] *= 0.6;
  return bumped;
}

// One engine tick for a lone tank: move, wall resolve, (tank-tank skipped), wall resolve again.
// Returns the number of wall-resolve calls that bumped (0..2).
export function stepTank(T, throttle, turn, maxSpeed, turnRate, walls) {
  const h = normAngle(T[2] + turn * turnRate * DT);
  T[2] = h;
  const target = throttle >= 0 ? throttle * maxSpeed : throttle * maxSpeed * REVERSE;
  const lim = ACCEL * DT;
  let dv = target - T[3];
  dv = dv < -lim ? -lim : dv > lim ? lim : dv;
  const v = T[3] + dv;
  T[3] = v;
  T[0] += Math.cos(h) * v * DT;
  T[1] += Math.sin(h) * v * DT;
  let b = 0;
  if (resolveTank(T, walls)) b++;
  if (resolveTank(T, walls)) b++;
  return b;
}

// Walls that can touch a tank staying within `reach` px of (x, y) during a simulation.
export function wallsNear(walls, x, y, reach) {
  const out = [];
  for (const w of walls) {
    const px = x < w.x ? w.x : x > w.x2 ? w.x2 : x;
    const py = y < w.y ? w.y : y > w.y2 ? w.y2 : y;
    if (Math.hypot(x - px, y - py) < reach) out.push(w);
  }
  return out;
}

// ---- bullets ----
// Spatial lists of walls a bullet centre inside a cell can touch (order kept = engine order).
export const GCELL = 50;
export function buildBulletGrid(walls) {
  const gw = Math.ceil(AW / GCELL);
  const gh = Math.ceil(AH / GCELL);
  const lists = new Array(gw * gh);
  const m = BULLET_R + 1;
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      const x0 = i * GCELL, y0 = j * GCELL, x1 = x0 + GCELL, y1 = y0 + GCELL;
      lists[j * gw + i] = walls.filter((w) => w.x - m < x1 && w.x2 + m > x0 && w.y - m < y1 && w.y2 + m > y0);
    }
  }
  return { gw, gh, lists };
}

export function cellWalls(grid, x, y) {
  let i = Math.floor(x / GCELL);
  let j = Math.floor(y / GCELL);
  i = i < 0 ? 0 : i >= grid.gw ? grid.gw - 1 : i;
  j = j < 0 ? 0 : j >= grid.gh ? grid.gh - 1 : j;
  return grid.lists[j * grid.gw + i];
}

// Does a bullet centre at (x, y) touch a wall or the border?  (Writes the contact to C.)
export function bulletContact(grid, x, y) {
  if (boundsHitB(x, y)) return true;
  const list = cellWalls(grid, x, y);
  for (let i = 0; i < list.length; i++) if (circleRect(x, y, BULLET_R, list[i])) return true;
  return false;
}

// Bullet state B = Float64Array [x, y, vx, vy, bouncesLeft, bounced(0/1), age, dead(0/1)].
// Advances one tick exactly like the engine without tanks. Substep positions where the engine
// would test tanks are appended to out[o..] as (x, y, bounced); returns the new o.
export function bulletTick(B, grid, out, o) {
  B[6] += DT;
  if (B[6] > BULLET_LIFE) { B[7] = 1; return o; }
  const speed = Math.hypot(B[2], B[3]);
  const steps = Math.max(1, Math.ceil((speed * DT) / 6));
  const sdt = DT / steps;
  for (let s = 0; s < steps && B[7] === 0; s++) {
    B[0] += B[2] * sdt;
    B[1] += B[3] * sdt;
    if (bulletContact(grid, B[0], B[1])) {
      if (B[4] > 0) {
        B[4]--;
        B[5] = 1;
        B[0] += C[0] * C[2];
        B[1] += C[1] * C[2];
        const dot = B[2] * C[0] + B[3] * C[1];
        B[2] -= 2 * dot * C[0];
        B[3] -= 2 * dot * C[1];
      } else {
        B[7] = 1;
      }
      continue;
    }
    if (out !== null) {
      out[o++] = B[0];
      out[o++] = B[1];
      out[o++] = B[5];
    }
  }
  return o;
}

// Muzzle spawn exactly like engine fire(): returns false if the muzzle is inside a wall.
export function spawnBullet(B, x, y, turret, bulletSpeed, grid) {
  const dx = Math.cos(turret);
  const dy = Math.sin(turret);
  const bx = x + dx * MUZZLE;
  const by = y + dy * MUZZLE;
  if (bulletContact(grid, bx, by)) return false;
  B[0] = bx; B[1] = by; B[2] = dx * bulletSpeed; B[3] = dy * bulletSpeed;
  B[4] = 1; B[5] = 0; B[6] = 0; B[7] = 0;
  return true;
}

// Reference replica of one full engine bullet tick with tanks (used by verify.mjs).
// bullets: array of {B, owner}; tanks: [{x, y, alive}] indexed by side.
export function stepBulletsWithTanks(list, tanks, grid) {
  const hits = [];
  for (const it of list) {
    const B = it.B;
    if (B[7]) continue;
    B[6] += DT;
    if (B[6] > BULLET_LIFE) { B[7] = 1; continue; }
    const speed = Math.hypot(B[2], B[3]);
    const steps = Math.max(1, Math.ceil((speed * DT) / 6));
    const sdt = DT / steps;
    for (let s = 0; s < steps && B[7] === 0; s++) {
      B[0] += B[2] * sdt;
      B[1] += B[3] * sdt;
      if (bulletContact(grid, B[0], B[1])) {
        if (B[4] > 0) {
          B[4]--; B[5] = 1;
          B[0] += C[0] * C[2]; B[1] += C[1] * C[2];
          const dot = B[2] * C[0] + B[3] * C[1];
          B[2] -= 2 * dot * C[0]; B[3] -= 2 * dot * C[1];
        } else B[7] = 1;
        continue;
      }
      for (let side = 0; side < tanks.length; side++) {
        const t = tanks[side];
        if (!t.alive) continue;
        if (side === it.owner && !B[5]) continue;
        if (Math.hypot(t.x - B[0], t.y - B[1]) < HIT_R) { B[7] = 1; hits.push({ id: it.id, side }); break; }
      }
    }
  }
  const live = list.filter((it) => !it.B[7]);
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i].B, b = live[j].B;
      if (a[7] || b[7]) continue;
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) < CLASH_R) { a[7] = 1; b[7] = 1; }
    }
  }
  return hits;
}
