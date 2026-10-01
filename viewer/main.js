import * as E from '/kit/arena/engine.js';
import { BotHost } from './bot-host.js';
import { HumanHost } from './human-host.js';
import { Renderer } from './render.js';
import { Sfx } from './sfx.js';

const $ = (s) => document.querySelector(s);
const R = new Renderer($('#stage'));
const sfx = new Sfx();
const params = new URLSearchParams(location.search);
const ALT_COLOR = '#e0b04a';

const ui = {
  phase: 'menu',
  speed: 1,
  paused: false,
  timeScale: 1,
  score: [0, 0],
  roundIndex: 0,
  firstTo: 4,
  mapIndex: null, // null — карты по кругу
  countdown: null,
  banner: null,
  matchEnd: null,
  tournament: null,
  introStart: 0,
  debug: false,
};
let bots = [];
window.__arena = ui; // for inspection from devtools
window.__renderer = R;
let contestants = null;
let runToken = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wait(ms, token) {
  let left = ms;
  while (left > 0) {
    if (token !== runToken) return false;
    const t0 = performance.now();
    await sleep(Math.min(left, 30));
    if (!ui.paused) left -= performance.now() - t0;
  }
  return token === runToken;
}

// ---------- menu ----------

function showMenu(msg = '', isError = false) {
  runToken++;
  disposeHosts();
  ui.phase = 'menu';
  ui.paused = false;
  $('#menu').hidden = false;
  $('#status').textContent = msg;
  $('#status').classList.toggle('error', isError);
}

async function loadBotList() {
  bots = await (await fetch('/api/bots')).json();
  for (const sel of [$('#botA'), $('#botB')]) {
    sel.innerHTML = '';
    for (const b of bots) {
      const o = document.createElement('option');
      o.value = b.id;
      o.textContent = `${b.model} — ${b.id}`;
      sel.appendChild(o);
    }
  }
  const contest = bots.filter((b) => b.id.startsWith('contestants/'));
  $('#botA').value = params.get('a') || contest[0]?.id || 'sparring/hunter';
  $('#botB').value = params.get('b') || contest[1]?.id || 'sparring/dummy';
  if (params.get('first')) $('#firstTo').value = params.get('first');
  updateHumanStats();
}

// ---------- map picker ----------

function loadMapList() {
  const sel = $('#mapSel');
  sel.innerHTML = '';
  const all = document.createElement('option');
  all.value = '';
  all.textContent = 'По кругу';
  sel.appendChild(all);
  E.MAPS.forEach((m, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = m.name;
    sel.appendChild(o);
  });
  const want = params.get('map');
  if (want != null) {
    const byName = E.MAPS.findIndex((m) => m.name.toLowerCase() === want.toLowerCase());
    const idx = byName >= 0 ? byName : Number(want);
    if (Number.isInteger(idx) && idx >= 0 && idx < E.MAPS.length) sel.value = String(idx);
  }
}

// Fixed map: sides still alternate every round so neither spawn gets an edge.
function planRound(i) {
  if (ui.mapIndex == null) return E.roundPlan(i);
  return { mapIndex: ui.mapIndex, swap: i % 2 === 1 };
}

// ---------- human stats picker ----------

const statInputs = () => [...document.querySelectorAll('#humanStats input')];
const selectedIsHuman = () => [$('#botA').value, $('#botB').value].some((id) => bots.find((b) => b.id === id)?.human);

function readHumanStats() {
  const stats = {};
  for (const inp of statInputs()) stats[inp.dataset.stat] = Number(inp.value);
  return stats;
}

function updateHumanStats() {
  $('#humanStats').hidden = !selectedIsHuman();
  const stats = readHumanStats();
  const check = E.checkStats(stats);
  const total = E.STAT_KEYS.reduce((s, k) => s + (stats[k] || 0), 0);
  $('#statSum').textContent = check.ok ? `${total} / ${E.STAT_POINTS}` : check.error;
  $('#statSum').classList.toggle('error', !check.ok);
}

const hs = (params.get('hs') || '').split(',').map(Number);
if (hs.length === 4 && hs.every(Number.isInteger)) statInputs().forEach((inp, i) => (inp.value = hs[i]));
for (const inp of statInputs()) inp.addEventListener('input', updateHumanStats);
for (const sel of [$('#botA'), $('#botB')]) sel.addEventListener('change', updateHumanStats);

function loadImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = `${url}?v=${Date.now()}`;
  });
}

const makeHost = (entry) => (entry.human ? new HumanHost(entry, R) : new BotHost(entry));
const humanPlaying = () => Boolean(contestants?.some((c) => c.entry.human)) && (ui.phase === 'countdown' || ui.phase === 'fight');

async function loadContestant(entry) {
  const host = makeHost(entry);
  const info = await host.load();
  const check = E.checkStats(info.stats);
  if (!check.ok) {
    host.dispose();
    throw new Error(`${entry.id}: ${check.error}`);
  }
  const [body, turret] = await Promise.all([loadImage(`${entry.dir}body.svg`), loadImage(`${entry.dir}turret.svg`)]);
  return {
    id: entry.id,
    entry,
    host,
    name: (info.name || entry.id).slice(0, 20),
    motto: (info.motto || '').slice(0, 60),
    model: entry.model,
    color: entry.color,
    stats: info.stats,
    art: { body, turret },
  };
}

async function loadHosts(c) {
  // Fresh workers = fresh module state for every match.
  c.host?.dispose();
  c.host = makeHost(c.entry);
  await c.host.load();
}

function disposeHosts() {
  for (const c of contestants || []) c.host?.dispose();
}

async function prepare() {
  sfx.unlock();
  disposeHosts();
  ui.phase = 'loading';
  $('#status').textContent = 'Загружаю ботов…';
  $('#status').classList.remove('error');
  ui.firstTo = Math.max(1, Math.min(9, Number($('#firstTo').value) || 4));
  ui.mapIndex = $('#mapSel').value === '' ? null : Number($('#mapSel').value);
  const ids = [$('#botA').value, $('#botB').value];
  const entries = ids.map((id) => bots.find((b) => b.id === id)).map((b) => (b.human ? { ...b, stats: readHumanStats() } : b));
  const loaded = [];
  for (const e of entries) loaded.push(await loadContestant(e));
  if (loaded[0].color.toLowerCase() === loaded[1].color.toLowerCase()) loaded[1].color = ALT_COLOR;
  contestants = loaded;
  await document.fonts.load('40px "Russo One"').catch(() => {});
  $('#menu').hidden = true;
  return contestants;
}

async function start(mode) {
  try {
    await prepare();
  } catch (err) {
    console.error(err);
    showMenu(String(err.message || err), true);
    return;
  }
  if (mode === 'tournament' && contestants.some((c) => c.entry.human)) {
    showMenu('Турнир на скорости — только между ботами: человек не успеет за тиками без пауз.', true);
    return;
  }
  const token = ++runToken;
  if (mode === 'intro') {
    R.contestants = contestants;
    ui.phase = 'intro';
    ui.introStart = performance.now();
    return;
  }
  if (mode === 'tournament') runTournament(token, Number($('#tourRounds').value) || 100);
  else runMatch(token);
}

// ---------- match ----------

function emptyStats() {
  return { rounds: 0, wins: 0, kills: 0, damageDealt: 0, damageTaken: 0, shots: 0, hits: 0, ricochetHits: 0, intercepts: 0, kits: 0, selfDamage: 0 };
}

function accumulate(stats, round, order) {
  round.tanks.forEach((t, side) => {
    const s = stats[order[side]];
    s.rounds++;
    for (const k of ['damageDealt', 'damageTaken', 'shots', 'hits', 'ricochetHits', 'intercepts', 'kits', 'selfDamage']) s[k] += t.tally[k];
    if (round.winner === side) {
      s.wins++;
      if (round.endReason === 'kill') s.kills++;
    }
  });
}

async function initBots(round, order, i) {
  await Promise.all(
    order.map((ci, side) => contestants[ci].host.init({ round: i, side, mapName: round.map.name, view: E.botView(round, side) })),
  );
}

function tickBots(round, order) {
  return Promise.all(order.map((ci, side) => contestants[ci].host.tick(E.botView(round, side))));
}

async function runMatch(token) {
  try {
    await Promise.all(contestants.map(loadHosts));
  } catch (err) {
    showMenu(String(err.message || err), true);
    return;
  }
  if (token !== runToken) return;
  ui.score = [0, 0];
  ui.matchEnd = null;
  const stats = [emptyStats(), emptyStats()];
  let i = 0;
  while (Math.max(...ui.score) < ui.firstTo) {
    ui.roundIndex = i;
    const plan = planRound(i);
    const order = plan.swap ? [1, 0] : [0, 1];
    const round = E.createRound({ mapIndex: plan.mapIndex, tanks: order.map((ci) => ({ name: contestants[ci].name, stats: contestants[ci].stats })) });
    R.newRound(round, order, contestants);
    await initBots(round, order, i);

    ui.phase = 'countdown';
    ui.countdown = { start: performance.now() };
    for (let k = 0; k < 3; k++) {
      sfx.play('beep');
      if (!(await wait(1000, token))) return;
    }
    ui.countdown = null;
    ui.phase = 'fight';
    sfx.play('go');
    R.shout('БОЙ!', '#ffffff');

    let slowUntil = 0;
    let next = performance.now();
    while (!round.over) {
      if (token !== runToken) return;
      while (ui.paused) {
        await sleep(30);
        if (token !== runToken) return;
        next = performance.now();
      }
      const actions = await tickBots(round, order);
      if (token !== runToken) return;
      R.beforeStep(round);
      const events = E.stepRound(round, actions);
      R.afterStep(round, events);
      sfx.events(events);
      if (events.some((e) => e.type === 'death')) slowUntil = performance.now() + 1700;
      const slow = performance.now() < slowUntil;
      ui.timeScale = slow ? 0.25 : 1;
      const dur = (1000 * E.DT) / (ui.speed * (slow ? 0.25 : 1));
      R.tickDuration = dur;
      next += dur;
      const delay = next - performance.now();
      if (delay < -250) next = performance.now();
      else if (delay > 0) await sleep(delay);
    }
    // Let the final explosion play out in slow motion.
    while (performance.now() < slowUntil) {
      if (token !== runToken) return;
      await sleep(30);
    }
    ui.timeScale = 1;

    accumulate(stats, round, order);
    const winnerCi = round.winner == null ? null : order[round.winner];
    if (winnerCi != null) ui.score[winnerCi]++;
    const reason =
      winnerCi == null
        ? round.endReason === 'kill' ? 'оба танка уничтожены' : 'равная броня по истечении времени'
        : round.endReason === 'kill'
          ? `уничтожение за ${round.time.toFixed(1)} с`
          : `по оставшейся броне: ${Math.round((100 * round.tanks[round.winner].hp) / round.tanks[round.winner].stats.maxHp)}% против ${Math.round((100 * round.tanks[1 - round.winner].hp) / round.tanks[1 - round.winner].stats.maxHp)}%`;
    ui.phase = 'roundEnd';
    ui.banner = { winner: winnerCi, reason, start: performance.now() };
    if (winnerCi != null) sfx.play('win');
    if (!(await wait(3400, token))) return;
    ui.banner = null;
    i++;
  }
  const winner = ui.score[0] === ui.score[1] ? null : ui.score[0] > ui.score[1] ? 0 : 1;
  ui.phase = 'matchEnd';
  ui.matchEnd = { winner, score: [...ui.score], stats, start: performance.now() };
  sfx.play('win');
  for (const c of contestants) c.host.dispose();
}

// ---------- tournament ----------

async function runTournament(token, n) {
  try {
    await Promise.all(contestants.map(loadHosts));
  } catch (err) {
    showMenu(String(err.message || err), true);
    return;
  }
  R.contestants = contestants;
  const T = {
    n,
    done: 0,
    wins: [0, 0],
    draws: 0,
    stats: [emptyStats(), emptyStats()],
    byMap: E.MAPS.map(() => ({ wins: [0, 0], draws: 0 })),
    mapIndex: ui.mapIndex,
    finished: false,
  };
  ui.tournament = T;
  ui.phase = 'tournament';
  for (let i = 0; i < n; i++) {
    const plan = planRound(i);
    const order = plan.swap ? [1, 0] : [0, 1];
    const round = E.createRound({ mapIndex: plan.mapIndex, tanks: order.map((ci) => ({ name: contestants[ci].name, stats: contestants[ci].stats })) });
    await initBots(round, order, i);
    while (!round.over) {
      if (token !== runToken) return;
      const actions = await tickBots(round, order);
      E.stepRound(round, actions);
    }
    accumulate(T.stats, round, order);
    const winnerCi = round.winner == null ? null : order[round.winner];
    if (winnerCi == null) {
      T.draws++;
      T.byMap[plan.mapIndex].draws++;
    } else {
      T.wins[winnerCi]++;
      T.byMap[plan.mapIndex].wins[winnerCi]++;
    }
    T.done++;
    T.health = contestants.map((c) => ({ missed: c.host.missed, frozen: c.host.frozen }));
  }
  T.finished = true;
  sfx.play('win');
  for (const c of contestants) c.host.dispose();
}

// ---------- loop & input ----------

let last = performance.now();
function loop(now) {
  // The first rAF timestamp can precede `last`, so clamp dt at zero.
  const dt = Math.max(0, Math.min(0.25, (now - last) / 1000));
  last = now;
  // One bad frame must not kill the loop: show the error instead of a black screen.
  requestAnimationFrame(loop);
  try {
    R.frame(now, dt, ui);
    if (ui.debug && contestants) {
      R.drawDebug(contestants.map((c) => `${c.name} (${c.id}): ошибок ${c.host?.errors ?? 0}, пропусков ${c.host?.missed ?? 0}${c.host?.frozen ? ', ЗАВИС' : ''}${c.host?.lastError ? ' — ' + String(c.host.lastError).split('\n')[0].slice(0, 120) : ''}`));
    }
  } catch (err) {
    if (!loop.reported) console.error(err);
    loop.reported = true;
    const ctx = R.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#400';
    ctx.fillRect(0, 0, ctx.canvas.width, 150);
    ctx.fillStyle = '#fff';
    ctx.font = '16px monospace';
    String(err?.stack || err).split('\n').slice(0, 6).forEach((l, i) => ctx.fillText(l.slice(0, 160), 16, 30 + i * 20));
  }
}
requestAnimationFrame(loop);

addEventListener('keydown', (e) => {
  if (e.target.closest?.('#menu') && e.key !== 'Escape') return;
  const k = e.key.toLowerCase();
  if (humanPlaying()) {
    // Letters and Space belong to the player while the round runs; P pauses instead.
    if (k === 'p') ui.paused = !ui.paused;
    else if (k === 'escape') showMenu();
    else if (k === '1') ui.speed = 1;
    else if (k === '2') ui.speed = 2;
    else if (k === '0') ui.speed = 0.5;
    return;
  }
  if (k === ' ') {
    e.preventDefault();
    if (ui.phase === 'intro') runMatch(runToken);
    else if (ui.phase === 'countdown' || ui.phase === 'fight' || ui.phase === 'roundEnd') ui.paused = !ui.paused;
    else if (ui.phase === 'matchEnd' || (ui.phase === 'tournament' && ui.tournament?.finished)) showMenu();
  } else if (k === 'escape') showMenu();
  else if (k === '1') ui.speed = 1;
  else if (k === '2') ui.speed = 2;
  else if (k === '3') ui.speed = 4;
  else if (k === '0') ui.speed = 0.5;
  else if (k === 'm') sfx.toggle();
  else if (k === 'd') ui.debug = !ui.debug;
  else if (k === 'f') {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen();
  } else if (k === 't' && ui.phase === 'matchEnd' && !contestants.some((c) => c.entry.human)) {
    const token = ++runToken;
    runTournament(token, Number($('#tourRounds').value) || 100);
  }
});

$('#btnIntro').onclick = () => start('intro');
$('#btnFight').onclick = () => start('fight');
$('#btnTour').onclick = () => start('tournament');
$('#btnReload').onclick = () => loadBotList();

loadMapList();
loadBotList()
  .then(() => {
    if (params.get('auto')) start(params.get('auto'));
  })
  .catch((err) => showMenu(`Не удалось получить список ботов: ${err.message}`, true));
