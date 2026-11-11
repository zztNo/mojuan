/* 墨卷端到端回归：真实 Chromium 无头跑一遍关键交互
   用法：NODE_PATH=<playwright 所在目录> node tools/test_e2e.js
   也可用 MJ_CHROME 指定浏览器可执行文件。 */
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const FILE = 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/');
const OFFLINE = 'file:///' + path.join(ROOT, 'mojuan-offline.html').replace(/\\/g, '/');
const CHROME = process.env.MJ_CHROME || 'C:/Users/15810/AppData/Local/ms-playwright/chromium-1252/chrome-win64/chrome.exe';
function loadChromium() {
  const candidates = ['playwright',
    'C:/Users/15810/.workbuddy/binaries/node/versions/22.22.2-6/node_modules/@playwright/cli/node_modules/playwright'];
  for (const c of candidates) { try { return require(c).chromium; } catch (_) {} }
  throw new Error('找不到 playwright，请设置 NODE_PATH');
}
const chromium = loadChromium();

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) pass++; else { fail++; console.log('  ✗ ' + name + (extra ? ' :: ' + extra : '')); }
};
const seed = (extra) => {
  if (sessionStorage.getItem('mj-seed')) return;
  sessionStorage.setItem('mj-seed', '1');
  localStorage.setItem('mojuan.state.v1', JSON.stringify(Object.assign({
    v: 5, shelf: ['shijing', 'daodejing'], settings: { pageMode: 'scroll' },
    progress: { shijing: { ch: 1, pct: 0, updated: 1 }, daodejing: { ch: 1, pct: 0, updated: 1 } }
  }, extra || {})));
};
const newPage = async (browser, extra, errs) => {
  const p = await browser.newPage({ viewport: { width: 430, height: 900 } });
  p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await p.addInitScript(seed, extra || {});
  return p;
};

(async () => {
  const errs = [];
  const browser = await chromium.launch({ executablePath: CHROME });

  /* ---------- A. 书架 / 笔记 / 划线（滚动模式） ---------- */
  {
    const p = await newPage(browser, {
      annotations: { shijing: [
        { ch: 1, pi: 0, text: '关关雎鸠', note: '', color: 'red', time: 1 },
        { ch: 1, pi: 1, text: '参差荇菜', note: '起兴', color: 'jade', time: 2 },
        { ch: 2, pi: 0, text: '窈窕淑女', note: '', color: 'gold', time: 3 }
      ] }
    }, errs);
    await p.goto(FILE + '#/shelf');
    await p.waitForSelector('.shelf-filters .chip', { timeout: 8000 });
    ok('藏卷分组 chip 带计数', (await p.textContent('.shelf-filters .chip')).includes('2'));
    await p.fill('#shelfSearch', '道德');
    await p.waitForTimeout(150);
    ok('藏卷搜索即时过滤', (await p.locator('[data-shelf-card]:not([hidden])').count()) <= 1);
    await p.fill('#shelfSearch', '');

    await p.goto(FILE + '#/me');
    await p.waitForSelector('[data-note-item]', { timeout: 8000 });
    ok('墨斋列出 3 条笔记', (await p.locator('[data-note-item]').count()) === 3);
    await p.click('.note-color-row [data-val="jade"]');
    await p.waitForTimeout(120);
    ok('按颜色筛选只剩 1 条', (await p.locator('[data-note-item]:not([hidden])').count()) === 1);
    await p.click('.note-color-row [data-val=""]');
    await p.click('[data-action="toggle-note-multi"]');
    ok('整理模式出现勾选圈', (await p.locator('.note-pick').count()) === 3);
    await p.click('[data-action="note-pick-all"]');
    ok('全选 3 条', (await p.locator('.note-pick.on').count()) === 3);
    await p.click('.note-multi-colors [data-val="gold"]');
    await p.waitForTimeout(200);
    const allGold = await p.evaluate(() => Object.values(JSON.parse(localStorage.getItem('mojuan.state.v1')).annotations)
      .flat().every((a) => a.color === 'gold'));
    ok('批量改色落盘', allGold);
    p.on('dialog', (d) => d.accept());
    await p.click('[data-action="note-bulk-del"]');
    await p.waitForTimeout(250);
    ok('批量删除并退出整理', (await p.locator('.note-multi-bar').count()) === 0
      && (await p.locator('[data-note-item]').count()) === 0);

  }

  /* ---------- A2. 划线就地编辑（独立页面，首载就用种子注入） ---------- */
  {
    const p = await newPage(browser, {
      annotations: { shijing: [{ ch: 1, pi: 0, text: '关关雎鸠', note: '', color: 'red', time: 9 }] }
    }, errs);
    await p.goto(FILE + '#/reader/shijing/1');
    await p.waitForSelector('#readerPaper p[data-pi]', { timeout: 8000 });
    await p.waitForSelector('#readerPaper mark.hl-mark', { timeout: 8000 });
    await p.close();
  }

  /* ---------- B. 目录 / 内文检索 / 卷签备注 ---------- */
  {
    const p = await newPage(browser, {
      progress: { shijing: { ch: 3, pct: 0.2, updated: 5 } },
      annotations: { shijing: [
        { ch: 1, pi: 0, text: '关关雎鸠', note: '', color: 'red', time: 1 },
        { ch: 1, pi: 1, text: '参差荇菜', note: '', color: 'jade', time: 2 }
      ] }
    }, errs);
    await p.goto(FILE + '#/reader/shijing/3');
    await p.waitForSelector('[data-action="reader-catalog"]', { timeout: 8000 });
    await p.click('[data-action="reader-catalog"]');
    await p.waitForSelector('#catalogList li');
    ok('前 2 章标为读过', (await p.locator('#catalogList li.read').count()) === 2);
    ok('第 1 章显示 2 条笔记', (await p.textContent('#catalogList li:first-child .ch-note')).includes('2'));
    await p.fill('#catalogSearch', '读');
    await p.waitForTimeout(220);
    ok('目录搜索只匹配章名', (await p.locator('#catalogList li:not([hidden])').count()) === 0);
    ok('无命中时给出空态', !(await p.locator('#catNoMatch').isHidden()));
    await p.fill('#catalogSearch', '');
    await p.waitForTimeout(220);
    ok('清空搜索后列表与空态一起复原',
      (await p.locator('#catalogList li:not([hidden])').count()) > 0 && (await p.locator('#catNoMatch').isHidden()));
    await p.keyboard.press('Escape');
    await p.waitForTimeout(260);
    ok('Esc 收起目录抽屉而不是退出阅读器', (await p.locator('#catalogDrawer').isHidden())
      && (await p.locator('#reader').count()) === 1);

    await p.click('[data-action="reader-search"]');
    await p.waitForSelector('#searchBox');
    await p.fill('#searchBox', '之');
    await p.waitForTimeout(500);
    /* 列表现在只铺前 200 条，但导航条按全部命中计数，总数要从提示里读 */
    const n = parseInt(((await p.textContent('.search-count')) || '').match(/找到 (\d+)/)?.[1] || '0', 10);
    const shown = await p.locator('.search-item').count();
    ok('内文检索有多处命中', n > 10, 'n=' + n);
    ok('列表限流但总数完整', shown <= 200 && n >= shown, 'shown=' + shown + ' total=' + n);
    await p.locator('.search-item').first().click();
    await p.waitForTimeout(700);
    ok('检索条浮出且计数从 1 开始', await p.locator('#searchNav').isVisible()
      && (await p.textContent('#searchNavCount')).trim() === '1 / ' + n);
    await p.click('[data-action="search-nav-next"]');
    await p.waitForTimeout(500);
    ok('下一处计数 +1', (await p.textContent('#searchNavCount')).trim() === '2 / ' + n);
    await p.click('[data-action="search-nav-close"]');
    await p.waitForTimeout(150);

    await p.click('[data-action="toggle-bookmark"]');
    await p.waitForTimeout(150);
    await p.click('[data-action="reader-catalog"]');
    await p.click('.cat-tabs [data-action="open-panel"][data-val="bookmark"]');
    await p.waitForSelector('[data-action="bm-note-edit"]');
    await p.click('[data-action="bm-note-edit"]');
    await p.fill('#bmNoteInput', '回归备注');
    await p.click('[data-action="bm-note-save"]');
    await p.waitForTimeout(250);
    ok('卷签备注写入并落盘', await p.evaluate(() =>
      (JSON.parse(localStorage.getItem('mojuan.state.v1')).bookmarks.shijing || [])[0].note === '回归备注'));
    await p.close();
  }

  /* ---------- C. 出现 / 退场动画 ---------- */
  {
    const p = await newPage(browser, {}, errs);
    await p.goto(FILE + '#/reader/shijing/1');
    await p.waitForSelector('#readerPaper p[data-pi]', { timeout: 8000 });
    await p.keyboard.press('s');
    await p.waitForSelector('.reader-settings');
    const a = await p.evaluate(() => ({
      row: getComputedStyle(document.querySelector('.reader-settings .rs-row')).animationName,
      mask: getComputedStyle(document.querySelector('#readerMask')).animationName
    }));
    ok('设置面板逐行落位', a.row === 'mjFade', JSON.stringify(a));
    ok('遮罩渐暗', a.mask === 'mjFade', JSON.stringify(a));
    await p.keyboard.press('Escape');
    await p.waitForTimeout(70);
    ok('关闭时挂退场动画', await p.locator('#readerPanel.mj-out').count() === 1);
    await p.waitForTimeout(260);
    ok('退场后面板隐藏清空', await p.locator('#readerPanel').isHidden()
      && (await p.evaluate(() => document.querySelector('#readerPanel').innerHTML.length)) === 0);
    await p.close();
  }

  /* ---------- D. 滑动翻页：点击 / 跟手 / 摆动 ---------- */
  {
    const p = await newPage(browser, {
      settings: { pageMode: 'flip', flipAnim: 'slide', fs: 26, lh: 2.8 }
    }, errs);
    await p.goto(FILE + '#/reader/shijing/1');
    await p.waitForSelector('#flipPage [data-fi]', { timeout: 8000 });
    const r = await p.locator('#readerBody').boundingBox();
    const cy = r.y + r.height * 0.4;
    const foot = () => p.evaluate(() => parseInt(document.querySelector('#flipFoot b').textContent, 10));
    const f0 = await foot();
    await p.mouse.click(r.x + r.width * 0.86, cy);
    await p.waitForTimeout(360);
    ok('点击翻页 +1', (await foot()) === f0 + 1);
    /* 已经翻到最后一页时往后拖没有相邻页，改成往右拖（往前翻）才测得到跟手 */
    const x0 = r.x + r.width * 0.4;
    await p.mouse.move(x0, cy);
    await p.mouse.down();
    for (let i = 1; i <= 8; i++) { await p.mouse.move(x0 + (60 * i) / 8, cy); await p.waitForTimeout(30); }
    await p.waitForTimeout(60);
    const tf = await p.evaluate(() => document.querySelector('#flipPage').style.transform);
    ok('拖动时页面跟手位移', /translate3d\(-?\d/.test(tf), tf);
    await p.mouse.up();
    await p.waitForTimeout(320);
    const f2 = await foot();
    ok('滑动模式松手后正常落位', f2 >= f0 + 1, 'f2=' + f2);
    await p.close();
  }

  /* ---------- E. 仿真翻页：3D 图层 / 前后翻 / 拖动 ---------- */
  {
    const p = await newPage(browser, {
      settings: { pageMode: 'flip', flipAnim: 'realistic', fs: 26, lh: 2.8 }
    }, errs);
    await p.goto(FILE + '#/reader/shijing/1');
    await p.waitForSelector('#flipPage [data-fi]', { timeout: 8000 });
    const r = await p.locator('#readerBody').boundingBox();
    const cy = r.y + r.height * 0.4;
    const foot = () => p.evaluate(() => parseInt(document.querySelector('#flipFoot b').textContent, 10));
    const st = () => p.evaluate(() => ({
      realistic: document.querySelector('#readerPaper').classList.contains('realistic'),
      adj: document.querySelector('#flipAdj').hidden,
      shade: document.querySelector('#flipShade').hidden,
      back: document.querySelector('#flipBack').hidden,
      tf: document.querySelector('#flipPage').style.transform
    }));
    const f0 = await foot();
    await p.mouse.click(r.x + r.width * 0.86, cy);
    await p.waitForTimeout(110);
    const mid = await st();
    ok('仿真翻页启用 3D 图层', mid.realistic && !mid.adj && !mid.shade && mid.back, JSON.stringify(mid));
    await p.waitForTimeout(420);
    ok('往后翻 +1 且图层收净', (await foot()) === f0 + 1 && !(await st()).realistic);
    await p.mouse.click(r.x + r.width * 0.14, cy);
    await p.waitForTimeout(430);
    ok('往前翻回到原页', (await foot()) === f0 && !(await st()).realistic);
    const x0 = r.x + r.width * 0.7;
    await p.mouse.move(x0, cy);
    await p.mouse.down();
    for (let i = 1; i <= 6; i++) { await p.mouse.move(x0 - i * 30, cy); await p.waitForTimeout(28); }
    const drag = await st();
    ok('拖动时纸绕书脊旋转', drag.realistic && /rotateY\(/.test(drag.tf), drag.tf);
    await p.mouse.up();
    await p.waitForTimeout(400);
    ok('仿真拖动落定后图层收净', !(await st()).realistic && (await st()).adj);
    await p.close();
  }

  /* ---------- G. 目录：回车直达命中 / 数字直达 ---------- */
  {
    const p = await newPage(browser, { progress: { shijing: { ch: 1, pct: 0, updated: 5 } } }, errs);
    await p.goto(FILE + '#/reader/shijing/1');
    await p.waitForSelector('[data-action="reader-catalog"]', { timeout: 8000 });
    await p.click('[data-action="reader-catalog"]');
    await p.waitForSelector('#catalogList li');
    /* 目录搜索框在阅读器里，焦点在输入框上时 Enter 不能被「输入框放行」那条吞掉 */
    await p.fill('#catalogSearch', '7');
    await p.focus('#catalogSearch');
    await p.keyboard.press('Enter');
    await p.waitForTimeout(700);
    ok('目录里回车直达第一条命中', (await p.evaluate(() => document.querySelector('#readerRoot').dataset.currentCh)) === '7');
    await p.close();
  }

  /* ---------- F. 单文件离线版 ---------- */
  {
    const p = await newPage(browser, {
      settings: { pageMode: 'flip', flipAnim: 'realistic', fs: 26, lh: 2.8 }
    }, errs);
    await p.goto(OFFLINE + '#/reader/shijing/1');
    await p.waitForSelector('#flipPage [data-fi]', { timeout: 10000 });
    ok('离线单文件版能启动', (await p.locator('#flipPage [data-fi]').count()) > 0);
    await p.click('[data-action="reader-search"]');
    await p.waitForSelector('#searchBox');
    await p.fill('#searchBox', '之');
    await p.waitForTimeout(600);
    ok('离线版内文检索可用', (await p.locator('.search-item').count()) > 10);
    await p.close();
  }

  ok('全程无控制台错误', errs.length === 0, errs.join(' | '));
  await browser.close();
  console.log('\n墨卷端到端回归：' + pass + ' PASS / ' + fail + ' FAIL');
  if (fail) process.exit(1);
})().catch((e) => { console.error('测试异常：', e.message); process.exit(1); });
