// Smoke test for this game. Opens index.html in a real browser and fails on page errors.
//
// It runs three checks:
//   1. sri:      every "integrity" hash in the import map matches the bytes the CDN serves right now.
//   2. load:     the page loads with no page errors, no console errors and no failed requests
//                (analytics and web fonts are left out), and a WebGL canvas is drawn.
//   3. tamper:   the CDN module is swapped for a modified copy. In a browser that enforces import-map
//                integrity, the modified code must not run. A browser that does not enforce it is
//                reported, not failed, since the game still works there, only without the check.
//
// Usage: node tools/smoke.mjs [chromium|firefox|webkit ...]   (default: chromium)
// Needs the `playwright` package and its browsers. SMOKE_CDN_DIR=<dir> serves the CDN files from
// a local copy of the npm package instead of the network (for machines without CDN access).
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';
import * as pw from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const mapText = html.match(/<script type="importmap">([\s\S]*?)<\/script>/)?.[1];
if (!mapText) { console.log('FAIL no import map in index.html'); process.exit(1); }
const importMap = JSON.parse(mapText);
const integrity = importMap.integrity || {};
const browsers = process.argv.slice(2).length ? process.argv.slice(2) : ['chromium'];
const cdnDir = process.env.SMOKE_CDN_DIR;
const IGNORED = /gc\.zgo\.at|goatcounter|fonts\.googleapis\.com|fonts\.gstatic\.com/;
let failed = false;
const cases = []; // for the optional JUnit report (SMOKE_JUNIT=<file>)
const fail = (msg, name = msg.split(':')[0]) => { failed = true; console.log('FAIL ' + msg); cases.push({ name, failure: msg }); };
const pass = (msg, name = msg.split(':')[0]) => { console.log('ok   ' + msg); cases.push({ name }); };

// Bytes of a CDN URL: from the local package copy if SMOKE_CDN_DIR is set, else from the network.
async function cdnBytes(url) {
  if (cdnDir) {
    const rel = url.split(/three@[^/]+\//)[1];
    return rel && existsSync(join(cdnDir, rel)) ? readFileSync(join(cdnDir, rel)) : null;
  }
  const r = await fetch(url);
  return r.ok ? Buffer.from(await r.arrayBuffer()) : null;
}

// 1. sri
const sriUrls = Object.keys(integrity);
for (const url of sriUrls) {
  const body = await cdnBytes(url);
  if (!body) { fail(`sri ${url}: could not download`); continue; }
  const got = 'sha384-' + createHash('sha384').update(body).digest('base64');
  if (got === integrity[url]) pass(`sri ${url} (${body.length} bytes)`, `sri ${url}`);
  else fail(`sri ${url}: import map says ${integrity[url]}, CDN serves ${got}`);
}
for (const url of Object.values(importMap.imports || {})) {
  if (!url.endsWith('/') && !integrity[url]) console.log(`note sri ${url}: no integrity hash`);
}

// Static file server for the repository.
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
  const file = join(root, path || 'index.html');
  if (!file.startsWith(root) || !existsSync(file)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' }).end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/index.html`;

async function openPage(browser, { tamper }) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('requestfailed', (r) => { if (!IGNORED.test(r.url())) errors.push('requestfailed: ' + r.url()); });
  // Answer analytics and font requests with an empty body of the right type, so no browser logs them.
  await page.route(IGNORED, (r) => {
    const t = r.request().resourceType();
    const contentType = t === 'stylesheet' ? 'text/css' : t === 'script' ? 'text/javascript' : 'text/plain';
    return r.fulfill({ status: 200, contentType, body: '' });
  });
  if (cdnDir || tamper) {
    await page.route(/cdn\.jsdelivr\.net\/npm\/three@/, async (r) => {
      let body = await cdnBytes(r.request().url());
      if (!body) return r.fulfill({ status: 404, body: '' });
      if (tamper) body = Buffer.concat([body, Buffer.from('\n;globalThis.__smokeTampered = true;\n')]);
      await r.fulfill({ status: 200, contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' }, body });
    });
  }
  await page.goto(base, { waitUntil: 'load', timeout: 60000 });
  // No fixed sleeps: wait for a drawn canvas (or give up after 30 s), then let 120 frames run so
  // errors thrown by the first render and update ticks are caught.
  const drawn = () => [...document.querySelectorAll('canvas')].some((c) => c.width * c.height > 100000);
  if (!tamper) await page.waitForFunction(drawn, null, { timeout: 30000 }).catch(() => {});
  await page.evaluate(() => new Promise((done) => {
    let n = 0;
    const tick = () => (++n >= 120 ? done() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  }));
  const state = await page.evaluate(() => ({
    tampered: globalThis.__smokeTampered === true,
    canvas: [...document.querySelectorAll('canvas')].some((c) => c.width * c.height > 100000),
  }));
  await page.close();
  return { errors, ...state };
}

for (const name of browsers) {
  // Headless Firefox on a machine without a GPU refuses WebGL unless it is forced on.
  // SMOKE_HEADED=1 runs a real window (under xvfb in CI), where Firefox gets a GL context from Mesa.
  const opts = { headless: process.env.SMOKE_HEADED !== '1' };
  if (name === 'firefox') opts.firefoxUserPrefs = { 'webgl.force-enabled': true };
  const browser = await pw[name].launch(opts);
  const version = browser.version();
  // 2. load
  const load = await openPage(browser, { tamper: false });
  if (load.errors.length) fail(`load ${name} ${version}: ${load.errors.length} error(s)\n  ` + load.errors.slice(0, 5).join('\n  '));
  else if (!load.canvas) fail(`load ${name} ${version}: no drawn canvas`);
  else pass(`load ${name} ${version}: canvas drawn, 0 errors`);
  // 3. tamper
  if (sriUrls.length) {
    const t = await openPage(browser, { tamper: true });
    if (!t.tampered) pass(`tamper ${name} ${version}: modified module was blocked`);
    else console.log(`note tamper ${name} ${version}: modified module RAN (this browser does not enforce import-map integrity)`);
  }
  await browser.close();
}
server.close();
if (process.env.SMOKE_JUNIT) {
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const body = cases.map((c) => `  <testcase classname="smoke" name="${esc(c.name)}">` +
    (c.failure ? `<failure message="${esc(c.failure.split('\n')[0])}">${esc(c.failure)}</failure>` : '') + '</testcase>').join('\n');
  const nFail = cases.filter((c) => c.failure).length;
  writeFileSync(process.env.SMOKE_JUNIT, `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="smoke" tests="${cases.length}" failures="${nFail}" errors="0" skipped="0" timestamp="${new Date().toISOString().slice(0, 19)}">\n${body}\n</testsuite>\n`);
}
console.log(failed ? 'RESULT FAIL' : 'RESULT OK');
process.exit(failed ? 1 : 0);
