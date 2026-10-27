'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { listenHost, loadConfig } = require('../core/config');
const { renderDatenschutz, renderImpressum } = require('../core/legal');

const ROOT = path.join(__dirname, '..', 'ui');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};
const PAGES = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/mockup.html': 'mockup.html',
  '/demo/mockup.html': 'mockup.html',
  '/datenschutz': 'datenschutz.html',
  '/impressum': 'impressum.html',
  '/app.css': 'app.css',
  '/app.js': 'app.js',
  '/tgLaunch.js': 'tgLaunch.js',
  '/fragebogen.js': 'fragebogen.js',
};

function sendFile(res, file) {
  const ext = path.extname(file);
  const body = fs.readFileSync(file);
  res.writeHead(200, {
    'Content-Type': TYPES[ext] || 'application/octet-stream',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; style-src 'self'; img-src 'self' data:; script-src 'self'",
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function proxy(req, res, engine) {
  const target = new URL(req.url, engine);
  const headers = { ...req.headers, host: target.host };
  const out = http.request(target, { method: req.method, headers }, (upstream) => {
    const responseHeaders = { ...upstream.headers, 'cache-control': 'no-store' };
    res.writeHead(upstream.statusCode || 502, responseHeaders);
    upstream.pipe(res);
  });
  out.on('error', () => {
    if (res.headersSent) return;
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error_code: 'engine_unreachable' }));
  });
  req.pipe(out);
}

function wantsJson(req) {
  return String(req.headers.accept || '').includes('application/json');
}

function createWebServer(options = {}) {
  const engine = (options.engine || process.env.ENGINE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
  return http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://web.local');
    const pathname = url.pathname;
    if (pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
    if (req.method === 'GET' && (pathname === '/datenschutz' || pathname === '/impressum')) {
      const config = loadConfig(process.env);
      const html = pathname === '/impressum' ? renderImpressum(config) : renderDatenschutz(config);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'self'; style-src 'self'; img-src 'self' data:; script-src 'self'",
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(html);
      return;
    }
    if (req.method === 'GET' && PAGES[pathname]) {
      sendFile(res, path.join(ROOT, PAGES[pathname]));
      return;
    }
    if (req.method === 'GET' && !wantsJson(req) && /^\/f\/[^/]+$/.test(pathname)) {
      sendFile(res, path.join(ROOT, 'fragebogen.html'));
      return;
    }
    if (pathname.startsWith('/v1/') || pathname.startsWith('/f/')) {
      proxy(req, res, engine);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });
}

function start() {
  const port = Number(process.env.WEB_PORT || process.env.PORT || 8791);
  const host = listenHost();
  const server = createWebServer();
  server.listen(port, host, () => {
    console.log(`web_listening host=${host} port=${port} engine=${process.env.ENGINE_URL || 'http://127.0.0.1:8787'}`);
  });
  return server;
}

if (require.main === module) start();

module.exports = { createWebServer, start };
