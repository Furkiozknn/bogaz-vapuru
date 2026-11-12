// Regression gate: does the candidate build still play as well as the base build, and is its HUD usable on phones?
//
// smoke.mjs only proves "the page loads with 0 errors". On 9 Nov an unreviewed commit made arrows do 0 damage to
// armoured enemies; the bot fell from wave 15 to wave 8 and smoke stayed green. This gate catches that class:
//   1. sim:     the game's own deterministic bot + fast-forward hook runs on BASE and CANDIDATE (headless Chromium),
//               once per seed in GAME.sim.seeds; the metrics are summed over the seeds and compared with per-metric
//               tolerances, and GAME.sim.noNewZero fails any unit (e.g. a shift) that drops to zero on one seed while
//               the base had it above zero, so a stall cannot hide behind a good sum. The candidate's first seed runs
//               twice: different numbers mean the sim is not deterministic and the comparison is void (FAIL).
//   2. layout:  on phone viewports (isMobile + hasTouch) every visible HUD button must lie inside the viewport and be
//               what elementFromPoint returns at its centre. Known offenders are listed in GAME.layout.known and
//               printed as KNOWN (never skipped silently); any other offender fails.
//   3. console: 0 page errors, 0 console errors, 0 failed requests in every run (same rules as smoke.mjs).
//
// Usage: node tools/gate.mjs [options]
//   --base <ref>        base = `git show <ref>:<entry>` (default origin/main)
//   --baseline          compare with tools/gate-baseline.json instead of a git base (used in CI)
//   --record            run the candidate and write tools/gate-baseline.json (then exit)
//   --candidate <file>  candidate HTML (default: the working-tree entry file); assets always come from the working tree
//   --only sim|layout   run one part
//   --strict-layout     KNOWN layout offenders fail too
// Env: SMOKE_CDN_DIR=<dir> serves CDN files from a local npm package copy; GATE_JSON=<file> writes a JSON report.
// Output: "ok"/"FAIL"/"KNOWN"/"note" lines, then RESULT OK|FAIL. Exit 1 on FAIL.
//
// Porting to another game: change only the GAME block below (see tools/GATE.md). Everything after it is generic.

// ======================================================================= per-game config
const GAME = {
  name: 'bogaz-vapuru',
  entry: 'index.html',
  // CDN modules (import map). `pkg` cuts the URL down to a path inside the npm package for SMOKE_CDN_DIR.
  cdn: { match: /cdn\.jsdelivr\.net\/npm\/three@/, pkg: /three@[^/]+\// },
  ignored: /gc\.zgo\.at|goatcounter|fonts\.googleapis\.com|fonts\.gstatic\.com/, // answered with an empty 200
  sim: {
    // ?auto starts the captain bot and the campaign at boot, ?cal plays all 8 shifts once in order (no retries),
    // so every shift's stars count; window.vapurSim(s) steps botTick + stepSim at 1/30 s with seeded RNG (?seed, default 11).
    query: '?auto&cal&noaudio',
    // One seed is not enough: the bot's campaign is chaotic, a harmless change can turn one shift from 3 to 0 stars
    // on seed 11 and the reverse on seed 4. Every build plays the campaign on each seed (`&seed=N` is appended to
    // `query`); stars and score are compared as sums over the seeds. 11 (the game's default) goes first: it is the
    // seed the candidate replays for the determinism check. Leave `seeds` out for a single run without `&seed=`.
    seeds: [11, 1, 2, 3, 4],
    seedParam: 'seed',
    holdFrames: true,     // queue requestAnimationFrame until the sim is done, so wall-clock frames do not advance it
    ready: () => window.__vapurReady === true && typeof window.vapurSim === 'function' && window.vapur.state === 'play',
    run: () => { window.vapurSim(8000); },
    metrics: () => {
      const V = window.vapur, log = V.log;
      return { shifts: log.length, stars: log.reduce((a, r) => a + r.stars, 0), score: log.reduce((a, r) => a + r.score, 0),
        perShift: log.map((r) => r.stars).join(''), done: V.done, gameErrors: V.errors.length };
    },
    // sums over the seeds: every seed must finish all 8 shifts, stars and score may each drop 10 %
    tolerance: { shifts: { abs: 0 }, stars: { rel: 0.10 }, score: { rel: 0.10 }, perShift: { info: true }, done: { info: true }, gameErrors: { max: 0 } },
    // per seed: a shift with 0 stars (or never reached) on the candidate fails unless it is 0 (or never reached) on the base
    noNewZero: { metric: 'perShift', zero: '0' },
    timeoutMs: 300000,
  },
  layout: {
    query: '?auto&noaudio', // the bot starts shift 1 at boot: in-game HUD, no overlay
    viewports: [[390, 844], [360, 740], [412, 915]],
    selectors: ['#topbar button', '#touch [role=slider]', '#touch .tb'],
    known: { ids: [], reason: '' },
    mode: 'enforce', // 'report' = print offenders, never fail (use only with a written reason)
    timeoutMs: 180000,
  },
};
// ======================================================================= generic core
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';
import { createHash } from 'node:crypto';
import { loadavg } from 'node:os';
import { chromium } from 'playwright';

const t0 = Date.now();
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = join(root, 'tools', 'gate-baseline.json');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const only = opt('--only');
const cdnDir = process.env.SMOKE_CDN_DIR;
const report = { game: GAME.name, sim: null, layout: [], console: [], notes: [], result: null };
let failed = false;
const log = (s) => console.log(s);
const fail = (s) => { failed = true; log('FAIL ' + s); };
const note = (s) => { report.notes.push(s); log('note ' + s); };
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);
// A timeout is reported as "infra": the run did not finish, which is a FAIL but not a measured regression.
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`infra: ${what} timed out after ${ms / 1000} s (machine load ${loadavg()[0].toFixed(1)})`)), ms))]);
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 });

// Whole-run watchdog: the machine is shared, never hang (one sim run per seed per build, plus the replay).
const WATCHDOG_MIN = 25;
const watchdog = setTimeout(() => { log(`FAIL gate: whole run exceeded ${WATCHDOG_MIN} min`); log('RESULT FAIL'); process.exit(1); }, WATCHDOG_MIN * 60000);
const SEEDS = GAME.sim.seeds?.length ? GAME.sim.seeds : [null];   // null: one run with the game's own default seed

// ---- builds
const candFile = opt('--candidate') || join(root, GAME.entry);
const builds = { cand: readFileSync(candFile, 'utf8') };
let baseLabel = null, baseline = null;
if (flag('--record')) { /* candidate only */ }
else if (flag('--baseline')) baseline = loadBaseline();
else {
  const ref = opt('--base') || 'origin/main';
  try { builds.base = git('show', `${ref}:${GAME.entry}`); baseLabel = `${ref} (${git('rev-parse', '--short', ref).trim()})`; }
  catch (e) {
    if (opt('--base')) { fail(`base: git show ${ref}:${GAME.entry} failed: ${String(e.stderr || e.message).trim()}`); }
    else { note(`base: ${ref} not available, falling back to ${baselinePath.slice(root.length + 1)}`); baseline = loadBaseline(); }
  }
}
function loadBaseline() {
  if (!existsSync(baselinePath)) { fail(`base: no git base and no ${baselinePath.slice(root.length + 1)} (run with --record)`); return null; }
  const b = JSON.parse(readFileSync(baselinePath, 'utf8'));
  if (b.game !== GAME.name || b.run !== GAME.sim.run.toString()) note('baseline was recorded with a different sim config; numbers may not be comparable');
  // sums over a different seed set are not comparable, and the per-seed zero check needs the per-seed numbers
  if (JSON.stringify(b.seeds ?? [null]) !== JSON.stringify(SEEDS) || !b.perSeed) { fail(`base: ${baselinePath.slice(root.length + 1)} was recorded for seeds ${JSON.stringify(b.seeds ?? 'default')}, the gate plays ${JSON.stringify(SEEDS)} (run with --record on main)`); return null; }
  return b;
}

// ---- static server: /<build>/<entry> is that build's HTML, every other path is the working tree
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
  '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
const server = createServer((req, res) => {
  const parts = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '').split(/[/\\]/);
  const build = parts.shift(), rel = parts.join('/');
  if (builds[build] !== undefined && (rel === '' || rel === GAME.entry)) { res.writeHead(200, { 'content-type': 'text/html' }).end(builds[build]); return; }
  const file = join(root, rel);
  if (!file.startsWith(root) || !existsSync(file)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' }).end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

function cdnBytes(url) {
  const rel = url.split(GAME.cdn.pkg)[1];
  return rel && existsSync(join(cdnDir, rel)) ? readFileSync(join(cdnDir, rel)) : null;
}

// Opens a page with smoke.mjs's rules: analytics/fonts answered empty, CDN from SMOKE_CDN_DIR if set, every
// pageerror / console error / failed request collected.
async function openPage(ctx, url, { holdFrames = false } = {}) {
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('requestfailed', (r) => { if (!GAME.ignored.test(r.url())) errors.push('requestfailed: ' + r.url()); });
  await page.route(GAME.ignored, (r) => {
    const t = r.request().resourceType();
    return r.fulfill({ status: 200, contentType: t === 'stylesheet' ? 'text/css' : t === 'script' ? 'text/javascript' : 'text/plain', body: '' });
  });
  if (cdnDir) {
    await page.route(GAME.cdn.match, async (r) => {
      const body = cdnBytes(r.request().url());
      if (!body) return r.fulfill({ status: 404, body: '' });
      await r.fulfill({ status: 200, contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' }, body });
    });
  }
  if (holdFrames) {
    // Frames queue until __gateRelease(); the game's own loop then cannot advance the sim on wall-clock time.
    await page.addInitScript(() => {
      const raf = window.requestAnimationFrame.bind(window), q = [];
      let hold = true;
      window.requestAnimationFrame = (cb) => (hold ? (q.push(cb), q.length) : raf(cb));
      window.__gateRelease = () => { hold = false; q.splice(0).forEach((cb) => raf(cb)); };
    });
  }
  await page.goto(url, { waitUntil: 'load', timeout: 120000 });
  return { page, errors };
}
// Let up to n frames render (to surface render-time errors), capped at ms of wall-clock: on a loaded machine with
// software GL a single frame can take seconds (model swap, shader compile), and slowness is not what this gate measures.
const frames = (page, n, ms = 20000) => page.evaluate(([n, ms]) => new Promise((done) => {
  let i = 0; const end = performance.now() + ms;
  const f = () => (++i >= n || performance.now() > end ? done(i) : requestAnimationFrame(f)); requestAnimationFrame(f);
}), [n, ms]);

const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
log(`gate ${GAME.name}: chromium ${browser.version()}, candidate ${candFile === join(root, GAME.entry) ? GAME.entry + ' (working tree)' : candFile} sha ${sha(builds.cand)}`);

function consoleCheck(what, errors) {
  report.console.push({ run: what, errors });
  if (errors.length) fail(`console ${what}: ${errors.length} error(s)\n  ` + errors.slice(0, 5).join('\n  '));
}

// ---- 1. sim
async function simRun(build, label, seed) {
  const S = GAME.sim, ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const ts = Date.now(), q = seed == null ? S.query : `${S.query}${S.query.includes('?') ? '&' : '?'}${S.seedParam}=${seed}`;
  label = seed == null ? label : `${label} seed ${seed}`;
  try {
    const { page, errors } = await openPage(ctx, `${origin}/${build}/${GAME.entry}${q}`, { holdFrames: S.holdFrames });
    // polling by interval, not rAF: frames are held, so a rAF poll would never re-check
    await page.waitForFunction(S.ready, null, { timeout: 120000, polling: 250 });
    await withTimeout(page.evaluate(S.run), S.timeoutMs, `sim ${label}`);
    const m = await page.evaluate(S.metrics);
    if (S.holdFrames) { await page.evaluate(() => window.__gateRelease()); await withTimeout(frames(page, 60), 60000, `frames ${label}`); }
    consoleCheck(`sim ${label}`, errors);
    log(`     sim ${label}: ${fmt(m)} (${((Date.now() - ts) / 1000).toFixed(1)} s)`);
    return m;
  } finally { await ctx.close(); }
}
const fmt = (m) => Object.entries(m).map(([k, v]) => `${k} ${v}`).join(' · ');
// one run per seed; returns { perSeed: { seed: metrics }, sum } where sum adds numbers, ANDs booleans, joins strings with '/'
async function simSeeds(build, label) {
  const perSeed = {};
  for (const seed of SEEDS) perSeed[seed ?? 'default'] = await simRun(build, label, seed);
  return { perSeed, sum: sumMetrics(Object.values(perSeed)) };
}
function sumMetrics(list) {
  const out = {};
  for (const k of Object.keys(list[0])) {
    const v = list.map((m) => m[k]);
    out[k] = typeof v[0] === 'number' ? v.reduce((a, x) => a + x, 0) : typeof v[0] === 'boolean' ? v.every(Boolean) : v.join('/');
  }
  return out;
}

function compare(base, cand) {
  const rows = [];
  for (const [k, tol] of Object.entries(GAME.sim.tolerance)) {
    const b = base?.[k], c = cand[k];
    let ok = true, why = '';
    if (tol.info) why = 'info';
    else if (tol.max !== undefined) { ok = c <= tol.max; why = `max ${tol.max}`; }
    else if (typeof b !== 'number') { ok = false; why = 'no base value'; }
    else {
      const allowed = tol.abs !== undefined ? tol.abs : Math.abs(b) * tol.rel;
      ok = c >= b - allowed;
      why = tol.abs !== undefined ? `allowed drop ${tol.abs}` : `allowed drop ${Math.round(tol.rel * 100)}% = ${allowed.toFixed(1)}`;
    }
    const delta = typeof b === 'number' && typeof c === 'number' ? ` (${c - b >= 0 ? '+' : ''}${c - b}${b ? `, ${(((c - b) / Math.abs(b)) * 100).toFixed(1)}%` : ''})` : '';
    rows.push({ metric: k, base: b, cand: c, ok, rule: why });
    const line = `sim ${k}${SEEDS.length > 1 ? ` (sum of ${SEEDS.length} seeds)` : ''}: base ${b} → candidate ${c}${delta}, ${why}`;
    if (tol.info) log('     ' + line); else if (ok) log('ok   ' + line); else fail(line);
  }
  return rows;
}
// Per seed, unit by unit (e.g. the stars of each shift): a unit that is zero or missing (never reached) on the
// candidate fails when the base had it above zero. The sums above can absorb one stalled shift; this cannot.
function noNewZero(basePer, candPer) {
  const Z = GAME.sim.noNewZero; if (!Z) return [];
  const isZero = (s, i) => s[i] === undefined || s[i] === Z.zero, rows = [];
  for (const seed of Object.keys(basePer)) {
    const b = String(basePer[seed][Z.metric] ?? ''), c = String(candPer[seed]?.[Z.metric] ?? '');
    const lost = [...b].map((_, i) => i).filter((i) => isZero(c, i) && !isZero(b, i)).map((i) => i + 1);
    rows.push({ seed, base: b, cand: c, newZero: lost });
    const line = `sim ${Z.metric} seed ${seed}: base ${b || '-'} → candidate ${c || '-'}`;
    if (lost.length) fail(`${line}: unit(s) ${lost.join(', ')} dropped to ${Z.zero} (or were never reached) and are not ${Z.zero} on the base`);
    else log(`ok   ${line}, no unit newly at ${Z.zero}`);
  }
  return rows;
}

if (only !== 'layout' && !failed) {
  try {
    const cand = await simSeeds('cand', 'candidate');
    const c1 = cand.perSeed[SEEDS[0] ?? 'default'], c2 = await simRun('cand', 'candidate replay', SEEDS[0]);
    const det = JSON.stringify(c1) === JSON.stringify(c2);
    if (det) log(`ok   sim determinism: candidate seed ${SEEDS[0] ?? 'default'} run twice, identical metrics`);
    else fail(`sim determinism: candidate gave different metrics on two runs (${fmt(c1)} vs ${fmt(c2)}); comparison is meaningless`);
    report.sim = { seeds: SEEDS, candidate: cand.sum, candidatePerSeed: cand.perSeed, candidateReplay: c2, deterministic: det };
    if (flag('--record')) {
      const rec = { game: GAME.name, recorded: new Date().toISOString(), commit: tryGit('rev-parse', '--short', 'HEAD'), entrySha: sha(builds.cand), run: GAME.sim.run.toString(), seeds: SEEDS, metrics: cand.sum, perSeed: cand.perSeed };
      if (det) { writeFileSync(baselinePath, JSON.stringify(rec, null, 2) + '\n'); log(`ok   record: wrote ${baselinePath.slice(root.length + 1)} ${fmt(cand.sum)}`); }
      else fail('record: not written, sim is not deterministic');
    } else if (det) {
      let base;
      if (builds.base !== undefined && builds.base === builds.cand) {
        base = cand; note(`base ${baseLabel} is byte-identical to the candidate (sha ${sha(builds.cand)}); base metrics = candidate runs`);
      } else if (builds.base !== undefined) { base = await simSeeds('base', `base ${baseLabel}`); }
      else if (baseline) { base = { perSeed: baseline.perSeed, sum: baseline.metrics }; log(`     base = ${baselinePath.slice(root.length + 1)} (commit ${baseline.commit}, recorded ${baseline.recorded})`); baseLabel = 'baseline ' + baseline.commit; }
      if (base) report.sim = { ...report.sim, baseLabel, base: base.sum, basePerSeed: base.perSeed, rows: compare(base.sum, cand.sum), zeroRows: noNewZero(base.perSeed, cand.perSeed) };
    }
  } catch (e) { fail(`sim: ${e.message.split('\n')[0]}`); }
}
function tryGit(...a) { try { return git(...a).trim(); } catch { return null; } }

// ---- 2. layout
async function layoutRun([w, h]) {
  const L = GAME.layout, ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  try {
    const { page, errors } = await openPage(ctx, `${origin}/cand/${GAME.entry}${L.query}`);
    await page.evaluate(() => document.fonts.ready);
    await withTimeout(frames(page, 30), 60000, `layout frames ${w}x${h}`);
    const res = await page.evaluate((sels) => {
      const name = (el) => el.id ? '#' + el.id : el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : '') + (el.textContent.trim() ? ` "${el.textContent.trim().slice(0, 20)}"` : '');
      const seen = new Set(), out = { checked: 0, offenders: [] };
      for (const el of sels.flatMap((s) => [...document.querySelectorAll(s)])) {
        if (seen.has(el)) continue; seen.add(el);
        const cs = getComputedStyle(el), r = el.getBoundingClientRect();
        if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0 || r.width * r.height === 0 || !el.getClientRects().length) continue;
        out.checked++;
        const box = `x ${Math.round(r.left)}-${Math.round(r.right)}, y ${Math.round(r.top)}-${Math.round(r.bottom)}`;
        const inside = r.left >= -0.5 && r.top >= -0.5 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5;
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2, hit = document.elementFromPoint(cx, cy);
        const covered = !hit ? 'nothing (centre off-screen)' : (hit === el || el.contains(hit)) ? null : name(hit.closest('[id]') || hit);
        if (!inside || covered) out.offenders.push({ el: name(el), box, why: [!inside && `outside ${innerWidth}x${innerHeight}`, covered && `elementFromPoint = ${covered}`].filter(Boolean).join('; ') });
      }
      return out;
    }, L.selectors);
    consoleCheck(`layout ${w}x${h}`, errors);
    return res;
  } finally { await ctx.close(); }
}

if (only !== 'sim' && !flag('--record')) {
  const L = GAME.layout, known = new Set(L.known?.ids || []), strict = flag('--strict-layout');
  const knownHit = new Set();
  for (const vp of L.viewports) {
    const tag = `layout ${vp[0]}x${vp[1]}`;
    try {
      const r = await withTimeout(layoutRun(vp), L.timeoutMs, tag);
      report.layout.push({ viewport: vp, ...r });
      if (!r.checked) { fail(`${tag}: no visible element matched ${L.selectors.join(', ')}`); continue; }
      let nKnown = 0;
      for (const o of r.offenders) {
        const id = o.el.split(' ')[0], isKnown = known.has(id);
        if (isKnown) { knownHit.add(id); nKnown++; }
        const line = `${tag} ${o.el}: ${o.why} (${o.box})`;
        if (isKnown && !strict) log('KNOWN ' + line); else if (L.mode === 'report') log('REPORT ' + line); else fail(line + (isKnown ? ' [known, --strict-layout]' : ''));
      }
      if (!r.offenders.length) log(`ok   ${tag}: ${r.checked} buttons inside the viewport and on top`);
      else log(`     ${tag}: ${r.checked} buttons checked, ${r.offenders.length} offender(s), ${nKnown} known`);
    } catch (e) { fail(`${tag}: ${e.message.split('\n')[0].replace(`${tag}: `, '')}`); }
  }
  if (knownHit.size) log(`KNOWN: ${[...knownHit].join(' ')} — ${L.known.reason} (${strict ? 'failing: --strict-layout' : 'not failing; --strict-layout fails on them'})`);
  for (const id of known) if (!knownHit.has(id) && report.layout.length) note(`known layout offender ${id} now passes everywhere; remove it from GAME.layout.known`);
  if (L.mode === 'report') note('layout mode is "report": offenders above are printed but do not fail the gate');
}

await browser.close();
server.close();
clearTimeout(watchdog);
report.result = failed ? 'FAIL' : 'OK';
report.seconds = Math.round((Date.now() - t0) / 1000);
if (process.env.GATE_JSON) writeFileSync(process.env.GATE_JSON, JSON.stringify(report, null, 2) + '\n');
log(`     ${report.seconds} s`);
log(`RESULT ${report.result}`);
process.exit(failed ? 1 : 0);
