/* A static file server, because the app is ES modules and a file:// URL cannot
 * import them. No dependency, no build, no config: `npm run dev`. */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const port = Number(process.env.PORT) || 8765;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml',
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${port}`);
    // normalize() collapses any ../ before it can escape the project directory.
    let path = join(root, normalize(decodeURIComponent(url.pathname)));
    if (!path.startsWith(root)) { res.writeHead(403).end('no'); return; }
    const s = await stat(path).catch(() => null);
    if (s?.isDirectory()) path = join(path, 'index.html');
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch (_) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  }
}).listen(port, () => console.log(`Irrigation Lab on http://localhost:${port}`));
