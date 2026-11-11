/* 数据安全 / 兼容 / 默认设置 专项回归
   用法：NODE_PATH=<playwright 所在目录> node tools/test_data.js */
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const FILE = 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/');
const CHROME = process.env.MJ_CHROME || 'C:/Users/15810/AppData/Local/ms-playwright/chromium-1252/chrome-win64/chrome.exe';
function loadChromium() {
  const candidates = ['playwright',
    'C:/Users/15810/.workbuddy/binaries/node/versions/22.22.2-6/node_modules/@playwright/cli/node_modules/playwright'];
  for (const c of candidates) { try { return require(c).chromium; } catch (_) {} }
  throw new Error('找不到 playwright，请设置 NODE_PATH');
}
const chromium = loadChromium();
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  ✗ ' + n + (x ? ' :: ' + x : '')); } };

/* 每个场景用独立 context，localStorage 完全隔离 */
async function scene(browser, seedObj, prep) {
  const ctx = await browser.newContext({ viewport: { width: 430, height: 900 } });
  const errs = [];
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  p.on('dialog', (d) => d.accept());
  if (seedObj !== null) {
    await p.addInitScript((raw) => {
      if (sessionStorage.getItem('mj-seed')) return;
      sessionStorage.setItem('mj-seed', '1');
      localStorage.clear();
      Object.keys(raw).forEach((k) => localStorage.setItem(k, raw[k]));
    }, seedObj);
  }
  if (prep) await prep(p);
  return { ctx, p, errs };
}
const stateKey = 'mojuan.state.v1';
const seeded = (st, extra) => {
  const raw = {};
  raw[stateKey] = JSON.stringify(Object.assign({
    v: 5, shelf: ['shijing'], settings: { pageMode: 'scroll', flipAnim: 'realistic' },
    progress: { shijing: { ch: 1, pct: 0, updated: 1 } }
  }, st || {}));
  return Object.assign(raw, extra || {});
};
const readState = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('mojuan.state.v1') || '{}'));

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME });

  /* ---------- 1. 仿真成为默认 + 迁移只跑一次 ---------- */
  {
    const { ctx, p, errs } = await scene(browser, {});
    await p.goto(FILE + '#/shelf');
    await p.waitForTimeout(500);
    const st = await readState(p);
    ok('全新用户默认就是仿真翻页', st.settings && st.settings.flipAnim === 'realistic', JSON.stringify(st.settings));
    ok('启动后版本号为 5', st.v === 5, 'v=' + st.v);
    ok('全新用户启动无报错', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }
  {
    const { ctx, p } = await scene(browser, seeded({ v: 4, settings: { pageMode: 'flip', flipAnim: 'slide' } }));
    await p.goto(FILE + '#/shelf');
    await p.waitForTimeout(450);
    const st = await readState(p);
    ok('存量 slide 用户一次性升到仿真', st.settings.flipAnim === 'realistic' && st.v === 5, JSON.stringify(st.settings));
    /* 走界面改设置：直接写 localStorage 再 reload 会被 pagehide 的 flushSave 覆盖 */
    await p.goto(FILE + '#/reader/shijing/1');
    await p.waitForSelector('[data-action="reader-settings"]', { timeout: 8000 });
    await p.click('[data-action="reader-settings"]');
    await p.click('[data-action="set-flipanim"][data-val="none"]');
    await p.waitForTimeout(250);
    await p.reload();
    await p.waitForTimeout(450);
    ok('用户自己选的「无动画」不会被迁移覆盖', (await readState(p)).settings.flipAnim === 'none',
      JSON.stringify((await readState(p)).settings));
    await ctx.close();
  }

  /* ---------- 2. 书城 / 藏卷页按 Esc 不再打断整个键盘处理器 ---------- */
  {
    const { ctx, p, errs } = await scene(browser, seeded());
    await p.goto(FILE + '#/store');
    await p.waitForTimeout(400);
    await p.keyboard.press('Escape');
    await p.waitForTimeout(100);
    ok('书城页按 Esc 不抛 TypeError', errs.length === 0, errs.join(' | '));
    await p.keyboard.press('?');
    await p.waitForTimeout(250);
    ok('Esc 之后 ? 快捷键仍能打开说明', (await p.locator('.sh-card').count()) === 1);
    await ctx.close();
  }

  /* ---------- 3. 老备份里的空章节本地卷不能崩 ---------- */
  {
    const broken = { id: 'broken', title: '残卷', author: '佚名', local: true, chapters: [] };
    const { ctx, p, errs } = await scene(browser, seeded({
      shelf: ['broken'], localBooks: [broken], progress: { broken: { ch: 1, pct: 0, updated: 1 } }
    }));
    await p.goto(FILE + '#/reader/broken/1');
    await p.waitForTimeout(700);
    /* 没有正文的损坏卷会被安全送回藏卷页并提示重新导入（这是既定行为），
       关键是不能抛 TypeError / 白屏；chapterList 的兜底保证万一正文还在也不崩。 */
    const toast = await p.textContent('#toast');
    ok('chapters: [] 的损坏卷安全回退不崩', errs.length === 0
      && (await p.evaluate(() => location.hash === '#/shelf'))
      && (toast || '').includes('重新导入'),
      errs.join(' | ') + ' toast=' + toast);
    await ctx.close();
  }

  /* ---------- 4. 导出备份带上了独立配置键 ---------- */
  let backupPath = '';
  {
    const extra = {
      'mojuan.sources.custom': '[{"id":"x","name":"我的源"}]',
      'mojuan.sources.off': '["wikisource"]',
      'mojuan.voice.v1': '{"azure":{"key":"secret"}}',
      'mojuan.toc.v1': '{"cache":1}'
    };
    const { ctx, p, errs } = await scene(browser, seeded(null, extra));
    await p.goto(FILE + '#/me');
    await p.waitForSelector('[data-action="export-backup"]', { timeout: 8000 });
    const [dl] = await Promise.all([
      p.waitForEvent('download', { timeout: 12000 }),
      p.click('[data-action="export-backup"]')
    ]);
    const f = await dl.path();
    backupPath = path.join(os.tmpdir(), 'mj-backup-test.json');
    fs.copyFileSync(f, backupPath);
    const obj = JSON.parse(fs.readFileSync(backupPath, 'utf8').replace(/^\uFEFF/, ''));
    ok('备份版本升到 2', obj.version === 2, 'v=' + obj.version);
    ok('备份含自定义书源', obj.extras && obj.extras['mojuan.sources.custom'] === extra['mojuan.sources.custom']);
    ok('备份含停用的源', obj.extras && obj.extras['mojuan.sources.off'] === extra['mojuan.sources.off']);
    ok('备份含在线音色 key', obj.extras && obj.extras['mojuan.voice.v1'] === extra['mojuan.voice.v1']);
    ok('可重建的目录缓存不进备份', !obj.extras || !('mojuan.toc.v1' in obj.extras));
    ok('导出过程无报错', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  /* ---------- 5. 恢复：规范化、extras 回写、拒绝更高版本 ---------- */
  {
    const { ctx, p, errs } = await scene(browser, seeded(null, { 'mojuan.sources.custom': '[{"id":"old"}]' }));
    await p.goto(FILE + '#/me');
    await p.waitForSelector('#backupFileInput', { state: 'attached', timeout: 8000 });
    const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8').replace(/^\uFEFF/, ''));
    backup.state = { v: 5, shelf: ['daodejing'], annotations: { shijing: [] } };
    const f = path.join(os.tmpdir(), 'mj-restore-test.json');
    fs.writeFileSync(f, JSON.stringify(backup), 'utf8');
    await p.setInputFiles('#backupFileInput', f);
    await p.waitForTimeout(1100);
    const st = await readState(p);
    ok('恢复后藏卷按备份覆盖', st.shelf && st.shelf[0] === 'daodejing', JSON.stringify(st.shelf));
    ok('缺字段的备份被规范化补齐', st.settings && st.settings.fs === 19 && !!st.bookTags, JSON.stringify(st.settings));
    ok('书源配置被回写', (await p.evaluate(() => localStorage.getItem('mojuan.sources.custom'))) === '[{"id":"x","name":"我的源"}]');
    const hi = path.join(os.tmpdir(), 'mj-backup-hi.json');
    backup.version = 99;
    fs.writeFileSync(hi, JSON.stringify(backup), 'utf8');
    await p.setInputFiles('#backupFileInput', hi);
    await p.waitForTimeout(400);
    ok('更高版本的备份被拒绝', (await readState(p)).shelf[0] === 'daodejing');
    ok('恢复流程无报错', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  /* ---------- 6. 重置数据清掉所有残留 ---------- */
  {
    const { ctx, p, errs } = await scene(browser, seeded(null, {
      'mojuan.sources.custom': '[{"id":"x"}]', 'mojuan.toc.v1': '{"cache":1}',
      'mojuan.voice.v1': '{"key":"s"}', 'mojuan.content.old': '{"paras":[]}'
    }));
    await p.goto(FILE + '#/me');
    await p.waitForSelector('[data-action="reset-data"]', { timeout: 8000 });
    await p.click('[data-action="reset-data"]');
    await p.waitForTimeout(500);
    const keys = await p.evaluate(() => Object.keys(localStorage).filter((k) => k.indexOf('mojuan.') === 0));
    ok('重置后只剩重建的 state', keys.length === 1 && keys[0] === 'mojuan.state.v1', JSON.stringify(keys));
    ok('重置后配置与缓存都清空', await p.evaluate(() =>
      !localStorage.getItem('mojuan.sources.custom') && !localStorage.getItem('mojuan.toc.v1')
      && !localStorage.getItem('mojuan.content.old')));
    ok('重置无报错', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  /* ---------- 7. 大量本地卷排序不再 O(n²) 且顺序正确 ---------- */
  {
    const n = 200;
    const books = Array.from({ length: n }, (_, i) => ({
      id: 'bk' + i, title: '卷' + String(n - i).padStart(3, '0'), author: '佚名', local: true, chapters: ['正文']
    }));
    const { ctx, p, errs } = await scene(browser, seeded({
      shelf: books.map((b) => b.id), localBooks: books
    }));
    await p.goto(FILE + '#/shelf');
    await p.waitForSelector('[data-shelf-card]', { timeout: 10000 });
    ok('200 卷全部渲染', (await p.locator('[data-shelf-card]').count()) === n);
    ok('大书架渲染无报错', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  /* ---------- 8. 听书切句：新正则与旧后顾断言等价 ---------- */
  {
    const { ctx, p } = await scene(browser, {});
    await p.goto(FILE + '#/shelf');
    const eq = await p.evaluate(() => {
      const oldF = (s) => s.split(/(?<=[，、：,:])/);
      const newF = (s) => s.match(/[^，、：,:]*[，、：,:]|[^，、：,:]+/g) || [];
      return ['关关雎鸠，在河之洲。', '一，二、三：四,五:六', '没有标点的一整句', '，开头', '结尾，']
        .every((s) => JSON.stringify(oldF(s)) === JSON.stringify(newF(s)));
    });
    ok('切句新写法与原语义一致', eq);
    const noLookbehind = !fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8').includes('split(/(?<=');
    ok('源码里已无后顾断言', noLookbehind);
    await ctx.close();
  }

  /* ---------- 9. 分页缓存：同参数不再反复建测量 DOM ---------- */
  {
    const { ctx, p, errs } = await scene(browser, seeded({
      settings: { pageMode: 'flip', flipAnim: 'realistic', fs: 24, lh: 2.8 }
    }));
    await p.goto(FILE + '#/reader/shijing/1');
    await p.waitForSelector('#flipPage [data-fi]', { timeout: 8000 });
    await p.waitForTimeout(350);
    await p.evaluate(() => {
      window.__mc = 0;
      new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => {
        if (n.nodeType === 1 && n.classList && n.classList.contains('flip-measure')) window.__mc++;
      }))).observe(document.body, { childList: true });
    });
    const f0 = (await p.textContent('#flipFoot')).trim();
    for (let i = 0; i < 3; i++) {
      await p.evaluate(() => window.dispatchEvent(new Event('resize')));
      await p.waitForTimeout(200);
    }
    const mc = await p.evaluate(() => window.__mc);
    ok('同参数重复分页命中缓存', mc === 0, 'measure DOM created=' + mc);
    ok('分页结果保持一致', (await p.textContent('#flipFoot')).trim() === f0);
    await p.keyboard.press('s');
    await p.waitForSelector('[data-action="set-font"][data-val="21"]', { timeout: 8000 });
    await p.click('[data-action="set-font"][data-val="21"]');
    await p.waitForTimeout(350);
    ok('改字号后缓存失效并重新测量', (await p.evaluate(() => window.__mc)) === 1);
    ok('分页优化无报错', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  /* ---------- 10. 面板 dialog 语义与 Tab 焦点循环 ---------- */
  {
    const { ctx, p, errs } = await scene(browser, seeded());
    await p.goto(FILE + '#/reader/shijing/1');
    await p.waitForSelector('#readerPaper p[data-pi]', { timeout: 8000 });
    await p.keyboard.press('s');
    await p.waitForSelector('.reader-settings');
    const a = await p.evaluate(() => {
      const el = document.querySelector('#readerPanel');
      return { role: el.getAttribute('role'), modal: el.getAttribute('aria-modal'),
        label: el.getAttribute('aria-label'), inside: el.contains(document.activeElement) };
    });
    ok('设置面板具备 dialog 语义', a.role === 'dialog' && a.modal === 'true' && !!a.label, JSON.stringify(a));
    ok('打开面板时焦点落在面板内', a.inside, JSON.stringify(a));
    let outside = 0;
    for (let i = 0; i < 24; i++) {
      await p.keyboard.press('Tab');
      if (!(await p.evaluate(() => document.querySelector('#readerPanel').contains(document.activeElement)))) outside++;
    }
    for (let i = 0; i < 6; i++) {
      await p.keyboard.press('Shift+Tab');
      if (!(await p.evaluate(() => document.querySelector('#readerPanel').contains(document.activeElement)))) outside++;
    }
    ok('Tab / Shift+Tab 焦点不会跑出面板', outside === 0, 'outside=' + outside);
    await p.keyboard.press('Escape');
    await p.waitForTimeout(260);
    await p.click('[data-action="reader-search"]');
    await p.waitForSelector('#searchBox');
    ok('检索抽屉也有 dialog 语义', await p.evaluate(() =>
      document.querySelector('#searchDrawer').getAttribute('role') === 'dialog'));
    ok('无障碍改动无报错', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  /* ---------- 11. 全书检索改为并发且可取消（静态检查） ---------- */
  {
    const src = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
    ok('全书检索不再逐章串行', src.includes('Math.min(3, total)') && src.includes('Promise.all'));
    ok('全书检索有取消入口与进度', src.includes('search-all-cancel') && src.includes("'已载入 ' + done"));
  }

  /* ---------- 12. 听书续听只认独立位置，不被阅读进度比例带偏 ---------- */
  {
    const src = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
    ok('续听不再拿 progress.pct 估算字符位置', !src.includes('pr.pct * listen.text.length'));
    ok('听书位置独立落盘', src.includes('state.listenPos[listen.bookId]'));

    const openListen = async (withPos, pct) => {
      /* listenPos 是 state 里的字段，不是独立的 localStorage 键 */
      const st = {
        settings: { pageMode: 'scroll', flipAnim: 'realistic' },
        progress: { shijing: { ch: 1, pct, updated: 1 } }
      };
      if (withPos) st.listenPos = { shijing: { ch: 1, sentIndex: 3, charIndex: 100, updated: 1 } };
      const { ctx, p, errs } = await scene(browser, seeded(st));
      await p.goto(FILE + '#/reader/shijing/1');
      await p.waitForSelector('#ttsBtn', { timeout: 8000 });
      await p.click('#ttsBtn');
      await p.waitForTimeout(750);
      const t = (await p.textContent('#toast')) || '';
      await ctx.close();
      return { resumed: t.includes('接着上次'), toast: t, errs };
    };
    const a = await openListen(true, 0.01);
    const b = await openListen(false, 0.9);
    ok('有听书位置记录时接着上次听', a.resumed, JSON.stringify(a));
    ok('阅读进度比例不会误触发续听', !b.resumed, JSON.stringify(b));
    ok('听书改动无脚本报错', a.errs.filter((x) => x.startsWith('PAGEERROR')).length === 0
      && b.errs.filter((x) => x.startsWith('PAGEERROR')).length === 0,
      a.errs.concat(b.errs).join(' | '));
  }

  /* ---------- 13. 批量测量：长章分页不炸、测量容器只建必要次数 ---------- */
  {
    const src = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
    ok('分页改为分块批量写读', src.includes('const BATCH = 64') && src.includes('heights.push('));
    const { ctx, p, errs } = await scene(browser, seeded({
      settings: { pageMode: 'flip', flipAnim: 'none', fs: 24, lh: 2.8 }
    }), async (pp) => {
      await pp.addInitScript(() => {
        window.__mc = 0;
        const ap = Node.prototype.appendChild;
        Node.prototype.appendChild = function (el) {
          if (el && el.classList && el.classList.contains('flip-measure')) window.__mc++;
          return ap.call(this, el);
        };
      });
    });
    await p.goto(FILE + '#/reader/shijing/1');
    await p.waitForSelector('#flipPage [data-fi]', { timeout: 8000 });
    await p.evaluate(() => {
      const srcObj = window.MJ.sources, orig = srcObj.getChapterSync;
      const long = Array.from({ length: 800 }, (_, i) =>
        '第' + (i + 1) + '段：关关雎鸠，在河之洲。窈窕淑女，君子好逑。参差荇菜，左右流之。');
      srcObj.getChapterSync = (id, no) => (id === 'shijing' && no === 1) ? long : orig(id, no);
    });
    await p.keyboard.press('s');
    await p.waitForSelector('[data-action="set-font"][data-val="21"]', { timeout: 8000 });
    await p.click('[data-action="set-font"][data-val="21"]');
    await p.waitForTimeout(650);
    const foot = (await p.textContent('#flipFoot')).trim();
    /* 页数随视口变化（430x900 是 266 页、400x760 是 401 页），只断言规模合理 */
    const totalN = parseInt((foot.match(/\/ (\d+)/) || [])[1] || '0', 10);
    ok('800 段长章正常分页', totalN > 100, foot);
    ok('长章分页只建 2 次测量容器', (await p.evaluate(() => window.__mc)) === 2);
    ok('长章分页无报错', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  /* ---------- 14. 在线取章失败：带上原因、可重试 ---------- */
  {
    const src = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
    ok('取章失败写入错误原因', src.includes('error: raw ? raw.slice(0, 60)') && src.includes('paras: null'));
    ok('正文提示会显示错误原因', src.includes("'（这一章暂未取到正文' + why"));
    const { ctx, p, errs } = await scene(browser, seeded());
    await p.goto(FILE + '#/store');
    await p.waitForTimeout(900);
    await p.evaluate(() => {
      const s = window.MJ.sources.get('wikisource');
      if (s) s.getChapter = () => Promise.reject(new Error('模拟网络超时 12000ms'));
    });
    await p.goto(FILE + '#/reader/ws:honglou/1');
    await p.waitForTimeout(1600);
    const txt = await p.textContent('.reader-error').catch(() => '');
    ok('失败时显示错误块与重试按钮', (txt || '').includes('重新取回'), (txt || '').slice(0, 120));
    ok('错误块带上具体原因', (txt || '').includes('模拟网络超时'), (txt || '').slice(0, 160));
    ok('在线失败流程无脚本报错', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  /* ---------- 15. 大列表：跳过视口外渲染，但 DOM / 搜索 / 整理都不变 ---------- */
  {
    const books = Array.from({ length: 300 }, (_, i) => ({
      id: 'bk' + i, title: '卷' + String(i).padStart(3, '0'), author: '佚名', local: true, chapters: ['正文']
    }));
    const { ctx, p, errs } = await scene(browser, seeded({
      shelf: books.map((b) => b.id), localBooks: books
    }));
    await p.goto(FILE + '#/shelf');
    await p.waitForSelector('.book-card', { timeout: 10000 });
    const cv = await p.evaluate(() => getComputedStyle(document.querySelector('.book-card')).contentVisibility);
    ok('书卡启用视口外渲染跳过', cv === 'auto', cv);
    ok('300 卷仍全在 DOM 中', (await p.locator('[data-shelf-card]').count()) === 300);
    await p.fill('#shelfSearch', '卷299');
    await p.waitForTimeout(160);
    ok('纯 DOM 搜索过滤不受影响', (await p.locator('[data-shelf-card]:not([hidden])').count()) === 1);
    await p.fill('#shelfSearch', '');
    await p.waitForTimeout(120);
    await p.click('[data-action="toggle-edit"]');
    await p.waitForTimeout(160);
    ok('批量整理选择框仍在', (await p.locator('.pick-box').count()) === 300);
    ok('大列表无报错', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  /* ---------- 16. 在线取章失败退避：冷却不打源，手动重试立即放行 ---------- */
  {
    const src = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
    ok('取章失败有退避阶梯', src.includes('CHAPTER_BACKOFF') && src.includes('retryAt'));
    const { ctx, p, errs } = await scene(browser, seeded());
    await p.goto(FILE + '#/store');
    await p.waitForTimeout(900);
    await p.evaluate(() => {
      window.__calls = 0;
      const s = window.MJ.sources.get('wikisource');
      if (s) s.getChapter = () => { window.__calls++; return Promise.reject(new Error('模拟断网')); };
    });
    await p.goto(FILE + '#/reader/ws:honglou/1');
    await p.waitForSelector('.reader-error', { timeout: 10000 });
    const c1 = await p.evaluate(() => window.__calls);
    /* 同一会话内离开再回来（contentCache 还在），冷却期内不该再发请求 */
    await p.evaluate(() => { location.hash = '#/store'; });
    await p.waitForTimeout(120);
    await p.evaluate(() => { location.hash = '#/reader/ws:honglou/1'; });
    await p.waitForTimeout(600);
    const c2 = await p.evaluate(() => window.__calls);
    ok('首次失败只请求一次', c1 === 1, 'c1=' + c1);
    ok('冷却期内不重复打书源', c2 === 1, 'c2=' + c2);
    const retry = await p.locator('[data-action="reader-retry"]').count();
    if (retry) {
      await p.click('[data-action="reader-retry"]');
      await p.waitForTimeout(600);
      const c3 = await p.evaluate(() => window.__calls);
      ok('点重新取回可立即重试', c3 === 2, 'c3=' + c3);
    } else ok('点重新取回可立即重试', false, '找不到重试按钮');
    ok('退避流程无脚本报错', errs.filter((x) => x.startsWith('PAGEERROR')).length === 0, errs.join(' | '));
    await ctx.close();
  }

  await browser.close();
  console.log('\n数据安全 / 兼容专项：' + pass + ' PASS / ' + fail + ' FAIL');
  if (fail) process.exit(1);
})().catch((e) => { console.error('测试异常：', e.message); process.exit(1); });
