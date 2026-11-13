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
  /* 正文缓存必须有上限：一本本地卷正文常在 1–3MB，连开十几本书全留在内存里，
     手机上的标签页很容易被系统回收。这里按「最近使用」排个序，超了就丢最久没碰的
     —— 但正在读的那一卷（state.lastRead）和正在取章的卷永远不动。
     被丢掉的只是内存副本，IndexedDB / localStorage 里的正文还在，下次打开重读即可。 */
  const CACHE_MAX_BOOKS = 6;
  const cacheOrder = [];
  function cacheTouch(id) {
    if (!id) return;
    const i = cacheOrder.indexOf(id);
    if (i >= 0) cacheOrder.splice(i, 1);
    cacheOrder.push(id);
    if (cacheOrder.length > CACHE_MAX_BOOKS) cacheTrim();
  }
  function cacheTrim() {
    while (cacheOrder.length > CACHE_MAX_BOOKS) {
      let victim = -1;
      for (let i = 0; i < cacheOrder.length; i++) {
        const id = cacheOrder[i];
        if (id === state.lastRead) continue;                       /* 正在读的卷 */
        let busy = false;
        for (const k in chapterInFlight) {
          if (k.indexOf(id + '::') === 0) { busy = true; break; }
        }
        if (busy) continue;                                        /* 有章节正在取回 */
        victim = i; break;
      }
      if (victim < 0) break;
      delete contentCache[cacheOrder[victim]];
      cacheOrder.splice(victim, 1);
    }
  }
  let coverUid = 0;
  let readerToken = 0;
  let sourcesReady = Promise.resolve();
  let importing = false;
  /* 断网时 navigator.onLine 为 false；用它决定要不要为在线书发请求、
     以及页面上的提示该说「目录没取回来」还是「现在没有网络」。 */
  function online() { return !(typeof navigator !== 'undefined' && navigator.onLine === false); }

  /* 书源层：书肆 / 藏卷 / 详情 / 阅读器 统一从这里取书
   * 内置公版书、维基文库在线源、本地导入卷，都走同一套接口 */
  const SRC = window.MJ.sources;
  function getBook(id) {
    return SRC.getBook(id) || (state.localBooks || []).find((b) => b.id === id) || null;
  }
  function allBooks() { return SRC.allBooks().concat(state.localBooks || []); }
  function chapterList(b) {
    /* 老备份 / 损坏记录里本地卷可能是 chapters: []，直接返回空数组会让
       chapterList(b)[ch-1].title 抛错。给个「全文」兜底，至少能打开。 */
    if (b.local) {
      const cs = b.chapters || [];
      return cs.length ? cs.map((t, i) => ({ no: i + 1, title: t })) : [{ no: 1, title: '全文' }];
    }
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
    const why = c && c.error ? '（' + c.error + '）' : '';
    return ['（这一章暂未取到正文' + why + '，点下方「重新取回」再试一次）'];
  }
  /* 这一章现在拿不拿得到正文：paragraphs() 取不到时会塞一句提示当正文，
     听卷不能把提示念出来，也得能分清「空章」和「没取回来」。 */
  function hasChapterBody(b, no) {
    if (!b) return false;
    if (b.local) {
      const rec = contentCache[b.id];
      const c = rec && rec.chapters && rec.chapters[no - 1];
      return !!(c && c.paras && c.paras.length);
    }
    const sync = SRC.getChapterSync(b.id, no);
    if (sync && sync.length) return true;
    const rec = contentCache[b.id];
    const c = rec && rec.chapters && rec.chapters[no - 1];
    return !!(c && c.paras && c.paras.length);
  }
  /* 搜索用：把「现在拿得到」的章节正文摊平成一个数组，取不到的留 null。
     内置卷走同步源（单文件离线版也走这条），在线 / 本地卷走 contentCache。 */
  function loadedParas(b, rec) {
    const total = chapterList(b).length;
    const out = [];
    let any = false;
    for (let i = 0; i < total; i++) {
      const c = rec && rec.chapters && rec.chapters[i];
      if (c && c.paras && c.paras.length) { out.push(c.paras); any = true; continue; }
      let sync = null;
      try { sync = SRC.getChapterSync(b.id, i + 1); } catch (e) { sync = null; }
      if (sync && sync.length) { out.push(sync); any = true; } else out.push(null);
    }
    return any ? out : [];
  }
  /* 连续取章失败时的冷却阶梯：断网时别让翻章 / 全书检索把书源打爆 */
  const CHAPTER_BACKOFF = [0, 3000, 8000, 18000, 30000];
  /* 正文按需取：内置书首次打开要加载整本分片，在线源逐章取回 */
  async function ensureChapter(b, no) {
    if (!b || b.local) return;
    const src = SRC.get(b.sourceId);
    if (!src || typeof src.getChapter !== 'function') return;
    if (SRC.getChapterSync(b.id, no)) return;
    const rec = contentCache[b.id] || (contentCache[b.id] = { id: b.id, chapters: [] });
    cacheTouch(b.id);
    const prev = rec.chapters[no - 1];
    if (prev && prev.paras) return;
    /* 冷却期内复用上次的失败标记，不再发请求；用户点「重新取回」会删掉记录，立即放行 */
    if (prev && prev.error && Date.now() < (prev.retryAt || 0)) return;
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
      } catch (e) {
        /* 别只留一句通用提示：把失败原因写进缓存，渲染处能告诉用户
           是超时 / 书源被停用 / 章节不存在，重试也知道该重试什么。 */
        const raw = (e && e.message ? String(e.message) : '')
          .replace(/[（）\r\n]/g, ' ').trim();
        const attempts = Math.min(CHAPTER_BACKOFF.length - 1, ((prev && prev.attempts) || 0) + 1);
        rec.chapters[no - 1] = {
          title: '', paras: null,
          error: raw ? raw.slice(0, 60) : '取回失败',
          attempts, retryAt: Date.now() + CHAPTER_BACKOFF[attempts]
        };
      }
    })();
    chapterInFlight[inflightKey] = task;
    try { await task; } finally { delete chapterInFlight[inflightKey]; }
  }

  /* 读到一章就顺手把下一章取回来：真翻到下一章时是「翻过去就有字」，
     而不是先看一屏「正在取回」。只在空闲时发一次请求，离线、后台标签、
     正在全书检索、已经离开这一卷时都不做。 */
  let prefetchCancel = null;
  function prefetchNext(b, ch) {
    if (prefetchCancel) { prefetchCancel(); prefetchCancel = null; }
    if (!b || b.local || !b.online) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    if (document.hidden) return;
    const sd = $('#searchDrawer');
    if (sd && !sd.hidden) return;                       /* 全书检索正在跑，别再抢带宽 */
    const next = Number(ch) + 1;
    if (!(next > 1) || next > chapterList(b).length) return;
    if (SRC.getChapterSync(b.id, next)) return;          /* 内置书本来就是同步的 */
    const run = () => {
      prefetchCancel = null;
      const bb = getBook(b.id);
      if (!bb || state.lastRead !== bb.id) return;      /* 已经换卷 / 出阅读器 */
      if (document.hidden) return;
      ensureChapter(bb, next).catch(() => {});
    };
    if (window.requestIdleCallback) {
      const id = requestIdleCallback(run, { timeout: 3000 });
      prefetchCancel = () => cancelIdleCallback(id);
    } else {
      const id = setTimeout(run, 700);
      prefetchCancel = () => clearTimeout(id);
    }
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
    for (let fi = 0; fi < files.length; fi++) {
      const f = files[fi];
      const short = f.name.replace(/\.[^.]+$/, '').slice(0, 12);
      try {
        /* 一次拖进好几卷时，只说「正在解析《x》」看不出还剩几卷，加个序号 */
        toast('正在解析《' + short + '》…' + (files.length > 1 ? '（' + (fi + 1) + ' / ' + files.length + '）' : ''));
        const r = await IMP.parseFile(f);
        const chapters = r.chapters.filter((c) => c.paras && c.paras.length);
        if (!chapters.length) throw new Error('文件里没有可读内容');
        const chars = chapters.reduce((a, c) => a + c.paras.join('').length, 0);
        const now = Date.now();
        const id = 'local-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 7);
        const pal = LOCAL_COLORS[ok % LOCAL_COLORS.length];
        const first = (chapters[0].paras[0] || '').slice(0, 60);
        /* 文件名 / EPUB dc:title 可能带 < > &，源头就换成全角，
           否则后面模板里的 ${b.title} 会把标签插进 DOM */
        const cleanMeta = (v) => String(v || '').replace(/[<>&]/g,
          (c) => ({ '<': '〈', '>': '〉', '&': '＆' }[c]));
        const bookTitle = cleanMeta(r.title || short);
        const bookAuthor = cleanMeta(r.author || '本地导入');
        const meta = {
          id, local: true, title: bookTitle, author: bookAuthor,
          category: '本地', status: '本地', tags: ['本地导入', (r.ext || 'txt').toUpperCase()],
          words: chars >= 10000 ? (chars / 10000).toFixed(1) + '万' : chars + '字',
          score: 9.0, readers: '本地卷', hot: 60,
          motif: LOCAL_MOTIFS[ok % LOCAL_MOTIFS.length], color: pal[0], color2: pal[1],
          seal: bookTitle.replace(/[《》\s]/g, '').charAt(0) || '卷',
          desc: '由本地文件导入，共 ' + chapters.length + ' 章。' + (first ? first + '…' : ''),
          chapters: chapters.map((c) => c.title), addedAt: now
        };
        try { await saveContent(id, { id, chapters }); } catch (e) { weakSave += 1; }
        contentCache[id] = { id, chapters };
        cacheTouch(id);
        if (r.cover) { state.covers[id] = { image: r.cover }; markCoversDirty(); }
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
      const oi = cacheOrder.indexOf(x); if (oi >= 0) cacheOrder.splice(oi, 1);
      delete state.progress[x];
      delete state.listenPos[x];
      delete state.covers[x]; markCoversDirty();
      delete state.bookmarks[x];
      delete state.annotations[x];
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
  /* 封面图是几十 KB 一张的 base64，单独存一个键；理由见 save() */
  const COVERS_KEY = 'mojuan.covers.v1';
  const DEFAULTS = {
    /* 藏卷默认空着 —— 这是用户自己攒的书架，不该由程序塞书进来 */
    shelf: [],
    progress: {},
    lastRead: '',
    settings: { theme: 'day', fs: 19, lh: 2, paper: 'xuan', lastDayPaper: 'xuan', font: 'song', pageMode: 'flip', flipAnim: 'realistic', rate: 1, voiceURI: '' },
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
    annotations: {},
    listenScope: 'book',
    /* 听书续听位置单独存句子下标，别再和阅读进度 progress.pct 混用：
       后者在滚动模式是 scrollTop 比例、翻页模式是页码比例，不是字符进度。 */
    listenPos: {},
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
    /* 翻页动画换成真正的「整页滑动」了：旧默认 'none' 在单页元素上本来就看不出动静，
     * 这里把存量用户一次性升到 'slide'。只做一次，之后用户在设置里选「无动画」要能留住。 */
    if (ver < 4 && state.settings && (!state.settings.flipAnim || state.settings.flipAnim === 'none')) {
      state.settings.flipAnim = 'slide';
    }
    /* v5：「仿真」翻页成为默认。存量用户一次性切过去；之后在设置里改回
       滑动 / 淡入 / 无动画都会留住，因为版本号已经是 5 了。 */
    if (ver < 5 && state.settings && state.settings.flipAnim === 'slide') {
      state.settings.flipAnim = 'realistic';
    }
    state.v = 5;
    /* 迁移结果必须立刻落盘：否则用户把种子书重新加回藏卷后，
     * 下次启动又会因为版本号没升级而被当成种子再删一遍。
     * （此处 save() 还没初始化完，直接写 localStorage；封面走自己的键） */
    try {
      const light = Object.assign({}, state); delete light.covers;
      localStorage.setItem(KEY, JSON.stringify(light));
      const cs = state.covers || {};
      if (Object.keys(cs).length) localStorage.setItem(COVERS_KEY, JSON.stringify(cs));
    } catch (e) { /* 配额满就下次再说，迁移本身幂等 */ }
  })();
  function normalizeState(raw) {
    try {
      return Object.assign({}, structuredClone(DEFAULTS), raw || {}, {
        settings: Object.assign({}, DEFAULTS.settings, (raw || {}).settings || {}),
        checkin: Object.assign({}, DEFAULTS.checkin, (raw || {}).checkin || {}),
        covers: Object.assign({}, DEFAULTS.covers, (raw || {}).covers || {}),
        bookmarks: Object.assign({}, DEFAULTS.bookmarks, (raw || {}).bookmarks || {}),
        annotations: Object.assign({}, DEFAULTS.annotations, (raw || {}).annotations || {}),
        bookTags: Object.assign({}, DEFAULTS.bookTags, (raw || {}).bookTags || {}),
        listenPos: Object.assign({}, DEFAULTS.listenPos, (raw || {}).listenPos || {}),
        pinned: Array.isArray((raw || {}).pinned) ? raw.pinned : [],
        readLog: Object.assign({}, DEFAULTS.readLog, (raw || {}).readLog || {})
      });
    } catch (e) { return structuredClone(DEFAULTS); }
  }
  function load() {
    let raw = {}, covers = {};
    try { raw = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { raw = {}; }
    try { covers = JSON.parse(localStorage.getItem(COVERS_KEY) || '{}') || {}; } catch (e) { covers = {}; }
    /* 存量用户的封面还压在主键里：先搬出来，再把主键瘦身写回。
       顺序不能反 —— 先写封面键的话，新旧两份大字符串会同时占着存储，
       本来刚好够用的配额会被这一下顶爆，迁移反而失败。 */
    if (raw.covers && Object.keys(raw.covers).length) {
      covers = Object.assign({}, raw.covers, covers);
      delete raw.covers;
      try {
        localStorage.setItem(KEY, JSON.stringify(raw));
        localStorage.setItem(COVERS_KEY, JSON.stringify(covers));
      } catch (e) { /* 写不进去就留到下次，内存里封面是全的，这次照样能用 */ }
    }
    try {
      const st = normalizeState(raw);
      st.covers = Object.assign({}, st.covers, covers);
      return st;
    } catch (e) { return structuredClone(DEFAULTS); }
  }
  /* localStorage 每源上限：Chrome 约 500 万字符（UTF-16），这里按字符数估，
     只用来分「宽裕 / 偏紧 / 已满」三档，不给用户一个假的精确总量。 */
  const LS_LIMIT = 5000000;
  function storageStats() {
    let chars = 0, coverChars = 0, coverN = 0;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || k.indexOf('mojuan.') !== 0) continue;
        chars += k.length + (localStorage.getItem(k) || '').length;
      }
    } catch (e) { return null; }
    Object.keys(state.covers || {}).forEach((id) => {
      const c = state.covers[id];
      if (c && c.image) { coverN += 1; coverChars += c.image.length; }
    });
    return { chars, coverChars, coverN, ratio: chars / LS_LIMIT };
  }
  function fmtBytes(bytes) {
    const mb = bytes / 1024 / 1024;
    return mb >= 0.1 ? mb.toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB';
  }
  let saveWarned = false, saveWarnAt = 0;
  /* 封面只在被改动时才写自己的键；写失败冷却 30 秒再试，别让每次翻页都
     白序列化几 MB。改动封面的入口统一调 markCoversDirty()。 */
  let coversDirty = false, coverRetryAt = 0;
  function markCoversDirty() { coversDirty = true; }
  function warnSave(text) {
    const now = Date.now();
    if (!saveWarned || now - saveWarnAt > 5000) {
      saveWarned = true; saveWarnAt = now;
      try { toast(text); } catch (_) { /* 忽略 */ }
    }
  }
  function save() {
    /* 封面图跟进度、笔记挤在同一个键里有两个坏处：
       ① 每翻一页存档都要把几 MB 的 base64 重新 stringify 一遍；
       ② 封面把配额占满后整份 setItem 抛异常，连「读到第几页」都一起存不进去，
          丢的是全部改动。拆成两个键，主体始终只有几 KB，互不影响。 */
    const light = Object.assign({}, state);
    delete light.covers;
    let mainOK = true, coverOK = true;
    try { localStorage.setItem(KEY, JSON.stringify(light)); }
    catch (e) {
      mainOK = false; ui.storageFull = true;
      warnSave('本地存储已满，这次改动没能保存；可到「墨斋 · 卷档管理」导出备份并清理封面图');
    }
    if (coversDirty && Date.now() >= coverRetryAt) {
      try {
        localStorage.setItem(COVERS_KEY, JSON.stringify(state.covers || {}));
        coversDirty = false;
      } catch (e) {
        coverOK = false; coverRetryAt = Date.now() + 30000;
        warnSave('封面图没能存下（本机空间不足），进度、笔记与设置不受影响');
      }
      /* 失败必须留着标记：靠 coverRetryAt 节流，冷却过后的下一次存档自动补写。
         早先无条件清掉，结果内存里是新封面、磁盘上永远旧值，重启就丢。 */
    }
    return mainOK && coverOK;
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
    shelfFilter: 'all', shelfSort: 'recent', shelfVisibleIds: [], shelfSearch: '',
    noteSearch: '', noteBook: '', noteColor: '', hlColor: 'red', seekDragAt: 0, metaDraft: null,
    noteMulti: false, notePicked: new Set(),
    searchHits: [], searchIdx: -1, searchNavOn: false, searchBook: '',
    bmNote: -1, panelFrom: null, searchFrom: null, modalFrom: null,
    tocLoading: false, tocFailed: false, tocOffline: false, storageFull: false
  };
  let readerSession = null;
  let lastFocus = null;   /* { hash, key }：跨页返回时把焦点还给原来那个控件 */
  let bannerTimer = null;
  let pendingScroll = 0;
  function rerender() {
    pendingScroll = window.scrollY;
    /* 重渲染会把页面整块换掉，原来按着的那个按钮就没了，焦点掉回 body。
       切分类 / 换排序 / 删卷之后键盘用户得从页首重新 Tab 一遍。
       这里按「动作 + 值」把同一个按钮找回来（找不到就不硬塞）。 */
    const back = restorableFocus();
    render();
    if (back) {
      const again = resolveFocus(back);
      if (again) again.focus({ preventScroll: true });
    }
  }
  /* 页面容器只当「兜底焦点」，不该记成「用户刚才在哪儿」——否则从详情页退回来时会去还原 #view */
  const FOCUS_SKIP_IDS = ['view', 'reader', 'listen', 'catalogDrawer', 'readerPanel', 'searchDrawer'];
  function restorableFocus() {
    const a = document.activeElement;
    if (!a || a === document.body) return null;
    if (a.id) return FOCUS_SKIP_IDS.indexOf(a.id) >= 0 ? null : { id: a.id };
    const act = a.dataset && a.dataset.action;
    if (!act) return null;
    return { action: act, val: a.dataset.val == null ? null : a.dataset.val, bookId: a.dataset.id || null };
  }
  function resolveFocus(key) {
    if (!key) return null;
    if (key.id) return document.getElementById(key.id);
    let list = Array.from(document.querySelectorAll('[data-action="' + key.action + '"]'));
    if (!list.length) return null;
    if (key.bookId) list = list.filter((el) => el.dataset.id === key.bookId);
    if (key.val != null) list = list.filter((el) => (el.dataset.val || '') === key.val);
    /* 同动作的按钮可能有一整页（每张书卡都有「打开」），拿不准就不要抢焦点 */
    if (list.length === 1) return list[0];
    if (key.val != null || key.bookId) return list[0] || null;
    return null;
  }

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
    /* 只取还没补过语义的节点：原来每次 render 都把整页上千个已处理节点
       取回来再在 JS 里跳过，选择器层面过滤掉省一大截。 */
    root.querySelectorAll('[data-action]:not([data-a11y])').forEach((el) => {
      if (NATIVE_CTL.test(el.tagName)) return;
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

  /* 退场过渡：先播一小段动画再真正隐藏 / 清空；期间可以取消（比如立刻又点开面板） */
  const mjExit = new Map();
  function mjExitDo(el, cls, done) {
    if (!el || el.hidden) { if (done) done(); return; }
    mjExitCancel(el);
    el.classList.add(cls);
    const t = setTimeout(() => {
      mjExit.delete(el); el.classList.remove(cls);
      if (done) done();
    }, 180);
    mjExit.set(el, { t, cls });
  }
  function mjExitCancel(el) {
    const old = el && mjExit.get(el);
    if (!old) return;
    clearTimeout(old.t); el.classList.remove(old.cls); mjExit.delete(el);
  }
  let panelCloseTimer = 0;
  function cancelPanelClose() {
    if (panelCloseTimer) { clearTimeout(panelCloseTimer); panelCloseTimer = 0; }
    ['#readerMask', '#readerPanel', '#catalogDrawer'].forEach((sel) => mjExitCancel($(sel)));
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
      <div class="cover-title${tcls}">${esc(b.title)}</div>
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
    /* 导出正文不要求「本地卷」：在线卷只要读过、缓存里有章节，也能导出那几章 */
    const exportableIds = ids.filter((x) => {
      const b = getBook(x); if (!b) return false;
      if (b.local) return true;
      const rec = contentCache[x];
      return !!(rec && rec.chapters && rec.chapters.some(Boolean));
    });
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
            <button class="as-item" data-action="bulk-export-books" ${exportableIds.length ? '' : 'disabled'}>${icon('book', 'ic-sm')}<span>导出正文 (${exportableIds.length})</span></button>
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
  /* parts 可以是字符串，也可以是「片段数组」：备份文件动辄几 MB，
     '\ufeff' + text 会先把整份 JSON 原样复制一遍再交给 Blob（峰值翻倍），
     改成把 BOM 和正文当成两个片段，浏览器拼 Blob 时不必在 JS 堆里再落一份。 */
  function downloadText(name, parts) {
    try {
      const list = Array.isArray(parts) ? parts : ['\ufeff' + parts];
      const url = URL.createObjectURL(new Blob(list, { type: 'text/plain;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
      return true;
    } catch (e) { return false; }
  }
  /* ---------- 完整备份 / 恢复（含本地卷正文） ---------- */
  const BACKUP_APP = 'mojuan', BACKUP_VER = 2;
  /* state 之外还有几个独立键：自定义书源（用户手写的代码）、停用的官方源、
     在线音色（含各家 API key）。这些丢了没法重建，必须一起进备份，
     恢复时回写、重置时清掉。目录缓存属于可重建缓存，不进备份但重置会清。 */
  const EXTRA_KEYS = ['mojuan.sources.custom', 'mojuan.sources.off', 'mojuan.voice.v1'];
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
    const extras = {};
    EXTRA_KEYS.forEach((k) => {
      try { const v = localStorage.getItem(k); if (v != null) extras[k] = v; } catch (e) { /* 存储不可用 */ }
    });
    /* 一份含 20 卷正文的备份可能几十 MB。整份 JSON.stringify 会先拼出一个巨型
       字符串，紧接着 Blob 再复制一份，峰值能到原体积的 2–3 倍，手机上直接爆。
       这里按「小字段 + 逐卷正文」分段序列化，交给 Blob 原生拼接，
       JS 堆里同时只存在单卷那一份字符串。 */
    const parts = ['\ufeff', '{"app":', JSON.stringify(BACKUP_APP),
      ',"version":', String(BACKUP_VER),
      ',"exportedAt":', JSON.stringify(new Date().toISOString()),
      ',"state":', new Blob([JSON.stringify(state)]),
      ',"contents":{'];
    let first = true;
    Object.keys(contents).forEach((k) => {
      const sep = first ? '' : ','; first = false;
      /* 每卷序列化完立刻交给 Blob：字符串出栈就能回收，parts 里只留 Blob 片段。
         早先是把整卷字符串 push 进数组，几十卷全攒在 JS 堆里，注释说的
         「同时只存在单卷那一份」其实没做到。Blob 构造接受多个片段，
         不必先拼成一个更大的字符串。 */
      parts.push(new Blob([sep, JSON.stringify(k), ':', JSON.stringify(contents[k])]));
    });
    parts.push('},"extras":', JSON.stringify(extras), '}');
    const ok = downloadText('墨卷备份-' + today() + '.json', parts);
    toast(ok
      ? '备份已导出 · 含 ' + Object.keys(contents).length + ' 卷本地卷正文'
        + (Object.keys(extras).length ? '、书源与音色配置' : '')
      : '导出失败，请检查浏览器下载权限');
  }
  async function restoreBackup(text) {
    let obj;
    try { obj = JSON.parse(String(text).replace(/^\uFEFF/, '')); }
    catch (e) { toast('文件不是有效的备份 JSON'); return; }
    if (!obj || obj.app !== BACKUP_APP || !obj.state || typeof obj.state !== 'object') {
      toast('这不是墨卷备份文件'); return;
    }
    if (Number(obj.version) > BACKUP_VER) {
      toast('这份备份来自更新版本的墨卷，请先升级后再恢复'); return;
    }
    const contents = obj.contents || {};
    const extras = (obj.extras && typeof obj.extras === 'object') ? obj.extras : {};
    const n = Object.keys(contents).length;
    if (!confirm('确定从这份备份恢复吗？\n\n将覆盖当前的藏卷、进度、卷签、划线批注、封面、设置、书源与音色配置，以及 ' + n + ' 卷本地卷正文。此操作不可撤销。')) return;

    /* 先落正文，再覆盖 state：任何一步失败，旧的 state 和旧正文都还在。
       IDB 事务本身是原子的，所以不做 clear() —— 只 put 新键、删掉备份里
       没有的旧键；一旦事务中止浏览器自动回滚，不会把本地卷清空。 */
    const putIDB = async () => {
      try {
        const db = await openDB();
        await new Promise((res, rej) => {
          const tx = db.transaction('books', 'readwrite');
          const st = tx.objectStore('books');
          Object.keys(contents).forEach((k) => st.put(contents[k], k));
          const stale = [];
          const cur = st.openKeyCursor();
          cur.onsuccess = (ev) => {
            const c = ev.target.result;
            if (!c) { stale.forEach((k) => st.delete(k)); return; }
            if (!(String(c.key) in contents)) stale.push(c.key);
            c.continue();
          };
          tx.oncomplete = () => res();
          tx.onerror = () => rej(tx.error || new Error('正文写入失败'));
          tx.onabort = () => rej(tx.error || new Error('事务被中止'));
        });
        try { db.close(); } catch (e) {}
        return true;
      } catch (e) { return false; }
    };
    const putLS = () => {
      const keys = Object.keys(contents);
      /* localStorage 没有事务：配额在第 N 卷爆掉时，前 N-1 卷已经写进去了。
         先把旧值记下来，失败就整体回滚，否则「原有数据未改动」是一句谎话。 */
      const before = {};
      let written = 0;
      try {
        keys.forEach((k) => { before[LS_PREFIX + k] = localStorage.getItem(LS_PREFIX + k); });
        for (; written < keys.length; written++) {
          localStorage.setItem(LS_PREFIX + keys[written], JSON.stringify(contents[keys[written]]));
        }
        const del = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.indexOf(LS_PREFIX) === 0 && !(k.slice(LS_PREFIX.length) in contents)) del.push(k);
        }
        del.forEach((k) => localStorage.removeItem(k));
        return true;
      } catch (e) {
        /* 先删掉这次写进去的键再还原旧值：新值还占着空间时，旧值更大的话
           回滚自己也会被配额拦下。 */
        try {
          for (let i = 0; i < written; i++) localStorage.removeItem(LS_PREFIX + keys[i]);
          keys.forEach((k) => {
            const key = LS_PREFIX + k;
            if (before[key] != null) localStorage.setItem(key, before[key]);
          });
        } catch (_) { /* 回滚也失败时至少别把页面搞崩，提示里不把话说满 */ }
        return false;
      }
    };
    try {
      const idbOK = await putIDB();
      if (!idbOK && !putLS()) {
        toast('恢复失败：本地卷正文没能完整写入（本机空间不足），已尝试还原原有数据；清理空间后再试');
        return;
      }
      /* 用与启动加载同一套规范化，缺字段的旧备份也不会让页面崩。
         内存里的 state 必须一起换：否则 reload 时 pagehide 的 flushSave()
         会把旧 state 写回 localStorage，刚恢复的数据瞬间被覆盖回去。 */
      const merged = normalizeState(obj.state);
      state = merged;
      /* 备份里的封面要写进自己的键；主体走 save() 的瘦身路径，
         免得一份几十 MB 的备份因为封面挤不进配额就把整个恢复判成失败。 */
      markCoversDirty();
      const restored = save();
      EXTRA_KEYS.forEach((k) => {
        try {
          if (extras[k] != null) localStorage.setItem(k, extras[k]);
          else localStorage.removeItem(k);
        } catch (e) { /* 单个配置失败不影响主体 */ }
      });
      toast(restored ? '恢复完成，正在重新载入…' : '恢复完成（本机空间不足，部分封面可能没能长期保存），正在重新载入…');
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
    let n = 0, onlineN = 0;
    for (const id of ids) {
      const b = getBook(id); if (!b) continue;
      let rec = contentCache[id];
      /* 在线卷只导出已读进缓存的章节，绝不为了导出去联网抓全书 */
      if (!rec && b.local) { try { rec = await loadContent(id); } catch (e) { rec = null; } }
      if (!rec || !rec.chapters) continue;
      const chs = rec.chapters.filter(Boolean);
      if (!chs.length) continue;
      const online = !b.local;
      if (online) onlineN += 1;
      chunks.push('《' + b.title + '》 ' + b.author + (online ? ' · 已缓存章节' : '') + ' · 共 ' + chs.length + ' 章\n');
      chs.forEach((c) => {
        chunks.push('\n' + c.title + '\n');
        (c.paras || []).forEach((p) => chunks.push('　　' + p + '\n'));
      });
      chunks.push('\n\n————————————\n\n');
      n += 1;
      if (n % 3 === 0) toast('正在整理…已处理 ' + n + ' 卷');
    }
    if (!n) { toast('没有可导出的正文 · 在线卷需先读过几章才有缓存'); return; }
    const header = '墨卷 · 正文导出\n导出时间：' + new Date().toLocaleString('zh-CN')
      + '\n共 ' + n + ' 卷' + (onlineN ? '（其中 ' + onlineN + ' 卷为在线已缓存章节）' : '') + '\n\n';
    const ok = downloadText('墨卷-导出正文.txt', header + chunks.join(''));
    toast(ok ? '已导出 ' + n + ' 卷正文' : '导出失败，请检查浏览器下载权限');
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
    /* 书肆卡片角上的「收下」：省掉进详情页再点一次，已在藏卷时变成对勾，点一下可移出 */
    const inShelf = state.shelf.includes(b.id);
    const quick = opts.quickAdd && !opts.edit
      ? `<button class="quick-add ${inShelf ? 'on' : ''}" data-action="${inShelf ? 'remove-shelf' : 'add-shelf'}" data-id="${b.id}"
           title="${inShelf ? '已在藏卷 · 点击移出' : '收入藏卷'}" aria-label="${inShelf ? '移出藏卷' : '收入藏卷'}">${icon(inShelf ? 'check' : 'plus', 'ic-sm')}</button>`
      : '';
    const tap = opts.edit ? 'pick-book' : (opts.shelf ? 'shelf-read' : 'open-book');
    return `<div class="book-card ${opts.edit ? 'editable' : ''} ${picked ? 'picked' : ''}" data-action="${tap}" data-id="${b.id}" ${opts.shelf ? 'data-shelf-card="1"' : ''} data-st="${esc(b.title.toLowerCase())}" data-sa="${esc((b.author || '').toLowerCase())}" data-sc="${esc((b.category || '').toLowerCase())}">
      <div class="cover-wrap">${coverHtml(b)}${badge}${pick}${quick}</div>
      <div class="book-name">${esc(b.title)}</div>
      <div class="book-meta"><span class="bm-text">${b.author} · ${b.category}</span>${miniTags(b)}</div>
      ${prog}
    </div>`;
  }
  /* 搜索命中词高亮：只标第一处，先切片再逐段 esc，不做正则替换，天然防注入 */
  function markText(s, q) {
    const raw = String(s || '');
    if (!q) return esc(raw);
    const i = raw.toLowerCase().indexOf(String(q).toLowerCase());
    if (i < 0) return esc(raw);
    return esc(raw.slice(0, i)) + '<mark class="q-hit">' + esc(raw.slice(i, i + String(q).length))
      + '</mark>' + esc(raw.slice(i + String(q).length));
  }
  function bookRow(b, i, opts) {
    opts = opts || {};
    const picked = ui.selected.has(b.id);
    const pick = opts.edit
      ? `<div class="pick-box row ${picked ? 'on' : ''}" data-action="pick-book" data-id="${b.id}">${picked ? icon('check', 'ic-sm') : ''}</div>`
      : '';
    const tap = opts.edit ? 'pick-book' : (opts.shelf ? 'shelf-read' : 'open-book');
    return `<div class="book-row ${opts.edit ? 'editable' : ''} ${picked ? 'picked' : ''}" data-action="${tap}" data-id="${b.id}" ${opts.shelf ? 'data-shelf-card="1"' : ''} data-st="${esc(b.title.toLowerCase())}" data-sa="${esc((b.author || '').toLowerCase())}" data-sc="${esc((b.category || '').toLowerCase())}">
      ${pick}
      ${opts.rank ? `<div class="rank-no ${i < 3 ? 'top' : ''}">${i + 1}</div>` : ''}
      <div style="width:62px;flex:none">${coverHtml(b)}</div>
      <div class="book-row-info">
        <h3>${markText(b.title, opts.mark)} <span class="muted" style="font-size:11px;font-weight:400">/ ${markText(b.author, opts.mark)}</span></h3>
        <p>${opts.hint ? `<b style="color:var(--cinnabar);font-weight:500">${esc(opts.hint)}</b> ` : ''}${esc(b.desc)}</p>
        <div class="row-tags"><span class="tag tag-red">${esc(b.status)}</span><span class="tag">${esc(b.category)}</span>
          <span class="tag">${esc(b.words)}</span><span class="tag">${chapNum(b)} 篇</span>${miniTags(b)}</div>
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
    /* 标签筛选带上卷数，一眼看出每个分组有几卷；空分组点不动 */
    const tagN = (k) => (k === 'all' ? shelf.length : shelf.filter((b) => state.bookTags[b.id] === k).length);
    html += `<div class="chip-row shelf-filters">${[['all', '全部'], ['want', '想读'], ['reading', '在读'], ['done', '已读']].map(([k, l]) =>
      `<button class="chip ${ui.shelfFilter === k ? 'active' : ''}" data-action="set-shelf-filter" data-val="${k}" ${k !== 'all' && !tagN(k) ? 'disabled' : ''}>${l} ${tagN(k)}</button>`).join('')}</div>`;
    html += `<div class="chip-row shelf-sorts">${[['recent', '最近阅读'], ['name', '书名'], ['added', '添加顺序']].map(([k, l]) =>
      `<button class="chip ${ui.shelfSort === k ? 'active' : ''}" data-action="set-shelf-sort" data-val="${k}">${l}</button>`).join('')}</div>`;
    html += `<div class="shelf-search">${icon('search', 'ic-sm')}<input id="shelfSearch" placeholder="搜书名 / 作者 / 分类" value="${esc(ui.shelfSearch || '')}" autocomplete="off"><button class="shelf-search-clear" data-action="clear-shelf-search" title="清空" ${ui.shelfSearch ? '' : 'hidden'}>${icon('close', 'ic-sm')}</button></div>`;
    html += `<div class="shelf-toolbar"><h2 class="section-title">架上诸卷</h2>
      <div class="shelf-tools">
        <button class="btn btn-ghost btn-sm shelf-organize" data-action="toggle-edit">${icon('settings', 'ic-sm')} <span>整理</span></button>
        <div class="view-toggle">
          <button class="${state.viewMode === 'grid' ? 'active' : ''}" data-action="toggle-view" data-val="grid" title="网格">${icon('gridview', 'ic-sm')}</button>
          <button class="${state.viewMode === 'list' ? 'active' : ''}" data-action="toggle-view" data-val="list" title="列表">${icon('listview', 'ic-sm')}</button>
        </div>
      </div></div>`;
    /* 比较器里原来每次都线性查 getBook / indexOf，几百卷时是 O(n² log n)。
       先把排序用到的字段建成 Map，比较器只读表。 */
    const shelfPos = new Map((state.shelf || []).map((id, i) => [id, i]));
    const sortMeta = new Map(shelf.map((it) => {
      const g = getBook(it.id) || it;
      return [it.id, {
        title: g.title || it.title || '',
        pinned: state.pinned.includes(it.id) ? 1 : 0,
        pos: shelfPos.has(it.id) ? shelfPos.get(it.id) : 0,
        updated: (state.progress[it.id] || {}).updated || 0
      }];
    }));
    let order = shelf.slice().sort((a, b) => {
      const x = sortMeta.get(a.id), y = sortMeta.get(b.id);
      if (x.pinned !== y.pinned) return y.pinned - x.pinned;
      if (ui.shelfSort === 'name') return x.title < y.title ? -1 : 1;
      if (ui.shelfSort === 'added') return x.pos - y.pos;
      return y.updated - x.updated;
    });
    if (ui.shelfFilter !== 'all') order = order.filter((b) => state.bookTags[b.id] === ui.shelfFilter);
    /* 搜索不在这里裁 order：重渲染若按关键词删卡片，之后删字放宽搜索就再也恢复不了。
       统一由 applyShelfSearch 切 hidden，DOM 里始终保留当前分组的全部卡片。 */
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
      html += `<div id="shelfNoMatch" class="empty" hidden>${icon('search')}<p>没找到匹配的卷</p><button class="btn btn-ghost" data-action="clear-shelf-search">清空搜索</button></div>`;
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
        <h2>${esc(b.title)}</h2><p>${esc(b.sub || '')}</p>
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
  /* ---------- 藏卷搜索：直接切 hidden，不重渲染，保住输入焦点与滚动位置 ---------- */
  let shelfSearchTimer = null, noteSearchTimer = null;
  function applyShelfSearch(v) {
    ui.shelfSearch = v || '';
    const q = ui.shelfSearch.toLowerCase();
    const vis = [];
    $$('[data-shelf-card]').forEach((el) => {
      const hit = !q || (el.dataset.st || '').includes(q) || (el.dataset.sa || '').includes(q) || (el.dataset.sc || '').includes(q);
      el.hidden = !hit;
      if (hit) vis.push(el.dataset.id);
    });
    ui.shelfVisibleIds = vis; /* 整理/全选只作用于当前可见的卷 */
    const empty = $('#shelfNoMatch');
    if (empty) empty.hidden = vis.length > 0 || !q;
    const clr = $('.shelf-search-clear');
    if (clr) clr.hidden = !ui.shelfSearch;
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
      <div class="book-hscroll" id="editorPick">${sorted(allBooks(), 'many').slice(0, 8).map((b) => bookCard(b, { badge: charNum(b) >= 100000 ? '长卷' : '', quickAdd: true })).join('')}</div></div>`;
    html += `<div class="section">${sectionHead('为你荐一卷', '换荐', 'shuffle')}
      <div class="book-hscroll" id="forYou">${sorted(allBooks().filter((b) => !state.shelf.includes(b.id)), 'long').slice(0, 7).map((b) => bookCard(b, { quickAdd: true })).join('')}</div></div>`;
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
      <div class="rec-grid">${allBooks().map((b) => bookCard(b, { quickAdd: true })).join('')}</div></div>`;
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
    html += list.length ? `<div class="book-grid">${list.map((b) => bookCard(b, { quickAdd: true })).join('')}</div>`
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
      `<div><div class="rank-crown">${['榜 首', '亚 卷', '探 花'][i]}</div>${bookCard(b, { quickAdd: true })}</div>`).join('')}</div>`;
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
      (list.length ? `<div class="book-list">${list.map((b, i) => bookRow(b, i, { hint: searchHint(q, b), mark: q.trim() })).join('')}</div>`
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
        <h1>${esc(b.title)}</h1>
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
        <div class="detail-tag-row">
          <span class="filter-label">标记</span>
          <div class="chip-row">
            ${[['want', '想读'], ['reading', '在读'], ['done', '已读']].map(([k, l]) =>
              `<button class="chip chip-sm ${state.bookTags[b.id] === k ? 'active' : ''}" data-action="set-book-tag" data-id="${b.id}" data-val="${k}">${l}</button>`).join('')}
            ${state.bookTags[b.id] ? `<button class="chip chip-sm" data-action="set-book-tag" data-id="${b.id}" data-val="">清除</button>` : ''}
          </div>
        </div>
      </div>
    </div>`;
    html += `<div class="detail-cols">
      <div class="panel" id="tocPanel">
        <h3>目录 <button class="link-more" data-action="open-catalog" data-id="${b.id}">全部 ${chapters.length} 章 ${icon('right', 'ic-sm')}</button></h3>
        ${b.online && chapters.length <= 1
          ? (ui.tocLoading ? tocLoadingHtml()
            : (ui.tocFailed ? `<div class="toc-status">${icon('info', 'ic-sm')} ${ui.tocOffline ? '现在没有网络，连上后点重试' : '目录没取回来'}
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
  /* ---------- 键盘捷径说明 ---------- */
  function openShortcutHelp() {
    let root = $('#shortcutHelp');
    if (!root) { root = document.createElement('div'); root.id = 'shortcutHelp'; document.body.appendChild(root); }
    mjExitCancel(root);
    const groups = [
      ['随处可用', [['1 / 2 / 3', '书肆 / 藏卷 / 墨斋'], ['/', '去书肆搜卷'],
        ['? 或 F1', '打开这份说明'], ['Esc', '关闭面板 / 清空搜索 / 收起听卷']]],
      ['读墨时', [['← / →', '翻页；滚动模式为上一章 / 下一章'],
        ['空格 / PageDown', '往后翻；滚动模式滚一屏（到底再按换下一章）'],
        ['Shift+空格 / PageUp', '往回翻；滚动模式往回滚一屏'],
        ['↑ / ↓', '滚动模式下上下滚一点'],
        ['t', '打开听卷'], ['c', '目录 / 卷签 / 笔记'],
        ['s', '字号与纸张设置'], ['n', '切换夜墨 / 日光'], ['Esc', '退出阅读器']]],
      ['划词与笔记', [['选中一段文字', '浮出「划线 / 批注」工具条'],
        ['Esc', '收起工具条 / 清空笔记搜索']]],
      ['听卷时', [['空格', '播放 / 暂停'], ['← / →', '上一章 / 下一章'],
        ['进度条上 ← / →', '快退 / 快进一小段'], ['Esc', '收成迷你条（再按一次停止）']]]
    ];
    root.innerHTML = `<div class="sh-backdrop" data-action="close-shortcut-help"></div>
      <div class="sh-card" role="dialog" aria-label="键盘捷径说明">
        <div class="sh-head"><b>键 盘 捷 径</b>
          <button class="icon-btn" data-action="close-shortcut-help" title="关闭">${icon('close', 'ic-sm')}</button></div>
        <div class="sh-body">${groups.map(([g, rows]) => `<div class="sh-group"><h4>${esc(g)}</h4>${rows.map(([k, d]) =>
          `<div class="sh-row"><kbd>${esc(k)}</kbd><span>${esc(d)}</span></div>`).join('')}</div>`).join('')}</div>
      </div>`;
    syncModalInert();
  }
  function closeShortcutHelp() {
    const r = $('#shortcutHelp');
    if (r) mjExitDo(r, 'mj-fade-out', () => r.remove());
  }

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
            <div class="st" style="cursor:pointer" data-action="open-book" data-id="${b.id}">《${esc(b.title)}》<small>${b.chapters.length} 章 · ${esc(b.words || '')} · ${esc(b.author || '')}</small></div>
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
            <div class="st" style="cursor:pointer" data-action="open-bookmark" data-id="${bid}" data-ch="${m.ch}" data-val="${i}">《${esc((getBook(bid) || {}).title || '已删除的卷')}》<small>${esc(m.title)} · 第 ${m.ch} 章${m.page ? ' · 第 ' + (m.page + 1) + ' 页' : ''}</small>${m.note ? `<i class="bm-note">${esc(m.note)}</i>` : ''}</div>
            <button class="btn btn-ghost btn-sm btn-danger" data-action="bookmark-del-global" data-id="${bid}" data-val="${i}">删除</button>
          </div>`).join('')}
        </div></div>`;
    }
    const annAll = [];
    Object.keys(state.annotations || {}).forEach((bid) => {
      (state.annotations[bid] || []).forEach((a, i) => annAll.push({ bid, a, i }));
    });
    if (annAll.length) {
      annAll.sort((x, y) => (y.a.time || 0) - (x.a.time || 0));
      const noteBooks = [];
      annAll.forEach(({ bid }) => { if (!noteBooks.includes(bid)) noteBooks.push(bid); });
      html += `<div class="section">${sectionHead('我的笔记 · ' + annAll.length, ui.noteMulti ? '完成' : '整理', 'toggle-note-multi')}
        <div class="shelf-search">${icon('search', 'ic-sm')}<input id="noteSearch" placeholder="搜原文 / 批注 / 书名" value="${esc(ui.noteSearch || '')}" autocomplete="off">
          <select id="noteBookFilter" class="note-book-filter" aria-label="按卷筛选">
            <option value="">全部卷</option>
            ${noteBooks.map((bid) => `<option value="${esc(bid)}" ${ui.noteBook === bid ? 'selected' : ''}>《${esc((getBook(bid) || {}).title || bid)}》</option>`).join('')}
          </select>
          <button class="shelf-search-clear" data-action="clear-note-search" title="清空" ${ui.noteSearch ? '' : 'hidden'}>${icon('close', 'ic-sm')}</button></div>
        <div class="chip-row note-color-row">
          <button class="chip ${ui.noteColor ? '' : 'active'}" data-action="set-note-color" data-val="">全部 ${annAll.length}</button>
          ${[['red', '朱砂'], ['jade', '青竹'], ['gold', '泥金']].map(([k, l]) => {
            const n = annAll.filter((x) => (x.a.color || 'red') === k).length;
            return `<button class="chip ${ui.noteColor === k ? 'active' : ''}" data-action="set-note-color" data-val="${k}" ${n ? '' : 'disabled'}>${l} ${n}</button>`;
          }).join('')}
        </div>
        ${ui.noteMulti ? `<div class="note-multi-bar">
          <button class="btn btn-ghost btn-sm" data-action="note-pick-all" id="notePickAll">全选</button>
          <span class="note-pick-count" id="notePickCount">已选 ${ui.notePicked.size} 条</span>
          <span class="note-multi-colors" title="给选中笔记改色">${[['red', '朱砂'], ['jade', '青竹'], ['gold', '泥金']].map(([k, l]) =>
            `<button class="hl-dot hl-${k}" data-action="note-bulk-color" data-val="${k}" title="改为${l}" aria-label="改为${l}"></button>`).join('')}</span>
          <button class="btn btn-ghost btn-sm btn-danger" data-action="note-bulk-del">${icon('trash', 'ic-sm')} 删除</button>
        </div>` : ''}
        <div class="setting-list">
          ${annAll.map(({ bid, a, i }) => {
            const bt = (getBook(bid) || {}).title || '已删除的卷';
            const frag = a.text.length > 42 ? a.text.slice(0, 42) + '…' : a.text;
            const hay = (bt + ' ' + a.text + ' ' + (a.note || '') + ' 第' + a.ch + '章').toLowerCase();
            const key = bid + ':' + i;
            const on = ui.notePicked.has(key);
            return `<div class="setting-row${ui.noteMulti ? ' note-multi' : ''}${on ? ' picked' : ''}" data-note-item="1" data-note-book="${esc(bid)}" data-note-key="${esc(key)}" data-note-color="${esc(a.color || 'red')}" data-note-search="${esc(hay)}">
              ${ui.noteMulti ? `<span class="note-pick ${on ? 'on' : ''}">${on ? icon('check', 'ic-sm') : ''}</span>` : ''}
              <div class="st" style="cursor:pointer" data-action="open-annotation" data-id="${esc(bid)}" data-val="${i}">《${esc(bt)}》<small><i class="ann-dot hl-${esc(a.color || 'red')}"></i>${esc(frag)}${a.note ? ' · 批注：' + esc(a.note) : ''} · 第 ${a.ch} 章</small></div>
              <button class="btn btn-ghost btn-sm btn-danger" data-action="annotation-del-global" data-id="${esc(bid)}" data-val="${i}">删除</button>
            </div>`;
          }).join('')}
        </div>
        <div id="noteNoMatch" class="cat-empty" hidden>没有匹配的笔记<br><small>换个词，或把「按卷」切回全部卷</small></div></div>`;
    }
    html += `<div class="section">${sectionHead('卷档管理', '', '')}
      <div class="setting-list">
        ${(function storageRow() {
          const st = storageStats();
          if (!st) return '';
          /* 三档：已满（save 失败过）> 偏紧（>75%）> 宽裕。
             封面图是最容易撑爆配额的一块，单独报出来，并给一个一键清理。 */
          const full = !!ui.storageFull || st.ratio >= 1;
          const tight = !full && st.ratio >= 0.75;
          const tip = full ? '已写不进去，先导出备份再清理'
            : tight ? '接近浏览器上限，建议清理或导出备份'
              : '余量充足';
          /* 封面超过总量两成时才报具体占用，否则「已用 0.1 MB · 封面图占 0.1 MB」
             这种重复数字对用户没有信息量。 */
          const coverHeavy = st.coverN > 0 && st.coverChars > st.chars * 0.2;
          const canClean = st.coverN > 0 && (full || tight);
          return `<div class="setting-row${full ? ' storage-full' : tight ? ' storage-tight' : ''}">
            ${icon('clock')}<div class="st">本地存储<small>已用 ${fmtBytes(st.chars * 2)}${st.coverN ? ' · 封面图 ' + st.coverN + ' 张' : ''}${coverHeavy ? '（占 ' + fmtBytes(st.coverChars * 2) + '）' : ''} · ${tip}</small></div>
            ${canClean ? `<button class="btn btn-ghost btn-sm" data-action="clean-covers">清理封面</button>` : ''}
          </div>`;
        })()}
        <div class="setting-row" data-action="export-backup">${icon('clock')}<div class="st">导出完整备份<small>藏卷、进度、笔记、封面、设置、自定义书源与在线音色、本地卷正文，存成一个 JSON 文件</small></div>${icon('right', 'ic-sm')}</div>
        <div class="setting-row" data-action="import-backup">${icon('book')}<div class="st">从备份恢复<small>选择之前导出的 .json，会覆盖当前所有数据</small></div>${icon('right', 'ic-sm')}</div>
        <div class="setting-row" data-action="export-annotations">${icon('brush')}<div class="st">导出划线与批注<small>${noteFilterActive() ? '按「我的笔记」当前的搜索 / 按卷 / 颜色筛选导出' : '把所有卷的笔记整理成一个 TXT'}，方便留存或搬运</small></div>${icon('right', 'ic-sm')}</div>
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
        <div class="setting-row" data-action="open-shortcut-help">${icon('settings')}<div class="st">键盘捷径<small>按 ? 随时打开，桌面上读墨更快</small></div>${icon('right', 'ic-sm')}</div>
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
    const hidx = buildHlIndex(b.id);
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
            <p class="re-hint">${b.online ? '内置的' + allBooks().filter((x) => !x.online).length + '卷公版书随墨卷离线保存，断网也能读。' : ''} 连续失败会自动放慢重试，点上方按钮可立即再试。</p>
          </div>`;
    const bodyInner = flip
      ? `<div class="reader-paper flip-paper" id="readerPaper">
          <div class="flip-page flip-adj" id="flipAdj" hidden aria-hidden="true"></div>
          <div class="flip-page" id="flipPage"><div class="reader-loading">正 在 分 页 …</div></div>
          <div class="flip-page flip-back" id="flipBack" hidden aria-hidden="true"></div>
          <div class="flip-shade" id="flipShade" hidden aria-hidden="true"></div>
          <div class="flip-foot" id="flipFoot">—</div>
        </div>`
      : `<div class="reader-paper" id="readerPaper">
          <div class="reader-chapter-no">${esc(b.title)} · ${esc(b.author)}</div>
          <h1>${esc(cur.title)}</h1>
          ${errMsg ? errBlock : paras.map((p, j) => `<p class="${p.indexOf('（本章完') === 0 ? 'end-note' : ''}" data-pi="${j}">${highlightHtml(p, b.id, ch, j, hidx)}</p>`).join('')}
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
        <button class="rb-mbtn" data-action="reader-catalog" title="目录 / 卷签 / 笔记">${icon('list')}<span>目录</span></button>
        <button class="rb-mbtn ${inShelf ? 'is-on' : ''}" data-action="reader-shelf-toggle" id="shelfBtn" data-on="${inShelf}" title="加入 / 移出藏卷">${icon(inShelf ? 'check' : 'plus')}<span>${inShelf ? '已在藏卷' : '收入藏卷'}</span></button>
        <button class="rb-mbtn" data-action="toggle-bookmark" id="bmBtn" title="添加 / 移除卷签">${icon('star')}<span>珍藏</span></button>
        <button class="rb-mbtn" data-action="toggle-tts" id="ttsBtn" title="打开听卷界面">${icon('volume')}<span>听卷</span></button>
        <button class="rb-mbtn" data-action="reader-theme-toggle" id="themeBtn" data-on="${night}" title="切换夜墨 / 日光">${icon(night ? 'sun' : 'moon')}<span>${night ? '日间' : '夜间'}</span></button>
        <button class="rb-mbtn" data-action="reader-settings" title="字号与纸张">${icon('settings')}<span>设置</span></button>
        <button class="rb-mbtn" data-action="reader-search" title="在本书中搜索">${icon('search')}<span>搜索</span></button>
      </div>`;
    /* tabindex="-1"：抽屉关掉后焦点要能回到阅读器本身，否则会掉到 body（读屏会从头念） */
    return `<div class="reader mode-${flip ? 'flip' : 'scroll'}" id="reader" tabindex="-1" data-paper="${state.settings.paper}">
      <div class="sr-announce" id="readerAnnounce" role="status" aria-live="polite" aria-atomic="true"></div>
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
      <div class="search-drawer" id="searchDrawer" hidden></div>
      <div class="search-nav" id="searchNav" hidden>
        <button class="sn-btn" data-action="search-nav-prev" aria-label="上一处" title="上一处">‹</button>
        <span class="sn-count" id="searchNavCount">—</span>
        <button class="sn-btn" data-action="search-nav-next" aria-label="下一处" title="下一处">›</button>
        <button class="sn-x" data-action="search-nav-close" aria-label="结束检索" title="结束检索">${icon('close', 'ic-sm')}</button>
      </div>
      <div class="hl-pop" id="hlPop" hidden>
        <button class="hl-btn" data-action="hl-save">划线</button>
        <button class="hl-btn" data-action="hl-note-open">批注</button>
        <span class="hl-colors" id="hlColors">${[['red', '朱砂'], ['jade', '青竹'], ['gold', '泥金']].map(([k, l]) =>
          `<button class="hl-dot hl-${k} ${ui.hlColor === k ? 'active' : ''}" data-action="hl-color" data-val="${k}" title="${l}" aria-label="${l}"></button>`).join('')}</span>
        <div class="hl-note" id="hlNote" hidden>
          <textarea id="hlNoteInput" rows="2" placeholder="写点想法（可留空）"></textarea>
          <button class="hl-btn primary" data-action="hl-save-note">保存</button>
        </div>
      </div>
      <div class="hl-pop hl-edit" id="hlEdit" hidden>
        <span class="hl-colors" id="hlEditColors">${[['red', '朱砂'], ['jade', '青竹'], ['gold', '泥金']].map(([k, l]) =>
          `<button class="hl-dot hl-${k}" data-action="hl-edit-color" data-val="${k}" title="改为${l}" aria-label="改为${l}"></button>`).join('')}</span>
        <button class="hl-btn" data-action="hl-edit-note">批注</button>
        <button class="hl-btn danger" data-action="hl-edit-del">删除</button>
        <div class="hl-note" id="hlEditNote" hidden>
          <textarea id="hlEditNoteInput" rows="2" placeholder="写点想法"></textarea>
          <button class="hl-btn primary" data-action="hl-edit-note-save">保存</button>
        </div>
      </div>
    </div>`;
  }
  /* 顶栏与阅读器共用一套夜间切换：theme 与 paper 必须同步，
     否则书城是夜墨、阅读器纸色还是浅的（或反过来）。 */
  function toggleNight() {
    const night = state.settings.theme !== 'night';
    if (night) {
      if (state.settings.paper !== 'night') state.settings.lastDayPaper = state.settings.paper || 'xuan';
      state.settings.paper = 'night';
    } else state.settings.paper = state.settings.lastDayPaper || 'xuan';
    state.settings.theme = night ? 'night' : 'day';
    save(); applyTheme();
    if ($('#reader')) { applyReaderStyle(); syncReaderMenu(); }
    return night;
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
      { text: b.title + ' · ' + b.author, type: 'no', idx: 0 },
      { text: chapterList(b)[ch - 1].title, type: 'h1', idx: 1 }
    ];
    paragraphs(b, ch - 1).forEach((t) => arr.push({ text: t, type: t.indexOf('（本章完') === 0 ? 'end' : 'p', idx: arr.length }));
    /* 校勘记单独占末尾一行入口，点开在面板里看：翻页模式下没法就地展开，
       硬塞在正文里又会挤掉一整页的字 */
    const notes = chapterNotes(b, ch - 1);
    if (notes.length) arr.push({ text: '注释 · ' + notes.length + ' 条', type: 'notes', idx: arr.length });
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
    const clsOf = (type) => (type === 'end' ? 'end-note' : type === 'no' ? 'reader-chapter-no' : type === 'notes' ? 'ch-notes-entry' : '');
    const nodeOf = (type) => document.createElement(type === 'h1' ? 'h1' : type === 'no' ? 'div' : 'p');
    const setIndent = (el, type, indent) => {
      if (type === 'p' || type === 'end' || type === 'notes') el.style.textIndent = indent ? '2em' : '0';
    };

    /* 阶段 0：五种类型的 marginBottom 固定不变，先「写一批、读一批」算好，
       后面几百段都不用再碰 getComputedStyle。标签与 class 必须和真正渲染时一致。 */
    const types = ['no', 'h1', 'p', 'end', 'notes'];
    const mMargin = {}, probes = {};
    types.forEach((type) => {
      const el = nodeOf(type); el.className = clsOf(type);
      m.appendChild(el); probes[type] = el;
    });
    types.forEach((type) => { mMargin[type] = parseFloat(getComputedStyle(probes[type]).marginBottom) || 0; });

    /* 阶段 1+2：分批「整批写 → 整批读」，每批只触发一次布局。
       原来每段都是「写 textContent → 读 offsetHeight」，一章几百次强制同步布局；
       分 64 段一批，既把次数降到 N/64，又不像一次建 N 个节点那样吃内存。 */
    const heights = [];
    const BATCH = 64;
    for (let start = 0; start < items.length; start += BATCH) {
      const end = Math.min(start + BATCH, items.length);
      const batch = [];
      for (let k = start; k < end; k++) {
        const it = items[k];
        const el = nodeOf(it.type);
        el.className = clsOf(it.type);
        setIndent(el, it.type, it.type === 'p');
        el.textContent = it.text;
        m.appendChild(el);
        batch.push(el);
      }
      batch.forEach((el, j) => heights.push(el.offsetHeight + mMargin[items[start + j].type]));
      batch.forEach((el) => el.remove());
    }

    /* 只有「单段比一页还长」需要二分切块时才逐次测量，绝大多数章节用不到 */
    function measure(type, text, indent) {
      const el = probes[type];
      el.textContent = text;
      setIndent(el, type, indent);
      return el.offsetHeight + mMargin[type];
    }
    const pages = [];
    let cur = [], used = 0;
    const flush = () => { if (cur.length) { pages.push(cur); cur = []; used = 0; } };
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      let rest = it.text, first = true;
      const h = heights[i];
      if (h <= H - used) {
        cur.push({ text: rest, type: it.type, indent: it.type === 'p', idx: it.idx });
        used += h;
        continue;
      }
      if (h <= H) {
        flush();
        cur.push({ text: rest, type: it.type, indent: it.type === 'p', idx: it.idx });
        used = h;
        continue;
      }
      /* 注释入口就一行：实在放不下就整行挪到下一页，别按字数腰斩 */
      if (it.type !== 'p' && it.type !== 'end') {
        flush();
        cur.push({ text: rest, type: it.type, indent: false, idx: it.idx });
        used = h;
        continue;
      }
      /* 单段比一页还长：二分找能放下的最大字数 */
      while (rest.length) {
        const avail = H - used;
        if (avail < 30) { flush(); continue; }
        let lo = 1, hi = rest.length, best = 0, bestH = 0;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          const h = measure('p', rest.slice(0, mid), first);
          if (h <= avail) { best = mid; bestH = h; lo = mid + 1; }
          else hi = mid - 1;
        }
        if (!best) best = Math.min(rest.length, 20);
        const chunk = rest.slice(0, best);
        cur.push({ text: chunk, type: 'p', indent: first, idx: it.idx });
        /* bestH 就是 rest.slice(0, best) 的高度，二分里已经量过，省掉一次强制布局 */
        used += bestH || measure('p', chunk, first);
        rest = rest.slice(best);
        first = false;
        if (rest.length) flush();
      }
    }
    flush();
    m.remove();
    return pages.length ? pages : [[{ text: '（本章暂无内容）', type: 'p', indent: false }]];
  }
  /* 分页结果缓存：同一章在同一排版参数下会被反复重算（调字号来回切、退出重进、
     翻章回来、窗口 resize）。key 里带内容与排版签名，正文或样式一变自动失效。 */
  const pageCache = new Map();
  function flipSig(items) {
    let len = 0, hash = 0;
    for (let i = 0; i < items.length; i++) {
      len += items[i].text.length;
      hash = (hash * 31 + items[i].text.length + items[i].type.charCodeAt(0)) | 0;
    }
    return items.length + ':' + len + ':' + hash;
  }
  function paginateCached(items, W, H, bookId, ch) {
    const st = state.settings;
    const key = [bookId, ch, W, H, st.fs, st.lh, st.font, st.paper, flipSig(items)].join('|');
    const hit = pageCache.get(key);
    if (hit) return hit;
    const pages = paginate(items, W, H);
    if (pageCache.size >= 24) pageCache.clear(); /* 长卷别把内存吃住 */
    pageCache.set(key, pages);
    return pages;
  }

  /* 一页的内容。翻页动画要同时摆两页，所以抽出来给「当前页」和「旁边那页」共用 */
  function pageInner(pos) {
    const page = flipState.pages[pos];
    if (!page) return '';
    const hidx = buildHlIndex(flipState.id);
    return page.map((it) => {
      if (it.type === 'no') return `<div class="reader-chapter-no" data-fi="${it.idx}">${esc(it.text)}</div>`;
      if (it.type === 'h1') return `<h1 data-fi="${it.idx}">${esc(it.text)}</h1>`;
      if (it.type === 'notes') return `<button class="ch-notes-entry" data-action="open-notes" data-fi="${it.idx}">${icon('list', 'ic-sm')} ${esc(it.text)}</button>`;
      return `<p class="${it.type === 'end' ? 'end-note' : ''}" data-fi="${it.idx}" style="${it.indent ? '' : 'text-indent:0'}">${highlightHtml(it.text, flipState.id, flipState.ch, it.idx - 2, hidx)}</p>`;
    }).join('');
  }
  /* 落定某一页：换内容、页脚、进度。直接跳页与动画收尾都走这里 */
  function commitPage(pos) {
    const fp = $('#flipPage'); if (!fp) return;
    flipState.page = pos;
    fp.innerHTML = pageInner(pos);
    const foot = $('#flipFoot');
    if (foot) foot.innerHTML = `第 ${flipState.ch} 章 · <b>${flipState.page + 1}</b> / ${flipState.pages.length} 页`;
    const pct = flipState.pages.length > 1 ? flipState.page / (flipState.pages.length - 1) : 0;
    state.progress[flipState.id] = { ch: flipState.ch, pct, updated: Date.now() };
    state.lastRead = flipState.id;
    scheduleSave();
    updateReaderSeek();
    syncBookmarkBtn();
  }
  function renderFlipPage(dir) {
    const fp = $('#flipPage'); if (!fp || !flipState.pages.length) return;
    fp.className = 'flip-page';
    fp.style.transform = '';
    commitPage(flipState.page);
    if (!dir) return;
    /* 换章时没有「上一页」可摆，就让新章从翻过去的那一侧滑进来，衔接上翻页的手感 */
    void fp.offsetWidth;
    if (animMode() === 'fade' || animMode() === 'realistic') fp.classList.add('anim-fade-' + dir);
    else if (animMode() === 'slide') fp.classList.add('anim-slide-' + dir);
  }

  /* ---------- 翻页动画：整页滑动 ---------- */
  const FLIP_EASE = 'cubic-bezier(.22,.68,.36,1)';
  let flipBusy = false;
  /* 把「旁边那页」铺好，并放到屏幕外对应的那一侧 */
  function ensureAdj(pos, dir, W) {
    const adj = $('#flipAdj'); if (!adj) return null;
    adj.innerHTML = pageInner(pos);
    adj.hidden = false;
    adj.style.transform = 'translate3d(' + (dir * W) + 'px,0,0)';
    return adj;
  }
  function clearAdj() {
    const adj = $('#flipAdj');
    if (!adj) return;
    adj.hidden = true; adj.innerHTML = ''; adj.style.transform = '';
  }
  /* 点击 / 键盘翻页：新页从一侧滑入、旧页滑出，两页一起动才是完整的翻页 */
  function flipSlide(delta) {
    const fp = $('#flipPage'), adj = $('#flipAdj');
    const np = flipState.page + delta;
    if (!fp || !adj || flipBusy || np < 0 || np >= flipState.pages.length) return false;
    /* 老 WebView 没有 Web Animations，别把翻页卡死在这里，交给调用方直接换页 */
    if (typeof fp.animate !== 'function') return false;
    const W = fp.clientWidth || 1;
    flipBusy = true;
    ensureAdj(np, delta, W);
    const a1 = fp.animate(
      [{ transform: 'translate3d(0,0,0)' }, { transform: 'translate3d(' + (-delta * W) + 'px,0,0)' }],
      { duration: 240, easing: FLIP_EASE, fill: 'both' });
    const a2 = adj.animate(
      [{ transform: 'translate3d(' + (delta * W) + 'px,0,0)' }, { transform: 'translate3d(0,0,0)' }],
      { duration: 240, easing: FLIP_EASE, fill: 'both' });
    const finish = () => {
      if (!flipBusy) return;
      flipBusy = false;
      commitPage(np);
      fp.style.transform = '';
      clearAdj();
      a1.cancel(); a2.cancel();
    };
    a2.onfinish = finish;
    /* 兜底：切到后台时 onfinish 不一定来，别把翻页卡在锁上 */
    setTimeout(() => { if (flipBusy) finish(); }, 240 + 140);
    return true;
  }
  /* 上下滚动模式里按空格 / PageDown 滚一屏；已经到头还往前，就像翻页那样换章，
     否则用户会以为按键失灵。滚到底再换章也符合「读到本章末」的直觉。 */
  function scrollReaderBody(body, dy, pageStep) {
    const max = Math.max(0, body.scrollHeight - body.clientHeight);
    const before = body.scrollTop;
    const to = Math.max(0, Math.min(max, before + dy));
    body.scrollTop = to; /* .reader-body 带 scroll-behavior:smooth，这里是带动画滚 */
    if (!pageStep || Math.abs(to - before) >= 1) return;
    const id = readerRoot.dataset.currentBook;
    const ch = Number(readerRoot.dataset.currentCh);
    switchChapter(id, ch + (dy > 0 ? 1 : -1));
  }
  function flipBy(delta) {
    const fs = flipState;
    if (!fs.pages.length || flipBusy) return;
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
    if (animMode() === 'slide' && flipSlide(delta)) return;
    if (animMode() === 'realistic' && flipRealistic(delta)) return;
    fs.page = np;
    renderFlipPage(animMode() === 'fade' ? (delta > 0 ? 'next' : 'prev') : '');
  }

  /* ---------- 仿真翻页：当前页就是一张纸，绕左侧书脊翻过去 ----------
     正面 #flipPage、背面 #flipBack 各转一个方向，靠 backface-visibility 决定谁可见；
     底下 #flipAdj 是翻过去之后露出的那一页，#flipShade 是书脊阴影 + 纸面受光。 */
  const REAL_3D_OK = (() => {
    try { return !!(window.CSS && CSS.supports && CSS.supports('backface-visibility', 'hidden')
      && CSS.supports('perspective', '1000px')); } catch (_) { return false; }
  })();
  function animMode() {
    const a = state.settings.flipAnim;
    /* CSS 的 reduced-motion 只压得住 CSS 动画；翻页用的是 Element.animate()，
       得在这里一并关掉，别让开了「减少动态效果」的用户仍被 240ms 动画晃到 */
    try {
      if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return 'none';
    } catch (_) { /* 老 WebView 没有 matchMedia */ }
    /* 老 WebView 撑不起 3D：静默退回整页滑动，别让翻页直接失效 */
    return a === 'realistic' && !REAL_3D_OK ? 'slide' : a;
  }
  function realLayers() {
    const paper = $('#readerPaper'), fp = $('#flipPage'), back = $('#flipBack'),
      adj = $('#flipAdj'), shade = $('#flipShade');
    return (paper && fp && back && adj && shade) ? { paper, fp, back, adj, shade } : null;
  }
  function realPose(dir, p) {
    /* 只掀到 90°：书脊在屏幕左缘，翻过 90° 纸就整个跑到屏幕外了，
       而且背面的反印字会和底下那页的文字叠成双重曝光。让纸立起来、
       底下的新页从右边一点点露出来，才是单栏全宽版式里最像真书的翻法。
       往前翻则从立起的 -90° 放平到 0°，把上一页盖回来。 */
    const q = Math.min(1, Math.max(0, p));
    /* 正角 = 纸向后（远离眼睛）掀起，右缘往书脊收缩；
       负角会把纸朝观察者翻、被透视放大，文字会挤成一条，方向是反的。 */
    const ang = dir > 0 ? 90 * q : 90 - 90 * q;
    return {
      fp: 'rotateY(' + ang.toFixed(2) + 'deg)',
      /* 纸全程不透明：一旦给它做淡出插值，中途就会变成半透明，
         底下那页的字会透上来，两页文字叠成双重曝光。立到 90° 时
         纸本身已被透视压成一条线，看不见，不需要再淡。 */
      shade: 0.42 * Math.sin(Math.PI * q)
    };
  }
  function realAt(L, dir, p) {
    const q = realPose(dir, p);
    L.fp.style.transform = q.fp;
    L.shade.style.opacity = String(q.shade);
  }
  function realPrepare(pos, dir) {
    const L = realLayers(); if (!L) return null;
    const cur = flipState.page;
    /* 往后翻：底下摆目标页，正面（当前页）翻走后露出来；
       往前翻：底下摆当前页，正面换成目标页，从书脊翻回来盖住。 */
    L.adj.innerHTML = pageInner(dir > 0 ? pos : cur);
    L.fp.innerHTML = pageInner(dir > 0 ? cur : pos);
    L.adj.hidden = false; L.shade.hidden = false;
    L.back.hidden = true; L.back.innerHTML = '';
    L.adj.style.transform = '';
    L.paper.classList.add('realistic');
    realAt(L, dir, 0);
    return L;
  }
  function realClear() {
    const L = realLayers(); if (!L) return;
    L.paper.classList.remove('realistic');
    L.fp.style.transform = ''; L.fp.style.opacity = '';
    L.back.style.transform = ''; L.back.style.opacity = '';
    L.back.hidden = true; L.back.innerHTML = '';
    L.shade.hidden = true; L.shade.style.opacity = '0';
    clearAdj();
  }
  /* 三个图层同步播一段 3D 动画；onfinish 不靠谱时用定时器兜底 */
  function realAnimate(L, dir, p0, p1, dur, done) {
    if (typeof L.fp.animate !== 'function') { done(); return; }
    const poses = [p0, (p0 + p1) / 2, p1].map((p) => realPose(dir, p));
    const opt = { duration: dur, easing: FLIP_EASE, fill: 'both' };
    const kf = (extra) => poses.map((q, i) => Object.assign({ offset: i / 2 }, extra(q)));
    const a1 = L.fp.animate(kf((q) => ({ transform: q.fp })), opt);
    const a2 = L.shade.animate(kf((q) => ({ opacity: q.shade })), opt);
    let ended = false;
    const finish = () => {
      if (ended) return; ended = true;
      a1.cancel(); a2.cancel();
      done();
    };
    a1.onfinish = finish;
    setTimeout(finish, dur + 120);
  }
  function flipRealistic(delta) {
    const L0 = realLayers(); if (!L0 || flipBusy) return false;
    const np = flipState.page + delta;
    if (np < 0 || np >= flipState.pages.length) return false;
    if (typeof L0.fp.animate !== 'function' || !REAL_3D_OK) return false;
    const L = realPrepare(np, delta); if (!L) return false;
    flipBusy = true;
    realAnimate(L, delta, 0, 1, 300, () => {
      flipBusy = false;
      commitPage(np);
      realClear();
    });
    return true;
  }
  function realDragSettle(dir, dx, W, done) {
    const L = realLayers(); if (!L) return;
    const target = flipState.page + dir;
    const go = done && target >= 0 && target < flipState.pages.length;
    const p0 = Math.max(0, Math.min(1, (-dx * dir) / W));
    if (typeof L.fp.animate !== 'function') {
      realClear(); if (go) commitPage(target); return;
    }
    flipBusy = true;
    realAnimate(L, dir, p0, go ? 1 : 0, go ? 220 : 180, () => {
      flipBusy = false;
      if (go) commitPage(target);
      realClear();
    });
  }
  /* 跟手翻页：手指压住往左/右推，两页跟着走；松手看「推得够远 / 甩得够快」决定翻过去还是弹回。
     这样按住后左右摆动也有连续反馈，而不是甩完才知道翻没翻。 */
  function bindFlipDrag(body) {
    let d = null, raf = 0;
    const clampDx = (dx, W) => Math.max(-W * 0.98, Math.min(W * 0.98, dx));
    const paint = () => {
      raf = 0;
      if (!d || !d.active) return;
      if (d.mode === 'real') {
        const L = realLayers(); if (!L) return;
        realAt(L, d.dir, Math.max(0, Math.min(1, (-d.pend * d.dir) / d.W)));
        return;
      }
      const fp = $('#flipPage'), adj = $('#flipAdj');
      if (fp) fp.style.transform = 'translate3d(' + d.pend + 'px,0,0)';
      if (adj) adj.style.transform = 'translate3d(' + (d.dir * d.W + d.pend) + 'px,0,0)';
    };
    body.addEventListener('pointerdown', (ev) => {
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      if (flipBusy || !flipState.pages.length) return;
      if (ev.target.closest('button, a, mark.hl-mark')) return;
      if ($('#hlPop') && !$('#hlPop').hidden) return;
      if (window.getSelection && String(window.getSelection()).trim()) return;
      d = { x: ev.clientX, y: ev.clientY, pid: ev.pointerId, dir: 0, W: 0, lock: false, active: false,
        pend: 0, lastX: ev.clientX, lastT: performance.now(), v: 0 };
    });
    body.addEventListener('pointermove', (ev) => {
      if (!d || d.dead || ev.pointerId !== d.pid) return;
      /* 长按选词时手指一动就是拖选择手柄，别抢过来当翻页 */
      if (window.getSelection && String(window.getSelection()).trim()) { d.dead = true; return; }
      const dy = ev.clientY - d.y;
      if (!d.lock) {
        const dx0 = ev.clientX - d.x;
        if (Math.abs(dx0) < 8 && Math.abs(dy) < 8) return;
        /* 竖着划就当没这回事，交回给原来的点击/选择逻辑 */
        if (Math.abs(dx0) <= Math.abs(dy) * 1.1) { d.dead = true; return; }
        const dir = dx0 < 0 ? 1 : -1;
        const fp = $('#flipPage'), adj = $('#flipAdj');
        const np = flipState.page + dir;
        /* 到头了：这次不跟手，但留着 d 好把松手那下 click 压掉 */
        if (!fp || !adj || np < 0 || np >= flipState.pages.length) { d.dead = true; return; }
        d.W = fp.clientWidth || 1;
        d.mode = animMode() === 'realistic' && REAL_3D_OK && typeof fp.animate === 'function' ? 'real' : 'slide';
        if (d.mode === 'real') realPrepare(np, dir);
        else ensureAdj(np, dir, d.W);
        d.dir = dir; d.lock = true; d.active = true;
        ui.flipSwiped = true;
        body.classList.add('flip-dragging');
        try { body.setPointerCapture(ev.pointerId); } catch (_) {}
      }
      /* 拖回起点再往另一边摆：把对侧那页换过来，两个方向都能跟手 */
      const want = ev.clientX < d.x ? 1 : -1;
      const npWant = flipState.page + want;
      if (want !== d.dir && Math.abs(ev.clientX - d.x) > 20 && npWant >= 0 && npWant < flipState.pages.length) {
        d.dir = want;
        if (d.mode === 'real') realPrepare(npWant, want);
        else ensureAdj(npWant, want, d.W);
      }
      const now = performance.now(), dt = now - d.lastT;
      if (dt > 0) d.v = (ev.clientX - d.lastX) / dt;
      d.lastX = ev.clientX; d.lastT = now;
      d.pend = clampDx(ev.clientX - d.x, d.W);
      if (!raf) raf = requestAnimationFrame(paint); /* 一帧只挪一次 */
      if (ev.cancelable) ev.preventDefault();
    }, { passive: false });
    const end = (ev) => {
      if (!d) return;
      const cur = d; d = null;
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      body.classList.remove('flip-dragging');
      const raw = ev.type === 'pointerup' ? ev.clientX : cur.lastX;
      /* 手指确实挪过位置：松手那一下的 click 不能再翻一页 / 折叠工具栏，
         否则「想往前拖但已在第一页」会反手翻到下一页 */
      if (Math.abs(raw - cur.x) > 8) {
        ui.flipSwiped = true;
        setTimeout(() => { ui.flipSwiped = false; }, 350);
      }
      if (!cur.active) return;
      const dx = clampDx(raw - cur.x, cur.W);
      const far = Math.abs(dx) > Math.min(cur.W * 0.26, 96);
      const flick = Math.abs(cur.v) > 0.32 && Math.sign(cur.v) === Math.sign(dx);
      /* dx 必须落在目标页那一侧（dir=1 时是负数），往回拖不管拖多远都是弹回 */
      const toward = dx * -cur.dir > 0;
      flipDragSettle(cur.dir, dx, cur.W, toward && Math.abs(dx) > 14 && (far || flick));
      setTimeout(() => { ui.flipSwiped = false; }, 350);
    };
    body.addEventListener('pointerup', end);
    body.addEventListener('pointercancel', end);
  }
  /* 松手后的收尾：翻过去或弹回来，200ms 左右，不拖沓 */
  function flipDragSettle(dir, dx, W, done) {
    if (animMode() === 'realistic' && REAL_3D_OK) return realDragSettle(dir, dx, W, done);
    const fp = $('#flipPage'), adj = $('#flipAdj');
    if (!fp || !adj) return;
    const target = flipState.page + dir;
    const go = done && target >= 0 && target < flipState.pages.length;
    /* 老 WebView：没有动画就直接落位，至少行为是对的 */
    if (typeof fp.animate !== 'function') {
      fp.style.transform = '';
      clearAdj();
      if (go) commitPage(target);
      return;
    }
    const to = done ? -dir * W : 0;
    const dur = done ? 200 : 170;
    const a1 = fp.animate(
      [{ transform: 'translate3d(' + dx + 'px,0,0)' }, { transform: 'translate3d(' + to + 'px,0,0)' }],
      { duration: dur, easing: FLIP_EASE, fill: 'both' });
    const a2 = adj.animate(
      [{ transform: 'translate3d(' + (dir * W + dx) + 'px,0,0)' }, { transform: 'translate3d(' + (dir * W + to) + 'px,0,0)' }],
      { duration: dur, easing: FLIP_EASE, fill: 'both' });
    flipBusy = true;
    const finish = () => {
      if (!flipBusy) return;
      flipBusy = false;
      if (go) commitPage(target);
      fp.style.transform = '';
      clearAdj();
      a1.cancel(); a2.cancel();
    };
    a2.onfinish = finish;
    setTimeout(() => { if (flipBusy) finish(); }, dur + 140);
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
    /* 听卷进度条：Tab 能停到它上面，方向键就该能调，不然它只是一块看得见摸不着的色条 */
    if (document.activeElement && document.activeElement.id === 'lpTrack' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault(); e.stopImmediatePropagation();
      const cur = listen.text ? listen.charIndex / listen.text.length : 0;
      listenSeekRatio(cur + (e.key === 'ArrowRight' ? 0.02 : -0.02));
    }
  });

  /* ---------- 卷签 ---------- */
  function bookmarkList(id) { return state.bookmarks[id] || []; }

  /* ---------- 划线 / 批注 ---------- */
  function annotationList(id) { return state.annotations[id] || []; }
  function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  const HL_COLORS = ['red', 'jade', 'gold'];
  /* 渲染整章前先按「章:段」把全书划线建成一张表。
     原来每段都 filter 一遍全书笔记（几百段 × 几百条 = 十几万次比较），
     现在建表 O(M)、每段查表 O(1)。表只在单次渲染内使用，不必操心失效。 */
  function buildHlIndex(bid) {
    const idx = new Map();
    annotationList(bid).forEach((a) => {
      if (!a.text) return;
      const q = esc(String(a.text).trim());
      if (!q) return;
      const k = a.ch + ':' + a.pi;
      let m = idx.get(k);
      if (!m) { m = new Map(); idx.set(k, m); }
      if (!m.has(q)) m.set(q, HL_COLORS.includes(a.color) ? a.color : 'red');
    });
    return idx;
  }
  /* 把本章本段的所有划线一次性套 <mark>：先 esc 再单次正则替换，
     既防 XSS，又避免多条重叠划线把已插入的标签二次拆坏。
     第 5 个参数是可选的预建索引；不传时退回只扫本段的局部构建（单段刷新用）。 */
  function highlightHtml(raw, bid, ch, pi, hidx) {
    const out = esc(raw);
    let map = hidx ? hidx.get(ch + ':' + pi) : null;
    if (!map) {
      map = new Map();
      annotationList(bid).filter((a) => a.ch === ch && a.pi === pi && a.text).forEach((a) => {
        const q = esc(String(a.text).trim());
        if (q && !map.has(q)) map.set(q, HL_COLORS.includes(a.color) ? a.color : 'red');
      });
    }
    if (!map.size) return out;
    const qs = Array.from(map.keys()).sort((x, y) => y.length - x.length);
    const re = new RegExp('(' + qs.map(escRe).join('|') + ')', 'g');
    return out.replace(re, (m) => '<mark class="hl-mark hl-' + (map.get(m) || 'red') + '">' + m + '</mark>');
  }
  /* 只重刷受影响的那一段（或翻页拆出来的几块），不整页重渲染，滚动位置不丢 */
  function refreshHlParas(bid, ch, pi) {
    $$('#readerPaper p[data-pi="' + pi + '"], #flipPage p[data-fi="' + (pi + 2) + '"]').forEach((el) => {
      el.innerHTML = highlightHtml(el.textContent, bid, ch, pi);
    });
  }
  const NOTE_COLORS = { red: '朱砂', jade: '青竹', gold: '泥金' };
  /* 笔记总览的筛选同样走 DOM hidden，不重渲染，输入焦点和滚动都在 */
  function applyNoteFilter() {
    const q = (ui.noteSearch || '').toLowerCase();
    const bk = ui.noteBook || '';
    const col = ui.noteColor || '';
    let shown = 0;
    $$('[data-note-item]').forEach((el) => {
      const hit = (!q || (el.dataset.noteSearch || '').includes(q)) && (!bk || el.dataset.noteBook === bk)
        && (!col || (el.dataset.noteColor || 'red') === col);
      el.hidden = !hit;
      if (hit) shown += 1;
    });
    const nm = $('#noteNoMatch'); if (nm) nm.hidden = shown > 0;
    const clr = $('.shelf-search-clear'); if (clr) clr.hidden = !ui.noteSearch;
    if (ui.noteMulti) syncNotePickBar();
  }
  /* 批量整理：勾选状态直接改 DOM，不整页重渲染，输入框焦点和滚动位置都不动 */
  function noteKeyOf(bid, idx) { return bid + ':' + idx; }
  function splitNoteKey(k) {
    const p = k.lastIndexOf(':');
    return [k.slice(0, p), Number(k.slice(p + 1))];
  }
  function syncNotePickBar() {
    const c = $('#notePickCount'); if (c) c.textContent = '已选 ' + ui.notePicked.size + ' 条';
    const all = $('#notePickAll');
    if (all) {
      const vis = $$('[data-note-item]').filter((el) => !el.hidden);
      all.textContent = vis.length && vis.every((el) => ui.notePicked.has(el.dataset.noteKey)) ? '取消全选' : '全选';
    }
  }
  function paintNotePick(el) {
    const on = ui.notePicked.has(el.dataset.noteKey);
    el.classList.toggle('picked', on);
    const box = el.querySelector('.note-pick');
    if (box) { box.classList.toggle('on', on); box.innerHTML = on ? icon('check', 'ic-sm') : ''; }
    return on;
  }
  function toggleNotePick(el) {
    const k = el.dataset.noteKey;
    if (ui.notePicked.has(k)) ui.notePicked.delete(k); else ui.notePicked.add(k);
    paintNotePick(el);
    syncNotePickBar();
  }
  function applyNoteBulkColor(col) {
    if (!ui.notePicked.size) { toast('先勾选要改色的笔记'); return; }
    const touched = [];
    ui.notePicked.forEach((k) => {
      const [bid, idx] = splitNoteKey(k);
      const a = annotationList(bid)[idx];
      if (a) { a.color = col; touched.push({ bid, a }); }
    });
    if (!touched.length) { toast('这些笔记已经不在了'); return; }
    save();
    $$('[data-note-item]').forEach((el) => {
      if (!ui.notePicked.has(el.dataset.noteKey)) return;
      const d = el.querySelector('.ann-dot'); if (d) d.className = 'ann-dot hl-' + col;
    });
    /* 笔记面板是开在阅读器里的，正文里的划线颜色要同步刷一下 */
    const cur = readerRoot.dataset.currentBook;
    if (cur) touched.filter((t) => t.bid === cur).forEach((t) => refreshHlParas(cur, t.a.ch, t.a.pi));
    /* 正按颜色筛时，改完色这些条目已不属于当前筛选，收起勾选并重筛，避免列表与筛选条件自相矛盾 */
    if (ui.noteColor) { ui.notePicked.clear(); rerender(); }
    toast('已改为' + NOTE_COLORS[col] + ' · ' + touched.length + ' 条');
  }
  function applyNoteBulkDelete() {
    if (!ui.notePicked.size) { toast('先勾选要删除的笔记'); return; }
    const n = ui.notePicked.size;
    if (!confirm('删除选中的 ' + n + ' 条笔记？此操作不可撤销。')) return;
    const byBook = new Map();
    ui.notePicked.forEach((k) => {
      const [bid, idx] = splitNoteKey(k);
      if (!byBook.has(bid)) byBook.set(bid, []);
      byBook.get(bid).push(idx);
    });
    let curTouched = [];
    byBook.forEach((idxs, bid) => {
      const list = annotationList(bid).slice();
      idxs.sort((x, y) => y - x).forEach((i) => { if (list[i]) curTouched.push({ bid, a: list[i] }); list.splice(i, 1); });
      state.annotations[bid] = list;
    });
    save();
    ui.notePicked.clear();
    ui.noteMulti = false;
    const cur = readerRoot.dataset.currentBook;
    if (cur) curTouched.filter((t) => t.bid === cur).forEach((t) => refreshHlParas(cur, t.a.ch, t.a.pi));
    rerender();
    toast('已删除 ' + n + ' 条笔记');
  }
  /* 把散在各卷的划线/批注收成一个 TXT，方便留存或搬到别处。
     onlyFiltered：遵守「我的笔记」当前的搜索词 / 按卷 / 按颜色筛选，无筛选时即全量。 */
  function notePassFilter(bid, a) {
    const q = (ui.noteSearch || '').toLowerCase();
    const b = getBook(bid);
    const hay = (((b && b.title) || bid) + ' ' + a.text + ' ' + (a.note || '') + ' 第' + a.ch + '章').toLowerCase();
    return (!q || hay.includes(q))
      && (!ui.noteBook || ui.noteBook === bid)
      && (!ui.noteColor || (a.color || 'red') === ui.noteColor);
  }
  function noteFilterActive() { return !!(ui.noteSearch || ui.noteBook || ui.noteColor); }
  function exportAnnotations(onlyFiltered) {
    const filtering = !!onlyFiltered && noteFilterActive();
    const lines = ['墨卷 · 划线与批注', '导出时间：' + new Date().toLocaleString('zh-CN')];
    if (filtering) {
      const bits = [];
      if (ui.noteSearch) bits.push('搜索「' + ui.noteSearch + '」');
      if (ui.noteBook) bits.push('《' + (((getBook(ui.noteBook) || {}).title) || ui.noteBook) + '》');
      if (ui.noteColor) bits.push(NOTE_COLORS[ui.noteColor] || '朱砂');
      lines.push('筛选条件：' + bits.join(' · '));
    }
    lines.push('');
    let n = 0;
    Object.keys(state.annotations || {}).forEach((bid) => {
      const list = annotationList(bid).filter((a) => (!filtering || notePassFilter(bid, a)));
      if (!list.length) return;
      const b = getBook(bid);
      lines.push('《' + ((b && b.title) || bid) + '》' + (b && b.author ? ' · ' + b.author : ''));
      list.slice().sort((x, y) => x.ch - y.ch || x.pi - y.pi || x.time - y.time).forEach((a) => {
        lines.push('  第 ' + a.ch + ' 章 · 第 ' + (a.pi + 1) + ' 段 · ' + (NOTE_COLORS[a.color || 'red'] || '朱砂'));
        lines.push('  原文：' + a.text);
        if (a.note) lines.push('  批注：' + a.note);
        lines.push('  ' + new Date(a.time).toLocaleDateString('zh-CN'));
        lines.push('');
        n += 1;
      });
      lines.push('');
    });
    if (!n) { toast(filtering ? '当前筛选下没有笔记' : '还没有划线或批注'); return; }
    toast(downloadText('墨卷笔记-' + today() + '.txt', lines.join('\n'))
      ? (filtering ? '已导出筛选结果 ' + n + ' 条' : '已导出 ' + n + ' 条笔记')
      : '导出失败，请检查浏览器下载权限');
  }
  let hlDraft = null;
  function hideHlPop() {
    const p = $('#hlPop'); if (p) p.hidden = true;
    const n = $('#hlNote'); if (n) n.hidden = true;
    hlDraft = null;
  }
  /* 点正文里已有的划线：就地改色、改批注、删除，不必绕去笔记列表 */
  let hlEditTarget = null;
  function hideHlEdit() {
    const p = $('#hlEdit'); if (p) p.hidden = true;
    const n = $('#hlEditNote'); if (n) n.hidden = true;
    hlEditTarget = null;
  }
  function openHlEdit(markEl) {
    const bid = readerRoot.dataset.currentBook; if (!bid || !markEl) return;
    const para = markEl.closest('#readerPaper p[data-pi], #flipPage p[data-fi]');
    if (!para) return;
    const pi = para.dataset.pi != null ? Number(para.dataset.pi) : Number(para.dataset.fi) - 2;
    const ch = Number(readerRoot.dataset.currentCh) || 1;
    const list = annotationList(bid);
    const idx = list.findIndex((a) => a.ch === ch && a.pi === pi && a.text === markEl.textContent);
    if (idx < 0) return;
    const pop = $('#hlEdit'); if (!pop) return;
    hideHlPop();
    hlEditTarget = { bid, ch, pi, idx };
    const col = list[idx].color || 'red';
    $$('#hlEditColors .hl-dot').forEach((b) => b.classList.toggle('active', b.dataset.val === col));
    const ta = $('#hlEditNoteInput'); if (ta) ta.value = list[idx].note || '';
    const n = $('#hlEditNote'); if (n) n.hidden = true;
    const r = markEl.getBoundingClientRect();
    const below = r.bottom + 132 < window.innerHeight;
    pop.dataset.below = below ? '1' : '0';
    pop.hidden = false;
    pop.style.left = Math.max(140, Math.min(window.innerWidth - 140, r.left + r.width / 2)) + 'px';
    pop.style.top = (below ? r.bottom + 8 : Math.max(10, r.top - 8)) + 'px';
  }
  /* 目标索引可能因为中间删过别的笔记而错位，落笔前先核对一遍 */
  function hlEditMutate(mut) {
    if (!hlEditTarget) return null;
    const t = hlEditTarget;
    const list = annotationList(t.bid);
    const a = list[t.idx];
    if (!a || a.ch !== t.ch || a.pi !== t.pi) { hideHlEdit(); return null; }
    mut(a, list);
    save();
    refreshHlParas(t.bid, a.ch, a.pi);
    return a;
  }
  const hlParaOf = (n) => {
    const el = n && (n.nodeType === 3 ? n.parentElement : n);
    return el && el.closest ? el.closest('#readerPaper p[data-pi], #flipPage p[data-fi]') : null;
  };
  /* 跨段选择：按段落切开，每段各取一段文字。
     划线是按「章:段:原文」存的，只有逐段对齐才能画出连续的几条高亮。 */
  function splitSelectionByPara(sel) {
    const paper = $('#readerPaper');
    if (!paper || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    const out = [];
    Array.from(paper.querySelectorAll('p[data-pi], p[data-fi]')).forEach((el) => {
      if (!range.intersectsNode(el)) return;
      const pi = el.dataset.pi != null ? Number(el.dataset.pi) : Number(el.dataset.fi) - 2;
      if (isNaN(pi) || pi < 0) return;
      const r = document.createRange();
      r.selectNodeContents(el);
      /* 把整段的范围钳到选区里：起点取两者较后的，终点取两者较前的 */
      if (range.compareBoundaryPoints(Range.START_TO_START, r) > 0) r.setStart(range.startContainer, range.startOffset);
      if (range.compareBoundaryPoints(Range.END_TO_END, r) < 0) r.setEnd(range.endContainer, range.endOffset);
      const t = String(r).replace(/\s+/g, ' ').trim();
      if (t) out.push({ pi, text: t });
    });
    return out.length ? out : null;
  }
  function onReaderSelection() {
    if (!readerRoot.dataset.currentBook) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const text = String(sel).trim();
    if (!text) return;
    const para = hlParaOf(sel.anchorNode), endPara = hlParaOf(sel.focusNode);
    if (!para || !endPara) return;
    const piOf = (el) => (el.dataset.pi != null ? Number(el.dataset.pi) : Number(el.dataset.fi) - 2);
    const b = getBook(readerRoot.dataset.currentBook); if (!b) return;
    /* 同一段内的选区直接过；跨段则逐段拆开。
       翻页模式会把长段拆成多块，两块其实还是同一段（pi 相同），照旧当一段处理。 */
    let parts = null;
    if (para !== endPara && piOf(para) !== piOf(endPara)) {
      parts = splitSelectionByPara(sel);
      if (!parts || parts.length < 2) return;
      if (parts.reduce((n, p) => n + p.text.length, 0) > 1200) { toast('选段太长了，分两次划吧'); return; }
    } else if (text.length > 500) return;
    const pi = piOf(para);
    if (isNaN(pi) || pi < 0) return;
    hlDraft = { bid: b.id, ch: Number(readerRoot.dataset.currentCh) || 1, pi, text: parts ? parts[0].text : text, parts };
    hideHlEdit();
    const pop = $('#hlPop'), note = $('#hlNote'); if (!pop) return;
    const saveBtn = pop.querySelector('[data-action="hl-save"]');
    if (saveBtn) saveBtn.textContent = parts ? '划线 · ' + parts.length + ' 段' : '划线';
    const r = sel.getRangeAt(0).getBoundingClientRect();
    const below = r.bottom + 120 < window.innerHeight;
    pop.dataset.below = below ? '1' : '0';
    pop.hidden = false;
    pop.style.left = Math.max(132, Math.min(window.innerWidth - 132, r.left + r.width / 2)) + 'px';
    pop.style.top = (below ? r.bottom + 8 : Math.max(10, r.top - 8)) + 'px';
    if (note) note.hidden = true;
  }
  function saveHl(note) {
    if (!hlDraft) return;
    const d = hlDraft;
    const list = state.annotations[d.bid] || (state.annotations[d.bid] = []);
    const col = ui.hlColor || 'red';
    /* 跨段时逐段落库；批注只挂第一段，免得同一条想法在笔记列表里出现三次 */
    const items = d.parts && d.parts.length ? d.parts : [{ pi: d.pi, text: d.text }];
    let added = 0;
    items.forEach((it, i) => {
      const nt = i === 0 ? (note || '') : '';
      const dup = list.some((a) => a.ch === d.ch && a.pi === it.pi && a.text === it.text
        && (a.note || '') === nt && (a.color || 'red') === col);
      if (dup) return;
      list.push({ ch: d.ch, pi: it.pi, text: it.text, note: nt, color: col, time: Date.now() });
      added += 1;
    });
    if (added) save();
    items.forEach((it) => refreshHlParas(d.bid, d.ch, it.pi));
    hideHlPop();
    try { window.getSelection().removeAllRanges(); } catch (e) { /* 忽略 */ }
    if (items.length > 1) toast(added ? '已划 ' + items.length + ' 段' : '这几段已经记下了');
    else toast(added ? (note ? '批注已存' : '已划线') : '这条已经记下了');
  }
  function annotationHtml(b) {
    const list = annotationList(b.id);
    if (!list.length) return '<div class="cat-empty">还没有划线或批注<br><small>在正文里选中一段文字，就能划线、写批注</small></div>';
    const items = list.map((a, i) => ({ a, i }))
      .sort((x, y) => x.a.ch - y.a.ch || x.a.pi - y.a.pi || x.a.time - y.a.time);
    return `<div class="catalog-list ann-list">${items.map(({ a, i }) => `
      <li class="ann-item" data-action="annotation-goto" data-val="${i}">
        <div class="ann-text"><i class="ann-dot hl-${esc(a.color || 'red')}"></i>${esc(a.text.length > 64 ? a.text.slice(0, 64) + '…' : a.text)}</div>
        ${a.note ? `<div class="ann-note">${esc(a.note)}</div>` : ''}
        <div class="ann-meta">第 ${a.ch} 章 · 第 ${a.pi + 1} 段 · ${new Date(a.time).toLocaleDateString('zh-CN')}</div>
        <button class="bm-del" data-action="annotation-del" data-val="${i}" title="删除">${icon('trash', 'ic-sm')}</button>
      </li>`).join('')}</div>`;
  }
  function bookKey() {
    return {
      id: readerRoot.dataset.currentBook,
      ch: Number(readerRoot.dataset.currentCh) || 1,
      page: state.settings.pageMode === 'flip' ? flipState.page : 0
    };
  }
  /* 章号才是卷签的身份。页码只在翻页模式有意义：滚动模式恒为 0，
     字号或窗口一变又会重排。先按 (章, 页) 精确找，找不到就退回同章，
     否则切一次阅读模式星标就熄灭，再点还会添一条重复的卷签。 */
  function bookmarkIndex(list, k) {
    let i = list.findIndex((m) => m.ch === k.ch && (m.page || 0) === k.page);
    if (i < 0) i = list.findIndex((m) => m.ch === k.ch);
    return i;
  }
  function currentBookmark() {
    const k = bookKey();
    const list = bookmarkList(k.id);
    const i = bookmarkIndex(list, k);
    return i >= 0 ? list[i] : null;
  }
  function syncBookmarkBtn() {
    const el = $('#bmBtn'); if (el) el.classList.toggle('bm-on', !!currentBookmark());
  }
  function toggleBookmark() {
    const k = bookKey(); if (!k.id) return;
    const list = bookmarkList(k.id).slice();
    const idx = bookmarkIndex(list, k);
    if (idx >= 0) { list.splice(idx, 1); toast('已移除卷签'); }
    else {
      const b = getBook(k.id);
      list.unshift({
        ch: k.ch, page: k.page, pct: (state.progress[k.id] || {}).pct || 0,
        title: chapterList(b)[k.ch - 1].title, time: Date.now(), note: ''
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
    rate: 1, voiceURI: '', timerMin: 0, timerAt: 0, scope: 'book', fadeOut: false,
    elapsed: 0, startedAt: 0, lastStart: 0, boundaryOK: false,
    remoteOff: false,
    dragging: false,
    prevOverflow: '',
    /* 自愈用：本句开口时刻、最近一次「有动静」的时刻、连续卡住次数 */
    sentAt: 0, lastBeat: 0, stall: 0,
    /* 进 bfcache 前是否在播：重新现身时用它决定要不要自动接着念 */
    pausedByHide: false,
    /* 正在取回下一章：这期间不念、不跟随、不巡检，界面只说「在取」 */
    busy: false
  };
  let ttsGen = 0, listenTimer = null, listenTick = null, keepAudio = null, lastCommit = 0;
  let listenFadeTimer = null;
  let listenReviveTimer = null;
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
     所以：同语言 + 同档位只留一个（正在用的那个永远保留），其它语言的机械音整组不收。
     机械音不再按性别区分——SAPI 那几个（Huihui / Yaoyao / Kangkang）本来就是同一个引擎换了三个名字，
     名字里那点性别暗示在设备上并不作数（Kangkang 实际念出来也不是男声），留着只会让人多试一次。 */
  function voiceKey(v) {
    const tier = voiceTier(v);
    return String(v.lang || '').toLowerCase().replace(/_/g, '-') + '|' + tier + '|' + (tier === 2 ? '' : voiceGender(v));
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
  const VOICE_MALE = /(yunxi|yunyang|yunjian|yunfeng|yunhao|yunjie|yunye|yunze|yunxia|\bmale\b|男声|男)/i;
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
          /* 不用后顾断言：旧 Safari / 老 WebView 解析整段脚本时会直接抛 SyntaxError */
          (seg.match(/[^，、：,:]*[，、：,:]|[^，、：,:]+/g) || []).forEach((piece) => {
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
  /* 上次听到哪一句：只认听书自己存的句子下标。
     以前拿 state.progress.pct 乘正文长度来估字符位置，但那个 pct 在滚动模式是
     scrollTop 比例、翻页模式是页码比例，用户边听边翻两页再回来就漂到别处去了。 */
  function listenResumeIndex() {
    if (!listen.sents.length) return 0;
    const pos = (state.listenPos || {})[listen.bookId];
    if (!pos || pos.ch !== listen.ch) return 0;
    const i = Math.max(0, Math.min(listen.sents.length - 1, Number(pos.sentIndex) || 0));
    /* 听到尾巴就从头来，别停在最后一句反复念 */
    return i > 0 && i < listen.sents.length - 1 ? i : 0;
  }
  function listenRenderDynamic() {
    if (!listen.active) return;
    const total = listen.text.length / Math.max(1, listen.rate * 4.6);
    const elapsed = listen.elapsed + (listen.playing && listen.startedAt ? (Date.now() - listen.startedAt) / 1000 : 0);
    const bar = $('#lpBar'); if (bar) bar.style.width = (listen.text ? Math.min(100, listen.charIndex / listen.text.length * 100) : 0) + '%';
    /* 进度条是 role=slider：读屏要知道走到哪儿了，光靠 width 它读不出来 */
    const track = $('#lpTrack');
    if (track) {
      const pct = listen.text ? Math.round(Math.min(1, listen.charIndex / listen.text.length) * 100) : 0;
      track.setAttribute('aria-valuenow', String(pct));
      track.setAttribute('aria-valuetext', pct + '%，' + fmtTime(elapsed) + ' / ' + fmtTime(total));
    }
    const now = $('#lpNow'); if (now) now.textContent = fmtTime(elapsed);
    const all = $('#lpTotal'); if (all) all.textContent = fmtTime(total);
    const play = $('#listenPlay');
    if (play) {
      play.innerHTML = icon(listen.playing ? 'pause' : 'play', 'ic-lg');
      play.setAttribute('aria-label', listen.playing ? '暂停' : '播放');
    }
    const lmPlay = $('#lmPlay'); if (lmPlay) lmPlay.innerHTML = icon(listen.playing ? 'pause' : 'play');
    const lyric = $('#listenLyric'); if (lyric) lyric.textContent = listen.paras[listen.paraIndex] || '';
    const cover = $('#listenCover'); if (cover) cover.classList.toggle('playing', listen.playing);
    /* 章名跟着 listen.ch 走：换章取回期间至少让人看见「在取哪一章」 */
    const chEl = $('#listenChapter');
    if (chEl) {
      const bb = getBook(listen.bookId);
      const title = bb ? ((chapterList(bb)[listen.ch - 1] || {}).title || '') : '';
      const text = title + (listen.busy ? ' · 正在取回…' : '');
      if (chEl.textContent !== text) chEl.textContent = text;
    }
    const rate = $('#ltRate'); if (rate) rate.textContent = '语速 ' + fmtRate(listen.rate) + '×';
    /* 一个键同时背「范围」和「定时」两件事：有定时就把更紧急的倒计时顶上去，
       没定时显示范围；剩不到一分钟直接报秒，免得挂着一个「0 分」像坏了。 */
    const where = $('#ltWhere');
    if (where) {
      const left = listen.timerAt ? listen.timerAt - Date.now() : 0;
      where.textContent = listen.fadeOut ? '即将收卷'
        : (!listen.timerMin ? '听到哪 · ' + (listen.scope === 'chapter' ? '本章' : '全书')
          : (left >= 60000 ? '听到哪 · ' + Math.ceil(left / 60000) + '分'
            : '听到哪 · ' + Math.max(1, Math.ceil(left / 1000)) + '秒'));
      where.setAttribute('aria-label', '朗读范围 ' + (listen.scope === 'chapter' ? '本章，念完即停' : '全书，接着念下一章')
        + (listen.timerMin ? '；定时 ' + listen.timerMin + ' 分钟' : '；未设定时') + '，点开可修改');
    }
    const tLeft = $('#ltTimerLeft');
    if (tLeft) {
      const txt = listenTimerLeftText();
      if (tLeft.textContent !== txt) tLeft.textContent = txt;
    }
    const t = $('#ttsBtn'); if (t) t.classList.toggle('tts-on', listen.active);
    if ('mediaSession' in navigator) {
      try { navigator.mediaSession.playbackState = listen.playing ? 'playing' : 'paused'; } catch (e) { /* 忽略 */ }
    }
    /* 边听边读：翻页模式自动翻到朗读段所在页；滚动模式收起时才滚动跟随。
       正在取下一章时正文还是旧的，跟随只会把眼睛带到错的地方。 */
    if (!listen.busy) listenFollowPara();
  }
  let lastFollow = 0, lastLP = null;
  /* 听书时尽量不让设备锁屏熄火：WakeLock 比静音音轨保活更优雅，不支持的浏览器自动跳过，
     原有 keepAlive 静音音轨仍作兜底 */
  let wakeLock = null;
  async function listenWakeLock() {
    if (!listen.playing) return;
    try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* 不支持或被拒都不影响 */ }
  }
  function listenReleaseWakeLock() {
    if (wakeLock) { try { wakeLock.release(); } catch (e) { /* 忽略 */ } wakeLock = null; }
  }
  document.addEventListener('visibilitychange', () => {
    if (!listen.playing || document.hidden) return;
    listenWakeLock();
    /* 手机锁屏 / 切走一阵再回来：先把 paused 解开，再看有没有动静。
       后台被掐断时浏览器一个回调都不给，只能靠自己补一句。 */
    listenEnsureResumed();
    clearTimeout(listenReviveTimer);
    listenReviveTimer = setTimeout(listenRevive, 800);
  });
  function listenScrollToPara() {
    const b = getBook(listen.bookId); if (!b) return;
    if (readerRoot.dataset.currentBook !== b.id) return;
    const paras = readerRoot.querySelectorAll('#readerBody .reader-paper p');
    const target = paras[Math.max(0, listen.paraIndex - 1)];
    if (!target) return;
    /* 高亮当前朗读的段落：与滚动解耦，段落一切换就更新，不受 2.5s 滚动节流影响。
       Windows SAPI 不触发 onboundary 也能稳定高亮（用的是句子所属的段落信息）。 */
    if (target !== lastLP) {
      if (lastLP) lastLP.classList.remove('lp-active');
      target.classList.add('lp-active');
      lastLP = target;
    }
    const r = target.getBoundingClientRect();
    if (Date.now() - lastFollow < 2500) return;
    if (r.top > window.innerHeight * 0.8 || r.bottom < window.innerHeight * 0.15) {
      lastFollow = Date.now();
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }
  /* 翻页模式听书跟随：当前朗读段落不在可视页时，自动翻到那一页并高亮。
     翻页没有手动滚动条，必须靠翻页把「眼睛的落点」带过去——否则只能干听。 */
  function listenFlipFollow() {
    const b = getBook(listen.bookId); if (!b) return;
    if (state.settings.pageMode !== 'flip' || !$('#reader') || !flipState.pages.length) return;
    if (flipState.id !== b.id || flipState.ch !== listen.ch) return;
    /* 用「正在朗读的这句」所属段落，比 paraIndex 更准：Windows SAPI 不触发 onboundary 时 paraIndex 会滞后一句 */
    const s = listen.sents[listen.sentIndex];
    const targetIdx = (s ? s.para : listen.paraIndex) + 1; // parts[0]=标题→h1(idx1)，段j→flipItems idx(2+j)=para+1
    let page = -1;
    for (let p = 0; p < flipState.pages.length; p++) {
      if (flipState.pages[p].some((it) => it.idx === targetIdx)) { page = p; break; }
    }
    if (page < 0) return;
    if (page !== flipState.page) { flipState.page = page; renderFlipPage(); }
    const fp = $('#flipPage'); if (!fp) return;
    fp.querySelectorAll('.lp-active').forEach((el) => el.classList.remove('lp-active'));
    fp.querySelectorAll('[data-fi="' + targetIdx + '"]').forEach((el) => el.classList.add('lp-active'));
  }
  function listenFollowPara() {
    const b = getBook(listen.bookId); if (!b) return;
    /* 正在拖悬浮球时别顺手滚正文：手上一动、页面一跳，感觉就像球被拽住了 */
    if (listen.dragging) return;
    if (readerRoot.dataset.currentBook !== b.id) return;
    if (state.settings.pageMode === 'flip') { listenFlipFollow(); return; }
    if (listen.expanded) return;
    listenScrollToPara();
  }
  /* 每句结束把进度落盘（节流），退出后再进来能接着听。
     state.progress 仍跟着朗读走，方便「边听边读」；但续听只认 listenPos。 */
  function listenCommitProgress(force) {
    if (!listen.active || !listen.text) return;
    const now = Date.now();
    if (!force && now - lastCommit < 1200) return;
    lastCommit = now;
    /* 不再写 state.progress：那里是阅读器的「页码/滚动比例」，
       听书的「字符比例」写进去会让 paginateAndRender / 卷签定位跳错位置。
       听书位置只存 listenPos；阅读进度由翻页 / 滚动自己维护。 */
    state.lastRead = listen.bookId;
    if (!state.listenPos) state.listenPos = {};
    state.listenPos[listen.bookId] = {
      ch: listen.ch, sentIndex: listen.sentIndex, charIndex: listen.charIndex, updated: now
    };
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
    /* 原来一次性把全部音频 Blob 读回内存再算总量；
       改成 openCursor 逐条只记 key / ts / size，峰值内存不再随缓存大小涨。 */
    openAudioDB().then((db) => {
      if (!db) return;
      const rows = [];
      let total = 0;
      const tx = db.transaction('clips', 'readonly');
      const cur = tx.objectStore('clips').openCursor();
      cur.onsuccess = (ev) => {
        const c = ev.target.result;
        if (!c) {
          try { db.close(); } catch (_) {}
          if (total <= max || !rows.length) return;
          const drop = Math.max(1, Math.ceil(rows.length * 0.25));
          rows.sort((a, b) => a.ts - b.ts).slice(0, drop)
            .forEach((r) => audioIDB('readwrite', (st) => st.delete(r.k)));
          return;
        }
        const v = c.value || {};
        total += v.blob ? v.blob.size / 1024 : 0;
        rows.push({ k: c.key, ts: v.ts || 0 });
        c.continue();
      };
      cur.onerror = () => { try { db.close(); } catch (_) {} };
    }).catch(() => { /* IDB 不可用时直接跳过清理 */ });
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
  /* ---------- 朗读自愈：切后台 / 锁屏 / 来电打断后回来，别只剩一个哑巴播放键 ----------
   * 三种现场浏览器都不会给回调：
   *   ① 页面隐藏一阵后 Chrome 会把 speechSynthesis 置成 paused，回前台仍是 paused，
   *      speak() 只往队列里塞东西，一声不出；
   *   ② 来电 / 别的 App 抢走音频，utterance 收到 interrupted 就没了下文，playing 还挂着 true；
   *   ③ 长句合成后 onend 偶发不回调（Chromium 老毛病），进度永远停在那一句上。
   * 办法：每句开口记 sentAt，boundary / onend / 音频 timeupdate 记 lastBeat；
   * 每秒巡检，超出这句的合理时长还没动静就原地重讲这一句 —— 进度不丢，用户不用动手。 */
  function listenEnsureResumed() {
    if (!speechOK()) return;
    try { if (speechSynthesis.paused) speechSynthesis.resume(); } catch (e) { /* 忽略 */ }
  }
  function listenBeat() { listen.lastBeat = Date.now(); }
  /* 一句最慢能念多久：中文约 4.5 字/秒，语速乘进去，再宽放 6 秒给慢合成 */
  function listenBudget(chars) {
    return Math.max(6000, (chars / (4.5 * Math.max(0.5, listen.rate))) * 1000 + 6000);
  }
  /* 原地重讲当前句。不走 listenSpeak 是为了保住 sentIndex / 已听时长 */
  function listenRespeak() {
    if (!listen.active || !listen.playing) return;
    /* 连续重讲说明环境真的不给念（通话中、音频被长期占用），别无限重试 */
    listen.stall += 1;
    if (listen.stall > 3) {
      listen.playing = false;
      listenReleaseWakeLock();
      toast('朗读一直被打断，已暂停');
      listenRenderDynamic();
      return;
    }
    const gen = ++ttsGen;
    listenDropAudio();
    try {
      if (speechOK()) {
        /* 队列里可能还挂着一条没头没尾的 utterance，不清掉新的 speak 会排在它后面 */
        if (speechSynthesis.paused) speechSynthesis.resume();
        speechSynthesis.cancel();
      }
    } catch (e) { /* 忽略 */ }
    listen.sentAt = Date.now(); listen.lastBeat = listen.sentAt;
    listenPlaySent(gen);
  }
  function listenWatchdog() {
    if (listen.busy) return;
    if (!listen.active || !listen.playing || listen.fadeOut) return;
    const s = listen.sents[listen.sentIndex];
    if (!s) return;
    if (remoteAudio && !remoteAudio.paused && !remoteAudio.ended) return; /* 音频在走，别插嘴 */
    const now = Date.now();
    if (now - (listen.lastBeat || listen.sentAt || now) < listenBudget(s.t.length)) return;
    listenRespeak();
  }
  /* 回前台时更急一点：后台断掉的话 lastBeat 早就停在断开那一刻了 */
  function listenRevive() {
    if (listen.busy) return;
    if (!listen.active || !listen.playing || listen.fadeOut) return;
    listenEnsureResumed();
    if (remoteAudio && !remoteAudio.paused && !remoteAudio.ended) return;
    const s = listen.sents[listen.sentIndex];
    const grace = s ? Math.min(8000, listenBudget(s.t.length) / 2) : 4000;
    if (Date.now() - (listen.lastBeat || 0) > grace) listenRespeak();
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
      listen.stall = 0;
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
      listenBeat();
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
    if (listen.busy) return;
    if (!listen.sents.length) return;
    if (!listenRemoteOn() && !speechOK()) return;
    const gen = ++ttsGen;
    listenDropAudio();
    try { if (speechOK()) speechSynthesis.cancel(); } catch (e) { /* 忽略 */ }
    if (!resume) { listen.sentIndex = 0; listen.elapsed = 0; listen.charIndex = 0; }
    listen.playing = true;
    listen.stall = 0;
    listenWakeLock();
    listen.startedAt = Date.now();
    listen.boundaryOK = false;
    listenPlaySent(gen);
  }
  function listenPlaySent(gen) {
    if (gen !== ttsGen || !listen.active) return;
    /* 定时收尾：当前这句已在 onend 里念完，不再排下一句，本地与在线音色两条路径都走这里 */
    if (listen.fadeOut) { listenFinishFade(); return; }
    const s = listen.sents[listen.sentIndex];
    if (!s) { listenChapterDone(); return; }
    if (listenRemoteOn()) { listenPlayRemote(gen, s); return; }
    /* 后台回来时 speechSynthesis 可能还停在 paused，先解开，否则下面这句不会出声 */
    listenEnsureResumed();
    const u = new SpeechSynthesisUtterance(s.t);
    u.lang = 'zh-CN'; u.rate = listen.rate;
    const v = listenPickVoice(); if (v) u.voice = v;
    u.onboundary = (ev) => {
      if (gen !== ttsGen) return;
      listen.boundaryOK = true;
      listenBeat();
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
      listen.stall = 0;
      listenBeat();
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
      /* canceled 是主动取消（换句 / 暂停 / 停止），不用管；
         interrupted 是系统打断（来电、切后台、别的 App 抢音频）——
         录音队列已经空了，可页面还挂着「正在播」，不重讲的话回来就是个哑巴播放键。 */
      if (kind === 'canceled') return;
      if (kind === 'interrupted') {
        if (!listen.playing) return;
        setTimeout(() => {
          if (gen === ttsGen && listen.active && listen.playing) listenRespeak();
        }, 800);
        return;
      }
      listen.playing = false;
      listenRenderDynamic();
      if (kind === 'not-allowed') toast('需要先点一下播放');
    };
    try {
      listen.sentAt = Date.now(); listen.lastBeat = listen.sentAt;
      speechSynthesis.speak(u);
      listen.lastStart = Date.now();
      listenRenderDynamic();
    } catch (e) { listen.playing = false; toast('朗读启动失败'); listenRenderDynamic(); }
  }
  function listenPause() {
    /* 手动暂停就取消这次收尾，之后再点播放能继续听 */
    clearTimeout(listenFadeTimer); listenFadeTimer = null; listen.fadeOut = false;
    clearTimeout(listenReviveTimer); listenReviveTimer = null;
    ttsGen += 1;
    listenDropAudio();
    try { speechSynthesis.cancel(); } catch (e) { /* 忽略 */ }
    if (listen.startedAt) { listen.elapsed += (Date.now() - listen.startedAt) / 1000; listen.startedAt = 0; }
    listen.playing = false;
    listen.stall = 0;
    listenReleaseWakeLock();
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
    /* 「只读本章」：本章念完就停，不自动续下一章；手动点下一章仍可继续 */
    if (listen.scope !== 'chapter' && b && listen.ch < chapterList(b).length) { listenGoChapter(listen.ch + 1, true); return; }
    listen.playing = false;
    toast(listen.scope === 'chapter' ? '这一章读完了' : '这一卷读完了');
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
    const target = Math.max(1, Math.min(chapterList(b).length, ch));
    const prev = listen.ch;
    listen.ch = target;
    /* 在线书换到还没取回来的章节：先说一声在取，别停在新章名 + 旧音频那种半吊子状态；
       实在取不回来也得老实承认，否则就成了「一键没声」的假播放。 */
    if (!b.local && !hasChapterBody(b, target)) {
      listen.busy = true;
      listen.charIndex = 0; listen.paraIndex = 0;
      renderListen();
      await ensureChapter(b, target);
      listen.busy = false;
      if (!listen.active) return;
    }
    if (!hasChapterBody(b, target)) {
      listen.ch = prev;
      listen.playing = false;
      listen.stall = 0;
      listenReleaseWakeLock();
      renderListen();
      toast(b.local ? '这一章没有可朗读的内容' : '这一章没取回来，连上网络再试');
      return;
    }
    listenLoadText();
    if (state.listenPos) delete state.listenPos[listen.bookId]; /* 换章从头听 */
    save();
    renderListen();
    /* renderListen 会把播报节点整个换掉，所以这句要放在它后面 */
    const meta = chapterList(b)[target - 1] || {};
    listenAnnounce('第 ' + target + ' 章' + (meta.title ? '，' + meta.title : ''));
    if (autoplay || listen.playing) listenSpeak(false);
    else listenRenderDynamic();
  }
  /* 听卷页自己的读屏播报。阅读器那个 #readerAnnounce 在听卷打开时整块是 inert 的，
     念不出来——换章、改范围、设定时这些只弹 toast 的动作，读屏用户等于什么都没收到。 */
  function listenAnnounce(text) {
    if (!text) return;
    const el = $('#listenAnnounce');
    if (el) el.textContent = '';
    setTimeout(() => {
      const live = $('#listenAnnounce');
      if (live && listen.active) live.textContent = text;
    }, 30);
  }
  function listenShell(b) {
    const chs = chapterList(b);
    return `<div class="listen" id="listen" tabindex="-1" role="dialog" aria-modal="true"
        aria-label="听卷 · ${esc(b.title)}" data-paper="${state.settings.paper}">
      <div class="listen-top">
        <button class="icon-btn" data-action="listen-minimize" title="收起听卷（继续播放）" aria-label="收起听卷，继续播放">${icon('close')}</button>
        <div class="listen-top-title">听 卷 · ${esc(b.title)}</div>
        <button class="icon-btn" data-action="listen-minimize" title="收起，边听边读" aria-label="收起，边听边读">${icon('minimize')}</button>
      </div>
      <div class="sr-announce" id="listenAnnounce" role="status" aria-live="polite" aria-atomic="true"></div>
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
          <div class="progress-line" data-action="listen-seek" id="lpTrack" role="slider" tabindex="0"
            aria-label="朗读进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-valuetext="0%"><i id="lpBar"></i></div>
          <span id="lpTotal">--:--</span>
        </div>
        <div class="listen-buttons">
          <button class="icon-btn lg" data-action="listen-prev" title="上一章" aria-label="上一章">${icon('stepback')}</button>
          <button class="listen-play" data-action="listen-toggle" id="listenPlay"
            aria-label="${listen.playing ? '暂停' : '播放'}">${icon(listen.playing ? 'pause' : 'play', 'ic-lg')}</button>
          <button class="icon-btn lg" data-action="listen-next" title="下一章" aria-label="下一章">${icon('stepforward')}</button>
        </div>
        <div class="listen-tools">
          <button data-action="listen-panel" data-val="rate" id="ltRate">语速 ${fmtRate(listen.rate)}×</button>
          <button data-action="listen-panel" data-val="voice">音色</button>
          <i class="lt-break" aria-hidden="true"></i>
          <button data-action="listen-panel" data-val="where" id="ltWhere" title="朗读范围与定时停止">听到哪 · ${listen.scope === 'chapter' ? '本章' : '全书'}</button>
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
    syncListenInert();
    /* 展开成全屏听卷页时把焦点交给它，不然键盘/spell 还停在背后的阅读器上 */
    if (listen.expanded && l && !l.hidden && !l.contains(document.activeElement)) {
      l.focus({ preventScroll: true });
    }
  }
  /* 听卷页展开时铺满整屏（fixed inset:0），背后内容照样在 Tab 序列与无障碍树里。
     这里按「是否展开」给主干让路；收起成迷你条就还回去。 */
  /* 跳到整章的第 ratio 段（0–1）：拖动进度条与键盘左右键共用。
     落到「句」的起点，不从半句话中间切。 */
  function listenSeekRatio(ratio) {
    if (!listen.text || !listen.sents.length) return;
    ratio = Math.max(0, Math.min(1, ratio || 0));
    const target = Math.floor(ratio * listen.text.length);
    let hit = 0;
    listen.sents.forEach((sn, k) => { if (sn.start <= target) hit = k; });
    listen.sentIndex = hit;
    const hs = listen.sents[hit];
    listen.charIndex = hs ? hs.start : 0;
    listen.paraIndex = hs ? hs.para : 0;
    listen.elapsed = ratio * (listen.text.length / Math.max(1, listen.rate * 4.6));
    if (listen.playing) listenSpeak(true); else listenRenderDynamic();
  }
  function listenFullOpen() { return !!(listen.active && listen.expanded); }
  function syncListenInert() {
    const on = listenFullOpen();
    ['#view', '.topbar', '#bottomNav', '.sidebar'].forEach((sel) => {
      const el = $(sel); if (!el) return;
      if (on) { el.setAttribute('inert', ''); el.setAttribute('aria-hidden', 'true'); }
      else if (!readerRoot.dataset.currentBook) { el.removeAttribute('inert'); el.removeAttribute('aria-hidden'); }
    });
    const rd = $('#reader');
    if (rd) {
      if (on) { rd.setAttribute('inert', ''); rd.setAttribute('aria-hidden', 'true'); }
      else { rd.removeAttribute('inert'); rd.removeAttribute('aria-hidden'); }
    }
  }
  /* 悬浮球拖动：逐帧只写一次 transform（走合成层，不触发布局），
     宽高与活动范围在按下时量一次，避免「写样式→读 offsetWidth→再写」的强制重排 */
  function setupMiniDrag() {
    const mini = $('#listenMini'); if (!mini || mini.hidden) return;
    let startX = 0, startY = 0, originL = 0, originT = 0;
    let dragging = false, moved = false, pid = 0;
    let maxL = 0, maxT = 0, curL = 0, curT = 0, wantL = 0, wantT = 0, raf = 0;
    let saved = null;

    const paint = () => {
      raf = 0;
      if (curL === wantL && curT === wantT) return; /* 位置没动就别碰样式 */
      curL = wantL; curT = wantT;
      mini.style.transform = 'translate3d(' + (curL - originL) + 'px,' + (curT - originT) + 'px,0)';
    };
    /* 收尾时把最后一帧补上，否则松手会少走几个像素、看着像「粘」了一下 */
    const flush = () => { if (raf) { cancelAnimationFrame(raf); raf = 0; } paint(); };

    const onDown = (e) => {
      if (e.target.closest('.lm-close') || e.target.closest('.lm-play')) return; /* 按钮各自处理 */
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const r = mini.getBoundingClientRect();
      saved = { left: mini.style.left, top: mini.style.top, right: mini.style.right, bottom: mini.style.bottom };
      dragging = true; moved = false; pid = e.pointerId;
      /* 先把 right/bottom 定位换成 left/top，拖动期间只用 transform 推着走 */
      mini.style.left = r.left + 'px'; mini.style.top = r.top + 'px';
      mini.style.right = 'auto'; mini.style.bottom = 'auto';
      mini.style.transform = 'translate3d(0,0,0)';
      originL = curL = wantL = r.left;
      originT = curT = wantT = r.top;
      maxL = Math.max(4, window.innerWidth - r.width - 4);
      maxT = Math.max(4, window.innerHeight - r.height - 4);
      startX = e.clientX; startY = e.clientY;
      listen.dragging = true;
      mini.classList.add('dragging');
      try { mini.setPointerCapture(pid); } catch (_) {}
    };

    const onMove = (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (!moved && Math.hypot(dx, dy) > 6) moved = true;
      if (!moved) return;
      wantL = Math.max(4, Math.min(maxL, originL + dx));
      wantT = Math.max(4, Math.min(maxT, originT + dy));
      if (!raf) raf = requestAnimationFrame(paint); /* 一帧只画一次，高刷屏也不重复干活 */
    };

    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      listen.dragging = false;
      try { mini.releasePointerCapture(pid); } catch (_) {}
      mini.classList.remove('dragging');
      if (!moved) {
        /* 只是点了一下：样式原封不动退回去，别把响应式定位改成死坐标 */
        if (saved) { mini.style.left = saved.left; mini.style.top = saved.top; mini.style.right = saved.right; mini.style.bottom = saved.bottom; }
        mini.style.transform = '';
        return;
      }
      /* 把 transform 的最终位移落回 left/top，同一帧内完成，不会闪 */
      flush();
      mini.style.left = curL + 'px';
      mini.style.top = curT + 'px';
      mini.style.transform = '';
      state.listenMiniPos = { left: Math.round(curL), top: Math.round(curT) };
      save();
      /* 拖完这次 click 别误触“展开” */
      mini.addEventListener('click', (ev) => { ev.stopPropagation(); ev.preventDefault(); }, { capture: true, once: true });
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
    } else if (kind === 'where') {
      /* 「范围」和「定时」其实都在回答「听到哪儿停」：一个管念到哪一章收，一个管念到几点收。
         以前一个是一键切换、一个藏在面板里，两处找、两套操作。合成一页，各自带上说明。 */
      const scopePills = [['chapter', '本章', '念完这一章就停'], ['book', '全书', '接着念下一章']].map(([k, l, tip]) =>
        `<button class="rs-pill ${listen.scope === k ? 'active' : ''}" data-action="listen-scope" data-val="${k}" aria-pressed="${listen.scope === k}">${l}<small>${tip}</small></button>`).join('');
      const timerPills = [[0, '不开启'], [15, '15 分钟'], [30, '30 分钟'], [45, '45 分钟'], [60, '60 分钟'], [90, '90 分钟']].map(([m, l]) =>
        `<button class="rs-pill ${listen.timerMin === m ? 'active' : ''}" data-action="listen-timer" data-val="${m}" aria-pressed="${listen.timerMin === m}">${l}</button>`).join('');
      p.innerHTML = head('听到哪儿')
        + '<div class="lp-group">朗读范围</div><div class="rs-pills lp-where-scope">' + scopePills + '</div>'
        + '<div class="lp-group">定时停止</div>'
        + `<div class="lp-empty" id="ltTimerLeft">${listenTimerLeftText()}</div>`
        + '<div class="rs-pills">' + timerPills + '</div>';
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
    /* 只统计大小，别把上百 MB 音频整批读回内存：用游标逐条累加 */
    openAudioDB().then((db) => {
      if (!db) { el.textContent = '听书音频缓存：不可用'; return; }
      let n = 0, sz = 0;
      const cur = db.transaction('clips', 'readonly').objectStore('clips').openCursor();
      cur.onsuccess = (ev) => {
        const c = ev.target.result;
        if (!c) {
          try { db.close(); } catch (_) {}
          el.textContent = n
            ? '听书音频缓存：' + n + ' 句 · '
              + (sz >= 1048576 ? (sz / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(sz / 1024)) + ' KB')
            : '听书音频缓存：还没有';
          return;
        }
        n += 1;
        sz += c.value && c.value.blob ? c.value.blob.size : 0;
        c.continue();
      };
      cur.onerror = () => {
        try { db.close(); } catch (_) {}
        el.textContent = '听书音频缓存：统计失败';
      };
    }).catch(() => { el.textContent = '听书音频缓存：不可用'; });
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
  /* 「听到哪儿」面板里那一行说明：每秒跟着走，别让「还剩 14:31」定在那儿不动 */
  function listenTimerLeftText() {
    if (!listen.timerMin) return '睡前听一段，到点会等这一句念完再停，不会硬断在半句上';
    if (listen.fadeOut) return '正在收尾，这一句念完就停';
    const left = Math.max(0, (listen.timerAt - Date.now()) / 1000);
    return '还剩 ' + fmtTime(left) + '，到点会等这一句念完再停';
  }
  /* 定时到点。
     原来是用一个 setTimeout 一次排满整段时长，两个隐患：手机切后台 / 锁屏时定时器会被
     节流或冻结，到点早过了才醒；暂停时 fadeOut 被取消，定时却再也不会重新武装，
     按钮就一直卡在「定时 0 分」。改成每秒巡检 timerAt，慢一秒但不会丢。 */
  function listenTimerCheck() {
    if (!listen.active || !listen.timerMin || !listen.timerAt || listen.fadeOut) return;
    if (Date.now() < listen.timerAt) return;
    if (!listen.playing) {
      /* 早就暂停了，本来就没声可停：悄悄把定时清掉，别留一个 0 分的幽灵 */
      listen.timerMin = 0; listen.timerAt = 0;
      listenRenderDynamic();
      return;
    }
    listen.fadeOut = true;
    toast('定时到了，等这一句念完就收');
    listenAnnounce('定时到了，这一句念完就停');
    listenRenderDynamic();
    /* 超长句兜底：15 秒后无论如何收尾，避免一直停不下来 */
    listenFadeTimer = setTimeout(() => { if (listen.active && listen.fadeOut) listenFinishFade(); }, 15000);
  }
  /* 定时到点不硬断：等当前这句自然念完再收尾；15 秒兜底防超长句卡住 */
  function listenFinishFade() {
    clearTimeout(listenFadeTimer); listenFadeTimer = null;
    clearTimeout(listenReviveTimer); listenReviveTimer = null;
    if (!listen.fadeOut || !listen.active) return;
    listen.fadeOut = false;
    ttsGen += 1;
    try { if (speechOK()) speechSynthesis.cancel(); } catch (e) { /* 忽略 */ }
    listenDropAudio();
    if (listen.startedAt) { listen.elapsed += (Date.now() - listen.startedAt) / 1000; listen.startedAt = 0; }
    listen.timerMin = 0; listen.timerAt = 0;
    listen.playing = false;
    listenReleaseWakeLock();
    listenCommitProgress();
    /* timerMin / fadeOut 都已归零，这一句刷新会把底栏键从「即将收卷」还原成范围文案 */
    listenRenderDynamic();
    toast('定时结束，听卷已收');
  }
  function listenStopAll() {
    clearTimeout(listenFadeTimer); listenFadeTimer = null; listen.fadeOut = false;
    clearTimeout(listenReviveTimer); listenReviveTimer = null;
    ttsGen += 1;
    try { if (speechOK()) speechSynthesis.cancel(); } catch (e) { /* 忽略 */ }
    clearTimeout(listenTimer); clearInterval(listenTick);
    listenDropAudio();
    listenCommitProgress(true); /* 强制补上最后一句，别被 1.2s 节流吃掉 */
    listen.active = false; listen.playing = false; listen.expanded = true;
    listen.pausedByHide = false;
    listen.timerMin = 0; listen.timerAt = 0;
    listenMediaSession(false);
    listenKeepAlive(false);
    const l = $('#listenRoot'); if (l) l.remove();
    const t = $('#ttsBtn'); if (t) t.classList.remove('tts-on');
    if (lastLP) { try { lastLP.classList.remove('lp-active'); } catch (e) { /* 忽略 */ } lastLP = null; }
    $$('#flipPage .lp-active').forEach((el) => el.classList.remove('lp-active'));
    listenReleaseWakeLock();
    document.body.style.overflow = listen.prevOverflow || '';
    /* 听卷页撤了，把背后被它让开的阅读器 / 页面收回来 */
    syncListenInert();
  }
  async function openListen(id, ch) {
    const b = getBook(id); if (!b) return;
    if (!speechOK()) { toast('当前浏览器不支持语音朗读'); return; }
    if (b.local && !contentCache[id]) {
      try { const rec = await loadContent(id); if (rec && rec.chapters) { contentCache[id] = rec; cacheTouch(id); } } catch (e) { /* 忽略 */ }
    }
    if (!listen.active) {
      listen.prevOverflow = document.body.style.overflow;
      try { history.pushState({ mojuanListen: true }, ''); } catch (e) { /* 忽略 */ }
    }
    listen.active = true; listen.expanded = true;
    listen.bookId = id; listen.ch = Math.max(1, Math.min(chapterList(b).length, ch || (state.progress[id] || {}).ch || 1));
    if (!b.local && !hasChapterBody(b, listen.ch)) {
      await ensureChapter(b, listen.ch);
      listen.ch = Math.max(1, Math.min(chapterList(b).length, listen.ch));
    }
    listen.rate = clampRate(state.settings.rate);
    listen.scope = state.listenScope === 'chapter' ? 'chapter' : 'book';
    listen.voiceURI = state.settings.voiceURI || '';
    /* 每次重新打开听卷都再试一次在线音色，别因为上次失败就永远不用 */
    listen.remoteOff = false;
    remoteWarned = false;
    /* 正文没到手时别开卷：原来会把「这一章暂未取到正文」的提示当成正文念出来 */
    if (!hasChapterBody(b, listen.ch)) {
      listen.active = false;
      document.body.style.overflow = listen.prevOverflow || '';
      toast(b.local ? '这一章没有可朗读的内容' : '这一章还没取回正文，先到目录里重新取回');
      return;
    }
    listenLoadText();
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
    listenTick = setInterval(() => {
      if (!listen.active) return;
      listenTimerCheck();
      listenRenderDynamic();
      /* 每秒顺带巡检：onend 丢了的句子在这里被捞回来 */
      listenWatchdog();
    }, 1000);
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
    const pages = paginateCached(flipItems(b, flipState.ch), W, H, b.id, flipState.ch);
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
  /* 把「最新滚动读数」写回 state.progress（只改内存，不落盘）。
     滚动事件里只记 scrollTop，scrollHeight/clientHeight 到真正要算时才读，
     免得每一帧滚动都去摸三处 layout。返回是否真的写入了。 */
  function commitScrollProbe() {
    const sp = ui.scrollProbe;
    if (!sp) return false;
    const el = sp.body;
    /* 章节已换掉 / 阅读器已卸载时，旧节点算出来的比例会把新章进度写坏 */
    if (!el || !document.contains(el) || readerRoot.dataset.currentBook !== sp.id) return false;
    const max = el.scrollHeight - el.clientHeight;
    if (!(max > 0)) return false;
    const pct = Math.min(1, Math.max(0, (sp.top || 0) / max));
    const prev = state.progress[sp.id];
    if (prev && prev.ch === sp.ch && Math.abs((prev.pct || 0) - pct) < 0.0005) return false;
    state.progress[sp.id] = { ch: sp.ch, pct, updated: Date.now() };
    state.lastRead = sp.id;
    return true;
  }
  /* 滚动模式下「正在读的那一段」：视口顶端落在哪一段、偏了几成。
     字号 / 行距 / 字体一变整章重排，按滚动比例还原会漂出好几段（视口能装的行数变了），
     按段落还原才真的停在原来那句话上。 */
  function scrollAnchorOf(body) {
    const paper = $('#readerPaper');
    if (!body || !paper) return null;
    const line = body.getBoundingClientRect().top;
    const ps = paper.querySelectorAll('p[data-pi]');
    if (!ps.length) return null;
    let best = null, frac = 0;
    for (let i = 0; i < ps.length; i += 1) {
      const r = ps[i].getBoundingClientRect();
      if (r.top > line + 1) break;
      best = ps[i];
      frac = r.height > 0 ? Math.min(1, Math.max(0, (line - r.top) / r.height)) : 0;
    }
    if (!best) { best = ps[0]; frac = 0; }
    return { pi: best.dataset.pi, frac };
  }
  function applyScrollAnchor(body, a) {
    const el = body && body.querySelector('#readerPaper p[data-pi="' + a.pi + '"]');
    if (!el) return false;
    const r = el.getBoundingClientRect(), br = body.getBoundingClientRect();
    body.scrollTop = Math.max(0, r.top - br.top + body.scrollTop + a.frac * r.height);
    return true;
  }
  /* 改完字号 / 行距后的统一收尾：翻页模式重排；滚动模式保住原来的阅读位置 */
  function restyleReader() {
    const body = $('#readerBody');
    const isFlip = state.settings.pageMode === 'flip';
    let ratio = 0, anchor = null;
    if (!isFlip && body) {
      const max = body.scrollHeight - body.clientHeight;
      ratio = max > 0 ? body.scrollTop / max : 0;
      anchor = scrollAnchorOf(body);
    }
    applyReaderStyle();
    if (isFlip) { scheduleReflow(); return; }
    /* 滚动模式不会重新渲染节点，字号一变浏览器就地重排，scrollTop 数值不变但位置会挪，
       所以按段落锚点把它拉回原处（等下一帧，布局算完再设） */
    if (body) {
      requestAnimationFrame(() => {
        if (anchor && applyScrollAnchor(body, anchor)) return;
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
      commitScrollProbe();
      flushSave();
      stopReadClock();
    } else if ($('#reader')) {
      startReadClock(readerSession.book);
    }
  });
  window.addEventListener('pagehide', (e) => {
    if (readerSession) { accrueReadTime(Date.now()); stopReadClock(); }
    /* 关页/刷新前把最后一次翻页、滚动进度立即落盘，否则节流中的存档会丢 */
    commitScrollProbe();
    flushSave();
    if (!listen.active) return;
    /* 进 bfcache 的页面会被原样还原，这会儿把听卷销毁掉，用户切回来就只剩个空阅读器。
       这种场合只暂停、留状态，等 pageshow 自己接着念；真关页才收摊。 */
    if (e && e.persisted) {
      listen.pausedByHide = listen.playing;
      if (listen.playing) listenPause();
      return;
    }
    listenStopAll();
  });
  window.addEventListener('pageshow', (e) => {
    if (!e || !e.persisted || !listen.active || !listen.pausedByHide) return;
    listen.pausedByHide = false;
    listenSpeak(true);
  });
  function paginateAndRender(b, ch, token, dir) {
    if (token !== readerToken) return;
    const body = $('#readerBody');
    const pr = state.progress[b.id];
    if (state.settings.pageMode === 'flip') {
      const fp = $('#flipPage'); if (!fp) return;
      const W = fp.clientWidth, H = fp.clientHeight;
      if (W < 60 || H < 80) return;
      const pages = paginateCached(flipItems(b, ch), W, H, b.id, ch);
      let page = 0;
      if (ui.flipHint === 'last') page = pages.length - 1;
      else if (pr && pr.ch === ch && pr.pct > 0) page = Math.min(pages.length - 1, Math.round(pr.pct * (pages.length - 1)));
      if (ui.flipTargetPage != null) { page = Math.min(pages.length - 1, ui.flipTargetPage); ui.flipTargetPage = null; }
      ui.flipHint = null;
      flipState = { pages, page, id: b.id, ch };
      renderFlipPage(dir || '');
    } else {
      ui.flipTargetPage = null; /* 滚动分支不消费它，留着会污染下次切回翻页模式 */
      if (pr && pr.ch === ch && pr.pct > 0) body.scrollTop = pr.pct * (body.scrollHeight - body.clientHeight);
      updateReaderSeek();
      syncBookmarkBtn();
    }
  }
  /* 换章后给读屏一句提示：视觉上正文整块换掉了，焦点却还停在「下一章」按钮上，
     读屏不播报的话用户根本不知道已经换到哪一章。只在章号真的变了时播
     （同一章内翻页不打断），首次进卷交给 #reader 的聚焦播报。
     顺手同步 document.title：多标签页 / 装成独立窗口之后，标题栏能看出在读哪一卷。 */
  const APP_TITLE = '墨卷 · 一卷在手，人间可读';
  function announceChapter(b, ch, prevCh) {
    const cur = chapterList(b)[ch - 1];
    const name = cur && cur.title ? String(cur.title) : '';
    const rd = $('#reader');
    if (rd) rd.setAttribute('aria-label', b.title + ' · 第 ' + ch + ' 章' + (name ? ' · ' + name : ''));
    document.title = name ? b.title + ' · ' + name + ' · 墨卷' : b.title + ' · 墨卷';
    if (prevCh == null || String(prevCh) === String(ch)) return;
    const el = $('#readerAnnounce');
    if (!el) return;
    /* 同一句重复也要重播：先清空，下一拍再写，读屏才会重念 */
    el.textContent = '';
    setTimeout(() => { el.textContent = '已到第 ' + ch + ' 章' + (name ? '，' + name : ''); }, 30);
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
    const prevCh = readerRoot.dataset.currentCh;
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
        cacheTouch(id);
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
    /* 换章 / 换卷前把上一章那次的滚动读数结算掉，再清空：
       否则留在 ui 里的旧读数会在关页时把新章的进度写成旧位置 */
    commitScrollProbe();
    ui.scrollProbe = null;
    const dir = ui.flipDir || '';
    ui.flipDir = '';
    if (canReuse) {
      document.body.style.overflow = 'hidden';
      announceChapter(b, ch, prevBook === id ? prevCh : null);
      paginateAndRender(b, ch, token, dir);
      setTimeout(() => { if (token === readerToken) prefetchNext(b, ch); }, 0);
      return;
    }
    document.body.style.overflow = 'hidden';
    readerRoot.innerHTML = readerHtml(b, ch);
    a11ySweep(readerRoot);
    announceChapter(b, ch, prevBook === id ? prevCh : null);
    setBgInert(true);
    /* 刚进阅读器（不是换章）时把焦点交给正文，读屏才知道翻到了哪一卷 */
    if (!prevBook) {
      const rd = $('#reader');
      if (rd) { rd.setAttribute('tabindex', '-1'); rd.focus({ preventScroll: true }); }
    }
    applyReaderStyle();
    const body = $('#readerBody');
    requestAnimationFrame(() => paginateAndRender(b, ch, token));
    /* 渲染落定后再预取下一章，别和首屏分页抢主线程 / 带宽 */
    setTimeout(() => { if (token === readerToken) prefetchNext(b, ch); }, 0);
    if (flipMode) {
      bindFlipDrag(body);
    } else {
      let tick;
      /* 滚动位置除了节流落盘，还留一份「最新读数」在内存里：
         260ms 的节流窗口内关页 / 切后台，flushSave() 落下去的是上一次的位置，
         用户滚到 90% 直接关掉标签，下次打开仍在 60%。关页前用它补一次。 */
      ui.scrollProbe = null;
      body.addEventListener('scroll', () => {
        /* 复用同一个对象：滚动一秒钟能触发几十次，每帧新建小对象纯属给 GC 添活 */
        const sp = ui.scrollProbe;
        if (!sp || sp.body !== body) ui.scrollProbe = { id, ch, body, top: body.scrollTop };
        else sp.top = body.scrollTop;
        clearTimeout(tick);
        tick = setTimeout(() => {
          commitScrollProbe();
          scheduleSave();
          updateReaderSeek();
        }, 260);
      }, { passive: true });
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
  /* 表单类弹窗（改卷名 / 书源 / 封面 / 书架菜单 / 批量操作 / 朗读设置 / 快捷键说明）
     都是直接 append 到 body 的覆盖层：底下页面照样在无障碍树和 Tab 序列里，
     键盘 Tab 几下就跑到后面的书卡上了，读屏也会把整页再念一遍。
     这里按「有没有弹窗」统一给主干设 inert，弹窗一关就还回去。
     弹窗是 append / remove 的，用 body 的 childList 观察最省事，不必每处开关都改。 */
  const MODAL_SELS = ['#shortcutHelp', '#metaModal', '#sourceModal', '#coverModal', '#shelfMenu', '#shelfActions', '#voiceModal'];
  let modalWasOpen = false;
  function findOpenModal() {
    for (let i = 0; i < MODAL_SELS.length; i++) {
      const el = $(MODAL_SELS[i]);
      if (el && !el.hidden && el.childElementCount) return el;
    }
    return null;
  }
  function syncModalInert() {
    const z = findOpenModal();
    const on = !!z;
    /* #view 等主干：阅读器或全屏听卷页占着屏时本来就被设过，关弹窗不能替它们撤掉 */
    ['#view', '.topbar', '#bottomNav', '.sidebar'].forEach((sel) => {
      const el = $(sel); if (!el) return;
      if (on) { el.setAttribute('inert', ''); el.setAttribute('aria-hidden', 'true'); }
      else if (!readerRoot.dataset.currentBook && !listenFullOpen()) { el.removeAttribute('inert'); el.removeAttribute('aria-hidden'); }
    });
    /* 阅读器本体：弹窗盖在它上面时也得让开 */
    const rd = $('#reader');
    if (rd) {
      if (on) { rd.setAttribute('inert', ''); rd.setAttribute('aria-hidden', 'true'); }
      else if (!listenFullOpen()) { rd.removeAttribute('inert'); rd.removeAttribute('aria-hidden'); }
    }
    if (on && !modalWasOpen) {
      const a = document.activeElement;
      ui.modalFrom = (a && a !== document.body && !z.contains(a)) ? a : null;
      /* 弹窗自己会 focus 输入框的（改卷名等），这里只在焦点还落在被 inert 的区域时才兜底 */
      if (!z.contains(document.activeElement)) {
        const first = z.querySelector('input:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]');
        if (first) first.focus({ preventScroll: true });
      }
    } else if (!on && modalWasOpen) {
      /* 打开时焦点可能本来就在 body 上（刚换过路由），退到阅读器或页面容器，别留在 body */
      const back = (ui.modalFrom && document.contains(ui.modalFrom)) ? ui.modalFrom : ($('#reader') || $('#view'));
      if (back) back.focus({ preventScroll: true });
      ui.modalFrom = null;
    }
    modalWasOpen = on;
  }
  function watchModals() {
    if (typeof MutationObserver === 'undefined') return;
    new MutationObserver(() => syncModalInert()).observe(document.body, { childList: true });
  }
  const READER_BG_SEL = ['#readerTop', '#readerBody', '#readerBottom', '#searchNav'];
  function syncReaderInert(force) {
    let on;
    if (typeof force === 'boolean') on = force;
    else {
      on = false;
      ['#readerPanel', '#catalogDrawer', '#searchDrawer'].forEach((sel) => {
        const el = $(sel);
        if (el && !el.hidden) on = true;
      });
    }
    READER_BG_SEL.forEach((sel) => {
      const el = $(sel); if (!el) return;
      if (on) { el.setAttribute('inert', ''); el.setAttribute('aria-hidden', 'true'); }
      else { el.removeAttribute('inert'); el.removeAttribute('aria-hidden'); }
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
    /* 标题跟着回到书肆，别让标签页一直停在「在读《某卷》第 N 章」 */
    if (document.title !== APP_TITLE) document.title = APP_TITLE;
    document.body.style.overflow = '';
    setBgInert(false);
  }
  function openPanel(kind) {
    cancelPanelClose();
    hideHlPop();
    hideHlEdit();
    const mask = $('#readerMask'), panel = $('#readerPanel'), drawer = $('#catalogDrawer');
    const b = getBook(readerRoot.dataset.currentBook); if (!b) return;
    /* 记下触发它的按钮：关闭后焦点要还回原处，而不是丢到 body */
    const from = document.activeElement;
    if (from && from !== document.body && !from.closest('#catalogDrawer') && !from.closest('#readerPanel')) ui.panelFrom = from;
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
          ${[['slide', '滑动'], ['realistic', '仿真'], ['fade', '淡入'], ['none', '无动画']].map(([k, l]) =>
            `<button class="rs-pill ${state.settings.flipAnim === k ? 'active' : ''}" data-action="set-flipanim" data-val="${k}">${l}</button>`).join('')}
        </div></div>
        <div class="rs-row rate-inline"><label>朗读</label>${rateSliderHtml(state.settings.rate, '语速 · 按住圆点拖动')}</div>
        <div class="rs-row"><label>存档</label><div class="rs-pills">
          <button class="rs-pill" data-action="export-chapter">导出本章 TXT</button>
        </div></div>
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
    } else if (kind === 'catalog' || kind === 'bookmark' || kind === 'annotation') {
      panel.hidden = true; drawer.hidden = false;
      ui.catalogTab = kind;
      const cur = Number(readerRoot.dataset.currentCh) || 1;
      const chs = chapterList(b);
      const marks = bookmarkList(b.id);
      const tabs = `<div class="cat-tabs">
        <button class="${kind === 'catalog' ? 'active' : ''}" data-action="open-panel" data-val="catalog">目录 ${chs.length}</button>
        <button class="${kind === 'bookmark' ? 'active' : ''}" data-action="open-panel" data-val="bookmark">卷签 ${marks.length}</button>
        <button class="${kind === 'annotation' ? 'active' : ''}" data-action="open-panel" data-val="annotation">笔记 ${annotationList(b.id).length}</button>
      </div>`;
      const resume = state.progress[b.id] || {};
      const resumeCh = resume.ch || 0;
      const resumeHtml = (resumeCh && resumeCh <= chs.length)
        ? `<button class="cat-resume" data-action="catalog-goto" data-ch="${resumeCh}">${icon('play', 'ic-sm')} 继续读 · 第 ${resumeCh} 章 ${Math.round((resume.pct || 0) * 100)}%</button>`
        : '';
      const noteMap = {};
      annotationList(b.id).forEach((a) => { noteMap[a.ch] = (noteMap[a.ch] || 0) + 1; });
      const content = kind === 'catalog'
        ? `${resumeHtml}<div class="cat-search">${icon('search', 'ic-sm')}<input id="catalogSearch" placeholder="搜章节名，或直接输入第几章" autocomplete="off"></div>
          <ul class="catalog-list" id="catalogList">${chs.map((c, i) => {
            const no = i + 1;
            const n = noteMap[no] || 0;
            const read = no < cur;
            return `<li class="${no === cur ? 'active' : ''}${read ? ' read' : ''}" data-action="catalog-goto" data-ch="${no}">
              <span class="cl-title">${esc(c.title)}</span>
              <small>${read ? '<i class="ch-read">读过</i>' : ''}${n ? `<i class="ch-note" title="${n} 条笔记">✎${n}</i>` : ''}${no}</small></li>`;
          }).join('')}</ul>
          <div class="cat-empty" id="catNoMatch" hidden>没有匹配的章节<br><small>试试章名里的关键词，或直接输入第几章</small></div>
          <div class="cat-nav">
            <button class="btn btn-ghost btn-sm" data-action="reader-prev" ${cur <= 1 ? 'disabled' : ''}>${icon('left', 'ic-sm')} 上一章</button>
            <button class="btn btn-ghost btn-sm" data-action="copy-chapter" title="复制本章正文">${icon('brush', 'ic-sm')} 复制本章</button>
            <button class="btn btn-ghost btn-sm" data-action="reader-next" ${cur >= chs.length ? 'disabled' : ''}>下一章 ${icon('right', 'ic-sm')}</button>
          </div>`
        : kind === 'annotation' ? annotationHtml(b)
        : `<div class="catalog-list bookmark-list">${marks.length ? marks.map((m, i) => (ui.bmNote === i ? `
            <li class="bm-editing" data-bm-editing="1">
              <div class="bm-edit-head">第 ${m.ch} 章${m.page ? ' · 第 ' + (m.page + 1) + ' 页' : ''} · 写在卷签上的话</div>
              <textarea id="bmNoteInput" rows="3" placeholder="为什么记下这一页？读到这里的想法…">${esc(m.note || '')}</textarea>
              <div class="bm-edit-acts">
                <button class="btn btn-ghost btn-sm" data-action="bm-note-cancel">取消</button>
                <button class="btn btn-primary btn-sm" data-action="bm-note-save" data-val="${i}">保存</button>
                ${m.note ? `<button class="btn btn-ghost btn-sm btn-danger" data-action="bm-note-clear" data-val="${i}">清除</button>` : ''}
              </div>
            </li>` : `
            <li data-action="bookmark-goto" data-val="${i}" class="${m.note ? 'has-note' : ''}">
              <span><b>${esc(m.title)}</b><small>${new Date(m.time).toLocaleDateString('zh-CN')} · 第 ${m.ch} 章${m.page ? ' · 第 ' + (m.page + 1) + ' 页' : ''}</small>
                ${m.note ? `<i class="bm-note">${esc(m.note)}</i>` : ''}</span>
              <button class="bm-del" data-action="bm-note-edit" data-val="${i}" title="${m.note ? '改备注' : '写备注'}">${icon('brush', 'ic-sm')}</button>
              <button class="bm-del" data-action="bookmark-del" data-val="${i}" title="删除卷签">${icon('trash', 'ic-sm')}</button>
            </li>`)).join('') : '<div class="cat-empty">还没有卷签<br><small>点顶部的星形按钮，把当前这一页收进卷签</small></div>'}</div>`;
      drawer.innerHTML = `<div class="catalog-head"><span>${esc(b.title)}</span>
          <button class="icon-btn" data-action="panel-close" title="关闭">${icon('close', 'ic-sm')}</button></div>
        ${tabs}${content}`;
    }
    a11ySweep(panel); a11ySweep(drawer);
    /* 正文与工具栏先 inert 掉，Tab 就不会从抽屉里跑到背后的翻页按钮上 */
    syncReaderInert();
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
    if (into && !into.hidden) {
      into.setAttribute('tabindex', '-1');
      into.setAttribute('role', 'dialog');
      into.setAttribute('aria-modal', 'true');
      into.setAttribute('aria-label', kind === 'settings' ? '读墨设置'
        : kind === 'notes' ? '校勘记' : '目录、卷签与笔记');
      into.focus({ preventScroll: true });
      /* 焦点直接落到第一个控件，键盘用户不用从容器开始一路 Tab */
      const firstCtl = into.querySelector('button:not([disabled]), input:not([disabled])');
      if (firstCtl) firstCtl.focus({ preventScroll: true });
    }
    /* 面板盖上来时把检索条收起，免得压在抽屉/设置上 */
    syncSearchNav();
  }
  function closePanel() {
    hideHlEdit();
    ui.bmNote = -1;
    cancelPanelClose();
    const mask = $('#readerMask'), panel = $('#readerPanel'), drawer = $('#catalogDrawer');
    const hadFocus = document.activeElement && (document.activeElement === panel || document.activeElement === drawer
      || (panel && panel.contains(document.activeElement)) || (drawer && drawer.contains(document.activeElement)));
    const finish = () => {
      if (mask) mask.hidden = true;
      if (panel) { panel.hidden = true; panel.innerHTML = ''; }
      if (drawer) { drawer.hidden = true; drawer.innerHTML = ''; }
      syncReaderInert(false);
      syncSearchNav();
    };
    /* 面板淡出、遮罩渐隐，动画走完再清内容；焦点先还回去，别等 */
    if (mask && !mask.hidden) mjExitDo(mask, 'mj-fade-out');
    if (panel && !panel.hidden) mjExitDo(panel, 'mj-out');
    if (drawer && !drawer.hidden) mjExitDo(drawer, 'mj-out-left');
    if (hadFocus) {
      /* 先解除正文的 inert，否则底栏按钮还带着 inert，focus() 会被静默忽略 */
      syncReaderInert(false);
      /* 优先回到当初点开它的那个按钮；换章后旧节点已不在 DOM 里，就退回阅读器本身 */
      const back = (ui.panelFrom && document.contains(ui.panelFrom)) ? ui.panelFrom : $('#reader');
      if (back) back.focus({ preventScroll: true });
      ui.panelFrom = null;
    }
    if ((mask && !mask.hidden) || (panel && !panel.hidden) || (drawer && !drawer.hidden)) {
      panelCloseTimer = setTimeout(() => {
        panelCloseTimer = 0;
        [mask, panel, drawer].forEach(mjExitCancel);
        finish();
      }, 180);
    } else finish();
  }
  function switchChapter(id, ch, pct) {
    hideHlEdit();
    const b = getBook(id);
    ch = Math.max(1, Math.min(chapterList(b).length, ch));
    state.progress[id] = { ch, pct: pct || 0, updated: Date.now() };
    state.lastRead = id; save();
    /* 新进度已写好，而 showReader 里还会结算一次滚动读数：那份读数属于换章前的
       旧章，同书换章时它的节点/书 id 校验全过得去，会把刚写的新章进度覆盖回旧章。
       这里先作废，让那次结算变成空操作；直接改路由进 showReader 的路径仍会正常结算。 */
    ui.scrollProbe = null;
    history.replaceState(null, '', '#/reader/' + id + '/' + ch);
    showReader(id, ch);
    closePanel();
    if (ui.searchNavOn) syncSearchNav();
  }

  /* ---------- 阅读器内文搜索：在本书已载入的章节里找词，点结果跳到命中段落 ---------- */
  let searchAllToken = 0;
  let readerSearchTimer = 0;
  const SEARCH_SHOW_LIMIT = 200;
  /* 输入时别每敲一个字就把全书重扫一遍（长卷上千章会明显卡手） */
  function scheduleBookSearch(b, q) {
    clearTimeout(readerSearchTimer);
    readerSearchTimer = setTimeout(() => { readerSearchTimer = 0; runBookSearch(b, q); }, 140);
  }
  function openReaderSearch() {
    const b = getBook(readerRoot.dataset.currentBook); if (!b) return;
    cancelPanelClose();
    mjExitCancel($('#searchDrawer'));
    const mask = $('#readerMask'), d = $('#searchDrawer');
    if (!mask || !d) return;
    const from = document.activeElement;
    if (from && from !== document.body) ui.searchFrom = from;
    mask.hidden = false; d.hidden = false;
    d.setAttribute('role', 'dialog'); d.setAttribute('aria-modal', 'true');
    d.setAttribute('aria-label', '在《' + b.title + '》中检索');
    d.setAttribute('tabindex', '-1');
    const rec = contentCache[b.id];
    const cached = (rec && rec.chapters ? rec.chapters.filter(Boolean).length : 0);
    const total = chapterList(b).length;
    const needNet = b.online && cached < total;
    d.innerHTML = `<div class="search-head"><span>在《${esc(b.title)}》中检索</span>
        <button class="icon-btn" data-action="search-close" title="关闭">${icon('close', 'ic-sm')}</button></div>
      <div class="search-bar">${icon('search', 'ic-sm')}<input id="searchBox" placeholder="输入要找的词句" autocomplete="off" aria-label="本书内搜索"></div>
      ${needNet ? `<div class="search-hint" id="searchHint">已检索已读过的 ${cached} / ${total} 章 · <button class="linklike" data-action="search-all">联网检索全书</button></div>` : ''}
      <div class="search-results" id="searchResults"><div class="search-empty">输入关键词，在本书内查找</div></div>`;
    const inp = d.querySelector('#searchBox');
    /* 输入框先备好再解除正文 inert，否则焦点会被 inert 里的旧节点抢走 */
    if (inp) { inp.focus(); inp.addEventListener('input', () => scheduleBookSearch(b, inp.value.trim())); }
    syncReaderInert();
  }
  function closeReaderSearch() {
    searchAllToken += 1; /* 抽屉关了就别让后台继续拉章节 */
    clearTimeout(readerSearchTimer); readerSearchTimer = 0;
    const d = $('#searchDrawer');
    const cat = $('#catalogDrawer'), pnl = $('#readerPanel');
    const othersOpen = (cat && !cat.hidden) || (pnl && !pnl.hidden);
    if (d && !d.hidden) mjExitDo(d, 'mj-out-right', () => { d.hidden = true; d.innerHTML = ''; syncReaderInert(); });
    /* 焦点回到「搜索」按钮，键盘不会卡在被清空的抽屉里；背后还有面板开着就交给它 */
    if (!othersOpen) {
      /* 必须先把正文的 inert 解除：目标按钮就在底栏里，inert 状态下 focus() 会被静默吞掉，
         焦点最终掉到 body，读屏会从页面开头重念 */
      syncReaderInert(false);
      const back = (ui.searchFrom && document.contains(ui.searchFrom)) ? ui.searchFrom : $('#reader');
      if (back) back.focus({ preventScroll: true });
    } else if (!d || d.hidden) syncReaderInert();
    ui.searchFrom = null;
    const mask = $('#readerMask');
    /* 没有其它面板开着时才撤掉遮罩，免得关了搜索却把背后的面板露出来 */
    if (mask && !othersOpen) {
      mjExitDo(mask, 'mj-fade-out', () => { mask.hidden = true; });
    }
  }
  function runBookSearch(b, q) {
    const box = $('#searchResults'); if (!box) return;
    const rec = contentCache[b.id];
    ui.searchHits = []; ui.searchIdx = -1;
    if (!q) { box.innerHTML = '<div class="search-empty">输入关键词，在本书内查找</div>'; return; }
    /* 正文来源有两条：在线/本地卷走 contentCache，内置卷直接走同步源。
       只翻 contentCache 的话，内置卷（含单文件离线版）会永远被当成「还没载入正文」。 */
    const chs = loadedParas(b, rec);
    if (!chs.length) { box.innerHTML = '<div class="search-empty">这本书还没载入正文</div>'; return; }
    const hits = [];
    chs.forEach((paras, i) => {
      if (!paras) return;
      paras.forEach((p, pi) => {
        if (p && p.indexOf(q) >= 0) {
          const idx = p.indexOf(q), len = q.length;
          const s = Math.max(0, idx - 16), e = Math.min(p.length, idx + len + 16);
          const raw = (s > 0 ? '…' : '') + p.slice(s, e) + (e < p.length ? '…' : '');
          const eq = esc(q);
          const frag = esc(raw).split(eq).join('<mark>' + eq + '</mark>');
          hits.push({ ch: i + 1, pi, frag });
        }
      });
    });
    if (!hits.length) { box.innerHTML = '<div class="search-empty">没有找到「' + esc(q) + '」</div>'; return; }
    ui.searchHits = hits; ui.searchQ = q;
    /* 全部命中仍留在 ui.searchHits 里，「上一处 / 下一处」能走完；
       但列表一次铺几百上千个 button 会拖垮抽屉，只列前 200 条并说明。 */
    const shown = hits.slice(0, SEARCH_SHOW_LIMIT);
    const tip = hits.length > SEARCH_SHOW_LIMIT
      ? `列表只列前 ${SEARCH_SHOW_LIMIT} 处；「上一处 / 下一处」仍可走完全部 ${hits.length} 处`
      : '点结果跳过去，之后可用「上一处 / 下一处」接着翻';
    box.innerHTML = `<div class="search-count">找到 ${hits.length} 处匹配<span class="sc-tip">${tip}</span></div>` + shown.map((h, i) =>
      `<button class="search-item" data-action="search-go" data-val="${i}">
         <span class="si-ch">第 ${h.ch} 章</span><span class="si-frag">${h.frag}</span>
       </button>`).join('');
  }
  /* 跳到第 i 处命中：跨章要等正文渲染完再定位，否则段落还不存在 */
  function jumpSearchHit(i) {
    const hits = ui.searchHits || [];
    if (!hits.length) return;
    if (i < 0) { toast('已经是第一处'); return; }
    if (i >= hits.length) { toast('已经是最后一处'); return; }
    const b = getBook(readerRoot.dataset.currentBook); if (!b) return;
    ui.searchIdx = i; ui.searchNavOn = true; ui.searchBook = b.id;
    const h = hits[i];
    const cur = Number(readerRoot.dataset.currentCh) || 1;
    if (cur !== h.ch) { switchChapter(b.id, h.ch, 0); setTimeout(() => { focusSearchHit(h.pi); syncSearchNav(); }, 320); }
    else { focusSearchHit(h.pi); syncSearchNav(); }
  }
  function syncSearchNav() {
    const bar = $('#searchNav'); if (!bar) return;
    const n = (ui.searchHits || []).length;
    const drawerOpen = !(($('#catalogDrawer') || {}).hidden) || !(($('#readerPanel') || {}).hidden);
    const on = ui.searchNavOn && n > 0 && ui.searchIdx >= 0 && !drawerOpen
      && readerRoot && readerRoot.dataset.currentBook === ui.searchBook;
    bar.hidden = !on;
    if (!on) return;
    const c = $('#searchNavCount'); if (c) c.textContent = (ui.searchIdx + 1) + ' / ' + n;
    const prev = $('[data-action="search-nav-prev"]'), next = $('[data-action="search-nav-next"]');
    if (prev) prev.disabled = ui.searchIdx <= 0;
    if (next) next.disabled = ui.searchIdx >= n - 1;
  }
  function closeSearchNav() {
    ui.searchNavOn = false; ui.searchHits = []; ui.searchIdx = -1; ui.searchBook = '';
    const bar = $('#searchNav'); if (bar) bar.hidden = true;
  }
  function focusSearchHit(pi) {
    const flip = state.settings.pageMode === 'flip';
    let tries = 0;
    const once = () => {
      let el;
      if (flip) {
        const targetIdx = pi + 2; /* no + h1 占两个 idx，段 j 的 flip idx 即 j+2 */
        const pg = flipState.pages.findIndex((pg) => pg.some((it) => it.idx === targetIdx));
        if (pg >= 0) { flipState.page = pg; renderFlipPage(''); }
        el = $('#flipPage [data-fi="' + targetIdx + '"]');
      } else {
        el = $('#readerPaper p[data-pi="' + pi + '"]');
      }
      if (el) {
        if (!flip) el.scrollIntoView({ block: 'center' });
        el.classList.remove('search-hit'); void el.offsetWidth; el.classList.add('search-hit');
        setTimeout(() => el.classList.remove('search-hit'), 2800);
        return;
      }
      if (tries++ < 12) { setTimeout(once, 90); return; }
      toast('这一页还没渲染出来');
    };
    once();
  }
  function cancelSearchAll() {
    searchAllToken += 1;
    const b = getBook(readerRoot.dataset.currentBook);
    const q = (($('#searchBox') || {}).value || '').trim();
    if (b) runBookSearch(b, q); /* 取消后立刻给出「已载入部分」的结果 */
    const hint = $('#searchHint');
    if (hint) hint.innerHTML = '已取消 · 只检索已载入的章节 <button class="linklike" data-action="search-all">继续检索全书</button>';
  }
  async function searchAll(b) {
    if (!b) return;
    const box = $('#searchResults'), hint = $('#searchHint');
    const total = chapterList(b).length;
    const token = ++searchAllToken;
    let done = 0;
    const paint = () => {
      if (token !== searchAllToken) return;
      if (box) box.innerHTML = '<div class="search-empty">正在联网载入全书… <b>' + done + ' / ' + total
        + '</b> 章<br><small>可继续输入关键词，或 <button class="linklike" data-action="search-all-cancel">取消检索</button></small></div>';
      if (hint) hint.innerHTML = '已载入 ' + done + ' / ' + total + ' 章';
    };
    paint();
    const queue = [];
    for (let i = 1; i <= total; i++) queue.push(i);
    const worker = async () => {
      while (queue.length && token === searchAllToken) {
        const i = queue.shift();
        try { await ensureChapter(b, i); } catch (e) { /* 单章失败不打断其它章 */ }
        done += 1;
        if (done % 4 === 0 || done === total) paint();
      }
    };
    /* 3 路并发：原来逐章串行，长卷最坏是 N × 单章超时；也别开太大把在线源打爆 */
    await Promise.all(Array.from({ length: Math.min(3, total) }, worker));
    if (token !== searchAllToken) return;
    const q = (($('#searchBox') || {}).value || '').trim();
    clearTimeout(readerSearchTimer); readerSearchTimer = 0;
    runBookSearch(b, q);
    /* 「done / total」只说明跑完了多少章，不等于取到了多少章：断网或书源限流时
       整本跑完可能一大半是空的，用户会以为「全网没有这个词」。
       这里把结果拆成「取到 / 冷却中 / 失败」三类，冷却的给一键重试。 */
    const rec = contentCache[b.id];
    let got = 0, cooling = 0, missing = 0;
    for (let i = 0; i < total; i++) {
      const c = rec && rec.chapters && rec.chapters[i];
      if ((c && c.paras && c.paras.length) || SRC.getChapterSync(b.id, i + 1)) { got += 1; continue; }
      if (c && c.error && Date.now() < (c.retryAt || 0)) cooling += 1; else missing += 1;
    }
    if (hint) {
      let s = '已检索 ' + got + ' / ' + total + ' 章';
      if (cooling) s += ' · ' + cooling + ' 章请求冷却中';
      if (missing) s += ' · ' + missing + ' 章取回失败';
      if (cooling || missing) s += ' · <button class="linklike" data-action="search-all">重试未取回的章</button>';
      hint.innerHTML = s;
    }
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
  const tocFailAt = {};
  /* 断网时取目录是立刻 reject 的，一失败就把 tocTried 放回 false、再 render 又触发一次，
     会变成「永远停在正在取回 + 每秒上千次失败请求」。所以失败后要停手：
     钉住 tocTried、记下失败时刻，8 秒内不自动重试；离开详情页再进来才重新自动试一次。 */
  const TOC_COOLDOWN = 8000;
  async function hydrateOnlineToc(id, force) {
    const b = getBook(id);
    if (!b || !b.online || tocTried[id]) return;
    if (!force && (b.chapters || []).length > 1) return;
    const src = SRC.get(b.sourceId);
    if (!src || typeof src.getBookMeta !== 'function') return;
    const lastFail = tocFailAt[id] || 0;
    if (!force && lastFail && Date.now() - lastFail < TOC_COOLDOWN) { ui.tocFailed = true; ui.tocOffline = !online(); return; }
    /* 明确断网就别发了：省电，也不用让用户对着转圈等 */
    if (!online()) {
      tocTried[id] = true; ui.tocLoading = false; ui.tocFailed = true; ui.tocOffline = true;
      tocFailAt[id] = Date.now();
      const now = parseRoute();
      if (now.name === 'book' && now.id === id) render();
      return;
    }
    tocTried[id] = true;
    ui.tocLoading = true; ui.tocFailed = false;
    const cur = parseRoute();
    if (cur.name === 'book' && cur.id === id) { const box = $('#tocPanel'); if (box) box.innerHTML = tocLoadingHtml(); }
    try {
      const m = await src.getBookMeta(id, { force });
      if (m && m.chapters && m.chapters.length > 1) {
        b.chapters = m.chapters;
        delete tocFailAt[id];
      } else {
        ui.tocFailed = true; tocFailAt[id] = Date.now();
      }
    } catch (e) { ui.tocFailed = true; tocFailAt[id] = Date.now(); }
    ui.tocLoading = false;
    ui.tocOffline = !online();
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
    /* 离开详情页就把「这次取过目录」的记账清掉：下次再进来（哪怕刚断过网）
       还会自动试一次，但停在页面上时不会反复空转。 */
    if (r.name !== 'book') {
      Object.keys(tocTried).forEach((k) => { delete tocTried[k]; });
      Object.keys(tocFailAt).forEach((k) => { delete tocFailAt[k]; });
    }
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
    if (r.name === 'shelf') applyShelfSearch(ui.shelfSearch);
    if (r.name === 'me') applyNoteFilter();
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
    /* 整理模式下行内任意位置都算勾选，别让点标题把面板关掉 */
    if (ui.noteMulti) {
      const row = e.target.closest('[data-note-item]');
      if (row) { e.preventDefault(); toggleNotePick(row); return; }
    }
    const goEl = e.target.closest('[data-go]');
    if (goEl) { go(goEl.dataset.go); return; }
    const el = e.target.closest('[data-action]');
    if (!el) {
      /* 刚划完字时点正文只收起工具条，别顺手翻页 */
      if ($('#hlPop') && !$('#hlPop').hidden) { hideHlPop(); return; }
      /* 点已有的划线是「编辑它」，别把当页翻过去、也别收工具条 */
      if (e.target.closest('mark.hl-mark')) return;
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
      case 'clean-covers': {
        /* 只掉图片，保留每本书选过的底纹 / 配色 / 印章，封面还会按原风格重新生成，
           不至于一键清成全白。 */
        const ids = Object.keys(state.covers || {}).filter((x) => state.covers[x] && state.covers[x].image);
        if (!ids.length) { toast('没有可清理的封面图'); break; }
        if (!confirm('清理 ' + ids.length + ' 张自定义封面图？\n\n封面的底纹、配色与印章会保留，只是不再显示照片；此操作不可撤销。')) break;
        ids.forEach((x) => { delete state.covers[x].image; });
        markCoversDirty();
        const okSave = save();
        if (okSave) ui.storageFull = false;
        /* 这一行在墨斋页中部，直接 render() 会把页面滚回页首（按钮刚点完就被甩走）。
           rerender() 会带上当前 scrollY，清完还留在原地，能接着看占用降了多少。 */
        rerender();
        toast(okSave ? '已清理 ' + ids.length + ' 张封面图' : '封面图已清理，但空间仍然不够，建议导出备份后清理已导入的卷');
        break;
      }
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
      case 'toggle-theme': {
        const night = toggleNight();
        rerender();
        toast(night ? '已切换夜墨模式' : '已回到宣纸日光'); break;
      }
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
        state.covers[cd.id] = c; markCoversDirty();
        const ok = save();
        closeCoverEditor();
        toast(ok ? '封面已更换' : '已应用，但本机空间不足无法长期保存');
        rerender(); break;
      }
      case 'cover-reset': {
        if (!ui.coverDraft) break;
        const b = getBook(ui.coverDraft.id);
        delete state.covers[ui.coverDraft.id]; markCoversDirty(); save();
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
      case 'set-book-tag': {
        if (!id) break;
        if (val) state.bookTags[id] = val; else delete state.bookTags[id];
        save(); rerender();
        toast(val ? '已标记为「' + TAG_LABEL[val] + '」' : '已清除标记');
        break;
      }
      case 'set-shelf-sort': ui.shelfSort = val; rerender(); break;
      case 'open-shortcut-help': openShortcutHelp(); break;
      case 'close-shortcut-help': closeShortcutHelp(); break;
      case 'clear-shelf-search': {
        const inp = $('#shelfSearch');
        if (inp) { inp.value = ''; inp.focus(); }
        applyShelfSearch('');
        break;
      }
      case 'clear-note-search': {
        const inp = $('#noteSearch');
        if (inp) { inp.value = ''; inp.focus(); }
        ui.noteSearch = ''; applyNoteFilter();
        break;
      }
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
        ui.selected.forEach((x) => {
          state.progress[x] = { ch: 1, pct: 0, updated: Date.now() };
          /* 续听位置是另一套状态，留着的话进度归零了、听卷却还跳回旧章旧句 */
          delete state.listenPos[x];
        });
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
        markCoversDirty();
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
          box.innerHTML = pick(allBooks(), 8).map((b) => bookCard(b, { badge: charNum(b) >= 100000 ? '长卷' : '', quickAdd: true })).join('');
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
        if (val !== 'slide') { realClear(); clearAdj(); }
        $$('#readerPanel .rs-pill').forEach((p) => { if (p.dataset.action === 'set-flipanim') p.classList.toggle('active', p.dataset.val === val); });
        break;
      case 'reset-data':
        if (confirm('确定清空藏卷、进度、设置和已导入的本地卷吗？此操作不可撤销。')) {
          const ids = state.localBooks.map((b) => b.id);
          /* 所有 mojuan.* 键一起清：自定义书源、停用的源、在线音色 key、目录缓存
             原来都会残留，用户以为「清空」了其实还留着配置和大块缓存。 */
          try {
            const del = [];
            for (let i = 0; i < localStorage.length; i++) {
              const k = localStorage.key(i);
              if (k && (k === KEY || k.indexOf('mojuan.') === 0)) del.push(k);
            }
            del.forEach((k) => localStorage.removeItem(k));
          } catch (e) { /* 存储不可用 */ }
          state = structuredClone(DEFAULTS); state.v = 5;
          coversDirty = false; /* 刚清空，别又写一个空的封面键回来 */
          save();
          ids.forEach((x) => { deleteContent(x).catch(() => {}); delete contentCache[x]; });
          /* 听书音频缓存是另一个 IndexedDB，不清会白占几十 MB */
          try { indexedDB.deleteDatabase(AUDIO_DB); } catch (e) {}
          applyTheme(); go('shelf'); toast('已恢复初始状态');
        }
        break;
      /* 阅读器 */
      case 'reader-back':
        if (history.length > 1) history.back(); else go('book/' + readerRoot.dataset.currentBook);
        break;
      case 'reader-catalog': openPanel('catalog'); break;
      case 'copy-chapter': {
        const b = getBook(readerRoot.dataset.currentBook);
        if (!b) break;
        const ch = Number(readerRoot.dataset.currentCh) || 1;
        const t = (chapterList(b)[ch - 1] || {}).title || ('第 ' + ch + ' 章');
        const paras = paragraphs(b, ch - 1) || [];
        if (!paras.length) { toast('这一章还没有正文'); break; }
        const text = '《' + b.title + '》 ' + (b.author || '') + '\n' + t + '\n\n' + paras.join('\n\n');
        closePanel();
        copyText(text).then((ok) => toast(ok ? '已复制本章正文' : '复制失败，请检查浏览器权限'));
        break;
      }
      case 'export-chapter': {
        const b = getBook(readerRoot.dataset.currentBook);
        if (!b) break;
        const ch = Number(readerRoot.dataset.currentCh) || 1;
        const t = (chapterList(b)[ch - 1] || {}).title || ('第 ' + ch + ' 章');
        const paras = paragraphs(b, ch - 1) || [];
        if (!paras.length) { toast('这一章还没有正文'); break; }
        const meta = ['《' + b.title + '》' + (b.author ? ' · ' + b.author : ''), t, '', '导出于 ' + new Date().toLocaleString('zh-CN'), ''];
        const text = meta.concat(paras).join('\n') + '\n';
        const safe = (b.title + '-' + t).replace(/[\\/:*?"<>|\s]+/g, '').slice(0, 60);
        toast(downloadText((safe || '墨卷-' + ch) + '.txt', text) ? '本章已导出为 TXT' : '导出失败，请检查浏览器下载权限');
        break;
      }
      case 'reader-settings': openPanel('settings'); break;
      case 'panel-close': closePanel(); break;
      case 'reader-search': openReaderSearch(); break;
      case 'search-close': closeReaderSearch(); break;
      case 'search-go': closeReaderSearch(); jumpSearchHit(Number(val)); break;
      case 'search-nav-prev': jumpSearchHit((ui.searchIdx || 0) - 1); break;
      case 'search-nav-next': jumpSearchHit((ui.searchIdx || 0) + 1); break;
      case 'search-nav-close': closeSearchNav(); break;
      /* 点「联网检索全书」＝用户主动要求再试：把冷却期提前作废，
         否则断网恢复后点重试仍在冷却里的章节会被直接跳过 */
      case 'search-all': {
        const tb = getBook(readerRoot.dataset.currentBook);
        const tr = tb && contentCache[tb.id];
        if (tr && tr.chapters) tr.chapters.forEach((c) => { if (c && c.error) c.retryAt = 0; });
        searchAll(tb);
        break;
      }
      case 'search-all-cancel': cancelSearchAll(); break;
      case 'reader-prev': switchChapter(readerRoot.dataset.currentBook, Number(readerRoot.dataset.currentCh) - 1); break;
      case 'reader-next': switchChapter(readerRoot.dataset.currentBook, Number(readerRoot.dataset.currentCh) + 1); break;
      case 'reader-retry': {
        /* 断网时点「重新取回」：把这一章的失败结果从缓存里清掉再拉一次 */
        const rid = readerRoot.dataset.currentBook, rch = Number(readerRoot.dataset.currentCh) || 1;
        const rec = contentCache[rid];
        /* 把失败标记一起删掉，否则下次 ensureChapter 会以为这章有结果 */
        if (rec && rec.chapters) delete rec.chapters[rch - 1];
        toast('正在重新取回…');
        showReader(rid, rch); break;
      }
      case 'flip-prev': flipBy(-1); break;
      case 'flip-next': flipBy(1); break;
      case 'catalog-goto': {
        /* 「继续读」指向当前章时要把章内进度一起带上，否则 switchChapter 的
           pct || 0 会把人弹回章首；点别的章则从第 0 页开始。 */
        const cid = readerRoot.dataset.currentBook;
        const pr = state.progress[cid] || {};
        switchChapter(cid, ch, Number(ch) === (pr.ch || 0) ? (pr.pct || 0) : 0);
        break;
      }
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
      case 'listen-scope': {
        const next = (val === 'chapter' || val === 'book') ? val
          : (listen.scope === 'chapter' ? 'book' : 'chapter');
        listen.scope = next; state.listenScope = next; save();
        const p = $('#listenPanel');
        if (p && !p.hidden && p.dataset.kind === 'where') listenPanel('where');
        listenRenderDynamic();
        listenAnnounce(next === 'chapter' ? '朗读范围：本章，读完即停' : '朗读范围：全书，本章读完接着下一章');
        toast(next === 'chapter' ? '只读本章 · 读完即停' : '从本章读到全书完');
        break;
      }
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
        listen.fadeOut = false;
        clearTimeout(listenFadeTimer); listenFadeTimer = null;
        if (listen.timerMin) {
          listen.timerAt = Date.now() + listen.timerMin * 60000;
        } else { listen.timerAt = 0; }
        /* 到点由每秒巡检（listenTimerCheck）负责，这里只落一个时间戳 */
        listenPanel('where'); listenRenderDynamic();
        listenAnnounce(listen.timerMin ? '定时 ' + listen.timerMin + ' 分钟，到点等这一句念完再停' : '已取消定时');
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
        listenSeekRatio((e.clientX - rect.left) / rect.width);
        break;
      }
      case 'open-panel': openPanel(val); break;
      case 'open-notes': openPanel('notes'); break;
      case 'hl-save': saveHl(''); break;
      case 'hl-color': {
        ui.hlColor = val === 'jade' || val === 'gold' ? val : 'red';
        $$('#hlColors .hl-dot').forEach((b) => b.classList.toggle('active', b.dataset.val === ui.hlColor));
        break;
      }
      case 'hl-note-open': {
        const n = $('#hlNote'), i = $('#hlNoteInput');
        if (n) n.hidden = false;
        if (i) i.focus();
        break;
      }
      case 'hl-save-note': saveHl((($('#hlNoteInput') || {}).value || '').trim()); break;
      case 'hl-edit-color': {
        const col = val === 'jade' || val === 'gold' ? val : 'red';
        if (!hlEditMutate((a) => { a.color = col; })) break;
        $$('#hlEditColors .hl-dot').forEach((b) => b.classList.toggle('active', b.dataset.val === col));
        toast('已改为' + NOTE_COLORS[col]);
        break;
      }
      case 'hl-edit-note': {
        const n = $('#hlEditNote'), i = $('#hlEditNoteInput');
        if (n) n.hidden = false;
        if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); }
        break;
      }
      case 'hl-edit-note-save': {
        const v = (($('#hlEditNoteInput') || {}).value || '').trim();
        if (!hlEditMutate((a) => { a.note = v; })) break;
        hideHlEdit();
        toast(v ? '批注已保存' : '批注已清空');
        break;
      }
      case 'hl-edit-del': {
        if (!hlEditTarget) break;
        const t = hlEditTarget;
        const list = annotationList(t.bid), a = list[t.idx];
        if (!a) { hideHlEdit(); break; }
        list.splice(t.idx, 1); state.annotations[t.bid] = list; save();
        refreshHlParas(t.bid, a.ch, a.pi);
        hideHlEdit();
        toast('已删除这条笔记');
        break;
      }
      case 'toggle-note-multi': {
        ui.noteMulti = !ui.noteMulti;
        if (!ui.noteMulti) ui.notePicked.clear();
        rerender();
        break;
      }
      case 'note-pick-all': {
        const vis = $$('[data-note-item]').filter((el) => !el.hidden);
        const allOn = vis.length && vis.every((el) => ui.notePicked.has(el.dataset.noteKey));
        vis.forEach((el) => {
          const k = el.dataset.noteKey;
          if (allOn) ui.notePicked.delete(k); else ui.notePicked.add(k);
          paintNotePick(el);
        });
        syncNotePickBar();
        break;
      }
      case 'note-bulk-color': applyNoteBulkColor(val === 'jade' || val === 'gold' ? val : 'red'); break;
      case 'note-bulk-del': applyNoteBulkDelete(); break;
      case 'annotation-goto': {
        const b = getBook(readerRoot.dataset.currentBook);
        const a = b && annotationList(b.id)[Number(val)];
        if (!a) break;
        closePanel();
        const cur = Number(readerRoot.dataset.currentCh) || 1;
        if (cur !== a.ch) { switchChapter(b.id, a.ch, 0); setTimeout(() => focusSearchHit(a.pi), 320); }
        else focusSearchHit(a.pi);
        break;
      }
      case 'annotation-del': {
        const b = getBook(readerRoot.dataset.currentBook); if (!b) break;
        const list = annotationList(b.id), idx = Number(val), d = list[idx];
        if (!d) break;
        list.splice(idx, 1); state.annotations[b.id] = list; save();
        refreshHlParas(b.id, d.ch, d.pi);
        openPanel('annotation'); toast('已删除');
        break;
      }
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
        const night = toggleNight();
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
        state.bookmarks[bid] = list; save(); ui.bmNote = -1;
        openPanel('bookmark'); syncBookmarkBtn(); toast('已删除卷签');
        break;
      }
      case 'bookmark-del-global': {
        const list = bookmarkList(id).slice();
        list.splice(Number(val), 1);
        state.bookmarks[id] = list; save(); rerender(); toast('已删除卷签');
        break;
      }
      case 'bm-note-edit': ui.bmNote = Number(val); openPanel('bookmark'); {
        const t = $('#bmNoteInput'); if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); }
        break;
      }
      case 'bm-note-cancel': ui.bmNote = -1; openPanel('bookmark'); break;
      case 'bm-note-clear': {
        const bid = readerRoot.dataset.currentBook;
        const m = bookmarkList(bid)[Number(val)];
        if (!m) break;
        m.note = ''; ui.bmNote = -1; save(); openPanel('bookmark'); toast('已清除备注');
        break;
      }
      case 'bm-note-save': {
        const bid = readerRoot.dataset.currentBook;
        const m = bookmarkList(bid)[Number(val)];
        if (!m) break;
        const v = (($('#bmNoteInput') || {}).value || '').trim().slice(0, 300);
        m.note = v; ui.bmNote = -1; save(); openPanel('bookmark');
        toast(v ? '备注已保存' : '备注已清空');
        break;
      }
      case 'open-bookmark': {
        const m = bookmarkList(id)[Number(val)];
        if (!m) { toast('卷签已不存在'); break; }
        ui.flipTargetPage = m.page || 0;
        go('reader/' + id + '/' + m.ch);
        break;
      }
      case 'export-annotations': exportAnnotations(true); break;
      case 'set-note-color': {
        ui.noteColor = val === 'jade' || val === 'gold' || val === 'red' ? val : '';
        $$('.note-color-row .chip').forEach((b) => b.classList.toggle('active', (b.dataset.val || '') === ui.noteColor));
        applyNoteFilter();
        break;
      }
      case 'open-annotation': {
        const a = annotationList(id)[Number(val)];
        if (!a) { toast('笔记已不存在'); break; }
        go('reader/' + id + '/' + a.ch);
        /* focusSearchHit 自带 12 次重试，能等异步分页/正文渲染完再定位到段落 */
        setTimeout(() => focusSearchHit(a.pi), 320);
        break;
      }
      case 'annotation-del-global': {
        const list = annotationList(id).slice(), idx = Number(val), d = list[idx];
        if (!d) break;
        list.splice(idx, 1);
        state.annotations[id] = list; save();
        if (readerRoot.dataset.currentBook === id) refreshHlParas(id, d.ch, d.pi);
        rerender(); toast('已删除笔记');
        break;
      }
    }
    if (el.id === 'readerMask') closePanel();
  });
  document.addEventListener('click', (e) => { if (e.target.id === 'readerMask') { closePanel(); closeReaderSearch(); } });
  /* 划完一段正文才弹「划线 / 批注」；点工具条内部不重新检测，免得把刚选中的清掉 */
  document.addEventListener('pointerup', (e) => {
    if (e.target && e.target.closest && (e.target.closest('#hlPop') || e.target.closest('#hlEdit'))) return;
    const mark = e.target && e.target.closest ? e.target.closest('#readerPaper mark.hl-mark, #flipPage mark.hl-mark') : null;
    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) {
        hideHlPop();
        if (mark) openHlEdit(mark); else hideHlEdit();
        return;
      }
      const pop = $('#hlPop'), txt = String(sel).trim();
      /* 选区没变就别重弹：用户正在批注框里打字，重渲会把输入框收掉 */
      if (pop && !pop.hidden && hlDraft && hlDraft.text === txt) return;
      if ($('#reader')) onReaderSelection();
    }, 20);
  });
  /* 目录过滤：按章名匹配，或直接输入章号。走 DOM hidden、不重建列表，
     输入焦点和滚动位置都稳；上千章也只跑一遍 forEach。 */
  function applyCatalogFilter(input) {
    const el = input || $('#catalogSearch');
    if (!el) return 0;
    const q = el.value.trim().toLowerCase();
    const num = parseInt(q, 10);
    let shown = 0;
    $$('#catalogList li').forEach((li) => {
      const liNum = parseInt(li.dataset.ch, 10);
      /* 只比章名：li 里还挂着「读过 / ✎N / 序号」，混进来会让搜「读」命中一大片 */
      const t = li.querySelector('.cl-title');
      const name = (t ? t.textContent : li.textContent).toLowerCase();
      const hit = !q || name.includes(q) || (!isNaN(num) && liNum === num);
      li.hidden = !hit;
      if (hit) shown += 1;
    });
    /* 一条不剩时把列表整体收起、让空态顶到搜索框下面，否则空列表还占着 flex 高度，
       空态提示会被顶到抽屉最底部 */
    const no = $('#catNoMatch');
    const list = $('#catalogList');
    const empty = !!q && shown === 0;
    if (no) no.hidden = !empty;
    if (list) {
      list.hidden = empty;
      /* 有关键词才回到顶部（结果从第一条看起）；清空搜索时保留原滚动位置 */
      if (q) list.scrollTop = 0;
    }
    return shown;
  }
  document.addEventListener('input', (e) => {
    /* 组词中的拼音串不是搜索词：拿 "guanju" 去过滤会闪一下「没找到」，
       目录里还会把列表整个收起。等上屏（compositionend 后的那次 input）再搜。 */
    if (e.isComposing) return;
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
    if (e.target.id === 'shelfSearch') {
      /* 防抖：停输 120ms 再过滤，避免逐键遍历 83 张卡片 */
      clearTimeout(shelfSearchTimer);
      const v = e.target.value;
      shelfSearchTimer = setTimeout(() => applyShelfSearch(v), 120);
    }
    if (e.target.id === 'noteSearch') {
      clearTimeout(noteSearchTimer);
      const v = e.target.value;
      noteSearchTimer = setTimeout(() => { ui.noteSearch = v; applyNoteFilter(); }, 120);
    }
    if (e.target.id === 'catalogSearch') {
      /* 长篇在线书目录上千条，逐键遍历全部 <li> 会卡，轻量防抖：停输 120ms 才过滤 */
      clearTimeout(catalogSearchTimer);
      const el = e.target;
      catalogSearchTimer = setTimeout(() => applyCatalogFilter(el), 120);
    }
  });
  /* 输入法上屏后补一次过滤：Chrome 会在 compositionend 之后再补一个 input，
     但部分安卓 WebView / 第三方输入法只发 compositionend，不补 input，
     那样输完拼音就再也不会搜了。这里按「框 → 各自的过滤函数」兜一遍。 */
  document.addEventListener('compositionend', (e) => {
    const el = e.target, id = el && el.id;
    if (id === 'searchInput') { clearTimeout(searchTimer); renderSearchBody(el.value); }
    else if (id === 'shelfSearch') { clearTimeout(shelfSearchTimer); applyShelfSearch(el.value); }
    else if (id === 'noteSearch') { clearTimeout(noteSearchTimer); ui.noteSearch = el.value; applyNoteFilter(); }
    else if (id === 'catalogSearch') { clearTimeout(catalogSearchTimer); applyCatalogFilter(el); }
  });
  /* 拖动松手才真正应用，避免播放中每移动一像素就重启朗读 */
  document.addEventListener('change', (e) => {
    if (e.target.matches && e.target.matches('[data-rate-slider]')) applyRate(e.target.value);
    if (e.target.id === 'noteBookFilter') { ui.noteBook = e.target.value; applyNoteFilter(); }
  });
  document.addEventListener('keydown', (e) => {
    /* Alt+←、Ctrl+P 等系统/浏览器组合键一律不抢 */
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    /* 中文输入法组词期间（拼音还没上屏）按键不算数：Enter 是「选字上屏」，
       空格是选词，方向键在候选框里走。这些键要是被当成「直达章节 / 翻页」，
       字打不进去还会被弹到别的章。keyCode 229 是组词中按键的老写法，一并挡掉。 */
    if (e.isComposing || e.keyCode === 229) return;
    /* 模态面板打开时把 Tab 关在里面，别让焦点跑回底下的正文。
       表单类弹窗（快捷键说明等）盖在最上层，优先圈在弹窗里。 */
    if (e.key === 'Tab') {
      const drawer = $('#catalogDrawer'), panel = $('#readerPanel'), sd = $('#searchDrawer');
      const dlg = findOpenModal()
        || (listenFullOpen() ? $('#listen') : null)
        || [drawer, panel, sd].find((el) => el && !el.hidden);
      if (dlg) {
        const f = Array.from(dlg.querySelectorAll(
          'button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'
        )).filter((el) => !el.hidden && el.getClientRects().length);
        if (f.length) {
          const first = f[0], last = f[f.length - 1], cur = document.activeElement;
          if (e.shiftKey && (cur === first || !dlg.contains(cur))) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && (cur === last || !dlg.contains(cur))) { e.preventDefault(); first.focus(); }
        }
      }
    }
    if (e.key === 'Escape') {
      if ($('#shortcutHelp')) { closeShortcutHelp(); return; }
      /* 焦点在藏卷搜索框里时，Esc 只清空搜索，不去动听书或阅读器 */
      const si = $('#shelfSearch');
      if (si && si.value && document.activeElement === si) {
        e.preventDefault(); si.value = ''; applyShelfSearch(''); return;
      }
      const ni = $('#noteSearch');
      if (ni && ni.value && document.activeElement === ni) {
        e.preventDefault(); ni.value = ''; ui.noteSearch = ''; applyNoteFilter(); return;
      }
      /* 目录搜索框里的 Esc 保持「收抽屉」：抽屉是模态面板，用户按 Esc 就是要关掉它 */
      if ($('#hlPop') && !$('#hlPop').hidden) { hideHlPop(); return; }
      if ($('#hlEdit') && !$('#hlEdit').hidden) { hideHlEdit(); return; }
      if (ui.noteMulti) { ui.noteMulti = false; ui.notePicked.clear(); rerender(); return; }
      if (ui.coverDraft) { closeCoverEditor(); return; }
      if (ui.metaDraft) { closeMetaEditor(); return; }
      if ($('#shelfMenu')) { closeShelfMenu(); return; }
      /* 听卷页按 Esc 先收起成迷你条（还在播，能边听边读），
         迷你条上再按才真的停掉——一按 Esc 就断朗读太狠了 */
      if (listen.active) {
        if (listen.expanded) { listen.expanded = false; renderListen(); }
        else listenStopAll();
        return;
      }
      /* 书城 / 藏卷页压根没有 #searchDrawer，不判空会抛 TypeError，
         把整个 keydown 处理器打断，连 ?、Enter、翻页键都一起失效 */
      const sd = $('#searchDrawer');
      if (sd && !sd.hidden) { closeReaderSearch(); return; }
      if (ui.searchNavOn) { closeSearchNav(); return; }
      /* 目录 / 卷签 / 笔记抽屉也算「面板」，Esc 先收它，别一按就退出阅读器 */
      const panel = $('#readerPanel'), drawer = $('#catalogDrawer');
      if ((panel && !panel.hidden) || (drawer && !drawer.hidden)) { closePanel(); return; }
      if (readerRoot.dataset.currentBook) {
        if (history.length > 1) history.back(); else go('book/' + readerRoot.dataset.currentBook);
        return;
      }
    }
    if (e.key === '?' || e.key === 'F1') {
      if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
      e.preventDefault(); openShortcutHelp(); return;
    }
    if ($('#shortcutHelp')) return; /* 说明浮层是模态，开着时吞掉其它键 */
    /* div/li 补成按钮之后，回车与空格还得能真的按下去 */
    const act = document.activeElement;
    if (act && !NATIVE_CTL.test(act.tagName) && act.dataset && act.dataset.action
      && act.getAttribute('role') === 'button' && (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar')) {
      e.preventDefault();
      act.click();
      return;
    }
    /* 目录里搜完按回车直接进第一条命中；先同步跑一遍过滤，别被 120ms 防抖拖住。
       必须放在「阅读器里焦点在输入框就放行」那条之前，否则永远走不到。 */
    if (e.key === 'Enter' && document.activeElement.id === 'catalogSearch') {
      e.preventDefault();
      clearTimeout(catalogSearchTimer);
      applyCatalogFilter(document.activeElement);
      const first = $$('#catalogList li').find((li) => !li.hidden);
      if (first) first.click();
      return;
    }
    /* 听卷页铺满全屏时，键盘先归它：空格播放/暂停，左右切章。
       焦点落在按钮或进度条上时让它们自己处理，别抢。 */
    if (listenFullOpen()) {
      const a0 = document.activeElement;
      const onCtl = !a0 || /BUTTON|A|INPUT|TEXTAREA|SELECT/.test(a0.tagName) || a0.id === 'lpTrack';
      if (!onCtl) {
        if (e.key === ' ') {
          e.preventDefault();
          const p = $('#listenPlay'); if (p) p.click();
          return;
        }
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          const btn = document.querySelector(e.key === 'ArrowLeft' ? '[data-action="listen-prev"]' : '[data-action="listen-next"]');
          if (btn) btn.click();
          return;
        }
      }
    }
    const inReader = !!readerRoot.dataset.currentBook;
    if (inReader && /INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
    if (inReader) {
      const panelOpen = ($('#readerPanel') && !$('#readerPanel').hidden)
        || ($('#catalogDrawer') && !$('#catalogDrawer').hidden);
      if (!panelOpen) {
        const k = (e.key || '').toLowerCase();
        const map = { t: '#ttsBtn', c: '[data-action="reader-catalog"]', s: '[data-action="reader-settings"]', n: '#themeBtn' };
        if (map[k]) {
          const btn = document.querySelector(map[k]);
          if (btn) { e.preventDefault(); btn.click(); }
          return;
        }
      }
      /* 焦点在原生按钮/链接上按空格，浏览器会自己激活它，别顺手再翻一页 */
      if (e.key === ' ' && /BUTTON|A|SELECT|INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
      const paging = state.settings.pageMode === 'flip' && $('#reader');
      /* 上下滚动模式：空格 / PageUp / PageDown / 上下键先滚正文。
         以前这些键不分模式一律「换章」，按一下空格就跳到下一章，读到哪儿全丢了。 */
      const scrollBody = paging ? null : $('#readerBody');
      if (scrollBody) {
        const vh = scrollBody.clientHeight || 600;
        if (e.key === ' ') {
          e.preventDefault();
          scrollReaderBody(scrollBody, (e.shiftKey ? -1 : 1) * Math.round(vh * 0.86), true);
          return;
        }
        if (e.key === 'PageDown' || e.key === 'PageUp') {
          e.preventDefault();
          scrollReaderBody(scrollBody, (e.key === 'PageDown' ? 1 : -1) * Math.round(vh * 0.86), true);
          return;
        }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          scrollReaderBody(scrollBody, (e.key === 'ArrowDown' ? 1 : -1) * 120, false);
          return;
        }
      }
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        paging ? flipBy(-1) : switchChapter(readerRoot.dataset.currentBook, Number(readerRoot.dataset.currentCh) - 1);
      }
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
        paging ? flipBy(1) : switchChapter(readerRoot.dataset.currentBook, Number(readerRoot.dataset.currentCh) + 1);
      }
      return;
    }
    if (!/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
      const nav = { '1': 'store', '2': 'shelf', '3': 'me' }[e.key];
      if (nav) { e.preventDefault(); go(nav); return; }
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
    /* 从详情页退回来时，焦点应该回到刚才点的那张书卡，
       而不是笼统地扔给页面容器（键盘用户得从第一个书卡重新数）。
       注意：必须先 render 再找节点，render 前拿到的 DOM 引用会被整块替换掉。 */
    const backKey = (lastFocus && lastFocus.hash === location.hash) ? lastFocus.key : null;
    render();
    const back = backKey ? resolveFocus(backKey) : null;
    if (back && document.contains(back)) back.focus({ preventScroll: true });
    else if (lost && !$('#reader')) { const v = $('#view'); if (v) v.focus({ preventScroll: true }); }
  });
  /* 记下「哪个路由上的哪个控件刚被聚焦过」：跨页返回时按这个还原 */
  document.addEventListener('focusin', () => {
    const k = restorableFocus();
    if (k) lastFocus = { hash: location.hash, key: k };
  });
  /* 书源：内置源在脚本载入时已同步进索引（首屏即有书）；这里再聚合在线源与自定义源 */
  sourcesReady = restoreCustomSources();
  /* 弹窗是 append/remove 的，盯着 body 的子节点变化来同步 inert 与焦点归还 */
  watchModals();
  render();
  sourcesReady.then(() => {
    renderNav(ui.nav);
    if (!$('#reader')) render();
  }).catch(() => {});
  /* Service Worker 是 skipWaiting + clients.claim：新版本一装好就立刻接管，
     可页面里还跑着旧脚本，不刷新就一直是旧版（修好的 bug 也拿不到）。
     给一条不打扰的提示，让用户自己挑时候更新。 */
  let swReloading = false;
  function showUpdateBar() {
    if ($('#updateBar')) return;
    const busy = listen.active && listen.playing;
    /* 手机宽度放不下长句，窄屏换短文案，宁肯少说也别截成「更新会中断听…」 */
    const narrow = window.innerWidth < 460;
    const text = busy
      ? (narrow ? '听书中 · 更新会中断' : '新版本已备好 · 更新会中断听书')
      : (narrow ? '有新版本可更新' : '新版本已备好');
    const el = document.createElement('div');
    el.id = 'updateBar';
    el.className = 'update-bar';
    el.setAttribute('role', 'status');
    el.innerHTML = `<span>${text}</span>
      <button class="btn btn-sm" data-update="now">立即更新</button>
      <button class="btn btn-ghost btn-sm" data-update="later">稍后</button>`;
    el.addEventListener('click', (e) => {
      const k = e.target.closest('[data-update]');
      if (!k) return;
      if (k.dataset.update === 'now') {
        swReloading = true;
        el.remove();
        location.reload();
      } else {
        el.remove();
      }
    });
    document.body.appendChild(el);
  }
  if ('serviceWorker' in navigator) {
    /* 首次安装也会触发 controllerchange（页面从「没有 SW」变成「有」），
       那种情况不该提示「新版本」——只有原本就有 SW 才算换版。 */
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || swReloading) return;
      showUpdateBar();
    });
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').then((reg) => {
      /* 首屏彻底空下来后再让 SW 补齐 19 本正文，避免和首屏抢带宽 */
      setTimeout(() => {
        if (reg.active) reg.active.postMessage({ type: 'prefetch-shards' });
      }, 5000);
    }).catch(() => {}));
  }
})();
