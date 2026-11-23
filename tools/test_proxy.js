/* 本地代理端到端回归：Node 起假站 + Python 代理 + 真实 Chromium 走完整链路
   用法：NODE_PATH=<playwright 所在目录> node tools/test_proxy.js
   不依赖外部网络，全部本地回环。 */
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const PY = process.env.MJ_PY || 'C:/Users/15810/.workbuddy/binaries/python/versions/3.13.12/python.exe';
const CHROME = process.env.MJ_CHROME || 'C:/Users/15810/AppData/Local/ms-playwright/chromium-1252/chrome-win64/chrome.exe';
function loadChromium() {
  for (const c of ['playwright',
    'C:/Users/15810/.workbuddy/binaries/node/versions/22.22.2-6/node_modules/@playwright/cli/node_modules/playwright']) {
    try { return require(c).chromium; } catch (_) {}
  }
  throw new Error('找不到 playwright，请设置 NODE_PATH');
}
const chromium = loadChromium();

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) pass++;
  else { fail++; console.log('  ✗ ' + name + (extra ? ' :: ' + extra : '')); }
};

/* 假站：书单 -> 书页 -> 两章。故意包含中文验证编码。 */
const SITE = {
  '/list.html': '<html><head><meta charset=utf-8></head><body>'
    + '<div class="book-item"><h3><a href="book1.html">公版测试书</a></h3></div></body></html>',
  '/book1.html': '<html><head><meta charset=utf-8></head><body>'
    + '<div class="chapter-list"><a href="ch1.html">第一章</a><a href="ch2.html">第二章</a></div></body></html>',
  '/ch1.html': '<html><head><meta charset=utf-8></head><body><div id="content">关关雎鸠，在河之洲。</div></body></html>',
  '/ch2.html': '<html><head><meta charset=utf-8></head><body><div id="content">参差荇菜，左右流之。</div></body></html>'
};
const listen = (srv, port) => new Promise((r) => srv.listen(port, '127.0.0.1', r));
const waitPort = async (port, tries = 40) => {
  for (let i = 0; i < tries; i++) {
    try { await new Promise((res, rej) => {
      const s = http.get({ host: '127.0.0.1', port, path: '/', timeout: 800 }, (r) => { r.resume(); res(); });
      s.on('error', rej); s.on('timeout', () => { s.destroy(); rej(new Error('timeout')); });
    }); return true; } catch (_) { await new Promise((r) => setTimeout(r, 250)); }
  }
  return false;
};

(async () => {
  const PROXY_PORT = 18899, SITE_PORT = 18901;
  const site = http.createServer((req, res) => {
    const body = SITE[req.url];
    if (body == null) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body);
  });
  const proxy = spawn(PY, [path.join(__dirname, 'local_server.py'), String(PROXY_PORT)],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let proxyLog = '';
  proxy.stderr.on('data', (d) => { proxyLog += d.toString(); });
  proxy.stdout.on('data', (d) => { proxyLog += d.toString(); });
  let browser;
  try {
    await listen(site, SITE_PORT);
    if (!await waitPort(PROXY_PORT)) throw new Error('代理服务未启动：' + proxyLog.slice(-300));
    browser = await chromium.launch({ executablePath: CHROME });
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', (e) => errs.push(e.message));
    p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
    const base = 'http://127.0.0.1:' + PROXY_PORT + '/';
    const siteBase = 'http://127.0.0.1:' + SITE_PORT + '/';
    await p.goto(base + 'index.html#/me');
    await p.waitForTimeout(700);

    /* P1：不同 URL 经代理取回的内容必须各自不同（守住 SW ignoreSearch 那个坑） */
    const distinct = await p.evaluate(async (o) => {
      const K = window.MJ.sourceKit;
      K.setProxy(o.proxy);
      const sb = o.site;
      const out = [];
      for (const f of ['list.html', 'book1.html', 'ch1.html']) {
        const t = await K.fetchText(sb + f);
        out.push({ len: t.length, book: t.includes('book-item'),
          chap: t.includes('chapter-list'), text: t.includes('关关雎鸠') });
      }
      return out;
    }, { proxy: base.replace(/\/$/, ''), site: siteBase });
    ok('P1 代理取不同网页不串内容',
      distinct[0].book && !distinct[0].chap && distinct[1].chap && !distinct[1].text
      && distinct[2].text && !distinct[2].book, JSON.stringify(distinct));

    /* P2：配代理 + 可视化书源 -> 抓书 -> 取正文，完整链路 */
    await p.fill('#proxyUrlInput', base.replace(/\/$/, ''));
    await p.click('[data-action="proxy-save"]');
    await p.waitForTimeout(200);
    await p.click('[data-action="add-source"]');
    await p.waitForTimeout(150);
    await p.fill('#sfId', 'proxytest');
    await p.fill('#sfName', '代理测试源');
    await p.fill('#sfListUrl', siteBase + 'list.html');
    await p.fill('#sfBookList', '.book-item');
    await p.fill('#sfBookTitle', 'h3 a');
    await p.fill('#sfBookLink', 'a@href');
    await p.fill('#sfChapterList', '.chapter-list a');
    await p.fill('#sfContent', '#content');
    await p.click('[data-action="source-form-save"]');
    await p.waitForTimeout(1200);
    const chain = await p.evaluate(async () => {
      const s = window.MJ.sources.get('proxytest');
      const ms = await s.metas();
      const ch = ms[0] ? await s.getChapter(ms[0].id, 1) : null;
      return { titles: ms.map((x) => x.title), chapter: ch };
    });
    ok('P2 代理下书源能抓书并取到正文',
      chain.titles.length === 1 && chain.titles[0] === '公版测试书'
      && chain.chapter && chain.chapter[0].indexOf('关关雎鸠') >= 0, JSON.stringify(chain));

    /* P3：正常链路全程无脚本错误（放在故意制造错误的 P4 之前） */
    ok('P3 正常链路无页面脚本错误', errs.length === 0, errs.join(' | '));
    /* P4：错误目标要给出明确错误，不能静默 */
    const bad = await p.evaluate(async () => {
      try { await window.MJ.sourceKit.fetchText('http://127.0.0.1:1/nope'); return 'no-error'; }
      catch (e) { return e.message; }
    });
    ok('P4 代理失败有明确提示', bad !== 'no-error' && bad.length > 0, bad);
    await ctx.close();
  } catch (e) {
    fail++;
    console.log('  测试异常: ' + e.message + '\n' + (proxyLog || '').slice(-400));
  } finally {
    if (browser) await browser.close().catch(() => {});
    proxy.kill();
    site.close();
  }
  console.log('\n墨卷本地代理回归：' + pass + ' PASS / ' + fail + ' FAIL');
  if (fail) process.exit(1);
})();
