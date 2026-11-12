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
/* 假语音引擎：记下每一句，也能故意吞掉 onend（Chromium 长句丢回调的老毛病）；
   speaking 恒为 false，模拟「进程静止但页面还以为在播」的现场。
   window.__dropEnd 为真时吞掉 onend，置 0 恢复正常。 */
const TTS_MOCK = () => {
  const S = {
    paused: false, speaking: false, pending: false, __spoke: [], __resume: 0, __last: null,
    /* 不返回音色：utterance.voice 只认真 SpeechSynthesisVoice，塞假对象会抛 TypeError */
    getVoices() { return []; },
    addEventListener() {}, removeEventListener() {},
    resume() { S.paused = false; S.__resume += 1; },
    pause() { S.paused = true; },
    cancel() { S.speaking = false; S.pending = false; },
    speak(u) {
      S.__spoke.push(u.text); S.__last = u; S.speaking = false;
      if (!window.__dropEnd) setTimeout(() => { try { u.onend && u.onend(); } catch (e) { /* 忽略 */ } }, 30);
    }
  };
  window.__dropEnd = 1;
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, get: () => S });
  window.__tts = S;
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
    /* 存储占用行：配额告警的入口。没有封面图时不该出现「清理封面」——
       按钮只在存满/偏紧且真有图片可清时才给，空按一下没意义。 */
    const stRow = await p.evaluate(() => {
      const el = Array.from(document.querySelectorAll('.setting-row .st'))
        .find((x) => /本地存储/.test(x.textContent));
      return el ? el.textContent.replace(/\s+/g, ' ') : '';
    });
    ok('墨斋显示本地存储占用', /已用\s*[\d.]+\s*(MB|KB)/.test(stRow), stRow);
    ok('无封面图时不显示清理按钮', (await p.locator('[data-action="clean-covers"]').count()) === 0);

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

    /* 焦点与遮罩：抽屉开着时正文必须 inert（Tab 不能穿到背后的翻页按钮），
       关掉后焦点要回到当初点开抽屉的那个按钮，而不是掉到 body */
    await p.click('[data-action="reader-catalog"]');
    await p.waitForSelector('#catalogList li');
    ok('抽屉打开时正文被 inert', await p.evaluate(() => ['readerBody', 'readerTop', 'readerBottom']
      .every((id) => document.getElementById(id).hasAttribute('inert'))));
    ok('抽屉内的 Tab 不会穿到背后', await (async () => {
      for (let i = 0; i < 24; i++) {
        await p.keyboard.press('Tab');
        const inside = await p.evaluate(() => !!document.activeElement.closest
          && !!document.activeElement.closest('#catalogDrawer'));
        if (!inside) return false;
      }
      return true;
    })());
    await p.keyboard.press('Escape');
    await p.waitForTimeout(300);
    ok('关闭抽屉后焦点回到触发按钮', await p.evaluate(() => document.activeElement
      && document.activeElement.dataset.action === 'reader-catalog'));
    ok('关闭抽屉后正文解除 inert', await p.evaluate(() => !document.getElementById('readerBody').hasAttribute('inert')));

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
    /* 中文输入法组词期间的按键不能当命令：拼音串（guanju）不该拿去过滤，
       Enter 是「选字上屏」，更不该把人弹到别的章去。上一步跳章已收起抽屉，重开一次。 */
    await p.click('[data-action="reader-catalog"]');
    await p.waitForSelector('#catalogSearch');
    const ime = await p.evaluate(() => {
      const inp = document.querySelector('#catalogSearch');
      const all = document.querySelectorAll('#catalogList li').length;
      inp.value = 'guanju';
      inp.dispatchEvent(new InputEvent('input', { isComposing: true, bubbles: true }));
      return new Promise((r) => setTimeout(() => {
        const vis = Array.from(document.querySelectorAll('#catalogList li')).filter((x) => !x.hidden).length;
        const ch = document.querySelector('#readerRoot').dataset.currentCh;
        inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true }));
        setTimeout(() => r({ all, vis, ch, ch2: document.querySelector('#readerRoot').dataset.currentCh,
          open: !document.querySelector('#catalogDrawer').hidden }), 350);
      }, 300));
    });
    ok('组词中的拼音不触发过滤', ime.vis === ime.all, JSON.stringify(ime));
    ok('组词中按 Enter 不跳章', ime.ch === ime.ch2 && ime.open, JSON.stringify(ime));
    await p.close();
  }

  /* ---------- G2. 换章：标签页标题与读屏播报 ---------- */
  {
    const p = await newPage(browser, { progress: { shijing: { ch: 1, pct: 0, updated: 5 } } }, errs);
    await p.goto(FILE + '#/reader/shijing/1');
    await p.waitForSelector('#readerAnnounce', { timeout: 8000 });
    await p.waitForTimeout(600);
    ok('进卷时标题带书名章名', /诗经/.test(await p.title()) && /关雎/.test(await p.title()));
    ok('进卷时阅读器有 aria-label', /第 1 章/.test((await p.getAttribute('#reader', 'aria-label')) || ''));
    ok('进卷时播报区是空的', !(await p.textContent('#readerAnnounce')));
    const t0 = await p.title();
    await p.evaluate(() => { const n = document.querySelector('[data-action="reader-step"][data-val="1"]'); if (n) n.click(); });
    await p.waitForTimeout(1200);
    ok('换章后标题跟着变', (await p.title()) !== t0 && /葛覃/.test(await p.title()), await p.title());
    ok('换章后有读屏播报', /已到第 2 章/.test((await p.textContent('#readerAnnounce')) || ''));
    ok('aria-label 跟着换章', /第 2 章/.test((await p.getAttribute('#reader', 'aria-label')) || ''));
    await p.evaluate(() => { location.hash = '#/shelf'; });
    await p.waitForTimeout(500);
    ok('退出阅读器标题复原', /一卷在手/.test(await p.title()));
    await p.close();
  }

  /* ---------- H. 听卷页：整屏模态 / 进度条语义 / 键盘 ---------- */
  {
    const p = await newPage(browser, { progress: { shijing: { ch: 1, pct: 0, updated: 5 } } }, errs);
    await p.goto(FILE + '#/reader/shijing/1');
    await p.waitForSelector('#ttsBtn', { timeout: 8000 });
    await p.click('#ttsBtn');
    await p.waitForSelector('#listen', { timeout: 8000 });
    await p.waitForTimeout(600);
    const st = await p.evaluate(() => {
      const l = document.getElementById('listen'), rd = document.getElementById('reader');
      const t = document.getElementById('lpTrack');
      const b = document.getElementById('listenPlay');
      return {
        role: l.getAttribute('role'), modal: l.getAttribute('aria-modal'),
        readerInert: rd.hasAttribute('inert'),
        trackRole: t.getAttribute('role'), trackNow: t.getAttribute('aria-valuenow'),
        playLabel: b.getAttribute('aria-label'),
        focusIn: l.contains(document.activeElement)
      };
    });
    ok('听卷页是整屏对话框', st.role === 'dialog' && st.modal === 'true');
    ok('听卷页打开时阅读器被 inert', st.readerInert === true);
    ok('听卷进度条有 slider 语义与进度值', st.trackRole === 'slider' && /^\d+$/.test(st.trackNow || ''));
    ok('播放键有可读的名称', st.playLabel === '暂停' || st.playLabel === '播放');
    ok('焦点进入听卷页', st.focusIn === true);
    /* Tab 不该跑到背后的阅读器上 */
    let escaped = false;
    for (let i = 0; i < 12; i++) {
      await p.keyboard.press('Tab');
      if (!(await p.evaluate(() => !!document.activeElement.closest('#listen')))) { escaped = true; break; }
    }
    ok('听卷页内 Tab 不会穿到背后', !escaped);
    /* 空格 = 播放 / 暂停 */
    await p.evaluate(() => document.getElementById('listen').focus());
    const a1 = await p.getAttribute('#listenPlay', 'aria-label');
    await p.keyboard.press(' ');
    await p.waitForTimeout(350);
    const a2 = await p.getAttribute('#listenPlay', 'aria-label');
    ok('空格切换播放 / 暂停', a1 !== a2, a1 + ' -> ' + a2);
    /* Esc 只是收起，不停止朗读 */
    await p.keyboard.press('Escape');
    await p.waitForTimeout(500);
    ok('Esc 把听卷页收成迷你条而不是直接停',
      (await p.locator('#listen').isHidden()) && (await p.locator('#listenMini').isVisible())
      && !(await p.evaluate(() => document.getElementById('reader').hasAttribute('inert'))));
    await p.click('[data-action="listen-close"]');
    await p.waitForTimeout(300);
    await p.close();
  }

  /* ---------- H2. 听卷自愈：onend 丢失 / 来电打断 / 后台留成 paused ---------- */
  {
    const p = await browser.newPage({ viewport: { width: 430, height: 900 } });
    p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
    await p.addInitScript(seed, { progress: { shijing: { ch: 1, pct: 0, updated: 5 } } });
    await p.addInitScript(TTS_MOCK);
    await p.goto(FILE + '#/reader/shijing/1');
    await p.waitForSelector('#ttsBtn', { timeout: 8000 });
    await p.click('#ttsBtn');
    await p.waitForSelector('#listen', { timeout: 8000 });
    await p.waitForTimeout(500);
    ok('听卷起手只念一句', (await p.evaluate(() => window.__tts.__spoke.length)) === 1);
    /* ① onend 丢了：巡检应在合理时长后原地重讲同一句，而不是永远停在那儿
       （首句「关雎 · 国风·周南」按 4.5 字/秒 + 6 秒余量算出来约 8 秒，等 9 秒稳一点） */
    await p.waitForTimeout(9000);
    const stuck = await p.evaluate(() => window.__tts.__spoke.slice(0, 2));
    ok('onend 丢失时会重讲同一句，不卡死', stuck.length === 2 && stuck[1] === stuck[0],
      JSON.stringify(stuck));
    /* ② 来电打断：录音队列已空但页面还挂着播放，应自动接上并继续往前念 */
    await p.evaluate(() => {
      window.__dropEnd = 0;
      const u = window.__tts.__last;
      if (u && u.onerror) u.onerror({ error: 'interrupted' });
    });
    await p.waitForTimeout(1600);
    const after = await p.evaluate(() => window.__tts.__spoke);
    ok('来电打断后自动接上', after.length >= 3, 'spoke=' + after.length);
    ok('接上后能继续往后念，不是反复重来', after[after.length - 1] !== after[0],
      JSON.stringify(after.slice(-1)));
    /* ③ 锁屏回来 speechSynthesis 仍挂着 paused：点播放要能自己解开 */
    const rv = await p.evaluate(async () => {
      window.__tts.paused = true;
      const before = window.__tts.__resume;
      document.getElementById('listenPlay').click(); /* 暂停 */
      await new Promise((r) => setTimeout(r, 200));
      document.getElementById('listenPlay').click(); /* 播放 */
      await new Promise((r) => setTimeout(r, 400));
      return { before, after: window.__tts.__resume, paused: window.__tts.paused };
    });
    ok('后台留下的 paused 会被解开', rv.after > rv.before && rv.paused === false,
      JSON.stringify(rv));
    await p.close();
  }

  /* ---------- H3. 进 bfcache 再回来：听卷不该被销毁 ---------- */
  {
    const p = await browser.newPage({ viewport: { width: 430, height: 900 } });
    p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
    await p.addInitScript(seed, { progress: { shijing: { ch: 1, pct: 0, updated: 5 } } });
    await p.addInitScript(TTS_MOCK);
    await p.goto(FILE + '#/reader/shijing/1');
    await p.waitForSelector('#ttsBtn', { timeout: 8000 });
    await p.click('#ttsBtn');
    await p.waitForSelector('#listen', { timeout: 8000 });
    await p.waitForTimeout(400);
    ok('H3 前置：打开听卷就在播',
      (await p.getAttribute('#listenPlay', 'aria-label')) === '暂停');
    await p.evaluate(() => { window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })); });
    await p.waitForTimeout(300);
    const bf = await p.evaluate(() => ({
      kept: !!document.getElementById('listen'),
      label: (document.getElementById('listenPlay') || {}).getAttribute
        ? document.getElementById('listenPlay').getAttribute('aria-label') : '',
      spoke: window.__tts.__spoke.length
    }));
    ok('进 bfcache 不销毁听卷', bf.kept === true);
    ok('进 bfcache 时先暂停，别在后台干念', bf.label === '播放', bf.label);
    await p.evaluate(() => { window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); });
    await p.waitForTimeout(700);
    ok('回到页面自动接着念',
      (await p.evaluate(() => window.__tts.__spoke.length)) > bf.spoke);
    /* 换章：章名、正文、朗读文本三样都得跟着走（本地书这条路径是实的） */
    const ch1 = await p.textContent('#listenChapter');
    await p.click('[data-action="listen-next"]');
    await p.waitForTimeout(700);
    const ch2 = await p.textContent('#listenChapter');
    ok('听卷换章后章名跟着变', ch1 !== ch2 && /葛覃/.test(ch2 || ''), (ch1 || '') + ' -> ' + (ch2 || ''));
    const spoke = await p.evaluate(() => window.__tts.__spoke);
    ok('换章后念的是新章正文', /葛覃/.test(spoke[spoke.length - 1] || ''), spoke.slice(-1)[0]);
    await p.close();
  }

  /* ---------- H4. 发版后老页面提示更新（需要 http 环境才有 Service Worker） ---------- */
  {
    const http = require('http');
    const fsx = require('fs');
    const ROOT_ = path.resolve(__dirname, '..');
    const MIME = {
      '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json',
      '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.json': 'application/json'
    };
    let swVer = 0;
    const server = http.createServer((req, res) => {
      const u = decodeURIComponent(req.url.split('?')[0]);
      if (u === '/sw.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
        res.end(`/* sw v${swVer} */self.addEventListener('install',()=>self.skipWaiting());`
          + `self.addEventListener('activate',(e)=>e.waitUntil(self.clients.claim()));`);
        return;
      }
      const f = path.join(ROOT_, u === '/' ? 'index.html' : u.replace(/^\//, ''));
      if (!f.startsWith(ROOT_) || !fsx.existsSync(f) || fsx.statSync(f).isDirectory()) {
        res.writeHead(404); res.end(''); return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
      fsx.createReadStream(f).pipe(res);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const origin = 'http://127.0.0.1:' + server.address().port;
    const p = await newPage(browser, {}, errs);
    await p.goto(origin + '/index.html#/shelf');
    await p.evaluate(() => navigator.serviceWorker.ready);
    await p.waitForTimeout(600);
    ok('首次装好 SW 不弹「新版本」', (await p.locator('#updateBar').count()) === 0);
    /* 再进一次页面：这回进来时已经有 controller，算「老页面」 */
    await p.reload();
    await p.waitForTimeout(600);
    swVer = 1;
    await p.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); await r.update(); });
    await p.waitForTimeout(2500);
    ok('发版后老页面会提示有新版本', (await p.locator('#updateBar').count()) === 1);
    await p.click('#updateBar [data-update="later"]');
    await p.waitForTimeout(200);
    ok('点「稍后」提示条消失', (await p.locator('#updateBar').count()) === 0);
    /* 再来一版：点「立即更新」应该真的刷新页面 */
    swVer = 2;
    await p.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); await r.update(); });
    await p.waitForTimeout(2500);
    ok('第二版也会提示', (await p.locator('#updateBar').count()) === 1);
    await p.evaluate(() => { window.__beforeReload = 1; });
    await p.click('#updateBar [data-update="now"]');
    await p.waitForTimeout(1200);
    ok('点「立即更新」会刷新页面', (await p.evaluate(() => window.__beforeReload)) === undefined);
    await p.close();
    server.closeAllConnections && server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }

  /* ---------- I. 焦点还原：跨页返回 / 同页重渲染 ---------- */
  {
    const p = await newPage(browser, {}, errs);
    await p.goto(FILE + '#/store');
    await p.waitForSelector('[data-action="open-book"]', { timeout: 8000 });
    const card = p.locator('[data-action="open-book"]').first();
    const bid = await card.getAttribute('data-id');
    await card.focus();
    await p.keyboard.press('Enter');
    await p.waitForTimeout(500);
    ok('回车打开详情', (await p.evaluate(() => location.hash)).indexOf('#/book/') === 0);
    await p.goBack();
    await p.waitForTimeout(600);
    const back = await p.evaluate(() => ({
      act: document.activeElement.dataset.action || '',
      id: document.activeElement.dataset.id || ''
    }));
    ok('返回列表后焦点回到原来那张书卡', back.act === 'open-book' && back.id === bid, JSON.stringify(back));
    await p.close();
  }

  /* ---------- J. 滚动进度：节流窗口内关页也不丢 ---------- */
  {
    const p = await newPage(browser, { progress: { shijing: { ch: 1, pct: 0, updated: 5 } } }, errs);
    await p.goto(FILE + '#/reader/shijing/1');
    await p.waitForSelector('#readerBody', { timeout: 8000 });
    await p.evaluate(() => document.querySelector('[data-action="reader-settings"]').click());
    await p.waitForTimeout(300);
    await p.evaluate(() => {
      const el = document.querySelector('[data-action="set-pagemode"][data-val="scroll"]');
      if (el) el.click();
    });
    await p.waitForTimeout(600);
    const pct = await p.evaluate(async () => {
      const bd = document.getElementById('readerBody');
      if (!bd) return null;
      const max = bd.scrollHeight - bd.clientHeight;
      if (!(max > 0)) return null;              /* 这一章短到不用滚，跳过 */
      bd.scrollTop = max * 0.9;
      bd.dispatchEvent(new Event('scroll'));
      /* 260ms 节流还没到点就关页 —— 正是原来会丢进度的那个窗口 */
      await new Promise((r) => setTimeout(r, 60));
      window.dispatchEvent(new Event('pagehide'));
      const st = JSON.parse(localStorage.getItem('mojuan.state.v1') || '{}');
      return st.progress && st.progress.shijing ? st.progress.shijing.pct : null;
    });
    ok('节流窗口内关页，最后一次滚动位置仍落盘', pct === null || pct > 0.8, String(pct));
    await p.close();
  }

  /* ---------- L. 上下滚动模式：空格 / PageDown 滚正文，不是直接换章 ---------- */
  {
    const p = await newPage(browser, { settings: { pageMode: 'scroll', fs: 19, lh: 2 }, progress: { shijing: { ch: 1, pct: 0, updated: 5 } } }, errs);
    await p.goto(FILE + '#/reader/shijing/1');
    await p.waitForSelector('#readerBody', { timeout: 8000 });
    await p.waitForTimeout(400);
    const st0 = await p.evaluate(() => {
      const bd = document.getElementById('readerBody');
      return { top: bd.scrollTop, max: bd.scrollHeight - bd.clientHeight };
    });
    ok('这一章能滚动（前提成立）', st0.max > 0, JSON.stringify(st0));
    await p.evaluate(() => document.getElementById('reader').focus());
    await p.keyboard.press('Space');
    await p.waitForTimeout(700);
    const st1 = await p.evaluate(() => ({
      top: document.getElementById('readerBody').scrollTop,
      ch: location.hash.split('/').pop()
    }));
    ok('空格滚正文而不是换章', st1.top > 0 && st1.ch === '1', JSON.stringify(st1));
    await p.evaluate(() => {
      const bd = document.getElementById('readerBody');
      bd.style.scrollBehavior = 'auto';
      bd.scrollTop = 0;
    });
    await p.waitForTimeout(200);
    await p.keyboard.press('ArrowDown');
    await p.waitForTimeout(400);
    const st2 = await p.evaluate(() => document.getElementById('readerBody').scrollTop);
    ok('方向键也能滚', st2 > 0, String(st2));
    /* 滚到底再按空格：这时候才该换章 */
    await p.evaluate(() => {
      const bd = document.getElementById('readerBody');
      bd.style.scrollBehavior = 'auto';
      bd.scrollTop = bd.scrollHeight;
    });
    await p.waitForTimeout(200);
    await p.keyboard.press('Space');
    await p.waitForTimeout(900);
    const st3 = await p.evaluate(() => location.hash.split('/').pop());
    ok('到底再按空格才换到下一章', st3 === '2', st3);
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

  /* ---------- K. 断网进在线书详情：不许空转，要给话说 ---------- */
  {
    const p = await newPage(browser, {}, errs);
    /* 数一下真的发了多少网络请求：断网时最怕「失败→重渲染→再失败」的忙循环 */
    await p.addInitScript(() => {
      window.__fetchN = 0;
      const raw = window.fetch;
      window.fetch = function () { window.__fetchN += 1; return raw.apply(this, arguments); };
    });
    await p.goto(FILE + '#/store');
    await p.waitForSelector('[data-id^="ws:"]', { timeout: 10000 });
    await p.context().setOffline(true);
    await p.evaluate(() => { location.hash = '#/book/ws:honglou'; });
    await p.waitForTimeout(1200);
    const st = await p.evaluate(() => ({
      n: window.__fetchN,
      toc: (document.querySelector('#tocPanel') || {}).textContent || '',
      retry: !!document.querySelector('[data-action="retry-toc"]'),
      loading: /正在取回/.test((document.querySelector('#tocPanel') || {}).textContent || '')
    }));
    ok('断网时不给在线书发请求', st.n === 0, 'fetch=' + st.n);
    ok('断网时明说「没有网络」', /没有网络/.test(st.toc), st.toc.replace(/\s+/g, ' ').slice(0, 60));
    ok('断网时给「重试」按钮', st.retry);
    ok('断网时不再无限「正在取回」', !st.loading);
    await p.waitForTimeout(800);
    ok('停住之后没有偷偷重试', (await p.evaluate(() => window.__fetchN)) === 0);
    /* 恢复网络点重试：要真的重发一次，而不是点了没反应 */
    await p.context().setOffline(false);
    await p.click('[data-action="retry-toc"]');
    await p.waitForTimeout(1500);
    const after = await p.evaluate(() => ({
      n: window.__fetchN,
      toc: (document.querySelector('#tocPanel') || {}).textContent || ''
    }));
    ok('恢复网络后点重试会重新取', after.n > 0, 'fetch=' + after.n);
    /* 真实网络下这一刻要么已经在取、要么已经取回；不该还停在「没有网络」的旧状态 */
    ok('重试后离开离线提示', !/没有网络/.test(after.toc), after.toc.replace(/\s+/g, ' ').slice(0, 60));
    await p.context().setOffline(false);
    await p.close();
  }

  ok('全程无控制台错误', errs.length === 0, errs.join(' | '));
  await browser.close();
  console.log('\n墨卷端到端回归：' + pass + ' PASS / ' + fail + ' FAIL');
  if (fail) process.exit(1);
})().catch((e) => { console.error('测试异常：', e.message); process.exit(1); });
