// «Чемпион-реплика» — sparring replica of the undefeated champion bot.
// Exact engine physics inside (physics.js); every tick:
//  * dodge planner: ~500 manoeuvres (first action x switch time x second action + previous plan)
//    over 1.2 s, cost = hits by every flying bullet (ricochets, own bounced bullets, clashes),
//    zone, kits, distance policy, readiness for the enemy's next shot (sideways, room to move),
//    and an imaginary linear-lead shot fired the tick the enemy's reload ends;
//  * distance policy from physics (no-dodge radii for both bullets), kill-race, end phase, zone;
//  * aiming: 10 hypotheses of enemy motion simulated over the flight time, the angle covering the
//    most weighted hypotheses wins, direct or banked off any wall face; weights learn from misses
//    and persist across rounds; low fire threshold; interception of unavoidable bullets;
//    never fires a shot whose ricochet can come back into itself.
import * as P from './physics.js';

const { DT, AW, AH, TANK_R, BULLET_R, HIT_R, MUZZLE, TURRET_RATE, ACCEL, REVERSE, CLASH_R } = P;
const HIT2_LO = HIT_R * HIT_R - 1e-7;
const HIT2_HI = HIT_R * HIT_R + 1e-7;
const TSTEP = TURRET_RATE * DT; // max turret change per tick
const now = typeof performance !== 'undefined' && performance.now ? () => performance.now() : () => Date.now();

// ---------------- tuning (derived from physics where possible) ----------------
const PH = 36; // planner horizon, ticks (1.2 s)
const NHT = 60; // enemy hypothesis horizon, ticks (2 s of flight)
const PLAN_BUDGET_MS = 12;
const TICK_BUDGET_MS = 26;
const HIT_COST = 1000 / 43; // per hp of damage
const LETHAL_W = 2500;
const ZONE_W = 40; // per tick outside the circle (+ ZONE_DEPTH_W per px of depth)
const ZONE_DEPTH_W = 2;
const BUMP_W = 6;
const NAV_W = 1.0;
const VIRT_W = 380;
const READY_W = 5;
const NEED_W = 2 * HIT_R + 12; // lateral escape width wanted at the enemy's shot
const PREV_BONUS = 20;
const FIRE_T = 0.1; // low fire threshold (fraction of hypothesis weight covered)
const SELF_MARGIN = 22;
const NO_DODGE_NEED = HIT_R + 13.3; // lateral displacement that clears the hit circle with margin

// ---------------- persistent learning (module level: survives rounds) ----------------
const NHYP = 10;
const HYP_THR = [0, 1, 1, 1, 0, 0, 0, -1, -1, -1];
const HYP_TURN = [0, 0, -1, 1, 0, -1, 1, 0, -1, 1];
const hypScore = new Float64Array(NHYP).fill(0.3);
hypScore[0] = 0.5;
const debug = { shots: 0, bank: 0, intercepts: 0, noFireSelf: 0, planTimeouts: 0, learned: 0, maxMs: 0 };

// ---------------- map cache ----------------
const NC = 20;
const NGW = AW / NC;
const NGH = AH / NC;
const NN = NGW * NGH;
let mapKey = '';
let WALLS = [];
let GRID = null;
let FACES = [];
const NAVFREE = new Uint8Array(NN);
const NAVCLEAR = new Float32Array(NN);
const NAVNEAR = new Int32Array(NN); // blocked cell -> nearest free cell (same side of the wall)
const NAVNEARD = new Float64Array(NN);
const fieldGoal = new Float64Array(NN);
const fieldMe = new Float64Array(NN);
const heapK = new Float64Array(NN * 8 + 16);
const heapV = new Int32Array(NN * 8 + 16);

function rectDist(x, y, w) {
  const px = x < w.x ? w.x : x > w.x2 ? w.x2 : x;
  const py = y < w.y ? w.y : y > w.y2 ? w.y2 : y;
  return Math.hypot(x - px, y - py);
}

function ensureMap(arena) {
  const key = arena.mapName + ':' + arena.walls.map((w) => `${w.x},${w.y},${w.w},${w.h}`).join(';');
  if (key === mapKey) return;
  mapKey = key;
  WALLS = P.prepWalls(arena.walls);
  GRID = P.buildBulletGrid(WALLS);
  for (let j = 0; j < NGH; j++) {
    for (let i = 0; i < NGW; i++) {
      const cx = (i + 0.5) * NC, cy = (j + 0.5) * NC;
      let c = Math.min(cx, AW - cx, cy, AH - cy);
      for (const w of WALLS) c = Math.min(c, rectDist(cx, cy, w));
      NAVCLEAR[j * NGW + i] = c;
      NAVFREE[j * NGW + i] = c >= TANK_R + 1 ? 1 : 0;
    }
  }
  for (let u = 0; u < NN; u++) {
    NAVNEAR[u] = NAVFREE[u] ? u : -1;
    NAVNEARD[u] = 0;
    if (NAVFREE[u]) continue;
    const ui = u % NGW, uj = (u / NGW) | 0;
    let bd = Infinity;
    for (let dj = -7; dj <= 7; dj++) {
      for (let di = -7; di <= 7; di++) {
        const i = ui + di, j = uj + dj;
        if (i < 0 || j < 0 || i >= NGW || j >= NGH || !NAVFREE[j * NGW + i]) continue;
        const d = Math.hypot(di, dj) * NC;
        if (d < bd) { bd = d; NAVNEAR[u] = j * NGW + i; NAVNEARD[u] = d; }
      }
    }
  }
  FACES = [];
  const add = (ax, c, lo, hi, side) => {
    const lim = ax === 0 ? AW : AH;
    if (c > BULLET_R + 0.5 && c < lim - BULLET_R - 0.5) FACES.push({ ax, c, lo, hi, side });
  };
  for (const w of WALLS) {
    add(0, w.x - BULLET_R, w.y, w.y2, -1);
    add(0, w.x2 + BULLET_R, w.y, w.y2, 1);
    add(1, w.y - BULLET_R, w.x, w.x2, -1);
    add(1, w.y2 + BULLET_R, w.x, w.x2, 1);
  }
  FACES.push({ ax: 0, c: BULLET_R, lo: 0, hi: AH, side: 1 }, { ax: 0, c: AW - BULLET_R, lo: 0, hi: AH, side: -1 },
    { ax: 1, c: BULLET_R, lo: 0, hi: AW, side: 1 }, { ax: 1, c: AH - BULLET_R, lo: 0, hi: AW, side: -1 });
}

// ---------------- geometry helpers ----------------
function segClear(x1, y1, x2, y2, pad) {
  const dx = x2 - x1, dy = y2 - y1;
  for (let i = 0; i < WALLS.length; i++) {
    const w = WALLS[i];
    let t0 = 0, t1 = 1;
    if (Math.abs(dx) < 1e-12) {
      if (x1 < w.x - pad || x1 > w.x2 + pad) continue;
    } else {
      let a = (w.x - pad - x1) / dx, b = (w.x2 + pad - x1) / dx;
      if (a > b) { const q = a; a = b; b = q; }
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
      if (t0 > t1) continue;
    }
    if (Math.abs(dy) < 1e-12) {
      if (y1 < w.y - pad || y1 > w.y2 + pad) continue;
    } else {
      let a = (w.y - pad - y1) / dy, b = (w.y2 + pad - y1) / dy;
      if (a > b) { const q = a; a = b; b = q; }
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
      if (t0 > t1) continue;
    }
    return false;
  }
  return true;
}

// Free distance for the tank centre along a unit direction (walls grown by the tank radius).
function rayRoom(x, y, ux, uy, maxD, wl) {
  let t = maxD;
  const lo = TANK_R, hx = AW - TANK_R, hy = AH - TANK_R;
  if (ux > 1e-9) t = Math.min(t, (hx - x) / ux); else if (ux < -1e-9) t = Math.min(t, (lo - x) / ux);
  if (uy > 1e-9) t = Math.min(t, (hy - y) / uy); else if (uy < -1e-9) t = Math.min(t, (lo - y) / uy);
  for (let i = 0; i < wl.length; i++) {
    const w = wl[i];
    let t0 = 0, t1 = t;
    if (Math.abs(ux) < 1e-12) {
      if (x < w.x - TANK_R || x > w.x2 + TANK_R) continue;
    } else {
      let a = (w.x - TANK_R - x) / ux, b = (w.x2 + TANK_R - x) / ux;
      if (a > b) { const q = a; a = b; b = q; }
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
      if (t0 > t1) continue;
    }
    if (Math.abs(uy) < 1e-12) {
      if (y < w.y - TANK_R || y > w.y2 + TANK_R) continue;
    } else {
      let a = (w.y - TANK_R - y) / uy, b = (w.y2 + TANK_R - y) / uy;
      if (a > b) { const q = a; a = b; b = q; }
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
      if (t0 > t1) continue;
    }
    if (t0 < t) t = t0;
  }
  return t < 0 ? 0 : t;
}

// Distance inside which a target standing sideways at rest cannot clear the hit circle:
// accel 420 up to its max speed, one tick of reaction, bullet leaves the muzzle 34 px out.
function noDodge(bulletSpeed, vmax) {
  const tAcc = vmax / ACCEL;
  const dAcc = 0.5 * ACCEL * tAcc * tAcc;
  const tEsc = NO_DODGE_NEED <= dAcc ? Math.sqrt((2 * NO_DODGE_NEED) / ACCEL) : tAcc + (NO_DODGE_NEED - dAcc) / vmax;
  return MUZZLE + bulletSpeed * (tEsc + DT);
}

// ---------------- navigation field (Dijkstra on 20 px cells) ----------------
function cellOf(x, y) {
  let i = Math.floor(x / NC), j = Math.floor(y / NC);
  i = i < 0 ? 0 : i >= NGW ? NGW - 1 : i;
  j = j < 0 ? 0 : j >= NGH ? NGH - 1 : j;
  return j * NGW + i;
}
function nearestFree(x, y) {
  const c0 = cellOf(x, y);
  if (NAVFREE[c0]) return c0;
  const i0 = c0 % NGW, j0 = (c0 / NGW) | 0;
  let best = -1, bd = Infinity;
  for (let r = 1; r < 10 && best < 0; r++) {
    for (let dj = -r; dj <= r; dj++) {
      for (let di = -r; di <= r; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
        const i = i0 + di, j = j0 + dj;
        if (i < 0 || j < 0 || i >= NGW || j >= NGH) continue;
        const c = j * NGW + i;
        if (!NAVFREE[c]) continue;
        const d = Math.hypot((i + 0.5) * NC - x, (j + 0.5) * NC - y);
        if (d < bd) { bd = d; best = c; }
      }
    }
  }
  return best < 0 ? c0 : best;
}
let hn = 0;
function hpush(k, v) {
  let i = hn++;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (heapK[p] <= k) break;
    heapK[i] = heapK[p]; heapV[i] = heapV[p];
    i = p;
  }
  heapK[i] = k; heapV[i] = v;
}
let popK = 0;
function hpop() {
  const tv = heapV[0];
  popK = heapK[0];
  hn--;
  if (hn > 0) {
    const k = heapK[hn], v = heapV[hn];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= hn) break;
      if (c + 1 < hn && heapK[c + 1] < heapK[c]) c++;
      if (heapK[c] >= k) break;
      heapK[i] = heapK[c]; heapV[i] = heapV[c];
      i = c;
    }
    heapK[i] = k; heapV[i] = v;
  }
  return tv;
}
const DIRS = [[1, 0, NC], [-1, 0, NC], [0, 1, NC], [0, -1, NC], [1, 1, NC * Math.SQRT2], [1, -1, NC * Math.SQRT2], [-1, 1, NC * Math.SQRT2], [-1, -1, NC * Math.SQRT2]];
function dijkstra(x, y, out) {
  out.fill(Infinity);
  const s = nearestFree(x, y);
  hn = 0;
  out[s] = Math.hypot(((s % NGW) + 0.5) * NC - x, (((s / NGW) | 0) + 0.5) * NC - y);
  hpush(out[s], s);
  while (hn > 0) {
    const u = hpop();
    const d = popK;
    if (d > out[u]) continue;
    const ui = u % NGW, uj = (u / NGW) | 0;
    for (let q = 0; q < 8; q++) {
      const di = DIRS[q][0], dj = DIRS[q][1];
      const vi = ui + di, vj = uj + dj;
      if (vi < 0 || vj < 0 || vi >= NGW || vj >= NGH) continue;
      const v = vj * NGW + vi;
      if (!NAVFREE[v]) continue;
      if (di && dj && (!NAVFREE[uj * NGW + vi] || !NAVFREE[vj * NGW + ui])) continue;
      const nd = d + DIRS[q][2];
      if (nd < out[v]) { out[v] = nd; hpush(nd, v); }
    }
  }
  // blocked cells take the value of their nearest free cell (never leaks through a wall)
  for (let u = 0; u < NN; u++) {
    if (NAVFREE[u]) continue;
    const v = NAVNEAR[u];
    out[u] = v >= 0 ? out[v] + NAVNEARD[u] : Infinity;
  }
}
function fieldAt(F, x, y) {
  const fx = x / NC - 0.5, fy = y / NC - 0.5;
  let i0 = Math.floor(fx), j0 = Math.floor(fy);
  if (i0 < 0) i0 = 0; else if (i0 > NGW - 2) i0 = NGW - 2;
  if (j0 < 0) j0 = 0; else if (j0 > NGH - 2) j0 = NGH - 2;
  let tx = fx - i0, ty = fy - j0;
  tx = tx < 0 ? 0 : tx > 1 ? 1 : tx;
  ty = ty < 0 ? 0 : ty > 1 ? 1 : ty;
  const b = j0 * NGW + i0;
  let a00 = F[b], a10 = F[b + 1], a01 = F[b + NGW], a11 = F[b + NGW + 1];
  if (!(a00 < 1e8 && a10 < 1e8 && a01 < 1e8 && a11 < 1e8)) {
    const m = Math.min(a00, a10, a01, a11);
    if (!(m < 1e8)) return 5000;
    const r = m + 40;
    if (!(a00 < 1e8)) a00 = r;
    if (!(a10 < 1e8)) a10 = r;
    if (!(a01 < 1e8)) a01 = r;
    if (!(a11 < 1e8)) a11 = r;
  }
  return (a00 * (1 - tx) + a10 * tx) * (1 - ty) + (a01 * (1 - tx) + a11 * tx) * ty;
}

// ---------------- reach tables (1-D kinematics along the hull axis) ----------------
const RT_N = 48;
const RV_STEP = 2;
let RT_VMAX = -1, RT_VMIN = 0, RT_NV = 0;
let RT_F = null, RT_B = null;
function buildReach(vmax) {
  if (vmax === RT_VMAX) return;
  RT_VMAX = vmax;
  RT_VMIN = -vmax * REVERSE;
  RT_NV = Math.ceil((vmax - RT_VMIN) / RV_STEP) + 1;
  RT_F = new Float64Array(RT_NV * (RT_N + 1));
  RT_B = new Float64Array(RT_NV * (RT_N + 1));
  const lim = ACCEL * DT;
  for (let iv = 0; iv < RT_NV; iv++) {
    const v0 = Math.min(vmax, RT_VMIN + iv * RV_STEP);
    for (let dir = 0; dir < 2; dir++) {
      const target = dir === 0 ? vmax : RT_VMIN;
      const tab = dir === 0 ? RT_F : RT_B;
      let v = v0, x = 0;
      for (let n = 0; n <= RT_N; n++) {
        tab[iv * (RT_N + 1) + n] = x;
        let dv = target - v;
        dv = dv < -lim ? -lim : dv > lim ? lim : dv;
        v += dv;
        x += v * DT;
      }
    }
  }
}
function reachTab(tab, v, n) {
  let f = (v - RT_VMIN) / RV_STEP;
  if (f < 0) f = 0; else if (f > RT_NV - 1) f = RT_NV - 1;
  const i = Math.min(RT_NV - 2, Math.floor(f));
  const t = f - i;
  return tab[i * (RT_N + 1) + n] * (1 - t) + tab[(i + 1) * (RT_N + 1) + n] * t;
}

// ---------------- per-round memory ----------------
let R = null;
function resetRound(view) {
  R = {
    lastTick: -1,
    firstSeen: new Map(),
    prevEnemy: null,
    prevPlan: null,
    goalX: view ? view.me.x : 800,
    goalY: view ? view.me.y : 450,
    goalTick: -999,
    goalMode: '',
    goalEX: 0,
    goalEY: 0,
    kitState: '',
    learn: [],
    lastFireTick: -99,
  };
}

// ---------------- enemy hypotheses ----------------
const HX = new Float64Array(NHYP * (NHT + 1));
const HY = new Float64Array(NHYP * (NHT + 1));
const TS = new Float64Array(4);
function estimateControl(e) {
  const pe = R.prevEnemy;
  const st = e.stats;
  if (!pe || pe.tick !== R.lastTick) return [Math.abs(e.speed) > 1 ? Math.sign(e.speed) : 0, 0];
  let turn = P.normAngle(e.heading - pe.h) / (st.turnRate * DT);
  turn = turn > 1 ? 1 : turn < -1 ? -1 : turn;
  const dv = e.speed - pe.v;
  const lim = ACCEL * DT;
  let thr;
  if (Math.abs(dv) < lim - 1e-6) {
    thr = e.speed >= 0 ? e.speed / st.maxSpeed : e.speed / (st.maxSpeed * REVERSE);
  } else if (dv > 0) thr = 1;
  else thr = e.speed > 0 ? 0 : -1;
  thr = thr > 1 ? 1 : thr < -1 ? -1 : thr;
  return [thr, turn];
}
function simHyps(e, ctl) {
  const st = e.stats;
  const wl = P.wallsNear(WALLS, e.x, e.y, st.maxSpeed * NHT * DT + TANK_R + 40);
  for (let h = 0; h < NHYP; h++) {
    const thr = h === 0 ? ctl[0] : HYP_THR[h];
    const turn = h === 0 ? ctl[1] : HYP_TURN[h];
    TS[0] = e.x; TS[1] = e.y; TS[2] = e.heading; TS[3] = e.speed;
    const base = h * (NHT + 1);
    HX[base] = e.x; HY[base] = e.y;
    for (let k = 1; k <= NHT; k++) {
      P.stepTank(TS, thr, turn, st.maxSpeed, st.turnRate, wl);
      HX[base + k] = TS[0]; HY[base + k] = TS[1];
    }
  }
}

// ---------------- threats: every flying bullet over the planner horizon ----------------
const MAXB = 31;
const MAXPT = 5200;
const TB = Array.from({ length: MAXB }, () => new Float64Array(8));
const SUB = new Float64Array(48);
const ptX = new Float64Array(MAXPT), ptY = new Float64Array(MAXPT), ptDmg = new Float64Array(MAXPT);
const ptBit = new Int32Array(MAXPT), ptBi = new Int32Array(MAXPT);
const ptOff = new Int32Array(PH + 2);
const tbx0 = new Float64Array(PH + 1), tbx1 = new Float64Array(PH + 1), tby0 = new Float64Array(PH + 1), tby1 = new Float64Array(PH + 1);
const bEX = new Float64Array(MAXB * (PH + 1)), bEY = new Float64Array(MAXB * (PH + 1));
const bAlive = new Uint8Array(MAXB * (PH + 1));
const bIsEnemy = new Uint8Array(MAXB), bDamage = new Float64Array(MAXB);
let nTB = 0;
function bulletAge(id, tick) {
  let f = R.firstSeen.get(id);
  if (f === undefined) { f = tick; R.firstSeen.set(id, f); }
  let age = 0;
  for (let k = f; k <= tick; k++) age += DT;
  return age;
}
function simThreats(s) {
  nTB = 0;
  for (const b of s.bullets) {
    if (nTB >= MAXB) break;
    const B = TB[nTB];
    B[0] = b.x; B[1] = b.y; B[2] = b.vx; B[3] = b.vy; B[4] = b.bouncesLeft; B[5] = b.canHitOwner ? 1 : 0;
    B[6] = bulletAge(b.id, s.tick); B[7] = 0;
    bIsEnemy[nTB] = b.mine ? 0 : 1;
    bDamage[nTB] = b.damage;
    bEX[nTB * (PH + 1)] = b.x; bEY[nTB * (PH + 1)] = b.y; bAlive[nTB * (PH + 1)] = 1;
    nTB++;
  }
  let np = 0;
  for (let k = 1; k <= PH; k++) {
    ptOff[k] = np;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < nTB; i++) {
      const B = TB[i];
      const idx = i * (PH + 1) + k;
      if (B[7]) { bAlive[idx] = 0; bEX[idx] = B[0]; bEY[idx] = B[1]; continue; }
      const o = P.bulletTick(B, GRID, SUB, 0);
      const enemy = bIsEnemy[i];
      for (let q = 0; q < o; q += 3) {
        if (!enemy && SUB[q + 2] === 0) continue;
        if (np >= MAXPT) break;
        const x = SUB[q], y = SUB[q + 1];
        ptX[np] = x; ptY[np] = y; ptDmg[np] = bDamage[i]; ptBit[np] = 1 << (i % 31); ptBi[np] = i;
        np++;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      bEX[idx] = B[0]; bEY[idx] = B[1]; bAlive[idx] = B[7] ? 0 : 1;
    }
    for (let i = 0; i < nTB; i++) {
      if (TB[i][7]) continue;
      for (let j = i + 1; j < nTB; j++) {
        if (TB[j][7] || TB[i][7]) continue;
        if (Math.hypot(TB[i][0] - TB[j][0], TB[i][1] - TB[j][1]) < CLASH_R) {
          TB[i][7] = 1; TB[j][7] = 1;
          bAlive[i * (PH + 1) + k] = 0; bAlive[j * (PH + 1) + k] = 0;
        }
      }
    }
    tbx0[k] = x0 - HIT_R; tbx1[k] = x1 + HIT_R; tby0[k] = y0 - HIT_R; tby1[k] = y1 + HIT_R;
  }
  ptOff[PH + 1] = np;
}

// ---------------- planner ----------------
const ACT_THR = [1, 1, 1, 0, 0, 0, -1, -1, -1];
const ACT_TURN = [0, -1, 1, 0, -1, 1, 0, -1, 1];
const SWITCHES = [1, 2, 4, 6, 9, 13, 18, 24];
const hitW = new Float64Array(PH + 1);
for (let k = 1; k <= PH; k++) hitW[k] = HIT_COST * (1.3 - (0.5 * k) / PH);
const distChk = new Uint8Array(PH + 1);
for (const k of [6, 12, 18, 24, 30, 36]) distChk[k] = 1;
const zoneR2 = new Float64Array(PH + 1);
let C_zoneX = 800, C_zoneY = 450, C_zoneEndR = 1e9;
let C_want = 400, C_minD = 300, C_dMinW = 4, C_dWantW = 0.25, C_myHp = 100;
let C_kitN = 0;
const kitX = new Float64Array(4), kitY = new Float64Array(4), kitVal = new Float64Array(4), kitFrom = new Int32Array(4);
let C_jr = -1, C_ebs = 700, C_wl = [];
let C_maxSpeed = 110, C_turnRate = 1.8;
// prefix (first action) and current plan buffers
const preX = new Float64Array(PH + 1), preY = new Float64Array(PH + 1), preH = new Float64Array(PH + 1), preV = new Float64Array(PH + 1);
const preC = new Float64Array(PH + 1), preM = new Int32Array(PH + 1), preD = new Float64Array(PH + 1), preK = new Int32Array(PH + 1);
const preFK = new Int32Array(PH + 1), preFB = new Int32Array(PH + 1);
const plX = new Float64Array(PH + 1), plY = new Float64Array(PH + 1), plH = new Float64Array(PH + 1), plV = new Float64Array(PH + 1);
const bestX = new Float64Array(PH + 1), bestY = new Float64Array(PH + 1), bestH = new Float64Array(PH + 1), bestV = new Float64Array(PH + 1);
const bestActs = new Int8Array(PH);
const seqActs = new Int8Array(PH);
let aC = 0, aM = 0, aD = 0, aK = 0, aFK = 0, aFB = -1;

function accTick(k, x, y, bumps) {
  const p0 = ptOff[k], p1 = ptOff[k + 1];
  if (p1 > p0 && x > tbx0[k] && x < tbx1[k] && y > tby0[k] && y < tby1[k]) {
    for (let i = p0; i < p1; i++) {
      const bit = ptBit[i];
      if (aM & bit) continue;
      const dx = x - ptX[i], dy = y - ptY[i];
      const d2 = dx * dx + dy * dy;
      if (d2 < HIT2_HI && (d2 < HIT2_LO || Math.hypot(dx, dy) < HIT_R)) {
        aM |= bit;
        aD += ptDmg[i];
        aC += hitW[k] * ptDmg[i] + (aD >= C_myHp ? LETHAL_W : 0);
        if (aFB < 0) { aFB = ptBi[i]; aFK = k; }
      }
    }
  }
  const zx = x - C_zoneX, zy = y - C_zoneY;
  const z2 = zx * zx + zy * zy;
  if (z2 > zoneR2[k]) aC += ZONE_W + (Math.sqrt(z2) - Math.sqrt(zoneR2[k])) * ZONE_DEPTH_W;
  for (let j = 0; j < C_kitN; j++) {
    if (aK & (1 << j) || k < kitFrom[j]) continue;
    const dx = x - kitX[j], dy = y - kitY[j];
    if (dx * dx + dy * dy < 1600) { aK |= 1 << j; aC -= kitVal[j]; }
  }
  if (bumps) aC += BUMP_W * bumps;
  if (distChk[k]) {
    const d = Math.hypot(x - HX[k], y - HY[k]);
    if (d < C_minD) aC += (C_minD - d) * C_dMinW;
    aC += Math.abs(d - C_want) * C_dWantW;
  }
}

function virtualHit() {
  const j = C_jr;
  const px = plX[j], py = plY[j], sp = plV[j];
  const hx = Math.cos(plH[j]) * sp, hy = Math.sin(plH[j]) * sp;
  const ex = HX[j], ey = HY[j];
  const Dx = px - ex, Dy = py - ey, vb = C_ebs;
  const a = hx * hx + hy * hy - vb * vb;
  const b = 2 * (Dx * hx + Dy * hy) - 2 * MUZZLE * vb;
  const c = Dx * Dx + Dy * Dy - MUZZLE * MUZZLE;
  const disc = b * b - 4 * a * c;
  if (disc < 0 || c <= 0) return false;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  if (!(t > 0)) return false;
  const ax = px + hx * t, ay = py + hy * t;
  let ux = ax - ex, uy = ay - ey;
  const ul = Math.hypot(ux, uy);
  if (ul < 1) return false;
  ux /= ul; uy /= ul;
  const sx = HX[j + 1] + ux * MUZZLE, sy = HY[j + 1] + uy * MUZZLE;
  if (!segClear(sx, sy, ax, ay, BULLET_R)) return false;
  const step = vb * DT;
  for (let m = 0; j + 1 + m <= PH; m++) {
    const qx = plX[j + 1 + m], qy = plY[j + 1 + m];
    const s0 = step * m, s1 = s0 + step;
    const rx = qx - sx, ry = qy - sy;
    let pr = rx * ux + ry * uy;
    if (pr < s0 - HIT_R - 10) break; // bullet is already past us
    pr = pr < s0 ? s0 : pr > s1 ? s1 : pr;
    const cx = rx - ux * pr, cy = ry - uy * pr;
    if (cx * cx + cy * cy < HIT_R * HIT_R) return true;
  }
  return false;
}

function readinessCost(x, y, h, v) {
  const ex = HX[C_jr], ey = HY[C_jr];
  const dx = x - ex, dy = y - ey;
  const D = Math.hypot(dx, dy);
  if (D < 1) return 0;
  const ch = Math.cos(h), sh = Math.sin(h);
  const lat = Math.abs(ch * dy - sh * dx) / D;
  let n = Math.floor((D - MUZZLE) / (C_ebs * DT)) - 1;
  if (n < 0) n = 0; else if (n > RT_N) n = RT_N;
  let f = reachTab(RT_F, v, n), b = reachTab(RT_B, v, n);
  const rf = rayRoom(x, y, ch, sh, 90, C_wl), rb = rayRoom(x, y, -ch, -sh, 90, C_wl);
  if (f > rf) f = rf;
  if (b < -rb) b = -rb;
  const width = (f - b) * lat;
  const def = NEED_W - width;
  return def > 0 ? def * READY_W : 0;
}

const TC = { nav: 0, zoneEnd: 0, ready: 0, virt: 0 };
function terminalCost() {
  const nav = fieldAt(fieldGoal, plX[PH], plY[PH]) * NAV_W;
  let c = nav;
  const zd = Math.hypot(plX[PH] - C_zoneX, plY[PH] - C_zoneY);
  const ze = zd > C_zoneEndR ? (zd - C_zoneEndR) * 12 : 0;
  c += ze;
  let rd = 0, vh = 0;
  if (C_jr >= 0) {
    const k = C_jr + 1;
    rd = readinessCost(plX[k], plY[k], plH[k], plV[k]);
    if (virtualHit()) vh = VIRT_W;
  }
  TC.nav = nav; TC.zoneEnd = ze; TC.ready = rd; TC.virt = vh;
  return c + rd + vh;
}
// Cost breakdown of an action sequence (debug only).
export function explainSeq(me, acts) {
  const total = simSequence(me, acts);
  return { total: Math.round(total), path: Math.round(aC), nav: Math.round(TC.nav), zoneEnd: Math.round(TC.zoneEnd), ready: Math.round(TC.ready), virt: TC.virt, end: [Math.round(plX[PH]), Math.round(plY[PH])] };
}
export function explainBest(me) { return explainSeq(me, bestActs); }
export function fieldDump() { return { fieldGoal, NAVFREE, NGW, NGH, NC, goal: [R.goalX, R.goalY] }; }

function simSequence(me, acts) {
  TS[0] = me.x; TS[1] = me.y; TS[2] = me.heading; TS[3] = me.speed;
  plX[0] = TS[0]; plY[0] = TS[1]; plH[0] = TS[2]; plV[0] = TS[3];
  aC = 0; aM = 0; aD = 0; aK = 0; aFK = 0; aFB = -1;
  for (let k = 1; k <= PH; k++) {
    const a = acts[k - 1];
    const bumps = P.stepTank(TS, ACT_THR[a], ACT_TURN[a], C_maxSpeed, C_turnRate, C_wl);
    plX[k] = TS[0]; plY[k] = TS[1]; plH[k] = TS[2]; plV[k] = TS[3];
    accTick(k, TS[0], TS[1], bumps);
  }
  return aC + terminalCost();
}

let bestFK = 0, bestFB = -1, bestCost = 0;
function saveBest(cost) {
  bestCost = cost;
  bestFK = aFK; bestFB = aFB;
  bestX.set(plX); bestY.set(plY); bestH.set(plH); bestV.set(plV);
}

function runPlanner(me, t0) {
  let best = Infinity;
  if (R.prevPlan) {
    for (let k = 0; k < PH; k++) seqActs[k] = R.prevPlan[Math.min(PH - 1, k + 1)];
    const c = simSequence(me, seqActs) - PREV_BONUS;
    best = c;
    bestActs.set(seqActs);
    saveBest(c);
  }
  let evaluated = 0;
  for (let a1 = 0; a1 < 9; a1++) {
    if (evaluated > 0 && now() - t0 > PLAN_BUDGET_MS) { debug.planTimeouts++; break; }
    const thr1 = ACT_THR[a1], turn1 = ACT_TURN[a1];
    TS[0] = me.x; TS[1] = me.y; TS[2] = me.heading; TS[3] = me.speed;
    preX[0] = TS[0]; preY[0] = TS[1]; preH[0] = TS[2]; preV[0] = TS[3];
    aC = 0; aM = 0; aD = 0; aK = 0; aFK = 0; aFB = -1;
    preC[0] = 0; preM[0] = 0; preD[0] = 0; preK[0] = 0; preFK[0] = 0; preFB[0] = -1;
    for (let k = 1; k <= PH; k++) {
      const bumps = P.stepTank(TS, thr1, turn1, C_maxSpeed, C_turnRate, C_wl);
      preX[k] = TS[0]; preY[k] = TS[1]; preH[k] = TS[2]; preV[k] = TS[3];
      accTick(k, TS[0], TS[1], bumps);
      preC[k] = aC; preM[k] = aM; preD[k] = aD; preK[k] = aK; preFK[k] = aFK; preFB[k] = aFB;
    }
    // hold the first action for the whole horizon
    plX.set(preX); plY.set(preY); plH.set(preH); plV.set(preV);
    {
      const c = aC + terminalCost();
      evaluated++;
      if (c < best) {
        best = c;
        for (let k = 0; k < PH; k++) bestActs[k] = a1;
        saveBest(c);
      }
    }
    for (let si = 0; si < SWITCHES.length; si++) {
      const S = SWITCHES[si];
      for (let k = 0; k <= S; k++) { plX[k] = preX[k]; plY[k] = preY[k]; plH[k] = preH[k]; plV[k] = preV[k]; }
      for (let a2 = 0; a2 < 9; a2++) {
        if (a2 === a1) continue;
        const thr2 = ACT_THR[a2], turn2 = ACT_TURN[a2];
        TS[0] = preX[S]; TS[1] = preY[S]; TS[2] = preH[S]; TS[3] = preV[S];
        aC = preC[S]; aM = preM[S]; aD = preD[S]; aK = preK[S]; aFK = preFK[S]; aFB = preFB[S];
        for (let k = S + 1; k <= PH; k++) {
          const bumps = P.stepTank(TS, thr2, turn2, C_maxSpeed, C_turnRate, C_wl);
          plX[k] = TS[0]; plY[k] = TS[1]; plH[k] = TS[2]; plV[k] = TS[3];
          accTick(k, TS[0], TS[1], bumps);
        }
        const c = aC + terminalCost();
        evaluated++;
        if (c < best) {
          best = c;
          for (let k = 0; k < PH; k++) bestActs[k] = k < S ? a1 : a2;
          saveBest(c);
        }
      }
    }
  }
  return evaluated;
}

// ---------------- goal selection ----------------
function losClear(x1, y1, x2, y2) {
  // bullet line from (x1,y1) to within ~20 px of (x2,y2)
  const dx = x2 - x1, dy = y2 - y1;
  const d = Math.hypot(dx, dy);
  if (d < 30) return true;
  const k = (d - 20) / d;
  return segClear(x1, y1, x1 + dx * k, y1 + dy * k, BULLET_R);
}

function chooseGoal(s, mode, want, minD) {
  const me = s.me, en = s.enemy;
  dijkstra(me.x, me.y, fieldMe);
  const Rf = P.zoneRadiusAt(s.time + 4);
  let bestC = Infinity, bx = me.x, by = me.y;
  for (let pass = 0; pass < 2 && bestC === Infinity; pass++) {
    const zoneMargin = pass === 0 ? 35 : -1e9;
    for (let j = 1; j < NGH; j += 2) {
      for (let i = 1; i < NGW; i += 2) {
        const idx = j * NGW + i;
        if (!NAVFREE[idx]) continue;
        const travel = fieldMe[idx];
        if (!(travel < 1e8)) continue;
        const cx = (i + 0.5) * NC, cy = (j + 0.5) * NC;
        const zd = Math.hypot(cx - C_zoneX, cy - C_zoneY);
        if (zd > Rf - zoneMargin) continue;
        const d = Math.hypot(cx - en.x, cy - en.y);
        let c = travel * 0.3;
        const los = losClear(cx, cy, en.x, en.y);
        if (mode === 'hide') {
          if (los) c += 500;
          c -= Math.min(d, 600) * 0.5;
          if (d < minD) c += (minD - d) * 3;
        } else {
          c += Math.abs(d - want);
          if (d < minD) c += (minD - d) * 5 + 150;
          if (!los) c += 140;
        }
        const clr = NAVCLEAR[idx];
        if (clr < 75) c += (75 - clr) * 1.5;
        const edge = Rf - zd;
        if (edge < 90) c += (90 - edge) * 1.5;
        if (Math.hypot(cx - R.goalX, cy - R.goalY) < 30) c -= 25;
        if (c < bestC) { bestC = c; bx = cx; by = cy; }
      }
    }
  }
  return [bx, by];
}

function pickKit(s) {
  const me = s.me, en = s.enemy;
  const myNeed = Math.min(50, me.maxHp - me.hp);
  const enNeed = Math.min(50, en.maxHp - en.hp);
  if (myNeed < 30 && enNeed < 40) return null;
  let best = null, bestScore = 0;
  for (const k of s.repairKits) {
    const cell = nearestFree(k.x, k.y);
    const dMe = fieldMe[cell];
    if (!(dMe < 1e8)) continue;
    const tMe = dMe / me.stats.maxSpeed + 0.4;
    if (!k.active && k.respawnIn > tMe + 0.5) continue;
    const tEn = (Math.hypot(en.x - k.x, en.y - k.y) * 1.15) / en.stats.maxSpeed + 0.3;
    const zr = P.zoneRadiusAt(s.time + tMe + 3);
    if (Math.hypot(k.x - C_zoneX, k.y - C_zoneY) > zr - 45) continue;
    const arrive = Math.max(tMe, k.active ? 0 : k.respawnIn);
    let score = 0;
    if (myNeed >= 30 && arrive < tEn - 0.2) score = myNeed;
    if (enNeed >= 40 && arrive < tEn + 0.3) score = Math.max(score, enNeed * 0.8 + myNeed * 0.5);
    score -= arrive * 4;
    if (score > bestScore) { bestScore = score; best = k; }
  }
  return best;
}

// ---------------- aiming ----------------
const BB = new Float64Array(8);
const SUBA = new Float64Array(48);
const hypMiss = new Float64Array(NHYP), hypTick = new Int32Array(NHYP);
const hypW = new Float64Array(NHYP);
let hypWSum = 1;
let C_myBS = 700;

// Score one turret angle: exact bullet flight vs every hypothesis. Returns -1 if the muzzle is blocked.
function evalAngle(a, Mx, My, jf) {
  if (!P.spawnBullet(BB, Mx, My, a, C_myBS, GRID)) return -1;
  for (let h = 0; h < NHYP; h++) { hypMiss[h] = 1e9; hypTick[h] = -1; }
  let open = NHYP;
  const maxM = NHT - jf - 1;
  let bounced = 0;
  for (let m = 0; m <= maxM && open > 0; m++) {
    const o = P.bulletTick(BB, GRID, SUBA, 0);
    const ek = jf + 1 + m;
    for (let q = 0; q < o; q += 3) {
      const bx = SUBA[q], by = SUBA[q + 1];
      for (let h = 0; h < NHYP; h++) {
        if (hypMiss[h] < HIT_R) continue;
        const i = h * (NHT + 1) + ek;
        const dx = HX[i] - bx, dy = HY[i] - by;
        const d2 = dx * dx + dy * dy;
        if (d2 < hypMiss[h] * hypMiss[h] || hypMiss[h] > 1e8) {
          const d = Math.sqrt(d2);
          if (d < hypMiss[h]) { hypMiss[h] = d; hypTick[h] = m; if (d < HIT_R) open--; }
        }
      }
    }
    if (BB[5]) bounced = 1;
    if (BB[7]) break;
  }
  let sc = 0;
  for (let h = 0; h < NHYP; h++) {
    const d = hypMiss[h];
    if (d < HIT_R) sc += hypW[h] * (1 - (0.25 * d) / HIT_R);
  }
  aimBounced = bounced;
  return sc / hypWSum;
}
let aimBounced = 0;

// Angle that meets hypothesis h's track (direct line).
function directAngle(h, Mx, My, jf, bs) {
  const base = h * (NHT + 1);
  let k = NHT;
  for (let m = 0; jf + 1 + m <= NHT; m++) {
    const i = base + jf + 1 + m;
    const L = MUZZLE + bs * DT * (m + 1);
    if (L >= Math.hypot(HX[i] - Mx, HY[i] - My)) { k = jf + 1 + m; break; }
  }
  return Math.atan2(HY[base + k] - My, HX[base + k] - Mx);
}

// Bank shot angles off every wall face / border for hypothesis h.
function bankAngles(h, Mx, My, jf, bs, out) {
  const base = h * (NHT + 1);
  for (let f = 0; f < FACES.length; f++) {
    const F = FACES[f];
    const mA = F.ax === 0 ? Mx : My;
    if ((mA - F.c) * F.side <= 1) continue;
    // iterate time of flight on the mirrored target
    let k = Math.min(NHT, jf + 12);
    let ok = true;
    let tx = 0, ty = 0;
    for (let it = 0; it < 3; it++) {
      const i = base + k;
      tx = HX[i]; ty = HY[i];
      const tA = F.ax === 0 ? tx : ty;
      if ((tA - F.c) * F.side <= 1) { ok = false; break; }
      if (F.ax === 0) tx = 2 * F.c - tx; else ty = 2 * F.c - ty;
      const L = Math.hypot(tx - Mx, ty - My) - MUZZLE;
      let nk = jf + 1 + Math.max(0, Math.ceil(L / (bs * DT)) - 1);
      if (nk > NHT) { ok = false; break; }
      if (nk === k) break;
      k = nk;
    }
    if (!ok) continue;
    // reflection point must be on the face
    const denom = F.ax === 0 ? tx - Mx : ty - My;
    if (Math.abs(denom) < 1e-9) continue;
    const u = (F.c - (F.ax === 0 ? Mx : My)) / denom;
    if (u <= 0 || u >= 1) continue;
    const q = F.ax === 0 ? My + (ty - My) * u : Mx + (tx - Mx) * u;
    if (q < F.lo + 1 || q > F.hi - 1) continue;
    out.push(Math.atan2(ty - My, tx - Mx));
  }
}

// Self-protection: could the ricochet of this shot come back into us?
function shotSafe(a, Mx, My) {
  if (!P.spawnBullet(BB, Mx, My, a, C_myBS, GRID)) return true;
  for (let m = 0; m < 75; m++) {
    const o = P.bulletTick(BB, GRID, SUBA, 0);
    const k = Math.min(PH, m + 1);
    const qx = bestX[k], qy = bestY[k];
    const r = HIT_R + SELF_MARGIN + (m + 1 > PH ? (m + 1 - PH) * 1.5 : 0);
    for (let q = 0; q < o; q += 3) {
      if (!SUBA[q + 2]) continue;
      const dx = SUBA[q] - qx, dy = SUBA[q + 1] - qy;
      if (dx * dx + dy * dy < r * r) return false;
    }
    if (BB[7]) break;
  }
  return true;
}

// Interception: find an angle reachable this tick whose bullet clashes with threat bullet bi before tick kHit.
function findIntercept(Mx, My, turret, bi, kHit) {
  let bestA = null, bestM = 1e9;
  const N = 24;
  for (let q = 0; q <= N; q++) {
    const a = P.normAngle(turret - TSTEP + (2 * TSTEP * q) / N);
    if (!P.spawnBullet(BB, Mx, My, a, C_myBS, GRID)) continue;
    for (let m = 0; m + 1 < kHit && m < PH; m++) {
      P.bulletTick(BB, GRID, null, 0);
      if (BB[7]) break;
      const idx = bi * (PH + 1) + m + 1;
      if (!bAlive[idx]) break;
      if (Math.hypot(BB[0] - bEX[idx], BB[1] - bEY[idx]) < CLASH_R) {
        if (m < bestM) { bestM = m; bestA = a; }
        break;
      }
    }
  }
  return bestA;
}

// Direction for a future interception shot (turret pre-rotation while reloading).
function interceptAim(Mx, My, bi, jf, kHit) {
  let bestA = null, bestErr = 1e9;
  for (let m = 0; jf + m + 1 < kHit && jf + m + 1 <= PH; m++) {
    const idx = bi * (PH + 1) + jf + m + 1;
    if (!bAlive[idx]) break;
    const bx = bEX[idx], by = bEY[idx];
    const L = MUZZLE + C_myBS * DT * (m + 1);
    const err = Math.abs(Math.hypot(bx - Mx, by - My) - L);
    if (err < bestErr) { bestErr = err; bestA = Math.atan2(by - My, bx - Mx); }
  }
  return bestErr < 40 ? bestA : null;
}

function turretCmd(turret, target) {
  let c = P.normAngle(target - turret) / TSTEP;
  return c > 1 ? 1 : c < -1 ? -1 : c;
}

// ---------------- main ----------------
function ticksUntilReady(reloadLeft) {
  let r = reloadLeft;
  for (let j = 0; j < 200; j++) {
    r = Math.max(0, r - DT);
    if (r <= 0) return j;
  }
  return 200;
}

function learn(s) {
  const en = s.enemy;
  const L = R.learn;
  for (let i = L.length - 1; i >= 0; i--) {
    const e = L[i];
    if (e.tick > s.tick) continue;
    if (e.tick === s.tick) {
      const err = Math.hypot(en.x - e.x, en.y - e.y);
      hypScore[e.h] = hypScore[e.h] * 0.93 + (err < HIT_R ? 0.07 : 0);
      debug.learned++;
    }
    L.splice(i, 1);
  }
}

function tick(s) {
  const t0 = now();
  const me = s.me, en = s.enemy;
  if (!R || s.tick <= R.lastTick - 1 || s.tick === 0 && R.lastTick > 0) resetRound(s);
  ensureMap(s.arena);
  if (!me.alive || !en.alive) { R.lastTick = s.tick; return { throttle: 0, turn: 0, turretTurn: 0, fire: false }; }
  buildReach(me.stats.maxSpeed);
  learn(s);

  // enemy motion hypotheses
  const ctl = estimateControl(en);
  simHyps(en, ctl);
  let ws = 0;
  for (let h = 0; h < NHYP; h++) { hypW[h] = 0.08 + hypScore[h]; ws += hypW[h]; }
  hypWSum = ws;

  // ---- distance policy from physics ----
  const Ze = noDodge(en.stats.bulletSpeed, me.stats.maxSpeed); // inside: I cannot dodge its bullet
  const Zm = noDodge(me.stats.bulletSpeed, en.stats.maxSpeed); // inside: it cannot dodge mine
  let want = Ze + 40;
  if (Zm > Ze + 40) want = (Ze + 40 + Zm) / 2;
  let minD = Ze + 10;
  const myFrac = me.hp / me.maxHp, enFrac = en.hp / en.maxHp;
  const hitsToKillMe = Math.ceil(me.hp / en.stats.damage);
  const hitsToKillEn = Math.ceil(en.hp / me.stats.damage);
  const ttkMe = en.reloadLeft + (hitsToKillMe - 1) * en.stats.reloadTime;
  const ttkEn = me.reloadLeft + (hitsToKillEn - 1) * me.stats.reloadTime;
  let mode = 'hold';
  if (ttkEn + me.stats.reloadTime < ttkMe && enFrac < myFrac - 0.05) {
    mode = 'close';
    want = Math.max(170, Ze - 130);
    minD = 110;
  }
  if (s.timeLeft < 22) {
    if (myFrac < enFrac - 0.005) { mode = 'chase'; want = 160; minD = 90; }
    else if (myFrac > enFrac + 0.005) { mode = 'hide'; minD = Math.min(minD, 200); }
  }
  C_zoneX = s.zone.x; C_zoneY = s.zone.y;
  // the circle caps the distance we can keep: farthest point inside it from the enemy
  const Rsoon = P.zoneRadiusAt(s.time + 3);
  const wantMax = Math.max(90, Math.min(2 * Rsoon, Rsoon + Math.hypot(en.x - C_zoneX, en.y - C_zoneY)) - 70);
  if (want > wantMax) want = wantMax;
  if (minD > want - 30) minD = want - 30;
  if (minD < 70) minD = 70;

  // ---- goal (battle point or kit) and navigation field ----
  const kitSig = s.repairKits.map((k) => (k.active ? 1 : 0)).join('');
  const needGoal = s.tick - R.goalTick >= 8 || mode !== R.goalMode || kitSig !== R.kitState ||
    Math.hypot(en.x - R.goalEX, en.y - R.goalEY) > 60;
  if (needGoal) {
    let g = chooseGoal(s, mode, want, minD);
    const kit = pickKit(s);
    if (kit) g = [kit.x, kit.y];
    if (Math.hypot(g[0] - R.goalX, g[1] - R.goalY) > 5 || R.goalTick < 0) {
      R.goalX = g[0]; R.goalY = g[1];
      dijkstra(R.goalX, R.goalY, fieldGoal);
    }
    R.goalTick = s.tick; R.goalMode = mode; R.kitState = kitSig; R.goalEX = en.x; R.goalEY = en.y;
    R.kitGoal = !!kit;
  }
  if (R.kitGoal) minD = Math.min(minD, 150);

  // ---- threats ----
  simThreats(s);

  // ---- planner context ----
  C_maxSpeed = me.stats.maxSpeed; C_turnRate = me.stats.turnRate; C_myHp = me.hp;
  C_wl = P.wallsNear(WALLS, me.x, me.y, C_maxSpeed * PH * DT + TANK_R + 30);
  for (let k = 0; k <= PH; k++) { const r = P.zoneRadiusAt(s.time + k * DT); zoneR2[k] = r * r; }
  C_zoneEndR = P.zoneRadiusAt(s.time + PH * DT + 1) - 10;
  C_want = want; C_minD = minD;
  C_dMinW = mode === 'close' || mode === 'chase' ? 1.5 : 4;
  C_dWantW = mode === 'hide' ? 0 : 0.25;
  C_ebs = en.stats.bulletSpeed;
  const jr = ticksUntilReady(en.reloadLeft);
  C_jr = jr <= PH - 4 ? jr : -1;
  C_kitN = 0;
  const myNeed = Math.min(50, me.maxHp - me.hp), enNeed = Math.min(50, en.maxHp - en.hp);
  for (const k of s.repairKits) {
    if (C_kitN >= 4) break;
    const from = k.active ? 0 : Math.ceil(k.respawnIn / DT);
    if (from > PH) continue;
    const zr = P.zoneRadiusAt(s.time + 3);
    const inside = Math.hypot(k.x - C_zoneX, k.y - C_zoneY) < zr - 30;
    const val = (myNeed * 14 + (enNeed >= 30 ? enNeed * 8 : 0)) * (inside ? 1 : 0.2);
    if (val <= 0) continue;
    kitX[C_kitN] = k.x; kitY[C_kitN] = k.y; kitVal[C_kitN] = val; kitFrom[C_kitN] = from;
    C_kitN++;
  }

  runPlanner(me, t0);
  const act = bestActs[0];
  R.prevPlan = Int8Array.from(bestActs);

  // ---- aiming / firing ----
  C_myBS = me.stats.bulletSpeed;
  const jf = ticksUntilReady(me.reloadLeft);
  const fi = Math.min(PH, jf + 1);
  const Mx = bestX[fi], My = bestY[fi];
  const jfa = Math.min(jf, NHT - 20);
  const cands = [];
  for (let h = 0; h < NHYP; h++) cands.push(directAngle(h, Mx, My, jfa, C_myBS));
  // circular weighted mean + sweep between the extremes
  {
    let sx = 0, sy = 0;
    for (let h = 0; h < NHYP; h++) { sx += Math.cos(cands[h]) * hypW[h]; sy += Math.sin(cands[h]) * hypW[h]; }
    const mean = Math.atan2(sy, sx);
    cands.push(mean);
    let lo = 0, hi = 0;
    for (let h = 0; h < NHYP; h++) {
      const d = P.normAngle(cands[h] - mean);
      if (d < lo) lo = d;
      if (d > hi) hi = d;
    }
    if (hi - lo < 1.2) for (let q = 1; q < 12; q++) cands.push(P.normAngle(mean + lo + ((hi - lo) * q) / 12));
  }
  const nDirect = cands.length;
  if (now() - t0 < TICK_BUDGET_MS - 8 && jf <= 12) {
    let hb = 0;
    for (let h = 1; h < NHYP; h++) if (hypW[h] > hypW[hb]) hb = h;
    bankAngles(0, Mx, My, jfa, C_myBS, cands);
    if (hb !== 0) bankAngles(hb, Mx, My, jfa, C_myBS, cands);
    bankAngles(4, Mx, My, jfa, C_myBS, cands);
  }
  let bestA = me.turret, bestS = -1, bestIsBank = false;
  const scores = new Float64Array(cands.length);
  for (let c = 0; c < cands.length; c++) {
    if (c >= nDirect && now() - t0 > TICK_BUDGET_MS) break;
    const sc = evalAngle(cands[c], Mx, My, jfa);
    scores[c] = sc;
    if (sc > bestS + (c >= nDirect ? 0.02 : 0)) { bestS = sc; bestA = cands[c]; bestIsBank = c >= nDirect; }
  }
  // refine around the best bank angle
  if (bestIsBank && now() - t0 < TICK_BUDGET_MS) {
    const base = bestA;
    for (const d of [-0.012, -0.006, 0.006, 0.012]) {
      const a = P.normAngle(base + d);
      const sc = evalAngle(a, Mx, My, jfa);
      if (sc > bestS) { bestS = sc; bestA = a; }
    }
  }
  if (bestS <= 0) bestA = Math.atan2(HY[Math.min(NHT, jf + 12)] - My, HX[Math.min(NHT, jf + 12)] - Mx);

  let turretTurn = turretCmd(me.turret, bestA);
  let fire = false;

  // interception of a bullet the plan cannot avoid
  let intercepting = false;
  if (bestFB >= 0 && bIsEnemy[bestFB]) {
    if (jf === 0) {
      const a = findIntercept(bestX[1], bestY[1], me.turret, bestFB, bestFK);
      if (a !== null) {
        turretTurn = turretCmd(me.turret, a);
        fire = true;
        intercepting = true;
        debug.intercepts++;
      }
    } else if (jf + 1 < bestFK) {
      const a = interceptAim(bestX[Math.min(PH, jf + 1)], bestY[Math.min(PH, jf + 1)], bestFB, jf, bestFK);
      if (a !== null) { turretTurn = turretCmd(me.turret, a); intercepting = true; }
    }
  }

  if (!intercepting && jf === 0) {
    // best angle reachable this tick
    let ra = null, rs = -1;
    const lo = me.turret - TSTEP;
    for (let q = 0; q <= 8; q++) {
      const a = P.normAngle(lo + (2 * TSTEP * q) / 8);
      const sc = evalAngle(a, bestX[1], bestY[1], 0);
      if (sc > rs) { rs = sc; ra = a; }
    }
    for (let c = 0; c < cands.length; c++) {
      if (Math.abs(P.normAngle(cands[c] - me.turret)) <= TSTEP * 0.999 && scores[c] > 0) {
        const sc = evalAngle(cands[c], bestX[1], bestY[1], 0);
        if (sc > rs) { rs = sc; ra = cands[c]; }
      }
    }
    const far = Math.abs(P.normAngle(bestA - me.turret)) > 3 * TSTEP;
    if (ra !== null && rs >= FIRE_T && (rs >= 0.6 * bestS || far)) {
      if (shotSafe(ra, bestX[1], bestY[1])) {
        evalAngle(ra, bestX[1], bestY[1], 0);
        turretTurn = turretCmd(me.turret, ra);
        fire = true;
        debug.shots++;
        if (aimBounced) debug.bank++;
        for (let h = 0; h < NHYP; h++) {
          const m = hypTick[h];
          if (m < 0) continue;
          const i = h * (NHT + 1) + 1 + m;
          R.learn.push({ tick: s.tick + 1 + m, h, x: HX[i], y: HY[i] });
        }
      } else debug.noFireSelf++;
    }
  }

  // bookkeeping
  debug.last = { mode, want: Math.round(want), minD: Math.round(minD), gx: Math.round(R.goalX), gy: Math.round(R.goalY), aim: +bestS.toFixed(2), jf, jr, fire, cost: Math.round(bestCost), kit: !!R.kitGoal };
  R.prevEnemy = { x: en.x, y: en.y, h: en.heading, v: en.speed, tick: s.tick };
  R.lastTick = s.tick;
  if (s.tick % 60 === 0) {
    const alive = new Set(s.bullets.map((b) => b.id));
    for (const id of R.firstSeen.keys()) if (!alive.has(id)) R.firstSeen.delete(id);
  }
  const ms = now() - t0;
  if (ms > debug.maxMs) debug.maxMs = ms;
  return { throttle: ACT_THR[act], turn: ACT_TURN[act], turretTurn, fire };
}

export default {
  name: 'Чемпион-реплика',
  motto: 'Физика, а не удача.',
  stats: { armor: 0, engine: 0, gun: 5, reload: 5 },
  debug,
  hypScore,
  init(info) {
    resetRound(info && info.view);
    if (info && info.view) ensureMap(info.view.arena);
  },
  tick,
};
