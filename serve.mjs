// Static server for the viewer + bot discovery. No dependencies.
//   node serve.mjs [--port 4747]
import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
const portArg = process.argv.indexOf('--port');
const port = portArg > 0 ? Number(process.argv[portArg + 1]) : 4747;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.md': 'text/markdown; charset=utf-8',
};

// Human-driven tank: no bot.js, the viewer reads the keyboard instead and lets the player pick stats.
const HUMAN = {
  id: 'human', dir: '/kit/tank/', model: 'Клавиатура и мышь', color: '#f2f2f2', human: true,
  name: 'Человек', motto: 'Руки не дрожат', stats: { armor: 3, engine: 3, gun: 2, reload: 2 },
};

async function listBots() {
  const bots = [HUMAN];
  const sparring = join(root, 'kit', 'arena', 'sparring');
  for (const name of await readdir(sparring)) {
    if (existsSync(join(sparring, name, 'bot.js'))) {
      bots.push({ id: `sparring/${name}`, dir: `/kit/arena/sparring/${name}/`, model: 'Спарринг', color: '#9aa39a' });
    }
  }
  const contestants = join(root, 'contestants');
  if (existsSync(contestants)) {
    for (const name of await readdir(contestants)) {
      const dir = join(contestants, name);
      if (!(await stat(dir)).isDirectory() || !existsSync(join(dir, 'tank', 'bot.js'))) continue;
      let meta = {};
      try {
        meta = JSON.parse(await readFile(join(dir, 'contestant.json'), 'utf8'));
      } catch {}
      bots.push({ id: `contestants/${name}`, dir: `/contestants/${name}/tank/`, model: meta.model || name, color: meta.color || '#e0e0e0' });
    }
  }
  return bots;
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/bots') {
      res.writeHead(200, { 'content-type': TYPES['.json'], 'cache-control': 'no-store' });
      res.end(JSON.stringify(await listBots()));
      return;
    }
    if (url.pathname === '/' || url.pathname === '/viewer') {
      res.writeHead(302, { location: `/viewer/${url.search}` });
      res.end();
      return;
    }
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith('/')) path += 'index.html';
    const file = normalize(join(root, path));
    if (!file.startsWith(root + sep)) throw Object.assign(new Error('forbidden'), { code: 'EACCES' });
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch (err) {
    res.writeHead(err.code === 'ENOENT' ? 404 : 500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(String(err.code || err.message));
  }
}).listen(port, () => console.log(`Танковая арена: http://localhost:${port}`));
