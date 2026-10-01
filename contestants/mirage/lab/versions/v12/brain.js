// Мозг танка: планировщик манёвров, стрелок, перехват, выбор позиции.
// Всё состояние — внутри экземпляра createBrain(): модули без изменяемых глобалов,
// поэтому зеркальный матч в песочнице не смешивает память двух сторон.
import {
  DT, W, H, TANK_R, HIT_R, HIT_R2, MUZZLE, TURRET_STEP, BULLET_LIFE, CLASH_D,
  norm, prepWalls, stepTank, traceBullets, trackHitAt, bulletContact, zoneRadiusAt, segClear, KIT_PICK, ZONE_DPS,
} from './sim.js';
import { rayFree, buildFree, navField, navAt, wallClearance } from './geom.js';

const HZ = 42; // горизонт плана, тиков (1.4 с)
const TRH = 76; // горизонт трасс пуль (план + полёт его следующей пули)
const THR = [1, 1, 1, 0, 0, 0, -1, -1, -1];
const TRN = [-1, 0, 1, -1, 0, 1, -1, 0, 1];
const K1S = [1, 3, 6, 10, 15, 21, 28];
const OPP_W = [1, 0.6, 0.35, 0.2];

// Веса стоимости плана (единица ≈ 1 HP).
const C = {
  HIT: 450, // попадание уже летящей пули: дороже одной «безвыходной» будущей позиции (ESC_FAIL)
  HIT_LATE: 80, // надбавка за раннее попадание (меньше времени на ответ)
  ESC: 3.2, // за пиксель нехватки ширины ухода к его выстрелу
  ESC_CAP: 240,
  ESC_BONUS: 0.15, // за пиксель запаса сверх требуемого (до 15)
  L_REQ: 72, // требуемая ширина ухода: 58 (ширина попадания) + запас
  VBULLET: 22, // виртуальная пуля (упреждение / центр) попадает в продолжение плана
  ESC_FAIL: 230, // к его выстрелу нет ухода с учётом летящих пуль (второй этап)
  REFINE_K: 40, // сколько лучших планов проверять вторым этапом
  DIST_HARD: 2.0, // за пиксель ближе опасной дистанции при прямой видимости
  ZONE: 12, // за тик вне зоны: дороже реального урона 0.67, иначе план откладывает въезд до бесконечности
  ZONE_END: 5, // за пиксель вне будущего круга в конце плана
  ZONE_HARD: 350, // конец плана вне будущего круга — запрет (иначе «ещё секунду снаружи» повторяется до смерти)
  GOAL: 0.22, // за пиксель навигационного расстояния до цели в конце плана
  BUMP: 1.5, // за тик удара о стену
  KIT: 1.2, // за HP лечения
  DENY: 0.6, // за HP, отнятые у раненого соперника
  PREV: 3, // инерция прошлого плана
  NOISE: 3, // случайность выбора среди почти равных
};

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

// Смещение вдоль корпуса за m тиков при полном газе вперёд (thr=1) или назад (thr=-1).
function reach(v0, m, thr, st) {
  const tgt = thr > 0 ? st.maxSpeed : -st.maxSpeed * 0.6;
  const dvMax = 420 * DT;
  let v = v0, s = 0;
  for (let i = 0; i < m; i++) {
    let dv = tgt - v;
    if (dv > dvMax) dv = dvMax; else if (dv < -dvMax) dv = -dvMax;
    v += dv;
    s += v * DT;
  }
  return s;
}

// Таблица бокового ухода в свободном поле: танк в начале координат, линия огня вдоль оси y,
// курс под углом th к оси x (боком = 0, носом = π/2), скорость v. Для каждого числа тиков m —
// крайние смещения по x среди постоянных управлений (газ ±1/0 × поворот ±1/0).
const RT_NV = 17, RT_NT = 25, RT_M = 48;
export function buildReachTable(st) {
  const lo = new Float32Array(RT_NV * RT_NT * RT_M), hi = new Float32Array(RT_NV * RT_NT * RT_M);
  const vmin = -st.maxSpeed * 0.6, vmax = st.maxSpeed;
  const dvMax = 420 * DT;
  for (let vi = 0; vi < RT_NV; vi++) {
    const v0 = vmin + ((vmax - vmin) * vi) / (RT_NV - 1);
    for (let ti = 0; ti < RT_NT; ti++) {
      const th0 = (Math.PI * ti) / (RT_NT - 1);
      const base = (vi * RT_NT + ti) * RT_M;
      for (let m = 0; m < RT_M; m++) { lo[base + m] = 1e9; hi[base + m] = -1e9; }
      for (const thr of [1, 0, -1]) for (const trn of [-1, 0, 1]) {
        let h = th0, v = v0, x = 0;
        const tgt = thr > 0 ? vmax : thr < 0 ? vmin : 0;
        for (let m = 0; m < RT_M; m++) {
          h += trn * st.turnRate * DT;
          let dv = tgt - v;
          if (dv > dvMax) dv = dvMax; else if (dv < -dvMax) dv = -dvMax;
          v += dv;
          x += Math.cos(h) * v * DT;
          if (x < lo[base + m]) lo[base + m] = x;
          if (x > hi[base + m]) hi[base + m] = x;
        }
      }
    }
  }
  return { lo, hi, vmin, vmax };
}
function reachLookup(T, v, th, m, out) {
  let fv = ((v - T.vmin) / (T.vmax - T.vmin)) * (RT_NV - 1);
  if (fv < 0) fv = 0; else if (fv > RT_NV - 1) fv = RT_NV - 1;
  let ft = (th / Math.PI) * (RT_NT - 1);
  if (ft < 0) ft = 0; else if (ft > RT_NT - 1) ft = RT_NT - 1;
  const mi = m < 1 ? 0 : m > RT_M ? RT_M - 1 : m - 1;
  const v0 = Math.min(RT_NV - 2, Math.floor(fv)), t0 = Math.min(RT_NT - 2, Math.floor(ft));
  const av = fv - v0, at = ft - t0;
  const i00 = (v0 * RT_NT + t0) * RT_M + mi, i01 = i00 + RT_M, i10 = i00 + RT_NT * RT_M, i11 = i10 + RT_M;
  const w00 = (1 - av) * (1 - at), w01 = (1 - av) * at, w10 = av * (1 - at), w11 = av * at;
  out.lo = T.lo[i00] * w00 + T.lo[i01] * w01 + T.lo[i10] * w10 + T.lo[i11] * w11;
  out.hi = T.hi[i00] * w00 + T.hi[i01] * w01 + T.hi[i10] * w10 + T.hi[i11] * w11;
  return out;
}

// Тики до готовности к выстрелу: список шагов (0 — ближайший), если стрелять сразу по готовности.
function fireSteps(reloadLeft, reloadTime, hz) {
  const out = [];
  let r = reloadLeft;
  for (let j = 0; j < hz; j++) {
    r = Math.max(0, r - DT);
    if (r <= 0) { out.push(j); r = reloadTime; }
  }
  return out;
}

// Шаги полёта пули до цели на дистанции d: пуля после тика выстрела в 34+v·dt от стрелка.
function flightSteps(d, bulletSpeed) {
  const step = bulletSpeed * DT;
  return Math.max(1, Math.ceil((d - HIT_R - MUZZLE - step) / step));
}

// Дистанция, ближе которой стоящая боком цель (скорость ~20) не набирает ширину ухода lreq.
export function dangerDistance(bulletSpeed, st, lreq) {
  for (let d = 150; d < 1200; d += 5) {
    const m = flightSteps(d, bulletSpeed);
    const L = reach(20, m, 1, st) - reach(20, m, -1, st);
    if (L >= lreq) return d;
  }
  return 1200;
}

// Грани для рикошета: линия отражения центра пули (грань, сдвинутая на радиус пули 5) и её протяжённость.
// n·p = c — линия, (nx, ny) — внешняя нормаль, [lo, hi] — пределы вдоль грани.
function buildFaces(walls) {
  const f = [];
  const R = 5;
  for (const w of walls) {
    f.push({ nx: -1, ny: 0, c: -(w.x - R), lo: w.y, hi: w.y2 });
    f.push({ nx: 1, ny: 0, c: w.x2 + R, lo: w.y, hi: w.y2 });
    f.push({ nx: 0, ny: -1, c: -(w.y - R), lo: w.x, hi: w.x2 });
    f.push({ nx: 0, ny: 1, c: w.y2 + R, lo: w.x, hi: w.x2 });
  }
  f.push({ nx: 1, ny: 0, c: R, lo: 0, hi: H });
  f.push({ nx: -1, ny: 0, c: -(W - R), lo: 0, hi: H });
  f.push({ nx: 0, ny: 1, c: R, lo: 0, hi: W });
  f.push({ nx: 0, ny: -1, c: -(H - R), lo: 0, hi: W });
  return f;
}

export function createBrain(opts = {}) {
  const P = { ...C, ...(opts.weights || {}) };
  const mem = {
    map: null, walls: null, free: null, nav: null, navGoal: null, navTick: -999,
    goal: null, goalTick: -999, goalKind: '',
    prev: null, prevTick: -1,
    lastE: null, bulletAge: new Map(),
    rng: mulberry(opts.seed ?? 1),
    round: 0, side: 0, debug: null, dbgOn: !!opts.debug,
  };
  // Буферы плана
  const NPLAN = 9 + 9 * K1S.length * 8 + 1;
  const plans = new Uint8Array(NPLAN * HZ);
  const PX = new Float64Array(HZ), PY = new Float64Array(HZ), PH = new Float64Array(HZ), PV = new Float64Array(HZ);
  const BX = new Float64Array(HZ), BY = new Float64Array(HZ);
  const zoneR2 = new Float64Array(HZ);
  const st = { x: 0, y: 0, h: 0, v: 0 };
  let RT = null;
  const rOut = { lo: 0, hi: 0 };

  // Видимость от соперника: для 720 направлений — дальность прямой пули до стены.
  const VIS_N = 720;
  const visD = new Float64Array(VIS_N);
  let visX = 0, visY = 0;
  function buildVis(ex, ey, walls) {
    visX = ex; visY = ey;
    for (let i = 0; i < VIS_N; i++) {
      const a = ((i + 0.5) / VIS_N) * 2 * Math.PI - Math.PI;
      visD[i] = rayFree(ex, ey, Math.cos(a), Math.sin(a), walls, 5, 4000);
    }
  }
  const visBin = (a) => { let i = Math.floor(((a + Math.PI) / (2 * Math.PI)) * VIS_N); if (i < 0) i += VIS_N; if (i >= VIS_N) i -= VIS_N; return i; };
  // Видна ли хоть часть моего круга попадания из точки соперника прямой пулей.
  function exposed(px, py) {
    const dx = px - visX, dy = py - visY;
    const d = Math.hypot(dx, dy);
    if (d < HIT_R + 1) return true;
    const a = Math.atan2(dy, dx);
    const del = Math.asin(Math.min(1, 26 / d));
    for (let q = -2; q <= 2; q++) {
      const sq = q / 2;
      const off = 26 * sq;
      const need = d * Math.cos(sq * del) - Math.sqrt(HIT_R2 - off * off);
      if (visD[visBin(a + sq * del)] > need) return true;
    }
    return false;
  }

  // Оценка «сколько ещё ехать» в конце плана: путь по сетке + время доворота к нему.
  function costToGo(x, y, h, st0) {
    const nav = mem.nav, free = mem.free;
    const d = navAt(nav, free, x, y);
    if (d > 1e5) return d;
    if (d < 30) return d;
    // Градиент односторонними разностями: соседние точки у стены могут быть непроходимы.
    const xp = navAt(nav, free, x + 8, y), xm = navAt(nav, free, x - 8, y);
    const yp = navAt(nav, free, x, y + 8), ym = navAt(nav, free, x, y - 8);
    const okxp = xp < 1e5, okxm = xm < 1e5, okyp = yp < 1e5, okym = ym < 1e5;
    const gx = okxp && okxm ? (xp - xm) / 2 : okxp ? xp - d : okxm ? d - xm : 0;
    const gy = okyp && okym ? (yp - ym) / 2 : okyp ? yp - d : okym ? d - ym : 0;
    const gl = Math.hypot(gx, gy);
    if (gl < 1e-6) return d;
    const want = Math.atan2(-gy, -gx);
    const diff = Math.abs(norm(want - h));
    const fwdT = diff / st0.turnRate;
    const revT = (Math.PI - diff) / st0.turnRate + (d * 0.5) / (0.6 * st0.maxSpeed) - (d * 0.5) / st0.maxSpeed;
    return d + Math.min(fwdT, revT) * Math.min(1, d / 120) * st0.maxSpeed;
  }

  function ensureMap(s) {
    if (mem.map === s.arena.mapName && mem.walls) return;
    mem.map = s.arena.mapName;
    mem.walls = prepWalls(s.arena.walls);
    mem.free = buildFree(mem.walls);
    mem.nav = new Float32Array(mem.free.length);
    mem.navZ = navField(mem.free, W / 2, H / 2); // путь до центра зоны (зона всегда сжимается к центру поля)
    mem.navGoal = null;
    mem.faces = buildFaces(mem.walls);
  }

  function init(info) {
    mem.round = info.round;
    mem.side = info.side;
    // Своя случайность на каждый раунд: воспроизводимо в лаборатории, разное от раунда к раунду.
    const salt = (typeof globalThis !== 'undefined' && globalThis.__MIRAGE_SALT) || opts.seed || 0x5eed;
    let hsh = (salt ^ Math.imul(info.round + 1, 0x9e3779b1) ^ Math.imul(info.side + 7, 0x85ebca6b)) >>> 0;
    for (const ch of String(info.mapName || '')) hsh = Math.imul(hsh ^ ch.charCodeAt(0), 0x01000193) >>> 0;
    mem.rng = mulberry(hsh);
    mem.prev = null;
    mem.lastE = null;
    mem.bulletAge.clear();
    mem.goal = null;
    mem.goalTick = -999;
    mem.navGoal = null;
    ensureMap(info.view);
  }

  // ---------- возраст пуль (в состоянии его нет) ----------
  function bulletAges(s) {
    const seen = new Set();
    for (const b of s.bullets) {
      seen.add(b.id);
      let a = mem.bulletAge.get(b.id);
      if (a === undefined) a = { tick: s.tick, age: DT };
      else if (a.tick !== s.tick) { for (let t = a.tick; t < s.tick; t++) a.age += DT; a.tick = s.tick; }
      mem.bulletAge.set(b.id, a);
    }
    for (const id of mem.bulletAge.keys()) if (!seen.has(id)) mem.bulletAge.delete(id);
  }

  // ---------- цель движения ----------
  function chooseGoal(s, ctx) {
    const { me, enemy: en } = s;
    const walls = mem.walls;
    const t = s.time;
    const hpMe = me.hp / me.maxHp, hpEn = en.hp / en.maxHp;
    // Аптечки
    let kitGoal = null;
    const myNeed = me.maxHp - me.hp, enNeed = en.maxHp - en.hp;
    for (const k of s.repairKits) {
      const readyIn = k.active ? 0 : k.respawnIn;
      if (readyIn > 4) continue;
      const dMe = Math.hypot(k.x - me.x, k.y - me.y), dEn = Math.hypot(k.x - en.x, k.y - en.y);
      const tMe = dMe / me.stats.maxSpeed, tEn = dEn / en.stats.maxSpeed;
      const futR = zoneRadiusAt(t + Math.max(tMe, readyIn) + 2);
      if (Math.hypot(k.x - s.zone.x, k.y - s.zone.y) > futR - 20) continue;
      const value = Math.min(50, myNeed) * 1.0 + Math.min(50, enNeed) * 0.6;
      if (value < 20) continue;
      if (tMe + 0.3 > Math.max(tEn, readyIn) + 0.8 && tMe > readyIn + 0.5) continue; // не успеваю раньше
      const score = value - dMe * 0.05;
      if (!kitGoal || score > kitGoal.score) kitGoal = { x: k.x, y: k.y, score };
    }
    if (kitGoal) return { x: kitGoal.x, y: kitGoal.y, kind: 'kit' };

    // Точка боя: перебор сетки.
    const dDanger = ctx.dDangerEn;
    let dDes = dDanger + 70;
    const lead = hpMe - hpEn;
    if (lead > 0.05) dDes = dDanger + 140;
    // Зона: цель должна остаться внутри круга с запасом на дорогу.
    const zr = zoneRadiusAt(t + 15) - 30;
    const zr2 = zoneRadiusAt(t + 22) - 30;
    // Круг меньше двух желаемых дистанций: желаемая — сколько позволяет круг (максимум от соперника).
    if (zr2 < dDes * 0.5 + 60) dDes = Math.max(120, Math.min(dDes, zr2 * 2 - 60));
    const late = t > 80;
    if (t > 88 && lead < -0.01) dDes = Math.min(dDes, 340); // отстаём в концовке — идём на верный выстрел
    let best = null;
    for (let gy = 40; gy <= H - 40; gy += 20) {
      for (let gx = 40; gx <= W - 40; gx += 20) {
        const zd = Math.hypot(gx - s.zone.x, gy - s.zone.y);
        if (zd > zr) continue;
        const cl = wallClearance(gx, gy, walls);
        if (cl < TANK_R + 6) continue;
        const d = Math.hypot(gx - en.x, gy - en.y);
        let sc = -Math.abs(d - dDes) * 1.0;
        if (d < dDanger) sc -= (dDanger - d) * 4;
        sc -= Math.hypot(gx - me.x, gy - me.y) * 0.25;
        sc += Math.min(cl, 90) * 0.5;
        if (zd > zr2) sc -= (zd - zr2) * 2;
        if (late) {
          const covered = !segClear(en.x, en.y, gx, gy, walls, 5);
          if (covered && lead >= -0.01) sc += 60;
          if (!covered && lead < -0.01) sc += 30;
        }
        if (!best || sc > best.sc) best = { x: gx, y: gy, sc };
      }
    }
    return best ? { x: best.x, y: best.y, kind: 'fight' } : { x: s.zone.x, y: s.zone.y, kind: 'center' };
  }

  // ---------- основной ход ----------
  function tick(s) {
    const me = s.me, en = s.enemy;
    if (!me.alive) return { throttle: 0, turn: 0, turretTurn: 0, fire: false };
    ensureMap(s);
    const walls = mem.walls;
    const myS = me.stats, enS = en.stats;
    const mySide = s.side, enSide = 1 - s.side;
    if (!RT) RT = buildReachTable(myS);
    bulletAges(s);

    // Манёвр соперника в прошлом тике (поворот восстанавливается точно).
    let enTurn = 0;
    if (mem.lastE && mem.lastE.tick === s.tick - 1) {
      enTurn = Math.max(-1, Math.min(1, norm(en.heading - mem.lastE.h) / (enS.turnRate * DT)));
    }
    mem.lastE = { tick: s.tick, h: en.heading, v: en.speed, x: en.x, y: en.y };

    const dDangerEn = dangerDistance(enS.bulletSpeed, myS, P.L_REQ); // его пуля против меня
    const dDangerMe = dangerDistance(myS.bulletSpeed, enS, P.L_REQ); // моя пуля против него
    const ctx = { dDangerEn, dDangerMe };

    // Цель движения и навигационное поле.
    if (!mem.goal || s.tick - mem.goalTick >= 10) {
      const g = chooseGoal(s, ctx);
      mem.goal = g;
      mem.goalTick = s.tick;
      if (!mem.navGoal || Math.hypot(mem.navGoal.x - g.x, mem.navGoal.y - g.y) > 10) {
        navField(mem.free, g.x, g.y, mem.nav);
        mem.navGoal = { x: g.x, y: g.y };
      }
    }

    // Пули: трассы на горизонт.
    const bl = s.bullets.map((b) => ({
      x: b.x, y: b.y, vx: b.vx, vy: b.vy, bouncesLeft: b.bouncesLeft, bounced: b.canHitOwner,
      age: mem.bulletAge.get(b.id)?.age ?? DT, owner: b.mine ? mySide : enSide, damage: b.damage,
    }));
    const tracks = traceBullets(bl, walls, TRH);
    // Угрозы: пули соперника и мои (после рикошета). Рамки для быстрого отсева.
    const threats = [];
    for (let i = 0; i < tracks.length; i++) {
      const tr = tracks[i];
      if (tr.owner === mySide && bl[i].bouncesLeft === 0 && !bl[i].bounced) continue;
      // рамка по тикам
      const S = tr.S;
      const box = new Float64Array(TRH * 4);
      let any = false;
      for (let k = 0; k < TRH; k++) {
        let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, ok = false;
        for (let q = 0; q < S; q++) {
          const c = tr.code[k * S + q];
          if (c === 0 || (c === 1 && tr.owner === mySide)) continue;
          const x = tr.xs[k * S + q], y = tr.ys[k * S + q];
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
          ok = true;
        }
        if (ok) { box[k * 4] = x0 - HIT_R - 2; box[k * 4 + 1] = x1 + HIT_R + 2; box[k * 4 + 2] = y0 - HIT_R - 2; box[k * 4 + 3] = y1 + HIT_R + 2; any = true; }
        else { box[k * 4] = 1e9; box[k * 4 + 1] = -1e9; box[k * 4 + 2] = 1e9; box[k * 4 + 3] = -1e9; }
      }
      if (any) threats.push({ tr, box, dmg: tr.damage });
    }

    // Будущие выстрелы соперника и зона.
    const enFire = en.alive ? fireSteps(en.reloadLeft, enS.reloadTime, HZ) : [];
    for (let k = 0; k < HZ; k++) { const r = zoneRadiusAt(s.time + (k + 1) * DT); zoneR2[k] = r * r; }
    const zoneOn = s.time + HZ * DT > 58;
    const zx = s.zone.x, zy = s.zone.y;
    const zEnd = zoneRadiusAt(s.time + HZ * DT + 1.5);

    // Позиция соперника на шаге j (короткая экстраполяция).
    const enPos = (j) => {
      const q = Math.min(j + 1, 6) * DT;
      let x = en.x + en.vx * q, y = en.y + en.vy * q;
      if (x < 24) x = 24; if (x > W - 24) x = W - 24; if (y < 24) y = 24; if (y > H - 24) y = H - 24;
      return [x, y];
    };
    // Круг тесен: держать опасную дистанцию уже нельзя — штраф за близость ослабляем (урезаем под круг).
    const zNear = zoneRadiusAt(s.time + 3);
    const cramped = zNear * 2 < dDangerEn + 160;
    const distK = cramped ? 0.25 : 1;
    // Отстаём по доле HP в концовке: по времени проигрыш гарантирован — открытость дешевле.
    const fMe0 = me.hp / me.maxHp, fEn0 = en.hp / en.maxHp;
    const behindLate = s.time > 88 && fMe0 < fEn0 - 0.01;
    const expK = behindLate ? 0.4 : 1;
    const jE0 = enFire.length ? enFire[0] : HZ;
    const [vex, vey] = enPos(Math.min(jE0, 6));
    buildVis(vex, vey, walls);
    const enReload = Math.round(enS.reloadTime / DT) + 1;

    // Аптечки, пригодные в горизонте.
    const kits = [];
    for (const k of s.repairKits) {
      const readyStep = k.active ? 0 : Math.ceil(k.respawnIn / DT);
      if (readyStep >= HZ) continue;
      const heal = Math.min(50, me.maxHp - me.hp), deny = Math.min(50, en.maxHp - en.hp);
      const val = heal * P.KIT + deny * P.DENY;
      if (val > 1) kits.push({ x: k.x, y: k.y, readyStep, val });
    }

    // ---------- генерация планов ----------
    let np = 0;
    const addPlan = (fn) => { const o = np * HZ; for (let k = 0; k < HZ; k++) plans[o + k] = fn(k); np++; };
    for (let a = 0; a < 9; a++) addPlan(() => a);
    for (let a1 = 0; a1 < 9; a1++) for (const k1 of K1S) for (let a2 = 0; a2 < 9; a2++) {
      if (a2 === a1) continue;
      addPlan((k) => (k < k1 ? a1 : a2));
    }
    let prevIdx = -1;
    if (mem.prev && mem.prevTick === s.tick - 1) {
      prevIdx = np;
      const pv = mem.prev;
      addPlan((k) => pv[Math.min(HZ - 1, k + 1)]);
    }

    // ---------- оценка планов ----------
    const goalOn = !!mem.goal;
    let bestI = -1, bestC = Infinity, bestHits = 0;
    const costs = new Float64Array(np);
    const hitsArr = new Uint8Array(np);
    const firstHit = new Int16Array(np);
    const oppJ = new Int16Array(np * 2).fill(-1);
    const oppC = new Float64Array(np * 2);
    const oppW = new Float64Array(np * 2);
    const dbg = mem.dbgOn ? [] : null;
    for (let pi = 0; pi < np; pi++) {
      const o = pi * HZ;
      st.x = me.x; st.y = me.y; st.h = me.heading; st.v = me.speed;
      let cost = 0, hits = 0, fh = -1;
      let hitMask = 0;
      let cB = 0, cZ = 0, cK = 0, cE = 0, cV = 0, cD = 0;
      let kitMask = 0;
      for (let k = 0; k < HZ; k++) {
        const a = plans[o + k];
        const bumped = stepTank(st, THR[a], TRN[a], myS, walls);
        const x = st.x, y = st.y;
        PX[k] = x; PY[k] = y; PH[k] = st.h; PV[k] = st.v;
        if (bumped) cost += P.BUMP;
        for (let ti = 0; ti < threats.length; ti++) {
          if (hitMask & (1 << ti)) continue;
          const th = threats[ti];
          const b = th.box;
          if (x < b[k * 4] || x > b[k * 4 + 1] || y < b[k * 4 + 2] || y > b[k * 4 + 3]) continue;
          if (trackHitAt(th.tr, k, x, y, mySide)) {
            hitMask |= 1 << ti;
            hits++;
            if (fh < 0) fh = k;
            const c = (P.HIT + P.HIT_LATE * (1 - k / HZ)) * (th.dmg / 43);
            cost += c; cB += c;
          }
        }
        if (zoneOn) {
          const dx = x - zx, dy = y - zy;
          if (dx * dx + dy * dy > zoneR2[k]) { cost += P.ZONE; cZ += P.ZONE; }
        }
        for (let q = 0; q < kits.length; q++) {
          if (kitMask & (1 << q)) continue;
          const kt = kits[q];
          if (k < kt.readyStep) continue;
          const dx = x - kt.x, dy = y - kt.y;
          if (dx * dx + dy * dy < (KIT_PICK - 2) * (KIT_PICK - 2)) { kitMask |= 1 << q; cost -= kt.val; cK -= kt.val; }
        }
      }
      // Готовность к его выстрелам: он стреляет в первый тик, когда видит меня после перезарядки.
      let jj = jE0;
      for (let oi = 0; oi < 3 && jj < HZ - 3; oi++) {
        while (jj < HZ - 3 && !exposed(PX[jj], PY[jj])) jj++;
        if (jj >= HZ - 3) break;
        const j = jj;
        jj += enReload;
        const [oex, oey] = enPos(j);
        const op = { ex: oex, ey: oey, w: OPP_W[oi] };
        const x = PX[j], y = PY[j], h = PH[j], v = PV[j];
        const dx = x - op.ex, dy = y - op.ey;
        const d = Math.hypot(dx, dy);
        if (d < 1) continue;
        // Его башня успеет навестись?
        const need = Math.abs(norm(Math.atan2(dy, dx) - en.turret));
        const turretW = need > TURRET_STEP * (j + 1) + 0.05 ? 0.25 : 1;
        const ww = op.w * turretW;
        const ux = dx / d, uy = dy / d;
        const m = flightSteps(d, enS.bulletSpeed);
        const ch = Math.cos(h), sh = Math.sin(h);
        // Боковой уход поперёк линии огня (с учётом поворота), обрезанный стенами сбоку.
        const nx = -uy, ny = ux;
        const th = Math.abs(norm(h - Math.atan2(ny, nx)));
        reachLookup(RT, v, th, m, rOut);
        const roomP = rayFree(x, y, nx, ny, walls, TANK_R, rOut.hi + 1);
        const roomM = rayFree(x, y, -nx, -ny, walls, TANK_R, -rOut.lo + 1);
        const hiC = Math.min(rOut.hi, roomP), loC = Math.max(rOut.lo, -roomM);
        const L = hiC - loC;
        const def = P.L_REQ - L;
        const f = reach(v, m, 1, myS), g = reach(v, m, -1, myS);
        const ff = f > 0 ? Math.min(f, rayFree(x, y, ch, sh, walls, TANK_R, f + 1)) : f;
        const gg = g < 0 ? -Math.min(-g, rayFree(x, y, -ch, -sh, walls, TANK_R, -g + 1)) : g;
        let ce = def > 0 ? Math.min(P.ESC_CAP, P.ESC * def) : -P.ESC_BONUS * Math.min(30, -def);
        ce *= ww * expK;
        cost += ce; cE += ce;
        if (oi < 2) { oppJ[pi * 2 + oi] = j; oppC[pi * 2 + oi] = ce; oppW[pi * 2 + oi] = ww; }
        if (d < dDangerEn) { const cd = P.DIST_HARD * (dDangerEn - d) * ww * distK; cost += cd; cD += cd; }
        // Виртуальные пули: линейное упреждение и центр множества достижимых точек.
        const vx = ch * v, vy = sh * v;
        let tt = d / enS.bulletSpeed;
        let lx = x, ly = y;
        for (let it = 0; it < 3; it++) { lx = x + vx * tt; ly = y + vy * tt; tt = Math.max(0, Math.hypot(lx - op.ex, ly - op.ey) - MUZZLE) / enS.bulletSpeed + DT; }
        const mid = (ff + gg) / 2;
        const cxp = x + ch * mid, cyp = y + sh * mid;
        for (let vb = 0; vb < 2; vb++) {
          const tx = vb === 0 ? lx : cxp, ty = vb === 0 ? ly : cyp;
          const ddx = tx - op.ex, ddy = ty - op.ey;
          const dl = Math.hypot(ddx, ddy);
          if (dl < 1) continue;
          const bx = ddx / dl, by = ddy / dl;
          const sx = op.ex + bx * MUZZLE, sy = op.ey + by * MUZZLE;
          const maxT = rayFree(sx, sy, bx, by, walls, 5, 3000);
          const stepL = enS.bulletSpeed * DT;
          let hit = false;
          for (let q = 0; q <= m + 3 && !hit; q++) {
            const k = j + q;
            if (k >= HZ) break;
            for (let sub = 1; sub <= 4; sub++) {
              const trav = stepL * (q + sub / 4);
              if (trav > maxT) break;
              const px = sx + bx * trav, py = sy + by * trav;
              const ex = PX[k] - px, ey = PY[k] - py;
              if (ex * ex + ey * ey < HIT_R2) { hit = true; break; }
            }
          }
          if (hit) { cost += P.VBULLET * ww; cV += P.VBULLET * ww; }
        }
      }
      // Конец плана: цель и зона.
      const xe = PX[HZ - 1], ye = PY[HZ - 1];
      let cG = 0;
      // Цель: путь до неё в трёх точках плана — раннее продвижение выгоднее «постоять и потом доехать».
      if (goalOn) {
        cG = (0.25 * costToGo(PX[13], PY[13], PH[13], myS) + 0.25 * costToGo(PX[27], PY[27], PH[27], myS) + 0.5 * costToGo(xe, ye, PH[HZ - 1], myS)) * P.GOAL;
        cost += cG;
      }
      if (zoneOn) {
        const zd = Math.hypot(xe - zx, ye - zy);
        if (zd > zEnd - 15) {
          // Насколько далеко до круга — по пути в обход стен, а не по прямой.
          const pz = Math.max(zd, navAt(mem.navZ, mem.free, xe, ye));
          const c = P.ZONE_HARD + (pz - zEnd + 15) * P.ZONE_END;
          cost += c; cZ += c;
        }
      }
      if (pi === prevIdx) cost -= P.PREV;
      cost += mem.rng() * P.NOISE;
      costs[pi] = cost;
      hitsArr[pi] = hits;
      firstHit[pi] = fh;
      if (dbg) dbg.push({ pi, cost, cB, cZ, cK, cE, cV, cD, cG, xe, ye, desc: `${plans[o]}→${plans[o + HZ - 1]}` });
      if (cost < bestC) { bestC = cost; bestI = pi; bestHits = hits; }
    }

    // ---------- второй этап: уход к его выстрелу с учётом уже летящих пуль ----------
    if (en.alive && P.REFINE_K > 0) {
      const order = Array.from({ length: np }, (_, i) => i).sort((a, b) => costs[a] - costs[b]).slice(0, P.REFINE_K);
      bestC = Infinity;
      for (const pi of order) {
        const o = pi * HZ;
        st.x = me.x; st.y = me.y; st.h = me.heading; st.v = me.speed;
        for (let k = 0; k < HZ; k++) { const a = plans[o + k]; stepTank(st, THR[a], TRN[a], myS, walls); PX[k] = st.x; PY[k] = st.y; PH[k] = st.h; PV[k] = st.v; }
        let c = costs[pi];
        let cR = 0;
        for (let oi = 0; oi < 2; oi++) {
          const j = oppJ[pi * 2 + oi];
          if (j < 0) continue;
          const [ex, ey] = enPos(j);
          const rc = refinedEscape(j, ex, ey, PX[j], PY[j], PH[j], PV[j], threats, myS, enS, mySide, walls, oi === 0) * oppW[pi * 2 + oi] * expK;
          c += rc - oppC[pi * 2 + oi];
          cR += rc;
        }
        costs[pi] = c;
        if (dbg) { dbg[pi].cost = c; dbg[pi].cR = cR; }
        if (c < bestC) { bestC = c; bestI = pi; bestHits = hitsArr[pi]; }
      }
    }

    const o = bestI * HZ;
    const act = plans[o];
    const chosen = plans.slice(o, o + HZ);
    mem.prev = chosen;
    mem.prevTick = s.tick;

    // Позиция после этого хода (для выстрела).
    st.x = me.x; st.y = me.y; st.h = me.heading; st.v = me.speed;
    stepTank(st, THR[act], TRN[act], myS, walls);
    const p1x = st.x, p1y = st.y;
    // Мой план на горизонт (для проверки возврата своей пули).
    st.x = me.x; st.y = me.y; st.h = me.heading; st.v = me.speed;
    for (let k = 0; k < HZ; k++) { const a = chosen[k]; stepTank(st, THR[a], TRN[a], myS, walls); BX[k] = st.x; BY[k] = st.y; }

    // ---------- стрельба ----------
    const canFire = Math.max(0, me.reloadLeft - DT) <= 0;
    let turretTurn = 0, fire = false;
    let aimInfo = null;
    // Перехват, если план всё равно ловит пулю.
    if (bestHits > 0 && canFire) {
      const ic = findIntercept(s, tracks, bl, p1x, p1y, me.turret, myS, mySide, walls, firstHit[bestI]);
      if (ic) { turretTurn = ic.turn; fire = true; aimInfo = { kind: 'intercept' }; }
    }
    if (!fire && en.alive) {
      const aim = bestShot(s, p1x, p1y, me.turret, myS, enS, walls, tracks, bl, mySide, enSide);
      if (aim) {
        const diff = norm(aim.angle - me.turret);
        turretTurn = Math.max(-1, Math.min(1, diff / TURRET_STEP));
        aimInfo = aim;
        if (canFire && Math.abs(diff) <= TURRET_STEP + 1e-9 && aim.coverage >= aim.need && !selfRisk(aim.angle, p1x, p1y, myS, walls, mySide)) {
          fire = shotWorthIt(s, p1x, p1y, myS, enS, dDangerEn, jE0);
          if (aimInfo) aimInfo.held = !fire;
        }
      }
    }

    if (dbg) mem.debug = { tick: s.tick, best: dbg[bestI], all: dbg, nplans: np, goal: mem.goal, aim: aimInfo, fire, bestHits };
    return { throttle: THR[act], turn: TRN[act], turretTurn, fire };
  }

  // Уход к его выстрелу в тик j: 9 постоянных управлений от моего состояния, отсев летящими пулями,
  // затем его лучший выстрел по выжившим — прямой или через грань стены (проверка точной трассой).
  // Возвращает стоимость (0 — надёжный уход).
  const QX = new Float64Array(9 * 40), QY = new Float64Array(9 * 40);
  const QA = new Int16Array(9);
  const surv = new Int8Array(9);
  const qs = { x: 0, y: 0, h: 0, v: 0 };
  const ivA = new Float64Array(18), ivS = new Int8Array(18), ivO = [];
  const cand = [];
  function stabBest(n) {
    ivO.length = 0;
    for (let i = 0; i < n * 2; i++) ivO.push(i);
    ivO.sort((p, q) => ivA[p] - ivA[q] || ivS[q] - ivS[p]);
    let cur = 0, best = 0, bestA = 0;
    for (let k = 0; k < ivO.length; k++) {
      const i = ivO[k];
      cur += ivS[i];
      if (cur > best) { best = cur; const nx = k + 1 < ivO.length ? ivA[ivO[k + 1]] : ivA[i]; bestA = (ivA[i] + nx) / 2; }
    }
    return { best, bestA };
  }
  function refinedEscape(j, ex, ey, x, y, h, v, threats, myS, enS, mySide, walls, banks) {
    const d = Math.hypot(x - ex, y - ey);
    const m = flightSteps(d, enS.bulletSpeed);
    const M2 = Math.min(m + 8, 39, TRH - j - 2);
    if (M2 < 1) return 0;
    const a0 = Math.atan2(y - ey, x - ex);
    const stepB = enS.bulletSpeed * DT;
    let nSurv = 0;
    for (let c = 0; c < 9; c++) {
      qs.x = x; qs.y = y; qs.h = h; qs.v = v;
      let alive = true;
      for (let q = 1; q <= M2; q++) {
        stepTank(qs, THR[c], TRN[c], myS, walls);
        const k = j + q;
        QX[c * 40 + q] = qs.x; QY[c * 40 + q] = qs.y;
        for (let ti = 0; ti < threats.length; ti++) {
          const b = threats[ti].box;
          if (qs.x < b[k * 4] || qs.x > b[k * 4 + 1] || qs.y < b[k * 4 + 2] || qs.y > b[k * 4 + 3]) continue;
          if (trackHitAt(threats[ti].tr, k, qs.x, qs.y, mySide)) { alive = false; break; }
        }
        if (!alive) break;
      }
      surv[c] = alive ? 1 : 0;
      if (alive) nSurv++;
    }
    if (nSurv === 0) return P.ESC_FAIL * 1.2; // уже летящие пули закрывают все уходы
    cand.length = 0;
    // Прямые выстрелы: интервалы углов на выживших в момент прихода пули.
    let nIv = 0;
    for (let c = 0; c < 9; c++) {
      if (!surv[c]) continue;
      let qa = M2;
      for (let q = 1; q <= M2; q++) {
        const dd = Math.hypot(QX[c * 40 + q] - ex, QY[c * 40 + q] - ey);
        if (MUZZLE + stepB * (q + 1) >= dd - 22) { qa = q; break; }
      }
      const tx = QX[c * 40 + qa], ty = QY[c * 40 + qa];
      if (!exposed(tx, ty)) continue;
      const dd = Math.hypot(tx - ex, ty - ey);
      const a = norm(Math.atan2(ty - ey, tx - ex) - a0);
      const del = Math.asin(Math.min(1, (HIT_R - 2) / Math.max(dd, HIT_R)));
      ivA[nIv * 2] = a - del; ivS[nIv * 2] = 1;
      ivA[nIv * 2 + 1] = a + del; ivS[nIv * 2 + 1] = -1;
      nIv++;
    }
    if (nIv > 0) {
      const sb = stabBest(nIv);
      cand.push(a0 + sb.bestA);
      if (sb.best >= nSurv) return P.ESC_FAIL; // прямой выстрел накрывает все уходы
    }
    // Рикошеты через грани: отражаем мои траектории ухода в грани, видимые и ему, и мне.
    if (banks) {
      const faces = mem.faces;
      for (let fi = 0; fi < faces.length; fi++) {
        const F = faces[fi];
        const se = F.nx * ex + F.ny * ey - F.c;
        const sp = F.nx * x + F.ny * y - F.c;
        if (se < 8 || sp < 8) continue;
        // длина пути через грань (по центру) — отсекаем слишком длинные
        const mx = x - 2 * sp * F.nx, my = y - 2 * sp * F.ny;
        const pathL = Math.hypot(mx - ex, my - ey);
        if (pathL > d * 1.8 + 150 || pathL > 1100) continue;
        let n2 = 0;
        for (let c = 0; c < 9; c++) {
          if (!surv[c]) continue;
          let qa = M2, tx = 0, ty = 0;
          for (let q = 1; q <= M2; q++) {
            const px = QX[c * 40 + q], py = QY[c * 40 + q];
            const s2 = F.nx * px + F.ny * py - F.c;
            tx = px - 2 * s2 * F.nx; ty = py - 2 * s2 * F.ny;
            if (MUZZLE + stepB * (q + 1) >= Math.hypot(tx - ex, ty - ey) - 22) { qa = q; break; }
          }
          // точка отскока должна лежать на грани
          const s2 = F.nx * QX[c * 40 + qa] + F.ny * QY[c * 40 + qa] - F.c;
          if (s2 < 5) continue;
          const t = se / (se + s2);
          const bx = ex + (tx - ex) * t, by = ey + (ty - ey) * t;
          const along = F.nx !== 0 ? by : bx;
          if (along < F.lo - 3 || along > F.hi + 3) continue;
          const dd = Math.hypot(tx - ex, ty - ey);
          const a = norm(Math.atan2(ty - ey, tx - ex) - a0);
          const del = Math.asin(Math.min(1, (HIT_R - 2) / Math.max(dd, HIT_R)));
          ivA[n2 * 2] = a - del; ivS[n2 * 2] = 1;
          ivA[n2 * 2 + 1] = a + del; ivS[n2 * 2 + 1] = -1;
          n2++;
        }
        if (n2 === 0) continue;
        const sb = stabBest(n2);
        if (sb.best >= Math.max(2, nSurv * 0.5)) cand.push(a0 + sb.bestA);
      }
    }
    // Точная проверка кандидатов: трасса его пули против выживших траекторий.
    let best = 0;
    for (const ang of cand) {
      const dx = Math.cos(ang), dy = Math.sin(ang);
      const sx = ex + dx * MUZZLE, sy = ey + dy * MUZZLE;
      if (bulletContact(sx, sy, walls, _cc)) continue;
      const tr = traceBullets([{ x: sx, y: sy, vx: dx * enS.bulletSpeed, vy: dy * enS.bulletSpeed, bouncesLeft: 1, bounced: false, age: 0, owner: 1 - mySide, damage: 0 }], walls, M2 + 1)[0];
      let cov = 0;
      for (let c = 0; c < 9; c++) {
        if (!surv[c]) continue;
        // трасса пули начинается в тике j (выстрел), позиции траектории — после ходов j+q
        for (let q = 1; q <= M2; q++) {
          if (q >= tr.deadAt) break;
          if (trackHitAt(tr, q, QX[c * 40 + q], QY[c * 40 + q], mySide)) { cov++; break; }
        }
      }
      if (cov > best) best = cov;
      if (best >= nSurv) break;
    }
    if (best >= nSurv) return P.ESC_FAIL;
    const f = best / nSurv;
    return P.ESC_FAIL * 0.5 * f * f * f + (nSurv < 3 ? 25 : 0);
  }
  const _cc = { nx: 0, ny: 0, depth: 0 };

  // ---------- траектории соперника (мишень) ----------
  const EN_M = 64;
  const EX = new Float64Array(81 * EN_M), EY = new Float64Array(81 * EN_M);
  function enemyTrajectories(en, enS, walls, M) {
    const es = { x: 0, y: 0, h: 0, v: 0 };
    let n = 0;
    for (let a0 = 0; a0 < 9; a0++) {
      for (let a = 0; a < 9; a++) {
        es.x = en.x; es.y = en.y; es.h = en.heading; es.v = en.speed;
        const o = n * EN_M;
        for (let k = 0; k < M; k++) {
          const aa = k === 0 ? a0 : a;
          stepTank(es, THR[aa], TRN[aa], enS, walls);
          EX[o + k] = es.x; EY[o + k] = es.y;
        }
        n++;
      }
    }
    return n;
  }

  // Трасса одной пули в буферы.
  const SB = { xs: new Float64Array(130 * 4), ys: new Float64Array(130 * 4), code: new Uint8Array(130 * 4), S: 4, deadAt: Infinity, goneAt: Infinity, owner: 0 };
  function traceOne(x, y, vx, vy, owner, walls, n) {
    const tr = traceBullets([{ x, y, vx, vy, bouncesLeft: 1, bounced: false, age: 0, owner, damage: 0 }], walls, n)[0];
    return tr;
  }

  function coverageOf(angle, p1x, p1y, myS, walls, mySide, enSide, nTraj, M, preCovered) {
    const dx = Math.cos(angle), dy = Math.sin(angle);
    const mx = p1x + dx * MUZZLE, my = p1y + dy * MUZZLE;
    const c = { nx: 0, ny: 0, depth: 0 };
    if (bulletContact(mx, my, walls, c)) return { cov: 0, hitTick: -1 };
    const tr = traceOne(mx, my, dx * myS.bulletSpeed, dy * myS.bulletSpeed, mySide, walls, M);
    let hit = 0, sumK = 0;
    for (let j = 0; j < nTraj; j++) {
      if (preCovered[j]) { hit++; continue; }
      const o = j * EN_M;
      for (let k = 0; k < M; k++) {
        if (k >= tr.deadAt) break;
        if (trackHitAt(tr, k, EX[o + k], EY[o + k], enSide)) { hit++; sumK += k; break; }
      }
    }
    return { cov: hit / nTraj, tr, meanK: sumK / Math.max(1, hit) };
  }

  // Верный выстрел, но после него 16 тиков без перехвата. Если его ответная пуля долетит раньше,
  // а увернуться на этой дистанции нельзя — это размен. Размен берём, только если он в нашу пользу.
  function shotWorthIt(s, p1x, p1y, myS, enS, dDangerEn, jE0) {
    const me = s.me, en = s.enemy;
    const d = Math.hypot(en.x - p1x, en.y - p1y);
    const myReload = Math.round(myS.reloadTime / DT) + 1;
    const mE = flightSteps(d, enS.bulletSpeed);
    const counter = d < dDangerEn + 10 && exposed(p1x, p1y) && jE0 + mE < myReload + 3;
    if (!counter) return true;
    const dieMe = Math.ceil(me.hp / enS.damage), dieEn = Math.ceil(en.hp / myS.damage);
    if (dieMe > dieEn) return true; // размен выигрываем
    const fMe = me.hp / me.maxHp, fEn = en.hp / en.maxHp;
    if (fMe < fEn - 1e-9) return true; // отстаём: по времени проигрыш, надо рисковать
    return false; // равны или впереди по доле — держим перехват
  }

  function bestShot(s, p1x, p1y, turret, myS, enS, walls, tracks, bl, mySide, enSide) {
    const en = s.enemy;
    const d0 = Math.hypot(en.x - p1x, en.y - p1y);
    // Горизонт мишени: хватает и на рикошетный путь (до ~1.7 прямой дистанции).
    const M = Math.min(EN_M, flightSteps(Math.min(1300, d0 * 1.7 + 200), myS.bulletSpeed) + 8);
    const nTraj = enemyTrajectories(en, enS, walls, M);
    // Уже летящие мои пули, накрывающие траектории соперника.
    const pre = new Uint8Array(nTraj);
    for (let i = 0; i < tracks.length; i++) {
      if (tracks[i].owner !== mySide) continue;
      const tr = tracks[i];
      for (let j = 0; j < nTraj; j++) {
        if (pre[j]) continue;
        const o = j * EN_M;
        for (let k = 0; k < Math.min(M, HZ); k++) {
          if (k >= tr.deadAt) break;
          if (trackHitAt(tr, k, EX[o + k], EY[o + k], enSide)) { pre[j] = 1; break; }
        }
      }
    }
    // Кандидаты: прямые углы на каждую траекторию в момент прихода пули + развёртка интервалов.
    const base = Math.atan2(en.y - p1y, en.x - p1x);
    const step = myS.bulletSpeed * DT;
    const ivs = [];
    const cands = [];
    for (let j = 0; j < nTraj; j++) {
      const o = j * EN_M;
      let kk = M - 1;
      for (let k = 0; k < M; k++) {
        const dd = Math.hypot(EX[o + k] - p1x, EY[o + k] - p1y);
        if (MUZZLE + step * (k + 1) >= dd - 8) { kk = k; break; }
      }
      const tx = EX[o + kk], ty = EY[o + kk];
      const dd = Math.hypot(tx - p1x, ty - p1y);
      const a = norm(Math.atan2(ty - p1y, tx - p1x) - base);
      const half = Math.asin(Math.min(1, (HIT_R - 3) / Math.max(dd, HIT_R)));
      ivs.push([a - half, 1], [a + half, -1]);
      if (j % 9 === 4 || j % 9 === 1 || j % 9 === 7 || j < 9) cands.push(a);
    }
    ivs.sort((p, q) => p[0] - q[0] || q[1] - p[1]);
    let cur = 0, bestCnt = -1, bestA = 0;
    for (let i = 0; i < ivs.length; i++) {
      cur += ivs[i][1];
      if (ivs[i][1] > 0 && cur > bestCnt) {
        bestCnt = cur;
        const nextA = i + 1 < ivs.length ? ivs[i + 1][0] : ivs[i][0];
        bestA = (ivs[i][0] + nextA) / 2;
      }
    }
    cands.push(bestA, bestA - 0.01, bestA + 0.01, 0);
    let best = null;
    for (const a of cands) {
      const ang = norm(base + a);
      const r = coverageOf(ang, p1x, p1y, myS, walls, mySide, enSide, nTraj, M, pre);
      const turnCost = Math.abs(norm(ang - turret));
      if (!best || r.cov > best.coverage + 1e-9 || (Math.abs(r.cov - best.coverage) < 1e-9 && turnCost < best.turnCost)) {
        best = { angle: ang, coverage: r.cov, turnCost, need: 0.999, kind: 'direct' };
      }
    }
    // Рикошет через грань: отражаем его траектории в грани, видимые и мне, и ему.
    // Дорого — только когда пушка почти готова (башня успеет довернуться).
    if (best.coverage < 0.999 && s.me.reloadLeft < 0.35) {
      const faces = mem.faces;
      const bank = [];
      for (let fi = 0; fi < faces.length; fi++) {
        const F = faces[fi];
        const sp = F.nx * p1x + F.ny * p1y - F.c;
        const se = F.nx * en.x + F.ny * en.y - F.c;
        if (sp < 8 || se < 8) continue;
        const mex = en.x - 2 * se * F.nx, mey = en.y - 2 * se * F.ny;
        const pathL = Math.hypot(mex - p1x, mey - p1y);
        if (pathL > d0 * 1.7 + 200 || pathL > 1300) continue;
        const iv = [];
        for (let j = 36; j < 45; j++) {
          const o = j * EN_M;
          let kk = -1, tx = 0, ty = 0;
          for (let k = 0; k < M; k++) {
            const s2 = F.nx * EX[o + k] + F.ny * EY[o + k] - F.c;
            tx = EX[o + k] - 2 * s2 * F.nx; ty = EY[o + k] - 2 * s2 * F.ny;
            if (MUZZLE + step * (k + 1) >= Math.hypot(tx - p1x, ty - p1y) - 8) { kk = k; break; }
          }
          if (kk < 0) continue;
          const s2 = F.nx * EX[o + kk] + F.ny * EY[o + kk] - F.c;
          if (s2 < 5) continue;
          const t = sp / (sp + s2);
          const bx = p1x + (tx - p1x) * t, by = p1y + (ty - p1y) * t;
          const along = F.nx !== 0 ? by : bx;
          if (along < F.lo + 2 || along > F.hi - 2) continue;
          const dd = Math.hypot(tx - p1x, ty - p1y);
          const a = norm(Math.atan2(ty - p1y, tx - p1x) - base);
          const half = Math.asin(Math.min(1, (HIT_R - 3) / Math.max(dd, HIT_R)));
          iv.push([a - half, 1], [a + half, -1]);
        }
        if (iv.length < 4) continue;
        iv.sort((p, q) => p[0] - q[0] || q[1] - p[1]);
        let c2 = 0, bc = 0, ba = 0;
        for (let i = 0; i < iv.length; i++) {
          c2 += iv[i][1];
          if (iv[i][1] > 0 && c2 > bc) { bc = c2; ba = (iv[i][0] + (i + 1 < iv.length ? iv[i + 1][0] : iv[i][0])) / 2; }
        }
        bank.push({ a: ba, cnt: bc, pathL });
      }
      bank.sort((p, q) => q.cnt - p.cnt || p.pathL - q.pathL);
      for (const b of bank.slice(0, 8)) {
        const ang = norm(base + b.a);
        const r = coverageOf(ang, p1x, p1y, myS, walls, mySide, enSide, nTraj, M, pre);
        const turnCost = Math.abs(norm(ang - turret));
        if (r.cov > best.coverage + 1e-9) best = { angle: ang, coverage: r.cov, turnCost, need: 0.999, kind: 'bank' };
      }
    }
    return best;
  }

  // Своя пуля после рикошета вернётся в меня (по моему плану)?
  function selfRisk(angle, p1x, p1y, myS, walls, mySide) {
    const dx = Math.cos(angle), dy = Math.sin(angle);
    const mx = p1x + dx * MUZZLE, my = p1y + dy * MUZZLE;
    const tr = traceOne(mx, my, dx * myS.bulletSpeed, dy * myS.bulletSpeed, mySide, walls, HZ);
    const R2 = (HIT_R + 16) * (HIT_R + 16);
    for (let k = 0; k < HZ; k++) {
      if (k >= tr.deadAt) break;
      const S = tr.S;
      for (let q = 0; q < S; q++) {
        if (tr.code[k * S + q] !== 2) continue;
        const ex = BX[k] - tr.xs[k * S + q], ey = BY[k] - tr.ys[k * S + q];
        if (ex * ex + ey * ey < R2) return true;
      }
    }
    return false;
  }

  // Перехват: выстрел, который встретит летящую в меня пулю в конце какого-то тика.
  function findIntercept(s, tracks, bl, p1x, p1y, turret, myS, mySide, walls, hitTick) {
    const step = myS.bulletSpeed * DT;
    let best = null;
    for (let i = 0; i < tracks.length; i++) {
      const tr = tracks[i];
      if (tr.owner === mySide && !bl[i].bounced) continue;
      for (let k = 0; k < Math.max(1, hitTick); k++) {
        if (k >= tr.deadAt) break;
        // позиция пули в конце тика k
        let bx = NaN, by = NaN;
        for (let q = tr.S - 1; q >= 0; q--) { const c = tr.code[k * tr.S + q]; if (c !== 0 || tr.xs[k * tr.S + q] !== 0) { bx = tr.xs[k * tr.S + q]; by = tr.ys[k * tr.S + q]; break; } }
        if (Number.isNaN(bx)) continue;
        const dd = Math.hypot(bx - p1x, by - p1y);
        const myD = MUZZLE + step * (k + 1);
        if (Math.abs(dd - myD) > CLASH_D - 1) continue;
        const ang = Math.atan2(by - p1y, bx - p1x);
        const diff = norm(ang - turret);
        if (Math.abs(diff) > TURRET_STEP) continue;
        // проверка точной симуляцией: обе пули вместе
        const dx = Math.cos(turret + diff), dy = Math.sin(turret + diff);
        const mx = p1x + dx * MUZZLE, my = p1y + dy * MUZZLE;
        const c = { nx: 0, ny: 0, depth: 0 };
        if (bulletContact(mx, my, walls, c)) continue;
        const two = traceBullets([
          { x: bl[i].x, y: bl[i].y, vx: bl[i].vx, vy: bl[i].vy, bouncesLeft: bl[i].bouncesLeft, bounced: bl[i].bounced, age: bl[i].age, owner: bl[i].owner, damage: bl[i].damage },
          { x: mx, y: my, vx: dx * myS.bulletSpeed, vy: dy * myS.bulletSpeed, bouncesLeft: 1, bounced: false, age: 0, owner: mySide, damage: 0 },
        ], walls, k + 2);
        // Пуля [0] смещена на тик: она уже летела, новая стартует в этот тик — оба трассируются с этого тика.
        if (two[0].goneAt <= k + 1 && two[1].goneAt <= k + 1) {
          if (!best || k < best.k) best = { k, turn: diff / TURRET_STEP };
        }
      }
    }
    return best;
  }

  return { init, tick, mem };
}
