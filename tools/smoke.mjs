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

// Network retry. A CI runner sometimes loses its connection to the CDN for a moment (TLS handshake
// reset, connection refused, DNS hiccup). Such a failure says nothing about the game, so the page
// load is retried up to NET_RETRIES more times, but only when every error of the attempt is of that
// network kind. HTTP 4xx/5xx answers, integrity (SRI) mismatches, page errors and console errors
// are never retried: they fail on the first attempt exactly as before. The last attempt is judged
// with the same checks as a single run.
const NET_RETRIES = 2;
const BACKOFF_MS = [2000, 5000];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Transport-level error texts of Chromium (net::ERR_*), Firefox (NS_ERROR_*) and WebKit (libsoup/GLib).
// net::ERR_ABORTED, net::ERR_FAILED, net::ERR_BLOCKED_*, certificate errors and anything that mentions
// integrity are left out on purpose: they are not transient.
const NET_ERROR = new RegExp([
  String.raw`net::ERR_(CONNECTION_(RESET|CLOSED|REFUSED|TIMED_OUT|FAILED)|TIMED_OUT|NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED`,
  String.raw`INTERNET_DISCONNECTED|NETWORK_CHANGED|NETWORK_IO_SUSPENDED|ADDRESS_UNREACHABLE|EMPTY_RESPONSE`,
  String.raw`SSL_PROTOCOL_ERROR|HTTP2_[A-Z_]+|QUIC_PROTOCOL_ERROR|SOCKET_NOT_CONNECTED|PROXY_CONNECTION_FAILED)\b`,
  String.raw`NS_ERROR_(NET_[A-Z_]+|CONNECTION_REFUSED|UNKNOWN_HOST|OFFLINE|PROXY_CONNECTION_REFUSED)\b`,
  String.raw`TLS handshake|SSL handshake|connection reset|connection refused|connection terminated|connection was lost`,
  String.raw`could not connect|could not resolve|error resolving|network is unreachable|timed out`,
].join('|'), 'i');
const NOT_NETWORK = /integrity|SRI\b|digest|certificate|CERT_/i;
const isNetworkText = (t) => NET_ERROR.test(t || '') && !NOT_NETWORK.test(t || '');
// What a browser reports when a module could not be fetched; only counted as a network error when
// the same attempt also has a network-level requestfailed.
const MODULE_FETCH_FAILED = /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i;

// Bytes of a CDN URL: from the local package copy if SMOKE_CDN_DIR is set, else from the network.
// A thrown fetch (no HTTP answer at all) is retried; a non-2xx answer is returned as null at once.
async function cdnBytes(url) {
  if (cdnDir) {
    const rel = url.split(/three@[^/]+\//)[1];
    return rel && existsSync(join(cdnDir, rel)) ? readFileSync(join(cdnDir, rel)) : null;
  }
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url);
      if (!r.ok) return null;
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      if (attempt >= NET_RETRIES) throw e;
      console.log(`retry fetch ${url}: attempt ${attempt + 1}/${NET_RETRIES + 1} got a network error ` +
        `(${e.cause?.code || e.cause?.message || e.message}); retrying in ${BACKOFF_MS[attempt] / 1000} s`);
      await sleep(BACKOFF_MS[attempt]);
    }
  }
}

// 1. sri
const sriUrls = Object.keys(integrity);
for (const url of sriUrls) {
  let body;
  try { body = await cdnBytes(url); } catch (e) { fail(`sri ${url}: could not download (${e.cause?.code || e.message})`); continue; }
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

// One page load. Besides the error list it says whether the attempt may be retried: only when it hit at
// least one network-level failure and nothing else (no HTTP error status, no other page or console error).
async function openPageOnce(browser, { tamper }) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  let netFailures = 0; // requestfailed or page.goto with a transport-level error text
  let hard = 0;        // any error that is not of the network kind
  page.on('pageerror', (e) => {
    errors.push('pageerror: ' + e.message);
    if (!MODULE_FETCH_FAILED.test(e.message)) hard++;
  });
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    errors.push('console: ' + text);
    const netText = /^Failed to load resource/i.test(text) && isNetworkText(text);
    if (!netText && !MODULE_FETCH_FAILED.test(text)) hard++;
  });
  page.on('requestfailed', (r) => {
    if (IGNORED.test(r.url())) return;
    const why = r.failure()?.errorText || 'unknown';
    errors.push(`requestfailed: ${r.url()} (${why})`);
    if (isNetworkText(why)) netFailures++; else hard++;
  });
  // An HTTP error answer is never a network hiccup: it blocks the retry even if the browser logs nothing.
  page.on('response', (r) => { if (r.status() >= 400 && !IGNORED.test(r.url())) hard++; });
  // Answer analytics and font requests with an empty body of the right type, so no browser logs them.
  await page.route(IGNORED, (r) => {
    const t = r.request().resourceType();
    const contentType = t === 'stylesheet' ? 'text/css' : t === 'script' ? 'text/javascript' : 'text/plain';
    return r.fulfill({ status: 200, contentType, body: '' });
  });
  if (cdnDir || tamper) {
    await page.route(/cdn\.jsdelivr\.net\/npm\/three@/, async (r) => {
      let body;
      // Node could not reach the CDN even after its own retries: show the page a network failure.
      try { body = await cdnBytes(r.request().url()); } catch { return r.abort('connectionreset'); }
      if (!body) return r.fulfill({ status: 404, body: '' });
      if (tamper) body = Buffer.concat([body, Buffer.from('\n;globalThis.__smokeTampered = true;\n')]);
      await r.fulfill({ status: 200, contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' }, body });
    });
  }
  try {
    await page.goto(base, { waitUntil: 'load', timeout: 60000 });
  } catch (e) {
    // A stalled CDN request keeps the load event from firing; that is the only goto failure we retry.
    if (!(e instanceof pw.errors.TimeoutError) && !isNetworkText(e.message)) throw e;
    errors.push('goto: ' + e.message.split('\n')[0]);
    netFailures++;
    await page.close();
    return { errors, tampered: false, canvas: false, retryable: hard === 0 };
  }
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
  return { errors, ...state, retryable: netFailures > 0 && hard === 0 };
}

// Loads the page, retrying only attempts whose every error is network-level (see NET_RETRIES).
async function openPage(browser, { tamper, label }) {
  for (let attempt = 0; ; attempt++) {
    const res = await openPageOnce(browser, { tamper });
    if (!res.retryable || attempt >= NET_RETRIES) return { ...res, retries: attempt };
    console.log(`retry ${label}: attempt ${attempt + 1}/${NET_RETRIES + 1} failed with network errors only; ` +
      `retrying in ${BACKOFF_MS[attempt] / 1000} s\n  ` + res.errors.slice(0, 5).join('\n  '));
    await sleep(BACKOFF_MS[attempt]);
  }
}
const retried = (n) => (n ? ` (after ${n} network ${n === 1 ? 'retry' : 'retries'})` : '');

for (const name of browsers) {
  // Headless Firefox on a machine without a GPU refuses WebGL unless it is forced on.
  // SMOKE_HEADED=1 runs a real window (under xvfb in CI), where Firefox gets a GL context from Mesa.
  const opts = { headless: process.env.SMOKE_HEADED !== '1' };
  if (name === 'firefox') opts.firefoxUserPrefs = { 'webgl.force-enabled': true };
  const browser = await pw[name].launch(opts);
  const version = browser.version();
  // 2. load
  const load = await openPage(browser, { tamper: false, label: `load ${name} ${version}` });
  if (load.errors.length) fail(`load ${name} ${version}: ${load.errors.length} error(s)${retried(load.retries)}\n  ` + load.errors.slice(0, 5).join('\n  '));
  else if (!load.canvas) fail(`load ${name} ${version}: no drawn canvas${retried(load.retries)}`);
  else pass(`load ${name} ${version}: canvas drawn, 0 errors${retried(load.retries)}`);
  // 3. tamper
  if (sriUrls.length) {
    const t = await openPage(browser, { tamper: true, label: `tamper ${name} ${version}` });
    // A page that never loaded cannot show whether the modified module was blocked.
    if (t.retryable) fail(`tamper ${name} ${version}: page did not load (network errors only)${retried(t.retries)}\n  ` + t.errors.slice(0, 5).join('\n  '));
    else if (!t.tampered) pass(`tamper ${name} ${version}: modified module was blocked${retried(t.retries)}`);
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
