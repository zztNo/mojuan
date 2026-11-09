/* 墨卷 · 应用逻辑 */
(function () {
  'use strict';
  const D = window.MJ.data;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const view = $('#view');
  const readerRoot = $('#readerRoot');
  const IMP = window.MJ.importer;
  const LOCAL_COLORS = [
    ['#3E5C55', '#1E3733'], ['#6C5878', '#382C43'], ['#8A4B32', '#4B2818'],
    ['#2F4B6E', '#16263C'], ['#5C6B48', '#303B27'], ['#375E68', '#1A333A']
  ];
  const LOCAL_MOTIFS = ['mountain', 'bamboo', 'cloud', 'wave', 'city', 'star', 'flower', 'sword'];
  /* 正文字体：Windows / macOS 字体名都列上，缺哪个自动回退 */
  const FONT_STACKS = {
    song: '"Source Han Serif CN","Source Han Serif SC","Noto Serif CJK SC","Noto Serif SC","Songti SC","STSong","SimSun","宋体",serif',
    hei: '"PingFang SC","Microsoft YaHei","微软雅黑","SimHei","Heiti SC",sans-serif',
    kai: '"Kaiti SC","STKaiti","KaiTi","楷体","SimSun",serif',
    fang: '"FangSong","STFangsong","仿宋","FangSong_GB2312","SimSun",serif'
  };
  const FONT_NAMES = { song: '宋体', hei: '黑体', kai: '楷体', fang: '仿宋' };
  const contentCache = {};
  const chapterInFlight = {};   /* bookId:no -> Promise，防止快速翻章时同一章被并发请求多次 */
  let coverUid = 0;
  let readerToken = 0;
  let sourcesReady = Promise.resolve();
  let importing = false;

  /* 书源层：书肆 / 藏卷 / 详情 / 阅读器 统一从这里取书
   * 内置公版书、维基文库在线源、本地导入卷，都走同一套接口 */
  const SRC = window.MJ.sources;
  function getBook(id) {
    return SRC.getBook(id) || (state.localBooks || []).find((b) => b.id === id) || null;
  }
  function allBooks() { return SRC.allBooks().concat(state.localBooks || []); }
  function chapterList(b) {
    if (b.local) return (b.chapters || []).map((t, i) => ({ no: i + 1, title: t }));
    if (b.chapters && b.chapters.length) return b.chapters;
    return [{ no: 1, title: '全文' }];
  }
  /* 全书读了多少：progress.pct 只记「本章读到几成」，直接当全书进度显示会大错
   * （读完第 100 章也显示 100%）。这里换算成 (已读章数 + 本章进度) / 总章数。 */
  function bookPct(b) {
    if (!b) return 0;
    const pr = state.progress[b.id];
    if (!pr) return 0;
    const total = Math.max(1, chapterList(b).length);
    const ch = Math.max(1, Math.min(total, Number(pr.ch) || 1));
    const inner = Math.max(0, Math.min(1, Number(pr.pct) || 0));
    return Math.max(0, Math.min(1, (ch - 1 + inner) / total));
  }
  /* 本章的校勘记 / 编者注：由在线书源在取正文时顺手挂在章节对象上。
     内置的离线书没有这类注，返回空数组。 */
  function chapterNotes(b, idx) {
    if (!b) return [];
    const src = SRC.get(b.sourceId);
    if (!src || typeof src.getChapterNotes !== 'function') return [];
    try { return src.getChapterNotes(b.id, idx + 1) || []; } catch (e) { return []; }
  }
  function paragraphs(b, idx) {
    if (b.local) {
      const rec = contentCache[b.id];
      const c = rec && rec.chapters && rec.chapters[idx];
      return c && c.paras && c.paras.length ? c.paras : ['本章内容未能读取，请重新导入这卷。'];
    }
    /* 内置源直接同步取；在线源走预取缓存 */
    const sync = SRC.getChapterSync(b.id, idx + 1);
    if (sync && sync.length) return sync;
    const rec = contentCache[b.id];
    const c = rec && rec.chapters && rec.chapters[idx];
    if (c && c.paras && c.paras.length) return c.paras;
    return ['（这一章暂未取到正文，请稍后重试）'];
  }
  /* 正文按需取：内置书首次打开要加载整本分片，在线源逐章取回 */
  async function ensureChapter(b, no) {
    if (!b || b.local) return;
    const src = SRC.get(b.sourceId);
    if (!src || typeof src.getChapter !== 'function') return;
    if (SRC.getChapterSync(b.id, no)) return;
    const rec = contentCache[b.id] || (contentCache[b.id] = { id: b.id, chapters: [] });
    if (rec.chapters[no - 1] && rec.chapters[no - 1].paras) return;
    /* 同一章已在取回中（目录回写触发的二次 ensure 等），直接复用那次请求 */
    const inflightKey = b.id + '::' + no;
    if (chapterInFlight[inflightKey]) { await chapterInFlight[inflightKey]; return; }
    const task = (async () => {
      try {
        const paras = await src.getChapter(b.id, no);
        if (paras && paras.length) rec.chapters[no - 1] = { title: '', paras: paras };
        /* 在线源可能在这一步才拿到真实章节目录，回写到索引 */
        const meta = SRC.getBook(b.id);
        if (meta && meta.chapters && meta.chapters.length <= 1 && paras && paras.length) {
          const fresh = await src.getBookMeta && await src.getBookMeta(b.id);
          if (fresh && fresh.chapters && fresh.chapters.length > 1) meta.chapters = fresh.chapters;
        }
      } catch (e) { /* 断网时静默，渲染处会给提示 */ }
    })();
    chapterInFlight[inflightKey] = task;
    try { await task; } finally { delete chapterInFlight[inflightKey]; }
  }

  /* 正文放 IndexedDB，localStorage 只放轻量元数据 */
  function openDB() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('mojuan-lib', 1);
      r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('books')) r.result.createObjectStore('books'); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  /* file:// 单文件版没有 IndexedDB，降级到 localStorage */
  const LS_PREFIX = 'mojuan.content.';
  function idbFallback(method, id, value) {
    const key = LS_PREFIX + id;
    if (method === 'put') { localStorage.setItem(key, JSON.stringify(value)); return true; }
    if (method === 'get') {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : undefined;
    }
    localStorage.removeItem(key); return true;
  }
  function idb(method, id, value) {
    let task;
    try {
      task = openDB().then((db) => new Promise((res, rej) => {
        const tx = db.transaction('books', method === 'get' ? 'readonly' : 'readwrite');
        const req = tx.objectStore('books')[method](...(method === 'put' ? [value, id] : [id]));
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
        tx.oncomplete = () => db.close();
      }));
    } catch (e) { task = Promise.reject(e); }
    return task.catch(() => idbFallback(method, id, value));
  }
  const saveContent = (id, content) => idb('put', id, content);
  const loadContent = (id) => idb('get', id);
  const deleteContent = (id) => idb('delete', id);

  /* 导入本地 TXT / EPUB */
  async function importFiles(fileList) {
    if (importing) { toast('正在导入，请稍候'); return; }
    const files = Array.from(fileList || []).filter((f) => f && f.size > 0 && f.size <= 30 * 1024 * 1024);
    if (!files.length) { toast('请选择 TXT / EPUB 文件（单卷不超过 30MB）'); return; }
    importing = true;
    let lastId = null, ok = 0, weakSave = 0;
    for (const f of files) {
      const short = f.name.replace(/\.[^.]+$/, '').slice(0, 12);
      try {
        toast('正在解析《' + short + '》…');
        const r = await IMP.parseFile(f);
        const chapters = r.chapters.filter((c) => c.paras && c.paras.length);
        if (!chapters.length) throw new Error('文件里没有可读内容');
        const chars = chapters.reduce((a, c) => a + c.paras.join('').length, 0);
        const now = Date.now();
        const id = 'local-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 7);
        const pal = LOCAL_COLORS[ok % LOCAL_COLORS.length];
        const first = (chapters[0].paras[0] || '').slice(0, 60);
        const meta = {
          id, local: true, title: r.title || short, author: r.author || '本地导入',
          category: '本地', status: '本地', tags: ['本地导入', (r.ext || 'txt').toUpperCase()],
          words: chars >= 10000 ? (chars / 10000).toFixed(1) + '万' : chars + '字',
          score: 9.0, readers: '本地卷', hot: 60,
          motif: LOCAL_MOTIFS[ok % LOCAL_MOTIFS.length], color: pal[0], color2: pal[1],
          seal: (r.title || '卷').replace(/[《》\s]/g, '').charAt(0) || '卷',
          desc: '由本地文件导入，共 ' + chapters.length + ' 章。' + (first ? first + '…' : ''),
          chapters: chapters.map((c) => c.title), addedAt: now
        };
        try { await saveContent(id, { id, chapters }); } catch (e) { weakSave += 1; }
        contentCache[id] = { id, chapters };
        if (r.cover) state.covers[id] = { image: r.cover };
        state.localBooks.unshift(meta);
        if (!state.shelf.includes(id)) state.shelf.unshift(id);
        state.progress[id] = { ch: 1, pct: 0, updated: now };
        lastId = id; ok += 1;
      } catch (err) {
        toast('《' + short + '》导入失败：' + (err && err.message ? err.message : '格式不支持'));
      }
    }
    importing = false;
    save();
    if (ok) {
      renderNav(ui.nav);
      toast('已导入 ' + ok + ' 卷 · 藏卷现共 ' + state.shelf.length + ' 卷' +
        (weakSave ? '（' + weakSave + ' 卷当前环境无法长期保存）' : ''));
      go('book/' + lastId);
    }
  }

  async function removeLocalBooks(ids) {
    for (const x of ids) {
      try { await deleteContent(x); } catch (e) { /* 记录可能已不存在 */ }
      delete contentCache[x];
      delete state.progress[x];
      delete state.covers[x];
      delete state.bookmarks[x];
      delete state.bookTags[x];
    }
    state.pinned = state.pinned.filter((p) => !ids.includes(p));
    state.localBooks = state.localBooks.filter((b) => !ids.includes(b.id));
    state.shelf = state.shelf.filter((x) => !ids.includes(x));
    if (ids.includes(state.lastRead)) state.lastRead = state.shelf[0] || '';
    save();
  }
  async function deleteLocalBook(id) {
    const b = getBook(id);
    if (!b || !b.local) return;
    if (!confirm('删除《' + b.title + '》？本地文件内容与读墨进度都会移除。')) return;
    await removeLocalBooks([id]);
    renderNav(ui.nav); toast('已删除《' + b.title + '》'); go('shelf');
  }

  /* 分类、榜单并入书肆页签，一级导航只留三项，书肆排第一 */
  const NAV = [
    { key: 'store', label: '书肆', icon: 'store' },
    { key: 'shelf', label: '藏卷', icon: 'shelf' },
    { key: 'me', label: '墨斋', icon: 'user' }
  ];
  /* ---------- 状态 ---------- */
  const KEY = 'mojuan.state.v1';
  const DEFAULTS = {
    /* 藏卷默认空着 —— 这是用户自己攒的书架，不该由程序塞书进来 */
    shelf: [],
    progress: {},
    lastRead: '',
    settings: { theme: 'day', fs: 19, lh: 2, paper: 'xuan', lastDayPaper: 'xuan', font: 'song', pageMode: 'flip', flipAnim: 'none', rate: 1, voiceURI: '' },
    /* 只记真实开卷记录：hist 存最近 30 天的开卷日期，streak 为连续天数。
     * 旧版这里有 coins（墨币），没有消耗场景，已去掉。 */
    checkin: { last: '', days: 0, streak: 0, hist: [] },
    history: [],
    seconds: 0,
    readLog: {},
    dailyGoal: 30,
    viewMode: 'grid',
    added: {},
    localBooks: [],
    covers: {},
    bookmarks: {},
    pinned: [],
    bookTags: {}
  };
  let state = load();
  /* 数据迁移，按版本号各跑一次。
   * v2：老版本存的是虚构书 id（b01…），换成真实书源后取不到书，清掉。
   *     只认「形如 b01 的旧 id」，不按"此刻取不到书"判断——自定义书源临时停用、
   *     在线源还没聚合完成时书会短暂取不到，那种情况抹数据是不可接受的。
   * v3：早期版本给新用户预置了四卷种子书（诗经/道德经/论语/幽梦影），
   *     用户一打开藏卷就看见自己没加过的书。现在藏卷默认空着，这里把种子撤掉；
   *     但只要他真读过、加过书签、置顶或打过标签，就说明这本是他自己的，保留。 */
  const SEED_SHELF = ['shijing', 'daodejing', 'lunyu', 'youmengying'];
  (function migrateLibrary() {
    const ver = Number(state.v) || 0;
    if (ver < 2) {
      const legacy = (id) => /^b\d+$/.test(String(id || ''));
      state.shelf = (state.shelf || []).filter((id) => !legacy(id));
      Object.keys(state.progress || {}).forEach((id) => { if (legacy(id)) delete state.progress[id]; });
      if (legacy(state.lastRead)) state.lastRead = state.shelf[0] || '';
    }
    if (ver < 3) {
      const mine = (id) => !!state.progress[id] || !!(state.bookmarks || {})[id]
        || (state.pinned || []).includes(id) || !!state.bookTags[id];
      const before = (state.shelf || []).length;
      state.shelf = (state.shelf || []).filter((id) => !SEED_SHELF.includes(id) || mine(id));
      if (state.shelf.length !== before && !state.shelf.includes(state.lastRead)) {
        state.lastRead = state.shelf[0] || '';
      }
    }
    state.v = 3;
    /* 翻页动画默认改为「无动画」：旧默认 'slide' 在单页元素上几乎看不出来，
     * 这里把存量用户也归一为 'none'，让"固定无动画"对所有人即时生效。 */
    if (state.settings && state.settings.flipAnim === 'slide') state.settings.flipAnim = 'none';
    /* 迁移结果必须立刻落盘：否则用户把种子书重新加回藏卷后，
     * 下次启动又会因为版本号没升级而被当成种子再删一遍。
     * （此处 save() 还没初始化完，直接写 localStorage） */
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* 配额满就下次再说，迁移本身幂等 */ }
  })();
  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
      return Object.assign({}, structuredClone(DEFAULTS), raw, {
        settings: Object.assign({}, DEFAULTS.settings, raw.settings || {}),
        checkin: Object.assign({}, DEFAULTS.checkin, raw.checkin || {}),
        covers: Object.assign({}, DEFAULTS.covers, raw.covers || {}),
        bookmarks: Object.assign({}, DEFAULTS.bookmarks, raw.bookmarks || {}),
        bookTags: Object.assign({}, DEFAULTS.bookTags, raw.bookTags || {}),
        pinned: Array.isArray(raw.pinned) ? raw.pinned : [],
        readLog: Object.assign({}, DEFAULTS.readLog, raw.readLog || {})
      });
    } catch (e) { return structuredClone(DEFAULTS); }
  }
  let saveWarned = false;
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); return true; }
    catch (e) {
      /* 配额写满时别不吭声：至少要告诉用户这次改动没存下 */
      if (!saveWarned) { saveWarned = true; try { toast('本地存储已满，这次的改动没能保存'); } catch (_) { /* 忽略 */ } }
      return false;
    }
  }
  /* 翻页/滚动会高频触发存档，但 state 含封面等大字段，整份 JSON.stringify 很重。
     合并成 500ms 内的最后一次落盘，避免每翻一页都卡一下主线程。
     关键时刻（关页、切后台）改调 flushSave() 立即落盘，不丢进度。 */
  let saveTimer = null;
  function scheduleSave(t) {
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; save(); }, t || 500);
  }
  function flushSave() { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } save(); }
  const ui = {
    cat: '全部', status: '全部', sortBy: 'long', rankTab: 'long', banner: 0,
    descOpen: false, nav: 'store', editMode: false, selected: new Set(), longPressed: false,
    coverDraft: null, flipHint: null, flipSwiped: false,
    catalogTab: 'catalog', flipTargetPage: null, flipDir: '',
    shelfFilter: 'all', shelfVisibleIds: [], seekDragAt: 0, metaDraft: null,
    tocLoading: false, tocFailed: false
  };
  let readerSession = null;
  let bannerTimer = null;
  let pendingScroll = 0;
  function rerender() { pendingScroll = window.scrollY; render(); }

  /* ---------- 工具 ---------- */
  function icon(n, cls) { return `<svg class="ic ${cls || ''}"><use href="#i-${n}"></use></svg>`; }
  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  /* 这一排 chip 能横向滚却没任何提示时，末尾那个会被切成半截。
     量一下有没有溢出，有就在右边缘加渐隐。 */
  function markScrollableRows(root) {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll('.chip-row').forEach((row) => {
      row.classList.toggle('is-scrollable', row.scrollWidth - row.clientWidth > 2);
    });
  }

  /* 书卡、设置项、目录项这些是用 div/li 做的按钮：鼠标点得动，键盘和读屏却进不去。
     渲染完统一补上 tabindex/role，并按需补一个读得出的名字。
     只处理"[data-action] 但本身不是原生控件"的元素，原生 button 一律不碰。 */
  const NATIVE_CTL = /^(BUTTON|A|INPUT|SELECT|TEXTAREA)$/;
  function a11ySweep(root) {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll('[data-action]').forEach((el) => {
      if (NATIVE_CTL.test(el.tagName) || el.dataset.a11y === '1') return;
      el.dataset.a11y = '1';
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
      if (!el.hasAttribute('role')) el.setAttribute('role', 'button');
      /* 书卡、设置行整块都是文字，读屏自然能读出名字；
         封面这种只有两三个字甚至没有字的可点块，合成一个完整的名字。 */
      const txt = (el.textContent || '').trim();
      if (!el.hasAttribute('aria-label') && txt.length < 12) {
        const bk = el.dataset.id ? getBook(el.dataset.id) : null;
        const nameMap = { 'open-chapter': '翻到这一章', 'catalog-goto': '翻到这一章', 'banner-dot': '切换推荐' };
        if (bk && el.dataset.action === 'open-book') el.setAttribute('aria-label', '打开《' + bk.title + '》');
        else if (!txt) el.setAttribute('aria-label', nameMap[el.dataset.action] || '操作');
      }
    });
  }
  function ymd(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function today() { return ymd(new Date()); }
  function yesterday() { return ymd(new Date(Date.now() - 86400000)); }
  let toastTimer;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 1900);
  }
  const COVER_MOTIFS = D.MOTIFS || [
    ['mountain', '远山'], ['bamboo', '青竹'], ['cloud', '云纹'], ['wave', '潮纹'],
    ['city', '楼阁'], ['star', '星轨'], ['flower', '梅枝'], ['sword', '剑气']
  ];
  const COVER_PALETTES = [
    ['#3E5C55', '#1E3733', '墨绿'], ['#3B4356', '#1B2030', '靛青'], ['#8E5B57', '#4A2E2C', '绛红'],
    ['#2F4B6E', '#16263C', '深蓝'], ['#A2703F', '#5E3E20', '赭石'], ['#5C6B48', '#303B27', '竹青'],
    ['#6C5878', '#382C43', '紫檀'], ['#375E68', '#1A333A', '青碧'], ['#8A4B32', '#4B2818', '唐红'],
    ['#61735F', '#2A352A', '苍青'], ['#8C6438', '#4A3419', '月赭'], ['#6C4C5C', '#32212B', '梦胭']
  ];
  function coverHtml(b, override) {
    const o = Object.assign({}, state.covers[b.id] || {}, override || {});
    const uid = 'c' + (++coverUid);
    const latin = !/[\u4e00-\u9fff]/.test(b.title);
    /* 竖排书名放不下就会顶出封面：六字起收字号，八字起再收一档 */
    const tlen = (b.title || '').length;
    const tcls = latin ? ' latin' : (tlen >= 8 ? ' xlong' : tlen >= 6 ? ' long' : '');
    const pic = o.image && /^data:image\/(jpeg|png|webp);base64,/.test(o.image) ? o.image : null;
    const art = pic
      ? `<div class="cover-photo" style="background-image:url('${pic}')"></div>`
      : D.motifSvg(o.motif || b.motif, o.color || b.color, o.color2 || b.color2, uid);
    const text = o.hideText ? '' : `<div class="cover-mark">墨卷藏书</div>
      <div class="cover-title${tcls}">${b.title}</div>
      <div class="cover-author">${b.author}</div>
      <div class="cover-seal">${o.seal || b.seal}</div>`;
    return `<div class="cover ${pic ? 'has-photo' : ''}">${art}<i class="cover-grain" aria-hidden="true"></i>${text}</div>`;
  }
  /* ---------- 自定义封面 ---------- */
  function compressCover(file, done) {
    if (!/^image\//.test(file.type)) { toast('请选择图片文件'); return; }
    if (file.size > 12 * 1024 * 1024) { toast('图片太大，请换一张小于 12MB 的'); return; }
    const fr = new FileReader();
    fr.onload = () => {
      const img = new Image();
      img.onload = () => {
        const W = 300, H = 435;
        const cv = document.createElement('canvas');
        cv.width = W; cv.height = H;
        const ctx = cv.getContext('2d');
        const scale = Math.max(W / img.width, H / img.height);
        const sw = W / scale, sh = H / scale;
        ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, 0, 0, W, H);
        done(cv.toDataURL('image/jpeg', 0.78));
      };
      img.onerror = () => toast('图片读取失败');
      img.src = fr.result;
    };
    fr.onerror = () => toast('图片读取失败');
    fr.readAsDataURL(file);
  }
  function openCoverEditor(id) {
    const b = getBook(id); if (!b) return;
    const s = state.covers[id] || {};
    ui.coverDraft = {
      id,
      draft: {
        motif: s.motif || b.motif, color: s.color || b.color, color2: s.color2 || b.color2,
        seal: s.seal || b.seal, image: s.image || null, hideText: !!s.hideText
      }
    };
    renderCoverEditor();
  }
  function closeCoverEditor() {
    const m = $('#coverModal'); if (m) m.remove();
    ui.coverDraft = null;
  }
  /* 本地卷：改卷名 / 作者 */
  function openMetaEditor(id) {
    const b = getBook(id); if (!b || !b.local) return;
    ui.metaDraft = id;
    let root = $('#metaModal');
    if (!root) { root = document.createElement('div'); root.id = 'metaModal'; document.body.appendChild(root); }
    root.innerHTML = `<div class="modal-backdrop" data-action="meta-close"></div>
      <div class="cover-editor mini-modal">
        <div class="ce-head"><h3>编辑卷册信息</h3>
          <button class="icon-btn" data-action="meta-close" title="关闭">${icon('close')}</button></div>
        <div class="mm-body">
          <label>卷名<input id="metaTitle" maxlength="40" value="${esc(b.title)}" autocomplete="off"></label>
          <label>作者<input id="metaAuthor" maxlength="24" value="${esc(b.author)}" autocomplete="off"></label>
          <p class="mm-hint">只改这卷在本设备上的显示名，不会改动原文件；藏卷、封面、搜索会一起更新。</p>
        </div>
        <div class="ce-foot"><div></div>
          <button class="btn btn-ghost" data-action="meta-close">取消</button>
          <button class="btn btn-primary" data-action="meta-save" data-id="${id}">保存</button>
        </div>
      </div>`;
    setTimeout(() => { const t = $('#metaTitle'); if (t) t.focus(); }, 30);
  }
  function closeMetaEditor() {
    const m = $('#metaModal'); if (m) m.remove();
    ui.metaDraft = null;
  }

  /* ---------- 书源：自定义插件 ---------- */
  const CUSTOM_SRC_KEY = 'mojuan.sources.custom';
  const SOURCE_SKELETON = `MJ.sources.register({
  id: 'my-source',
  name: '我的书源',
  desc: '一句话说明这个书源',
  online: true,
  async metas() {
    // 返回书目元数据数组，可在这里请求你自己的接口
    return [{
      id: 'my-1', title: '书名', author: '作者', category: '文集',
      desc: '简介', words: '1.0万', score: 9.0, readers: '本机',
      tags: ['自定义'], chapters: [{ no: 1, title: '全文' }]
    }];
  },
  async getChapter(id, no) {
    const text = await fetch('https://example.com/book/' + encodeURIComponent(id)).then(r => r.text());
    return text.split('\\n').map(s => s.trim()).filter(Boolean);
  }
});`;
  function customSources() {
    try { return JSON.parse(localStorage.getItem(CUSTOM_SRC_KEY) || '[]'); } catch (e) { return []; }
  }
  function saveCustomSources(list) {
    try { localStorage.setItem(CUSTOM_SRC_KEY, JSON.stringify(list)); } catch (e) { /* 忽略 */ }
  }
  /* 记住被关掉的书源，下次打开还是关着的 */
  const OFF_SRC_KEY = 'mojuan.sources.off';
  function disabledSources() {
    try { return JSON.parse(localStorage.getItem(OFF_SRC_KEY) || '[]'); } catch (e) { return []; }
  }
  function markSource(id, off) {
    const list = disabledSources().filter((x) => x !== id);
    if (off) list.push(id);
    try { localStorage.setItem(OFF_SRC_KEY, JSON.stringify(list)); } catch (e) { /* 忽略 */ }
  }
  function runSourceCode(code) {
    const fn = new Function('MJ', 'window', '"use strict";\n' + code);
    fn(window.MJ, window);
  }
  async function restoreCustomSources() {
    customSources().forEach((code) => {
      try { runSourceCode(code); } catch (e) { console.warn('[sources] 自定义书源载入失败', e); }
    });
    disabledSources().forEach((id) => { if (SRC.get(id)) SRC.setEnabled(id, false); });
    await SRC.refresh();
  }
  function openSourceEditor() {
    let root = $('#sourceModal');
    if (!root) { root = document.createElement('div'); root.id = 'sourceModal'; document.body.appendChild(root); }
    root.innerHTML = `<div class="modal-backdrop" data-action="source-close"></div>
      <div class="cover-editor mini-modal">
        <div class="ce-head"><h3>添加自定义书源</h3>
          <button class="icon-btn" data-action="source-close" title="关闭">${icon('close')}</button></div>
        <div class="mm-body">
          <label>插件代码<textarea id="sourceCode" spellcheck="false" rows="12">${esc(SOURCE_SKELETON)}</textarea></label>
          <p class="mm-hint">改好书名与你自己的接口地址即可。代码只保存在本机，不会上传；接入后书肆、搜索、藏卷、阅读器都会自动认得它。</p>
        </div>
        <div class="ce-foot"><div></div>
          <button class="btn btn-ghost" data-action="source-close">取消</button>
          <button class="btn btn-primary" data-action="source-save">启用</button>
        </div>
      </div>`;
  }
  function closeSourceEditor() { const m = $('#sourceModal'); if (m) m.remove(); }
  function renderCoverEditor() {
    const cd = ui.coverDraft; if (!cd) return;
    const b = getBook(cd.id); if (!b) return;
    const d = cd.draft;
    let root = $('#coverModal');
    if (!root) {
      root = document.createElement('div');
      root.id = 'coverModal';
      document.body.appendChild(root);
    }
    root.innerHTML = `<div class="modal-backdrop" data-action="cover-close"></div>
      <div class="cover-editor">
        <div class="ce-head"><h3>更换封面 · ${esc(b.title)}</h3>
          <button class="icon-btn" data-action="cover-close" title="关闭">${icon('close')}</button></div>
        <div class="ce-body">
          <div class="ce-preview" id="cePreview">${coverHtml(b, d)}</div>
          <div class="ce-options">
            <div class="ce-label">上传自己的图</div>
            <button class="btn btn-ghost btn-sm" data-action="cover-upload">${icon('plus', 'ic-sm')} 选择图片（JPG / PNG / WebP）</button>
            <div class="ce-hint">会按比例裁成封面并压缩，只保存在这台设备的浏览器里，不会上传。选了纹样或配色会切回水墨封面。</div>
            <div class="ce-label" style="margin-top:18px">或挑一种水墨纹样</div>
            <div class="ce-motifs">${COVER_MOTIFS.map(([k, l]) =>
              `<button class="ce-chip ${!d.image && d.motif === k ? 'active' : ''}" data-action="cover-motif" data-val="${k}">${l}</button>`).join('')}</div>
            <div class="ce-label">配色</div>
            <div class="ce-colors">${COVER_PALETTES.map(([c1, c2, l]) =>
              `<button class="ce-color ${!d.image && d.color === c1 ? 'active' : ''}" title="${l}" data-action="cover-color" data-val="${c1}" data-val2="${c2}" style="background:linear-gradient(135deg,${c1},${c2})"></button>`).join('')}</div>
            <label class="ce-check"><input type="checkbox" data-action="cover-toggle-text" ${d.hideText ? '' : 'checked'}> 封面上显示卷名与印章</label>
          </div>
        </div>
        <div class="ce-foot">
          <button class="btn btn-ghost btn-sm" data-action="cover-reset">恢复默认</button>
          <div style="flex:1"></div>
          <button class="btn btn-ghost btn-sm" data-action="cover-close">取消</button>
          <button class="btn btn-primary btn-sm" data-action="cover-save">保存封面</button>
        </div>
      </div>`;
  }
  /* ---------- 藏卷整理：批量操作面板 ---------- */
  /* 长按藏卷卡片：自己决定进详情页，还是取消 / 做点别的 */
  function closeShelfMenu() {
    const m = $('#shelfMenu'); if (m) m.remove();
  }
  function openShelfMenu(id) {
    const b = getBook(id); if (!b) return;
    let root = $('#shelfMenu');
    if (!root) { root = document.createElement('div'); root.id = 'shelfMenu'; document.body.appendChild(root); }
    const pinned = state.pinned.includes(id);
    root.innerHTML = `<div class="modal-backdrop" data-action="close-shelf-menu"></div>
      <div class="action-sheet shelf-menu-sheet">
        <div class="as-head"><b>《${esc(b.title)}》</b>
          <button class="icon-btn" data-action="close-shelf-menu" title="关闭">${icon('close')}</button></div>
        <div class="as-body">
          <button class="as-row primary" data-action="shelf-menu-detail" data-id="${id}">${icon('book', 'ic-sm')}<span>展卷细看</span>${icon('right', 'ic-sm')}</button>
          <div class="as-label">还可以</div>
          <div class="as-grid three">
            <button class="as-item" data-action="shelf-menu-pin" data-id="${id}">${icon('star', 'ic-sm')}<span>${pinned ? '取消置顶' : '置顶到最前'}</span></button>
            <button class="as-item" data-action="shelf-menu-remove" data-id="${id}">${icon('trash', 'ic-sm')}<span>移出藏卷</span></button>
            <button class="as-item" data-action="shelf-menu-manage" data-id="${id}">${icon('gridview', 'ic-sm')}<span>批量理卷</span></button>
          </div>
        </div>
        <div class="as-foot"><button class="btn btn-ghost btn-sm" data-action="close-shelf-menu">取消</button></div>
      </div>`;
  }
  function closeShelfActions() { const m = $('#shelfActions'); if (m) m.remove(); }
  function openShelfActions() {
    const ids = Array.from(ui.selected);
    if (!ids.length) { toast('先选几卷'); return; }
    const localIds = ids.filter((x) => (getBook(x) || {}).local);
    const allPinned = ids.every((x) => state.pinned.includes(x));
    let root = $('#shelfActions');
    if (!root) {
      root = document.createElement('div');
      root.id = 'shelfActions';
      document.body.appendChild(root);
    }
    root.innerHTML = `<div class="modal-backdrop" data-action="close-shelf-actions"></div>
      <div class="action-sheet">
        <div class="as-head"><b>批量操作 · 已选 ${ids.length} 卷</b>
          <button class="icon-btn" data-action="close-shelf-actions" title="关闭">${icon('close')}</button></div>
        <div class="as-body">
          <div class="as-label">藏卷</div>
          <div class="as-grid">
            <button class="as-item" data-action="bulk-pin" data-val="${allPinned ? 'unpin' : 'pin'}">${icon('star', 'ic-sm')}<span>${allPinned ? '取消置顶' : '置顶到最前'}</span></button>
            <button class="as-item" data-action="batch-remove">${icon('book', 'ic-sm')}<span>移出藏卷</span></button>
          </div>
          <div class="as-label">读墨状态</div>
          <div class="as-grid">
            ${[['want', '想读'], ['reading', '在读'], ['done', '已读'], ['', '清除标记']].map(([k, l]) =>
              `<button class="as-item" data-action="bulk-tag" data-val="${k}">${icon(k ? 'check' : 'close', 'ic-sm')}<span>${l}</span></button>`).join('')}
          </div>
          <button class="as-row" data-action="bulk-reset-progress">${icon('clock', 'ic-sm')}<span>重置这几卷的读墨进度</span>${icon('right', 'ic-sm')}</button>
          <div class="as-label">批量换封面（切回水墨风格）</div>
          <div class="ce-motifs">${COVER_MOTIFS.map(([k, l]) =>
            `<button class="ce-chip" data-action="bulk-cover-motif" data-val="${k}">${l}</button>`).join('')}</div>
          <div class="ce-colors">${COVER_PALETTES.map(([c1, c2, l]) =>
            `<button class="ce-color" title="${l}" data-action="bulk-cover-color" data-val="${c1}" data-val2="${c2}" style="background:linear-gradient(135deg,${c1},${c2})"></button>`).join('')}</div>
          <div class="as-label">导出</div>
          <div class="as-grid">
            <button class="as-item" data-action="bulk-copy-list">${icon('list', 'ic-sm')}<span>复制卷单</span></button>
            <button class="as-item" data-action="bulk-export-list">${icon('brush', 'ic-sm')}<span>下载卷单</span></button>
            <button class="as-item" data-action="bulk-export-books" ${localIds.length ? '' : 'disabled'}>${icon('book', 'ic-sm')}<span>导出正文 (${localIds.length})</span></button>
          </div>
          ${localIds.length ? `<button class="as-row danger" data-action="batch-delete">${icon('trash', 'ic-sm')}<span>彻底删除这 ${localIds.length} 卷本地卷</span>${icon('right', 'ic-sm')}</button>` : ''}
        </div>
        <div class="as-foot"><button class="btn btn-ghost btn-sm" data-action="close-shelf-actions">完成</button></div>
      </div>`;
  }
  function shelfListText(ids) {
    const lines = ['墨卷 · 卷单', '导出时间：' + new Date().toLocaleString('zh-CN'), '共 ' + ids.length + ' 卷', ''];
    ids.forEach((id, i) => {
      const b = getBook(id); if (!b) return;
      const p = state.progress[id] || {};
      const bp = bookPct(b);
      const t = state.bookTags[id] ? TAG_LABEL[state.bookTags[id]] : '';
      lines.push((i + 1) + '. 《' + b.title + '》 ' + b.author);
      lines.push('   ' + b.category + ' · ' + b.status + ' · ' + b.words +
        (bp > 0 ? ' · 已读 ' + Math.max(1, Math.round(bp * 100)) + '%（第' + (p.ch || 1) + '章）' : '') +
        (t ? ' · ' + t : '') + (state.pinned.includes(id) ? ' · 置顶' : ''));
    });
    return lines.join('\n');
  }
  function downloadText(name, text) {
    try {
      const url = URL.createObjectURL(new Blob(['\ufeff' + text], { type: 'text/plain;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
      return true;
    } catch (e) { return false; }
  }
  /* ---------- 完整备份 / 恢复（含本地卷正文） ---------- */
  const BACKUP_APP = 'mojuan', BACKUP_VER = 1;
  function collectContents() {
    return new Promise((res) => {
      const out = {};
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.indexOf(LS_PREFIX) === 0) {
            try { out[k.slice(LS_PREFIX.length)] = JSON.parse(localStorage.getItem(k)); } catch (e) { /* 跳过坏记录 */ }
          }
        }
      } catch (e) { /* 存储不可用 */ }
      openDB().then((db) => {
        const tx = db.transaction('books', 'readonly');
        const req = tx.objectStore('books').openCursor();
        req.onsuccess = (ev) => {
          const c = ev.target.result;
          if (c) { out[c.key] = c.value; c.continue(); }
        };
        tx.oncomplete = () => { try { db.close(); } catch (e) {} res(out); };
        tx.onerror = () => { try { db.close(); } catch (e) {} res(out); };
      }).catch(() => res(out));
    });
  }
  async function exportBackup() {
    toast('正在整理备份…');
    const contents = await collectContents();
    const payload = {
      app: BACKUP_APP, version: BACKUP_VER, exportedAt: new Date().toISOString(),
      state, contents
    };
    const ok = downloadText('墨卷备份-' + today() + '.json', JSON.stringify(payload));
    toast(ok
      ? '备份已导出 · 含 ' + Object.keys(contents).length + ' 卷本地卷正文'
      : '导出失败，请检查浏览器下载权限');
  }
  async function restoreBackup(text) {
    let obj;
    try { obj = JSON.parse(String(text).replace(/^\uFEFF/, '')); }
    catch (e) { toast('文件不是有效的备份 JSON'); return; }
    if (!obj || obj.app !== BACKUP_APP || !obj.state || typeof obj.state !== 'object') {
      toast('这不是墨卷备份文件'); return;
    }
    const contents = obj.contents || {};
    const n = Object.keys(contents).length;
    if (!confirm('确定从这份备份恢复吗？\n\n将覆盖当前的藏卷、进度、卷签、封面、设置，以及 ' + n + ' 卷本地卷正文。此操作不可撤销。')) return;
    try {
      localStorage.setItem(KEY, JSON.stringify(obj.state));
      try {
        const del = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.indexOf(LS_PREFIX) === 0) del.push(k);
        }
        del.forEach((k) => localStorage.removeItem(k));
      } catch (e) { /* 忽略 */ }
      let idbOK = false;
      try {
        const db = await openDB();
        await new Promise((res, rej) => {
          const tx = db.transaction('books', 'readwrite');
          const st = tx.objectStore('books');
          st.clear();
          Object.keys(contents).forEach((k) => st.put(contents[k], k));
          tx.oncomplete = () => res();
          tx.onerror = () => rej(tx.error);
        });
        try { db.close(); } catch (e) {}
        idbOK = true;
      } catch (e) { /* file:// 下 IDB 不可用，走 localStorage 降级 */ }
      if (!idbOK) {
        Object.keys(contents).forEach((k) => {
          try { localStorage.setItem(LS_PREFIX + k, JSON.stringify(contents[k])); } catch (e) { /* 容量不足忽略 */ }
        });
      }
      toast('恢复完成，正在重新载入…');
      setTimeout(() => location.reload(), 600);
    } catch (e) {
      toast('恢复失败：' + (e && e.message ? e.message : '未知错误'));
    }
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch (e) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        const ok = document.execCommand('copy'); ta.remove();
        return ok;
      } catch (e2) { return false; }
    }
  }
  async function exportLocalBooks(ids) {
    const chunks = [];
    let n = 0;
    for (const id of ids) {
      const b = getBook(id); if (!b || !b.local) continue;
      let rec = contentCache[id];
      if (!rec) { try { rec = await loadContent(id); } catch (e) { rec = null; } }
      if (!rec || !rec.chapters) continue;
      chunks.push('《' + b.title + '》 ' + b.author + '\n');
      rec.chapters.forEach((c) => {
        chunks.push('\n' + c.title + '\n');
        (c.paras || []).forEach((p) => chunks.push('　　' + p + '\n'));
      });
      chunks.push('\n\n————————————\n\n');
      n += 1;
    }
    if (!n) { toast('没有可导出的本地卷正文'); return; }
    toast(downloadText('墨卷-导出正文.txt', chunks.join('')) ? '已导出 ' + n + ' 卷正文' : '导出失败');
  }
  function bannerArt(b, i) {
    return D.motifSvg(b.motif, b.color, b.color2, 'ban' + i).replace('class="cover-art"', 'class="cover-art banner-art"');
  }
  const TAG_LABEL = { want: '想读', reading: '在读', done: '已读' };
  function miniTags(b) {
    const t = state.bookTags[b.id];
    return (state.pinned.includes(b.id) ? '<span class="mini-tag pin">置顶</span>' : '') +
      (t ? `<span class="mini-tag">${TAG_LABEL[t]}</span>` : '');
  }
  function bookCard(b, opts) {
    opts = opts || {};
    const pr = state.progress[b.id];
    const badge = opts.badge ? `<div class="cover-badge ${opts.ghost ? 'ghost' : ''}">${opts.badge}</div>` : '';
    const bp = bookPct(b);
    const prog = bp > 0 ? `<div class="book-progress">已读 ${Math.max(1, Math.round(bp * 100))}% · 第${pr.ch}章</div>` : '';
    const picked = ui.selected.has(b.id);
    const pick = opts.edit
      ? `<div class="pick-box ${picked ? 'on' : ''}" data-action="pick-book" data-id="${b.id}">${picked ? icon('check', 'ic-sm') : ''}</div>`
      : '';
    const tap = opts.edit ? 'pick-book' : (opts.shelf ? 'shelf-read' : 'open-book');
    return `<div class="book-card ${opts.edit ? 'editable' : ''} ${picked ? 'picked' : ''}" data-action="${tap}" data-id="${b.id}" ${opts.shelf ? 'data-shelf-card="1"' : ''}>
      <div style="position:relative">${coverHtml(b)}${badge}${pick}</div>
      <div class="book-name">${b.title}</div>
      <div class="book-meta"><span class="bm-text">${b.author} · ${b.category}</span>${miniTags(b)}</div>
      ${prog}
    </div>`;
  }
  function bookRow(b, i, opts) {
    opts = opts || {};
    const picked = ui.selected.has(b.id);
    const pick = opts.edit
      ? `<div class="pick-box row ${picked ? 'on' : ''}" data-action="pick-book" data-id="${b.id}">${picked ? icon('check', 'ic-sm') : ''}</div>`
      : '';
    const tap = opts.edit ? 'pick-book' : (opts.shelf ? 'shelf-read' : 'open-book');
    return `<div class="book-row ${opts.edit ? 'editable' : ''} ${picked ? 'picked' : ''}" data-action="${tap}" data-id="${b.id}" ${opts.shelf ? 'data-shelf-card="1"' : ''}>
      ${pick}
      ${opts.rank ? `<div class="rank-no ${i < 3 ? 'top' : ''}">${i + 1}</div>` : ''}
      <div style="width:62px;flex:none">${coverHtml(b)}</div>
      <div class="book-row-info">
        <h3>${b.title} <span class="muted" style="font-size:11px;font-weight:400">/ ${b.author}</span></h3>
        <p>${opts.hint ? `<b style="color:var(--cinnabar);font-weight:500">${esc(opts.hint)}</b> ` : ''}${b.desc}</p>
        <div class="row-tags"><span class="tag tag-red">${b.status}</span><span class="tag">${b.category}</span>
          <span class="tag">${b.words}</span><span class="tag">${chapNum(b)} 篇</span>${miniTags(b)}</div>
      </div>
    </div>`;
  }
  function sectionHead(title, moreText, moreAction) {
    return `<div class="section-head"><h2 class="section-title">${title}</h2>
      ${moreText ? `<button class="section-more" data-action="${moreAction}">${moreText} ${icon('right', 'ic-sm')}</button>` : ''}</div>`;
  }
  function go(path) { location.hash = '#/' + path; }
  /* 排序只用真实字段：chars（字数）、chapters.length（篇目）。
   * 旧版按 hot（由字数推算的假热度）和 score（每本都是 9.2）排，已废弃。 */
  function charNum(b) {
    if (b.chars) return b.chars;
    const w = parseFloat(b.words) || 0;
    return Math.round(w * (/万/.test(String(b.words)) ? 10000 : 1));
  }
  function chapNum(b) { return (b.chapters || []).length; }
  function sorted(arr, by) {
    const a = arr.slice();
    if (by === 'short') a.sort((x, y) => charNum(x) - charNum(y));
    else if (by === 'many') a.sort((x, y) => chapNum(y) - chapNum(x));
    else if (by === 'new') a.sort((x, y) => x.id.localeCompare(y.id) * -1);
    else a.sort((x, y) => charNum(y) - charNum(x));
    return a;
  }
  function head(title, en, desc, actionHtml) {
    return `<div class="page-head"><div><h1 class="page-title">${title}<span class="en">${en}</span></h1>
      ${desc ? `<div class="page-desc" style="margin-top:6px">${desc}</div>` : ''}</div>${actionHtml || ''}</div>`;
  }
  const importBtn = () => `<button class="btn btn-ghost btn-sm" data-action="import-books">${icon('plus', 'ic-sm')} 导入本地卷</button>`;

  /* ---------- 页面：藏卷 ---------- */
  function pageShelf() {
    const shelf = state.shelf.map(getBook).filter(Boolean);
    const lastTitle = (getBook(state.lastRead) || {}).title;
    const shelfSub = !shelf.length
      ? '还没有藏卷 · 去书肆挑一卷，或导入本地卷'
      : `共藏 ${shelf.length} 卷 · ${lastTitle ? '最近读的是《' + lastTitle + '》' : '挑一卷，从今天读起'}`;
    let html = head('藏卷', 'MY SCROLLS', shelfSub, importBtn());
    /* 空着的时候不摆筛选和整理工具：没书可筛、可整理，摆出来只会让人以为操作坏了 */
    if (!shelf.length) {
      return html + `<div class="empty">${icon('book')}<p>藏卷还空着，去书肆挑一卷，或导入本地卷</p>
        <div class="empty-actions">
          <button class="btn btn-primary" data-go="store">逛逛书肆</button>
          <button class="btn btn-ghost" data-action="import-books">${icon('plus', 'ic-sm')} 导入本地卷</button>
        </div></div>`;
    }
    const last = getBook(state.lastRead);
    const pr = state.progress[state.lastRead] || { ch: 1, pct: 0 };
    if (last && state.shelf.includes(last.id)) {
      const bp = bookPct(last);
      const begun = !!state.progress[last.id];
      const pctText = bp > 0 ? Math.max(1, Math.round(bp * 100)) : 0;
      html += `<div class="continue-card" data-action="continue-read" data-id="${last.id}">
        <div>${coverHtml(last)}</div>
        <div class="continue-info">
          <div class="muted" style="font-size:11px;letter-spacing:.16em;margin-bottom:6px">${begun ? '接 着 读' : '待 开 卷'}</div>
          <h3>${last.title}</h3>
          <div class="last">${chapterList(last)[Math.max(0, Math.min((pr.ch || 1) - 1, chapterList(last).length - 1))].title} · ${last.author}</div>
          <div class="progress-line"><i style="width:${Math.round(bp * 100)}%"></i></div>
          <div class="pct">${begun ? '已读 ' + pctText + '%　续卷' : '尚未开卷　开卷'} ${icon('right', 'ic-sm')}</div>
        </div>
      </div>`;
    }
    html += `<div class="chip-row shelf-filters">${[['all', '全部'], ['want', '想读'], ['reading', '在读'], ['done', '已读']].map(([k, l]) =>
      `<button class="chip ${ui.shelfFilter === k ? 'active' : ''}" data-action="set-shelf-filter" data-val="${k}">${l}</button>`).join('')}</div>`;
    html += `<div class="shelf-toolbar"><h2 class="section-title">架上诸卷</h2>
      <div class="shelf-tools">
        <button class="btn btn-ghost btn-sm shelf-organize" data-action="toggle-edit">${icon('settings', 'ic-sm')} <span>整理</span></button>
        <div class="view-toggle">
          <button class="${state.viewMode === 'grid' ? 'active' : ''}" data-action="toggle-view" data-val="grid" title="网格">${icon('gridview', 'ic-sm')}</button>
          <button class="${state.viewMode === 'list' ? 'active' : ''}" data-action="toggle-view" data-val="list" title="列表">${icon('listview', 'ic-sm')}</button>
        </div>
      </div></div>`;
    let order = shelf.slice().sort((a, b) => {
      const pa = state.pinned.includes(a.id) ? 1 : 0, pb = state.pinned.includes(b.id) ? 1 : 0;
      if (pa !== pb) return pb - pa;
      const ua = (state.progress[a.id] || {}).updated || 0, ub = (state.progress[b.id] || {}).updated || 0;
      return ub - ua;
    });
    if (ui.shelfFilter !== 'all') order = order.filter((b) => state.bookTags[b.id] === ui.shelfFilter);
    ui.shelfVisibleIds = order.map((b) => b.id);
    if (!order.length) {
      html += `<div class="empty">${icon('search')}<p>这个分组还空着，长按卷册可批量理卷</p>
        <button class="btn btn-ghost" data-action="set-shelf-filter" data-val="all">看全部</button></div>`;
    } else {
      html += state.viewMode === 'grid'
        ? `<div class="book-grid">${order.map((b) => bookCard(b, {
            shelf: true, edit: ui.editMode,
            badge: b.status === '连载' && (state.progress[b.id] || {}).updated ? '有更新' : ''
          })).join('')}</div>`
        : `<div class="book-list">${order.map((b, i) => bookRow(b, i, { shelf: true, edit: ui.editMode })).join('')}</div>`;
    }
    if (ui.editMode) {
      const n = ui.selected.size;
      const vis = ui.shelfVisibleIds;
      const allSel = vis.length > 0 && vis.every((x) => ui.selected.has(x));
      html += `<div class="edit-bar">
        <div class="edit-count">已选 <b>${n}</b> 卷 · 共 ${shelf.length} 卷</div>
        <div class="edit-actions">
          <button class="btn btn-ghost btn-sm" data-action="select-all">${allSel ? '取消全选' : '全选'}</button>
          <button class="btn btn-primary btn-sm" data-action="open-shelf-actions" ${n ? '' : 'disabled'}>${icon('settings', 'ic-sm')} 批量操作 (${n})</button>
          <button class="btn btn-ghost btn-sm" data-action="toggle-edit">完成</button>
        </div>
      </div>`;
    }
    return html;
  }

  /* ---------- 页面：书肆 ---------- */
  function bannerHtml() {
    const b = D.BANNERS[ui.banner];
    const bk = getBook(b.book);
    return `<div class="banner" style="background:linear-gradient(105deg,${b.color},${b.color2})">
      ${bannerArt(b, ui.banner)}
      <div style="position:absolute;inset:0;z-index:0;background:linear-gradient(90deg,rgba(12,16,14,.58) 30%,rgba(12,16,14,.08))"></div>
      <div class="banner-inner">
        <div class="banner-tag">${b.tag}</div>
        <h2>${b.title}</h2><p>${b.sub}</p>
        <button class="btn btn-primary btn-sm" data-action="open-book" data-id="${b.book}">开卷细读 ${icon('right', 'ic-sm')}</button>
      </div>
      ${bk ? `<div class="banner-cover" data-action="open-book" data-id="${bk.id}">${coverHtml(bk)}</div>` : ''}
      <div class="banner-dots" role="group" aria-label="书肆推荐切换">${D.BANNERS.map((bn, i) => `<button type="button" class="banner-dot${i === ui.banner ? ' active' : ''}" data-action="banner-dot" data-val="${i}" aria-current="${i === ui.banner ? 'true' : 'false'}" aria-label="第 ${i + 1} 卷：${esc(bn.title)}"></button>`).join('')}</div>
    </div>`;
  }
  /* 分类与榜单并入书肆，用页签切换（子路由 store/category、store/rank） */
  function storeHtml(tab) {
    const desc = {
      home: '每日一卷 · 一卷一世界',
      category: '按心绪挑一卷',
      rank: '长卷短卷，各有所宜'
    }[tab] || '每日一卷 · 一卷一世界';
    const tabs = `<div class="store-tabs">${[
      ['home', '推荐', 'scroll', ''],
      ['category', '分类', 'grid', 'category'],
      ['rank', '卷榜', 'rank', 'rank']
    ].map(([k, label, ic, path]) =>
      `<button class="store-tab ${tab === k ? 'active' : ''}" data-go="store${path ? '/' + path : ''}">${icon(ic, 'ic-sm')}<span>${label}</span></button>`).join('')}</div>`;
    return head('书肆', 'INK MARKET', desc) + tabs +
      (tab === 'category' ? pageCategory() : tab === 'rank' ? pageRank() : pageStore());
  }
  function pageStore() {
    let html = '';
    html += `<div id="bannerBox">${bannerHtml()}</div>`;
    html += `<div class="quick-cats">
      ${[['诗词', 'book'], ['典籍', 'scroll'], ['蒙学', 'brush'], ['文集', 'grid'],
        ['小说', 'novel'], ['史部', 'history']].map(([c, ic]) =>
        `<button class="quick-cat" data-action="quick-cat" data-val="${c}">${icon(ic)}<span>${c}</span></button>`).join('')}
    </div>`;
    html += `<div class="section">${sectionHead('墨客荐卷', '换荐', 'shuffle')}
      <div class="book-hscroll" id="editorPick">${sorted(allBooks(), 'many').slice(0, 8).map((b) => bookCard(b, { badge: charNum(b) >= 100000 ? '长卷' : '' })).join('')}</div></div>`;
    html += `<div class="section">${sectionHead('为你荐一卷', '换荐', 'shuffle')}
      <div class="book-hscroll" id="forYou">${sorted(allBooks().filter((b) => !state.shelf.includes(b.id)), 'long').slice(0, 7).map((b) => bookCard(b)).join('')}</div></div>`;
    const pool = allBooks();
    const daily = pool[new Date().getDate() % Math.max(1, pool.length)] || pool[0];
    const dailyInShelf = state.shelf.includes(daily.id);
    html += `<div class="section">${sectionHead('今日一卷', '', '')}
      <div class="daily-card" data-action="open-book" data-id="${daily.id}">
        <div>${coverHtml(daily)}</div>
        <div>
          <div class="muted" style="font-size:11px;letter-spacing:.16em">DAILY PICK · 今 日 展 卷</div>
          <h3>${daily.title}</h3><div class="byline">${daily.author} · ${daily.category} · ${daily.words}</div>
          <p class="desc">${daily.desc}</p>
          <div style="display:flex;align-items:center;gap:12px">
            <span class="score" style="font-size:20px">${chapNum(daily)}</span><span class="muted" style="font-size:12px">篇 · ${daily.words}</span>
            <button class="btn btn-ghost btn-sm" style="margin-left:auto" data-action="${dailyInShelf ? 'open-book' : 'add-shelf'}" data-id="${daily.id}">${icon(dailyInShelf ? 'check' : 'plus', 'ic-sm')} ${dailyInShelf ? '已在藏卷' : '收入藏卷'}</button>
          </div>
        </div>
      </div></div>`;
    html += `<div class="section">${sectionHead('卷帙长短', '看卷榜', 'go-rank')}
      <div class="rank-list">${sorted(allBooks(), 'long').slice(0, 5).map((b, i) => bookRow(b, i, { rank: true })).join('')}</div></div>`;
    html += `<div class="section">${sectionHead('诸卷总览', '', '')}
      <div class="rec-grid">${allBooks().map((b) => bookCard(b)).join('')}</div></div>`;
    return html;
  }

  /* ---------- 页面：分类 ---------- */
  function pageCategory() {
    /* 分类跟着书源里实际有的书走，不用写死 */
    const seen = [];
    allBooks().forEach((b) => { if (b.category && seen.indexOf(b.category) < 0) seen.push(b.category); });
    const cats = ['全部'].concat(seen);
    if (state.localBooks.length) cats.push('本地');
    if (cats.indexOf(ui.cat) < 0) ui.cat = '全部';
    /* 卷源筛选：公版 / 在线 / 本地 是书里真实存在的三档（原「连载、完结」对公版书没有意义） */
    const srcChips = [['全部', '全部卷源'], ['公版', '公版'], ['在线', '在线']]
      .concat(state.localBooks.length ? [['本地', '本地']] : []);
    if (!srcChips.some(([s]) => s === ui.status)) ui.status = '全部';
    let html = '';
    html += `<div class="chip-row" style="margin-bottom:14px">${cats.map((c) =>
      `<button class="chip ${ui.cat === c ? 'active' : ''}" data-action="set-cat" data-val="${c}">${c}</button>`).join('')}</div>`;
    /* 卷源与排序各自成组：原先两组挤在一个 flex 行里，
       窄屏换行后「排序」两个字会掉在卷源那行末尾，看着像卷源的一项 */
    html += `<div class="filter-bar">
      <div class="filter-group"><span class="filter-label">卷源</span>
        <div class="chip-row">${srcChips.map(([s, label]) =>
          `<button class="chip ${ui.status === s ? 'active' : ''}" data-action="set-status" data-val="${s}">${label}</button>`).join('')}</div></div>
      <div class="filter-group"><span class="filter-label">排序</span>
        <div class="chip-row">${[['long', '字数多'], ['short', '字数少'], ['many', '篇目多'], ['new', '上新']].map(([k, l]) =>
          `<button class="chip ${ui.sortBy === k ? 'active' : ''}" data-action="set-sortby" data-val="${k}">${l}</button>`).join('')}</div></div>
    </div>`;
    /* 「连载/完结」这两个状态对公版书没有意义（全部是完结），改成按卷源筛，能真的分出三档 */
    const sourceOf = (b) => (b.local ? '本地' : (b.online ? '在线' : '公版'));
    let list = allBooks().filter((b) => (ui.cat === '全部' || b.category === ui.cat) && (ui.status === '全部' || sourceOf(b) === ui.status));
    list = sorted(list, ui.sortBy);
    html += `<div class="result-head">共 ${list.length} 卷符合条件</div>`;
    html += list.length ? `<div class="book-grid">${list.map((b) => bookCard(b)).join('')}</div>`
      : `<div class="empty">${icon('search')}<p>这个格子里暂时还空着</p><button class="btn btn-ghost" data-action="set-cat" data-val="全部">看看全部</button></div>`;
    return html;
  }

  /* ---------- 页面：榜单 ---------- */
  function pageRank() {
    let html = '';
    html += `<div class="rank-tab-row">${D.RANK_TABS.map((t) =>
      `<button class="rank-tab ${ui.rankTab === t.key ? 'active' : ''}" data-action="set-ranktab" data-val="${t.key}">${t.label}</button>`).join('')}</div>`;
    html += `<div class="rank-note">按卷帙实际的字数与篇目数排列 · 无联网统计，故不设热度榜</div>`;
    const by = ui.rankTab === 'short' || ui.rankTab === 'many' ? ui.rankTab : 'long';
    const list = sorted(allBooks(), by);
    const top3 = list.slice(0, 3);
    html += `<div class="rank-top3">${top3.map((b, i) =>
      `<div><div class="rank-crown">${['榜 首', '亚 卷', '探 花'][i]}</div>${bookCard(b)}</div>`).join('')}</div>`;
    html += `<div class="book-list">${list.slice(3).map((b, i) => bookRow(b, i + 3, { rank: true })).join('')}</div>`;
    return html;
  }

  /* ---------- 页面：搜索 ---------- */
  let searchTimer = null;
  let catalogSearchTimer = null;
  function searchMatch(q) {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    /* 卷名、作者、分类、简介、标签，以及篇目名（搜「逍遥游」「关雎」也能找到所在卷） */
    return allBooks().filter((b) => {
      const hay = [b.title, b.author, b.category, b.desc, ...(b.tags || [])].join(' ').toLowerCase();
      if (hay.includes(s)) return true;
      const chs = b.chapters || [];
      for (let i = 0; i < chs.length; i++) {
        if ((chs[i].title || '').toLowerCase().includes(s)) return true;
      }
      return false;
    });
  }
  /* 命中篇目时，把那一篇的名字带出来给用户看 */
  function searchHint(q, b) {
    const s = q.trim().toLowerCase();
    if (!s) return '';
    const hit = (b.chapters || []).find((c) => (c.title || '').toLowerCase().includes(s));
    return hit && !String(b.title).toLowerCase().includes(s) ? `含「${hit.title}」` : '';
  }
  function pageSearch() {
    let html = head('寻卷', 'SEARCH', '输入卷名、墨客或篇目名，篇目也能搜到');
    html += `<div class="search-page">
      <div class="search-input-wrap">${icon('search')}
        <input id="searchInput" type="search" autocomplete="off" placeholder="试试「道德经」或「关雎」" value="">
        <button class="icon-btn" data-action="clear-query" title="清空" aria-label="清空搜索">${icon('close', 'ic-sm')}</button>
      </div>
      <div id="searchBody"></div>
    </div>`;
    return html;
  }
  function renderSearchBody(q) {
    const box = $('#searchBody'); if (!box) return;
    if (!q.trim()) {
      box.innerHTML = `<div class="search-block"><h3>${icon('clock', 'ic-sm')} 最近寻过
          <button class="link-more" style="margin-left:auto" data-action="clear-history">清空</button></h3>
        <div class="history-chips">${state.history.length ? state.history.map((h) =>
          `<button class="chip" data-action="hot-word" data-val="${esc(h)}">${esc(h)}</button>`).join('') : '<span class="muted" style="font-size:12.5px">还没有寻卷记录</span>'}</div></div>
        <div class="search-block"><h3>${icon('search', 'ic-sm')} 不妨从这里找</h3>
        <div class="hot-list">${D.HOT_SEARCH.map((h, i) =>
          `<div class="hot-item" data-action="hot-word" data-val="${esc(h)}"><i>${i + 1}</i><span>${esc(h)}</span></div>`).join('')}</div></div>
        <div class="search-block"><h3>${icon('book', 'ic-sm')} 或许你会喜欢</h3>
        <div class="book-grid">${allBooks().slice(0, 6).map((b) => bookCard(b)).join('')}</div></div>`;
      a11ySweep(box);
      return;
    }
    const list = searchMatch(q);
    box.innerHTML = `<div class="result-head">「${esc(q)}」· 找到 ${list.length} 卷</div>` +
      (list.length ? `<div class="book-list">${list.map((b, i) => bookRow(b, i, { hint: searchHint(q, b) })).join('')}</div>`
        : `<div class="empty">${icon('search')}<p>没找到这一卷，换个词试试</p></div>`);
    a11ySweep(box);
  }
  function commitSearch(q) {
    q = q.trim(); if (!q) return;
    state.history = [q, ...state.history.filter((h) => h !== q)].slice(0, 8);
    save();
  }

  /* ---------- 页面：书籍详情 ---------- */
  function pageBook(id) {
    const b = getBook(id); if (!b) return `<div class="empty">${icon('book')}<p>这一卷找不到了</p>
      <div class="empty-actions"><button class="btn btn-primary" data-go="shelf">回藏卷</button>
      <button class="btn btn-ghost" data-go="store">逛逛书肆</button></div></div>`;
    const inShelf = state.shelf.includes(b.id);
    const pr = state.progress[b.id];
    const chapters = chapterList(b);
    const bp = bookPct(b);
    let html = `<button class="btn btn-ghost btn-sm" style="margin-bottom:18px" data-action="history-back">${icon('back', 'ic-sm')} 返回</button>`;
    html += `<div class="detail-hero">
      <div class="detail-cover">${coverHtml(b)}
        <button class="btn btn-ghost btn-sm cover-edit-btn" data-action="open-cover" data-id="${b.id}">${icon('brush', 'ic-sm')} 换封面</button>
      </div>
      <div class="detail-info">
        <div class="muted" style="font-size:11px;letter-spacing:.2em">${b.category} · ${b.status}</div>
        <h1>${b.title}</h1>
        <div class="detail-byline">${b.author} · ${b.local ? '本地导入' : (b.online ? '维基文库' : '墨卷公版')}</div>
        <div class="detail-stats">
          <div class="stat"><b>${chapters.length}</b><span>篇目</span></div>
          <div class="stat"><b>${b.words}</b><span>总字数</span></div>
          <div class="stat"><b>${b.local ? (b.tags[1] || 'TXT') : (b.online ? '在线' : '公版')}</b><span>${b.local ? '文件格式' : '卷源'}</span></div>
          <div class="stat"><b>${bp > 0 ? Math.max(1, Math.round(bp * 100)) + '%' : '—'}</b><span>已读</span></div>
        </div>
        <p class="detail-desc ${ui.descOpen ? '' : 'clamp'}" id="bookDesc">${b.desc}</p>
        <button class="link-more" style="align-self:flex-start;margin-bottom:14px" data-action="toggle-desc">${ui.descOpen ? '收起' : '展开简介'} ${icon('right', 'ic-sm')}</button>
        <div class="detail-tags">${b.tags.map((t) => `<span class="tag">${t}</span>`).join('')}</div>
        <div class="detail-actions">
          <button class="btn btn-primary" data-action="start-read" data-id="${b.id}">${icon('book', 'ic-sm')} ${pr ? '续卷 · 第' + Math.min(chapters.length, pr.ch || 1) + '章' : '开卷'}</button>
          <button class="btn btn-ghost" data-action="${inShelf ? 'remove-shelf' : 'add-shelf'}" data-id="${b.id}">
            ${icon(inShelf ? 'check' : 'plus', 'ic-sm')} ${inShelf ? '已在藏卷' : '收入藏卷'}</button>
          ${b.local ? `<button class="btn btn-ghost btn-sm btn-danger" data-action="delete-local" data-id="${b.id}">${icon('trash', 'ic-sm')} 弃卷</button>` : ''}
        </div>
      </div>
    </div>`;
    html += `<div class="detail-cols">
      <div class="panel" id="tocPanel">
        <h3>目录 <button class="link-more" data-action="open-catalog" data-id="${b.id}">全部 ${chapters.length} 章 ${icon('right', 'ic-sm')}</button></h3>
        ${b.online && chapters.length <= 1
          ? (ui.tocLoading ? tocLoadingHtml()
            : (ui.tocFailed ? `<div class="toc-status">${icon('info', 'ic-sm')} 目录没取回来
                <button class="btn btn-ghost btn-sm" data-action="retry-toc" data-id="${b.id}">${icon('refresh', 'ic-sm')} 重试</button></div>`
              : `<div class="toc-status">${icon('info', 'ic-sm')} 篇目开卷时联网取回</div>`))
          : `<ul class="chapter-preview">${chapters.slice(0, 6).map((c, i) =>
          `<li data-action="open-chapter" data-id="${b.id}" data-ch="${i + 1}"><span style="color:var(--ink-2)">${c.title}</span><span>${i === 0 ? '卷首' : ''}</span></li>`).join('')}</ul>`}
      </div>
      <div class="panel">
        <h3>关于此卷</h3>
        ${b.local
          ? `<div class="review"><p>这卷由本地文件导入，正文保存在此设备的浏览器数据库中，不会上传到任何服务器。章节按文件原有标记划分，读墨进度与排版设置和内置卷一致。不想保留时可用上方「弃卷」移除。</p>
              <button class="btn btn-ghost btn-sm" data-action="edit-local" data-id="${b.id}">${icon('brush', 'ic-sm')} 编辑卷名 / 作者</button></div>`
          : b.online
          ? `<div class="review"><p>这卷来自「${esc((SRC.get(b.sourceId) || {}).name || '在线书源')}」，正文在开卷时从公共书库取回，需要联网。读到哪一章就取哪一章，不占本地空间。</p>
              <div class="row-tags" style="margin-top:8px"><span class="tag">公共书库</span><span class="tag">需联网</span></div></div>`
          : `<div class="review"><p>${esc(b.desc)}</p>
              <p class="muted" style="font-size:12px;margin-top:8px">作者${esc(b.author)}，作品已入公有领域，可自由阅读与分发。全文随墨卷离线内置，断网也能读。</p>
              <div class="row-tags" style="margin-top:8px"><span class="tag">公有领域</span><span class="tag">离线可读</span>${(b.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div></div>`}
      </div>
    </div>`;
    html += `<div class="section">${sectionHead('读过这卷的人也在读', '', '')}
      <div class="book-hscroll">${allBooks().filter((x) => x.id !== b.id && x.category === b.category).concat(allBooks().filter((x) => x.id !== b.id && x.category !== b.category)).slice(0, 8).map((x) => bookCard(x)).join('')}</div></div>`;
    return html;
  }

  function readLogHtml() {
    const goal = Math.max(1, Number(state.dailyGoal) || 30);
    const log = state.readLog || {};
    /* 一次都没读过的时候，不摆一排零高度的柱子，那看着像加载失败 */
    if (!Object.keys(log).length) {
      return `<div class="section">${sectionHead('读墨记', '', '')}
        <div class="read-log rl-empty">
          <p>还没有读墨记录。翻开任意一卷，这里会按日留下痕迹。</p>
          <button class="btn btn-ghost btn-sm" data-action="go-store">${icon('book', 'ic-sm')} 去书肆挑一卷</button>
        </div></div>`;
    }
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      days.push({ key: ymd(d), label: i === 0 ? '今' : '日一二三四五六'[d.getDay()], min: Math.round((log[ymd(d)] || 0) / 60) });
    }
    const todayMin = days[6].min;
    const max = Math.max(goal, ...days.map((d) => d.min), 1);
    return `<div class="section">${sectionHead('读墨记', '', '')}
      <div class="read-log">
        <div class="rl-top">
          <div>今日 <b>${todayMin}</b> 分钟 <span class="rl-goal">/ 目标 ${goal} 分钟 · ${todayMin >= goal ? '已达成' : '还差 ' + (goal - todayMin) + ' 分钟'}</span></div>
          <div class="rl-goal-chips">${[15, 30, 60, 90].map((g) =>
            `<button class="chip ${goal === g ? 'active' : ''}" data-action="set-goal" data-val="${g}">${g}分</button>`).join('')}</div>
        </div>
        <div class="rl-track"><i style="width:${Math.min(100, todayMin / goal * 100)}%"></i></div>
        <div class="rl-bars">${days.map((d) => `<div class="rl-col" title="${d.key} · ${d.min} 分钟">
          <div class="rl-bar-wrap"><div class="rl-bar ${d.key === today() ? 'today' : ''}" style="height:${Math.max(3, Math.min(100, d.min / max * 100))}%"></div></div>
          <span>${d.label}</span></div>`).join('')}</div>
      </div></div>`;
  }

  /* ---------- 页面：我的 ---------- */
  function pageMe() {
    /* 开卷 = 有阅读记录的书（打开过就算）；读过篇目 = 每本读过的章数累加 */
    const opened = Object.keys(state.progress || {}).length;
    const chapterCount = Object.values(state.progress || {}).reduce((a, p) =>
      a + Math.max(0, (Number(p.ch) || 1) - 1 + ((Number(p.pct) || 0) > 0 ? 1 : 0)), 0);
    const done = state.checkin.last === today();
    const streak = state.checkin.streak || 0;
    const hist = Array.isArray(state.checkin.hist) ? state.checkin.hist : [];
    let html = head('墨斋', 'MY INK STUDIO', '读墨这件小事，值得记一笔', importBtn());
    html += `<div class="profile-card">
      <div class="profile-avatar">墨</div>
      <div><div class="profile-name">墨友 · 墨客</div><div class="profile-sub">${state.checkin.days ? '已与墨卷相伴 ' + state.checkin.days + ' 天' : '今日初见，尚未开卷'}</div></div>
      <div class="profile-coin"><b>${streak || '—'}</b><span>连续开卷</span></div>
    </div>`;
    html += `<div class="stat-grid">
      <div class="stat-card"><b>${state.shelf.length}</b><span>藏书（卷）</span></div>
      <div class="stat-card"><b>${Math.round(state.seconds / 60)}</b><span>读墨（分钟）</span></div>
      <div class="stat-card"><b>${chapterCount}</b><span>读过篇目</span></div>
      <div class="stat-card"><b>${opened}</b><span>开卷（卷）</span></div>
    </div>`;
    html += readLogHtml();
    html += `<div class="section">${sectionHead('每日开卷', '', '')}
      <div class="checkin-card">
        <div class="checkin-days">${[6, 5, 4, 3, 2, 1, 0].map((i) => {
          const d = new Date(Date.now() - i * 86400000);
          const on = hist.indexOf(ymd(d)) >= 0;
          return `<div class="day-dot ${on ? 'done' : ''} ${i === 0 ? 'today' : ''}"><i>${on ? '✓' : ''}</i><span>${i === 0 ? '今' : '周' + '日一二三四五六'[d.getDay()]}</span></div>`;
        }).join('')}</div>
        <button class="btn ${done ? 'btn-ghost' : 'btn-primary'}" data-action="checkin" ${done ? 'disabled' : ''}>
          ${icon(done ? 'check' : 'brush', 'ic-sm')} ${done ? '今日已开卷' : '记一笔 · 今日开卷'}</button>
      </div></div>`;
    html += `<div class="section">${sectionHead('读墨设置', '', '')}
      <div class="setting-list">
        <div class="setting-row">${icon('moon')}<div class="st">夜墨模式<small>护眼深色，适合夜里展卷</small></div>
          <button class="switch ${state.settings.theme === 'night' ? 'on' : ''}" data-action="toggle-theme" aria-label="夜墨模式"></button></div>
        <div class="setting-row">${icon('settings')}<div class="st">正文字号<small>当前 ${state.settings.fs}px · 在读墨器里也能调</small></div>
          <div style="display:flex;gap:8px"><button class="btn btn-ghost btn-sm" data-action="set-font" data-val="-">A-</button>
          <button class="btn btn-ghost btn-sm" data-action="set-font" data-val="+">A+</button></div></div>
        <div class="setting-row">${icon('brush')}<div class="st">正文字体<small>当前 ${FONT_NAMES[state.settings.font] || '宋体'} · 在读墨器里也能调</small></div>
          <div class="rs-pills">${Object.keys(FONT_NAMES).map((k) =>
            `<button class="rs-pill ${state.settings.font === k ? 'active' : ''}" data-action="set-fontfamily" data-val="${k}" style="padding:5px 8px;font-size:11.5px">${FONT_NAMES[k]}</button>`).join('')}</div></div>
        <div class="setting-row">${icon('book')}<div class="st">读墨方式<small>左右翻页 / 上下滚动，读墨器里也能改</small></div>
          <div class="rs-pills">${[['flip', '翻页'], ['scroll', '滚动']].map(([k, l]) =>
            `<button class="rs-pill ${state.settings.pageMode === k ? 'active' : ''}" data-action="set-pagemode" data-val="${k}" style="padding:5px 9px;font-size:11.5px">${l}</button>`).join('')}</div></div>
        <div class="setting-row">${icon('brush')}<div class="st">默认纸张<small>宣纸 / 青竹 / 羊皮 / 夜墨</small></div>
          <div class="rs-pills">${[['xuan', '宣纸'], ['bamboo', '青竹'], ['sheep', '羊皮'], ['night', '夜墨']].map(([k, l]) =>
            `<button class="rs-pill ${state.settings.paper === k ? 'active' : ''}" data-action="set-paper" data-val="${k}" style="padding:5px 9px;font-size:11.5px">${l}</button>`).join('')}</div></div>
        <div class="setting-row rate-standalone">${rateSliderHtml(state.settings.rate, '朗读语速 · 按住圆点拖动，最高 3 倍速')}</div>
        <div class="setting-row">${icon('book')}<div class="st">离线读墨<small>已缓存全部内置卷目，断网也能读</small></div>
          <span class="tag tag-red">已开启</span></div>
      </div></div>`;
    if (state.localBooks.length) {
      html += `<div class="section" id="localList">${sectionHead('本地卷册 · ' + state.localBooks.length, '', '')}
        <div class="setting-list">
          ${state.localBooks.map((b) => `<div class="setting-row">
            <div class="local-thumb" style="background:${b.color}">${b.seal}</div>
            <div class="st" style="cursor:pointer" data-action="open-book" data-id="${b.id}">《${b.title}》<small>${b.chapters.length} 章 · ${b.words} · ${b.author}</small></div>
            <button class="btn btn-ghost btn-sm btn-danger" data-action="delete-local" data-id="${b.id}">删除</button>
          </div>`).join('')}
        </div>
        <div class="muted" style="font-size:11.5px;margin-top:10px;line-height:1.8">正文保存在本设备的浏览器数据库中，不会上传；换设备或清理浏览器数据会丢失，请保留原文件。</div>
      </div>`;
    }
    const bmAll = [];
    Object.keys(state.bookmarks || {}).forEach((bid) => {
      (state.bookmarks[bid] || []).forEach((m, i) => bmAll.push({ bid, m, i }));
    });
    if (bmAll.length) {
      html += `<div class="section">${sectionHead('我的卷签 · ' + bmAll.length, '', '')}
        <div class="setting-list">
          ${bmAll.map(({ bid, m, i }) => `<div class="setting-row">
            <div class="st" style="cursor:pointer" data-action="open-bookmark" data-id="${bid}" data-ch="${m.ch}" data-val="${i}">《${esc((getBook(bid) || {}).title || '已删除的卷')}》<small>${esc(m.title)} · 第 ${m.ch} 章${m.page ? ' · 第 ' + (m.page + 1) + ' 页' : ''}</small></div>
            <button class="btn btn-ghost btn-sm btn-danger" data-action="bookmark-del-global" data-id="${bid}" data-val="${i}">删除</button>
          </div>`).join('')}
        </div></div>`;
    }
    html += `<div class="section">${sectionHead('卷档管理', '', '')}
      <div class="setting-list">
        <div class="setting-row" data-action="export-backup">${icon('clock')}<div class="st">导出完整备份<small>藏卷、进度、卷签、封面、设置与本地卷正文，存成一个 JSON 文件</small></div>${icon('right', 'ic-sm')}</div>
        <div class="setting-row" data-action="import-backup">${icon('book')}<div class="st">从备份恢复<small>选择之前导出的 .json，会覆盖当前所有数据</small></div>${icon('right', 'ic-sm')}</div>
      </div></div>`;
    html += `<div class="section">${sectionHead('书源', '', '')}
      <div class="setting-list">
        ${SRC.list().map((s) => {
          const n = SRC.allBooks().filter((b) => b.sourceId === s.id).length;
          return `<div class="setting-row">
            ${icon(s.online ? 'store' : 'book')}
            <div class="st">${esc(s.name)}<small>${esc(s.desc)} · 现有 ${n} 卷${s.online ? ' · 需联网' : ' · 离线可读'}</small></div>
            <button class="switch ${s.enabled === false ? '' : 'on'}" data-action="toggle-source" data-id="${esc(s.id)}" aria-label="${esc(s.name)}"></button>
          </div>`;
        }).join('')}
        <div class="setting-row" data-action="add-source">${icon('plus')}<div class="st">添加自定义书源<small>粘贴一段 JS 插件即可接入别的书库，无需改动主程序</small></div>${icon('right', 'ic-sm')}</div>
      </div></div>`;
    html += `<div class="section">${sectionHead('其他', '', '')}
      <div class="setting-list">
        <div class="setting-row" data-action="import-books">${icon('plus')}<div class="st">导入本地卷<small>TXT / EPUB / MD，支持多选</small></div>${icon('right', 'ic-sm')}</div>
        ${state.localBooks.length ? `<div class="setting-row" data-action="go-local-list">${icon('trash')}<div class="st">整理 / 删除已导入的卷<small>已导入 ${state.localBooks.length} 本，可单本删除；藏卷里长按卷册可批量理卷</small></div>${icon('right', 'ic-sm')}</div>` : ''}
        <div class="setting-row" data-action="go-shelf">${icon('shelf')}<div class="st">管理我的藏卷</div>${icon('right', 'ic-sm')}</div>
        <div class="setting-row" data-action="reset-data">${icon('trash')}<div class="st">清空本地读墨数据<small>藏卷、进度与设置将恢复初始状态</small></div>${icon('right', 'ic-sm')}</div>
      </div></div>`;
    html += `<div class="about-line">墨卷 MO JUAN · 一卷在手，人间可读<br>公版典藏 · 全文离线内置 · 书源可扩展</div>`;
    return html;
  }

  /* ---------- 阅读器 ---------- */
  /* 正文取不到时，书源返回的是一句提示而不是真章节。
     认出来单独渲染成「取不到 + 重试」，别让人对着括号里的一行字读。 */
  const READER_ERR_RE = /^（?(需要联网|这一章暂未取到|这一章暂无|这卷没有|本章内容未能读取)/;
  function chapterErrMsg(b, ch) {
    const ps = paragraphs(b, ch - 1);
    if (ps.length !== 1) return '';
    const t = ps[0];
    return READER_ERR_RE.test(t) ? t.replace(/^（/, '').replace(/）$/, '') : '';
  }
  function readerHtml(b, ch) {
    const chapters = chapterList(b);
    const cur = chapters[ch - 1];
    const paras = paragraphs(b, ch - 1);
    const notes = chapterNotes(b, ch - 1);
    const pr = state.progress[b.id] || { ch: 1, pct: 0 };
    const pct = pr.ch === ch ? pr.pct : 0;
    const errMsg = chapterErrMsg(b, ch);
    /* 只有一句提示时分页没有意义，直接走滚动布局 */
    const flip = state.settings.pageMode === 'flip' && !errMsg;
    const errBlock = `<div class="reader-error">
            ${icon('info', 'ic-lg')}
            <p>${esc(errMsg)}</p>
            <button class="btn btn-primary btn-sm" data-action="reader-retry">${icon('refresh', 'ic-sm')} 重新取回</button>
            <p class="re-hint">${b.online ? '内置的' + allBooks().filter((x) => !x.online).length + '卷公版书随墨卷离线保存，断网也能读。' : ''}</p>
          </div>`;
    const bodyInner = flip
      ? `<div class="reader-paper flip-paper" id="readerPaper">
          <div class="flip-page" id="flipPage"><div class="reader-loading">正 在 分 页 …</div></div>
          <div class="flip-foot" id="flipFoot">—</div>
        </div>`
      : `<div class="reader-paper" id="readerPaper">
          <div class="reader-chapter-no">${esc(b.title)} · ${esc(b.author)}</div>
          <h1>${esc(cur.title)}</h1>
          ${errMsg ? errBlock : paras.map((p) => `<p class="${p.indexOf('（本章完') === 0 ? 'end-note' : ''}">${esc(p)}</p>`).join('')}
          ${notes.length && !errMsg ? `<button class="ch-notes-entry" data-action="open-notes">${icon('list', 'ic-sm')} 注释 · ${notes.length} 条</button>` : ''}
          <div class="reader-chapter-nav">
            <button data-action="reader-prev" ${ch <= 1 ? 'disabled' : ''}>${icon('left', 'ic-sm')} 上一章</button>
            <button data-action="reader-catalog">目录</button>
            <button data-action="reader-next" ${ch >= chapters.length ? 'disabled' : ''}>下一章 ${icon('right', 'ic-sm')}</button>
          </div>
        </div>`;
    const inShelf = state.shelf.includes(b.id);
    const night = state.settings.paper === 'night';
    /* 进度条单独一行：上一章 / 可拖动滑块 / 下一章；菜单栏在进度条下面，和番茄一致 */
    const bottom = `<div class="rb-seek">
        <div class="rb-seek-row">
          <button class="rb-step" data-action="reader-step" data-val="-1" title="上一章">上一章</button>
          <div class="rb-track" id="rbTrack" role="slider" tabindex="0" aria-label="全卷读墨进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
            <div class="rb-rail"><i id="rbBar"></i></div>
            <span class="rb-thumb" id="rbThumb"></span>
            <span class="rb-bubble" id="rbBubble" hidden></span>
          </div>
          <button class="rb-step" data-action="reader-step" data-val="1" title="下一章">下一章</button>
        </div>
        <div class="rb-info" id="rbLabel">—</div>
      </div>
      <div class="rb-menu" id="rbMenu">
        <button class="rb-mbtn" data-action="reader-catalog" title="目录与卷签">${icon('list')}<span>目录</span></button>
        <button class="rb-mbtn ${inShelf ? 'is-on' : ''}" data-action="reader-shelf-toggle" id="shelfBtn" data-on="${inShelf}" title="加入 / 移出藏卷">${icon(inShelf ? 'check' : 'plus')}<span>${inShelf ? '已在藏卷' : '收入藏卷'}</span></button>
        <button class="rb-mbtn" data-action="toggle-bookmark" id="bmBtn" title="添加 / 移除卷签">${icon('star')}<span>珍藏</span></button>
        <button class="rb-mbtn" data-action="toggle-tts" id="ttsBtn" title="打开听卷界面">${icon('volume')}<span>听卷</span></button>
        <button class="rb-mbtn" data-action="reader-theme-toggle" id="themeBtn" data-on="${night}" title="切换夜墨 / 日光">${icon(night ? 'sun' : 'moon')}<span>${night ? '日间' : '夜间'}</span></button>
        <button class="rb-mbtn" data-action="reader-settings" title="字号与纸张">${icon('settings')}<span>设置</span></button>
      </div>`;
    return `<div class="reader mode-${flip ? 'flip' : 'scroll'}" id="reader" data-paper="${state.settings.paper}">
      <div class="reader-top" id="readerTop">
        <button class="icon-btn" data-action="reader-back" title="返回">${icon('back')}</button>
        <div class="rt-title">${esc(b.title)}</div>
        <div class="rt-chapter">${esc(cur.title)}</div>
      </div>
      <div class="reader-body" id="readerBody">${bodyInner}</div>
      <div class="reader-bottom" id="readerBottom">${bottom}</div>
      <div class="reader-mask" id="readerMask" hidden></div>
      <div id="readerPanel" hidden></div>
      <div class="catalog-drawer" id="catalogDrawer" hidden></div>
    </div>`;
  }
  function applyReaderStyle() {
    const r = $('#reader'); if (!r) return;
    const paper = r.querySelector('#readerPaper');
    paper.style.setProperty('--fs', state.settings.fs + 'px');
    paper.style.setProperty('--lh', state.settings.lh);
    paper.style.setProperty('--ff', FONT_STACKS[state.settings.font] || FONT_STACKS.song);
    r.dataset.paper = state.settings.paper;
  }
  /* ---------- 左右翻页：按当前窗口与字号把整章切成页 ---------- */
  let flipState = { pages: [], page: 0, id: null, ch: 0 };
  function flipItems(b, ch) {
    const arr = [
      { text: b.title + ' · ' + b.author, type: 'no' },
      { text: chapterList(b)[ch - 1].title, type: 'h1' }
    ];
    paragraphs(b, ch - 1).forEach((t) => arr.push({ text: t, type: t.indexOf('（本章完') === 0 ? 'end' : 'p' }));
    /* 校勘记单独占末尾一行入口，点开在面板里看：翻页模式下没法就地展开，
       硬塞在正文里又会挤掉一整页的字 */
    const notes = chapterNotes(b, ch - 1);
    if (notes.length) arr.push({ text: '注释 · ' + notes.length + ' 条', type: 'notes' });
    return arr;
  }
  function paginate(items, W, H) {
    const m = document.createElement('div');
    m.className = 'reader-paper flip-measure';
    m.style.width = W + 'px';
    m.style.setProperty('--fs', state.settings.fs + 'px');
    m.style.setProperty('--lh', state.settings.lh);
    m.style.setProperty('--ff', FONT_STACKS[state.settings.font] || FONT_STACKS.song);
    document.body.appendChild(m);
    const nProbe = document.createElement('div'); nProbe.className = 'reader-chapter-no';
    const hProbe = document.createElement('h1');
    const pProbe = document.createElement('p');
    m.appendChild(nProbe); m.appendChild(hProbe); m.appendChild(pProbe);
    /* 同一次分页里每种类型的 marginBottom 固定不变，预先算好缓存，
       避免在几百段正文里反复 getComputedStyle 触发强制样式重算 */
    const mMargin = {};
    /* 每种类型用同一个探针量高度，class 必须和真正渲染时一致，否则行高对不上 */
    const clsOf = (type) => (type === 'end' ? 'end-note' : type === 'no' ? 'reader-chapter-no' : type === 'notes' ? 'ch-notes-entry' : '');
    function marginOf(type) {
      if (!(type in mMargin)) {
        const el = type === 'h1' ? hProbe : type === 'no' ? nProbe : pProbe;
        el.className = clsOf(type);
        mMargin[type] = parseFloat(getComputedStyle(el).marginBottom) || 0;
      }
      return mMargin[type];
    }
    function measure(type, text, indent) {
      const el = type === 'h1' ? hProbe : type === 'no' ? nProbe : pProbe;
      el.textContent = text;
      if (type === 'p' || type === 'end' || type === 'notes') {
        el.style.textIndent = indent ? '2em' : '0';
        el.className = clsOf(type);
      }
      return el.offsetHeight + marginOf(type);
    }
    const pages = [];
    let cur = [], used = 0;
    const flush = () => { if (cur.length) { pages.push(cur); cur = []; used = 0; } };
    for (const it of items) {
      let rest = it.text, first = true;
      const h = measure(it.type, rest, it.type === 'p');
      if (h <= H - used) {
        cur.push({ text: rest, type: it.type, indent: it.type === 'p' });
        used += h;
        continue;
      }
      if (h <= H) {
        flush();
        cur.push({ text: rest, type: it.type, indent: it.type === 'p' });
        used = h;
        continue;
      }
      /* 注释入口就一行：实在放不下就整行挪到下一页，别按字数腰斩 */
      if (it.type !== 'p' && it.type !== 'end') {
        flush();
        cur.push({ text: rest, type: it.type, indent: false });
        used = h;
        continue;
      }
      /* 单段比一页还长：二分找能放下的最大字数 */
      while (rest.length) {
        const avail = H - used;
        if (avail < 30) { flush(); continue; }
        let lo = 1, hi = rest.length, best = 0;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (measure('p', rest.slice(0, mid), first) <= avail) { best = mid; lo = mid + 1; }
          else hi = mid - 1;
        }
        if (!best) best = Math.min(rest.length, 20);
        const chunk = rest.slice(0, best);
        cur.push({ text: chunk, type: 'p', indent: first });
        used += measure('p', chunk, first);
        rest = rest.slice(best);
        first = false;
        if (rest.length) flush();
      }
    }
    flush();
    m.remove();
    return pages.length ? pages : [[{ text: '（本章暂无内容）', type: 'p', indent: false }]];
  }
  function renderFlipPage(dir) {
    const fp = $('#flipPage'); if (!fp || !flipState.pages.length) return;
    fp.className = 'flip-page';
    fp.innerHTML = flipState.pages[flipState.page].map((it) => {
      if (it.type === 'no') return `<div class="reader-chapter-no">${esc(it.text)}</div>`;
      if (it.type === 'h1') return `<h1>${esc(it.text)}</h1>`;
      if (it.type === 'notes') return `<button class="ch-notes-entry" data-action="open-notes">${icon('list', 'ic-sm')} ${esc(it.text)}</button>`;
      return `<p class="${it.type === 'end' ? 'end-note' : ''}" style="${it.indent ? '' : 'text-indent:0'}">${esc(it.text)}</p>`;
    }).join('');
    void fp.offsetWidth;
    if (dir && state.settings.flipAnim !== 'none') fp.classList.add('anim-' + state.settings.flipAnim + '-' + dir);
    const foot = $('#flipFoot');
    if (foot) foot.innerHTML = `第 ${flipState.ch} 章 · <b>${flipState.page + 1}</b> / ${flipState.pages.length} 页`;
    const pct = flipState.pages.length > 1 ? flipState.page / (flipState.pages.length - 1) : 0;
    state.progress[flipState.id] = { ch: flipState.ch, pct, updated: Date.now() };
    state.lastRead = flipState.id;
    scheduleSave();
    updateReaderSeek();
    syncBookmarkBtn();
  }
  function flipBy(delta) {
    const fs = flipState;
    if (!fs.pages.length) return;
    const np = fs.page + delta;
    const totalCh = chapterList(getBook(fs.id)).length;
    if (np < 0) {
      if (fs.ch > 1) { ui.flipHint = 'last'; ui.flipDir = 'prev'; switchChapter(fs.id, fs.ch - 1); }
      else toast('已经是第一页了');
      return;
    }
    if (np >= fs.pages.length) {
      if (fs.ch < totalCh) { ui.flipDir = 'next'; switchChapter(fs.id, fs.ch + 1); }
      else toast('已经是最后一页了');
      return;
    }
    fs.page = np;
    renderFlipPage(delta > 0 ? 'next' : 'prev');
  }
  /* ---------- 阅读进度条：全书比例、可拖动、跨章跳转 ---------- */
  function clamp01(x) { return Math.max(0, Math.min(1, x)); }
  function readerOverall() {
    const id = readerRoot.dataset.currentBook; if (!id) return 0;
    const b = getBook(id); if (!b) return 0;
    const total = Math.max(1, chapterList(b).length);
    const ch = Math.max(1, Number(readerRoot.dataset.currentCh) || 1);
    let inner = 0;
    if (state.settings.pageMode === 'flip' && flipState.id === id && flipState.ch === ch && flipState.pages.length > 1)
      inner = flipState.page / (flipState.pages.length - 1);
    else inner = (state.progress[id] || {}).pct || 0;
    return clamp01((ch - 1 + clamp01(inner)) / total);
  }
  function ratioToChapter(ratio, total) {
    const pos = clamp01(ratio) * total;
    const ch = Math.min(total, Math.floor(pos) + 1);
    let inner = pos - (ch - 1);
    if (ratio >= 1) inner = 1;
    return { ch, inner: clamp01(inner) };
  }
  function syncReaderMenu() {
    const id = readerRoot.dataset.currentBook; if (!id) return;
    const inShelf = state.shelf.includes(id);
    const sb = $('#shelfBtn');
    if (sb && sb.dataset.on !== String(inShelf)) {
      sb.dataset.on = String(inShelf);
      sb.classList.toggle('is-on', inShelf);
      sb.innerHTML = icon(inShelf ? 'check' : 'plus') + `<span>${inShelf ? '已在藏卷' : '收入藏卷'}</span>`;
    }
    const night = state.settings.paper === 'night';
    const tb = $('#themeBtn');
    if (tb && tb.dataset.on !== String(night)) {
      tb.dataset.on = String(night);
      tb.innerHTML = icon(night ? 'sun' : 'moon') + `<span>${night ? '日间' : '夜间'}</span>`;
    }
  }
  function updateReaderSeek() {
    const id = readerRoot.dataset.currentBook; if (!id) return;
    const b = getBook(id); if (!b) return;
    const total = chapterList(b).length;
    const ch = Math.max(1, Number(readerRoot.dataset.currentCh) || 1);
    const pct = readerOverall();
    const bar = $('#rbBar'), thumb = $('#rbThumb'), label = $('#rbLabel'), track = $('#rbTrack');
    if (bar) bar.style.width = (pct * 100) + '%';
    if (thumb) thumb.style.left = (pct * 100) + '%';
    if (track) track.setAttribute('aria-valuenow', Math.round(pct * 100));
    if (label) label.innerHTML = `第 ${ch} / ${total} 章 · ${esc((chapterList(b)[ch - 1] || {}).title || '')} <b>${Math.round(pct * 100)}%</b>`;
    syncReaderMenu();
  }
  function previewSeek(ratio) {
    const b = getBook(readerRoot.dataset.currentBook); if (!b) return;
    const total = chapterList(b).length;
    const { ch } = ratioToChapter(ratio, total);
    const bar = $('#rbBar'), thumb = $('#rbThumb'), bubble = $('#rbBubble'), label = $('#rbLabel');
    if (bar) bar.style.width = (ratio * 100) + '%';
    if (thumb) thumb.style.left = (ratio * 100) + '%';
    if (bubble) {
      bubble.textContent = `第 ${ch} 章 · ${Math.round(ratio * 100)}%`;
      bubble.style.left = (ratio * 100) + '%';
      bubble.hidden = false;
    }
    if (label) label.innerHTML = `松手跳至 · 第 ${ch} / ${total} 章 <b>${Math.round(ratio * 100)}%</b>`;
  }
  function seekToRatio(ratio) {
    const id = readerRoot.dataset.currentBook; if (!id) return;
    const b = getBook(id); if (!b) return;
    const total = chapterList(b).length;
    const { ch, inner } = ratioToChapter(ratio, total);
    const cur = Math.max(1, Number(readerRoot.dataset.currentCh) || 1);
    if (ch !== cur) { switchChapter(id, ch, inner); return; }
    if (state.settings.pageMode === 'flip' && flipState.pages.length) {
      flipState.page = Math.min(flipState.pages.length - 1, Math.round(inner * (flipState.pages.length - 1)));
      renderFlipPage('next');
    } else {
      const bd = $('#readerBody');
      if (bd) bd.scrollTop = inner * (bd.scrollHeight - bd.clientHeight);
    }
    updateReaderSeek();
  }
  let seekDrag = null;
  document.addEventListener('pointerdown', (e) => {
    const track = e.target.closest && e.target.closest('#rbTrack');
    if (!track || e.button > 0) return;
    e.preventDefault();
    const rect = track.getBoundingClientRect();
    seekDrag = { rect, ratio: clamp01((e.clientX - rect.left) / rect.width) };
    ui.seekDragAt = Date.now();
    track.classList.add('dragging');
    try { track.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    previewSeek(seekDrag.ratio);
  });
  document.addEventListener('pointermove', (e) => {
    if (!seekDrag) return;
    seekDrag.ratio = clamp01((e.clientX - seekDrag.rect.left) / seekDrag.rect.width);
    previewSeek(seekDrag.ratio);
  });
  function finishSeek(cancel) {
    if (!seekDrag) return;
    const d = seekDrag; seekDrag = null;
    ui.seekDragAt = Date.now();
    const track = $('#rbTrack');
    if (track) track.classList.remove('dragging');
    const bubble = $('#rbBubble'); if (bubble) bubble.hidden = true;
    if (cancel) updateReaderSeek();
    else { seekToRatio(d.ratio); setTimeout(updateReaderSeek, 80); }
  }
  document.addEventListener('pointerup', () => finishSeek(false));
  document.addEventListener('pointercancel', () => finishSeek(true));
  document.addEventListener('keydown', (e) => {
    if (document.activeElement && document.activeElement.id === 'rbTrack' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault(); e.stopImmediatePropagation();
      seekToRatio(clamp01(readerOverall() + (e.key === 'ArrowRight' ? 0.02 : -0.02)));
    }
  });

  /* ---------- 卷签 ---------- */
  function bookmarkList(id) { return state.bookmarks[id] || []; }
  function bookKey() {
    return {
      id: readerRoot.dataset.currentBook,
      ch: Number(readerRoot.dataset.currentCh) || 1,
      page: state.settings.pageMode === 'flip' ? flipState.page : 0
    };
  }
  function currentBookmark() {
    const k = bookKey();
    return bookmarkList(k.id).find((m) => m.ch === k.ch && (m.page || 0) === k.page);
  }
  function syncBookmarkBtn() {
    const el = $('#bmBtn'); if (el) el.classList.toggle('bm-on', !!currentBookmark());
  }
  function toggleBookmark() {
    const k = bookKey(); if (!k.id) return;
    const list = bookmarkList(k.id).slice();
    const idx = list.findIndex((m) => m.ch === k.ch && (m.page || 0) === k.page);
    if (idx >= 0) { list.splice(idx, 1); toast('已移除卷签'); }
    else {
      const b = getBook(k.id);
      list.unshift({
        ch: k.ch, page: k.page, pct: (state.progress[k.id] || {}).pct || 0,
        title: chapterList(b)[k.ch - 1].title, time: Date.now()
      });
      toast('已添加卷签');
    }
    state.bookmarks[k.id] = list; save(); syncBookmarkBtn();
    const drawer = $('#catalogDrawer');
    if (drawer && !drawer.hidden) openPanel(ui.catalogTab);
  }

  /* ---------- 朗读语速：可拖动滑杆 0.5× ~ 3× ---------- */
  const RATE_MIN = 0.5, RATE_MAX = 3;
  function clampRate(v) {
    const n = Number(v);
    return isNaN(n) ? 1 : Math.min(RATE_MAX, Math.max(RATE_MIN, Math.round(n * 20) / 20));
  }
  function fmtRate(v) { return String(Math.round(Number(v) * 100) / 100); }
  function ratePct(v) { return ((clampRate(v) - RATE_MIN) / (RATE_MAX - RATE_MIN) * 100).toFixed(2) + '%'; }
  function rateSliderHtml(cur, label) {
    const v = clampRate(cur);
    return `<div class="rate-box" data-rate-box>
      <div class="rate-top"><span>${label || '按住圆点拖动'}</span><b class="rate-val">${fmtRate(v)}×</b></div>
      <input class="rate-range" type="range" min="${RATE_MIN}" max="${RATE_MAX}" step="0.05"
        value="${v}" style="--rate-pct:${ratePct(v)}" data-rate-slider aria-label="朗读语速">
      <div class="rate-scale"><span>0.5×</span><span>1×</span><span>2×</span><span>3×</span></div>
      <div class="rate-presets">${[0.75, 1, 1.5, 2, 3].map((r) =>
        `<button class="rate-preset ${Math.abs(v - r) < 0.001 ? 'active' : ''}" data-action="set-rate" data-val="${r}">${r}×</button>`).join('')}</div>
    </div>`;
  }
  function fillRateTrack(inp) { inp.style.setProperty('--rate-pct', ratePct(inp.value)); }
  function syncRateUI(r) {
    r = clampRate(r);
    $$('[data-rate-slider]').forEach((inp) => { inp.value = r; fillRateTrack(inp); });
    $$('[data-rate-box]').forEach((box) => {
      const v = box.querySelector('.rate-val'); if (v) v.textContent = fmtRate(r) + '×';
      box.querySelectorAll('.rate-preset').forEach((b) => b.classList.toggle('active', Math.abs(Number(b.dataset.val) - r) < 0.001));
    });
    const t = $('#ltRate'); if (t) t.textContent = '语速 ' + fmtRate(r) + '×';
  }
  function applyRate(v) {
    const r = clampRate(v);
    state.settings.rate = r; save();
    listen.rate = r;
    syncRateUI(r);
    if (listen.active) {
      if (listen.playing) listenSpeak(true);
      listenRenderDynamic();
    }
  }

  /* ---------- 听卷：句子级朗读（走浏览器内置语音） ----------
   * 之前是整章一次性丢给 speechSynthesis：长文本会被 Chromium 静默截断，
   * 暂停要等整段合成完，进度条也只能靠 boundary 估算。
   * 现在按句排队：一句一合成，句间自然衔接，暂停/换语速立刻生效，
   * 顺带能记住「听到第几句」，下次接着听。 */
  let listen = {
    active: false, expanded: true, playing: false,
    bookId: null, ch: 1, paras: [], text: '',
    sents: [], sentIndex: 0,
    charIndex: 0, paraIndex: 0,
    rate: 1, voiceURI: '', timerMin: 0, timerAt: 0,
    elapsed: 0, startedAt: 0, lastStart: 0, boundaryOK: false,
    remoteOff: false,
    prevOverflow: ''
  };
  let ttsGen = 0, listenTimer = null, listenTick = null, keepAudio = null, lastCommit = 0;
  /* 在线音色：合成的音频、正在播的 <audio>、失败回退标记 */
  let remoteAudio = null, remoteUrl = null, remoteWarned = false;
  const audioCache = new Map();
  const VOICE = () => (window.MJ && window.MJ.voice) || null;
  const SILENT_WAV = 'data:audio/wav;base64,UklGRmQGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YUAGAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA';

  const speechOK = () => 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;

  /* 系统语音按可用性排序：带 Natural/Neural 的在线音色最好，
     SAPI 那批（Huihui/Kangkang/Yaoyao）是拼接式的，念白话还行、念文言很硬。 */
  function voiceTier(v) {
    const n = (v.name || '').toLowerCase();
    if (/natural|neural|online|premium|enhanced|google|siri/.test(n)) return 0;
    if (/huihui|kangkang|yaoyao|sapi|espeak|compact|pico/.test(n)) return 2;
    /* Windows 上凡是「Microsoft xxx - Language (Country)」又不带 Natural/Online 的，都是老式 SAPI 拼接音
       （David / Mark / Zira / Huihui / Kangkang / Yaoyao 全在此列）。名字里没有 sapi 字样，只能靠这个特征认。 */
    if (/^microsoft/.test(n) && / - /.test(n)) return 2;
    return 1;
  }
  function voiceTag(v) {
    const t = voiceTier(v);
    if (t === 0) return '<small>自然语音</small>';
    if (t === 2) return '<small>机械音</small>';
    return '';
  }
  function listenVoices() {
    if (!speechOK()) return [];
    const all = speechSynthesis.getVoices() || [];
    const zh = all.filter((v) => /zh|cmn|Chinese/i.test(v.lang + ' ' + v.name));
    const list = zh.length ? zh : all;
    return dedupeVoices(list.slice().sort((a, b) => voiceTier(a) - voiceTier(b)));
  }
  /* 面板要「设备里有什么就让人看见什么」：中文音色排前面，其它语言另起一组跟在后面。
     以前只列中文，用户装的粤语/日语/英语音色在面板里根本看不到，像是没有。
     但设备里也塞了不少"看着是多一个、其实是同一个"的条目，一律列出来只是噪音：
       · 中文 SAPI 的 Huihui / Yaoyao / Kangkang 常常是同一个拼接引擎换名字，念出来一模一样；
       · 英语的 David / Mark / Zira 这类机械音对读中文古籍毫无用处。
     所以：同语言 + 同档位 + 同性别只留一个（正在用的那个永远保留），其它语言的机械音整组不收。 */
  function voiceKey(v) {
    return String(v.lang || '').toLowerCase().replace(/_/g, '-') + '|' + voiceTier(v) + '|' + voiceGender(v);
  }
  function dedupeVoices(list) {
    const seen = new Set();
    return list.filter((v) => {
      if (listen.voiceURI && v.voiceURI === listen.voiceURI) return true;
      const k = voiceKey(v);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  function listenVoiceGroups() {
    if (!speechOK()) return { zh: [], other: [] };
    const all = speechSynthesis.getVoices() || [];
    const zh = [], other = [];
    all.forEach((v) => {
      if (/^(zh|cmn)/i.test(v.lang || '') || /chinese|中文|普通话|國語|国语/i.test(v.name || '')) zh.push(v);
      else other.push(v);
    });
    const byTier = (a, b) => voiceTier(a) - voiceTier(b) || String(a.name).localeCompare(String(b.name));
    return {
      zh: dedupeVoices(zh.sort(byTier)),
      other: dedupeVoices(other.filter((v) => voiceTier(v) !== 2 || v.voiceURI === listen.voiceURI).sort(byTier))
    };
  }
  const TIER_LABEL = ['自然', '通用', '机械'];

  /* 系统音色的名字动辄「Microsoft Huihui - Chinese (Simplified, PRC)」「Google 普通话（中国大陆）」，
     一屏列下来全是型号和地区码，反而看不出最该知道的两件事：男声还是女声、音质什么档。
     所以列表里只显示「女声 · 自然」这样的短标签，语言压成两字，序号用来区分同名音色；
     完整原名保留在 title 里，想核对型号时悬停即可。 */
  const VOICE_FEMALE = /(huihui|yaoyao|xiaoxiao|xiaoyi|xiaochen|xiaohan|xiaomeng|xiaomo|xiaoxuan|xiaorui|xiaoshuang|xiaoyan|xiaoyou|xiaozhen|xiaobei|xiaoni|hiujin|tingting|meijia|sinji|tianran|lili|female|女声|女)/i;
  const VOICE_MALE = /(kangkang|yunxi|yunyang|yunjian|yunfeng|yunhao|yunjie|yunye|yunze|yunxia|\bmale\b|男声|男)/i;
  function voiceGender(v) {
    const n = String(v.name || '');
    if (VOICE_FEMALE.test(n)) return '女';
    if (VOICE_MALE.test(n)) return '男';
    return '';
  }
  const LANG_SHORT = {
    zh: '中文', yue: '粤语', cmn: '中文', ja: '日语', en: '英语', ko: '韩语',
    fr: '法语', de: '德语', es: '西语', ru: '俄语', it: '意语', pt: '葡语',
    th: '泰语', vi: '越语', ar: '阿语', nl: '荷语', pl: '波语', tr: '土语'
  };
  function voiceLangShort(v) {
    const lang = String(v.lang || '').toLowerCase().replace(/_/g, '-');
    const base = lang.split('-')[0];
    if (base === 'zh') {
      if (/-(hk|mo|yue)/.test(lang) || /cantonese|粤|粵/i.test(v.name || '')) return '粤语';
      if (/-tw/.test(lang)) return '台湾';
      return '中文';
    }
    return LANG_SHORT[base] || (base ? base.toUpperCase() : '未知');
  }
  /* 列表里那一行主文案：性别 + 音质档；性别推不出来就只说档位 */
  function voiceLabel(v) {
    const tier = TIER_LABEL[voiceTier(v)];
    const g = voiceGender(v);
    return g ? g + '声 · ' + tier : tier + '音色';
  }
  /* Chrome 第一次取语音列表常常是空的，等系统把列表吐出来再刷一次面板，别让用户以为没音色 */
  if (speechOK() && typeof speechSynthesis.addEventListener === 'function') {
    speechSynthesis.addEventListener('voiceschanged', () => {
      const p = $('#listenPanel');
      if (p && !p.hidden && p.dataset.kind === 'voice') listenPanel('voice');
    });
  }
  function listenPickVoice() {
    const vs = listenVoices();
    if (!vs.length) return null;
    const saved = vs.find((x) => x.voiceURI === listen.voiceURI);
    if (saved) return saved;
    const best = vs[0];
    if (best) listen.voiceURI = best.voiceURI;
    return best || null;
  }
  function fmtTime(sec) {
    sec = Math.max(0, Math.round(sec));
    return String(Math.floor(sec / 60)).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0');
  }
  /* 切句：先按段落，再按句末标点；超过 90 字的再用逗号收短，
     免得一句话合成十几秒，暂停和跳句都变迟钝。 */
  function listenSplit(parts) {
    const sents = [];
    let offset = 0;
    parts.forEach((p, pi) => {
      const re = /[^。！？；!?;…]+[。！？；!?;…」』”’"]*/g;
      let m;
      while ((m = re.exec(p)) !== null) {
        const seg = m[0];
        if (!seg.trim()) continue;
        const at = offset + m.index;
        if (seg.length > 90) {
          let cursor = 0;
          seg.split(/(?<=[，、：,:])/).forEach((piece) => {
            if (!piece) return;
            sents.push({ t: piece, start: at + cursor, para: pi });
            cursor += piece.length;
          });
        } else {
          sents.push({ t: seg, start: at, para: pi });
        }
      }
      offset += p.length + 1;
    });
    return sents;
  }
  function listenLoadText() {
    const b = getBook(listen.bookId); if (!b) return false;
    const parts = [chapterList(b)[listen.ch - 1].title].concat(paragraphs(b, listen.ch - 1));
    let pos = 0;
    listen.paras = parts.map((p) => { pos += p.length + 1; return p; });
    listen.text = parts.join('\n');
    listen.sents = listenSplit(parts);
    listen.sentIndex = 0; listen.charIndex = 0; listen.paraIndex = 0;
    listen.elapsed = 0; listen.boundaryOK = false;
    return !!listen.text;
  }
  function listenParaAt(idx) {
    let i = 0;
    listen.sents.forEach((s, k) => { if (s.start <= idx) { i = s.para; } });
    return i;
  }
  /* 上次听到哪一句：同章、进度未到尾巴才续，否则从头 */
  function listenResumeIndex() {
    const pr = state.progress[listen.bookId] || {};
    if (pr.ch !== listen.ch || !pr.pct || pr.pct > 0.97 || !listen.sents.length) return 0;
    const target = Math.floor(pr.pct * listen.text.length);
    let i = 0;
    listen.sents.forEach((s, k) => { if (s.start <= target) i = k; });
    return i;
  }
  function listenRenderDynamic() {
    if (!listen.active) return;
    const total = listen.text.length / Math.max(1, listen.rate * 4.6);
    const elapsed = listen.elapsed + (listen.playing && listen.startedAt ? (Date.now() - listen.startedAt) / 1000 : 0);
    const bar = $('#lpBar'); if (bar) bar.style.width = (listen.text ? Math.min(100, listen.charIndex / listen.text.length * 100) : 0) + '%';
    const now = $('#lpNow'); if (now) now.textContent = fmtTime(elapsed);
    const all = $('#lpTotal'); if (all) all.textContent = fmtTime(total);
    const play = $('#listenPlay'); if (play) play.innerHTML = icon(listen.playing ? 'pause' : 'play', 'ic-lg');
    const lmPlay = $('#lmPlay'); if (lmPlay) lmPlay.innerHTML = icon(listen.playing ? 'pause' : 'play');
    const lyric = $('#listenLyric'); if (lyric) lyric.textContent = listen.paras[listen.paraIndex] || '';
    const cover = $('#listenCover'); if (cover) cover.classList.toggle('playing', listen.playing);
    const rate = $('#ltRate'); if (rate) rate.textContent = '语速 ' + fmtRate(listen.rate) + '×';
    const timer = $('#ltTimer');
    if (timer) timer.textContent = listen.timerMin ? '定时 ' + Math.max(0, Math.ceil((listen.timerAt - Date.now()) / 60000)) + '分' : '定时';
    const t = $('#ttsBtn'); if (t) t.classList.toggle('tts-on', listen.active);
    if ('mediaSession' in navigator) {
      try { navigator.mediaSession.playbackState = listen.playing ? 'playing' : 'paused'; } catch (e) { /* 忽略 */ }
    }
    /* 边听边读时把正文滚到当前段，眼睛跟得上耳朵 */
    if (!listen.expanded) listenScrollToPara();
  }
  let lastFollow = 0;
  function listenScrollToPara() {
    const b = getBook(listen.bookId); if (!b) return;
    if (readerRoot.dataset.currentBook !== b.id) return;
    if (Date.now() - lastFollow < 2500) return;
    const paras = readerRoot.querySelectorAll('#readerBody .reader-paper p');
    const target = paras[Math.max(0, listen.paraIndex - 1)];
    if (!target) return;
    const r = target.getBoundingClientRect();
    if (r.top > window.innerHeight * 0.8 || r.bottom < window.innerHeight * 0.15) {
      lastFollow = Date.now();
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }
  /* 每句结束把进度落盘（节流），退出后再进来能接着听 */
  function listenCommitProgress() {
    if (!listen.active || !listen.text) return;
    const now = Date.now();
    if (now - lastCommit < 1200) return;
    lastCommit = now;
    state.progress[listen.bookId] = {
      ch: listen.ch,
      pct: Math.min(0.999, listen.charIndex / listen.text.length),
      updated: now
    };
    state.lastRead = listen.bookId;
    save();
  }
  function listenRemoteOn() {
    const v = VOICE();
    return !!(v && v.active() && !listen.remoteOff);
  }
  function listenDropAudio() {
    if (remoteAudio) {
      remoteAudio.onended = null; remoteAudio.ontimeupdate = null; remoteAudio.onerror = null;
      try { remoteAudio.pause(); } catch (e) { /* 忽略 */ }
      remoteAudio = null;
    }
    if (remoteUrl) { try { URL.revokeObjectURL(remoteUrl); } catch (e) { /* 忽略 */ } remoteUrl = null; }
  }
  function listenCacheKey(text) {
    const v = VOICE();
    const c = v && v.active();
    const who = c ? (c.provider === 'azure' ? 'az:' + c.azure.voice : 'oai:' + c.openai.voice) : 'local';
    return who + '|' + listen.rate + '|' + text;
  }
  /* 合成的句子音频存进 IndexedDB：同一句不重复计费，听过的章节断网也能重听 */
  const AUDIO_DB = 'mojuan-audio';
  let audioDB = null, audioWrites = 0;
  function openAudioDB() {
    if (audioDB) return audioDB;
    audioDB = new Promise((res) => {
      try {
        const rq = indexedDB.open(AUDIO_DB, 1);
        rq.onupgradeneeded = () => { const db = rq.result; if (!db.objectStoreNames.contains('clips')) db.createObjectStore('clips'); };
        rq.onsuccess = () => res(rq.result);
        rq.onerror = () => res(null);
      } catch (e) { res(null); }
    });
    return audioDB;
  }
  function audioIDB(mode, fn) {
    return openAudioDB().then((db) => {
      if (!db) return null;
      return new Promise((res) => {
        try {
          const tx = db.transaction('clips', mode);
          const store = tx.objectStore('clips');
          const rq = fn(store);
          if (rq) { rq.onsuccess = () => res(rq.result || null); rq.onerror = () => res(null); }
          else { tx.oncomplete = () => res(null); tx.onerror = () => res(null); }
        } catch (e) { res(null); }
      });
    });
  }
  function audioCachedGet(key) { return audioIDB('readonly', (st) => st.get(key)); }
  function audioCachedPut(key, blob) {
    audioWrites += 1;
    audioIDB('readwrite', (st) => st.put({ blob, ts: Date.now() }, key));
    /* 每写 20 条修剪一次，别让缓存无限长 */
    if (audioWrites % 20 === 0) audioPrune();
  }
  function audioPrune(limitKB) {
    const max = limitKB || 120 * 1024;   /* 120MB 上限 */
    audioIDB('readonly', (st) => st.getAll()).then((list) => {
      if (!list || !list.length) return;
      let total = 0;
      list.forEach((r) => { total += (r && r.blob ? r.blob.size : 0) / 1024; });
      if (total <= max) return;
      const keys = audioIDB('readonly', (st) => st.getAllKeys());
      Promise.resolve(keys).then((ks) => {
        if (!ks) return;
        const rows = ks.map((k, i) => ({ k, ts: (list[i] || {}).ts || 0 })).sort((a, b) => a.ts - b.ts);
        const drop = Math.max(1, Math.ceil(rows.length * 0.25));
        rows.slice(0, drop).forEach((r) => audioIDB('readwrite', (st) => st.delete(r.k)));
      });
    });
  }
  async function listenSynth(text) {
    const key = listenCacheKey(text);
    const mem = audioCache.get(key);
    if (mem) return mem;
    const p = (async () => {
      const rec = await audioCachedGet(key);
      if (rec && rec.blob) return rec.blob;
      const v = VOICE();
      if (!v || !v.active()) throw new Error('没有在线音色');
      const blob = await v.synth(text, { rate: listen.rate });
      audioCachedPut(key, blob);
      return blob;
    })();
    audioCache.set(key, p);
    try {
      const blob = await p;
      audioCache.set(key, blob);
      if (audioCache.size > 90) audioCache.delete(audioCache.keys().next().value);
      return blob;
    } catch (e) {
      audioCache.delete(key);
      throw e;
    }
  }
  function listenPrefetch(idx) {
    if (!listenRemoteOn()) return;
    const s = listen.sents[idx];
    if (!s) return;
    listenSynth(s.t).catch(() => { /* 预取失败不吵，播到那句再处理 */ });
  }
  /* 在线音色失败：说一声，然后本次听卷改用系统语音继续念，别让用户卡住 */
  function listenRemoteFallback(msg) {
    listen.remoteOff = true;
    listen.playing = false;
    listenDropAudio();
    if (!remoteWarned) {
      remoteWarned = true;
      toast((msg || '在线音色不可用') + '，先用系统语音接着念');
    }
    listenSpeak(true);
  }
  async function listenPlayRemote(gen, s) {
    listen.playing = true;
    listenRenderDynamic();
    let blob;
    try {
      blob = await listenSynth(s.t);
    } catch (e) {
      if (gen !== ttsGen || !listen.active) return;
      listenRemoteFallback(e && e.message);
      return;
    }
    if (gen !== ttsGen || !listen.active) return;
    listenDropAudio();
    remoteUrl = URL.createObjectURL(blob);
    const a = new Audio(remoteUrl);
    remoteAudio = a;
    remoteAudio.dataset.sent = String(listen.sentIndex);
    a.onended = () => {
      if (gen !== ttsGen) return;
      listenDropAudio();
      listen.sentIndex += 1;
      const nx = listen.sents[listen.sentIndex];
      listen.charIndex = nx ? nx.start : listen.text.length;
      listen.paraIndex = nx ? nx.para : Math.max(0, listen.paras.length - 1);
      listenCommitProgress();
      listenRenderDynamic();
      listenPlaySent(gen);
    };
    a.ontimeupdate = () => {
      if (gen !== ttsGen) return;
      const d = a.duration;
      if (!d || !isFinite(d)) return;
      const pct = Math.max(0, Math.min(1, a.currentTime / d));
      listen.charIndex = Math.min(listen.text.length - 1, s.start + Math.floor(s.t.length * pct));
      listen.paraIndex = s.para;
      listenRenderDynamic();
    };
    a.onerror = () => { if (gen === ttsGen) listenRemoteFallback('音频播放失败'); };
    try {
      await a.play();
    } catch (e) {
      if (gen !== ttsGen) return;
      listenRemoteFallback('浏览器拦住了自动播放，点一下播放键');
      return;
    }
    listenPrefetch(listen.sentIndex + 1);
  }
  function listenSpeak(resume) {
    if (!listen.sents.length) return;
    if (!listenRemoteOn() && !speechOK()) return;
    const gen = ++ttsGen;
    listenDropAudio();
    try { if (speechOK()) speechSynthesis.cancel(); } catch (e) { /* 忽略 */ }
    if (!resume) { listen.sentIndex = 0; listen.elapsed = 0; listen.charIndex = 0; }
    listen.playing = true;
    listen.startedAt = Date.now();
    listen.boundaryOK = false;
    listenPlaySent(gen);
  }
  function listenPlaySent(gen) {
    if (gen !== ttsGen || !listen.active) return;
    const s = listen.sents[listen.sentIndex];
    if (!s) { listenChapterDone(); return; }
    if (listenRemoteOn()) { listenPlayRemote(gen, s); return; }
    const u = new SpeechSynthesisUtterance(s.t);
    u.lang = 'zh-CN'; u.rate = listen.rate;
    const v = listenPickVoice(); if (v) u.voice = v;
    u.onboundary = (ev) => {
      if (gen !== ttsGen) return;
      listen.boundaryOK = true;
      listen.charIndex = Math.min(listen.text.length - 1, s.start + (ev.charIndex || 0));
      listen.paraIndex = s.para;
      listenRenderDynamic();
    };
    u.onend = () => {
      if (gen !== ttsGen || !listen.active) return;
      /* 第一句秒结束且没有任何 boundary：多半是没有可用的中文语音 */
      if (!listen.boundaryOK && listen.sentIndex === 0 && Date.now() - listen.startedAt < 1600) {
        listen.playing = false;
        toast('这台设备没有可用的中文语音，暂时无法朗读');
        listenRenderDynamic();
        return;
      }
      listen.sentIndex += 1;
      const nx = listen.sents[listen.sentIndex];
      listen.charIndex = nx ? nx.start : listen.text.length;
      listen.paraIndex = nx ? nx.para : Math.max(0, listen.paras.length - 1);
      listenCommitProgress();
      listenRenderDynamic();
      listenPlaySent(gen);
    };
    u.onerror = (ev) => {
      if (gen !== ttsGen) return;
      const kind = ev && ev.error;
      if (kind === 'interrupted' || kind === 'canceled') return;
      listen.playing = false;
      listenRenderDynamic();
      if (kind === 'not-allowed') toast('需要先点一下播放');
    };
    try {
      speechSynthesis.speak(u);
      listen.lastStart = Date.now();
      listenRenderDynamic();
    } catch (e) { listen.playing = false; toast('朗读启动失败'); listenRenderDynamic(); }
  }
  function listenPause() {
    ttsGen += 1;
    listenDropAudio();
    try { speechSynthesis.cancel(); } catch (e) { /* 忽略 */ }
    if (listen.startedAt) { listen.elapsed += (Date.now() - listen.startedAt) / 1000; listen.startedAt = 0; }
    listen.playing = false;
    listenCommitProgress();
    listenRenderDynamic();
  }
  function listenToggle() { listen.playing ? listenPause() : listenSpeak(true); }
  function listenSentStep(delta) {
    if (!listen.sents.length) return;
    const i = Math.max(0, Math.min(listen.sents.length - 1, listen.sentIndex + delta));
    listen.sentIndex = i;
    const s = listen.sents[i];
    listen.charIndex = s ? s.start : 0;
    listen.paraIndex = s ? s.para : 0;
    if (listen.playing) listenSpeak(true); else listenRenderDynamic();
  }
  function listenChapterDone() {
    if (listen.startedAt) { listen.elapsed += (Date.now() - listen.startedAt) / 1000; listen.startedAt = 0; }
    listen.charIndex = listen.text.length;
    const b = getBook(listen.bookId);
    if (b && listen.ch < chapterList(b).length) { listenGoChapter(listen.ch + 1, true); return; }
    listen.playing = false;
    toast('这一卷读完了');
    listenRenderDynamic();
  }
  /* 锁屏 / 通知栏 / 耳机按键：没有这层，手机一锁屏就断，还得掏出来点播放 */
  function listenMediaSession(on) {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    if (!on) {
      try { ms.playbackState = 'paused'; ms.metadata = null; } catch (e) { /* 忽略 */ }
      ['play', 'pause', 'stop', 'previoustrack', 'nexttrack', 'seekbackward', 'seekforward'].forEach((k) => {
        try { ms.setActionHandler(k, null); } catch (e) { /* 忽略 */ }
      });
      return;
    }
    const b = getBook(listen.bookId); if (!b) return;
    try {
      ms.metadata = new MediaMetadata({
        title: chapterList(b)[listen.ch - 1].title,
        artist: b.author || '佚名',
        album: b.title
      });
      ms.setActionHandler('play', () => { if (!listen.playing) listenSpeak(true); });
      ms.setActionHandler('pause', () => listenPause());
      ms.setActionHandler('stop', () => listenStopAll());
      ms.setActionHandler('previoustrack', () => { if (listen.ch > 1) listenGoChapter(listen.ch - 1, true); });
      ms.setActionHandler('nexttrack', () => {
        const bb = getBook(listen.bookId);
        if (bb && listen.ch < chapterList(bb).length) listenGoChapter(listen.ch + 1, true);
      });
      ms.setActionHandler('seekbackward', () => listenSentStep(-1));
      ms.setActionHandler('seekforward', () => listenSentStep(1));
    } catch (e) { /* 忽略 */ }
  }
  /* 静音循环音轨：让系统认为页面正在放音，隐藏标签页/锁屏时不容易被挂起 */
  function listenKeepAlive(on) {
    if (on) {
      if (!keepAudio) {
        keepAudio = document.createElement('audio');
        keepAudio.src = SILENT_WAV;
        keepAudio.loop = true;
        keepAudio.volume = 0.01;
        keepAudio.setAttribute('playsinline', '');
        keepAudio.preload = 'auto';
        keepAudio.style.display = 'none';
        document.body.appendChild(keepAudio);
      }
      keepAudio.play().catch(() => { /* 静音播放被拦就随它 */ });
    } else if (keepAudio) {
      try { keepAudio.pause(); } catch (e) { /* 忽略 */ }
      keepAudio.remove();
      keepAudio = null;
    }
  }
  async function listenGoChapter(ch, autoplay) {
    const b = getBook(listen.bookId); if (!b) return;
    listen.ch = Math.max(1, Math.min(chapterList(b).length, ch));
    if (!b.local) {
      await ensureChapter(b, listen.ch);
      if (!listen.active) return;
    }
    listenLoadText();
    state.progress[listen.bookId] = { ch: listen.ch, pct: 0, updated: Date.now() };
    save();
    renderListen();
    if (autoplay || listen.playing) listenSpeak(false);
    else listenRenderDynamic();
  }
  function listenShell(b) {
    const chs = chapterList(b);
    return `<div class="listen" id="listen" data-paper="${state.settings.paper}">
      <div class="listen-top">
        <button class="icon-btn" data-action="listen-minimize" title="收起听卷（继续播放）">${icon('close')}</button>
        <div class="listen-top-title">听 卷 · ${esc(b.title)}</div>
        <button class="icon-btn" data-action="listen-minimize" title="收起，边听边读">${icon('minimize')}</button>
      </div>
      <div class="listen-main">
        <div class="listen-cover" id="listenCover">${coverHtml(b)}</div>
        <div class="listen-book">${esc(b.title)}</div>
        <div class="listen-author">${esc(b.author)}</div>
        <div class="listen-chapter" id="listenChapter">${esc(chs[listen.ch - 1].title)}</div>
        <div class="listen-lyric" id="listenLyric"></div>
      </div>
      <div class="listen-bottom">
        <div class="listen-progress">
          <span id="lpNow">00:00</span>
          <div class="progress-line" data-action="listen-seek" id="lpTrack"><i id="lpBar"></i></div>
          <span id="lpTotal">--:--</span>
        </div>
        <div class="listen-buttons">
          <button class="icon-btn lg" data-action="listen-prev" title="上一章">${icon('stepback')}</button>
          <button class="listen-play" data-action="listen-toggle" id="listenPlay">${icon(listen.playing ? 'pause' : 'play', 'ic-lg')}</button>
          <button class="icon-btn lg" data-action="listen-next" title="下一章">${icon('stepforward')}</button>
        </div>
        <div class="listen-tools">
          <button data-action="listen-panel" data-val="rate" id="ltRate">语速 ${fmtRate(listen.rate)}×</button>
          <button data-action="listen-panel" data-val="voice">音色</button>
          <button data-action="listen-panel" data-val="timer" id="ltTimer">定时</button>
          <button data-action="listen-panel" data-val="catalog">目录</button>
        </div>
        <div id="listenPanel" class="listen-panel" hidden></div>
      </div>
    </div>
    <div class="listen-mini" id="listenMini" hidden>
      <button class="lm-close" data-action="listen-close" title="停止听书" aria-label="停止听书">${icon('close', 'ic-sm')}</button>
      <div class="lm-ball" data-action="listen-expand" title="展开听卷">
        <div class="lm-cover">${coverHtml(b)}</div>
        <button class="lm-play" data-action="listen-toggle" id="lmPlay" title="播放 / 暂停">${icon(listen.playing ? 'pause' : 'play')}</button>
      </div>
    </div>`;
  }
  function renderListen() {
    const b = getBook(listen.bookId); if (!b || !listen.active) return;
    let root = $('#listenRoot');
    if (!root) { root = document.createElement('div'); root.id = 'listenRoot'; document.body.appendChild(root); }
    root.innerHTML = listenShell(b);
    const l = $('#listen'), m = $('#listenMini');
    if (l) l.hidden = !listen.expanded;
    if (m) {
      m.hidden = listen.expanded;
      if (!listen.expanded) {
        if (state.listenMiniPos) {
          /* 用户拖到了自己喜欢的位置，尊重之 */
          m.style.left = state.listenMiniPos.left + 'px';
          m.style.top = state.listenMiniPos.top + 'px';
          m.style.right = 'auto';
          m.style.bottom = 'auto';
        } else {
          /* 默认左下角：浮在底部工具区 / 底部导航之上，别盖住入口 */
          const rb = $('#readerBottom'), bn = $('#bottomNav');
          m.style.left = ''; m.style.right = ''; m.style.top = '';
          m.style.bottom = (rb || bn)
            ? `calc(${Math.ceil((rb || bn).getBoundingClientRect().height)}px + 10px + env(safe-area-inset-bottom))`
            : '';
        }
      } else {
        m.style.bottom = '';
      }
      setupMiniDrag();
    }
    listenRenderDynamic();
    if (listen.active) listenMediaSession(true);
  }
  function setupMiniDrag() {
    const mini = $('#listenMini'); if (!mini || mini.hidden) return;
    let startX = 0, startY = 0, originL = 0, originT = 0, dragging = false, moved = false, pid = null;
    const onDown = (e) => {
      if (e.target.closest('.lm-close') || e.target.closest('.lm-play')) return; /* 按钮各自处理 */
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      dragging = true; moved = false; pid = e.pointerId;
      const r = mini.getBoundingClientRect();
      if (mini.style.left === '' || mini.style.right !== 'auto') {
        mini.style.left = r.left + 'px'; mini.style.top = r.top + 'px';
        mini.style.right = 'auto'; mini.style.bottom = 'auto';
      }
      originL = parseFloat(mini.style.left) || 0;
      originT = parseFloat(mini.style.top) || 0;
      startX = e.clientX; startY = e.clientY;
      try { mini.setPointerCapture(pid); } catch (_) {}
      mini.classList.add('dragging');
    };
    const onMove = (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (!moved && Math.hypot(dx, dy) > 6) moved = true;
      if (!moved) return;
      const w = mini.offsetWidth, h = mini.offsetHeight;
      const nl = Math.max(4, Math.min(window.innerWidth - w - 4, originL + dx));
      const nt = Math.max(4, Math.min(window.innerHeight - h - 4, originT + dy));
      mini.style.left = nl + 'px'; mini.style.top = nt + 'px';
    };
    const onUp = (e) => {
      if (!dragging) return;
      dragging = false;
      try { mini.releasePointerCapture(pid); } catch (_) {}
      mini.classList.remove('dragging');
      if (moved) {
        state.listenMiniPos = { left: parseFloat(mini.style.left) || 0, top: parseFloat(mini.style.top) || 0 };
        save();
        /* 拖完这次 click 别误触“展开” */
        mini.addEventListener('click', (ev) => { ev.stopPropagation(); ev.preventDefault(); }, { capture: true, once: true });
      }
    };
    mini.addEventListener('pointerdown', onDown);
    mini.addEventListener('pointermove', onMove);
    mini.addEventListener('pointerup', onUp);
    mini.addEventListener('pointercancel', onUp);
  }
  function listenPanel(kind) {
    const p = $('#listenPanel'); if (!p) return;
    p.dataset.kind = kind;
    p.hidden = false;
    const head = (t) => `<div class="lp-head"><span>${t}</span><button class="icon-btn" data-action="listen-panel-close" title="关闭">${icon('close', 'ic-sm')}</button></div>`;
    if (kind === 'rate') {
      p.innerHTML = head('朗读语速') + rateSliderHtml(listen.rate, '按住圆点拖动 · 0.5× ~ 3×');
    } else if (kind === 'voice') {
      const g = listenVoiceGroups();
      const vs = g.zh.length ? g.zh : g.other;
      const allMeh = vs.length && vs.every((v) => voiceTier(v) === 2);
      const vv = VOICE();
      const onlineLabel = vv ? vv.activeLabel() : '';
      const onlineBtn = `<button class="lp-online ${onlineLabel ? 'on' : ''}" data-action="voice-config">${onlineLabel ? '在线音色 · ' + esc(onlineLabel) : '启用在线音色（需自备 key）'}${icon('right', 'ic-sm')}</button>`;
      const tip = onlineLabel
        ? ''
        : (!vs.length
          ? '<div class="lp-empty">没有检测到可用语音，可在系统设置里安装中文语音包</div>'
          : (allMeh ? '<div class="lp-empty">这台设备只装了早期机械音，念白话尚可、念文言会比较生硬。上面可以启用在线音色，或者装一个自然语音包。</div>' : ''));
      /* 每个音色右侧给一个试听键：标签只有「女声 · 自然」，实际嗓音还得听一耳朵才准 */
      const row = (v, no) => `<div class="lp-row">
          <button class="lp-item ${listen.voiceURI === v.voiceURI ? 'active' : ''}" data-action="listen-voice" data-val="${esc(v.voiceURI)}" title="${esc(v.name)}">${voiceLabel(v)}<small>${voiceLangShort(v)} · ${no + 1}</small></button>
          <button class="lp-try" data-action="listen-voice-try" data-val="${esc(v.voiceURI)}" title="试听这个音色">${icon('volume', 'ic-sm')}</button>
        </div>`;
      const group = (title, list) => list.length
        ? `<div class="lp-group">${title}</div><div class="lp-list">${list.map(row).join('')}</div>`
        : '';
      /* 提示放列表上方：面板高度有限，放下面要滚动才看得见 */
      p.innerHTML = head('音色 · ' + (g.zh.length + g.other.length) + ' 个') + onlineBtn + tip
        + group('中文音色', g.zh)
        + group(g.zh.length ? '其它语言' : '音色', g.other)
        + (g.other.length && g.zh.length ? '<div class="lp-empty">文言文建议用中文音色；其它语言念中文会走音。</div>' : '');
    } else if (kind === 'timer') {
      p.innerHTML = head('定时停止') + `<div class="rs-pills">${[[0, '不开启'], [15, '15 分钟'], [30, '30 分钟'], [60, '60 分钟'], [90, '90 分钟']].map(([m, l]) =>
        `<button class="rs-pill ${listen.timerMin === m ? 'active' : ''}" data-action="listen-timer" data-val="${m}">${l}</button>`).join('')}</div>`;
    } else {
      const b = getBook(listen.bookId);
      p.innerHTML = head('目录 · 共 ' + chapterList(b).length + ' 章') +
        `<div class="lp-list">${chapterList(b).map((c, i) =>
          `<button class="lp-item ${i + 1 === listen.ch ? 'active' : ''}" data-action="listen-chapter" data-val="${i + 1}">${esc(c.title)}</button>`).join('')}</div>`;
    }
  }
  /* ---------- 听卷音色：在线音色配置（可选，自备 key） ---------- */
  const VOICE_PROVIDERS = [['local', '系统语音'], ['azure', 'Azure'], ['openai', 'OpenAI 兼容']];
  function voiceField(label, inner) { return `<label class="vf-row"><span>${label}</span>${inner}</label>`; }
  /* 合成过的句子会存下来：同一句不再计费，听过的章节断网也能重听 */
  function voiceCacheRow() {
    return `<div class="vf-cache"><span id="vfCacheSize">听书音频缓存：统计中…</span>
      <button class="btn btn-ghost btn-sm" data-action="voice-clear-audio">清除</button></div>`;
  }
  function voiceCacheInfo() {
    const el = document.getElementById('vfCacheSize');
    if (!el) return;
    audioIDB('readonly', (st) => st.getAll()).then((list) => {
      if (!list || !list.length) { el.textContent = '听书音频缓存：还没有'; return; }
      let sz = 0;
      list.forEach((r) => { sz += r && r.blob ? r.blob.size : 0; });
      el.textContent = '听书音频缓存：' + list.length + ' 句 · '
        + (sz >= 1048576 ? (sz / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(sz / 1024)) + ' KB');
    });
  }
  function voiceModalHtml() {
    const v = VOICE(); if (!v) return '';
    const c = v.getConfig();
    const p = c.provider;
    let body = '';
    if (p === 'local') {
      body = '<p class="vf-note">用设备自带的语音，零流量、离线可用。音色取决于系统装了什么语音包。想在听卷界面看这台设备具体有哪几个音色，打开「音色」面板就行。</p>';
    } else if (p === 'azure') {
      body = voiceField('区域', `<select id="vfRegion">${['eastasia', 'southeastasia', 'eastus', 'westus2', 'japaneast', 'northeurope'].map((r) => `<option ${c.azure.region === r ? 'selected' : ''}>${r}</option>`).join('')}</select>`)
        + voiceField('密钥', `<input id="vfKey" type="password" autocomplete="off" placeholder="Azure 语音服务的密钥" value="${esc(c.azure.key)}">`)
        + voiceField('音色', `<select id="vfVoice">${v.AZURE_VOICES.map(([id, label]) => `<option value="${id}" ${c.azure.voice === id ? 'selected' : ''}>${label}</option>`).join('')}</select>`)
        + '<p class="vf-note">Azure 每月 50 万字符免费，按一章八千字算够听六十多章。密钥只存在这台设备的浏览器里，不会上传到任何地方。</p>'
        + voiceCacheRow();
    } else {
      body = voiceField('接口地址', `<input id="vfBase" type="url" placeholder="https://api.openai.com/v1" value="${esc(c.openai.base)}">`)
        + voiceField('密钥', `<input id="vfKey" type="password" autocomplete="off" placeholder="sk-..." value="${esc(c.openai.key)}">`)
        + voiceField('模型', `<input id="vfModel" placeholder="tts-1" value="${esc(c.openai.model)}">`)
        + voiceField('音色', `<select id="vfVoice">${v.OPENAI_VOICES.map(([id, label]) => `<option value="${id}" ${c.openai.voice === id ? 'selected' : ''}>${label}</option>`).join('')}</select>`)
        + '<p class="vf-note">任何兼容 OpenAI <code>/audio/speech</code> 的服务都能填，接口地址写到 <code>/v1</code> 那一层。密钥只存在这台设备上。</p>'
        + voiceCacheRow();
    }
    return `<div class="as-head"><b>听卷音色</b><button class="icon-btn" data-action="close-voice-config" title="关闭">${icon('close')}</button></div>
      <div class="as-body">
        <div class="vf-seg">${VOICE_PROVIDERS.map(([k, l]) => `<button class="${p === k ? 'active' : ''}" data-action="voice-provider" data-val="${k}">${l}</button>`).join('')}</div>
        ${body}
      </div>
      <div class="as-foot" style="gap:8px">
        <button class="btn btn-ghost btn-sm" data-action="voice-test">试听一句</button>
        <button class="btn btn-primary btn-sm" data-action="voice-save">保存</button>
      </div>`;
  }
  function renderVoiceModal() {
    const root = $('#voiceModal');
    if (!root) return;
    root.innerHTML = `<div class="modal-backdrop" data-action="close-voice-config"></div><div class="action-sheet">${voiceModalHtml()}</div>`;
  }
  function openVoiceConfig() {
    if (!VOICE()) { toast('语音模块没加载'); return; }
    let root = $('#voiceModal');
    if (!root) { root = document.createElement('div'); root.id = 'voiceModal'; document.body.appendChild(root); }
    renderVoiceModal();
    root.hidden = false;
    document.body.style.overflow = 'hidden';
    voiceCacheInfo();
  }
  function closeVoiceConfig() {
    const root = $('#voiceModal'); if (root) root.remove();
    document.body.style.overflow = (listen.active || $('#reader')) ? 'hidden' : '';
  }
  /* 只把表单里当前这一家的值写回去，切服务商时不丢已填的 key */
  function voiceSaveForm() {
    const v = VOICE(); if (!v) return;
    const c = v.getConfig();
    const g = (id) => { const el = document.getElementById(id); return el ? String(el.value || '').trim() : ''; };
    const patch = { provider: c.provider };
    if (c.provider === 'azure') patch.azure = { region: g('vfRegion') || 'eastasia', key: g('vfKey'), voice: g('vfVoice') || 'zh-CN-XiaoxiaoNeural' };
    else if (c.provider === 'openai') patch.openai = { base: g('vfBase') || 'https://api.openai.com/v1', key: g('vfKey'), model: g('vfModel') || 'tts-1', voice: g('vfVoice') || 'alloy' };
    v.setConfig(patch);
  }
  function listenStopAll() {
    ttsGen += 1;
    try { if (speechOK()) speechSynthesis.cancel(); } catch (e) { /* 忽略 */ }
    clearTimeout(listenTimer); clearInterval(listenTick);
    listenDropAudio();
    listenCommitProgress();
    listen.active = false; listen.playing = false; listen.expanded = true;
    listen.timerMin = 0; listen.timerAt = 0;
    listenMediaSession(false);
    listenKeepAlive(false);
    const l = $('#listenRoot'); if (l) l.remove();
    const t = $('#ttsBtn'); if (t) t.classList.remove('tts-on');
    document.body.style.overflow = listen.prevOverflow || '';
  }
  async function openListen(id, ch) {
    const b = getBook(id); if (!b) return;
    if (!speechOK()) { toast('当前浏览器不支持语音朗读'); return; }
    if (b.local && !contentCache[id]) {
      try { const rec = await loadContent(id); if (rec && rec.chapters) contentCache[id] = rec; } catch (e) { /* 忽略 */ }
    }
    if (!listen.active) {
      listen.prevOverflow = document.body.style.overflow;
      try { history.pushState({ mojuanListen: true }, ''); } catch (e) { /* 忽略 */ }
    }
    listen.active = true; listen.expanded = true;
    listen.bookId = id; listen.ch = Math.max(1, Math.min(chapterList(b).length, ch || (state.progress[id] || {}).ch || 1));
    if (!b.local) {
      await ensureChapter(b, listen.ch);
      listen.ch = Math.max(1, Math.min(chapterList(b).length, listen.ch));
    }
    listen.rate = clampRate(state.settings.rate);
    listen.voiceURI = state.settings.voiceURI || '';
    /* 每次重新打开听卷都再试一次在线音色，别因为上次失败就永远不用 */
    listen.remoteOff = false;
    remoteWarned = false;
    if (!listenLoadText()) { toast('这一章没有可朗读的内容'); listen.active = false; return; }
    /* 上次听到一半就从那一句接着听，听完的从头来 */
    const resumeAt = listenResumeIndex();
    if (resumeAt > 0) {
      const rs = listen.sents[resumeAt];
      listen.sentIndex = resumeAt;
      listen.charIndex = rs ? rs.start : 0;
      listen.paraIndex = rs ? rs.para : 0;
    }
    lastCommit = 0;
    document.body.style.overflow = 'hidden';
    renderListen();
    listenMediaSession(true);
    listenKeepAlive(true);
    listenSpeak(true);
    if (resumeAt > 0) toast('接着上次听到的地方');
    clearInterval(listenTick);
    listenTick = setInterval(() => { if (listen.active) listenRenderDynamic(); }, 1000);
  }

  /* 字号 / 行距 / 窗口尺寸变化时，按当前阅读位置重新分页 */
  /* 当前页第一个字在整章里的字符偏移：重排的锚点 */
  function flipCharOffset(pages, idx) {
    let off = 0;
    for (let i = 0; i < idx && i < pages.length; i += 1) {
      for (const it of pages[i]) off += it.text.length;
    }
    return off;
  }
  function flipPageAtOffset(pages, off) {
    let acc = 0;
    for (let i = 0; i < pages.length; i += 1) {
      let len = 0;
      for (const it of pages[i]) len += it.text.length;
      if (acc + len > off) return i;
      acc += len;
    }
    return Math.max(0, pages.length - 1);
  }
  function reflowFlip() {
    if (state.settings.pageMode !== 'flip' || !$('#reader') || !flipState.pages.length) return;
    const b = getBook(flipState.id); if (!b) return;
    const fp = $('#flipPage'); if (!fp) return;
    const W = fp.clientWidth, H = fp.clientHeight;
    if (W < 60 || H < 80) return;
    /* 用「当前页第一个字在全章的偏移」当锚点。字号一变页数全变，
       按页码比例定位会漂到别处，按字数锚点能稳稳停在原来读到的那句话上。 */
    const anchor = flipCharOffset(flipState.pages, flipState.page);
    const pages = paginate(flipItems(b, flipState.ch), W, H);
    flipState.pages = pages;
    flipState.page = flipPageAtOffset(pages, anchor);
    renderFlipPage('');
  }
  /* 连点字号 / 行距时，只在停手后重排一次：每次点击都整章重算会把界面拖住，
     而中间那些状态用户根本来不及看 */
  let reflowTimer = null;
  function scheduleReflow() {
    if (reflowTimer) clearTimeout(reflowTimer);
    reflowTimer = setTimeout(() => { reflowTimer = null; reflowFlip(); }, 110);
  }
  /* 改完字号 / 行距后的统一收尾：翻页模式重排；滚动模式保住原来的阅读位置 */
  function restyleReader() {
    const body = $('#readerBody');
    const isFlip = state.settings.pageMode === 'flip';
    let ratio = 0;
    if (!isFlip && body) {
      const max = body.scrollHeight - body.clientHeight;
      ratio = max > 0 ? body.scrollTop / max : 0;
    }
    applyReaderStyle();
    if (isFlip) { scheduleReflow(); return; }
    /* 滚动模式不会重新渲染节点，字号一变浏览器就地重排，scrollTop 数值不变但位置会挪，
       所以按比例把它拉回原处（等下一帧，布局算完再设） */
    if (body) {
      requestAnimationFrame(() => {
        const max = body.scrollHeight - body.clientHeight;
        if (max > 0) body.scrollTop = Math.round(ratio * max);
      });
    }
  }
  let readTimer = null;
  function stopReadClock() { if (readTimer) { clearInterval(readTimer); readTimer = null; } }
  function accrueReadTime(now) {
    if (!readerSession) return;
    const sec = Math.max(0, (now - readerSession.start) / 1000);
    state.seconds += sec;
    state.readLog = state.readLog || {};
    const d = today();
    state.readLog[d] = (state.readLog[d] || 0) + sec;
    readerSession.start = now;
  }
  function startReadClock(id) {
    stopReadClock();
    if (!readerSession || readerSession.book !== id) readerSession = { book: id, start: Date.now() };
    /* 每分钟落一次盘：中途关掉标签页也不会把这段阅读时长丢掉 */
    readTimer = setInterval(() => {
      if (!readerSession || !$('#reader')) { stopReadClock(); return; }
      accrueReadTime(Date.now());
      save();
    }, 60000);
  }
  function settleSession() {
    stopReadClock();
    if (!readerSession) return;
    accrueReadTime(Date.now());
    readerSession = null; save();
  }
  /* 切到别的标签页 / 手机锁屏时停表，否则读墨记会被凭空灌满时间。
     后台标签的定时器只是被浏览器节流成每分钟一次，并不会停。 */
  document.addEventListener('visibilitychange', () => {
    if (!readerSession) return;
    if (document.hidden) {
      accrueReadTime(Date.now());
      flushSave();
      stopReadClock();
    } else if ($('#reader')) {
      startReadClock(readerSession.book);
    }
  });
  window.addEventListener('pagehide', () => {
    if (readerSession) { accrueReadTime(Date.now()); stopReadClock(); }
    /* 关页/刷新前把最后一次翻页、滚动进度立即落盘，否则节流中的存档会丢 */
    flushSave();
    if (listen.active) listenStopAll();
  });
  function paginateAndRender(b, ch, token, dir) {
    if (token !== readerToken) return;
    const body = $('#readerBody');
    const pr = state.progress[b.id];
    if (state.settings.pageMode === 'flip') {
      const fp = $('#flipPage'); if (!fp) return;
      const W = fp.clientWidth, H = fp.clientHeight;
      if (W < 60 || H < 80) return;
      const pages = paginate(flipItems(b, ch), W, H);
      let page = 0;
      if (ui.flipHint === 'last') page = pages.length - 1;
      else if (pr && pr.ch === ch && pr.pct > 0) page = Math.min(pages.length - 1, Math.round(pr.pct * (pages.length - 1)));
      if (ui.flipTargetPage != null) { page = Math.min(pages.length - 1, ui.flipTargetPage); ui.flipTargetPage = null; }
      ui.flipHint = null;
      flipState = { pages, page, id: b.id, ch };
      renderFlipPage(dir || '');
    } else {
      if (pr && pr.ch === ch && pr.pct > 0) body.scrollTop = pr.pct * (body.scrollHeight - body.clientHeight);
      updateReaderSeek();
      syncBookmarkBtn();
    }
  }
  async function showReader(id, ch) {
    const token = ++readerToken;
    let b = getBook(id);
    if (!b) { /* 在线书源还没聚合完，等一下再找一次 */
      try { await sourcesReady; } catch (e) { /* 忽略 */ }
      b = getBook(id);
    }
    if (!b) { toast('这一卷找不到了'); go('shelf'); return; }
    let flipMode = state.settings.pageMode === 'flip';
    const prevBook = readerRoot.dataset.currentBook;
    const prevMode = readerRoot.dataset.mode;
    /* 同一本书、同样是翻页模式时换章：只重算分页，不重建 DOM，省掉「正在分页」占位帧 */
    let canReuse = flipMode && prevBook === id && prevMode === 'flip' && !!$('#reader') && !!$('#flipPage');
    readerRoot.dataset.currentBook = id;
    /* 在线书的章目是懒取的，此刻只有「开卷取回」占位，不能拿它来钳制章号 */
    const placeholder = b.online && chapterList(b).length <= 1;
    ch = Math.max(1, ch || 1);
    if (!placeholder) ch = Math.min(chapterList(b).length, ch);
    readerRoot.dataset.currentCh = ch;
    if (b.local && !contentCache[id]) {
      canReuse = false;
      document.body.style.overflow = 'hidden';
      readerRoot.innerHTML = `<div class="reader" data-paper="${state.settings.paper}"><div class="reader-loading">正 在 展 卷 …</div></div>`;
      try {
        const rec = await loadContent(id);
        if (token !== readerToken) return;
        if (!rec || !rec.chapters) throw new Error('内容已丢失');
        contentCache[id] = rec;
      } catch (e) {
        toast('本地卷内容读取失败，请重新导入');
        go('shelf'); return;
      }
    }
    /* 正文不在内存里：内置书要加载整本分片，在线源逐章取回 */
    if (!b.local) {
      const src = SRC.get(b.sourceId);
      const hasAsync = src && typeof src.getChapter === 'function';
      const cached = contentCache[id] && contentCache[id].chapters[ch - 1];
      if (hasAsync && !SRC.getChapterSync(id, ch) && !cached) {
        canReuse = false;
        document.body.style.overflow = 'hidden';
        readerRoot.innerHTML = `<div class="reader" data-paper="${state.settings.paper}"><div class="reader-loading">正 在 展 卷 …</div></div>`;
      }
      if (hasAsync) {
        await ensureChapter(b, ch);
        if (token !== readerToken) return;
        const total = chapterList(b).length;
        if (ch > total) {
          ch = total;
          readerRoot.dataset.currentCh = ch;
          await ensureChapter(b, ch);
          if (token !== readerToken) return;
        }
      }
    }
    if (token !== readerToken) return;
    /* 正文到手后再判断：只有一句「取不到正文」的提示时分页没有意义，走滚动布局显示错误块。
       这一步必须放在取回正文之后，否则会把「还没取回来」误判成取不到。 */
    if (flipMode && chapterErrMsg(b, ch)) flipMode = false;
    /* 在线书翻章要等取正文，读到本章末再翻会卡一下。这里闲时把下一章先取回来。 */
    if (b.online && ch < chapterList(b).length) ensureChapter(b, ch + 1);
    readerRoot.dataset.mode = flipMode ? 'flip' : 'scroll';
    /* 章号若被钳到范围内（手输 999、或在线书章目少于预期），把地址栏也改回来，
     * 免得复制出去/存成书签的链接指向不存在的章 */
    const cur = parseRoute();
    if (cur.name === 'reader' && (cur.id !== id || Number(cur.ch) !== ch)) {
      try { history.replaceState(null, '', '#/reader/' + id + '/' + ch); } catch (e) { /* file:// 忽略 */ }
    }
    if (!readerSession || readerSession.book !== id) { settleSession(); startReadClock(id); }
    const dir = ui.flipDir || '';
    ui.flipDir = '';
    if (canReuse) {
      document.body.style.overflow = 'hidden';
      paginateAndRender(b, ch, token, dir);
      return;
    }
    document.body.style.overflow = 'hidden';
    readerRoot.innerHTML = readerHtml(b, ch);
    a11ySweep(readerRoot);
    setBgInert(true);
    /* 刚进阅读器（不是换章）时把焦点交给正文，读屏才知道翻到了哪一卷 */
    if (!prevBook) {
      const rd = $('#reader');
      if (rd) { rd.setAttribute('tabindex', '-1'); rd.focus({ preventScroll: true }); }
    }
    applyReaderStyle();
    const body = $('#readerBody');
    requestAnimationFrame(() => paginateAndRender(b, ch, token));
    if (flipMode) {
      let sx = 0, sy = 0;
      body.addEventListener('touchstart', (ev) => {
        sx = ev.touches[0].clientX; sy = ev.touches[0].clientY;
      }, { passive: true });
      body.addEventListener('touchend', (ev) => {
        const dx = ev.changedTouches[0].clientX - sx, dy = ev.changedTouches[0].clientY - sy;
        if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.3) {
          ui.flipSwiped = true;
          flipBy(dx < 0 ? 1 : -1);
          setTimeout(() => { ui.flipSwiped = false; }, 350);
        }
      }, { passive: true });
    } else {
      let tick;
      body.addEventListener('scroll', () => {
        clearTimeout(tick);
        tick = setTimeout(() => {
          const max = body.scrollHeight - body.clientHeight;
          const pct = max > 0 ? Math.min(1, body.scrollTop / max) : 0;
          state.progress[id] = { ch, pct, updated: Date.now() };
          state.lastRead = id;
          scheduleSave();
          updateReaderSeek();
        }, 260);
      });
    }
    readerRoot.dataset.currentBook = id;
    readerRoot.dataset.currentCh = ch;
  }
  /* 阅读器是盖在整页之上的独立层，底下的书城/藏卷虽然看不见却还在 DOM 里：
     键盘 Tab 会一头钻进去、读屏也会把后面的书单念出来。进阅读器时把背景设成 inert。 */
  function setBgInert(on) {
    ['#view', '.topbar', '#bottomNav', '.sidebar'].forEach((sel) => {
      const el = $(sel); if (!el) return;
      if (on) {
        el.setAttribute('inert', '');
        el.setAttribute('aria-hidden', 'true');
      } else {
        el.removeAttribute('inert');
        el.removeAttribute('aria-hidden');
      }
    });
  }
  function hideReader() {
    readerToken += 1;
    /* 退出阅读器时朗读不中断，收成迷你播放条继续播；只有用户显式点「停止」才停 */
    if (listen.active) { listen.expanded = false; renderListen(); }
    settleSession();
    readerRoot.innerHTML = '';
    delete readerRoot.dataset.currentBook;
    delete readerRoot.dataset.currentCh;
    delete readerRoot.dataset.mode;
    document.body.style.overflow = '';
    setBgInert(false);
  }
  function openPanel(kind) {
    const mask = $('#readerMask'), panel = $('#readerPanel'), drawer = $('#catalogDrawer');
    const b = getBook(readerRoot.dataset.currentBook); if (!b) return;
    mask.hidden = false; drawer.hidden = true;
    if (kind === 'settings') {
      const fsList = [16, 18, 19, 21, 24];
      const paperList = [['xuan', '#f7f2e6'], ['bamboo', '#e9efe4'], ['sheep', '#f2e5cd'], ['night', '#161a1c']];
      panel.hidden = false;
      panel.innerHTML = `<div class="reader-settings">
        <div class="rs-row"><label>字体</label><div class="rs-pills">${Object.keys(FONT_NAMES).map((k) =>
          `<button class="rs-pill ${state.settings.font === k ? 'active' : ''}" data-action="set-fontfamily" data-val="${k}">${FONT_NAMES[k]}</button>`).join('')}</div></div>
        <div class="rs-row"><label>字号 ${state.settings.fs}px</label><div class="rs-pills">${fsList.map((f) =>
          `<button class="rs-pill ${state.settings.fs === f ? 'active' : ''}" data-action="set-font" data-val="${f}">${f}</button>`).join('')}<button class="rs-pill" data-action="set-font" data-val="-">A−</button><button class="rs-pill" data-action="set-font" data-val="+">A＋</button></div></div>
        <div class="rs-row"><label>行距</label><div class="rs-pills">${[1.7, 2, 2.3].map((l, i) =>
          `<button class="rs-pill ${state.settings.lh === l ? 'active' : ''}" data-action="set-lh" data-val="${l}">${['紧凑', '适中', '疏朗'][i]}</button>`).join('')}</div></div>
        <div class="rs-row"><label>纸张</label><div class="rs-pills">${paperList.map(([k, c]) =>
          `<button class="rs-pill ${state.settings.paper === k ? 'active' : ''}" data-action="set-paper" data-val="${k}"><span class="paper-dot" style="background:${c};vertical-align:middle;margin-right:6px"></span>${({ xuan: '宣纸', bamboo: '青竹', sheep: '羊皮', night: '夜墨' })[k]}</button>`).join('')}</div></div>
        <div class="rs-row"><label>读墨</label><div class="rs-pills">
          <button class="rs-pill ${state.settings.pageMode === 'flip' ? 'active' : ''}" data-action="set-pagemode" data-val="flip">左右翻页</button>
          <button class="rs-pill ${state.settings.pageMode === 'scroll' ? 'active' : ''}" data-action="set-pagemode" data-val="scroll">上下滚动</button>
        </div></div>
        <div class="rs-row"><label>翻页</label><div class="rs-pills">
          ${[['slide', '卷动'], ['fade', '淡入'], ['none', '无动画']].map(([k, l]) =>
            `<button class="rs-pill ${state.settings.flipAnim === k ? 'active' : ''}" data-action="set-flipanim" data-val="${k}">${l}</button>`).join('')}
        </div></div>
        <div class="rs-row rate-inline"><label>朗读</label>${rateSliderHtml(state.settings.rate, '语速 · 按住圆点拖动')}</div>
      </div>`;
    } else if (kind === 'notes') {
      /* 校勘记：竖排一列，字号比正文小一档，只在这里看，不占正文版面 */
      const ch = Math.max(1, Number(readerRoot.dataset.currentCh) || 1);
      const notes = chapterNotes(b, ch - 1);
      panel.hidden = false;
      panel.innerHTML = `<div class="reader-notes">
        <div class="rn-head"><span>注释 · 第 ${ch} 章 · ${notes.length} 条</span>
          <button class="icon-btn" data-action="panel-close" title="关闭">${icon('close', 'ic-sm')}</button></div>
        <ul class="rn-list">${notes.map((t) => `<li>${esc(t)}</li>`).join('') || '<li>本章没有注释</li>'}</ul>
      </div>`;
    } else if (kind === 'catalog' || kind === 'bookmark') {
      panel.hidden = true; drawer.hidden = false;
      ui.catalogTab = kind;
      const cur = Number(readerRoot.dataset.currentCh) || 1;
      const chs = chapterList(b);
      const marks = bookmarkList(b.id);
      const tabs = `<div class="cat-tabs">
        <button class="${kind === 'catalog' ? 'active' : ''}" data-action="open-panel" data-val="catalog">目录 ${chs.length}</button>
        <button class="${kind === 'bookmark' ? 'active' : ''}" data-action="open-panel" data-val="bookmark">卷签 ${marks.length}</button>
      </div>`;
      const content = kind === 'catalog'
        ? `<div class="cat-search">${icon('search', 'ic-sm')}<input id="catalogSearch" placeholder="搜章节名或序号" autocomplete="off"></div>
          <ul class="catalog-list" id="catalogList">${chs.map((c, i) =>
            `<li class="${i + 1 === cur ? 'active' : ''}" data-action="catalog-goto" data-ch="${i + 1}">${esc(c.title)}<small>${i + 1}</small></li>`).join('')}</ul>
          <div class="cat-nav">
            <button class="btn btn-ghost btn-sm" data-action="reader-prev" ${cur <= 1 ? 'disabled' : ''}>${icon('left', 'ic-sm')} 上一章</button>
            <button class="btn btn-ghost btn-sm" data-action="reader-next" ${cur >= chs.length ? 'disabled' : ''}>下一章 ${icon('right', 'ic-sm')}</button>
          </div>`
        : `<div class="catalog-list bookmark-list">${marks.length ? marks.map((m, i) => `
            <li data-action="bookmark-goto" data-val="${i}">
              <span><b>${esc(m.title)}</b><small>${new Date(m.time).toLocaleDateString('zh-CN')} · 第 ${m.ch} 章${m.page ? ' · 第 ' + (m.page + 1) + ' 页' : ''}</small></span>
              <button class="bm-del" data-action="bookmark-del" data-val="${i}" title="删除卷签">${icon('trash', 'ic-sm')}</button>
            </li>`).join('') : '<div class="cat-empty">还没有卷签<br><small>点顶部的星形按钮，把当前这一页收进卷签</small></div>'}</div>`;
      drawer.innerHTML = `<div class="catalog-head"><span>${esc(b.title)}</span>
          <button class="icon-btn" data-action="panel-close" title="关闭">${icon('close', 'ic-sm')}</button></div>
        ${tabs}${content}`;
    }
    a11ySweep(panel); a11ySweep(drawer);
    /* 读到第 180 章时点开目录，不能让人从第 1 章一路往下滚 */
    if (kind === 'catalog' && !drawer.hidden) {
      const list = drawer.querySelector('#catalogList');
      const act = list && list.querySelector('li.active');
      if (list && act) {
        const lr = list.getBoundingClientRect(), ar = act.getBoundingClientRect();
        list.scrollTop += (ar.top - lr.top) - (lr.height - ar.height) / 2;
      }
    }
    /* 抽屉/设置面板一打开就把焦点送进去，键盘 Tab 才不会又跑回底下的正文 */
    const into = (drawer.hidden ? panel : drawer);
    if (into && !into.hidden) { into.setAttribute('tabindex', '-1'); into.focus({ preventScroll: true }); }
  }
  function closePanel() {
    const mask = $('#readerMask'), panel = $('#readerPanel'), drawer = $('#catalogDrawer');
    const hadFocus = document.activeElement && (document.activeElement === panel || document.activeElement === drawer
      || (panel && panel.contains(document.activeElement)) || (drawer && drawer.contains(document.activeElement)));
    if (mask) mask.hidden = true;
    if (panel) { panel.hidden = true; panel.innerHTML = ''; }
    if (drawer) { drawer.hidden = true; drawer.innerHTML = ''; }
    /* 面板里的元素被清掉了，焦点不能就这么掉在地上 */
    if (hadFocus) { const rd = $('#reader'); if (rd) rd.focus({ preventScroll: true }); }
  }
  function switchChapter(id, ch, pct) {
    const b = getBook(id);
    ch = Math.max(1, Math.min(chapterList(b).length, ch));
    state.progress[id] = { ch, pct: pct || 0, updated: Date.now() };
    state.lastRead = id; save();
    history.replaceState(null, '', '#/reader/' + id + '/' + ch);
    showReader(id, ch);
    closePanel();
  }

  /* ---------- 路由 ---------- */
  function parseRoute() {
    const raw = (location.hash || '#/store').replace(/^#\/?/, '');
    const parts = raw.split('/').filter(Boolean);
    const name = parts[0] || 'store';
    return { name, id: parts[1], ch: Number(parts[2]) || 1, tab: name === 'store' ? (parts[1] || 'home') : '' };
  }
  /* 在线书的目录是懒取的：一键进详情页只有「开卷取回」占位，篇目会显示成 1。
   * 打开详情时补取一次目录，取到就重绘，取不到（离线）就保持占位。 */
  const tocTried = {};
  async function hydrateOnlineToc(id, force) {
    const b = getBook(id);
    if (!b || !b.online || tocTried[id]) return;
    if (!force && (b.chapters || []).length > 1) return;
    const src = SRC.get(b.sourceId);
    if (!src || typeof src.getBookMeta !== 'function') return;
    tocTried[id] = true;
    ui.tocLoading = true; ui.tocFailed = false;
    const cur = parseRoute();
    if (cur.name === 'book' && cur.id === id) { const box = $('#tocPanel'); if (box) box.innerHTML = tocLoadingHtml(); }
    try {
      const m = await src.getBookMeta(id, { force });
      if (m && m.chapters && m.chapters.length > 1) {
        b.chapters = m.chapters;
      } else if (force) {
        ui.tocFailed = true;
      }
    } catch (e) { if (force) ui.tocFailed = true; }
    ui.tocLoading = false;
    /* 取失败不把 tocTried 钉死：这次离线、下次重进详情页（可能已恢复网络）还有机会自动重取，
       不必非得靠手动「重试」按钮。 */
    if ((b.chapters || []).length <= 1) tocTried[id] = false;
    const now = parseRoute();
    if (now.name === 'book' && now.id === id) render();
  }

  function tocLoadingHtml() {
    return `<div class="toc-status">${icon('refresh', 'ic-sm')} 正在取回目录 …</div>`;
  }
  function renderNav(active) {
    $('#sideNav').innerHTML = NAV.map((n) => `<button class="nav-item ${n.key === active ? 'active' : ''}" data-go="${n.key}">
      ${icon(n.icon)}<span>${n.label}</span>${n.key === 'shelf' && state.shelf.length ? `<span class="badge">${state.shelf.length}</span>` : ''}</button>`).join('');
    $('#bottomNav').innerHTML = NAV.map((n) => `<button class="${n.key === active ? 'active' : ''}" data-go="${n.key}">
      ${icon(n.icon)}<span>${n.label}</span></button>`).join('');
  }
  function render() {
    const r = parseRoute();
    if (r.name === 'reader') { showReader(r.id, r.ch); return; }
    hideReader();
    if (r.name !== 'shelf') closeShelfMenu();
    ui.nav = NAV.some((n) => n.key === r.name) ? r.name
      : (['book', 'search', 'category', 'rank'].includes(r.name) ? 'store' : ui.nav);
    renderNav(ui.nav);
    let html;
    switch (r.name) {
      case 'store': html = storeHtml(['category', 'rank'].includes(r.tab) ? r.tab : 'home'); break;
      case 'category': case 'rank': {
        /* 旧链接平滑迁到书肆子页，底部仍高亮「书肆」 */
        try { history.replaceState(null, '', '#/store/' + r.name); } catch (e) { /* file:// 忽略 */ }
        html = storeHtml(r.name); break;
      }
      case 'shelf': html = pageShelf(); break;
      case 'search': html = pageSearch(); break;
      case 'book': html = pageBook(r.id); break;
      case 'me': html = pageMe(); break;
      default: html = storeHtml('home');
    }
    view.innerHTML = html;
    a11ySweep(view);
    markScrollableRows(view);
    window.scrollTo(0, pendingScroll);
    pendingScroll = 0;
    if (r.name === 'search') {
      renderSearchBody('');
      const input = $('#searchInput');
      if (input) setTimeout(() => input.focus(), 60);
    }
    startBanner(r.name === 'store' && (r.tab || 'home') === 'home');
    if (r.name === 'book') hydrateOnlineToc(r.id);
  }
  function startBanner(on) {
    clearInterval(bannerTimer); bannerTimer = null;
    if (!on) return;
    /* 系统设了「减少动态效果」就不自动轮播，只留手动切换 */
    if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    bannerTimer = setInterval(() => {
      if (document.hidden || parseRoute().name !== 'store') return;
      const box = $('#bannerBox'); if (!box) return;
      /* 鼠标停在横幅上、或键盘焦点在横幅里时不换卷：
         重绘会把用户正在操作的按钮冲掉，焦点跟着掉回 body */
      if (box.matches(':hover')) return;
      const ae = document.activeElement;
      if (ae && ae.closest && ae.closest('#bannerBox')) return;
      ui.banner = (ui.banner + 1) % D.BANNERS.length;
      box.innerHTML = bannerHtml();
      a11ySweep(box);
    }, 5200);
  }

  /* ---------- 主题 ---------- */
  function applyTheme() {
    document.body.dataset.theme = state.settings.theme === 'night' ? 'night' : 'day';
    const u = $('#themeIcon use'); if (u) u.setAttribute('href', state.settings.theme === 'night' ? '#i-sun' : '#i-moon');
    const meta = $('meta[name="theme-color"]'); if (meta) meta.setAttribute('content', state.settings.theme === 'night' ? '#14181a' : '#f5f1e8');
  }

  /* ---------- 事件 ---------- */
  document.addEventListener('click', (e) => {
    if (ui.longPressed) { ui.longPressed = false; e.preventDefault(); return; }
    const goEl = e.target.closest('[data-go]');
    if (goEl) { go(goEl.dataset.go); return; }
    const el = e.target.closest('[data-action]');
    if (!el) {
      if (e.target.closest('#readerBody') && !e.target.closest('button')) {
        if (ui.flipSwiped) { ui.flipSwiped = false; return; }
        if (state.settings.pageMode === 'flip' && $('#reader')) {
          const rect = $('#readerBody').getBoundingClientRect();
          const x = (e.clientX - rect.left) / rect.width;
          if (x < 0.32) { flipBy(-1); return; }
          if (x > 0.68) { flipBy(1); return; }
        }
        $('#readerTop').classList.toggle('ctrl-hidden');
        $('#readerBottom').classList.toggle('ctrl-hidden');
      }
      return;
    }
    const a = el.dataset.action, id = el.dataset.id, val = el.dataset.val, ch = Number(el.dataset.ch);
    switch (a) {
      case 'open-search': go('search'); break;
      case 'import-books': $('#fileInput').click(); break;
      case 'export-backup': exportBackup(); break;
      case 'import-backup': $('#backupFileInput').click(); break;
      case 'delete-local': deleteLocalBook(id); break;
      case 'edit-local': openMetaEditor(id); break;
      case 'meta-close': closeMetaEditor(); break;
      case 'meta-save': {
        const bid = ui.metaDraft; if (!bid) break;
        const ti = $('#metaTitle'), ai = $('#metaAuthor');
        /* 卷名/作者会被直接拼进封面与卡片 HTML，尖括号与 & 必须换成全角，否则等于允许注入标签 */
        const plain = (s) => String(s || '').replace(/[<>&]/g, (c) => ({ '<': '〈', '>': '〉', '&': '＆' }[c]));
        const title = plain(((ti && ti.value) || '').trim());
        const author = plain(((ai && ai.value) || '').trim());
        if (!title) { toast('卷名不能为空'); break; }
        const b = state.localBooks.find((x) => x.id === bid); if (!b) break;
        b.title = title;
        b.author = author || '本地导入';
        b.seal = title.replace(/[《》\s]/g, '').charAt(0) || '卷';
        save(); closeMetaEditor(); rerender();
        toast('已更新卷册信息');
        break;
      }
      case 'go-shelf': go('shelf'); break;
      case 'go-store': go('store'); break;
      case 'go-rank': go('store/rank'); break;
      case 'history-back': history.length > 1 ? history.back() : go('store'); break;
      case 'toggle-theme':
        state.settings.theme = state.settings.theme === 'night' ? 'day' : 'night';
        save(); applyTheme(); rerender();
        toast(state.settings.theme === 'night' ? '已切换夜墨模式' : '已回到宣纸日光'); break;
      case 'open-book': go('book/' + id); break;
      case 'toggle-source': {
        const s = SRC.get(id); if (!s) break;
        SRC.setEnabled(id, s.enabled === false);
        markSource(id, s.enabled === false);
        save();
        (async () => { await SRC.refresh(); rerender(); })();
        toast((s.enabled === false ? '已停用 ' : '已启用 ') + s.name);
        break;
      }
      case 'add-source': openSourceEditor(); break;
      case 'source-close': closeSourceEditor(); break;
      case 'source-save': {
        const ta = $('#sourceCode');
        const code = ta ? ta.value.trim() : '';
        if (!code) { toast('先写点代码'); break; }
        const before = SRC.list().map((s) => s.id).join('|');
        try { runSourceCode(code); } catch (e) { toast('书源代码有误：' + (e && e.message ? e.message : '未知错误')); break; }
        const after = SRC.list().map((s) => s.id).join('|');
        if (after === before) { toast('这段代码没有注册任何书源（需要调用 MJ.sources.register）'); break; }
        const list = customSources();
        list.push(code);
        saveCustomSources(list);
        closeSourceEditor();
        (async () => { await SRC.refresh(); renderNav(ui.nav); rerender(); })();
        toast('书源已接入');
        break;
      }
      case 'shelf-read': {
        const p = state.progress[id] || { ch: 1 };
        go('reader/' + id + '/' + (p.ch || 1)); break;
      }
      case 'close-shelf-menu': closeShelfMenu(); break;
      case 'shelf-menu-detail': closeShelfMenu(); go('book/' + id); break;
      case 'shelf-menu-pin': {
        const pinned = state.pinned.includes(id);
        state.pinned = pinned ? state.pinned.filter((x) => x !== id) : [id].concat(state.pinned);
        save(); closeShelfMenu(); toast(pinned ? '已取消置顶' : '已置顶'); rerender(); break;
      }
      case 'shelf-menu-remove': {
        state.shelf = state.shelf.filter((x) => x !== id);
        save(); renderNav(ui.nav); closeShelfMenu(); toast('已从藏卷移出'); rerender(); break;
      }
      case 'shelf-menu-manage': {
        closeShelfMenu();
        ui.editMode = true; ui.selected.clear(); ui.selected.add(id);
        rerender(); break;
      }
      case 'open-cover': openCoverEditor(id); break;
      case 'cover-close': closeCoverEditor(); break;
      case 'cover-motif': {
        if (!ui.coverDraft) break;
        ui.coverDraft.draft.motif = val; ui.coverDraft.draft.image = null;
        renderCoverEditor(); break;
      }
      case 'cover-color': {
        if (!ui.coverDraft) break;
        ui.coverDraft.draft.color = val;
        ui.coverDraft.draft.color2 = el.dataset.val2;
        ui.coverDraft.draft.image = null;
        renderCoverEditor(); break;
      }
      case 'cover-toggle-text': {
        if (!ui.coverDraft) break;
        ui.coverDraft.draft.hideText = !e.target.checked; break;
      }
      case 'cover-upload': $('#coverFileInput').click(); break;
      case 'cover-save': {
        if (!ui.coverDraft) break;
        const cd = ui.coverDraft, d = cd.draft;
        const c = { motif: d.motif, color: d.color, color2: d.color2, seal: d.seal, hideText: !!d.hideText };
        if (d.image) c.image = d.image;
        state.covers[cd.id] = c;
        const ok = save();
        closeCoverEditor();
        toast(ok ? '封面已更换' : '已应用，但本机空间不足无法长期保存');
        rerender(); break;
      }
      case 'cover-reset': {
        if (!ui.coverDraft) break;
        const b = getBook(ui.coverDraft.id);
        delete state.covers[ui.coverDraft.id]; save();
        ui.coverDraft.draft = {
          motif: b.motif, color: b.color, color2: b.color2,
          seal: b.seal, image: null, hideText: false
        };
        renderCoverEditor();
        rerender();
        toast('已恢复默认封面'); break;
      }
      case 'start-read': case 'continue-read': {
        const p = state.progress[id] || { ch: 1 };
        go('reader/' + id + '/' + (p.ch || 1)); break;
      }
      case 'open-chapter': go('reader/' + id + '/' + ch); break;
      case 'open-catalog': go('reader/' + id + '/' + (state.progress[id] ? state.progress[id].ch : 1));
        setTimeout(() => openPanel('catalog'), 60); break;
      case 'retry-toc': tocTried[id] = false; ui.tocFailed = false; hydrateOnlineToc(id, true); break;
      case 'add-shelf':
        e.stopPropagation();
        if (state.shelf.includes(id)) { toast('这卷已经在藏卷上了'); break; }
        state.shelf.unshift(id); state.added[id] = Date.now(); save(); renderNav(ui.nav);
        toast('已收入藏卷'); rerender(); break;
      case 'remove-shelf':
        state.shelf = state.shelf.filter((x) => x !== id); save(); renderNav(ui.nav); toast('已从藏卷移出'); rerender(); break;
      case 'toggle-edit':
        ui.editMode = !ui.editMode; ui.selected.clear(); closeShelfActions(); rerender(); break;
      case 'pick-book': {
        if (ui.selected.has(id)) ui.selected.delete(id); else ui.selected.add(id);
        rerender(); break;
      }
      case 'select-all': {
        const ids = ui.shelfVisibleIds.slice();
        const allSel = ids.length > 0 && ids.every((x) => ui.selected.has(x));
        ui.selected = allSel ? new Set() : new Set(ids);
        rerender(); break;
      }
      case 'set-shelf-filter': ui.shelfFilter = val; rerender(); break;
      case 'open-shelf-actions': openShelfActions(); break;
      case 'close-shelf-actions': closeShelfActions(); break;
      case 'bulk-pin': {
        const ids = Array.from(ui.selected);
        if (val === 'unpin') state.pinned = state.pinned.filter((x) => !ui.selected.has(x));
        else ids.forEach((x) => { if (!state.pinned.includes(x)) state.pinned.unshift(x); });
        save(); toast(val === 'unpin' ? '已取消置顶' : '已置顶 ' + ids.length + ' 卷');
        openShelfActions(); rerender(); break;
      }
      case 'bulk-tag': {
        ui.selected.forEach((x) => { if (val) state.bookTags[x] = val; else delete state.bookTags[x]; });
        save(); toast(val ? '已标记为「' + TAG_LABEL[val] + '」' : '已清除标记');
        rerender(); break;
      }
      case 'bulk-reset-progress': {
        ui.selected.forEach((x) => { state.progress[x] = { ch: 1, pct: 0, updated: Date.now() }; });
        save(); toast('已重置读墨进度'); rerender(); break;
      }
      case 'bulk-cover-motif': case 'bulk-cover-color': {
        ui.selected.forEach((x) => {
          const b = getBook(x); if (!b) return;
          const c = Object.assign({}, state.covers[x] || {});
          delete c.image;
          if (a === 'bulk-cover-motif') c.motif = val;
          else { c.color = val; c.color2 = el.dataset.val2; }
          if (!c.color) { c.color = b.color; c.color2 = b.color2; }
          if (!c.motif) c.motif = b.motif;
          state.covers[x] = c;
        });
        save(); toast('已批量更换封面'); rerender(); break;
      }
      case 'bulk-copy-list':
        copyText(shelfListText(Array.from(ui.selected))).then((ok) =>
          toast(ok ? '卷单已复制到剪贴板' : '复制失败，可改用「下载卷单」'));
        break;
      case 'bulk-export-list':
        toast(downloadText('墨卷-卷单.txt', shelfListText(Array.from(ui.selected))) ? '卷单已下载' : '下载失败');
        break;
      case 'bulk-export-books': exportLocalBooks(Array.from(ui.selected)); break;
      case 'batch-remove': {
        const ids = Array.from(ui.selected);
        if (!ids.length) break;
        state.shelf = state.shelf.filter((x) => !ui.selected.has(x));
        state.pinned = state.pinned.filter((x) => !ui.selected.has(x));
        if (ui.selected.has(state.lastRead)) state.lastRead = state.shelf[0] || '';
        save(); ui.editMode = false; ui.selected.clear(); closeShelfActions();
        renderNav(ui.nav); toast('已移出藏卷 ' + ids.length + ' 卷（卷还在书肆里）'); rerender(); break;
      }
      case 'batch-delete': {
        const ids = Array.from(ui.selected).filter((x) => (getBook(x) || {}).local);
        if (!ids.length) { toast('选中的都不是本地卷'); break; }
        if (!confirm('彻底删除选中的 ' + ids.length + ' 卷本地卷？正文和读墨进度都会移除，不可撤销。')) break;
        closeShelfActions();
        removeLocalBooks(ids).then(() => {
          ui.editMode = false; ui.selected.clear();
          renderNav(ui.nav); toast('已彻底删除 ' + ids.length + ' 卷本地卷'); rerender();
        });
        break;
      }
      case 'go-local-list': {
        const t = $('#localList');
        if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
        else toast('还没有导入本地卷');
        break;
      }
      case 'toggle-view': state.viewMode = val; save(); rerender(); break;
      case 'set-cat': ui.cat = val; rerender(); break;
      case 'set-status': ui.status = val; rerender(); break;
      case 'set-sortby': ui.sortBy = val; rerender(); break;
      case 'set-ranktab': ui.rankTab = val; rerender(); break;
      case 'quick-cat': ui.cat = val; ui.status = '全部'; go('store/category'); break;
      case 'banner-dot': {
        ui.banner = Number(val);
        const bb = $('#bannerBox');
        if (bb) {
          bb.innerHTML = bannerHtml(); a11ySweep(bb);
          /* 换卷后把焦点还给同一序号的新圆点，键盘连按才接得上 */
          const nd = bb.querySelector('.banner-dot[data-val="' + val + '"]');
          if (nd) nd.focus({ preventScroll: true });
        }
        break;
      }
      case 'shuffle': {
        const pick = (arr, n) => arr.slice().sort(() => Math.random() - 0.5).slice(0, n);
        const box = $('#editorPick'); if (box) {
          box.innerHTML = pick(allBooks(), 8).map((b) => bookCard(b, { badge: charNum(b) >= 100000 ? '长卷' : '' })).join('');
          a11ySweep(box);
        }
        const fy = $('#forYou'); if (fy) {
          fy.innerHTML = pick(allBooks().filter((b) => !state.shelf.includes(b.id)), 7).map((b) => bookCard(b)).join('');
          a11ySweep(fy);
        }
        /* 换荐按钮本身没被替换，焦点不用特意找回来 */
        toast('换了一批荐读'); break;
      }
      case 'toggle-desc': ui.descOpen = !ui.descOpen; $('#bookDesc').classList.toggle('clamp');
        el.innerHTML = (ui.descOpen ? '收起' : '展开简介') + ' ' + icon('right', 'ic-sm'); break;
      case 'hot-word': {
        const input = $('#searchInput');
        if (input) input.value = val;
        commitSearch(val); renderSearchBody(val); break;
      }
      case 'clear-query': { const input = $('#searchInput'); if (input) { input.value = ''; input.focus(); } renderSearchBody(''); break; }
      case 'clear-history': state.history = []; save(); renderSearchBody(''); toast('寻卷记录已清空'); break;
      case 'set-goal':
        state.dailyGoal = Number(val) || 30; save(); rerender();
        toast('今日读墨目标设为 ' + state.dailyGoal + ' 分钟'); break;
      case 'checkin': {
        const ck = state.checkin;
        const t = today();
        if (ck.last === t) break;
        /* 老版本没有 streak，就用 days（当时记的也是连续天数）接上 */
        const prev = ck.streak || ck.days || 0;
        ck.streak = ck.last === yesterday() ? prev + 1 : 1;
        ck.days = (ck.days || 0) + 1;
        ck.last = t;
        ck.hist = (Array.isArray(ck.hist) ? ck.hist : []).concat(t).slice(-30);
        save(); rerender();
        toast(ck.streak > 1 ? `今日已开卷 · 连续 ${ck.streak} 天` : '今日已开卷');
        break;
      }
      case 'set-fontfamily': {
        state.settings.font = FONT_STACKS[val] ? val : 'song'; save();
        restyleReader();
        $$('[data-action=set-fontfamily]').forEach((p) => p.classList.toggle('active', p.dataset.val === state.settings.font));
        if (!$('#reader')) rerender();
        break;
      }
      case 'set-font': {
        if (val === '+' || val === '-') state.settings.fs = Math.max(15, Math.min(28, state.settings.fs + (val === '+' ? 1 : -1)));
        else state.settings.fs = Number(val);
        save(); restyleReader();
        if (!$('#reader')) { rerender(); break; }
        $$('#readerPanel .rs-pill').forEach((p) => { if (p.dataset.action === 'set-font') p.classList.toggle('active', Number(p.dataset.val) === state.settings.fs); });
        break;
      }
      case 'set-lh': {
        state.settings.lh = Number(val); save(); restyleReader();
        if (!$('#reader')) { rerender(); break; }
        /* 只改高亮，不重建面板——重建会把面板滚回顶部，调一次行距跳一次，很难用 */
        $$('#readerPanel .rs-pill').forEach((p) => { if (p.dataset.action === 'set-lh') p.classList.toggle('active', Number(p.dataset.val) === state.settings.lh); });
        break;
      }
      case 'set-paper':
        state.settings.paper = val; save(); applyReaderStyle();
        if (!$('#reader')) { rerender(); break; }
        $$('#readerPanel .rs-pill').forEach((p) => { if (p.dataset.action === 'set-paper') p.classList.toggle('active', p.dataset.val === val); });
        break;
      case 'set-pagemode':
        state.settings.pageMode = val; save();
        if ($('#reader')) {
          closePanel();
          showReader(readerRoot.dataset.currentBook, Number(readerRoot.dataset.currentCh));
        } else rerender();
        break;
      case 'set-flipanim':
        state.settings.flipAnim = val; save();
        $$('#readerPanel .rs-pill').forEach((p) => { if (p.dataset.action === 'set-flipanim') p.classList.toggle('active', p.dataset.val === val); });
        break;
      case 'reset-data':
        if (confirm('确定清空藏卷、进度、设置和已导入的本地卷吗？此操作不可撤销。')) {
          const ids = state.localBooks.map((b) => b.id);
          localStorage.removeItem(KEY); state = structuredClone(DEFAULTS); save();
          ids.forEach((x) => { deleteContent(x).catch(() => {}); delete contentCache[x]; });
          applyTheme(); go('shelf'); toast('已恢复初始状态');
        }
        break;
      /* 阅读器 */
      case 'reader-back':
        if (history.length > 1) history.back(); else go('book/' + readerRoot.dataset.currentBook);
        break;
      case 'reader-catalog': openPanel('catalog'); break;
      case 'reader-settings': openPanel('settings'); break;
      case 'panel-close': closePanel(); break;
      case 'reader-prev': switchChapter(readerRoot.dataset.currentBook, Number(readerRoot.dataset.currentCh) - 1); break;
      case 'reader-next': switchChapter(readerRoot.dataset.currentBook, Number(readerRoot.dataset.currentCh) + 1); break;
      case 'reader-retry': {
        /* 断网时点「重新取回」：把这一章的失败结果从缓存里清掉再拉一次 */
        const rid = readerRoot.dataset.currentBook, rch = Number(readerRoot.dataset.currentCh) || 1;
        const rec = contentCache[rid];
        if (rec && rec.chapters) delete rec.chapters[rch - 1];
        toast('正在重新取回…');
        showReader(rid, rch); break;
      }
      case 'flip-prev': flipBy(-1); break;
      case 'flip-next': flipBy(1); break;
      case 'catalog-goto': switchChapter(readerRoot.dataset.currentBook, ch); break;
      case 'toggle-bookmark': toggleBookmark(); break;
      case 'toggle-tts':
        openListen(readerRoot.dataset.currentBook, Number(readerRoot.dataset.currentCh) || 1);
        break;
      case 'listen-close': {
        listenStopAll();
        if (history.state && history.state.mojuanListen) history.back();
        break;
      }
      case 'listen-minimize': listen.expanded = false; renderListen(); break;
      case 'listen-expand': listen.expanded = true; renderListen(); break;
      case 'listen-toggle': listenToggle(); break;
      case 'listen-prev':
        if (listen.ch > 1) listenGoChapter(listen.ch - 1, true);
        else toast('已经是第一章了');
        break;
      case 'listen-next': {
        const b = getBook(listen.bookId);
        if (b && listen.ch < chapterList(b).length) listenGoChapter(listen.ch + 1, true);
        else toast('已经是最后一章了');
        break;
      }
      case 'listen-panel': listenPanel(val); break;
      case 'listen-panel-close': {
        const p = $('#listenPanel');
        if (p) { p.hidden = true; p.innerHTML = ''; }
        break;
      }
      case 'listen-voice': {
        listen.voiceURI = val;
        state.settings.voiceURI = val; save();
        listenPanel('voice');
        if (listen.playing) listenSpeak(true);
        break;
      }
      /* 试听：只念一句短的，不选中、不动朗读进度 */
      case 'listen-voice-try': {
        if (!speechOK()) { toast('这台设备不支持语音朗读'); break; }
        if (listen.playing) { toast('听卷进行中，先暂停再试听'); break; }
        const all = speechSynthesis.getVoices() || [];
        const v = all.find((x) => x.voiceURI === val);
        if (!v) { toast('这个音色已不在设备上'); break; }
        try { speechSynthesis.cancel(); } catch (_) { /* 忽略 */ }
        const u = new SpeechSynthesisUtterance('此间有墨一卷，静听即是山林。');
        u.voice = v; u.lang = v.lang || 'zh-CN'; u.rate = listen.rate || 1;
        speechSynthesis.speak(u);
        break;
      }
      case 'voice-config': openVoiceConfig(); break;
      case 'close-voice-config': closeVoiceConfig(); break;
      case 'voice-provider': {
        voiceSaveForm();
        const v = VOICE();
        if (v) v.setConfig({ provider: val });
        renderVoiceModal();
        voiceCacheInfo();
        break;
      }
      case 'voice-save': {
        voiceSaveForm();
        const v = VOICE();
        closeVoiceConfig();
        const on = v && v.active();
        toast(on ? '已切到 ' + v.activeLabel() : '已用系统语音');
        if (listen.active) {
          listen.remoteOff = false;
          remoteWarned = false;
          listenPanel('voice');
          if (listen.playing) listenSpeak(true);
        }
        break;
      }
      case 'voice-clear-audio': {
        audioIDB('readwrite', (st) => st.clear());
        audioCache.clear();
        toast('已清除听书音频缓存');
        voiceCacheInfo();
        break;
      }
      case 'voice-test': {
        voiceSaveForm();
        const v = VOICE();
        if (!v || !v.active()) { toast('先填好密钥再试听'); break; }
        toast('正在合成…');
        v.synth('子曰：学而时习之，不亦说乎？有朋自远方来，不亦乐乎。', { rate: 1 }).then((blob) => {
          const a = new Audio(URL.createObjectURL(blob));
          a.play().then(() => toast('这就是这个音色的声音')).catch(() => toast('合成好了，但浏览器拦住了播放'));
        }).catch((e) => toast(e.message || '合成失败'));
        break;
      }
      case 'listen-timer': {
        listen.timerMin = Number(val);
        clearTimeout(listenTimer);
        if (listen.timerMin) {
          listen.timerAt = Date.now() + listen.timerMin * 60000;
          listenTimer = setTimeout(() => { listenStopAll(); toast('定时结束，已停止听卷'); }, listen.timerMin * 60000);
        } else listen.timerAt = 0;
        listenPanel('timer'); listenRenderDynamic();
        toast(listen.timerMin ? '将在 ' + listen.timerMin + ' 分钟后停止' : '已取消定时');
        break;
      }
      case 'listen-chapter': {
        const p = $('#listenPanel');
        if (p) { p.hidden = true; p.innerHTML = ''; }
        listenGoChapter(Number(val), true);
        break;
      }
      case 'listen-seek': {
        const track = e.target.closest('.progress-line');
        if (!track || !listen.text) break;
        const rect = track.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        /* 拖到哪就从那一句开始念，别从半句话中间切 */
        const target = Math.floor(ratio * listen.text.length);
        let hit = 0;
        listen.sents.forEach((sn, k) => { if (sn.start <= target) hit = k; });
        listen.sentIndex = hit;
        const hs = listen.sents[hit];
        listen.charIndex = hs ? hs.start : 0;
        listen.paraIndex = hs ? hs.para : 0;
        listen.elapsed = ratio * (listen.text.length / Math.max(1, listen.rate * 4.6));
        if (listen.playing) listenSpeak(true); else listenRenderDynamic();
        break;
      }
      case 'open-panel': openPanel(val); break;
      case 'open-notes': openPanel('notes'); break;
      case 'set-rate': applyRate(val); break;
      case 'reader-step': {
        const bid = readerRoot.dataset.currentBook; if (!bid) break;
        const total = chapterList(getBook(bid)).length;
        const target = (Number(readerRoot.dataset.currentCh) || 1) + Number(val);
        if (target < 1) { toast('已经是第一章'); break; }
        if (target > total) { toast('已经是最后一章'); break; }
        switchChapter(bid, target);
        break;
      }
      case 'reader-shelf-toggle': {
        const bid = readerRoot.dataset.currentBook; if (!bid) break;
        const inShelf = state.shelf.includes(bid);
        if (inShelf) state.shelf = state.shelf.filter((x) => x !== bid);
        else { state.shelf.unshift(bid); state.added[bid] = Date.now(); }
        save(); renderNav(ui.nav); syncReaderMenu();
        toast(inShelf ? '已从藏卷移出' : '已收入藏卷');
        break;
      }
      case 'reader-theme-toggle': {
        const night = state.settings.paper !== 'night';
        if (night) {
          state.settings.lastDayPaper = state.settings.paper === 'night' ? (state.settings.lastDayPaper || 'xuan') : state.settings.paper;
          state.settings.paper = 'night';
        } else state.settings.paper = state.settings.lastDayPaper || 'xuan';
        state.settings.theme = night ? 'night' : 'day';
        save(); applyTheme(); applyReaderStyle(); syncReaderMenu();
        $$('#readerPanel .rs-pill').forEach((p) => {
          if (p.dataset.action === 'set-paper') p.classList.toggle('active', p.dataset.val === state.settings.paper);
        });
        toast(night ? '已切换夜墨模式' : '已回到宣纸日光');
        break;
      }
      case 'bookmark-goto': {
        const bid = readerRoot.dataset.currentBook;
        const m = bookmarkList(bid)[Number(val)];
        if (!m) break;
        ui.flipTargetPage = m.page || 0;
        switchChapter(bid, m.ch, m.pct || 0);
        break;
      }
      case 'bookmark-del': {
        const bid = readerRoot.dataset.currentBook;
        const list = bookmarkList(bid).slice();
        list.splice(Number(val), 1);
        state.bookmarks[bid] = list; save();
        openPanel('bookmark'); syncBookmarkBtn(); toast('已删除卷签');
        break;
      }
      case 'bookmark-del-global': {
        const list = bookmarkList(id).slice();
        list.splice(Number(val), 1);
        state.bookmarks[id] = list; save(); rerender(); toast('已删除卷签');
        break;
      }
      case 'open-bookmark': {
        const m = bookmarkList(id)[Number(val)];
        if (!m) { toast('卷签已不存在'); break; }
        ui.flipTargetPage = m.page || 0;
        go('reader/' + id + '/' + m.ch);
        break;
      }
    }
    if (el.id === 'readerMask') closePanel();
  });
  document.addEventListener('click', (e) => { if (e.target.id === 'readerMask') closePanel(); });
  document.addEventListener('input', (e) => {
    if (e.target.matches && e.target.matches('[data-rate-slider]')) {
      const r = clampRate(e.target.value);
      fillRateTrack(e.target);
      const box = e.target.closest('[data-rate-box]');
      if (box) {
        const v = box.querySelector('.rate-val'); if (v) v.textContent = fmtRate(r) + '×';
        box.querySelectorAll('.rate-preset').forEach((b) => b.classList.toggle('active', Math.abs(Number(b.dataset.val) - r) < 0.001));
      }
      return;
    }
    if (e.target.id === 'searchInput') {
      /* 逐键过滤 71 卷并扫章节在手机上会卡，轻量防抖：停输 120ms 才重渲 */
      clearTimeout(searchTimer);
      const v = e.target.value;
      searchTimer = setTimeout(() => renderSearchBody(v), 120);
    }
    if (e.target.id === 'catalogSearch') {
      /* 长篇在线书目录上千条，逐键遍历全部 <li> 会卡，轻量防抖：停输 120ms 才过滤 */
      clearTimeout(catalogSearchTimer);
      const el = e.target;
      catalogSearchTimer = setTimeout(() => {
        const q = el.value.trim().toLowerCase();
        $$('#catalogList li').forEach((li) => { li.hidden = !!q && !li.textContent.toLowerCase().includes(q); });
      }, 120);
    }
  });
  /* 拖动松手才真正应用，避免播放中每移动一像素就重启朗读 */
  document.addEventListener('change', (e) => {
    if (e.target.matches && e.target.matches('[data-rate-slider]')) applyRate(e.target.value);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (ui.coverDraft) { closeCoverEditor(); return; }
      if (ui.metaDraft) { closeMetaEditor(); return; }
      if ($('#shelfMenu')) { closeShelfMenu(); return; }
      if (listen.active) { listenStopAll(); return; }
      const panel = $('#readerPanel');
      if (panel && !panel.hidden) { closePanel(); return; }
      if (readerRoot.dataset.currentBook) {
        if (history.length > 1) history.back(); else go('book/' + readerRoot.dataset.currentBook);
        return;
      }
    }
    /* div/li 补成按钮之后，回车与空格还得能真的按下去 */
    const act = document.activeElement;
    if (act && !NATIVE_CTL.test(act.tagName) && act.dataset && act.dataset.action
      && act.getAttribute('role') === 'button' && (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar')) {
      e.preventDefault();
      act.click();
      return;
    }
    const inReader = !!readerRoot.dataset.currentBook;
    if (inReader && /INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
    if (inReader) {
      const paging = state.settings.pageMode === 'flip' && $('#reader');
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        paging ? flipBy(-1) : switchChapter(readerRoot.dataset.currentBook, Number(readerRoot.dataset.currentCh) - 1);
      }
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
        if (e.key === ' ') e.preventDefault();
        paging ? flipBy(1) : switchChapter(readerRoot.dataset.currentBook, Number(readerRoot.dataset.currentCh) + 1);
      }
      return;
    }
    if (e.key === '/' && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); go('search'); }
    if (e.key === 'Enter' && document.activeElement.id === 'searchInput') {
      commitSearch(document.activeElement.value); renderSearchBody(document.activeElement.value);
    }
  });

  /* ---------- 文件选择 / 拖放导入 ---------- */
  $('#fileInput').addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length) importFiles(e.target.files);
    e.target.value = '';
  });
  $('#backupFileInput').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) {
      const fr = new FileReader();
      fr.onload = () => restoreBackup(fr.result);
      fr.onerror = () => toast('备份文件读取失败');
      fr.readAsText(f, 'utf-8');
    }
    e.target.value = '';
  });
  /* 封面图片选择器常驻，避免每次打开编辑器重复创建 */
  const coverInput = document.createElement('input');
  coverInput.id = 'coverFileInput'; coverInput.type = 'file'; coverInput.accept = 'image/*'; coverInput.hidden = true;
  document.body.appendChild(coverInput);
  coverInput.addEventListener('change', (ev) => {
    const f = ev.target.files && ev.target.files[0];
    if (f && ui.coverDraft) compressCover(f, (src) => {
      if (!ui.coverDraft) return;
      ui.coverDraft.draft.image = src;
      renderCoverEditor();
      toast('图片已裁好，点「保存封面」生效');
    });
    ev.target.value = '';
  });
  const dropHint = $('#dropHint');
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  document.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth += 1; dropHint.hidden = false;
  });
  document.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  document.addEventListener('dragleave', (e) => {
    e.preventDefault(); dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) dropHint.hidden = true;
  });
  document.addEventListener('drop', (e) => {
    e.preventDefault(); dragDepth = 0; dropHint.hidden = true;
    if (e.dataTransfer && e.dataTransfer.files.length) importFiles(e.dataTransfer.files);
  });

  /* 长按藏卷卡片 → 弹出选择菜单（展卷细看 / 更多操作 / 取消） */
  let pressTimer = null, pressId = null, pressStart = null, menuJustOpened = false;
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const card = e.target.closest('.book-card, .book-row');
    if (!card || ui.editMode || parseRoute().name !== 'shelf' || !card.dataset.shelfCard) return;
    pressId = card.dataset.id;
    pressStart = { x: e.clientX, y: e.clientY };
    pressTimer = setTimeout(() => {
      pressTimer = null;
      if (!pressId) return;
      openShelfMenu(pressId);
      menuJustOpened = true;
      pressId = null;
    }, 500);
  });
  document.addEventListener('pointermove', (e) => {
    /* 手指轻微抖动不取消长按，滑动超过阈值才算滚动 */
    if (pressTimer && pressStart && Math.abs(e.clientX - pressStart.x) + Math.abs(e.clientY - pressStart.y) > 12) {
      clearTimeout(pressTimer); pressTimer = null;
    }
  });
  document.addEventListener('pointerup', () => {
    clearTimeout(pressTimer); pressTimer = null;
    /* 松手会带出一次 click，精确吞掉它，避免长按后又直接跳进阅读器 */
    if (menuJustOpened) {
      menuJustOpened = false;
      ui.longPressed = true;
      setTimeout(() => { ui.longPressed = false; }, 400);
    }
  });
  document.addEventListener('pointercancel', () => {
    clearTimeout(pressTimer); pressTimer = null; menuJustOpened = false;
  });

  let flipResizeTimer = null;
  window.addEventListener('resize', () => {
    markScrollableRows($('#view'));
    if (state.settings.pageMode !== 'flip' || !$('#reader')) return;
    clearTimeout(flipResizeTimer);
    flipResizeTimer = setTimeout(reflowFlip, 200);
  });

  /* 路由切换（App 内导航）不再停听书——退出阅读器后朗读收成迷你条继续。
     真正离开页面（关标签/刷新）时由 pagehide 统一收尾。 */
  if (speechOK()) {
    try {
      speechSynthesis.addEventListener('voiceschanged', () => {
        const p = $('#listenPanel');
        if (listen.active && p && !p.hidden && p.dataset.kind === 'voice') listenPanel('voice');
      });
    } catch (e) { /* 忽略 */ }
  }

  /* ---------- 启动 ---------- */
  applyTheme();
  if (!location.hash) location.replace('#/store');
  /* 路由切换后，原来持有焦点的按钮已被 innerHTML 换掉，
     焦点会掉回 body —— 键盘用户再按 Tab 就要从页首重来一遍。
     这里把焦点交给内容容器，读屏也会跟着播报新页面。 */
  window.addEventListener('hashchange', () => {
    const lost = document.activeElement === document.body || document.activeElement === null;
    render();
    if (lost && !$('#reader')) { const v = $('#view'); if (v) v.focus({ preventScroll: true }); }
  });
  /* 书源：内置源在脚本载入时已同步进索引（首屏即有书）；这里再聚合在线源与自定义源 */
  sourcesReady = restoreCustomSources();
  render();
  sourcesReady.then(() => {
    renderNav(ui.nav);
    if (!$('#reader')) render();
  }).catch(() => {});
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').then((reg) => {
      /* 首屏彻底空下来后再让 SW 补齐 19 本正文，避免和首屏抢带宽 */
      setTimeout(() => {
        if (reg.active) reg.active.postMessage({ type: 'prefetch-shards' });
      }, 5000);
    }).catch(() => {}));
  }
})();
