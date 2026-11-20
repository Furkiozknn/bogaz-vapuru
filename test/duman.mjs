// Duman testi: sayfa açılıyor mu, konsol hatası var mı, oyun başlıyor mu, bir etkileşim durumu değiştiriyor mu,
// eski kayıtla açılış çalışıyor mu, telefon görünümünde taşma var mı. Depoya hiçbir bağımlılık eklenmez.
//
// Kullanım:  node test/duman.mjs [klasör]        (klasör verilmezse deponun kökü)
// Gerekli:   `playwright-core` (depo dışında kurulu olabilir: PW_MODULE=<node_modules'ın bulunduğu klasör>)
//            ve bir Chromium tabanlı tarayıcı: CHROMIUM=<tarayıcı exe yolu> (verilmezse Playwright'ın kendi tarayıcısı).
// Çıktı: "ok" / "n/a" / "FAIL" satırları, en sonda RESULT; hata varsa çıkış kodu 1.
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.argv[2] || join(here, '..'));
const req = createRequire(process.env.PW_MODULE ? pathToFileURL(join(process.env.PW_MODULE, 'x.js')) : import.meta.url);
const { chromium } = req('playwright-core');
const IGNORED = /gc\.zgo\.at|goatcounter|fonts\.googleapis\.com|fonts\.gstatic\.com/;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.gif': 'image/gif', '.mp4': 'video/mp4' };
let failed = false;
const ok = (m) => console.log('ok   ' + m);
const na = (m) => console.log('n/a  ' + m);
const fail = (m) => { failed = true; console.log('FAIL ' + m); };
const check = (c, m) => (c ? ok(m) : fail(m));

const srv = createServer((rq, rs) => {
  const p = normalize(decodeURIComponent(new URL(rq.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
  let f = join(root, p || 'index.html');
  if (!f.startsWith(root)) { rs.writeHead(403).end(); return; }
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!existsSync(f)) { rs.writeHead(404, { 'content-type': 'text/plain' }).end('404'); return; }
  rs.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream' }).end(readFileSync(f));
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + srv.address().port + '/';
console.log('hedef: ' + root);

const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM || undefined, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const attach = (page, errs) => {
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  page.on('requestfailed', (r) => { if (!IGNORED.test(r.url())) errs.push('requestfailed: ' + r.url()); });
  page.on('response', (r) => { if (r.status() >= 400 && !IGNORED.test(r.url())) errs.push(r.status() + ' ' + r.url()); });
};
const ready = (page) => page.waitForFunction(() => window.__vapurReady === true, null, { timeout: 120000 });
const overflow = (page) => page.evaluate(() => {
  const w = innerWidth, bad = [];
  for (const e of document.querySelectorAll('.screen.show button, .screen.show a')) {
    const r = e.getBoundingClientRect(); if (r.width && (r.left < -1 || r.right > w + 1)) bad.push(e.id || e.textContent.trim().slice(0, 20));
  }
  return { h: document.documentElement.scrollWidth > w + 1, bad };
});
try {
  for (const [name, vp, mobile] of [['masaüstü 1366x768', { width: 1366, height: 768 }, false], ['telefon 390x844', { width: 390, height: 844 }, true]]) {
    const ctx = await browser.newContext({ viewport: vp, isMobile: mobile, hasTouch: mobile });
    await ctx.route(IGNORED, (r) => r.fulfill({ status: 200, body: '' }));
    const page = await ctx.newPage();
    const errs = [];
    attach(page, errs);
    const t0 = Date.now();
    await page.goto(base + '?low', { waitUntil: 'load' });
    await ready(page);
    ok(`[${name}] sayfa açıldı, oyun hazır (${Date.now() - t0} ms)`);
    const title = await page.title();
    check(/Boğaz Vapuru/.test(title), `[${name}] başlık: ${title}`);
    const o1 = await overflow(page);
    check(!o1.h && !o1.bad.length, `[${name}] başlık ekranında yatay taşma yok ${o1.bad.join(',')}`);
    const links = await page.$$eval('#sTitle a', (as) => as.map((a) => a.href));
    check(links.includes('https://furkiozknn.github.io/'), `[${name}] başlık ekranında "Diğer oyunlar" (merkez sayfa) bağlantısı var`);
    const ver = await page.evaluate(() => (document.getElementById('verTag') || {}).textContent || '');
    if (ver) ok(`[${name}] sürüm etiketi: ${ver}`); else na(`[${name}] sürüm etiketi bu sürümde yok`);
    if (await page.$('#bNews')) {
      await page.click('#bNews');
      const shown = await page.evaluate(() => document.getElementById('sNews').classList.contains('show') && document.querySelectorAll('#newsList li').length >= 3);
      check(shown, `[${name}] Yenilikler penceresi açılıyor ve maddeleri var`);
      const o = await overflow(page);
      check(!o.h && !o.bad.length, `[${name}] Yenilikler penceresinde taşma yok`);
      await page.keyboard.press('Escape');
      check(await page.evaluate(() => !document.getElementById('sNews').classList.contains('show')), `[${name}] Esc ile kapanıyor`);
      // Kaptan defteri: kayıtlı bir sefer listede görünüyor
      await page.evaluate(() => localStorage.setItem('arena.vapur.log', JSON.stringify([{ d: '2026-11-19', m: 'c', i: 2, st: 3, sc: 812, px: 41 }, { d: '2026-11-18', m: 'e', i: 3, st: 1, sc: 300, px: 12 }])));
      await page.click('#bNews'); await page.click('#bTabLog');
      const rows = await page.evaluate(() => document.querySelectorAll('#logList li').length);
      check(rows === 2, `[${name}] Kaptan defteri 2 kaydı listeliyor (${rows})`);
      const o5 = await overflow(page);
      check(!o5.h && !o5.bad.length, `[${name}] Kaptan defteri sekmesinde taşma yok`);
      await page.click('#bNewsBack');
      check((await page.evaluate(() => window.vapur.state)) === 'title', `[${name}] Geri düğmesi menüye döndürüyor`);
    } else na(`[${name}] Yenilikler penceresi bu sürümde yok`);

    // oyun başlıyor, bir etkileşim durumu değiştiriyor
    await page.click('#bPlay');
    await page.waitForFunction(() => window.vapur && window.vapur.state === 'intro');
    const o2 = await overflow(page);
    check(!o2.h && !o2.bad.length, `[${name}] vardiya ekranında taşma yok ${o2.bad.join(',')}`);
    await page.click('#bStart');
    await page.waitForFunction(() => window.vapur.state === 'play', null, { timeout: 30000 });
    ok(`[${name}] vardiya başladı (state: play)`);
    const a = await page.evaluate(() => ({ t: window.vapur.time, x: window.vapur.player.x, z: window.vapur.player.z }));
    if (mobile) await page.evaluate(() => { window.vapur.input.throttle = 1; }); else await page.keyboard.down('KeyW');
    await page.evaluate(() => window.vapurSim(20));
    if (!mobile) await page.keyboard.up('KeyW');
    const b = await page.evaluate(() => ({ t: window.vapur.time, x: window.vapur.player.x, z: window.vapur.player.z }));
    const moved = Math.abs(b.x - a.x) + Math.abs(b.z - a.z);
    check(b.t > a.t && moved > 5, `[${name}] gaz verince vapur ilerliyor (konum değişti: ${moved.toFixed(1)} m)`);
    await page.click('#bPause');
    check((await page.evaluate(() => window.vapur.state)) === 'paused', `[${name}] duraklatma çalışıyor`);
    const o3 = await overflow(page);
    check(!o3.h && !o3.bad.length, `[${name}] duraklatma ekranında taşma yok`);
    await page.click('#bResume');
    check((await page.evaluate(() => window.vapur.state)) === 'play', `[${name}] devam çalışıyor`);
    // HUD dokunmatik hedefleri
    const small = await page.evaluate(() => [...document.querySelectorAll('#hud button')].filter((e) => { const r = e.getBoundingClientRect(); return r.width && (r.width < 40 || r.height < 40); }).map((e) => e.id + ':' + Math.round(e.getBoundingClientRect().width) + 'x' + Math.round(e.getBoundingClientRect().height)));
    check(small.length === 0, `[${name}] HUD düğmeleri en az 40x40 px ${small.join(' ')}`);
    // vardiyayı bitir -> sonuç ekranı
    await page.evaluate(() => window.vapur.end('clear'));
    await page.waitForFunction(() => window.vapur.state === 'end', null, { timeout: 10000 });
    const o4 = await overflow(page);
    check(!o4.h && !o4.bad.length, `[${name}] sonuç ekranında taşma yok ${o4.bad.join(',')}`);
    await page.click('#bMenuE');
    await page.waitForFunction(() => window.vapur.state === 'title');
    ok(`[${name}] sonuçtan menüye dönüş çalışıyor`);
    check(errs.length === 0, `[${name}] konsol/ağ hatası yok ${errs.slice(0, 3).join(' | ')}`);
    await ctx.close();
  }

  // eski kayıtla açılış
  {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    await ctx.route(IGNORED, (r) => r.fulfill({ status: 200, body: '' }));
    await ctx.addInitScript(() => {
      if (sessionStorage.getItem('seeded')) return; sessionStorage.setItem('seeded', '1');
      localStorage.setItem('arena.vapur.save', JSON.stringify({ best: { stars: [3, 2, 1, 0, 0, 0, 0, 0], score: [900, 700, 400, 0, 0, 0, 0, 0], total: 2000, endless: 2, endlessPax: 30 }, run: { shift: 3, total: 2000, pax: 40, stars: [3, 2, 1] } }));
      localStorage.setItem('arena.vapur.settings', JSON.stringify({ lang: 'en', quality: 'low' }));
    });
    const page = await ctx.newPage(); const errs = []; attach(page, errs);
    await page.goto(base + '?low', { waitUntil: 'load' }); await ready(page);
    const best = await page.evaluate(() => document.getElementById('bestLine').textContent);
    check(/2000|2,000|6\/24/.test(best), `[eski kayıt] en iyi satırı eski kayıttan okundu: ${best}`);
    await page.evaluate(() => document.getElementById('bCont').click());
    await page.waitForFunction(() => window.vapur.state === 'intro');
    check((await page.evaluate(() => document.getElementById('inTitle').textContent)).length > 0, '[eski kayıt] "Devam" vardiya ekranına götürüyor');
    check(errs.length === 0, '[eski kayıt] konsol hatası yok ' + errs.slice(0, 2).join(' | '));
    await ctx.close();
  }

  // 3 yıldızlı seferde konfeti, 1 yıldızlıda yok; defter kaydı (hedef puan düşürülerek yıldız zorlanır)
  {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    await ctx.route(IGNORED, (r) => r.fulfill({ status: 200, body: '' }));
    const page = await ctx.newPage(); const errs = []; attach(page, errs);
    await page.goto(base + '?low', { waitUntil: 'load' }); await ready(page);
    const finish = async (target) => {
      await page.evaluate(() => window.vapur.start(1));
      await page.waitForFunction(() => window.vapur.state === 'play');
      await page.evaluate((t) => { window.vapur.SIM.target = t; window.vapur.end('clear'); }, target);
      await page.waitForFunction(() => window.vapur.state === 'end');
      return page.evaluate(() => ({ n: document.querySelectorAll('#confetti i').length, stars: document.querySelectorAll('#enStars svg.on').length, log: JSON.parse(localStorage.getItem('arena.vapur.log') || '[]').length }));
    };
    const three = await finish(-1);
    if (await page.$('#bNews')) {
      check(three.stars === 3 && three.n > 0, `[konfeti] 3 yıldızlı sonuçta konfeti var (${three.stars} yıldız, ${three.n} parça)`);
      check(three.log === 1, `[defter] 3 yıldızlı sefer deftere yazıldı (${three.log} kayıt)`);
    } else na('[konfeti] bu sürümde yok');
    await page.click('#bMenuE'); await page.waitForFunction(() => window.vapur.state === 'title');
    const none = await finish(1e9);
    if (await page.$('#bNews')) check(none.stars === 0 && none.n === 0 && none.log === 1, `[konfeti] 0 yıldızlı sonuçta konfeti yok, deftere yazılmadı (${none.stars} yıldız, ${none.n} parça, ${none.log} kayıt)`);
    check(errs.length === 0, '[konfeti] konsol hatası yok ' + errs.slice(0, 2).join(' | '));
    await ctx.close();
  }

  // sayfa meta + 404
  {
    const html = readFileSync(join(root, 'index.html'), 'utf8');
    const m = (re) => (html.match(re) || [])[1] || '';
    const desc = m(/<meta name="description" content="([^"]*)"/);
    check(/[çğıöşüÇĞİÖŞÜ]/.test(desc) && /\b(ve|bir|ile)\b/.test(desc), `description Türkçe: ${desc.slice(0, 60)}...`);
    check(/<meta name="twitter:image"/.test(html) && /<meta name="twitter:title"/.test(html), 'Twitter kartı: başlık + görsel');
    check(/<meta property="og:image"/.test(html), 'Open Graph görseli var');
    check(existsSync(join(root, '404.html')), '404.html var');
  }
} catch (e) {
  fail('beklenmeyen hata: ' + (e && e.stack || e));
} finally {
  await browser.close();
  srv.close();
}
console.log(failed ? 'RESULT: FAIL' : 'RESULT: OK');
process.exit(failed ? 1 : 0);
