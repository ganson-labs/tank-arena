// Статический сервер для проверки в браузере (корень — папка участника).
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, resolve, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.svg': 'image/svg+xml', '.json': 'application/json' };
const port = Number(process.argv[2] || 4790);
import { writeFile } from 'node:fs/promises';
http.createServer(async (req, res) => {
  if (req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => { await writeFile(join(root, 'lab', 'browser', 'result.txt'), body); res.writeHead(200); res.end('ok'); });
    return;
  }
  try {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const f = join(root, p);
    if (!f.startsWith(root)) { res.writeHead(403); return res.end(); }
    const data = await readFile(f);
    res.writeHead(200, { 'content-type': types[extname(f)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('nf'); }
}).listen(port, () => console.log('serving', root, 'on', port));
