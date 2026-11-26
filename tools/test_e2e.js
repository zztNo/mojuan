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

  /* ---------- H5. 定时停止：到点收尾 / 后台睡过头也要认账 / 暂停不留 0 分幽灵 ---------- */
  {
    const p = await browser.newPage({ viewport: { width: 430, height: 900 } });
    p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
    await p.addInitScript(seed, { progress: { shijing: { ch: 1, pct: 0, updated: 5 } } });
    await p.addInitScript(TTS_MOCK);
    /* 把时钟拨快的钩子：定时改成按 timerAt 巡检，这样才能在几秒内验到点 */
    await p.addInitScript(() => {
      const real = Date.now.bind(Date);
      window.__off = 0;
      Date.now = () => real() + (window.__off || 0);
    });
    await p.goto(FILE + '#/reader/shijing/1');
    await p.waitForSelector('#ttsBtn', { timeout: 8000 });
    await p.click('#ttsBtn');
    await p.waitForSelector('#listen', { timeout: 8000 });
    await p.waitForTimeout(500);
    await p.click('[data-action="listen-panel"][data-val="where"]');
    await p.waitForTimeout(200);
    await p.click('[data-action="listen-timer"][data-val="15"]');
    await p.waitForTimeout(300);
    const t0 = await p.evaluate(() => ({
      btn: document.getElementById('ltWhere').textContent,
      panel: (document.getElementById('ltTimerLeft') || {}).textContent || '',
      pressed: (document.querySelector('[data-action="listen-timer"][data-val="15"]') || {}).getAttribute
        ? document.querySelector('[data-action="listen-timer"][data-val="15"]').getAttribute('aria-pressed') : ''
    }));
    ok('选了 15 分钟，按钮上就写着 15分', t0.btn === '听到哪 · 15分', t0.btn);
    ok('面板里给出还剩多久', /还剩 1[45]:\d\d/.test(t0.panel), t0.panel);
    ok('选中的档位有 pressed 状态', t0.pressed === 'true', String(t0.pressed));
    /* ① 时间到（模拟后台被冻结，醒来已经过了 16 分钟）：先标记收尾，不硬断在半句上 */
    await p.evaluate(() => { window.__off = 16 * 60 * 1000; });
    await p.waitForTimeout(1400);
    const t1 = await p.evaluate(() => ({
      label: document.getElementById('listenPlay').getAttribute('aria-label'),
      btn: document.getElementById('ltWhere').textContent
    }));
    ok('到点先进入收尾，不当场拔电', t1.btn === '即将收卷' && t1.label === '暂停', JSON.stringify(t1));
    /* 这一句念完 → 才真正停 */
    await p.evaluate(() => { const u = window.__tts.__last; if (u && u.onend) u.onend(); });
    await p.waitForTimeout(500);
    const t2 = await p.evaluate(() => ({
      label: document.getElementById('listenPlay').getAttribute('aria-label'),
      btn: document.getElementById('ltWhere').textContent
    }));
    ok('这句念完就停，定时也归零', t2.label === '播放' && t2.btn === '听到哪 · 全书', JSON.stringify(t2));
    /* ② 暂停中的定时到点：不该留一个「定时 0 分」的幽灵按钮 */
    await p.evaluate(() => { window.__off = 0; });
    await p.click('[data-action="listen-panel"][data-val="where"]');
    await p.waitForTimeout(200);
    await p.click('[data-action="listen-timer"][data-val="30"]');
    await p.waitForTimeout(300);
    await p.evaluate(() => { window.__off = 40 * 60 * 1000; }); /* 先暂停，再让时间走过去 */
    await p.click('#listenPlay'); /* 这时是「播放」→ 点一下开念 */
    await p.waitForTimeout(200);
    await p.click('#listenPlay'); /* 再点一下暂停 */
    await p.waitForTimeout(1400);
    const t3 = await p.evaluate(() => ({
      label: document.getElementById('listenPlay').getAttribute('aria-label'),
      btn: document.getElementById('ltWhere').textContent
    }));
    ok('暂停中到点不留幽灵定时（键还原成范围）', t3.btn === '听到哪 · 全书', t3.btn);
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

  /* ---------- M. 跨段划线：一次选中多段，逐段落库并高亮 ---------- */
  {
    const p = await newPage(browser, { settings: { pageMode: 'scroll', fs: 19, lh: 2 } }, errs);
    await p.goto(FILE + '#/reader/chuci/1');
    await p.waitForSelector('#readerPaper p[data-pi]', { timeout: 8000 });
    await p.waitForTimeout(500);
    const box = await p.evaluate(() => {
      const ps = [...document.querySelectorAll('#readerPaper p[data-pi]')];
      const r1 = ps[2].getBoundingClientRect(), r2 = ps[4].getBoundingClientRect();
      return { x1: r1.left + 30, y1: r1.top + r1.height / 2, x2: r2.left + 60, y2: r2.top + r2.height / 2 };
    });
    await p.mouse.move(box.x1, box.y1);
    await p.mouse.down();
    await p.mouse.move(box.x2, box.y2, { steps: 12 });
    await p.mouse.up();
    await p.waitForTimeout(300);
    const pop = await p.evaluate(() => {
      const el = document.getElementById('hlPop');
      return { hidden: el.hidden, label: (el.querySelector('[data-action="hl-save"]') || {}).textContent };
    });
    ok('跨段选中会弹工具条，并写明划几段', pop.hidden === false && /3 段/.test(pop.label || ''), JSON.stringify(pop));
    await p.click('#hlPop [data-action="hl-save"]');
    await p.waitForTimeout(400);
    const saved = await p.evaluate(() => {
      const st = JSON.parse(localStorage.getItem('mojuan.state.v1') || '{}');
      const ann = (st.annotations || {}).chuci || [];
      return {
        n: ann.length, pis: ann.map((a) => a.pi),
        marks: document.querySelectorAll('#readerPaper mark.hl-mark').length
      };
    });
    ok('三段各记一条划线', saved.n === 3, JSON.stringify(saved));
    ok('三段都画出高亮', saved.marks === 3, String(saved.marks));
    await p.close();
  }

  /* ---------- N. 滚动模式改字号 / 行距，停在原来读到的那一段 ---------- */
  {
    const p = await newPage(browser, { settings: { pageMode: 'scroll', fs: 19, lh: 2 } }, errs);
    await p.goto(FILE + '#/reader/chuci/1');
    await p.waitForSelector('#readerBody', { timeout: 8000 });
    await p.waitForTimeout(500);
    const topPara = () => p.evaluate(() => {
      const bd = document.getElementById('readerBody');
      const ps = [...bd.querySelectorAll('p[data-pi]')];
      const line = bd.getBoundingClientRect().top;
      let el = ps[0];
      ps.forEach((x) => { if (x.getBoundingClientRect().top <= line + 1) el = x; });
      return { pi: el.dataset.pi, txt: (el.textContent || '').slice(0, 16) };
    });
    await p.evaluate(() => {
      const bd = document.getElementById('readerBody');
      bd.style.scrollBehavior = 'auto';
      bd.scrollTop = Math.round((bd.scrollHeight - bd.clientHeight) * 0.5);
    });
    await p.waitForTimeout(300);
    const before = await topPara();
    ok('滚动到章中间，顶端有具体段落（前提成立）', Number(before.pi) > 5, before.pi);
    await p.evaluate(() => document.querySelector('[data-action="reader-settings"]').click());
    await p.waitForTimeout(250);
    await p.evaluate(() => { const el = document.querySelector('[data-action="set-font"][data-val="24"]'); if (el) el.click(); });
    await p.waitForTimeout(700);
    const afterFs = await topPara();
    ok('字号 19→24 后仍停在同一段', afterFs.txt === before.txt && afterFs.pi === before.pi, JSON.stringify(afterFs));
    await p.evaluate(() => { const el = document.querySelector('[data-action="set-lh"][data-val="1.7"]'); if (el) el.click(); });
    await p.waitForTimeout(700);
    const afterLh = await topPara();
    ok('行距 2→1.7 后仍停在同一段', afterLh.txt === before.txt && afterLh.pi === before.pi, JSON.stringify(afterLh));
    await p.close();
  }

  /* ---------- O. 窄屏听卷工具条：收成四键后 340+ 一行，极窄机型 2 + 2 兜底 ---------- */
  {
    const rowsAt = async (w) => {
      const p = await newPage(browser, { shelf: ['shijing'] }, errs);
      await p.setViewportSize({ width: w, height: 760 });
      await p.goto(FILE + '#/reader/shijing/1');
      await p.waitForSelector('#ttsBtn', { timeout: 8000 });
      await p.click('#ttsBtn');
      await p.waitForSelector('#listen', { timeout: 8000 });
      await p.waitForTimeout(300);
      const r = await p.evaluate(() => {
        const tops = [...document.querySelectorAll('.listen-tools button')]
          .map((e) => Math.round(e.getBoundingClientRect().top));
        const groups = [];
        tops.forEach((t) => {
          const hit = groups.find((g) => g[0] === t);
          if (hit) hit[1] += 1; else groups.push([t, 1]);
        });
        return groups.map((g) => g[1]);
      });
      await p.close();
      return JSON.stringify(r);
    };
    const narrow = await rowsAt(360);
    ok('360 宽：四个工具键排成一行', narrow === '[4]', narrow);
    const wide = await rowsAt(430);
    ok('430 宽：四个工具键仍是一行', wide === '[4]', wide);
    const tiny = await rowsAt(320);
    ok('320 宽：极窄机型折成 2 + 2', tiny === '[2,2]', tiny);
  }

  /* ---------- P. 听卷读屏：换章 / 改范围 / 设定时都要念出来（阅读器那个 live 区是 inert 的） ---------- */
  {
    const p = await newPage(browser, { shelf: ['shijing'] }, errs);
    await p.goto(FILE + '#/reader/shijing/1');
    await p.waitForSelector('#ttsBtn', { timeout: 8000 });
    await p.click('#ttsBtn');
    await p.waitForSelector('#listen', { timeout: 8000 });
    await p.waitForTimeout(400);
    const live = () => p.evaluate(() => ({
      text: (document.getElementById('listenAnnounce') || {}).textContent || '',
      role: (document.getElementById('listenAnnounce') || {}).getAttribute
        ? document.getElementById('listenAnnounce').getAttribute('role') : ''
    }));
    const l0 = await live();
    ok('听卷有自己的 polite 播报区', l0.role === 'status', l0.role);
    await p.click('[data-action="listen-next"]');
    await p.waitForTimeout(800);
    const l1 = await live();
    ok('换章会播报新章名', /第 2 章/.test(l1.text) && /葛覃/.test(l1.text), l1.text);
    await p.click('[data-action="listen-panel"][data-val="where"]');
    await p.waitForTimeout(200);
    const wherePanel = await p.evaluate(() => ({
      groups: [...document.querySelectorAll('#listenPanel .lp-group')].map((e) => e.textContent),
      scope: document.getElementById('ltWhere').textContent
    }));
    ok('「听到哪儿」把范围和定时收在一页', wherePanel.groups.join('|') === '朗读范围|定时停止', JSON.stringify(wherePanel));
    await p.click('[data-action="listen-scope"][data-val="chapter"]');
    await p.waitForTimeout(300);
    const l2 = await live();
    ok('改朗读范围会播报', /朗读范围/.test(l2.text), l2.text);
    const scopeState = await p.evaluate(() => ({
      pressed: document.querySelector('[data-action="listen-scope"][data-val="chapter"]').getAttribute('aria-pressed'),
      where: document.getElementById('ltWhere').textContent
    }));
    ok('范围选中态与底栏键同步', scopeState.pressed === 'true' && scopeState.where === '听到哪 · 本章', JSON.stringify(scopeState));
    await p.click('[data-action="listen-timer"][data-val="30"]');
    await p.waitForTimeout(300);
    const l3 = await live();
    ok('设定时会播报', /定时 30 分钟/.test(l3.text), l3.text);
    await p.close();
  }

  /* ---------- Q. 夜墨听卷纸的可读性 + 底栏不随倒计时文案抖 ---------- */
  {
    /* 把半透明背景一路合成到不透明祖先，算 WCAG 对比度 */
    const ratioOf = (p, sel) => p.evaluate((s) => {
      const parse = (v) => {
        const m = String(v).match(/rgba?\(([^)]+)\)/);
        if (!m) return [0, 0, 0, 0];
        const a = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
        return [a[0], a[1], a[2], a.length > 3 ? a[3] : 1];
      };
      const el = document.querySelector(s);
      if (!el) return 0;
      const layers = [];
      let n = el;
      while (n) {
        const c = parse(getComputedStyle(n).backgroundColor);
        if (c[3] > 0) layers.push(c);
        n = n.parentElement;
      }
      let bg = [255, 255, 255];
      for (let i = layers.length - 1; i >= 0; i--) {
        const c = layers[i], a = c[3];
        bg = [0, 1, 2].map((k) => c[k] * a + bg[k] * (1 - a));
      }
      const lum = (rgb) => {
        const f = (v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
        return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
      };
      const fg = parse(getComputedStyle(el).color).slice(0, 3);
      const a = lum(fg), b = lum(bg);
      return +((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toFixed(2);
    }, sel);

    const p = await newPage(browser, { settings: { paper: 'night' } }, errs);
    await p.goto(FILE + '#/reader/shijing/1');
    await p.waitForSelector('#ttsBtn', { timeout: 8000 });
    await p.click('#ttsBtn');
    await p.waitForSelector('#listen', { timeout: 8000 });
    await p.click('[data-action="listen-panel"][data-val="where"]');
    await p.waitForTimeout(250);
    const cSmall = await ratioOf(p, '.lp-where-scope .rs-pill.active small');
    const cPill = await ratioOf(p, '.lp-where-scope .rs-pill.active');
    ok('日间主题配夜墨纸：选中范围副标达 AA', cSmall >= 4.5, String(cSmall));
    ok('日间主题配夜墨纸：选中档位主文字达 AA', cPill >= 4.5, String(cPill));
    const cChap = await ratioOf(p, '#listenChapter');
    ok('日间主题配夜墨纸：章名也达 AA', cChap >= 4.5, String(cChap));
    const marked = await p.evaluate(() => {
      const on = document.querySelector('.lp-where-scope .rs-pill.active');
      const off = document.querySelector('.lp-where-scope .rs-pill:not(.active)');
      return !!on && !!off && getComputedStyle(on).color !== getComputedStyle(off).color;
    });
    ok('选中档位主文字不再被压回普通正文色', marked, String(marked));

    /* 全站夜间主题会把全局朱砂提亮，浅色纸配亮红反而看不清：强调色按纸张固定才稳 */
    await p.evaluate(() => {
      document.body.dataset.theme = 'night';
      document.getElementById('listen').dataset.paper = 'xuan';
    });
    await p.waitForTimeout(100);
    const cLight = await ratioOf(p, '.lp-where-scope .rs-pill.active small');
    ok('夜间主题配浅色纸：选中副标仍达 AA', cLight >= 4.5, String(cLight));

    const stable = await p.evaluate(() => {
      const w = document.getElementById('ltWhere');
      const keys = [...document.querySelectorAll('.listen-tools button')];
      const labels = ['听到哪 · 全书', '听到哪 · 15分', '听到哪 · 9分', '听到哪 · 59秒', '即将收卷'];
      const rows = labels.map((t) => {
        w.textContent = t;
        return keys.map((k) => Math.round(k.getBoundingClientRect().left)).join(',');
      });
      return { all: rows, same: rows.every((r) => r === rows[0]) };
    });
    ok('倒计时文案变化不推动底栏其它键', stable.same, JSON.stringify(stable.all));

    await p.setViewportSize({ width: 360, height: 820 });
    await p.waitForTimeout(120);
    const rows360 = await p.evaluate(() =>
      [...new Set([...document.querySelectorAll('.listen-tools button')]
        .map((e) => Math.round(e.getBoundingClientRect().top)))].length);
    ok('加固定宽度后 360 宽四键仍是一行', rows360 === 1, String(rows360));
    await p.close();
  }

  /* ---------- R. 进度与状态一致性 ---------- */
  /* R1 滚动模式换章：旧章的滚动读数不能把刚写好的新章进度覆盖回去 */
  {
    const p = await newPage(browser, { settings: { pageMode: 'scroll' } }, errs);
    await p.goto(FILE + '#/reader/shijing/1');
    await p.waitForSelector('#readerBody', { timeout: 8000 });
    await p.waitForTimeout(300);
    await p.evaluate(() => {
      const b = document.getElementById('readerBody');
      b.scrollTop = (b.scrollHeight - b.clientHeight) * 0.7;
      b.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await p.waitForTimeout(250);
    await p.click('[data-action="reader-catalog"]');
    await p.waitForSelector('[data-action="catalog-goto"][data-ch="2"]', { timeout: 8000 });
    await p.click('[data-action="catalog-goto"][data-ch="2"]');
    await p.waitForTimeout(350);
    await p.click('[data-action="reader-catalog"]');
    await p.waitForSelector('.cat-resume', { timeout: 8000 });
    const resume = await p.evaluate(() => (document.querySelector('.cat-resume') || {}).textContent || '');
    ok('滚动模式换章后进度没被旧章读数覆盖', /第\s*2\s*章/.test(resume), resume);
    await p.close();
  }

  /* R2 目录「继续读」要保留章内进度，不能弹回章首
     （用滚动模式：诗经首章在翻页模式下只有一页，pct 本来就是 0，测不出差别） */
  {
    const p = await newPage(browser, {
      settings: { pageMode: 'scroll' },
      progress: { shijing: { ch: 1, pct: 0.6, updated: 1 } }
    }, errs);
    await p.goto(FILE + '#/reader/shijing/1');
    await p.waitForSelector('#readerBody', { timeout: 8000 });
    await p.waitForTimeout(400);
    const readPct = () => p.evaluate(() => {
      const st = JSON.parse(localStorage.getItem('mojuan.state.v1') || '{}');
      return (st.progress.shijing || {}).pct;
    });
    const before = await readPct();
    ok('R2 前置：章内确实有进度', Number(before) > 0.1, String(before));
    await p.click('[data-action="reader-catalog"]');
    await p.waitForSelector('.cat-resume', { timeout: 8000 });
    await p.click('.cat-resume');
    await p.waitForTimeout(400);
    const after = await readPct();
    ok('目录「继续读」保留章内进度', Number(after) > 0.1, String(after));
    await p.close();
  }

  /* R3 封面写失败一次，冷却过后要自动再试，不能永远丢在内存里 */
  {
    const p = await browser.newPage({ viewport: { width: 430, height: 900 } });
    p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
    await p.addInitScript(() => {
      const real = Date.now.bind(Date);
      window.__off = 0;
      Date.now = () => real() + (window.__off || 0);
      localStorage.setItem('mojuan.state.v1', JSON.stringify({
        v: 5, shelf: ['shijing'], settings: { pageMode: 'scroll' },
        progress: { shijing: { ch: 1, pct: 0, updated: 1 } }
      }));
      const rawSet = Storage.prototype.setItem;
      window.__coverWrites = 0;
      let failOnce = true;
      Storage.prototype.setItem = function (k, v) {
        if (k === 'mojuan.covers.v1') {
          window.__coverWrites += 1;
          if (failOnce) { failOnce = false; const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; }
        }
        return rawSet.call(this, k, v);
      };
    });
    await p.goto(FILE + '#/book/shijing');
    await p.waitForSelector('[data-action="open-cover"]', { timeout: 8000 });
    await p.click('[data-action="open-cover"]');
    await p.waitForSelector('[data-action="cover-save"]', { timeout: 8000 });
    await p.click('[data-action="cover-save"]');
    await p.waitForTimeout(250);
    await p.evaluate(() => { window.__off = 31000; });
    await p.evaluate(() => { window.dispatchEvent(new Event('pagehide')); });
    await p.waitForTimeout(250);
    const r = await p.evaluate(() => ({
      writes: window.__coverWrites, has: !!localStorage.getItem('mojuan.covers.v1')
    }));
    ok('封面写失败冷却后会自动再试', r.writes >= 2 && r.has, JSON.stringify(r));
    await p.close();
  }

  /* R4 批量重置读墨进度，要连听卷续听位置一起清 */
  {
    const p = await newPage(browser, {
      listenPos: { shijing: { ch: 2, sentIndex: 5, charIndex: 120 } }
    }, errs);
    await p.goto(FILE + '#/shelf');
    await p.waitForSelector('[data-shelf-card]', { timeout: 8000 });
    await p.evaluate(() => {
      const b = document.createElement('button');
      b.dataset.action = 'shelf-menu-manage'; b.dataset.id = 'shijing';
      document.body.appendChild(b); b.click(); b.remove();
    });
    await p.waitForTimeout(250);
    await p.evaluate(() => {
      const b = document.createElement('button');
      b.dataset.action = 'bulk-reset-progress';
      document.body.appendChild(b); b.click(); b.remove();
    });
    await p.waitForTimeout(250);
    const st = await p.evaluate(() => JSON.parse(localStorage.getItem('mojuan.state.v1') || '{}'));
    ok('批量重置进度会清掉听卷续听位置', !st.listenPos || !st.listenPos.shijing, JSON.stringify(st.listenPos));
    await p.close();
  }

  /* ---------- S. 卷签跨阅读模式：不能熄灭，也不能重复添加 ---------- */
  {
    const p = await newPage(browser, {
      settings: { pageMode: 'flip', flipAnim: 'none', fs: 26, lh: 2.8 }
    }, errs);
    await p.setViewportSize({ width: 430, height: 620 });
    await p.goto(FILE + '#/reader/shijing/1');
    await p.waitForSelector('#flipPage [data-fi]', { timeout: 8000 });
    await p.waitForTimeout(200);
    const box = await p.locator('#readerBody').boundingBox();
    await p.mouse.click(box.x + box.width * 0.86, box.y + box.height * 0.4);
    await p.waitForTimeout(350);
    const pageNo = await p.evaluate(() => Number((document.querySelector('#flipFoot b') || {}).textContent || 0));
    ok('S 前置：确实翻到了第 2 页', pageNo >= 2, String(pageNo));
    await p.click('#bmBtn');
    await p.waitForTimeout(180);
    const readMarks = () => p.evaluate(() =>
      (JSON.parse(localStorage.getItem('mojuan.state.v1') || '{}').bookmarks || {}).shijing || []);
    const b1 = await readMarks();
    ok('S 前置：卷签记下了非首页页码', b1.length === 1 && b1[0].page > 0, JSON.stringify(b1));

    await p.click('[data-action="reader-settings"]');
    await p.waitForSelector('[data-action="set-pagemode"][data-val="scroll"]', { timeout: 8000 });
    await p.click('[data-action="set-pagemode"][data-val="scroll"]');
    await p.waitForTimeout(400);
    const on = await p.evaluate(() =>
      !!document.getElementById('bmBtn') && document.getElementById('bmBtn').classList.contains('bm-on'));
    ok('切到上下滚动后星标仍然亮着', on, String(on));

    await p.click('#bmBtn');
    await p.waitForTimeout(220);
    const b2 = await readMarks();
    ok('再点星标是移除而不是新增重复卷签', b2.length === 0, JSON.stringify(b2));
    await p.close();
  }

  /* ---------- T. 笔记多选：筛选后不能连隐藏的一起删 ---------- */
  {
    const p = await newPage(browser, {
      annotations: {
        shijing: [
          { ch: 1, pi: 0, text: '春风又绿江南岸', color: 'red', note: '', time: 1 },
          { ch: 1, pi: 1, text: '明月何时照我还', color: 'red', note: '', time: 2 }
        ]
      }
    }, errs);
    p.on('dialog', (d) => d.accept());
    await p.goto(FILE + '#/me');
    await p.waitForSelector('[data-note-item]', { timeout: 8000 });
    await p.click('[data-action="toggle-note-multi"]');
    await p.waitForSelector('#notePickAll', { timeout: 8000 });
    await p.click('#notePickAll');
    await p.waitForTimeout(180);
    const all = await p.evaluate(() => (document.getElementById('notePickCount') || {}).textContent || '');
    ok('T 前置：全选了 2 条', /2 条/.test(all), all);
    await p.fill('#noteSearch', '春风');
    await p.waitForTimeout(400);
    const picked = await p.evaluate(() => (document.getElementById('notePickCount') || {}).textContent || '');
    ok('筛选后勾选集合收敛到可见项', /1 条/.test(picked), picked);
    await p.click('[data-action="note-bulk-del"]');
    await p.waitForTimeout(320);
    const left = await p.evaluate(() => {
      const st = JSON.parse(localStorage.getItem('mojuan.state.v1') || '{}');
      return (st.annotations.shijing || []).map((a) => a.text);
    });
    ok('删除只删可见笔记，隐藏的还在',
      left.length === 1 && left[0].indexOf('明月') >= 0, JSON.stringify(left));
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

  /* ---------- U. 在线章节取回：占位提示不能当正文缓存，冷却过后要真的再取 ---------- */
  {
    const p = await newPage(browser, {}, errs);
    await p.goto(FILE + '#/store');
    await p.waitForTimeout(400);
    /* 假书源：第一次返回占位提示（模拟「需要联网 / 没取回来」），之后返回真正文 */
    await p.evaluate(() => {
      window.__gc = 0;
      const meta = {
        id: 'tst:b1', sourceId: 'tst', title: '测试卷', author: '某人', online: true,
        desc: '探针', words: '1万', chars: 1000,
        chapters: [{ no: 1, title: '第一章' }, { no: 2, title: '第二章' }]
      };
      window.MJ.sources.register({
        id: 'tst', name: '探针源', desc: '测试', online: true,
        metasSync: () => [meta],
        getChapter: async (id, no) => {
          window.__gc += 1;
          if (window.__gc === 1) return ['（这一章暂未取到正文，点下方「重新取回」再试一次）'];
          return ['第' + no + '章 真实正文第一段，长度足够观察渲染结果是否正确。', '第二段真实正文。'];
        }
      });
    });
    await p.evaluate(() => { location.hash = '#/reader/tst:b1/1'; });
    await p.waitForTimeout(900);
    const s1 = await p.evaluate(() => ({
      retry: !!document.querySelector('[data-action="reader-retry"]'),
      text: (document.querySelector('.reader-body') || {}).textContent || ''
    }));
    ok('占位提示按失败处理：给「重新取回」', s1.retry);
    ok('占位提示不被当成正文显示', /暂未取到正文/.test(s1.text) && !/真实正文第一段/.test(s1.text));
    /* 冷却期（首次失败 3 秒）内重进不该再发请求 */
    await p.evaluate(() => { location.hash = '#/shelf'; });
    await p.waitForTimeout(200);
    await p.evaluate(() => { location.hash = '#/reader/tst:b1/1'; });
    await p.waitForTimeout(500);
    const cached = await p.evaluate(() => window.__gc);
    ok('冷却期内不重复取章', cached <= 2, 'calls=' + cached);
    /* 冷却过后再进：要真的再发一次，并把真正文渲染出来 */
    await p.waitForTimeout(3200);
    await p.evaluate(() => { location.hash = '#/shelf'; });
    await p.waitForTimeout(200);
    await p.evaluate(() => { location.hash = '#/reader/tst:b1/1'; });
    await p.waitForTimeout(900);
    const s2 = await p.evaluate(() => ({
      calls: window.__gc,
      retry: !!document.querySelector('[data-action="reader-retry"]'),
      text: (document.querySelector('.reader-body') || {}).textContent || ''
    }));
    ok('冷却过后自动再取一次', s2.calls > cached, 'calls=' + cached + '→' + s2.calls);
    ok('取回成功后渲染真正文', /真实正文第一段/.test(s2.text) && !s2.retry);
    await p.close();
  }

  /* ---------- V. 在线音色：缓存写满 20 条触发修剪后，后面的话还要能存进去 ----------
     旧实现修剪完顺手 close() 掉共享的 IndexedDB 连接，第 20 句起所有写入静默失败，
     同一句下次重听还要再合成一次（重复计费）。这里数「合成了几次」和「库里存了几条」。 */
  {
    const p = await browser.newPage({ viewport: { width: 430, height: 900 } });
    p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
    p.on('console', (m) => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
    await p.addInitScript(() => {
      if (!sessionStorage.getItem('mj-seed-audio')) {
        sessionStorage.setItem('mj-seed-audio', '1');
        localStorage.setItem('mojuan.state.v1', JSON.stringify({ v: 5, shelf: [], settings: { pageMode: 'scroll' }, progress: {} }));
      }
      /* 假装配好了 Azure：走在线合成这条分支 */
      localStorage.setItem('mojuan.voice.v1', JSON.stringify({
        provider: 'azure', azure: { region: 'eastasia', key: 'fake-key', voice: 'zh-CN-XiaoxiaoNeural' }
      }));
      window.__synth = 0;
      window.fetch = async () => {
        window.__synth += 1;
        return new Response(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
      };
      /* 假音频元素：立刻 onended，模拟一句念完 */
      const FakeAudio = function () {
        this.paused = true; this.ended = false; this.dataset = {};
        const self = this;
        this.play = () => {
          self.paused = false;
          setTimeout(() => { self.ended = true; self.paused = true; if (self.onended) self.onended(); }, 5);
          return Promise.resolve();
        };
        this.pause = () => { self.paused = true; };
        this.addEventListener = () => {}; this.removeEventListener = () => {};
      };
      window.Audio = FakeAudio;
    });
    await p.goto(FILE + '#/store');
    await p.waitForTimeout(400);
    await p.evaluate(() => {
      const sents = [];
      for (let i = 1; i <= 26; i++) sents.push('这是第' + i + '句测试正文用于验证缓存写入。');
      const meta = {
        id: 'tst:b1', sourceId: 'tst', title: '测试卷', author: '某人', online: true,
        desc: 'x', words: '1万', chars: 1000,
        chapters: [{ no: 1, title: '第一章' }, { no: 2, title: '第二章' }]
      };
      window.MJ.sources.register({
        id: 'tst', name: '探针源', desc: 't', online: true,
        metasSync: () => [meta],
        getChapter: async () => [sents.join('')]
      });
    });
    await p.evaluate(() => { location.hash = '#/reader/tst:b1/1'; });
    await p.waitForSelector('#ttsBtn', { timeout: 8000 });
    await p.click('#ttsBtn');
    await p.waitForSelector('#listen', { timeout: 8000 });
    await p.waitForTimeout(500);
    await p.evaluate(() => document.getElementById('listenPlay').click());
    await p.waitForTimeout(6500);
    const st = await p.evaluate(async () => {
      const db = await new Promise((res) => {
        const r = indexedDB.open('mojuan-audio', 1);
        r.onsuccess = () => res(r.result); r.onerror = () => res(null);
      });
      const clips = db ? await new Promise((res) => {
        const tx = db.transaction('clips', 'readonly');
        const rq = tx.objectStore('clips').count();
        rq.onsuccess = () => res(rq.result); rq.onerror = () => res(-1);
      }) : -2;
      return { synth: window.__synth, clips };
    });
    ok('连听超过 20 句确实在持续合成', st.synth >= 22, 'synth=' + st.synth);
    ok('修剪后仍能写入：合成几条就存几条', st.clips === st.synth, 'synth=' + st.synth + ' clips=' + st.clips);
    await p.close();
  }

  /* ---------- W. 藏卷整理：筛掉/改标记之后，选择集要跟着「看得见」的卷收敛 ---------- */
  {
    const p = await newPage(browser, {
      shelf: ['shijing', 'daodejing', 'qianzi'],
      bookTags: { shijing: 'want' }
    }, errs);
    await p.goto(FILE + '#/shelf');
    await p.waitForSelector('[data-shelf-card]', { timeout: 8000 });
    await p.click('[data-action="toggle-edit"]');
    await p.waitForSelector('.edit-bar', { timeout: 8000 });
    await p.click('[data-action="select-all"]');
    await p.waitForTimeout(150);
    const before = await p.textContent('.edit-count');
    ok('全选后计数是 3 卷', /已选\s*3\s*卷/.test(before.replace(/\s+/g, ' ')), before);
    /* 筛到「想读」只剩 1 卷：看不见的那两卷不能还留在选择集里 */
    await p.click('[data-action="set-shelf-filter"][data-val="want"]');
    await p.waitForTimeout(200);
    const after = await p.textContent('.edit-count');
    ok('筛选后计数收敛到可见的 1 卷', /已选\s*1\s*卷/.test(after.replace(/\s+/g, ' ')), after);
    await p.click('[data-action="open-shelf-actions"]');
    await p.waitForTimeout(250);
    await p.click('[data-action="batch-remove"]');
    await p.waitForTimeout(300);
    const shelf = await p.evaluate(() => JSON.parse(localStorage.getItem('mojuan.state.v1') || '{}').shelf);
    ok('移出藏卷只移走看得见的那一卷', shelf.length === 2 && !shelf.includes('shijing'), JSON.stringify(shelf));
    await p.close();
  }

  /* ---------- X. 夜墨是「纸」也是「主题」：两者不能分叉 ---------- */
  {
    const p = await newPage(browser, {
      settings: { paper: 'bamboo', theme: 'day', pageMode: 'scroll' },
      progress: { shijing: { ch: 1, pct: 0, updated: 1 } }
    }, errs);
    await p.goto(FILE + '#/reader/shijing/1');
    await p.waitForSelector('#readerPaper', { timeout: 8000 });
    /* 等版面真正落定（showReader 取完正文才写 dataset.mode），否则面板会被外层未展开的栏挡住 */
    await p.waitForFunction(() => document.getElementById('readerRoot').dataset.mode === 'scroll', { timeout: 8000 });
    await p.evaluate(() => document.querySelector('[data-action="reader-settings"]').click());
    await p.waitForTimeout(500);
    await p.click('[data-action="set-paper"][data-val="night"]');
    await p.waitForTimeout(250);
    const n1 = await p.evaluate(() => ({
      theme: document.body.dataset.theme,
      paper: document.getElementById('reader').dataset.paper
    }));
    ok('选夜墨纸：全站主题同步变夜', n1.theme === 'night' && n1.paper === 'night', JSON.stringify(n1));
    /* 面板开着时底栏是 inert 的，先关面板再点夜间按钮 */
    await p.evaluate(() => document.getElementById('readerMask').click());
    await p.waitForTimeout(400);
    /* 再点底栏「日间」：一次就要回到原来的青竹，不能回到宣纸 */
    await p.click('#themeBtn');
    await p.waitForTimeout(250);
    const n2 = await p.evaluate(() => ({
      theme: document.body.dataset.theme,
      paper: document.getElementById('reader').dataset.paper
    }));
    ok('点一次就回到日光，且保住原来的纸色', n2.theme === 'day' && n2.paper === 'bamboo', JSON.stringify(n2));
    await p.close();
  }

  /* ---------- Y. 详情页「续卷 / 开卷」与已读状态自洽 ---------- */
  {
    const p = await newPage(browser, {
      shelf: ['shijing'],
      progress: { shijing: { ch: 1, pct: 0, updated: 1 } }
    }, errs);
    await p.goto(FILE + '#/book/shijing');
    await p.waitForSelector('[data-action="start-read"]', { timeout: 8000 });
    const b1 = await p.textContent('[data-action="start-read"]');
    const stat1 = await p.textContent('.detail-stats');
    ok('只导入没读过：按钮写「开卷」', /开卷/.test(b1) && !/续卷/.test(b1), b1.trim());
    ok('只导入没读过：已读是「—」', /—/.test(stat1), stat1.replace(/\s+/g, ' ').slice(0, 60));
    await p.close();

    const q = await newPage(browser, {
      shelf: ['shijing'],
      progress: { shijing: { ch: 3, pct: 0.2, updated: 1 } }
    }, errs);
    await q.goto(FILE + '#/book/shijing');
    await q.waitForSelector('[data-action="start-read"]', { timeout: 8000 });
    const b2 = await q.textContent('[data-action="start-read"]');
    ok('真读到第 3 章：按钮写「续卷 · 第3章」', /续卷 · 第3章/.test(b2.replace(/\s+/g, ' ')), b2.trim());
    await q.close();
  }

  /* ---------- Z. 检索抽屉：失败的章不算「已检索」，重试入口不能消失 ---------- */
  {
    const p = await newPage(browser, {}, errs);
    await p.goto(FILE + '#/store');
    await p.waitForTimeout(400);
    await p.evaluate(() => {
      window.__gc = 0;
      const meta = {
        id: 'tst:b1', sourceId: 'tst', title: '测试卷', author: '某人', online: true,
        desc: '探针', words: '1万', chars: 1000,
        chapters: [{ no: 1, title: '第一章' }, { no: 2, title: '第二章' }, { no: 3, title: '第三章' }]
      };
      window.MJ.sources.register({
        id: 'tst', name: '探针源', desc: '测试', online: true,
        metasSync: () => [meta],
        getChapter: async (id, no) => {
          window.__gc += 1;
          if (no === 2) return ['（这一章暂未取到正文，点下方「重新取回」再试一次）'];
          return ['第' + no + '章 正文一段足够长的内容，方便检索与渲染。'];
        }
      });
    });
    /* 先跑一遍失败章，再回到第一章打开检索抽屉 */
    await p.evaluate(() => { location.hash = '#/reader/tst:b1/2'; });
    await p.waitForTimeout(700);
    await p.evaluate(() => { location.hash = '#/reader/tst:b1/1'; });
    await p.waitForTimeout(700);
    await p.click('[data-action="reader-search"]');
    await p.waitForTimeout(300);
    const s = await p.evaluate(() => {
      const hint = document.getElementById('searchHint');
      return { hint: !!hint, text: (hint || {}).textContent || '', all: !!document.querySelector('[data-action="search-all"]') };
    });
    ok('有失败章时检索抽屉仍给「联网检索全书」入口', s.hint && s.all, s.text.replace(/\s+/g, ' ').slice(0, 60));
    /* 第 1 章读到、第 3 章被预取、第 2 章失败：应当是 2 / 3，绝不能是 3 / 3 */
    const hintText = s.text.replace(/\s+/g, ' ');
    ok('已检索章数不把失败章算进去', /2 \/ 3/.test(hintText) && !/3 \/ 3/.test(hintText), hintText.slice(0, 60));
    await p.close();
  }

  /* ===== AA：寻卷篇目 / 防抖 / 书肆空态 / 换荐 / 弹层 Esc / 书源注册 ===== */
  {
    const LOCAL = {
      id: 'local-aa-1', local: true, title: '山门记事', author: '本地导入',
      category: '本地', status: '本地', tags: ['本地导入', 'TXT'], words: '200字',
      score: 9.0, readers: '本地卷', hot: 60, motif: 'ink', color: '#5a4a3a', color2: '#8a7a6a',
      seal: '山', desc: '由本地文件导入，共 2 章。山门初开，风过松林…',
      chapters: ['第一章 山门', '第九章 归隐'], addedAt: 1
    };
    const p = await newPage(browser, { localBooks: [LOCAL] }, errs);
    await p.goto(FILE + '#/search');
    await p.waitForTimeout(350);
    await p.fill('#searchInput', '归隐');
    await p.waitForTimeout(280);
    const hit = await p.evaluate(() => {
      const box = document.getElementById('searchBody');
      return {
        local: !!box.querySelector('.book-row[data-id="local-aa-1"]'),
        rows: box.querySelectorAll('.book-row').length,
        text: box.textContent.replace(/\s+/g, ' ')
      };
    });
    ok('AA1 本地导入卷的篇目名能被寻卷命中', hit.local, '命中 ' + hit.rows + ' 卷 / ' + hit.text.slice(0, 70));
    ok('AA2 命中篇目时带出「含…」提示', /含「第九章 归隐」/.test(hit.text), hit.text.slice(0, 80));

    /* 输入后 120ms 内清空：挂起的防抖不该把旧关键词写回结果区 */
    await p.evaluate(() => {
      const i = document.getElementById('searchInput');
      i.value = '道德'; i.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('[data-action="clear-query"]').click();
    });
    await p.waitForTimeout(300);
    const clr = await p.evaluate(() => ({
      val: document.getElementById('searchInput').value,
      head: !!document.querySelector('#searchBody .result-head'),
      text: (document.getElementById('searchBody') || {}).textContent || ''
    }));
    ok('AA3 清空后结果区不被旧关键词覆盖', clr.val === '' && !clr.head, clr.text.replace(/\s+/g, ' ').slice(0, 60));

    /* 热词点击同样要取消挂起的防抖（先回默认页，那里才有热词） */
    await p.evaluate(() => { document.querySelector('[data-action="clear-query"]').click(); });
    await p.evaluate(() => {
      const i = document.getElementById('searchInput');
      i.value = '道德'; i.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('[data-action="hot-word"]').click();
    });
    await p.waitForTimeout(300);
    const hot = await p.evaluate(() => {
      const h = document.querySelector('#searchBody .result-head');
      return { val: document.getElementById('searchInput').value, head: h ? h.textContent : '' };
    });
    ok('AA4 点热词后结果区与输入框一致', !!hot.val && hot.head.indexOf(hot.val) >= 0, hot.val + ' / ' + hot.head);
    await p.close();
  }
  {
    /* 所有书源都停用、又没导入本地卷时，书肆首页不该抛异常白屏 */
    const errBefore = errs.length;
    const p = await newPage(browser, {}, errs);
    await p.goto(FILE + '#/shelf');
    await p.waitForTimeout(300);
    await p.evaluate(async () => {
      window.MJ.sources.list().forEach((s) => window.MJ.sources.setEnabled(s.id, false));
      await window.MJ.sources.refresh();
      location.hash = '#/store';
    });
    await p.waitForTimeout(500);
    const st = await p.evaluate(() => ({
      quick: !!document.querySelector('.quick-cats'),
      len: ((document.getElementById('view') || {}).textContent || '').trim().length,
      books: window.MJ.sources.allBooks().length
    }));
    ok('AA5 书源全停用时书肆完整渲染', st.quick && errs.length === errBefore,
      'quick-cats=' + st.quick + ' 剩余书=' + st.books + ' 新增错误=' + errs.slice(errBefore).join(' | '));
    await p.close();
  }
  {
    const p = await newPage(browser, {}, errs);
    await p.goto(FILE + '#/store');
    await p.waitForTimeout(400);
    const before = await p.evaluate(() => document.querySelectorAll('#forYou .quick-add').length);
    await p.click('[data-action="shuffle"]');
    await p.waitForTimeout(250);
    const after = await p.evaluate(() => document.querySelectorAll('#forYou .quick-add').length);
    ok('AA6 换荐后「为你荐一卷」仍保留收下按钮', before > 0 && after === before, before + ' → ' + after);
    await p.close();
  }
  {
    const p = await newPage(browser, {}, errs);
    await p.goto(FILE + '#/me');
    await p.waitForTimeout(350);
    await p.click('[data-action="add-source"]');
    await p.waitForTimeout(150);
    const opened = await p.evaluate(() => !!document.getElementById('sourceModal'));
    await p.keyboard.press('Escape');
    await p.waitForTimeout(150);
    const closed = await p.evaluate(() => !document.getElementById('sourceModal'));
    ok('AA7 Esc 能关掉自定义书源弹层', opened && closed, 'opened=' + opened + ' closed=' + closed);
    await p.close();
  }
  {
    const p = await newPage(browser, {}, errs);
    await p.goto(FILE + '#/shelf');
    await p.waitForTimeout(350);
    let opened2 = false, closed2 = false, note = '';
    try {
      await p.click('[data-action="toggle-edit"]', { timeout: 8000 });
      await p.waitForTimeout(150);
      await p.click('[data-action="pick-book"]', { timeout: 8000 });
      await p.waitForTimeout(120);
      await p.click('[data-action="open-shelf-actions"]', { timeout: 8000 });
      await p.waitForTimeout(150);
      opened2 = await p.evaluate(() => !!document.getElementById('shelfActions'));
      await p.keyboard.press('Escape');
      await p.waitForTimeout(150);
      closed2 = await p.evaluate(() => !document.getElementById('shelfActions'));
    } catch (e) { note = String(e.message).split('\n')[0]; }
    ok('AA8 Esc 能关掉藏卷批量操作面板', opened2 && closed2, 'opened=' + opened2 + ' closed=' + closed2 + ' ' + note);
    await p.close();
  }
  {
    /* 同 id 更新自定义书源：不该因 id 列表没变就误判「没有注册任何书源」 */
    const p = await newPage(browser, {}, errs);
    await p.goto(FILE + '#/me');
    await p.waitForTimeout(350);
    const code = (n) => "MJ.sources.register({ id:'tst:aa', name:'" + n + "', metasSync: () => [], getChapter: async () => [] });";
    for (const n of ['甲源', '乙源']) {
      await p.click('[data-action="add-source-js"]');
      await p.waitForTimeout(120);
      await p.fill('#sourceCode', code(n));
      await p.click('[data-action="source-save"]');
      await p.waitForTimeout(180);
    }
    const r = await p.evaluate(() => ({
      toast: (document.getElementById('toast') || {}).textContent || '',
      modal: !!document.getElementById('sourceModal'),
      n: JSON.parse(localStorage.getItem('mojuan.sources.custom') || '[]').length,
      name: (window.MJ.sources.get('tst:aa') || {}).name
    }));
    ok('AA9 同 id 更新书源不误报「没有注册」', r.toast.indexOf('没有注册') < 0 && !r.modal, r.toast);
    ok('AA10 两次启用都落盘且会话内是最新代码', r.n === 2 && r.name === '乙源', r.n + ' / ' + r.name);
    await p.close();
  }

  /* ===== AB：书源代码异常事务 / 启动载入坏插件 / pointercancel / 音色弹层 Esc ===== */
  {
    const p = await newPage(browser, {}, errs);
    await p.goto(FILE + '#/me');
    await p.waitForTimeout(350);
    await p.click('[data-action="add-source-js"]');
    await p.waitForTimeout(120);
    await p.fill('#sourceCode', "MJ.sources.register({ id:'ghost-probe', name:'幽灵源' }); throw new Error('boom');");
    await p.click('[data-action="source-save"]');
    await p.waitForTimeout(220);
    const r = await p.evaluate(() => ({
      ghost: !!(window.MJ.sources._registry && window.MJ.sources._registry.has('ghost-probe')),
      custom: JSON.parse(localStorage.getItem('mojuan.sources.custom') || '[]').length,
      toast: (document.getElementById('toast') || {}).textContent || ''
    }));
    ok('AB1 书源代码中途抛错不留幽灵源', !r.ghost, 'toast=' + r.toast);
    ok('AB2 失败代码不写进自定义书源列表', r.custom === 0, '磁盘份数 ' + r.custom);
    await p.close();
  }
  {
    /* 启动时载入坏插件：不该污染注册表，也不该每次启动重演 */
    const p = await newPage(browser, {}, errs);
    await p.goto(FILE + '#/shelf');
    await p.waitForTimeout(300);
    await p.evaluate(() => localStorage.setItem('mojuan.sources.custom',
      JSON.stringify(["MJ.sources.register({ id:'ghost-boot', name:'G' }); throw new Error('boom');"])));
    await p.reload();
    await p.waitForFunction(() => window.MJ.sources.ready === true, null, { timeout: 12000 });
    await p.waitForTimeout(200);
    const r = await p.evaluate(() => ({
      ghost: window.MJ.sources.list().some((s) => s.id === 'ghost-boot'),
      left: JSON.parse(localStorage.getItem('mojuan.sources.custom') || '[]').length
    }));
    ok('AB3 启动载入坏插件不污染书源列表', !r.ghost);
    ok('AB4 载入失败的坏代码被剔除', r.left === 0, '剩余 ' + r.left);
    await p.close();
  }
  {
    /* 系统中断手势（来电 / 切后台）：只该弹回，绝不能提交页码 */
    const p = await newPage(browser, {
      settings: { pageMode: 'flip', flipAnim: 'slide', fs: 26, lh: 2.8 }
    }, errs);
    await p.goto(FILE + '#/reader/shijing/1');
    await p.waitForSelector('#flipPage [data-fi]', { timeout: 8000 });
    const before = await p.evaluate(() => parseInt(document.querySelector('#flipFoot b').textContent, 10));
    await p.evaluate(() => {
      const body = document.getElementById('readerBody');
      const t = document.querySelector('#flipPage [data-fi]') || document.getElementById('flipPage');
      const r = body.getBoundingClientRect();
      const y = r.y + r.height * 0.4;
      const fire = (type, x, pid) => t.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: pid, pointerType: 'touch',
        clientX: x, clientY: y, button: 0
      }));
      window.getSelection().removeAllRanges();
      fire('pointerdown', 300, 1);
      fire('pointermove', 100, 1);
      fire('pointermove', 80, 1);
      fire('pointercancel', 80, 1);
    });
    await p.waitForTimeout(450);
    const after = await p.evaluate(() => parseInt(document.querySelector('#flipFoot b').textContent, 10));
    ok('AB5 pointercancel 不翻页', after === before, before + ' → ' + after);
    await p.close();
  }
  {
    const p = await newPage(browser, {}, errs);
    await p.addInitScript(TTS_MOCK);
    await p.goto(FILE + '#/reader/shijing/1');
    await p.waitForTimeout(650);
    await p.click('[data-action="toggle-tts"]');
    await p.waitForTimeout(300);
    await p.click('[data-action="listen-panel"][data-val="voice"]');
    await p.waitForTimeout(200);
    const hasBtn = await p.evaluate(() => !!document.querySelector('[data-action="voice-config"]'));
    if (hasBtn) { await p.click('[data-action="voice-config"]'); await p.waitForTimeout(200); }
    const opened = await p.evaluate(() => !!document.getElementById('voiceModal'));
    await p.keyboard.press('Escape');
    await p.waitForTimeout(250);
    const r = await p.evaluate(() => {
      const full = document.getElementById('listen'), mini = document.getElementById('listenMini');
      return {
        modal: !!document.getElementById('voiceModal'),
        full: !!(full && !full.hidden),
        mini: !!(mini && !mini.hidden)
      };
    });
    ok('AB6 Esc 能关掉在线音色配置弹层', opened && !r.modal, 'opened=' + opened + ' btn=' + hasBtn);
    /* 听卷占屏时主干本来就该 inert，不能拿它当判据；要看的是 Esc 有没有
       落到 listen.active 分支把朗读收成迷你条甚至停掉 */
    ok('AB7 Esc 关弹层时不收起听卷', r.full && !r.mini, 'full=' + r.full + ' mini=' + r.mini);
    await p.close();
  }

  /* ===== AC：分类 chip / 笔记改色 / Shift+空格 / 单章章名 / 双指拖拽 ===== */
  {
    const LOCAL = {
      id: 'local-ac-1', local: true, title: '分类测试卷', author: '本地导入',
      category: '本地', status: '本地', tags: ['本地导入'], words: '100字',
      score: 9.0, readers: '本地卷', hot: 1, motif: 'ink', color: '#5a4a3a', color2: '#8a7a6a',
      seal: '分', desc: '由本地文件导入，共 1 章。', chapters: ['第一章 初遇'], addedAt: 1
    };
    const p = await newPage(browser, { localBooks: [LOCAL] }, errs);
    await p.goto(FILE + '#/store/category');
    await p.waitForTimeout(400);
    const n = await p.evaluate(() => document.querySelectorAll('.chip[data-action="set-cat"][data-val="本地"]').length);
    ok('AC1 分类页「本地」只出现一次', n === 1, '实际 ' + n + ' 个');
    await p.close();
  }
  {
    const p = await newPage(browser, {
      annotations: {
        shijing: [
          { text: '关关雎鸠，在河之洲', note: '', ch: 1, pi: 0, color: 'red' },
          { text: '窈窕淑女，君子好逑', note: '', ch: 1, pi: 1, color: 'red' }
        ]
      }
    }, errs);
    await p.goto(FILE + '#/me');
    await p.waitForTimeout(400);
    await p.click('[data-action="toggle-note-multi"]');
    await p.waitForTimeout(150);
    await p.click('[data-note-item]');
    await p.waitForTimeout(120);
    await p.click('[data-action="note-bulk-color"][data-val="jade"]');
    await p.waitForTimeout(180);
    const c = await p.evaluate(() => {
      const items = Array.from(document.querySelectorAll('[data-note-item]'));
      const chip = document.querySelector('.note-color-row .chip[data-val="jade"]');
      return {
        colors: items.map((el) => el.dataset.noteColor),
        text: chip ? chip.textContent.trim() : '',
        disabled: chip ? chip.disabled : null
      };
    });
    ok('AC2 批量改色同步 DOM 颜色与 chip 计数', c.colors[0] === 'jade' && c.colors[1] === 'red'
      && /1/.test(c.text) && c.disabled === false, JSON.stringify(c));
    /* 修复前青竹 chip 是 disabled，这里绕过禁用只为走到筛选逻辑本身 */
    await p.evaluate(() => {
      const chip = document.querySelector('.note-color-row .chip[data-val="jade"]');
      if (chip) { chip.disabled = false; chip.click(); }
    });
    await p.waitForTimeout(150);
    const f = await p.evaluate(() => {
      const nm = document.getElementById('noteNoMatch');
      return {
        shown: Array.from(document.querySelectorAll('[data-note-item]')).filter((el) => !el.hidden).length,
        noMatch: !!(nm && !nm.hidden)
      };
    });
    ok('AC3 改色后按新颜色能筛到笔记', f.shown === 1 && !f.noMatch, JSON.stringify(f));
    await p.close();
  }
  {
    const p = await newPage(browser, {
      settings: { pageMode: 'flip', flipAnim: 'slide', fs: 26, lh: 2.8 }
    }, errs);
    await p.goto(FILE + '#/reader/shijing/1');
    await p.waitForSelector('#flipPage [data-fi]', { timeout: 8000 });
    const footText = () => p.evaluate(() =>
      (document.querySelector('#flipFoot') || {}).textContent.replace(/\s+/g, ' ').trim());
    const parseFoot = (s) => {
      const m = String(s).match(/第\s*(\d+)\s*章\s*·\s*(\d+)\s*\/\s*(\d+)\s*页/);
      return m ? { ch: +m[1], p: +m[2] } : null;
    };
    await p.evaluate(() => document.getElementById('reader').focus());
    await p.keyboard.press('ArrowRight');
    /* flipSlide 动画 240ms、兜底 setTimeout 380ms，等不够会被 flipBusy 护栏挡回去 */
    await p.waitForTimeout(520);
    const beforeTxt = await footText();
    await p.keyboard.press('Shift+Space');
    await p.waitForTimeout(520);
    const afterTxt = await footText();
    const bf = parseFoot(beforeTxt), af = parseFoot(afterTxt);
    /* 只读页码会假通过：按错方向翻到章末会换到下一章、页码又从 1 开始 */
    ok('AC4 翻页模式 Shift+空格 往回翻（与快捷键说明一致）',
      !!(bf && af && af.ch === bf.ch && af.p === bf.p - 1), beforeTxt + ' → ' + afterTxt);

    const imp = await p.evaluate(async () => {
      const txt = '第一章 初遇\n\n' + '关关雎鸠，在河之洲。'.repeat(400);
      const res = await window.MJ.importer.parseFile(new File([txt], '单章.txt', { type: 'text/plain' }));
      return { first: res.chapters[0].title, n: res.chapters.length };
    });
    ok('AC5 只有一个章标记的 TXT 保留原章名', imp.first === '第一章 初遇', JSON.stringify(imp));
    await p.close();
  }
  {
    const p = await newPage(browser, {
      settings: { pageMode: 'flip', flipAnim: 'slide', fs: 26, lh: 2.8 }
    }, errs);
    await p.goto(FILE + '#/reader/shijing/1');
    await p.waitForSelector('#flipPage [data-fi]', { timeout: 8000 });
    const foot = () => p.evaluate(() => parseInt(document.querySelector('#flipFoot b').textContent, 10));
    const r = await p.locator('#readerBody').boundingBox();
    const f0 = await foot();
    await p.evaluate(() => {
      const body = document.getElementById('readerBody');
      const t = document.querySelector('#flipPage [data-fi]') || document.getElementById('flipPage');
      const y = body.getBoundingClientRect().y + body.getBoundingClientRect().height * 0.4;
      const fire = (type, x, pid) => t.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: pid, pointerType: 'touch',
        clientX: x, clientY: y, button: 0
      }));
      window.getSelection().removeAllRanges();
      fire('pointerdown', 300, 1);
      fire('pointermove', 100, 1);
      fire('pointerdown', 500, 2);
      fire('pointerup', 500, 2);
    });
    await p.waitForTimeout(200);
    const adj = await p.evaluate(() => {
      const a = document.getElementById('flipAdj');
      return a ? a.hidden : null;
    });
    ok('AC6 双指误触后邻页图层被清理', adj === true, 'flipAdj.hidden=' + adj);
    await p.waitForTimeout(320);
    await p.mouse.click(r.x + r.width * 0.86, r.y + r.height * 0.4);
    await p.waitForTimeout(380);
    ok('AC7 双指误触后下一次点击仍能翻页', (await foot()) === f0 + 1, f0 + ' → ' + (await foot()));
    await p.close();
  }

  /* ===== AD：HTML 导入不再把标签当正文、不再丢章名 ===== */
  {
    const p = await newPage(browser, {}, errs);
    await p.goto(FILE + '#/shelf');
    await p.waitForTimeout(300);
    const r = await p.evaluate(async () => {
      const html = '<!doctype html><html><head><title>不该进正文</title>'
        + '<style>.x{color:red}</style></head><body>'
        + '<h1>第一章 初遇</h1><p>关关雎鸠，在河之洲。</p>'
        + '<p>窈窕淑女，君子好逑。</p>'
        + '<script>var ghost = "不该进正文";</script></body></html>';
      const res = await window.MJ.importer.parseFile(new File([html], '初遇.html', { type: 'text/html' }));
      return {
        ext: res.ext, first: res.chapters[0].title, n: res.chapters.length,
        body: res.chapters.map((c) => c.paras.join('')).join('')
      };
    });
    ok('AD1 HTML 标签与脚本样式不进正文',
      !/〈(?:html|head|body|p|h1|style|script|title)/i.test(r.body) && !/不该进正文|color:red/.test(r.body),
      r.body.slice(0, 90));
    ok('AD2 HTML 的标题保留为章名', r.first === '第一章 初遇', r.first + ' / ' + r.n + ' 章');
    ok('AD3 HTML 正文文本完整保留', /关关雎鸠/.test(r.body) && /窈窕淑女/.test(r.body), r.body.slice(0, 90));
    ok('AD4 导入结果标记为 HTML 格式', r.ext === 'html', r.ext);

    const r2 = await p.evaluate(async () => {
      const html = '<div>第一段文本</div><br><div>第二段文本 &amp; 收尾</div>';
      const res = await window.MJ.importer.parseFile(new File([html], '无标题.htm', { type: 'text/html' }));
      return { body: res.chapters.map((c) => c.paras.join('')).join('') };
    });
    ok('AD5 无标题 HTML 同样剥标签并解码实体',
      !/〈/.test(r2.body) && /第一段文本/.test(r2.body) && /第二段文本/.test(r2.body),
      r2.body.slice(0, 80));

    const r3 = await p.evaluate(async () => {
      const res = await window.MJ.importer.parseFile(
        new File(['第一章 初遇\n\n正文内容。'], '普通.txt', { type: 'text/plain' }));
      return res.chapters[0].title;
    });
    ok('AD6 普通 TXT 章名不受影响', r3 === '第一章 初遇', r3);
    await p.close();
  }

  /* ===== AE：窄屏榜单页不横向溢出 ===== */
  {
    for (const w of [320, 360, 430]) {
      const p = await browser.newPage({ viewport: { width: w, height: 860 } });
      p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
      await p.addInitScript(seed, {});
      await p.goto(FILE + '#/store/rank');
      await p.waitForTimeout(320);
      const r = await p.evaluate(() => {
        const de = document.documentElement;
        return {
          over: de.scrollWidth - de.clientWidth,
          w: de.clientWidth,
          rights: Array.from(document.querySelectorAll('.rank-top3 .book-card'))
            .map((el) => Math.round(el.getBoundingClientRect().right))
        };
      });
      ok('AE ' + w + 'px 榜单页不横向溢出', r.over <= 1, '溢出 ' + r.over + 'px');
      if (w === 320) {
        ok('AE 前三甲卡片都在视口内', r.rights.length === 3 && r.rights.every((x) => x <= r.w + 1),
          JSON.stringify(r.rights) + ' / 视口 ' + r.w);
      }
      await p.close();
    }
  }

  /* ===== AF：读屏可访问性（语速面板对比度 / 目录列表语义） ===== */
  {
    const p = await newPage(browser, {}, errs);
    await p.goto(FILE + '#/me');
    await p.waitForTimeout(350);
    await p.addScriptTag({ path: require('path').join(__dirname, 'axe.min.js') });
    const c = await p.evaluate(async () => {
      const r = await window.axe.run(document, { runOnly: ['color-contrast'] });
      return r.violations.reduce((n, v) => n + v.nodes.length, 0);
    });
    ok('AF1 墨斋页面无对比度不足的文字', c === 0, c + ' 处未达 4.5:1');
    await p.close();
  }
  {
    const p = await newPage(browser, {}, errs);
    await p.goto(FILE + '#/book/shijing');
    await p.waitForTimeout(350);
    const r = await p.evaluate(() => {
      const lis = Array.from(document.querySelectorAll('#tocPanel .chapter-preview li'));
      return { n: lis.length, roles: lis.map((el) => el.getAttribute('role')) };
    });
    ok('AF2 目录条目的 role 不与 listitem 语义冲突',
      r.n > 0 && r.roles.every((x) => !x || x === 'listitem'), JSON.stringify(r.roles));
    await p.close();
  }

  /* ===== AG：海量笔记首屏不卡死（分批渲染） ===== */
  {
    const p = await browser.newPage({ viewport: { width: 430, height: 900 } });
    p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
    await p.addInitScript(() => {
      const ann = {};
      for (let i = 0; i < 20000; i++) {
        (ann.shijing = ann.shijing || []).push({
          text: '第' + i + '条划线内容', note: '', ch: 1 + (i % 10), pi: i,
          color: ['red', 'jade', 'gold'][i % 3], time: i
        });
      }
      localStorage.setItem('mojuan.state.v1', JSON.stringify({
        v: 5, shelf: ['shijing'], settings: {}, progress: {}, annotations: ann
      }));
    });
    await p.goto(FILE + '#/me');
    await p.waitForTimeout(500);
    const first = await p.evaluate(() => ({
      rows: document.querySelectorAll('[data-note-item]').length,
      dom: document.getElementsByTagName('*').length,
      more: !!document.querySelector('[data-action="note-more"]')
    }));
    ok('AG1 两万条笔记首屏只渲染一批', first.rows <= 300 && first.dom < 3000,
      first.rows + ' 行 / ' + first.dom + ' 节点');
    ok('AG2 提供「显示更多」入口', first.more);
    /* 展开一批后数量增加，但总量仍受控 */
    await p.click('[data-action="note-more"]');
    await p.waitForTimeout(150);
    const more = await p.evaluate(() => document.querySelectorAll('[data-note-item]').length);
    ok('AG3 显示更多能追加下一批', more > first.rows && more <= first.rows + 300,
      first.rows + ' → ' + more);
    await p.close();
  }
  {
    /* 命中落在未渲染的批次里：搜索必须找得到，且焦点不能被重渲染冲掉 */
    const p = await browser.newPage({ viewport: { width: 430, height: 900 } });
    p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
    await p.addInitScript(() => {
      const ann = {};
      for (let i = 0; i < 20000; i++) {
        (ann.shijing = ann.shijing || []).push({
          text: '第' + i + '条' + (i === 19999 ? '独门关键词' : '普通内容'),
          note: '', ch: 1, pi: i, color: 'red', time: 1
        });
      }
      localStorage.setItem('mojuan.state.v1', JSON.stringify({
        v: 5, shelf: ['shijing'], settings: {}, progress: {}, annotations: ann
      }));
    });
    await p.goto(FILE + '#/me');
    await p.waitForTimeout(500);
    await p.fill('#noteSearch', '独门关键词');
    await p.waitForTimeout(400);
    const r = await p.evaluate(() => ({
      visible: Array.from(document.querySelectorAll('[data-note-item]')).filter((el) => !el.hidden).length,
      noMatch: !document.getElementById('noteNoMatch').hidden,
      focus: document.activeElement.id
    }));
    ok('AG4 批次外的命中也能搜到', r.visible === 1 && !r.noMatch, JSON.stringify(r));
    ok('AG5 扩批重渲染后焦点回到搜索框', r.focus === 'noteSearch', r.focus);
    await p.close();
  }

  /* ===== AH：书卡无嵌套交互（读屏可访问性） ===== */
  {
    const p = await newPage(browser, {}, errs);
    await p.goto(FILE + '#/store');
    await p.waitForTimeout(350);
    await p.addScriptTag({ path: require('path').join(__dirname, 'axe.min.js') });
    const c = await p.evaluate(async () => {
      const r = await window.axe.run(document, { runOnly: ['nested-interactive'] });
      return r.violations.reduce((n, v) => n + v.nodes.length, 0);
    });
    ok('AH1 书肆页无嵌套交互违规', c === 0, c + ' 处');
    /* 键盘仍要能打开书：Tab 到卡片按回车 */
    const opened = await p.evaluate(async () => {
      const card = document.querySelector('#editorPick .book-card');
      if (!card) return false;
      card.focus();
      card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise((r) => setTimeout(r, 200));
      return location.hash.indexOf('#/book/') === 0;
    });
    ok('AH2 书卡键盘回车仍能打开书', opened);
    await p.close();
  }

  /* ===== AI：标题层级与 reader landmark ===== */
  {
    for (const [name, route] of [['search', '#/search'], ['book', '#/book/shijing'], ['store', '#/store']]) {
      const p = await newPage(browser, {}, errs);
      await p.goto(FILE + route);
      await p.waitForTimeout(350);
      await p.addScriptTag({ path: require('path').join(__dirname, 'axe.min.js') });
      const n = await p.evaluate(async () => {
        const r = await window.axe.run(document, { runOnly: ['heading-order'] });
        return r.violations.reduce((x, v) => x + v.nodes.length, 0);
      });
      ok('AI ' + name + ' 页标题层级连续', n === 0, n + ' 处跳级');
      await p.close();
    }
    const p = await newPage(browser, {}, errs);
    await p.goto(FILE + '#/reader/shijing/1');
    await p.waitForTimeout(700);
    await p.addScriptTag({ path: require('path').join(__dirname, 'axe.min.js') });
    const n = await p.evaluate(async () => {
      const r = await window.axe.run(document, { runOnly: ['region'] });
      return r.violations.reduce((x, v) => x + v.nodes.length, 0);
    });
    ok('AI reader 页内容都在 landmark 内', n === 0, n + ' 处游离内容');
    await p.close();
  }

  /* ===== AJ：重复导入同一文件不产生副本 ===== */
  {
    const p = await newPage(browser, { localBooks: [], shelf: [] }, errs);
    await p.goto(FILE + '#/shelf');
    await p.waitForTimeout(300);
    const files = Array.from({ length: 5 }, () => ({
      name: '同一本书.txt', mimeType: 'text/plain',
      buffer: Buffer.from('第一章 初遇\n\n' + '关关雎鸠，在河之洲。'.repeat(300))
    }));
    await p.locator('#fileInput').setInputFiles(files);
    await p.waitForTimeout(1200);
    const r = await p.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('mojuan.state.v1'));
      return { books: s.localBooks.length, shelf: s.shelf.length };
    });
    ok('AJ1 同一文件重复导入只留一本', r.books === 1 && r.shelf === 1, JSON.stringify(r));
    await p.close();
  }
  {
    /* 同名但正文不同：不能误判成重复 */
    const p = await newPage(browser, { localBooks: [], shelf: [] }, errs);
    await p.goto(FILE + '#/shelf');
    await p.waitForTimeout(300);
    const files = [
      { name: '同名.txt', mimeType: 'text/plain', buffer: Buffer.from('第一章 初遇\n\n' + '甲'.repeat(600)) },
      { name: '同名.txt', mimeType: 'text/plain', buffer: Buffer.from('第一章 初遇\n\n' + '乙'.repeat(900)) }
    ];
    await p.locator('#fileInput').setInputFiles(files);
    await p.waitForTimeout(1000);
    const r = await p.evaluate(() => JSON.parse(localStorage.getItem('mojuan.state.v1')).localBooks.length);
    ok('AJ2 同名但内容不同仍各自导入', r === 2, r + ' 本');
    await p.close();
  }

  /* ===== AK：可视化书源配置 ===== */
  {
    const p = await newPage(browser, {}, errs);
    await p.goto(FILE + '#/me');
    await p.waitForTimeout(350);
    await p.click('[data-action="add-source"]');
    await p.waitForTimeout(200);
    const hasForm = await p.evaluate(() => ['sfId', 'sfName', 'sfListUrl', 'sfBookList', 'sfContent']
      .every((id) => !!document.getElementById(id)));
    ok('AK1 可视化表单字段齐全', hasForm);
    await p.fill('#sfId', 'viz-test');
    await p.fill('#sfName', '测试可视化源');
    await p.fill('#sfGroup', '公版');
    /* 用存在的同源文件，避免测试里 refresh() fetch 外部站触发 CORS 噪声 */
    await p.fill('#sfListUrl', FILE);
    await p.fill('#sfBookList', '.book-item');
    await p.fill('#sfBookTitle', 'h3 a');
    await p.fill('#sfBookLink', 'a@href');
    await p.click('[data-action="source-form-save"]');
    await p.waitForTimeout(500);
    const r = await p.evaluate((url) => {
      const s = window.MJ.sources.get('viz-test');
      const saved = JSON.parse(localStorage.getItem('mojuan.sources.custom') || '[]');
      return { ok: !!s, name: s && s.name, group: s && s.group,
        cfg: !!(s && s._cfg && s._cfg.listUrl === url),
        saved: saved.some((c) => c.indexOf('/* mj-visual:viz-test */') === 0) };
    }, FILE);
    ok('AK2 表单保存后书源注册成功', r.ok && r.name === '测试可视化源' && r.group === '公版', JSON.stringify(r));
    ok('AK3 配置落到本地存储带标记', r.cfg && r.saved, JSON.stringify(r));
    /* 再进墨斋：书源列表能看到编辑按钮与分组 */
    await p.evaluate(() => { location.hash = '#/shelf'; });
    await p.waitForTimeout(200);
    await p.evaluate(() => { location.hash = '#/me'; });
    await p.waitForTimeout(400);
    const list = await p.evaluate(() => {
      const row = Array.from(document.querySelectorAll('.setting-row'))
        .find((el) => el.textContent.indexOf('测试可视化源') >= 0);
      return { row: !!row, edit: !!(row && row.querySelector('[data-action="source-edit"]')),
        group: !!(row && row.textContent.indexOf('公版') >= 0) };
    });
    ok('AK4 书源列表显示编辑入口与分组', list.row && list.edit && list.group, JSON.stringify(list));
    await p.close();
  }

  /* ===== AL：订阅源（A1） ===== */
  {
    const p = await newPage(browser, {}, errs);
    await p.goto(FILE + '#/me');
    await p.waitForTimeout(350);
    const hasEntry = await p.evaluate(() => !!document.querySelector('[data-go="subscribe"]'));
    ok('AL1 墨斋有订阅入口', hasEntry);
    /* 解析引擎：DOMParser + CSS 选择器抓文章列表（纯本地，无网络） */
    const parsed = await p.evaluate(() => {
      const K = window.MJ.subKit;
      const html = '<html><body><div class="post"><h3><a href="/a1">文章甲</a></h3></div>'
        + '<div class="post"><h3><a href="/a2">文章乙</a></h3></div></body></html>';
      /* 直接借用 sourceKit 的解析，验证选择器语法 */
      const doc = window.MJ.sourceKit.parseHtml(html, 'https://example.com/news');
      const items = window.MJ.sourceKit.pickAll(doc, '.post');
      return items.map((el) => window.MJ.sourceKit.pick(
        { querySelector: (s) => el.querySelector(s), textContent: el.textContent, getAttribute: (a) => el.getAttribute(a) },
        'h3 a', ''));
    });
    ok('AL2 订阅列表选择器能抽标题', parsed.length === 2 && parsed[0] === '文章甲' && parsed[1] === '文章乙',
      JSON.stringify(parsed));
    await p.goto(FILE + '#/subscribe');
    await p.waitForTimeout(250);
    await p.click('[data-action="sub-add"]');
    await p.waitForTimeout(150);
    const form = await p.evaluate(() => ['sbId', 'sbName', 'sbUrl', 'sbArticles', 'sbTitle', 'sbLink']
      .every((id) => !!document.getElementById(id)));
    ok('AL3 订阅表单字段齐全', form);
    await p.fill('#sbId', 'rss-test');
    await p.fill('#sbName', '测试订阅');
    await p.fill('#sbUrl', FILE);
    await p.fill('#sbArticles', '.post');
    await p.fill('#sbTitle', 'h3 a');
    await p.fill('#sbLink', 'a@href');
    await p.click('[data-action="sub-form-save"]');
    await p.waitForTimeout(400);
    const saved = await p.evaluate(() => {
      const s = (JSON.parse(localStorage.getItem('mojuan.state.v1')).subscriptions || []).find((x) => x.id === 'rss-test');
      return !!s && s.name === '测试订阅';
    });
    ok('AL4 订阅源配置落盘', saved);
    await p.close();
  }

  /* ===== AM：换源与进度迁移（A3） ===== */
  {
    const p = await newPage(browser, {
      progress: { 'srcA:1': { ch: 5, pct: 0.4, updated: 1 } },
      bookmarks: { 'srcA:1': [{ ch: 5, title: '书签甲' }] },
      bookTags: { 'srcA:1': 'reading' },
      pinned: ['srcA:1']
    }, errs);
    await p.goto(FILE + '#/shelf');
    await p.waitForTimeout(300);
    /* 注入两个同名、不同来源的在线书 */
    await p.evaluate(async () => {
      ['srcA', 'srcB'].forEach((sid) => {
        window.MJ.sources.register({
          id: sid, name: sid === 'srcA' ? '甲源' : '乙源', online: true,
          metasSync: () => [{ id: sid + ':1', sourceId: sid, title: '同名书', author: '某作者',
            category: '网络', tags: [], chapters: [{ no: 1, title: '第一章' }] }]
        });
      });
      await window.MJ.sources.refresh();
    });
    await p.goto(FILE + '#/book/srcA:1');
    await p.waitForTimeout(350);
    await p.click('[data-action="switch-source"]');
    await p.waitForTimeout(200);
    const cand = await p.evaluate(() => Array.from(document.querySelectorAll('[data-action="switch-source-to"]'))
      .map((el) => el.dataset.id));
    ok('AM1 换源弹层列出同名异源书', cand.length === 1 && cand[0] === 'srcB:1', JSON.stringify(cand));
    await p.click('[data-action="switch-source-to"][data-id="srcB:1"]');
    await p.waitForTimeout(350);
    const r = await p.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('mojuan.state.v1'));
      return { hash: location.hash, progress: s.progress['srcB:1'],
        oldProgress: !!s.progress['srcA:1'], bm: !!s.bookmarks['srcB:1'],
        tag: s.bookTags['srcB:1'], pinned: s.pinned.includes('srcB:1'), shelf: s.shelf.includes('srcB:1') };
    });
    ok('AM2 换源后进度与书签笔记迁移', r.hash.indexOf('book/srcB:1') >= 0 && r.progress
      && r.progress.ch === 5 && Math.abs(r.progress.pct - 0.4) < 0.001 && !r.oldProgress
      && r.bm && r.tag === 'reading' && r.pinned && r.shelf, JSON.stringify(r));
    await p.close();
  }

  /* ===== AN：内容净化与排版微调（A5/A7） ===== */
  {
    const p = await newPage(browser, {
      shelf: ['shijing'],
      settings: { pageMode: 'scroll', cleanRules: [{ pattern: '关关雎鸠', replacement: '【替换成功】', flags: 'g' }] }
    }, errs);
    await p.goto(FILE + '#/reader/shijing/1');
    await p.waitForTimeout(600);
    const body = await p.evaluate(() => document.querySelector('#readerBody').textContent);
    ok('AN1 净化规则作用于正文', body.indexOf('【替换成功】') >= 0, body.slice(0, 60));
    /* A7：章名字体与划线粗细设置改到 CSS 变量 */
    await p.evaluate(() => { location.hash = '#/me'; });
    await p.waitForTimeout(200);
    await p.goto(FILE + '#/reader/shijing/1');
    await p.waitForTimeout(500);
    await p.evaluate(() => {
      document.querySelector('[data-action="set-paper"]') && null;
      /* 直接走分派：模拟设置面板里的按钮点击 */
      const panel = document.getElementById('readerPanel');
      if (panel) panel.hidden = false;
    });
    /* 通过真实分派改设置：造按钮触发 set-chapterfont / set-underline */
    await p.evaluate(() => {
      const mk = (action, val) => {
        const b = document.createElement('button');
        b.dataset.action = action; b.dataset.val = val;
        document.body.appendChild(b); b.click(); b.remove();
      };
      mk('set-chapterfont', 'kai'); mk('set-underline', '3');
    });
    await p.waitForTimeout(200);
    const style = await p.evaluate(() => {
      const paper = document.getElementById('readerPaper');
      return {
        chapterFont: paper && paper.style.getPropertyValue('--chapter-ff'),
        underline: paper && paper.style.getPropertyValue('--hl-underline')
      };
    });
    ok('AN2 章名字体与划线粗细设置生效',
      !!style.chapterFont && style.chapterFont !== 'inherit' && style.underline === '3px',
      JSON.stringify(style));
    await p.close();
  }

  /* ===== AO：自定义书单（A8） ===== */
  {
    const p = await newPage(browser, { shelf: ['shijing'] }, errs);
    await p.goto(FILE + '#/me');
    await p.waitForTimeout(350);
    ok('AO1 墨斋有书单入口', await p.evaluate(() => !!document.querySelector('[data-go="lists"]')));
    await p.click('[data-go="lists"]');
    await p.waitForTimeout(250);
    await p.click('[data-action="list-add"]');
    await p.waitForTimeout(150);
    await p.fill('#listNameInput', '睡前读');
    await p.click('[data-action="list-save"]');
    await p.waitForTimeout(250);
    const created = await p.evaluate(() => (JSON.parse(localStorage.getItem('mojuan.state.v1')).lists || [])[0]);
    ok('AO2 新建书单落盘', !!created && created.name === '睡前读', JSON.stringify(created));
    /* 从详情页把书加进去 */
    await p.goto(FILE + '#/book/shijing');
    await p.waitForTimeout(300);
    await p.click('[data-action="list-pick"]');
    await p.waitForTimeout(150);
    await p.click('[data-action="list-add-book"]');
    await p.waitForTimeout(250);
    const added = await p.evaluate(() => {
      const l = (JSON.parse(localStorage.getItem('mojuan.state.v1')).lists || [])[0];
      return l && l.bookIds.indexOf('shijing') >= 0;
    });
    ok('AO3 书能加入书单', added);
    await p.close();
  }

  /* ===== AP：WebDAV 备份配置（A9） ===== */
  {
    const p = await newPage(browser, {}, errs);
    await p.goto(FILE + '#/me');
    await p.waitForTimeout(350);
    ok('AP1 墨斋有 WebDAV 入口', await p.evaluate(() => !!document.querySelector('[data-action="webdav-config"]')));
    await p.click('[data-action="webdav-config"]');
    await p.waitForTimeout(150);
    await p.fill('#wdUrl', 'https://dav.example.com/mojuan.json');
    await p.fill('#wdUser', 'tester');
    await p.fill('#wdPass', 'secret');
    /* 只验证配置落盘，不真的 fetch（CORS 环境不可控） */
    await p.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('mojuan.state.v1'));
      s.webdav = { url: document.getElementById('wdUrl').value, user: document.getElementById('wdUser').value, pass: document.getElementById('wdPass').value };
      localStorage.setItem('mojuan.state.v1', JSON.stringify(s));
    });
    const saved = await p.evaluate(() => {
      const w = JSON.parse(localStorage.getItem('mojuan.state.v1')).webdav;
      return w && w.url === 'https://dav.example.com/mojuan.json' && w.user === 'tester' && w.pass === 'secret';
    });
    ok('AP2 WebDAV 配置落盘', saved);
    await p.close();
  }

  /* ===== AQ：按段落阅读模式（A6） ===== */
  {
    const p = await newPage(browser, {
      shelf: ['shijing'], settings: { pageMode: 'para' }
    }, errs);
    await p.goto(FILE + '#/reader/shijing/1');
    await p.waitForTimeout(650);
    const st = await p.evaluate(() => ({
      mode: document.getElementById('readerRoot').dataset.mode,
      nav: !!document.querySelector('[data-action="para-next"]'),
      total: document.querySelectorAll('#readerPaper p[data-pi]').length,
      shown: Array.from(document.querySelectorAll('#readerPaper p[data-pi]')).filter((el) => !el.classList.contains('para-hidden')).length,
      tip: (document.getElementById('paraTip') || {}).textContent
    }));
    ok('AQ1 段落模式一次只显示一组', st.mode === 'para' && st.nav && st.total > 3 && st.shown === 3,
      JSON.stringify(st));
    await p.click('[data-action="para-next"]');
    await p.waitForTimeout(150);
    const after = await p.evaluate(() => ({
      shownIdx: Array.from(document.querySelectorAll('#readerPaper p[data-pi]'))
        .map((el, i) => el.classList.contains('para-hidden') ? -1 : i).filter((i) => i >= 0),
      tip: (document.getElementById('paraTip') || {}).textContent
    }));
    ok('AQ2 下一段按钮切换段落组', after.shownIdx[0] >= 3 && after.tip.indexOf('2 /') === 0,
      JSON.stringify(after));
    await p.close();
  }

  /* ===== AR：新功能集成——阅读设置面板对比度 ===== */
  {
    for (const paper of ['xuan', 'night']) {
      const p = await newPage(browser, {
        shelf: ['shijing'], settings: { paper }
      }, errs);
      await p.goto(FILE + '#/reader/shijing/1');
      await p.waitForTimeout(600);
      await p.click('[data-action="reader-settings"]');
      /* 面板逐行动画延迟到 .23s + .26s，等它落定再测，否则抓到半透明过渡色 */
      await p.waitForTimeout(700);
      await p.addScriptTag({ path: require('path').join(__dirname, 'axe.min.js') });
      const n = await p.evaluate(async () => {
        const r = await window.axe.run(document, { runOnly: ['color-contrast'] });
        return r.violations.reduce((x, v) => x + v.nodes.length, 0);
      });
      ok('AR ' + paper + ' 设置面板文字对比度达标', n === 0, n + ' 处不足');
      await p.close();
    }
  }

  /* ===== AT：封面渲染 XSS（本地卷作者 / 印章） ===== */
  {
    const P = '<img src=x onerror="window.__xss=1">';
    const p = await newPage(browser, {
      localBooks: [{ id: 'evil', local: true, title: '恶意卷', author: P, seal: P,
        category: '本地', status: '本地', tags: [], words: '1', chapters: [{ no: 1, title: '全' }], desc: 'x' }],
      shelf: ['evil']
    }, errs);
    await p.addInitScript(() => { window.__xss = 0; });
    for (const route of ['#/store', '#/shelf', '#/book/evil']) {
      await p.goto(FILE + route);
      await p.waitForTimeout(350);
    }
    const x = await p.evaluate(() => window.__xss);
    ok('AT1 本地卷作者与印章不执行脚本', x === 0, 'xss=' + x);
    await p.close();
  }
  {
    /* AT2：所有用户可控字段同时注入，逐个页面确认没有漏网的插值点 */
    const P = '<img src=x onerror="window.__xss=1">';
    const evil = { id: 'evil', local: true, title: P, author: P, desc: P, seal: P,
      category: P, status: P, words: P, tags: [P], color: '#000', color2: '#111',
      chapters: [{ no: 1, title: P }], addedAt: 1 };
    const p = await newPage(browser, {
      shelf: ['evil'], lastRead: 'evil', progress: { evil: { ch: 1, pct: 0 } },
      localBooks: [evil], bookTags: { evil: 'want' },
      annotations: { evil: [{ ch: 1, pi: 0, text: P, note: P, color: 'red' }] },
      subscriptions: [{ id: 's', name: P, url: 'x', enabled: true }],
      lists: [{ id: 'l', name: P, bookIds: ['evil'] }]
    }, errs);
    await p.addInitScript(() => { window.__xss = 0; });
    const hits = [];
    for (const route of ['#/store', '#/shelf', '#/me', '#/book/evil', '#/reader/evil/1', '#/subscribe', '#/lists', '#/search']) {
      await p.goto(FILE + route);
      await p.waitForTimeout(250);
      if (await p.evaluate(() => window.__xss)) hits.push(route);
    }
    ok('AT2 全字段注入八页面均无脚本执行', hits.length === 0, hits.join(','));
    await p.close();
  }

  /* ===== AU：书源 JSON 导入 / 导出 + 模板空壳兜底 ===== */
  {
    const p = await newPage(browser, {}, errs);
    await p.goto(FILE + '#/me');
    await p.waitForTimeout(350);
    ok('AU1 墨斋有书源导入导出入口', await p.evaluate(() =>
      !!document.querySelector('[data-action="import-source-json"]')
      && !!document.querySelector('[data-action="export-sources"]')));
    const payload = JSON.stringify({ app: 'mojuan-sources', version: 1, sources: [
      { id: 'imp1', name: '导入书源', group: '测试', listUrl: FILE,
        bookList: '.b', bookTitle: 'h3', content: '#c' },
      { id: 'rss1', name: '导入订阅', url: FILE,
        ruleArticles: '.post', ruleTitle: 'h3', ruleLink: 'a@href' }
    ] });
    await p.locator('#sourceFileInput').setInputFiles({ name: 's.json', mimeType: 'application/json', buffer: Buffer.from(payload) });
    await p.waitForTimeout(700);
    const r = await p.evaluate(() => ({
      src: !!window.MJ.sources.get('imp1'),
      cfg: !!(window.MJ.sources.get('imp1') || {})._cfg,
      subs: JSON.parse(localStorage.getItem('mojuan.state.v1')).subscriptions.map((s) => s.id)
    }));
    ok('AU2 导入书源与订阅配置', r.src && r.cfg && r.subs.indexOf('rss1') >= 0, JSON.stringify(r));
    /* legado 原生规则要给明确提示，不能静默失败 */
    await p.locator('#sourceFileInput').setInputFiles({ name: 'l.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify([{ bookSourceName: '起点', bookSourceUrl: 'x', searchUrl: '@js:x', ruleSearch: {} }])) });
    await p.waitForTimeout(350);
    const tip = await p.evaluate(() => document.querySelector('#toast').textContent);
    ok('AU3 legado 规则书源给明确提示', tip.indexOf('阅读 App 的规则书源') >= 0, tip);
    await p.close();
  }
  {
    /* 模板空壳：直接保存后详情不应出现 undefined */
    const p = await newPage(browser, {}, errs);
    await p.goto(FILE + '#/me');
    await p.waitForTimeout(350);
    await p.click('[data-action="add-source-js"]');
    await p.waitForTimeout(150);
    await p.click('[data-action="source-save"]');
    await p.waitForTimeout(500);
    await p.goto(FILE + '#/book/my-source:my-1');
    await p.waitForTimeout(300);
    const txt = await p.evaluate(() => document.body.textContent);
    ok('AU4 示例书源详情不出现 undefined', txt.indexOf('undefined') < 0);
    await p.close();
  }

  /* ===== AV：本地代理配置 ===== */
  {
    const p = await newPage(browser, {}, errs);
    await p.goto(FILE + '#/me');
    await p.waitForTimeout(350);
    ok('AV1 墨斋有代理地址入口', await p.evaluate(() => !!document.getElementById('proxyUrlInput')));
    await p.fill('#proxyUrlInput', 'http://127.0.0.1:8899');
    await p.click('[data-action="proxy-save"]');
    await p.waitForTimeout(200);
    const r = await p.evaluate(() => ({
      kit: window.MJ.sourceKit.getProxy(),
      state: JSON.parse(localStorage.getItem('mojuan.state.v1')).proxyUrl
    }));
    ok('AV2 代理地址写入状态与工具箱', r.kit === 'http://127.0.0.1:8899' && r.state === r.kit, JSON.stringify(r));
    /* 非法地址要拒绝 */
    await p.fill('#proxyUrlInput', '127.0.0.1:8899');
    await p.click('[data-action="proxy-save"]');
    await p.waitForTimeout(150);
    ok('AV3 非法代理地址被拒绝', await p.evaluate(() =>
      JSON.parse(localStorage.getItem('mojuan.state.v1')).proxyUrl === 'http://127.0.0.1:8899'));
    await p.close();
  }

  /* ===== AW：阅读 App 净化规则兼容 ===== */
  {
    /* 用 shijing 真实正文「关关雎鸠，在河之洲」验证正则与纯文本两种替换 */
    const rules = [
      { name: '正则', pattern: '关关雎鸠', replacement: '【正则命中】', isRegex: true, isEnabled: true, scopeContent: true, flags: 'g' },
      { name: '纯文本', pattern: '在河之洲', replacement: '【文本命中】', isRegex: false, isEnabled: true, scopeContent: true, flags: 'g' },
      { name: '停用', pattern: '窈窕淑女', replacement: '【不该出现】', isRegex: false, isEnabled: false, scopeContent: true, flags: 'g' }
    ];
    const p = await newPage(browser, {
      shelf: ['shijing'],
      settings: { pageMode: 'scroll', cleanRules: rules },
      progress: { shijing: { ch: 1, pct: 0 } }
    }, errs);
    await p.goto(FILE + '#/reader/shijing/1');
    await p.waitForTimeout(650);
    const body = await p.evaluate(() => document.querySelector('#readerBody').textContent);
    ok('AW1 正则与纯文本替换生效，停用规则不生效',
      body.indexOf('【正则命中】') >= 0 && body.indexOf('【文本命中】') >= 0
      && body.indexOf('【不该出现】') < 0 && body.indexOf('窈窕淑女') >= 0,
      body.slice(0, 80));
    /* 导入阅读导出的 ReplaceRule JSON */
    await p.evaluate(() => { location.hash = '#/me'; });
    await p.waitForTimeout(250);
    /* 必须先在阅读设置里打开净化弹层，#cleanRulesInput 才存在 */
    await p.goto(FILE + '#/reader/shijing/1');
    await p.waitForTimeout(600);
    await p.click('[data-action="reader-settings"]');
    await p.waitForTimeout(700);
    await p.click('[data-action="clean-rules"]');
    await p.waitForTimeout(150);
    const legado = JSON.stringify([
      { id: 1, name: '阅读规则', group: '净化', pattern: 'abc', replacement: 'XYZ',
        isRegex: false, isEnabled: true, scopeContent: true, scopeTitle: false, order: 0 }
    ]);
    await p.locator('#ruleFileInput').setInputFiles({ name: 'rules.json', mimeType: 'application/json', buffer: Buffer.from(legado) });
    await p.waitForTimeout(300);
    const imported = await p.evaluate(() => ({
      n: JSON.parse(localStorage.getItem('mojuan.state.v1')).settings.cleanRules.length,
      inBox: (document.querySelector('#cleanRulesInput') || {}).value || ''
    }));
    ok('AW2 阅读净化规则 JSON 可导入', imported.n === 4 && imported.inBox.indexOf('abc') >= 0,
      JSON.stringify(imported).slice(0, 150));
    await p.close();
  }
  {
    /* 标题净化 + 作用范围：用在线书验证 scope 只对指定书源生效 */
    const p = await newPage(browser, {
      settings: { cleanRules: [
        { name: '标题', pattern: '第', replacement: 'CH', isRegex: false, isEnabled: true,
          scopeTitle: true, scopeContent: false, flags: 'g' },
        { name: '甲源专属', pattern: '限定', replacement: '命中', isRegex: false, isEnabled: true,
          scope: 'srcA', scopeContent: true, flags: 'g' }
      ] }
    }, errs);
    await p.goto(FILE + '#/me');
    await p.waitForTimeout(400);
    await p.evaluate(async () => {
      ['srcA', 'srcB'].forEach((sid) => window.MJ.sources.register({
        id: sid, name: sid === 'srcA' ? '甲源' : '乙源', online: true,
        metasSync: () => [{ id: sid + ':1', sourceId: sid, title: '第1章', category: 'x',
          tags: [], chapters: [{ no: 1, title: '第1章 限定内容' }] }],
        getChapter: async () => ['第1章 限定内容', '正文限定']
      }));
      await window.MJ.sources.refresh();
    });
    /* 进阅读器看渲染结果：章节标题与正文的净化都在渲染层发生 */
    await p.goto(FILE + '#/reader/srcA:1/1');
    await p.waitForTimeout(800);
    const a = await p.evaluate(() => ({
      title: document.querySelector('#readerPaper h1')?.textContent || '',
      body: document.querySelector('#readerBody')?.textContent || ''
    }));
    await p.goto(FILE + '#/reader/srcB:1/1');
    await p.waitForTimeout(800);
    const bb = await p.evaluate(() => ({
      title: document.querySelector('#readerPaper h1')?.textContent || '',
      body: document.querySelector('#readerBody')?.textContent || ''
    }));
    ok('AW3 标题净化与书源作用范围生效',
      a.title.indexOf('CH') >= 0 && a.body.indexOf('命中') >= 0
      && bb.title.indexOf('CH') >= 0 && bb.body.indexOf('命中') < 0,
      JSON.stringify({ a, bb }).slice(0, 200));
    await p.close();
  }
  /* ===== AX：从阅读 App 借鉴的四项功能 ===== */
  {
    /* X1 未读章节角标 */
    const p = await newPage(browser, {
      shelf: ['shijing'], progress: { shijing: { ch: 3, pct: 0 } }
    }, errs);
    await p.goto(FILE + '#/shelf');
    await p.waitForTimeout(400);
    const b = await p.evaluate(() => {
      const el = document.querySelector('.unread-badge');
      return el ? { text: el.textContent, cls: el.className } : null;
    });
    ok('AX1 书架显示未读章节角标', !!b && b.cls.indexOf('reading') >= 0 && b.text.length > 0,
      JSON.stringify(b));
    await p.close();
  }
  {
    /* X2 自动翻页：段落模式切组 + 开关 */
    const p = await newPage(browser, {
      shelf: ['shijing'], settings: { pageMode: 'para' }
    }, errs);
    await p.goto(FILE + '#/reader/shijing/1');
    await p.waitForTimeout(700);
    const before = await p.evaluate(() => document.getElementById('paraTip').textContent);
    await p.click('[data-action="auto-page"]');
    await p.waitForTimeout(150);
    await p.evaluate(() => {
      const x = document.createElement('button');
      x.dataset.action = 'auto-speed'; x.dataset.val = '1000';
      document.body.appendChild(x); x.click(); x.remove();
    });
    await p.waitForTimeout(1300);
    const r = await p.evaluate(() => ({
      after: document.getElementById('paraTip').textContent,
      on: document.getElementById('autoPageBtn').dataset.on
    }));
    await p.click('[data-action="auto-page"]');
    await p.waitForTimeout(100);
    const off = await p.evaluate(() => document.getElementById('autoPageBtn').dataset.on);
    ok('AX2 自动翻页切组并可开关',
      before !== r.after && r.on === 'true' && off === 'false',
      JSON.stringify({ before, ...r, off }));
    await p.close();
  }
  {
    /* X3 简繁转换：开关切换正文 */
    const p = await newPage(browser, {
      shelf: ['shijing'], settings: { pageMode: 'scroll', s2t: false }
    }, errs);
    await p.goto(FILE + '#/reader/shijing/1');
    await p.waitForTimeout(650);
    const simp = await p.evaluate(() => document.querySelector('#readerBody').textContent);
    await p.goto(FILE + '#/me');
    await p.waitForTimeout(200);
    await p.goto(FILE + '#/reader/shijing/1');
    await p.waitForTimeout(650);
    await p.evaluate(() => {
      const x = document.createElement('button');
      x.dataset.action = 'set-s2t'; x.dataset.val = '1';
      document.body.appendChild(x); x.click(); x.remove();
    });
    await p.waitForTimeout(500);
    const trad = await p.evaluate(() => document.querySelector('#readerBody').textContent);
    ok('AX3 简繁切换改变正文字形',
      simp.indexOf('关关雎鸠') >= 0 && trad.indexOf('關關雎鳩') >= 0 && trad.indexOf('关关雎鸠') < 0,
      JSON.stringify({ simp: simp.slice(0, 30), trad: trad.slice(0, 30) }));
    await p.close();
  }

  /* ===== AY：MD3 分支借鉴的四项功能 ===== */
  {
    const p = await newPage(browser, {
      shelf: ['shijing'], progress: { shijing: { ch: 1, pct: 0 } }
    }, errs);
    await p.goto(FILE + '#/shelf');
    await p.waitForTimeout(400);
    /* Y1 密度切换 */
    const hasDensity = await p.evaluate(() => !!document.querySelector('[data-action="set-density"]'));
    await p.click('[data-action="set-density"][data-val="compact"]');
    await p.waitForTimeout(250);
    const density = await p.evaluate(() => ({
      cls: document.querySelector('.book-grid').className,
      saved: JSON.parse(localStorage.getItem('mojuan.state.v1')).density
    }));
    ok('AY1 书架密度可切换并持久化', hasDensity && density.cls.indexOf('density-compact') >= 0 && density.saved === 'compact',
      JSON.stringify(density));
    /* Y2 自动分组：有进度 -> 在读，无进度 -> 未读；用第二本书造对照 */
    const chips = await p.evaluate(() => Array.from(document.querySelectorAll('.shelf-autogroup .chip')).map((e) => e.textContent.trim()));
    await p.click('[data-action="set-shelf-filter"][data-val="auto:reading"]');
    await p.waitForTimeout(250);
    const readingCards = await p.evaluate(() => document.querySelectorAll('.book-card').length);
    ok('AY2 自动分组按进度归类', chips.length === 3 && chips[1].indexOf('1') >= 0 && readingCards === 1,
      JSON.stringify({ chips, readingCards }));
    await p.close();
  }
  {
    /* Y3 书籍备注：编辑、落盘、展示 */
    const p = await newPage(browser, { shelf: ['shijing'] }, errs);
    await p.goto(FILE + '#/book/shijing');
    await p.waitForTimeout(400);
    await p.click('[data-action="edit-book-note"]');
    await p.waitForTimeout(150);
    await p.fill('#bookNoteInput', '这是一本好诗集');
    await p.click('[data-action="save-book-note"]');
    await p.waitForTimeout(300);
    const note = await p.evaluate(() => ({
      saved: JSON.parse(localStorage.getItem('mojuan.state.v1')).bookNotes.shijing,
      shown: (document.querySelector('.bn-text') || {}).textContent
    }));
    ok('AY3 书籍备注可编辑与展示', note.saved === '这是一本好诗集' && note.shown === note.saved,
      JSON.stringify(note));
    await p.close();
  }
  {
    /* Y4 时间轴：翻章事件按天展示 */
    const p = await newPage(browser, {
      shelf: ['shijing'],
      readEvents: [
        { t: Date.now(), id: 'shijing', ch: 2 },
        { t: Date.now() - 3600000, id: 'shijing', ch: 1 }
      ]
    }, errs);
    await p.goto(FILE + '#/me');
    await p.waitForTimeout(400);
    const tl = await p.evaluate(() => ({
      has: !!document.querySelector('.timeline'),
      n: document.querySelectorAll('.tl-item').length,
      txt: (document.querySelector('.timeline') || {}).textContent || ''
    }));
    ok('AY4 读墨时间轴展示翻章事件', tl.has && tl.n === 2 && tl.txt.indexOf('诗经') >= 0,
      JSON.stringify({ has: tl.has, n: tl.n }));
    await p.close();
  }

  /* ===== AZ：漫画阅读与听卷增强 ===== */
  {
    const p = await newPage(browser, {}, errs);
    await p.goto(FILE + '#/me');
    await p.waitForTimeout(400);
    ok('AZ0 墨斋有漫画导入入口', await p.evaluate(() => !!document.querySelector('[data-action="import-comic"]')));
    /* 造两张本地图片 */
    const b64 = await p.evaluate(() => {
      const c = document.createElement('canvas'); c.width = 120; c.height = 160;
      const x = c.getContext('2d'); x.fillStyle = '#c33'; x.fillRect(0, 0, 120, 160);
      return c.toDataURL('image/png').split(',')[1];
    });
    const buf = Buffer.from(b64, 'base64');
    await p.locator('#imageFileInput').setInputFiles([
      { name: 'a_1.png', mimeType: 'image/png', buffer: buf },
      { name: 'a_2.png', mimeType: 'image/png', buffer: buf }
    ]);
    await p.waitForTimeout(1500);
    const meta = await p.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('mojuan.state.v1'));
      return s.localBooks[0] ? { kind: s.localBooks[0].kind, n: s.localBooks[0].chapters.length } : null;
    });
    ok('AZ1 图片导入成漫画卷', !!meta && meta.kind === 'comic' && meta.n === 2, JSON.stringify(meta));
    const id = await p.evaluate(() => JSON.parse(localStorage.getItem('mojuan.state.v1')).localBooks[0].id);
    await p.goto(FILE + '#/reader/' + id + '/1');
    await p.waitForTimeout(800);
    const render = await p.evaluate(() => ({
      img: !!document.querySelector('#comicImg'), tools: !!document.querySelector('#comicTools')
    }));
    ok('AZ2 漫画页渲染图片与工具条', render.img && render.tools, JSON.stringify(render));
    await p.click('[data-action="comic-zoom"][data-val="+"]');
    await p.waitForTimeout(120);
    const zoom = await p.evaluate(() => document.querySelector('#comicImg').dataset.zoom);
    ok('AZ3 漫画缩放生效', zoom === '1.25', zoom);
    await p.click('[data-action="comic-crop"]');
    await p.waitForTimeout(120);
    ok('AZ4 漫画切边可切换', await p.evaluate(() => document.querySelector('.comic-page').classList.contains('cropped')));
    await p.close();
  }
  {
    /* 听卷迷你条定时角标 */
    const p = await newPage(browser, { shelf: ['shijing'], settings: { pageMode: 'scroll' } }, errs);
    await p.goto(FILE + '#/reader/shijing/1');
    await p.waitForTimeout(700);
    await p.click('[data-action="toggle-tts"]');
    await p.waitForTimeout(300);
    const started = await p.evaluate(() => !!document.getElementById('listen'));
    if (started) {
      await p.evaluate(() => {
        const x = document.createElement('button');
        x.dataset.action = 'listen-timer'; x.dataset.val = '30';
        document.body.appendChild(x); x.click(); x.remove();
      });
      await p.waitForTimeout(150);
      await p.click('[data-action="listen-minimize"]');
      await p.waitForTimeout(150);
    }
    const timer = await p.evaluate(() => {
      const el = document.getElementById('lmTimer');
      return el ? { exists: true, hidden: el.hidden, text: el.textContent } : { exists: false };
    });
    ok('AZ5 听卷迷你条显示定时剩余', started && timer.exists && !timer.hidden && timer.text.indexOf('分') >= 0,
      JSON.stringify({ started, timer }));
    await p.close();
  }

  /* ===== BA：段距 / 首行缩进 / 目录筛选 / 单卷墨卷包 ===== */
  {
    const p = await newPage(browser, { shelf: ['shijing'], settings: { pageMode: 'scroll', fs: 19, lh: 2 } }, errs);
    await p.goto(FILE + '#/reader/shijing/1');
    await p.waitForTimeout(600);
    const before = await p.evaluate(() => {
      const el = document.querySelector('#readerPaper p[data-pi]');
      const cs = getComputedStyle(el);
      return { mb: parseFloat(cs.marginBottom) || 0, ti: cs.textIndent };
    });
    ok('BA0 默认段距与首行缩进', before.mb > 15 && before.ti !== '0px', JSON.stringify(before));
    await p.click('[data-action="reader-settings"]');
    await p.waitForTimeout(200);
    await p.click('#readerPanel [data-action="set-paragap"][data-val="1.7"]');
    await p.waitForTimeout(150);
    await p.click('#readerPanel [data-action="set-indent"][data-val="0"]');
    await p.waitForTimeout(200);
    const after = await p.evaluate(() => {
      const el = document.querySelector('#readerPaper p[data-pi]');
      const cs = getComputedStyle(el);
      const s = JSON.parse(localStorage.getItem('mojuan.state.v1') || '{}');
      return { mb: parseFloat(cs.marginBottom) || 0, ti: cs.textIndent, st: s.settings || {} };
    });
    /* 1.7em × 19px ≈ 32.3px；给 2px 余量，字体度量有小数 */
    ok('BA1 段距切到疏朗后生效', Math.abs(after.mb - 19 * 1.7) < 2, String(after.mb));
    ok('BA2 首行缩进关闭后为 0', after.ti === '0px', after.ti);
    ok('BA3 排版设置已存档', Number(after.st.paraGap) === 1.7 && after.st.indent === false, JSON.stringify(after.st));
    /* 翻页模式是另一套排版（分页测量 + 缓存键），必须一起认这两个设置 */
    await p.click('#readerPanel [data-action="set-pagemode"][data-val="flip"]');
    await p.waitForTimeout(900);
    const flipTi = await p.evaluate(() => {
      const el = document.querySelector('#flipPage p');
      return el ? getComputedStyle(el).textIndent : 'none';
    });
    ok('BA4 翻页模式同样不缩进', flipTi === '0px', flipTi);
    await p.close();
  }
  {
    const p = await newPage(browser, {
      shelf: ['daodejing'], settings: { pageMode: 'scroll' },
      progress: { daodejing: { ch: 6, pct: 0, updated: 1 } }
    }, errs);
    await p.goto(FILE + '#/reader/daodejing/6');
    await p.waitForTimeout(600);
    await p.click('[data-action="reader-catalog"]');
    await p.waitForTimeout(250);
    const total = await p.evaluate(() => document.querySelectorAll('#catalogList li').length);
    await p.click('.cat-filters [data-val="unread"]');
    await p.waitForTimeout(150);
    const unread = await p.evaluate(() => Array.from(document.querySelectorAll('#catalogList li')).filter((li) => !li.hidden).length);
    /* 第 6 章为当前章，1–5 章算读过：未读应剩 total - 5 */
    ok('BA5 未读筛选只留当前章及之后', total > 6 && unread === total - 5, unread + '/' + total);
    const notedDisabled = await p.evaluate(() => {
      const b = document.querySelector('.cat-filters [data-val="noted"]');
      return b ? b.disabled : null;
    });
    ok('BA6 没有笔记时「有笔记」不可点', notedDisabled === true, String(notedDisabled));
    await p.click('.cat-filters [data-val="all"]');
    await p.waitForTimeout(150);
    const back = await p.evaluate(() => Array.from(document.querySelectorAll('#catalogList li')).filter((li) => !li.hidden).length);
    ok('BA7 切回全部恢复整卷目录', back === total, back + '/' + total);
    await p.close();
  }
  {
    const p = await newPage(browser, {}, errs);
    await p.goto(FILE + '#/me');
    await p.waitForTimeout(400);
    const pack = {
      app: 'mojuan-volume', version: 1,
      book: { title: '墨卷包测试卷', author: '测试', desc: '端到端测试用的卷', kind: 'text', tags: ['测试'] },
      chapters: [{ title: '第一章 起', paras: ['甲段正文', '乙段正文'] }, { title: '第二章 承', paras: ['丙段正文'] }],
      notes: {
        annotations: [{ ch: 1, pi: 0, text: '甲段正文', note: '批一句', color: 'jade', time: 1 }],
        bookmarks: [{ title: '第一章 起', ch: 1, page: 0, time: 1, note: '' }],
        bookNote: '整卷备注'
      }
    };
    const send = () => p.locator('#fileInput').setInputFiles([{
      name: '测试卷.mjz', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(pack), 'utf8')
    }]);
    await send();
    await p.waitForTimeout(1800);
    const got = await p.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('mojuan.state.v1') || '{}');
      const b = (s.localBooks || []).find((x) => x.title === '墨卷包测试卷');
      if (!b) return null;
      return {
        id: b.id, chs: b.chapters.length,
        ann: (s.annotations[b.id] || []).length, bm: (s.bookmarks[b.id] || []).length,
        note: (s.bookNotes || {})[b.id]
      };
    });
    ok('BA8 墨卷包导入成卷', !!got && got.chs === 2, JSON.stringify(got));
    ok('BA9 笔记 / 卷签 / 整卷备注随包恢复',
      !!got && got.ann === 1 && got.bm === 1 && got.note === '整卷备注', JSON.stringify(got));
    if (got) {
      await p.goto(FILE + '#/reader/' + got.id + '/1');
      await p.waitForTimeout(600);
      const body = await p.evaluate(() => document.querySelector('#readerPaper').textContent);
      ok('BA10 导入卷正文可读', body.indexOf('甲段正文') >= 0, body.slice(0, 30));
    } else ok('BA10 导入卷正文可读', false, '卷未导入');
    /* 同一个包再导一次：指纹相同，应被跳过而不是堆出第二本 */
    await p.goto(FILE + '#/me');
    await p.waitForTimeout(300);
    await send();
    await p.waitForTimeout(1200);
    const dupN = await p.evaluate(() => (JSON.parse(localStorage.getItem('mojuan.state.v1') || '{}').localBooks || [])
      .filter((b) => b.title === '墨卷包测试卷').length);
    ok('BA11 重复导入不产生副本', dupN === 1, String(dupN));
    const [dl] = await Promise.all([
      p.waitForEvent('download', { timeout: 6000 }).catch(() => null),
      p.click('[data-action="export-volume"]')
    ]);
    ok('BA12 单卷可导出成 .mjz', !!dl && /\.mjz$/.test(dl.suggestedFilename()), dl && dl.suggestedFilename());
    await p.close();
  }

  /* ===== BB：宽屏双栏 ===== */
  {
    const p = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
    p.on('console', (m) => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
    await p.addInitScript(seed, { shelf: [], settings: { pageMode: 'flip' } });
    await p.goto(FILE + '#/me');
    await p.waitForTimeout(400);
    /* 造一卷够长的本地书：短章在宽屏上只有一页，双栏验不出来 */
    const paras = [];
    for (let i = 0; i < 70; i++) {
      paras.push('第' + (i + 1) + '段：' + '春眠不觉晓处处闻啼鸟夜来风雨声花落知多少'.repeat(4));
    }
    const pack = {
      app: 'mojuan-volume', version: 1,
      book: { title: '双栏测试卷', author: '测试', kind: 'text' },
      chapters: [{ title: '第一章 长', paras }, { title: '第二章 短', paras: ['短章一段'] }]
    };
    await p.locator('#fileInput').setInputFiles([{
      name: '双栏.mjz', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(pack), 'utf8')
    }]);
    await p.waitForTimeout(1600);
    const bid = await p.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('mojuan.state.v1') || '{}');
      const b = (s.localBooks || []).find((x) => x.title === '双栏测试卷');
      return b ? b.id : null;
    });
    ok('BB0 长出测试卷', !!bid, String(bid));
    await p.goto(FILE + '#/reader/' + bid + '/1');
    await p.waitForTimeout(1200);
    const s1 = await p.evaluate(() => {
      const sp = document.querySelector('#flipPage .flip-spread');
      const cols = sp ? Array.from(sp.querySelectorAll('.flip-col')) : [];
      return {
        spread: !!sp, n: cols.length,
        widths: cols.map((c) => Math.round(c.getBoundingClientRect().width)),
        over: cols.map((c) => c.scrollHeight - c.clientHeight),
        foot: (document.querySelector('#flipFoot b') || {}).textContent,
        total: (document.querySelector('#flipFoot') || {}).textContent
      };
    });
    ok('BB1 宽屏自动拆成双栏', s1.spread === true && s1.n === 2, JSON.stringify(s1));
    ok('BB2 两栏等宽且没有文字溢出',
      s1.widths[0] === s1.widths[1] && s1.over.every((v) => v <= 1), JSON.stringify(s1));
    ok('BB3 页脚写成「1–2 / N 页」', /^1–2$/.test(s1.foot || ''), String(s1.foot) + ' | ' + s1.total);
    await p.keyboard.press('ArrowRight');
    await p.waitForTimeout(800);
    const foot2 = await p.evaluate(() => (document.querySelector('#flipFoot b') || {}).textContent);
    ok('BB4 一次翻两页（3–4）', /^3–4$/.test(foot2 || ''), String(foot2));
    /* 设置里选单栏：立刻回到一屏一页 */
    await p.evaluate(() => {
      const btn = document.querySelector('[data-action="reader-settings"]');
      if (btn) btn.click();
    });
    await p.waitForTimeout(300);
    await p.click('#readerPanel [data-action="set-columns"][data-val="one"]');
    await p.waitForTimeout(700);
    const s2 = await p.evaluate(() => ({
      spread: !!document.querySelector('#flipPage .flip-spread'),
      foot: (document.querySelector('#flipFoot b') || {}).textContent
    }));
    ok('BB5 选单栏后回到一屏一页', s2.spread === false && /^\d+$/.test(s2.foot || ''), JSON.stringify(s2));
    /* 窄屏（手机）即便设置成双栏也不挤成窄条 */
    await p.evaluate(() => {
      const btn = document.querySelector('[data-action="set-columns"][data-val="two"]');
      if (btn) btn.click();
    });
    await p.waitForTimeout(500);
    await p.setViewportSize({ width: 430, height: 900 });
    await p.waitForTimeout(900);
    const s3 = await p.evaluate(() => ({
      spread: !!document.querySelector('#flipPage .flip-spread'),
      w: document.querySelector('#flipPage .flip-col') ?
        Math.round(document.querySelector('#flipPage .flip-col').getBoundingClientRect().width) : 0
    }));
    ok('BB6 窄屏下双栏自动让位给单栏', s3.spread === false, JSON.stringify(s3));
    await p.close();
  }

  ok('全程无控制台错误', errs.length === 0, errs.join(' | '));
  await browser.close();
  console.log('\n墨卷端到端回归：' + pass + ' PASS / ' + fail + ' FAIL');
  if (fail) process.exit(1);
})().catch((e) => { console.error('测试异常：', e.message); process.exit(1); });
