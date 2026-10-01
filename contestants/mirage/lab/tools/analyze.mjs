// Разбор результатов стенда: попадания по категориям, урон зоны, HP на входе в концовку.
//   node lab/tools/analyze.mjs v8-champv2
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const name = process.argv[2];
const { results: rs } = JSON.parse(readFileSync(join(root, 'lab', 'results', name + '.json')));
const n = rs.length;
const cnt = (f) => rs.filter(f).length;
console.log(`${name}: ${n} раундов, A побед ${cnt((r) => r.winner === 'A')}, поражений ${cnt((r) => r.winner === 'B')}, ничьих ${cnt((r) => r.winner === 'draw')}`);

// Попадания по A
const hs = rs.flatMap((r) => r.hits.filter((h) => h.victimIsA && !h.self).map((h) => ({ ...h, map: r.map, i: r.i })));
const cat = {};
for (const h of hs) {
  const path = h.flight * 700;
  const ratio = path / Math.max(1, h.fireDist - 29);
  const kind = !h.ricochet ? 'прямой' : ratio > 1.25 ? 'через стену' : 'рикошет у цели';
  const ph = h.t < 60 ? '<60' : h.t < 90 ? '60-90' : '90+';
  cat[kind] = cat[kind] || { '<60': 0, '60-90': 0, '90+': 0 };
  cat[kind][ph]++;
}
console.log('попадания по A (категория × фаза):', JSON.stringify(cat));
const hb = rs.flatMap((r) => r.hits.filter((h) => !h.victimIsA && !h.self).map((h) => ({ ...h })));
const catB = { '<60': 0, '60-90': 0, '90+': 0 };
for (const h of hb) catB[h.t < 60 ? '<60' : h.t < 90 ? '60-90' : '90+']++;
console.log('попадания по B по фазам:', JSON.stringify(catB));

// Зона
const zA = rs.map((r) => r.aT.zoneDamage), zB = rs.map((r) => r.bT.zoneDamage);
console.log(`зона: A всего ${zA.reduce((a, b) => a + b, 0).toFixed(0)} (раундов с уроном >20: ${zA.filter((z) => z > 20).length}), B всего ${zB.reduce((a, b) => a + b, 0).toFixed(0)} (${zB.filter((z) => z > 20).length})`);
const zoneDeaths = rs.filter((r) => r.winner === 'B' && r.aT.zoneDamage >= 40);
console.log('поражения с уроном зоны ≥40:', zoneDeaths.map((r) => `${r.i}:${r.map}(${r.aT.zoneDamage.toFixed(0)})`).join(' '));

// HP на 90 с и исход
const bucket = {};
for (const r of rs) {
  const h = r.hpAt?.[90];
  if (!h) continue;
  const k = h[0] > h[1] ? 'A впереди' : h[0] < h[1] ? 'A позади' : 'равно';
  bucket[k] = bucket[k] || { W: 0, L: 0, D: 0 };
  bucket[k][r.winner === 'A' ? 'W' : r.winner === 'B' ? 'L' : 'D']++;
}
console.log('HP на 90 с → исход:', JSON.stringify(bucket));
const early = rs.filter((r) => r.winner !== 'draw' && r.time < 90);
console.log(`раунды, решённые до 90 с: ${early.length} (A выиграл ${early.filter((r) => r.winner === 'A').length})`);
if (process.argv[3] === 'hits') {
  for (const h of hs.sort((a, b) => a.t - b.t)) {
    const vf = h.victimAtFire;
    const rel = vf ? Math.abs(Math.atan2(Math.sin(vf.h - vf.losAngle), Math.cos(vf.h - vf.losAngle))) : null;
    console.log(`${String(h.i).padStart(3)} ${h.map.padEnd(9)} t${String(h.t).padStart(6)} дист ${h.fireDist} полёт ${h.flight} ${h.ricochet ? 'R' : ' '} стрелок(${vf?.sx},${vf?.sy}) я(${vf?.x},${vf?.y}) курс/линия ${rel?.toFixed(2)} v${vf?.v} отскок ${h.bounce ? h.bounce.join(',') : '-'} удар(${h.at})`);
  }
}
