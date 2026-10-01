// Калибровка порога выстрела: доля попаданий по корзинам покрытия (по журналу выстрелов стенда).
//   node lab/tools/calib.mjs calib-v4full
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { results } = JSON.parse(readFileSync(join(root, 'lab', 'results', process.argv[2] + '.json')));
const shots = results.flatMap((r) => (r.shots || []).map((s) => ({ ...s, map: r.map })));
const bins = [0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.999, 1.01];
const row = (label, list) => {
  const n = list.length;
  const c = (o) => list.filter((s) => s.out === o).length;
  return `${label.padEnd(26)} n=${String(n).padStart(4)}  попал ${String(c('hit')).padStart(3)} (${n ? ((100 * c('hit')) / n).toFixed(1) : '—'}%)  сбит ${String(c('clash')).padStart(3)}  мимо ${String(c('miss')).padStart(4)}`;
};
for (const kind of ['direct', 'bank']) {
  console.log(`— ${kind}`);
  for (let i = 0; i < bins.length - 1; i++) {
    const lo = bins[i], hi = bins[i + 1];
    const l = shots.filter((s) => s.kind === kind && s.cov >= lo && s.cov < hi);
    if (l.length) console.log(row(`покрытие ${lo}–${hi < 1.01 ? hi : 1}`, l));
  }
  // по дистанции для полного покрытия
  const full = shots.filter((s) => s.kind === kind && s.cov >= 0.999);
  for (const [a, b] of [[0, 300], [300, 380], [380, 440], [440, 520], [520, 2000]]) {
    const l = full.filter((s) => s.d >= a && s.d < b);
    if (l.length) console.log(row(`  полное, дист ${a}–${b}`, l));
  }
  // его перезарядка: может ли он сбить
  const canInt = shots.filter((s) => s.kind === kind && s.cov >= 0.9 && s.enReload < 0.3);
  const noInt = shots.filter((s) => s.kind === kind && s.cov >= 0.9 && s.enReload >= 0.3);
  if (canInt.length) console.log(row('  ≥0.9, он скоро заряжен', canInt));
  if (noInt.length) console.log(row('  ≥0.9, он перезаряжается', noInt));
}
console.log(row('перехваты (мои)', shots.filter((s) => s.kind === 'intercept')));
