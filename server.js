const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const PDFS_DIR = path.join(__dirname, 'pdfs');
const PUBLIC_DIR = path.join(__dirname, 'public');

if (!fs.existsSync(PDFS_DIR)) {
  fs.mkdirSync(PDFS_DIR, { recursive: true });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

// Build a safe Content-Disposition using RFC 5987 for non-ASCII names
function contentTypeDisposition(name, attrs) {
  const safe = name.replace(/["\\]/g, '_');
  const ascii = /^[\x20-\x7e]+$/.test(safe) ? safe : 'download.pdf';
  let value = 'inline; filename="' + ascii + '"';
  value += "; filename*=UTF-8''" + encodeURIComponent(safe).replace(/'/g, '%27');
  for (const k in attrs) value += '; ' + k + '="' + attrs[k] + '"';
  return value;
}

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');

  try {
    if (pathname === '/api/pdfs') {
      const files = fs
        .readdirSync(PDFS_DIR)
        .filter((f) => f.toLowerCase().endsWith('.pdf'))
        .map((name) => {
          const full = path.join(PDFS_DIR, name);
          const stat = fs.statSync(full);
          return { name, size: stat.size, modified: stat.mtime };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      return sendJson(res, 200, files);
    }

    if (pathname.startsWith('/api/pdf/')) {
      const name = decodeURIComponent(pathname.slice('/api/pdf/'.length));
      if (name === '' || name.includes('/') || name.includes('\\') || name.includes('..')) {
        return sendJson(res, 400, { error: 'Invalid file name' });
      }
      const filePath = path.join(PDFS_DIR, name);
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        return sendJson(res, 404, { error: 'File not found' });
      }
      const stat = fs.statSync(filePath);
      res.writeHead(200, {
        'Content-Type': MIME['.pdf'],
        'Content-Length': stat.size,
        'Content-Disposition': contentTypeDisposition(name),
      });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    let relative;
    if (pathname === '/' || pathname === '') {
      relative = 'index.html';
    } else {
      relative = pathname.replace(/^\/+/, '');
    }
    const filePath = path.join(PUBLIC_DIR, relative);

    if (!filePath.startsWith(PUBLIC_DIR)) {
      return sendJson(res, 403, { error: 'Forbidden' });
    }
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return sendJson(res, 404, { error: 'Not found' });
    }
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const stat = fs.statSync(filePath);
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size });
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: 'Internal server error' });
  }
});

server.listen(PORT, () => {
  console.log('PDF Tool v0.1 running at http://localhost:' + PORT);
});
