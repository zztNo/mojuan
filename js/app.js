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
      return cs.length ? cs.map((t, i) => ({ no: i + 1, title: applyS2T(applyClean(t, 'title', b)) }))
        : [{ no: 1, title: '全文' }];
    }
    if (b.chapters && b.chapters.length) {
      /* 阅读规则可只作用标题：目录、翻页、听书都走这里，统一净化 */
      return b.chapters.map((c) => Object.assign({}, c, { title: applyS2T(applyClean(c.title, 'title', b)) }));
    }
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
  /* 导入阅读 App 导出的净化规则 JSON。认 ReplaceRule 字段，也认墨卷自己的
     {pattern,replacement} 数组；旧文本格式每行一条。返回 null 表示无法识别。 */
  function parseReplaceRules(text) {
    let data;
    try { data = JSON.parse(String(text).replace(/^\uFEFF/, '')); }
    catch (e) {
      // 不是 JSON，按文本格式解析：正则 => 替换 / 文本 :: 替换，# 后是标记
      const lines = String(text).split('\n').map((x) => x.trim()).filter(Boolean);
      if (!lines.length) return null;
      const out = [];
      lines.forEach((line) => {
        const hash = line.indexOf('#');
        const body = (hash >= 0 ? line.slice(0, hash) : line).trim();
        const meta = hash >= 0 ? line.slice(hash + 1) : '';
        const plain = body.indexOf('::') >= 0;
        const parts = plain ? body.split(/\s*::\s*/) : body.split(/\s*(?:=>|==>)\s*/);
        const pattern = (parts[0] || '').trim();
        if (!pattern) return;
        if (!plain) { try { new RegExp(pattern); } catch (e2) { return; } }
        const r = {
          name: '', group: '', pattern, replacement: parts.slice(1).join(plain ? '::' : '=>'),
          isRegex: !plain, isEnabled: meta.indexOf('停用') < 0,
          scopeContent: true, scopeTitle: meta.indexOf('标题') >= 0,
          scope: '', excludeScope: '', flags: 'g'
        };
        const g = meta.match(/组:(\S+)/), sc = meta.match(/源:(\S+)/), ex = meta.match(/排除:(\S+)/);
        if (g) r.group = g[1];
        if (sc) r.scope = sc[1];
        if (ex) r.excludeScope = ex[1];
        out.push(r);
      });
      return out.length ? out : null;
    }
    const arr = Array.isArray(data) ? data
      : (data && Array.isArray(data.replaceRules) ? data.replaceRules
        : (data && Array.isArray(data.rules) ? data.rules : []));
    if (!arr.length) return null;
    return arr.filter((r) => r && typeof r === 'object' && r.pattern).map((r) => ({
      name: String(r.name || ''), group: String(r.group || ''),
      pattern: String(r.pattern), replacement: String(r.replacement || ''),
      isRegex: r.isRegex !== false, isEnabled: r.isEnabled !== false,
      scope: String(r.scope || ''), excludeScope: String(r.excludeScope || ''),
      scopeTitle: r.scopeTitle === true, scopeContent: r.scopeContent !== false,
      flags: r.flags || 'g', order: Number(r.order) || 0
    }));
  }

  /* 内容净化：兼容阅读 App 的替换规则（ReplaceRule）核心字段。
     pattern/replacement + isRegex（false 为纯文本）+ scope（限定书源）+
     scopeTitle/scopeContent（作用标题/正文）+ isEnabled + group。
     旧的纯文本格式「正则 => 替换」在导入时转成对象，这里只认对象。 */
  function ruleMatchesScope(r, b) {
    const source = b ? String(b.sourceId || b.id || '') : '';
    const srcName = b && b.sourceId ? String((SRC.get(b.sourceId) || {}).name || '') : '';
    const inList = (field) => {
      const raw = r[field];
      if (!raw) return false;
      const names = String(raw).split(/[,，]/).map((x) => x.trim()).filter(Boolean);
      return names.some((n) => source === n || srcName === n);
    };
    if (r.scope && !inList('scope')) return false;
    if (r.excludeScope && inList('excludeScope')) return false;
    return true;
  }
  function applyClean(text, kind, b) {
    if (!text) return text;
    const rules = state.settings.cleanRules || [];
    let s = String(text);
    rules.forEach((r) => {
      if (!r || !r.pattern || r.isEnabled === false || !ruleMatchesScope(r, b)) return;
      if (kind === 'title' && r.scopeTitle === false) return;
      if (kind === 'content' && r.scopeContent === false) return;
      const rep = r.replacement || '';
      try {
        if (r.isRegex === false) {
          // 纯文本：split/join 不会把 . * ( ) 当正则元字符
          s = s.split(r.pattern).join(rep);
        } else {
          s = s.replace(new RegExp(r.pattern, r.flags || 'g'), rep);
        }
      } catch (e) { /* 写错的规则跳过，不影响阅读 */ }
    });
    return s;
  }
  /* 简繁转换：在净化之后做，正文与章节标题都走这里 */
  function applyS2T(text) {
    return state.settings.s2t && globalThis.MJ_S2T && typeof MJ_S2T.convert === 'function'
      ? MJ_S2T.convert(text) : text;
  }
  /* 正文段落：跳过占位提示与「本章完」，免得把错误提示洗掉或抹掉章末标记 */
  function cleanParagraphs(paras, b) {
    const rules = (state.settings.cleanRules || []);
    const s2t = state.settings.s2t && globalThis.MJ_S2T;
    if (!rules.length && !s2t) return paras;
    return paras.map((t) => {
      if (!t || /^（(这一章暂未取到|本章内容未能读取)/.test(t) || t.indexOf('（本章完') === 0) return t;
      const s = applyS2T(applyClean(t, 'content', b));
      return s.trim() || t;
    });
  }
  function paragraphs(b, idx) {
    const cleaned = (arr) => cleanParagraphs(arr, b);
    if (b.local) {
      const rec = contentCache[b.id];
      const c = rec && rec.chapters && rec.chapters[idx];
      return cleaned(c && c.paras && c.paras.length ? c.paras : ['本章内容未能读取，请重新导入这卷。']);
    }
    /* 内置源直接同步取；在线源走预取缓存 */
    const sync = SRC.getChapterSync(b.id, idx + 1);
    if (sync && sync.length) return cleaned(sync);
    const rec = contentCache[b.id];
    const c = rec && rec.chapters && rec.chapters[idx];
    if (c && c.paras && c.paras.length) return cleaned(c.paras);
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
  /* 书源取不到正文时可能返回一句占位提示而不是抛错。这类字符串绝不能当成功
     正文落库：否则冷却阶梯不触发、联网后也永不重取，用户会一直看着那句提示。 */
  const CHAPTER_RETRYABLE_RE = /^（?(需要联网|这一章没取回来|这一章暂未取到|本章内容未能读取)/;
  function isRetryablePlaceholder(paras) {
    return !!(paras && paras.length === 1 && CHAPTER_RETRYABLE_RE.test(String(paras[0] || '').trim()));
  }
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
        if (isRetryablePlaceholder(paras)) {
          /* 按失败记，走冷却阶梯：联网后或点「重新取回」才会再发一次请求 */
          const attempts = Math.min(CHAPTER_BACKOFF.length - 1, ((prev && prev.attempts) || 0) + 1);
          rec.chapters[no - 1] = {
            title: '', paras: null, error: '章节未取回',
            attempts, retryAt: Date.now() + CHAPTER_BACKOFF[attempts]
          };
        } else if (paras && paras.length) {
          rec.chapters[no - 1] = { title: '', paras: paras };
        }
        /* 在线源可能在这一步才拿到真实章节目录，回写到索引 */
        const meta = SRC.getBook(b.id);
        if (meta && meta.chapters && meta.chapters.length <= 1 && paras && paras.length
            && !isRetryablePlaceholder(paras)) {
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
    /* 漫画卷：下一图提前解码，翻页时不白屏 */
    if (b && b.kind === 'comic') {
      const imgs = (contentCache[b.id] || {}).images || [];
      const next = imgs[Number(ch)];
      if (next) { const im = new Image(); im.src = next; }
      return;
    }
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

  /* 本地卷去重指纹：只用元数据，老备份里没有 fingerprint 的卷也能按同样规则重算。
     正文不进指纹——同一个文件重导字数一致，不同版本字数/章名通常不同。 */
  function localFingerprint(title, author, words, chapterTitles) {
    return [title, author, words, (chapterTitles || []).length,
      String((chapterTitles || [])[0] || '')].join('\u0001');
  }

  /* 导入本地 TXT / EPUB / HTML */
  async function importFiles(fileList) {
    if (importing) { toast('正在导入，请稍候'); return; }
    const files = Array.from(fileList || []).filter((f) => f && f.size > 0 && f.size <= 30 * 1024 * 1024);
    if (!files.length) { toast('请选择 TXT / EPUB / HTML 文件（单卷不超过 30MB）'); return; }
    importing = true;
    let lastId = null, ok = 0, weakSave = 0, duplicate = 0;
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
        /* 重复拖同一个文件不该堆出几本一模一样的卷：每本都带完整正文副本写进
           IndexedDB，重试几次就把配额吃掉。用书名+作者+字数+章数+首章名做指纹，
           对老备份里没有 fingerprint 字段的卷也能按同样规则重算比对。 */
        const words = chars >= 10000 ? (chars / 10000).toFixed(1) + '万' : chars + '字';
        const dupKey = localFingerprint(bookTitle, bookAuthor, words, chapters.map((c) => c.title));
        const dup = (state.localBooks || []).find((old) => old.local
          && (old.fingerprint || localFingerprint(old.title, old.author, old.words, old.chapters || [])) === dupKey);
        if (dup) {
          duplicate += 1;
          toast('《' + bookTitle + '》已在藏卷里，这次跳过了');
          continue;
        }
        const meta = {
          fingerprint: dupKey,
          id, local: true, title: bookTitle, author: bookAuthor,
          category: '本地', status: '本地', tags: ['本地导入', (r.ext || 'txt').toUpperCase()],
          words,
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
        (duplicate ? ' · 跳过 ' + duplicate + ' 本重复' : '') +
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
    settings: { theme: 'day', fs: 19, lh: 2, paraGap: 1.1, indent: true, paper: 'xuan', lastDayPaper: 'xuan', font: 'song', chapterFont: '', underlineWidth: 1, cleanRules: [], s2t: false, pageMode: 'flip', flipAnim: 'realistic', columns: 'auto', rate: 1, voiceURI: '', voice2URI: '' },
    /* 只记真实开卷记录：hist 存最近 30 天的开卷日期，streak 为连续天数。
     * 旧版这里有 coins（墨币），没有消耗场景，已去掉。 */
    checkin: { last: '', days: 0, streak: 0, hist: [] },
    history: [],
    seconds: 0,
    readLog: {},
    /* 阅读事件流：每次翻章记一条 {t, id, ch}，用于时间轴。最多留 500 条。 */
    readEvents: [],
    dailyGoal: 30,
    viewMode: 'grid', density: 'cozy',
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
    bookTags: {},
    /* 整本书的备注（区别于某一段的划线批注） */
    bookNotes: {},
    /* 订阅源：用户自己填的网页列表规则，只用于公版 / 开放获取 / 自有资源 */
    subscriptions: [],
    subRead: {},
    /* 自定义书单：用户自己命名的书 grouping */
    lists: [],
    /* WebDAV 备份配置：密码存在本机浏览器里，请勿在公用设备使用 */
    webdav: { url: '', user: '', pass: '' },
    /* 本地代理地址：配合 tools/local_server.py，让书源能取回跨域网页 */
    proxyUrl: ''
  };
  let state = load();
  /* 本地代理：启动时把配置同步给解析工具箱，让书源/订阅请求能走它 */
  if (globalThis.MJ && MJ.sourceKit) MJ.sourceKit.setProxy(state.proxyUrl);
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
        bookNotes: Object.assign({}, DEFAULTS.bookNotes, (raw || {}).bookNotes || {}),
        listenPos: Object.assign({}, DEFAULTS.listenPos, (raw || {}).listenPos || {}),
        pinned: Array.isArray((raw || {}).pinned) ? raw.pinned : [],
        subscriptions: Array.isArray((raw || {}).subscriptions) ? raw.subscriptions : [],
        subRead: Object.assign({}, DEFAULTS.subRead, (raw || {}).subRead || {}),
        lists: Array.isArray((raw || {}).lists) ? raw.lists : [],
        webdav: Object.assign({}, DEFAULTS.webdav, (raw || {}).webdav || {}),
        proxyUrl: String((raw || {}).proxyUrl || ''),
        readLog: Object.assign({}, DEFAULTS.readLog, (raw || {}).readLog || {}),
        readEvents: Array.isArray((raw || {}).readEvents) ? raw.readEvents.slice(-500) : []
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
    if (globalThis.MJ && MJ.sourceKit) MJ.sourceKit.setProxy(state.proxyUrl);
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
    noteMulti: false, notePicked: new Set(), noteLimit: 200, paraGroup: 0,
    autoPage: false, autoPageMs: 6000,
    searchHits: [], searchIdx: -1, searchNavOn: false, searchBook: '',
    bmNote: -1, panelFrom: null, searchFrom: null, modalFrom: null,
    tocLoading: false, tocFailed: false, tocOffline: false, storageFull: false,
    srcHealth: {}, srcChecking: false, comicPer: 1
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
      /* <ul> 的直接子元素只能是 listitem：给 li 套 role=button 会让读屏把
         整组目录从列表里摘掉，axe 也报 aria-allowed-role + list 两条违规。
         书卡这类容器里还嵌着原生「收下」按钮，自己再当 role=button 就成了
         嵌套交互（axe 报 124 处），读屏用户按 Tab 会撞上两个重叠的按钮。
         这两种都只补 tabindex、不加 role，键盘 Enter/空格靠下面的分派照常工作。 */
      const hasFocusableChild = !!el.querySelector('button, a, input, select, textarea, [tabindex]');
      if (!el.hasAttribute('role') && el.tagName !== 'LI' && !hasFocusableChild) {
        el.setAttribute('role', 'button');
      }
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
    /* 只放行「合法前缀 + 纯 base64 字符」：原正则只校验开头，后面能拼 ' 闭合
       background-image:url('...') 注入 CSS。base64 不含引号，整串白名单即可。 */
    const pic = o.image && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(o.image) ? o.image : null;
    const art = pic
      ? `<div class="cover-photo" style="background-image:url('${pic}')"></div>`
      : D.motifSvg(o.motif || b.motif, o.color || b.color, o.color2 || b.color2, uid);
    const text = o.hideText ? '' : `<div class="cover-mark">墨卷藏书</div>
      <div class="cover-title${tcls}">${esc(b.title)}</div>
      <div class="cover-author">${esc(b.author)}</div>
      <div class="cover-seal">${esc(o.seal || b.seal)}</div>`;
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
  const SOURCE_SKELETON = `/* 这是示例骨架，直接保存只会得到一本取不到正文的空壳书。
   请把 id/name、metas 里的书目、getChapter 的请求地址都换成你自己的。
   如果只是想接一个网页书单，用「添加书源（可视化）」填地址与选择器即可。 */
MJ.sources.register({
  id: 'my-source',
  name: '我的书源',
  desc: '一句话说明这个书源',
  online: true,
  async metas() {
    // 返回书目元数据数组，可在这里请求你自己的接口
    return [{
      id: 'my-1', title: '书名', author: '作者', category: '文集', status: '自定义',
      desc: '简介', words: '1.0万', score: 9.0, readers: '本机',
      tags: ['自定义'], chapters: [{ no: 1, title: '全文' }]
    }];
  },
  async getChapter(id, no) {
    const text = await fetch('https://example.com/book/' + encodeURIComponent(id)).then(r => r.text());
    return text.split('\\n').map(s => s.trim()).filter(Boolean);
  }
});`;
  /* 漫画卷：把用户自己的图片合成一卷，图片存 IndexedDB，不上传、不抓取。 */
  async function importComicFiles(fileList) {
    if (importing) { toast('正在导入，请稍候'); return; }
    const files = Array.from(fileList || []).filter((f) => f && /^image\//i.test(f.type) && f.size > 0);
    if (!files.length) { toast('请选择 JPG / PNG / WebP 图片'); return; }
    importing = true;
    try {
      toast('正在整理图片…（0 / ' + files.length + '）');
      const r = await MJ.importer.parseImages(files, (i, n) => {
        if (i % 5 === 0 || i === n) toast('正在压缩图片…（' + i + ' / ' + n + '）');
      });
      const now = Date.now();
      const id = 'local-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 7);
      const base = (files[0].name.replace(/\.[^.]+$/, '') || '图片卷').slice(0, 20);
      const cleanMeta = (v) => String(v || '').replace(/[<>&]/g,
        (c) => ({ '<': '〈', '>': '〉', '&': '＆' }[c]));
      const title = cleanMeta(base) || '我的图片卷';
      /* 章节标题用「第 N 图」，正文放一个占位段；阅读器识别 kind 后改画图片 */
      /* paragraphs() 对 local 书取 rec.chapters[idx].paras，所以每章都要带 paras */
      const chapters = r.images.map((_, i) => ({
        title: '第 ' + (i + 1) + ' 图', paras: ['（漫画页）']
      }));
      const pal = LOCAL_COLORS[(state.localBooks || []).length % LOCAL_COLORS.length];
      const meta = {
        id, local: true, kind: 'comic', title, author: '我的图片',
        category: '漫画', status: '本地', tags: ['本地导入', '图片'],
        words: r.count + ' 图', score: 9, readers: '本机', hot: 60,
        motif: LOCAL_MOTIFS[0], color: pal[0], color2: pal[1],
        seal: title.charAt(0), desc: '由 ' + r.count + ' 张本地图片组成，内容只存在这台设备上。',
        chapters: chapters.map((c) => c.title), addedAt: now
      };
      await saveContent(id, { id, kind: 'comic', chapters, images: r.images });
      contentCache[id] = { id, kind: 'comic', chapters, images: r.images };
      state.localBooks = state.localBooks || [];
      state.localBooks.unshift(meta);
      if (!state.shelf.includes(id)) state.shelf.unshift(id);
      state.progress[id] = { ch: 1, pct: 0, updated: now };
      /* 第一张当封面，压缩过的 dataURL 已经是小图 */
      state.covers[id] = { image: r.images[0] }; markCoversDirty();
      save(); renderNav(ui.nav);
      toast('已导入《' + title + '》· ' + r.count + ' 张图片');
      go('book/' + id);
    } catch (e) {
      toast('图片导入失败：' + (e && e.message ? e.message : '未知错误'));
    } finally { importing = false; }
  }

  /* ---------- 单卷墨卷包（.mjz） ----------
     整库备份适合「整台设备搬走」，但常见的需求是「把这一卷发给朋友」
     或「只把这一卷搬到平板」。墨卷包只装一卷：正文、漫画图、划线批注、
     卷签、整卷备注一起带走；导入时重新生成 id，不动原有藏书。 */
  const VOLUME_APP = 'mojuan-volume', VOLUME_VER = 1;
  const VOLUME_MAX = 80 * 1024 * 1024;

  function volumeFileName(title) {
    const base = String(title || '墨卷').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) || '墨卷';
    return base + '.mjz';
  }

  async function exportVolume(id) {
    const b = getBook(id);
    if (!b || !b.local) { toast('只有本地导入的卷能导出成墨卷包'); return; }
    let rec = contentCache[id];
    if (!rec || !rec.chapters) rec = await loadContent(id);
    if (!rec || !rec.chapters || !rec.chapters.length) { toast('这一卷的正文不在本机，无法导出'); return; }
    const comic = b.kind === 'comic' || rec.kind === 'comic';
    const payload = {
      app: VOLUME_APP, version: VOLUME_VER, exportedAt: new Date().toISOString(),
      book: {
        title: b.title, author: b.author, desc: b.desc || '', kind: comic ? 'comic' : 'text',
        words: b.words || '', category: b.category || '', tags: b.tags || [],
        seal: b.seal || '', color: b.color || '', color2: b.color2 || '', motif: b.motif || '',
        cover: (state.covers[id] || {}).image || ''
      },
      chapters: rec.chapters.map((c) => ({ title: c.title, paras: c.paras || [] })),
      images: comic ? (rec.images || []) : [],
      notes: {
        annotations: annotationList(id), bookmarks: bookmarkList(id),
        bookNote: (state.bookNotes || {})[id] || ''
      }
    };
    let json;
    try { json = JSON.stringify(payload); }
    catch (e) { toast('打包失败：这一卷内容过大'); return; }
    /* 图片卷动辄几十兆：先量再写，别让浏览器在 stringify 之后就卡死 */
    if (json.length > VOLUME_MAX) { toast('这一卷超过 80MB，请改用完整备份'); return; }
    const ok = downloadText(volumeFileName(b.title), [json]);
    const noteN = payload.notes.annotations.length + payload.notes.bookmarks.length;
    toast(ok
      ? '已导出《' + b.title + '》' + (noteN ? ' · 含 ' + noteN + ' 条笔记与卷签' : '')
      : '导出失败，请检查下载权限');
  }

  /* 解析墨卷包：任何字段都当作不可信输入，逐项裁剪，坏章直接丢 */
  function parseVolumePack(data) {
    if (!data || data.app !== VOLUME_APP) return null;
    if (Number(data.version) > VOLUME_VER) throw new Error('这个墨卷包来自更新的墨卷，请先升级');
    const book = (data.book && typeof data.book === 'object') ? data.book : {};
    const chapters = (Array.isArray(data.chapters) ? data.chapters : []).map((c) => ({
      title: String((c && c.title) || '').slice(0, 60),
      paras: (Array.isArray(c && c.paras) ? c.paras : []).map((p) => String(p)).filter(Boolean)
    })).filter((c) => c.paras.length);
    if (!chapters.length) throw new Error('包里的正文是空的');
    const images = book.kind === 'comic' && Array.isArray(data.images)
      ? data.images.filter((s) => typeof s === 'string' && s.indexOf('data:image/') === 0)
      : [];
    return { book, chapters, images, notes: (data.notes && typeof data.notes === 'object') ? data.notes : {} };
  }

  async function importVolumePack(data) {
    const pack = parseVolumePack(data);
    if (!pack) return false;
    const { book, chapters, images, notes } = pack;
    const cleanMeta = (v) => String(v || '').replace(/[<>&]/g,
      (c) => ({ '<': '〈', '>': '〉', '&': '＆' }[c]));
    const title = cleanMeta(book.title) || '未命名墨卷';
    const author = cleanMeta(book.author) || '本地导入';
    const chars = chapters.reduce((a, c) => a + c.paras.join('').length, 0);
    const words = images.length ? images.length + ' 图'
      : (chars >= 10000 ? (chars / 10000).toFixed(1) + '万' : chars + '字');
    /* 和 TXT / EPUB 导入共用同一套指纹：手滑导两次不会堆出两本一样的卷 */
    const dupKey = localFingerprint(title, author, words, chapters.map((c) => c.title));
    const dup = (state.localBooks || []).find((old) => old.local
      && (old.fingerprint || localFingerprint(old.title, old.author, old.words, old.chapters || [])) === dupKey);
    if (dup) { toast('《' + title + '》已在藏卷里，这次跳过了'); return true; }
    const now = Date.now();
    const id = 'local-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 7);
    const pal = LOCAL_COLORS[(state.localBooks || []).length % LOCAL_COLORS.length];
    const rec = { id, chapters };
    if (images.length) { rec.kind = 'comic'; rec.images = images; }
    await saveContent(id, rec);
    contentCache[id] = rec; cacheTouch(id);
    const meta = {
      fingerprint: dupKey, id, local: true, title, author,
      category: cleanMeta(book.category) || (images.length ? '漫画' : '本地'),
      status: '本地',
      tags: Array.isArray(book.tags) ? book.tags.map((t) => cleanMeta(t)).filter(Boolean).slice(0, 4) : ['本地导入'],
      words, score: 9.0, readers: '本地卷', hot: 60,
      motif: book.motif || LOCAL_MOTIFS[0], color: book.color || pal[0], color2: book.color2 || pal[1],
      seal: cleanMeta(book.seal) || title.replace(/[《》\s]/g, '').charAt(0) || '卷',
      desc: cleanMeta(book.desc) || ('由墨卷包导入，共 ' + chapters.length + (images.length ? ' 图。' : ' 章。')),
      chapters: chapters.map((c) => c.title), addedAt: now
    };
    if (images.length) meta.kind = 'comic';
    state.localBooks.unshift(meta);
    if (!state.shelf.includes(id)) state.shelf.unshift(id);
    state.progress[id] = { ch: 1, pct: 0, updated: now };
    const cover = (typeof book.cover === 'string' && book.cover.indexOf('data:image/') === 0)
      ? book.cover : (images[0] || null);
    if (cover) { state.covers[id] = { image: cover }; markCoversDirty(); }
    /* 笔记随卷走：换了设备也要看得见自己划过的句子、写过的想法 */
    const anns = Array.isArray(notes.annotations) ? notes.annotations.filter((a) => a && typeof a.text === 'string') : [];
    if (anns.length) {
      state.annotations[id] = anns.slice(0, 5000).map((a) => ({
        ch: Number(a.ch) || 1, pi: Number(a.pi) || 0, text: String(a.text),
        note: String(a.note || ''), color: ['red', 'jade', 'gold'].includes(a.color) ? a.color : 'red',
        time: Number(a.time) || now
      }));
    }
    const bms = Array.isArray(notes.bookmarks) ? notes.bookmarks.filter((m) => m && m.title) : [];
    if (bms.length) {
      state.bookmarks[id] = bms.slice(0, 500).map((m) => ({
        title: String(m.title), ch: Number(m.ch) || 1, page: Number(m.page) || 0,
        time: Number(m.time) || now, note: String(m.note || '')
      }));
    }
    if (notes.bookNote) state.bookNotes[id] = String(notes.bookNote).slice(0, 4000);
    save(); renderNav(ui.nav);
    const noteN = (anns.length + bms.length);
    toast('已导入《' + title + '》' + (images.length ? ' · ' + images.length + ' 图' : ' · ' + chapters.length + ' 章')
      + (noteN ? ' · 附 ' + noteN + ' 条笔记' : ''));
    go('book/' + id);
    return true;
  }

  /* 导入入口统一走这里：.mjz / .json 先试着当墨卷包，其余交给 TXT / EPUB / HTML 流程 */
  async function handleImportFiles(list) {
    const files = Array.from(list || []);
    const packs = files.filter((f) => /\.(mjz|json)$/i.test(f.name || ''));
    const others = files.filter((f) => packs.indexOf(f) < 0);
    for (const f of packs) {
      if (f.size > VOLUME_MAX) { toast('《' + f.name + '》超过 80MB，未导入'); continue; }
      try {
        let data = null;
        try { data = JSON.parse(await f.text()); } catch (e) { data = null; }
        if (data && data.app === VOLUME_APP) { await importVolumePack(data); continue; }
        toast('《' + f.name + '》不是墨卷包');
      } catch (err) {
        toast('《' + f.name + '》读取失败：' + (err && err.message ? err.message : '格式不对'));
      }
    }
    if (others.length) importFiles(others);
  }

  /* A2 配套：把当前所有自定义书源导出成 JSON，便于备份 / 分享 / 换机迁移。 */
  function exportSources() {
    const list = customSources();
    if (!list.length) { toast('还没有自定义书源可导出'); return; }
    const payload = { app: 'mojuan-sources', version: 1, exportedAt: new Date().toISOString(), sources: list };
    const ok = downloadText('墨卷书源-' + today() + '.json', JSON.stringify(payload, null, 2));
    toast(ok ? '已导出 ' + list.length + ' 个书源' : '导出失败，请检查下载权限');
  }

  /* ---------- 书源可用性检测 ---------- */
  /* 只测可视化书源：它们有确定的目录地址，拉一次书单就知道通不通。
     内置源（公版 / 维基文库）不是「挂没挂」的问题，标成「内置」更诚实；
     探测失败最常见的两种是超时和 CORS，错误串裁短后再显示，别让一行字撑破版。 */
  function shortErr(e) {
    const m = String((e && (e.message || e.name)) || e || '未知错误');
    if (/abort/i.test(m)) return '超时';
    if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return '取不到（跨域被拦或断网）';
    return m.length > 22 ? m.slice(0, 22) + '…' : m;
  }
  async function probeSource(s) {
    if (!s._cfg || !s._cfg.listUrl) return { skip: true, msg: '内置源' };
    const t0 = (window.performance && performance.now()) || Date.now();
    const ms = () => Math.round((((window.performance && performance.now()) || Date.now()) - t0));
    try {
      const list = await s.metas();
      const n = Array.isArray(list) ? list.length : 0;
      /* 卷数前面那行「现有 N 卷」已经报过了，这里只说「通没通、多快」 */
      return n ? { ok: true, msg: '通 · ' + ms() + 'ms' } : { ok: false, msg: '目录为空' };
    } catch (e) {
      return { ok: false, msg: shortErr(e) };
    }
  }
  /* 并发 3：再多就容易把本地代理和对方站点一起打挂，也更像在压测别人 */
  async function checkSources() {
    if (ui.srcChecking) return;
    const targets = (SRC.list() || []).filter((s) => s.enabled !== false && s._cfg && s._cfg.listUrl);
    if (!targets.length) { toast('没有可检测的在线书源：内置源无需检测'); return; }
    ui.srcChecking = true;
    ui.srcHealth = {};
    paintHealth();
    let i = 0;
    const worker = async () => {
      while (i < targets.length) {
        const s = targets[i++];
        ui.srcHealth[s.id] = await probeSource(s);
        paintHealth();
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    ui.srcChecking = false;
    paintHealth();
    const okN = targets.filter((s) => (ui.srcHealth[s.id] || {}).ok).length;
    toast('检测完成：' + okN + ' / ' + targets.length + ' 个书源可用');
  }
  /* 直接改已有 DOM，不 rerender：检测过程中整页重建会把滚动位置和焦点甩掉 */
  function paintHealth() {
    $$('[data-health-for]').forEach((el) => {
      const h = (ui.srcHealth || {})[el.dataset.healthFor];
      if (!h || h.skip) { el.hidden = true; el.textContent = ''; return; }
      el.hidden = false;
      el.className = 'src-health ' + (h.ok ? 'ok' : 'bad');
      el.textContent = (h.ok ? '✓ ' : '✕ ') + h.msg;
    });
    const hint = $('#srcCheckHint');
    if (!hint) return;
    const done = Object.keys(ui.srcHealth || {}).length;
    hint.textContent = ui.srcChecking
      ? '正在检测…（已完成 ' + done + ' 个）'
      : done ? '已测 ' + done + ' 个 · 再点可重测' : '逐个拉一次目录，看哪个源挂了';
  }

  /* 解析导入的书源 JSON：认墨卷自己的导出格式、纯配置数组 / 单个配置。
     legado 原生书源规则依赖 App 宿主 API，浏览器跑不了，明确提示而不假装支持。 */
  function parseSourceImport(text) {
    let data;
    try { data = JSON.parse(String(text).replace(/^\uFEFF/, '')); }
    catch (e) { throw new Error('不是有效的 JSON 文件'); }
    const arr = Array.isArray(data) ? data
      : (data && Array.isArray(data.sources) ? data.sources
        : (data && typeof data === 'object' ? [data] : []));
    if (!arr.length) throw new Error('文件里没有书源配置');
    const CFG_KEYS = ['listUrl', 'bookList', 'bookTitle', 'bookLink', 'chapterList', 'content', 'ruleArticles'];
    const visual = arr.filter((x) => x && typeof x === 'object' && CFG_KEYS.some((k) => k in x));
    if (visual.length && visual.length === arr.length) {
      return visual.map((c) => ({
        id: String(c.id || '').trim(), name: String(c.name || '').trim(),
        group: String(c.group || ''), desc: String(c.desc || '导入的书源'),
        listUrl: String(c.listUrl || ''), bookList: String(c.bookList || ''),
        bookTitle: String(c.bookTitle || ''), bookLink: String(c.bookLink || ''),
        chapterList: String(c.chapterList || ''), content: String(c.content || ''),
        defaultAuthor: String(c.defaultAuthor || ''), replaceRegex: String(c.replaceRegex || ''),
        ruleArticles: String(c.ruleArticles || ''), ruleTitle: String(c.ruleTitle || ''),
        ruleLink: String(c.ruleLink || ''), url: String(c.url || '')
      }));
    }
    if (arr.some((x) => x && (x.bookSourceName || x.ruleSearch || x.bookSourceUrl))) {
      throw new Error('这是阅读 App 的规则书源，依赖 App 内置脚本环境，浏览器里无法运行；请用「可视化」方式自己配地址与选择器');
    }
    throw new Error('没有识别到墨卷书源配置（需要含 listUrl / bookList / content 等字段）');
  }

  function customSources() {
    try { return JSON.parse(localStorage.getItem(CUSTOM_SRC_KEY) || '[]'); } catch (e) { return []; }
  }
  function saveCustomSources(list) {
    try { localStorage.setItem(CUSTOM_SRC_KEY, JSON.stringify(list)); } catch (e) { /* 忽略 */ }
  }

  async function importSourceJson(file) {
    let cfgs;
    try {
      const txt = await file.text();
      cfgs = parseSourceImport(txt);
    } catch (e) { toast('书源导入失败：' + (e.message || '格式不对')); return; }
    let nBook = 0, nSub = 0, bad = 0;
    const codes = customSources();
    for (const c of cfgs) {
      /* 订阅源配置：有 url + ruleArticles，没有 listUrl */
      if (c.url && c.ruleArticles && !c.listUrl) {
        if (!c.id || !c.name) { bad += 1; continue; }
        state.subscriptions = state.subscriptions || [];
        const i = state.subscriptions.findIndex((s) => s.id === c.id);
        const sub = { id: c.id, name: c.name, url: c.url, ruleArticles: c.ruleArticles, enabled: true };
        if (c.ruleTitle) sub.ruleTitle = c.ruleTitle;
        if (c.ruleLink) sub.ruleLink = c.ruleLink;
        if (i >= 0) state.subscriptions[i] = Object.assign({}, state.subscriptions[i], sub);
        else state.subscriptions.push(sub);
        nSub += 1;
        continue;
      }
      /* 书籍书源：必须有 id / name / listUrl */
      if (!c.id || !c.name || !c.listUrl) { bad += 1; continue; }
      if (!/^[a-zA-Z0-9_-]+$/.test(c.id)) {
        c.id = 'src-' + c.id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'src-' + Date.now().toString(36);
      }
      const code = '/* mj-visual:' + c.id + ' */MJ.sources.register(MJ.sourceKit.makeSource('
        + JSON.stringify(c) + '));';
      const r = runSourceCodeSafe(code);
      if (r.err) { bad += 1; continue; }
      const mark = '/* mj-visual:' + c.id + ' */';
      const at = codes.findIndex((x) => x.indexOf(mark) === 0);
      if (at >= 0) codes[at] = code; else codes.push(code);
      nBook += 1;
    }
    saveCustomSources(codes);
    save();
    await SRC.refresh();
    renderNav(ui.nav); rerender();
    toast('书源导入完成：' + nBook + ' 个书源' + (nSub ? ' · ' + nSub + ' 个订阅' : '')
      + (bad ? ' · ' + bad + ' 个跳过（缺字段）' : ''));
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
  /* 自定义书源是用户粘进来的任意 JS：执行到一半抛错时，前面成功的 register
     已经改了全局注册表（带 metasSync 还会顺带污染 index）。原先只在调用处
     catch 一句 toast，幽灵源就留在会话里、磁盘上却什么都没有。这里把
     「执行 + 出错回滚」包成事务，保存与启动恢复走同一条路径。 */
  function runSourceCodeSafe(code) {
    const before = SRC.list().slice();
    try { runSourceCode(code); }
    catch (e) {
      const keep = new Set(before.map((s) => s.id));
      SRC.list().forEach((s) => { if (!keep.has(s.id)) SRC.unregister(s.id); });
      /* 覆盖过的旧 id 换回原来的对象；register 对已存在 id 只 set，不改 order */
      before.forEach((s) => SRC.register(s));
      return { err: e, before, after: null };
    }
    return { err: null, before, after: SRC.list() };
  }
  async function restoreCustomSources() {
    const all = customSources(), good = [];
    all.forEach((code) => {
      /* 老备份里可能混进非字符串的占位记录，别当代码执行、更别顺手删掉 */
      if (typeof code !== 'string') { good.push(code); return; }
      const r = runSourceCodeSafe(code);
      if (r.err) console.warn('[sources] 自定义书源载入失败，已回滚', r.err);
      else good.push(code);
    });
    /* 坏代码一次载入失败就会次次失败，直接从列表剔掉，别每次启动都重演一遍 */
    if (good.length !== all.length) saveCustomSources(good);
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
  /* A2：可视化书源配置。不预置任何站点，只让用户填地址与选择器。
     保存时生成调用 MJ.sourceKit 的标准插件代码，复用原有的注册 / 回滚 / 备份链路。 */
  function openSourceForm(editId) {
    const old = editId ? SRC.get(editId) : null;
    const c = (old && old._cfg) || {};
    let root = $('#sourceModal');
    if (!root) { root = document.createElement('div'); root.id = 'sourceModal'; document.body.appendChild(root); }
    const f = (id, label, val, hint, ph) => `<label>${label}<input id="${id}" value="${esc(val || '')}" placeholder="${esc(ph || '')}" spellcheck="false"></label>${hint ? `<p class="mm-hint">${hint}</p>` : ''}`;
    root.innerHTML = `<div class="modal-backdrop" data-action="source-close"></div>
      <div class="cover-editor mini-modal source-form">
        <div class="ce-head"><h3>${editId ? '编辑书源' : '添加书源（可视化）'}</h3>
          <button class="icon-btn" data-action="source-close" title="关闭">${icon('close')}</button></div>
        <div class="mm-body">
          <label>公版站点模板（可选，点选后填入示例地址与选择器，仍需你自行验证）
            <select id="sfTemplate"><option value="">— 自定义 —</option>
              <option value="gutenberg">古登堡计划（英文公版）</option>
              <option value="wikisource">中文维基文库</option>
            </select></label>
          ${f('sfId', '标识 ID（英文/数字，唯一）', c.id || '', '', 'my-src-1')}
          ${f('sfName', '书源名称', c.name || '', '', '我的书库')}
          ${f('sfGroup', '分组', c.group || '', '同一分组的书源可在列表里归在一起。', '自定义')}
          ${f('sfListUrl', '书单页地址', c.listUrl || '', '填入一个网页地址，书源会从这里抓书名与链接。目标站必须允许浏览器跨域访问，否则取不到内容。', 'https://example.com/books')}
          ${f('sfBookList', '书单条目选择器', c.bookList || '', 'CSS 选择器，匹配书单里的每一本书，如 .book-item 或 li.row。', '.book-item')}
          ${f('sfBookTitle', '书名选择器', c.bookTitle || '', '相对每条书目的选择器，留空则取条目文字。', 'h3 a')}
          ${f('sfBookLink', '书链选择器', c.bookLink || '', '取 href 属性，写成 a@href。', 'a@href')}
          ${f('sfChapterList', '章节列表选择器', c.chapterList || '', '书页里每一章链接的选择器。', '.chapter-list a')}
          ${f('sfContent', '正文选择器', c.content || '', '章节页里正文容器的选择器。', '#content')}
          ${f('sfAuthor', '默认作者', c.defaultAuthor || '', '书单里取不到作者时用它兜底。', '网络书源')}
          ${f('sfReplace', '正文清理正则（可选）', c.replaceRegex || '', '匹配到的内容会被删掉，如 广告|免责声明。', '')}
          <p class="mm-hint">本功能只提供一个通用抓取框架，不内置也不推荐任何站点。请仅用于公有领域、开放获取或你自己有权使用的资源；能否读取取决于目标站是否允许跨域访问。</p>
          <button class="link-more" data-action="source-switch-js">改用 JS 代码编辑</button>
          <div id="sfDry" class="sf-dry" hidden></div>
        </div>
        <div class="ce-foot">
          <button class="btn btn-ghost btn-sm" data-action="source-dry-run">${icon('refresh', 'ic-sm')} 试跑一次</button>
          <div style="flex:1"></div>
          <button class="btn btn-ghost" data-action="source-close">取消</button>
          <button class="btn btn-primary" data-action="source-form-save">保存并启用</button>
        </div>
      </div>`;
    a11ySweep(root);
    /* C 方案：只给公版站点的「入口地址示例」，不预置选择器、不保证可用。
       目标站是否允许跨域、页面结构如何，由用户自己打开页面验证。 */
    const tpl = $('#sfTemplate');
    if (tpl) tpl.addEventListener('change', () => {
      const urls = {
        gutenberg: 'https://www.gutenberg.org/ebooks/search/?query=zh',
        wikisource: 'https://zh.wikisource.org/wiki/Special:Search'
      };
      const u = urls[tpl.value];
      if (u && $('#sfListUrl')) { $('#sfListUrl').value = u; toast('已填入示例地址，选择器请按实际页面填写'); }
    });
  }
  function sourceCodeFromForm() {
    const g = (id) => ($('#' + id) || {}).value || '';
    const cfg = {
      id: g('sfId').trim(), name: g('sfName').trim(), group: g('sfGroup').trim(),
      desc: '可视化书源', listUrl: g('sfListUrl').trim(), bookList: g('sfBookList').trim(),
      bookTitle: g('sfBookTitle').trim(), bookLink: g('sfBookLink').trim(),
      chapterList: g('sfChapterList').trim(), content: g('sfContent').trim(),
      defaultAuthor: g('sfAuthor').trim(), replaceRegex: g('sfReplace').trim()
    };
    if (!cfg.id || !cfg.name) throw new Error('标识 ID 与书源名称必填');
    if (!/^[a-zA-Z0-9_-]+$/.test(cfg.id)) throw new Error('标识 ID 只能用英文、数字、下划线和短横线');
    if (cfg.replaceRegex) { try { new RegExp(cfg.replaceRegex); } catch (e) { throw new Error('清理正则写错了'); } }
    return { cfg, code: '/* mj-visual:' + cfg.id + ' */MJ.sources.register(MJ.sourceKit.makeSource(' + JSON.stringify(cfg) + '));' };
  }
  /* 试跑：用表单里的地址与选择器真抓一次，把「命中几本、前几本叫什么」摊开。
     选择器写错最难受的是「保存成功、书肆里却空空如也」，这里一次就能看出断在哪一步。 */
  async function dryRunSource() {
    let cfg;
    try { cfg = sourceCodeFromForm().cfg; } catch (e) { toast(e.message); return; }
    const box = $('#sfDry');
    const paint = (cls, html) => { if (box) { box.hidden = false; box.className = 'sf-dry ' + cls; box.innerHTML = html; } };
    if (!cfg.listUrl) { toast('先填「书单页地址」再试跑'); return; }
    if (/^file:/i.test(cfg.listUrl)) { paint('bad', '本地文件地址（file://）浏览器抓不到，换一个 http(s) 网址。'); return; }
    paint('', '正在取回书单页…');
    const t0 = (window.performance && performance.now()) || Date.now();
    try {
      const html = await MJ.sourceKit.fetchText(cfg.listUrl, null, 15000);
      const list = await MJ.sourceKit.makeSource(cfg).metas();
      const ms = Math.round(((window.performance && performance.now()) || Date.now()) - t0);
      if (!list.length) {
        paint('bad', '取回 ' + html.length + ' 字，但<b>一本都没匹配上</b>（' + ms + 'ms）。'
          + '<br>· 先确认「书单条目选择器」在页面上真能选到东西，写宽一点试（如 a 或 li）'
          + '<br>· 链接选择器一般写 a@href，留空取不到书链');
        return;
      }
      const rows = list.slice(0, 5).map((b) =>
        `<li>${esc(b.title)}<em>${esc(b.url || '')}</em></li>`).join('');
      paint('ok', '取回 ' + html.length + ' 字 · 命中 <b>' + list.length + '</b> 本 · ' + ms + 'ms'
        + '<ol class="sf-dry-list">' + rows + '</ol>'
        + (list.length > 5 ? '<div class="sf-dry-more">只列前 5 本</div>' : ''));
    } catch (e) {
      paint('bad', '取不回来：' + esc(shortErr(e))
        + '<br>常见原因：目标站不允许跨域（可在墨斋配本地代理）、地址写错、或页面需要登录。');
    }
  }
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
  /* 备份分段序列化：本地下载与 WebDAV 上传共用，避免两处逻辑分叉。
     一份含 20 卷正文的备份可能几十 MB，整份 stringify 峰值 2–3 倍会爆手机，
     所以按「小字段 + 逐卷正文」交给 Blob 原生拼接，堆里只留单卷字符串。 */
  async function buildBackupParts() {
    const contents = await collectContents();
    const extras = {};
    EXTRA_KEYS.forEach((k) => {
      try { const v = localStorage.getItem(k); if (v != null) extras[k] = v; } catch (e) { /* 存储不可用 */ }
    });
    const parts = ['\ufeff', '{"app":', JSON.stringify(BACKUP_APP),
      ',"version":', String(BACKUP_VER),
      ',"exportedAt":', JSON.stringify(new Date().toISOString()),
      ',"state":', new Blob([JSON.stringify(state)]),
      ',"contents":{'];
    let first = true;
    Object.keys(contents).forEach((k) => {
      const sep = first ? '' : ','; first = false;
      parts.push(new Blob([sep, JSON.stringify(k), ':', JSON.stringify(contents[k])]));
    });
    parts.push('},"extras":', JSON.stringify(extras), '}');
    return { parts, n: Object.keys(contents).length, extrasN: Object.keys(extras).length };
  }
  async function exportBackup() {
    toast('正在整理备份…');
    const { parts, n, extrasN } = await buildBackupParts();
    const ok = downloadText('墨卷备份-' + today() + '.json', parts);
    toast(ok
      ? '备份已导出 · 含 ' + n + ' 卷本地卷正文'
        + (extrasN ? '、书源与音色配置' : '')
      : '导出失败，请检查浏览器下载权限');
  }
  /* A9 WebDAV：纯前端 fetch PUT/GET，要求目标服务允许跨域（CORS）。
     不是所有 WebDAV 服务都给跨域头，失败会明确提示，不静默。 */
  function webdavAuth() {
    const w = state.webdav || {};
    if (!w.user) return {};
    try { return { Authorization: 'Basic ' + btoa(unescape(encodeURIComponent(w.user + ':' + (w.pass || '')))) }; }
    catch (e) { return {}; }
  }
  async function webdavUpload() {
    const w = state.webdav || {};
    if (!w.url) { toast('先填 WebDAV 地址'); return; }
    try {
      toast('正在整理备份…');
      const { parts } = await buildBackupParts();
      const res = await fetch(w.url, { method: 'PUT', headers: Object.assign({ 'Content-Type': 'application/json' }, webdavAuth()), body: new Blob(parts, { type: 'application/json' }) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      toast('已上传到 WebDAV');
    } catch (e) {
      toast('上传失败：' + ((e && e.message) || '网络或跨域受限') + '（需服务允许 CORS）');
    }
  }
  async function webdavDownload() {
    const w = state.webdav || {};
    if (!w.url) { toast('先填 WebDAV 地址'); return; }
    try {
      const res = await fetch(w.url, { method: 'GET', headers: webdavAuth() });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      await restoreBackup(text);
    } catch (e) {
      toast('下载失败：' + ((e && e.message) || '网络或跨域受限') + '（需服务允许 CORS）');
    }
  }
  function openWebdavForm() {
    const w = state.webdav || {};
    let root = $('#sourceModal');
    if (!root) { root = document.createElement('div'); root.id = 'sourceModal'; document.body.appendChild(root); }
    root.innerHTML = `<div class="modal-backdrop" data-action="source-close"></div>
      <div class="cover-editor mini-modal"><div class="ce-head"><h3>WebDAV 备份</h3>
        <button class="icon-btn" data-action="source-close" title="关闭">${icon('close')}</button></div>
      <div class="mm-body">
        <label>完整文件 URL<input id="wdUrl" value="${esc(w.url || '')}" placeholder="https://dav.example.com/mojuan/backup.json"></label>
        <label>账号（可选）<input id="wdUser" value="${esc(w.user || '')}" autocomplete="off"></label>
        <label>密码（可选）<input id="wdPass" type="password" value="${esc(w.pass || '')}" autocomplete="off"></label>
        <p class="mm-hint">账号密码只存本机浏览器，请勿在公用设备使用。目标服务需允许跨域访问，否则会失败；这不是墨卷能绕过的限制。</p>
      </div>
      <div class="ce-foot"><div></div>
        <button class="btn btn-ghost" data-action="wd-download">从 WebDAV 恢复</button>
        <button class="btn btn-primary" data-action="wd-save">保存并上传</button></div></div>`;
    a11ySweep(root);
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
    /* 藏卷卡角标：未读章节数，红=在读、灰=未开始（对应阅读的红/灰小数字） */
    const total = Math.max(1, chapterList(b).length);
    const unread = Math.max(0, total - (pr ? Math.max(1, Number(pr.ch) || 1) : 1));
    const unreadBadge = opts.shelf && unread > 0
      ? `<span class="unread-badge ${pr ? 'reading' : ''}" title="未读 ${unread} 章">${unread > 99 ? '99+' : unread}</span>` : '';
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
      <div class="cover-wrap">${coverHtml(b)}${badge}${unreadBadge}${pick}${quick}</div>
      <div class="book-name">${esc(b.title)}</div>
      <div class="book-meta"><span class="bm-text">${esc(b.author)} · ${esc(b.category)}</span>${miniTags(b)}</div>
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
        <h3 role="heading" aria-level="2">${markText(b.title, opts.mark)} <span class="muted" style="font-size:11px;font-weight:400">/ ${markText(b.author, opts.mark)}</span></h3>
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
      : `共藏 ${shelf.length} 卷 · ${lastTitle ? '最近读的是《' + esc(lastTitle) + '》' : '挑一卷，从今天读起'}`;
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
      const begun = !!state.progress[last.id] && (((pr.ch || 1) > 1) || bp > 0);
      const pctText = bp > 0 ? Math.max(1, Math.round(bp * 100)) : 0;
      html += `<div class="continue-card" data-action="continue-read" data-id="${last.id}">
        <div>${coverHtml(last)}</div>
        <div class="continue-info">
          <div class="muted" style="font-size:11px;letter-spacing:.16em;margin-bottom:6px">${begun ? '接 着 读' : '待 开 卷'}</div>
          <h3>${esc(last.title)}</h3>
          <div class="last">${esc(chapterList(last)[Math.max(0, Math.min((pr.ch || 1) - 1, chapterList(last).length - 1))].title)} · ${esc(last.author)}</div>
          <div class="progress-line"><i style="width:${Math.round(bp * 100)}%"></i></div>
          <div class="pct">${begun ? '已读 ' + pctText + '%　续卷' : '尚未开卷　开卷'} ${icon('right', 'ic-sm')}</div>
        </div>
      </div>`;
    }
    /* 标签筛选带上卷数，一眼看出每个分组有几卷；空分组点不动 */
    /* 自动分组：按真实进度算未读/在读/已读，和手动 tags 并行，不互相覆盖 */
    const autoGroup = (b) => {
      const pr = state.progress[b.id];
      if (!pr) return 'new';
      const total = Math.max(1, chapterList(b).length);
      const ch = Math.max(1, Number(pr.ch) || 1);
      if ((ch - 1 + (Number(pr.pct) || 0)) >= total) return 'read';
      return 'reading';
    };
    const tagN = (k) => {
      if (k === 'all') return shelf.length;
      if (k.indexOf('auto:') === 0) return shelf.filter((b) => autoGroup(b) === k.slice(5)).length;
      return shelf.filter((b) => state.bookTags[b.id] === k).length;
    };
    html += `<div class="chip-row shelf-filters">${[['all', '全部'], ['want', '想读'], ['reading', '在读'], ['done', '已读']].map(([k, l]) =>
      `<button class="chip ${ui.shelfFilter === k ? 'active' : ''}" data-action="set-shelf-filter" data-val="${k}" ${k !== 'all' && !tagN(k) ? 'disabled' : ''}>${l} ${tagN(k)}</button>`).join('')}</div>`;
    html += `<div class="chip-row shelf-autogroup"><span class="ag-label">自动</span>${[['new', '未读'], ['reading', '在读'], ['read', '已读']].map(([k, l]) =>
      `<button class="chip chip-sm ${ui.shelfFilter === 'auto:' + k ? 'active' : ''}" data-action="set-shelf-filter" data-val="auto:${k}" ${!tagN('auto:' + k) ? 'disabled' : ''}>${l} ${tagN('auto:' + k)}</button>`).join('')}</div>`;
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
        ${state.viewMode === 'grid' ? `<div class="view-toggle density-toggle">
          <button class="${state.density === 'cozy' ? 'active' : ''}" data-action="set-density" data-val="cozy" title="舒适 · 大封面">舒</button>
          <button class="${state.density === 'compact' ? 'active' : ''}" data-action="set-density" data-val="compact" title="紧凑 · 宽屏更多列">紧</button>
        </div>` : ''}
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
    if (ui.shelfFilter === 'all') { /* 不过滤 */ }
    else if (ui.shelfFilter.indexOf('auto:') === 0) {
      const want = ui.shelfFilter.slice(5);
      order = order.filter((b) => autoGroup(b) === want);
    } else order = order.filter((b) => state.bookTags[b.id] === ui.shelfFilter);
    /* 搜索不在这里裁 order：重渲染若按关键词删卡片，之后删字放宽搜索就再也恢复不了。
       统一由 applyShelfSearch 切 hidden，DOM 里始终保留当前分组的全部卡片。 */
    ui.shelfVisibleIds = order.map((b) => b.id);
    pruneShelfPick();
    if (!order.length) {
      html += `<div class="empty">${icon('search')}<p>这个分组还空着，长按卷册可批量理卷</p>
        <button class="btn btn-ghost" data-action="set-shelf-filter" data-val="all">看全部</button></div>`;
    } else {
      html += state.viewMode === 'grid'
        ? `<div class="book-grid density-${esc(state.density || 'cozy')}">${order.map((b) => bookCard(b, {
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
        <div class="banner-tag">${esc(b.tag)}</div>
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
  /* 整理模式的选择集只能包含「此刻看得见」的卷：筛了标签、批量改了标记、搜了关键词之后，
     被筛掉的卷若还留在集合里，编辑条会写「已选 3 卷」屏幕上却只有 1 卷，
     再点「移出藏卷」就把屏幕外那几卷一起移走了（笔记多选早已这样收敛）。 */
  function pruneShelfPick() {
    if (!ui.selected || !ui.selected.size) return;
    const keep = new Set(ui.shelfVisibleIds || []);
    Array.from(ui.selected).forEach((x) => { if (!keep.has(x)) ui.selected.delete(x); });
  }
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
    pruneShelfPick();
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
    /* 书源可以一个个全停掉，这时一本书都没有；原先直接解引用 daily.id 会抛异常，
       整个 render() 断掉，书肆停在上一个页面甚至白屏。给一个能走通的空态。 */
    const pool = allBooks();
    if (!pool.length) {
      html += `<div class="section">${sectionHead('今日一卷', '', '')}
        <div class="empty">${icon('book')}<p>书源都停用了，眼前暂时没有可荐的卷</p>
        <div class="empty-actions"><button class="btn btn-primary" data-go="me">去墨斋启用书源</button>
        <button class="btn btn-ghost" data-go="shelf">回藏卷</button></div></div></div>`;
    } else {
      const daily = pool[new Date().getDate() % pool.length];
      const dailyInShelf = state.shelf.includes(daily.id);
      html += `<div class="section">${sectionHead('今日一卷', '', '')}
        <div class="daily-card" data-action="open-book" data-id="${daily.id}">
          <div>${coverHtml(daily)}</div>
          <div>
            <div class="muted" style="font-size:11px;letter-spacing:.16em">DAILY PICK · 今 日 展 卷</div>
            <h3>${esc(daily.title)}</h3><div class="byline">${esc(daily.author)} · ${esc(daily.category)} · ${esc(daily.words)}</div>
            <p class="desc">${esc(daily.desc)}</p>
            <div style="display:flex;align-items:center;gap:12px">
              <span class="score" style="font-size:20px">${chapNum(daily)}</span><span class="muted" style="font-size:12px">篇 · ${daily.words}</span>
              <button class="btn btn-ghost btn-sm" style="margin-left:auto" data-action="${dailyInShelf ? 'open-book' : 'add-shelf'}" data-id="${daily.id}">${icon(dailyInShelf ? 'check' : 'plus', 'ic-sm')} ${dailyInShelf ? '已在藏卷' : '收入藏卷'}</button>
            </div>
          </div>
        </div></div>`;
    }
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
    /* seen 已经从 allBooks() 收过本地卷的「本地」分类，再 push 会出现两个同名
       chip、选中时两个一起高亮；只有旧数据没带 category 时才需要补一个 */
    if (state.localBooks.length && cats.indexOf('本地') < 0) cats.push('本地');
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
  /* 本地导入卷的 chapters 是字符串数组，公版书是 {no,title}；搜索这两处直接读原始
     数组，绕开了 chapterList() 的归一化，得自己把两种形态都认下来。 */
  const chapterTitle = (c) => typeof c === 'string' ? c : String((c && c.title) || '');
  function searchMatch(q) {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    /* 卷名、作者、分类、简介、标签，以及篇目名（搜「逍遥游」「关雎」也能找到所在卷） */
    return allBooks().filter((b) => {
      const hay = [b.title, b.author, b.category, b.desc, ...(b.tags || [])].join(' ').toLowerCase();
      if (hay.includes(s)) return true;
      const chs = b.chapters || [];
      for (let i = 0; i < chs.length; i++) {
        if (chapterTitle(chs[i]).toLowerCase().includes(s)) return true;
      }
      return false;
    });
  }
  /* 命中篇目时，把那一篇的名字带出来给用户看 */
  function searchHint(q, b) {
    const s = q.trim().toLowerCase();
    if (!s) return '';
    const hit = (b.chapters || []).find((c) => chapterTitle(c).toLowerCase().includes(s));
    return hit && !String(b.title).toLowerCase().includes(s) ? `含「${chapterTitle(hit)}」` : '';
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
      box.innerHTML = `<div class="search-block"><h3 role="heading" aria-level="2">${icon('clock', 'ic-sm')} 最近寻过
          <button class="link-more" style="margin-left:auto" data-action="clear-history">清空</button></h3>
        <div class="history-chips">${state.history.length ? state.history.map((h) =>
          `<button class="chip" data-action="hot-word" data-val="${esc(h)}">${esc(h)}</button>`).join('') : '<span class="muted" style="font-size:12.5px">还没有寻卷记录</span>'}</div></div>
        <div class="search-block"><h3 role="heading" aria-level="2">${icon('search', 'ic-sm')} 不妨从这里找</h3>
        <div class="hot-list">${D.HOT_SEARCH.map((h, i) =>
          `<div class="hot-item" data-action="hot-word" data-val="${esc(h)}"><i>${i + 1}</i><span>${esc(h)}</span></div>`).join('')}</div></div>
        <div class="search-block"><h3 role="heading" aria-level="2">${icon('book', 'ic-sm')} 或许你会喜欢</h3>
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

  /* ---------- 页面：订阅（A1） ---------- */
  let subCache = {};   /* 订阅源 id -> 文章列表，切页不重复抓 */
  function pageSubscribe() {
    let html = `<button class="btn btn-ghost btn-sm" style="margin-bottom:18px" data-action="history-back">${icon('back', 'ic-sm')} 返回</button>`;
    html += head('订阅', 'SUBSCRIBE', '自己接的网页列表 · 只用于公版与你有权使用的资源',
      `<button class="btn btn-ghost btn-sm" data-action="sub-add">${icon('plus', 'ic-sm')} 添加订阅源</button>`);
    const subs = (state.subscriptions || []).filter((s) => s.enabled !== false);
    if (!subs.length) {
      return html + `<div class="empty">${icon('book')}<p>还没有订阅源</p>
        <p class="muted" style="font-size:12px">点右上角「添加订阅源」，填一个网页地址与列表选择器即可</p></div>`;
    }
    html += `<div class="section">${sectionHead('订阅', '', '')}<div class="setting-list">`;
    subs.forEach((s) => {
      const list = subCache[s.id];
      const n = list ? list.length : 0;
      const err = subCache[s.id + ':error'];
      html += `<div class="setting-row">
        ${icon('book')}
        <div class="st">${esc(s.name)}<small>${esc(s.url)}${err ? ' · 取回失败：' + esc(err) : (list ? ' · ' + n + ' 条' : ' · 点右侧刷新')}</small></div>
        <button class="btn btn-ghost btn-sm" data-action="sub-refresh" data-id="${esc(s.id)}">刷新</button>
        <button class="btn btn-ghost btn-sm" data-action="sub-edit" data-id="${esc(s.id)}">编辑</button>
      </div>`;
      if (list) {
        list.forEach((a) => {
          const read = !!state.subRead[a.key];
          html += `<div class="setting-row sub-item ${read ? 'read' : ''}">
            <div class="st" style="cursor:pointer" data-action="sub-open" data-val="${esc(a.key)}">
              ${esc(a.title)}<small>${esc(a.url)}</small></div>
            <button class="btn btn-ghost btn-sm" data-action="sub-toggle-read" data-val="${esc(a.key)}">${read ? '已读' : '未读'}</button>
          </div>`;
        });
      }
    });
    return html + '</div></div>';
  }
  function openSubForm(editId) {
    const old = (state.subscriptions || []).find((s) => s.id === editId) || {};
    let root = $('#sourceModal');
    if (!root) { root = document.createElement('div'); root.id = 'sourceModal'; document.body.appendChild(root); }
    const f = (id, label, val, hint, ph) => `<label>${label}<input id="${id}" value="${esc(val || '')}" placeholder="${esc(ph || '')}" spellcheck="false"></label>${hint ? `<p class="mm-hint">${hint}</p>` : ''}`;
    root.innerHTML = `<div class="modal-backdrop" data-action="source-close"></div>
      <div class="cover-editor mini-modal source-form">
        <div class="ce-head"><h3>${editId ? '编辑订阅源' : '添加订阅源'}</h3>
          <button class="icon-btn" data-action="source-close" title="关闭">${icon('close')}</button></div>
        <div class="mm-body">
          ${f('sbId', '标识 ID', old.id || '', '', 'rss-1')}
          ${f('sbName', '名称', old.name || '', '', '我的订阅')}
          ${f('sbUrl', '列表页地址', old.url || '', '目标站需允许浏览器跨域访问，否则取不到内容。', 'https://example.com/news')}
          ${f('sbArticles', '条目选择器', old.ruleArticles || '', '匹配每一条，如 .post 或 li.item。', '.post')}
          ${f('sbTitle', '标题选择器', old.ruleTitle || '', '相对每条的选择器，留空取条目文字。', 'h3 a')}
          ${f('sbLink', '链接选择器', old.ruleLink || '', '取 href 写成 a@href。', 'a@href')}
          <p class="mm-hint">只填公版、开放获取或你有权使用的资源；能否读取取决于目标站是否允许跨域访问。</p>
        </div>
        <div class="ce-foot"><div></div>
          <button class="btn btn-ghost" data-action="source-close">取消</button>
          <button class="btn btn-primary" data-action="sub-form-save">保存</button>
        </div>
      </div>`;
    a11ySweep(root);
  }
  /* ---------- 页面：我的书单（A8） ---------- */
  function pageLists() {
    let html = `<button class="btn btn-ghost btn-sm" style="margin-bottom:18px" data-action="history-back">${icon('back', 'ic-sm')} 返回</button>`;
    html += head('书单', 'LISTS', '把书按自己的主题归在一起',
      `<button class="btn btn-ghost btn-sm" data-action="list-add">${icon('plus', 'ic-sm')} 新建书单</button>`);
    const lists = state.lists || [];
    if (!lists.length) {
      return html + `<div class="empty">${icon('book')}<p>还没有书单</p>
        <p class="muted" style="font-size:12px">点右上角新建，再到书详情页把书加进去</p></div>`;
    }
    lists.forEach((l) => {
      const books = (l.bookIds || []).map(getBook).filter(Boolean);
      html += `<div class="section"><div class="section-head"><h2 class="section-title">${esc(l.name)}</h2>
        <button class="section-more" data-action="list-rename" data-id="${esc(l.id)}">改名 ${icon('right', 'ic-sm')}</button>
        <button class="section-more" data-action="list-del" data-id="${esc(l.id)}">删除</button></div>`;
      if (!books.length) {
        html += `<div class="empty" style="padding:20px">这本单子还空着<small style="display:block;margin-top:6px">在书详情页点「加入书单」</small></div></div>`;
        return;
      }
      html += `<div class="book-grid">${books.map((b) => bookCard(b, { quickAdd: false })).join('')}</div></div>`;
    });
    return html;
  }
  function openListEditor(kind, id) {
    let root = $('#sourceModal');
    if (!root) { root = document.createElement('div'); root.id = 'sourceModal'; document.body.appendChild(root); }
    const list = (state.lists || []).find((l) => l.id === id);
    const title = kind === 'add' ? '新建书单' : (kind === 'rename' ? '改名书单' : '加入书单');
    let body = '';
    if (kind === 'pick') {
      body = `<p class="mm-hint">选一本单子，把这本书加进去。</p><div class="setting-list">${(state.lists || []).map((l) =>
        `<div class="setting-row" data-action="list-add-book" data-id="${esc(l.id)}" data-val="${esc(id)}">
          ${icon('book')}<div class="st">${esc(l.name)}<small>${(l.bookIds || []).length} 本</small></div>${icon('right', 'ic-sm')}</div>`).join('') || '<div class="empty" style="padding:20px">还没有书单，先去墨斋新建一个</div>'}</div>`;
    } else {
      body = `<label>书单名称<input id="listNameInput" value="${esc(list ? list.name : '')}" placeholder="如：睡前读"></label>`;
    }
    root.innerHTML = `<div class="modal-backdrop" data-action="source-close"></div>
      <div class="cover-editor mini-modal"><div class="ce-head"><h3>${title}</h3>
        <button class="icon-btn" data-action="source-close" title="关闭">${icon('close')}</button></div>
      <div class="mm-body">${body}</div>
      <div class="ce-foot"><div></div><button class="btn btn-ghost" data-action="source-close">取消</button>
        ${kind === 'pick' ? '' : `<button class="btn btn-primary" data-action="list-save" data-val="${esc(id || '')}">保存</button>`}</div></div>`;
    a11ySweep(root);
  }

  /* A3 换源：同一本书在不同来源间切换，进度/书签/笔记/标记一起迁过去。
     只匹配「同名书」，不猜；不同来源的 id 不同，进度按 id 存，所以要显式迁移。 */
  function openSwitchSource(id) {
    const cur = getBook(id); if (!cur) return;
    const title = String(cur.title || '').trim();
    const candidates = allBooks().filter((b) => b.id !== id && b.sourceId !== cur.sourceId
      && String(b.title || '').trim() === title);
    let root = $('#sourceModal');
    if (!root) { root = document.createElement('div'); root.id = 'sourceModal'; document.body.appendChild(root); }
    const rows = candidates.length ? candidates.map((b) => {
      const srcName = ((SRC.get(b.sourceId) || {}).name) || (b.local ? '本地卷' : '公版');
      return `<div class="setting-row" data-action="switch-source-to" data-id="${esc(b.id)}">
        ${icon(b.online ? 'store' : 'book')}<div class="st">${esc(b.title)}<small>${esc(b.author || '')} · ${esc(srcName)} · ${(b.chapters || []).length} 章</small></div>
        ${icon('right', 'ic-sm')}</div>`;
    }).join('') : `<div class="empty" style="padding:20px">其他来源里没有找到《${esc(title)}》</div>`;
    root.innerHTML = `<div class="modal-backdrop" data-action="source-close"></div>
      <div class="cover-editor mini-modal">
        <div class="ce-head"><h3>换源 · ${esc(title)}</h3>
          <button class="icon-btn" data-action="source-close" title="关闭">${icon('close')}</button></div>
        <div class="mm-body"><p class="mm-hint">选另一个来源的同名书，当前进度、书签、笔记与标记会一起带过去。</p>
          <div class="setting-list">${rows}</div></div>
        <div class="ce-foot"><div></div><button class="btn btn-ghost" data-action="source-close">取消</button></div>
      </div>`;
    a11ySweep(root);
  }
  function switchSourceTo(toId) {
    const from = readerRoot.dataset.currentBook || (location.hash.match(/book\/([^/]+)/) || [])[1];
    if (!from || from === toId) { closeSourceEditor(); return; }
    const to = getBook(toId);
    if (!to) { toast('目标书不存在'); return; }
    /* 进度按章号与章内比例迁移，不按百分比硬搬 */
    const p = state.progress[from];
    if (p) {
      state.progress[toId] = Object.assign({}, p, { updated: Date.now() });
      delete state.progress[from];
    }
    ['bookmarks', 'annotations', 'bookTags', 'listenPos', 'bookNotes'].forEach((k) => {
      if (state[k] && state[k][from]) {
        state[k][toId] = state[k][toId] || state[k][from];
        delete state[k][from];
      }
    });
    if (state.pinned && state.pinned.includes(from)) {
      state.pinned = state.pinned.map((x) => x === from ? toId : x);
    }
    if (state.lastRead === from) state.lastRead = toId;
    if (!state.shelf.includes(toId)) state.shelf.unshift(toId);
    closeSourceEditor();
    save(); renderNav(ui.nav);
    go('book/' + toId);
    toast('已换到《' + to.title + '》的另一来源，进度已保留');
  }

  async function refreshSub(id) {
    const s = (state.subscriptions || []).find((x) => x.id === id);
    if (!s) return;
    try {
      subCache[id] = await MJ.subKit.fetchArticles(s);
      delete subCache[id + ':error'];
    } catch (e) {
      delete subCache[id];
      subCache[id + ':error'] = (e && e.message ? e.message : '取回失败').slice(0, 40);
      toast('订阅取回失败：' + subCache[id + ':error']);
    }
    rerender();
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
    /* 「读过」看的是真读到哪儿，不是「有没有那条记录」：导入时会先写一条
       {ch:1,pct:0}，只按记录判断就会出现「续卷 · 第 1 章」配「已读 —」的矛盾。 */
    const begun = !!pr && ((pr.ch || 1) > 1 || bp > 0);
    let html = `<button class="btn btn-ghost btn-sm" style="margin-bottom:18px" data-action="history-back">${icon('back', 'ic-sm')} 返回</button>`;
    html += `<div class="detail-hero">
      <div class="detail-cover">${coverHtml(b)}
        <button class="btn btn-ghost btn-sm cover-edit-btn" data-action="open-cover" data-id="${b.id}">${icon('brush', 'ic-sm')} 换封面</button>
      </div>
      <div class="detail-info">
        <div class="muted" style="font-size:11px;letter-spacing:.2em">${esc(b.category || '未分类')} · ${esc(b.status || '来自书源')}</div>
        <h1>${esc(b.title)}</h1>
        <div class="detail-byline">${esc(b.author)} · ${b.local ? '本地导入' : (b.online ? '维基文库' : '墨卷公版')}</div>
        <div class="detail-stats">
          <div class="stat"><b>${chapters.length}</b><span>篇目</span></div>
          <div class="stat"><b>${esc(b.words)}</b><span>总字数</span></div>
          <div class="stat"><b>${b.local ? (b.tags[1] || 'TXT') : (b.online ? '在线' : '公版')}</b><span>${b.local ? '文件格式' : '卷源'}</span></div>
          <div class="stat"><b>${bp > 0 ? Math.max(1, Math.round(bp * 100)) + '%' : '—'}</b><span>已读</span></div>
        </div>
        <p class="detail-desc ${ui.descOpen ? '' : 'clamp'}" id="bookDesc">${esc(b.desc)}</p>
        <button class="link-more" style="align-self:flex-start;margin-bottom:14px" data-action="toggle-desc">${ui.descOpen ? '收起' : '展开简介'} ${icon('right', 'ic-sm')}</button>
        <div class="detail-tags">${(b.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
        <div class="detail-actions">
          <button class="btn btn-primary" data-action="start-read" data-id="${b.id}">${icon('book', 'ic-sm')} ${begun ? '续卷 · 第' + Math.min(chapters.length, pr.ch || 1) + '章' : '开卷'}</button>
          <button class="btn btn-ghost" data-action="${inShelf ? 'remove-shelf' : 'add-shelf'}" data-id="${b.id}">
            ${icon(inShelf ? 'check' : 'plus', 'ic-sm')} ${inShelf ? '已在藏卷' : '收入藏卷'}</button>
          <button class="btn btn-ghost btn-sm" data-action="switch-source" data-id="${esc(b.id)}">${icon('store', 'ic-sm')} 换源</button>
          <button class="btn btn-ghost btn-sm" data-action="list-pick" data-id="${esc(b.id)}">${icon('grid', 'ic-sm')} 加入书单</button>
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
        <h3 role="heading" aria-level="2">目录 <button class="link-more" data-action="open-catalog" data-id="${b.id}">全部 ${chapters.length} 章 ${icon('right', 'ic-sm')}</button></h3>
        ${b.online && chapters.length <= 1
          ? (ui.tocLoading ? tocLoadingHtml()
            : (ui.tocFailed ? `<div class="toc-status">${icon('info', 'ic-sm')} ${ui.tocOffline ? '现在没有网络，连上后点重试' : '目录没取回来'}
                <button class="btn btn-ghost btn-sm" data-action="retry-toc" data-id="${b.id}">${icon('refresh', 'ic-sm')} 重试</button></div>`
              : `<div class="toc-status">${icon('info', 'ic-sm')} 篇目开卷时联网取回</div>`))
          : `<ul class="chapter-preview">${chapters.slice(0, 6).map((c, i) =>
          `<li data-action="open-chapter" data-id="${b.id}" data-ch="${i + 1}"><span style="color:var(--ink-2)">${esc(c.title)}</span><span>${i === 0 ? '卷首' : ''}</span></li>`).join('')}</ul>`}
      </div>
      <div class="panel">
        <h3 role="heading" aria-level="2">关于此卷</h3>
        ${b.local
          ? `<div class="review"><p>这卷由本地文件导入，正文保存在此设备的浏览器数据库中，不会上传到任何服务器。章节按文件原有标记划分，读墨进度与排版设置和内置卷一致。不想保留时可用上方「弃卷」移除。</p>
              <button class="btn btn-ghost btn-sm" data-action="edit-local" data-id="${b.id}">${icon('brush', 'ic-sm')} 编辑卷名 / 作者</button></div>`
          : b.online
          ? `<div class="review"><p>这卷来自「${esc((SRC.get(b.sourceId) || {}).name || '在线书源')}」，正文在开卷时从公共书库取回，需要联网。读到哪一章就取哪一章，不占本地空间。</p>
              <div class="row-tags" style="margin-top:8px"><span class="tag">公共书库</span><span class="tag">需联网</span></div></div>`
          : `<div class="review"><p>${esc(b.desc)}</p>
              <p class="muted" style="font-size:12px;margin-top:8px">作者${esc(b.author)}，作品已入公有领域，可自由阅读与分发。全文随墨卷离线内置，断网也能读。</p>
              <div class="row-tags" style="margin-top:8px"><span class="tag">公有领域</span><span class="tag">离线可读</span>${(b.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div></div>`}
        <div class="book-note">
          <h3 role="heading" aria-level="2">我的备注
            <button class="link-more" data-action="edit-book-note" data-id="${esc(b.id)}">${state.bookNotes[b.id] ? '编辑' : '写一条'} ${icon('right', 'ic-sm')}</button></h3>
          ${state.bookNotes[b.id]
            ? `<p class="bn-text">${esc(state.bookNotes[b.id])}</p>`
            : '<p class="muted" style="font-size:12px">读这本书的想法、摘记，写在这里，随时可改。</p>'}
        </div>
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

  /* 阅读记录时间轴：按天聚合读墨时长与翻章事件，展示最近有记录的 7 天。
     数据来自已有的 state.readLog（每日秒数）与 state.readEvents（翻章事件）。 */
  function readTimelineHtml() {
    const evs = state.readEvents || [];
    const log = state.readLog || {};
    if (!evs.length && !Object.keys(log).length) return '';
    /* 把事件按「日期」分组 */
    const byDay = new Map();
    evs.forEach((e) => {
      const d = ymd(new Date(e.t));
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(e);
    });
    const days = Array.from(byDay.keys()).sort().reverse().slice(0, 7);
    if (!days.length) return '';
    const fmt = (ts) => new Date(ts).toTimeString().slice(0, 5);
    return `<div class="section">${sectionHead('读墨时间轴', '', '')}
      <div class="timeline">${days.map((d) => {
        const min = Math.round((log[d] || 0) / 60);
        const list = (byDay.get(d) || []).slice(-6).reverse();
        const label = d === today() ? '今天' : (d === ymd(new Date(Date.now() - 86400000)) ? '昨天' : d.slice(5));
        return `<div class="tl-day"><div class="tl-head"><b>${label}</b><span>${min ? min + ' 分钟' : '—'}</span></div>
          <div class="tl-items">${list.length ? list.map((e) => {
            const b = getBook(e.id);
            return `<div class="tl-item"><i>${fmt(e.t)}</i><span>读到《${esc(b ? b.title : e.id)}》第 ${e.ch} 章</span></div>`;
          }).join('') : '<div class="tl-item muted">这天没有翻章记录</div>'}</div></div>`;
      }).join('')}</div></div>`;
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
    html += readTimelineHtml();
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
            <div class="local-thumb" style="background:${b.color}">${esc(b.seal)}</div>
            <div class="st" style="cursor:pointer" data-action="open-book" data-id="${b.id}">《${esc(b.title)}》<small>${b.chapters.length} 章 · ${esc(b.words || '')} · ${esc(b.author || '')}</small></div>
            <button class="btn btn-ghost btn-sm" data-action="export-volume" data-id="${b.id}" title="导出成墨卷包，可换设备导入">导出</button>
            <button class="btn btn-ghost btn-sm btn-danger" data-action="delete-local" data-id="${b.id}">删除</button>
          </div>`).join('')}
        </div>
        <div class="muted" style="font-size:11.5px;margin-top:10px;line-height:1.8">正文保存在本设备的浏览器数据库中，不会上传；换设备或清理浏览器数据会丢失，请保留原文件。点「导出」可存成一份墨卷包（.mjz），连同正文、漫画图与笔记，换设备时导入即可。</div>
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
        <div class="setting-list" id="noteList">
          ${(function noteRows() {
            /* 一次只渲染一批，避免几万条笔记堆出十万个 DOM 节点。
               筛选命中落在批次外时，applyNoteFilter() 会扩 ui.noteLimit 重渲染。 */
            return annAll.slice(0, ui.noteLimit).map(({ bid, a, i }) => {
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
            }).join('');
          })()}
        </div>
        ${annAll.length > ui.noteLimit ? `<button class="btn btn-ghost note-more" data-action="note-more">还有 ${annAll.length - ui.noteLimit} 条 · 显示更多</button>` : ''}
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
        <div class="setting-row" data-action="export-book-notes">${icon('brush')}<div class="st">导出书籍备注<small>把每本书的整书备注整理成一个 TXT</small></div>${icon('right', 'ic-sm')}</div>
        <div class="setting-row" data-action="webdav-config">${icon('store')}<div class="st">WebDAV 云备份<small>${state.webdav && state.webdav.url ? '已配置 · 可上传 / 恢复' : '填一个支持跨域的 WebDAV 地址，上传或恢复备份'}</small></div>${icon('right', 'ic-sm')}</div>
        <div class="setting-row" data-action="export-annotations">${icon('brush')}<div class="st">导出划线与批注<small>${noteFilterActive() ? '按「我的笔记」当前的搜索 / 按卷 / 颜色筛选导出' : '把所有卷的笔记整理成一个 TXT'}，方便留存或搬运</small></div>${icon('right', 'ic-sm')}</div>
      </div></div>`;
    html += `<div class="section">${sectionHead('书源', '', '')}
      <div class="setting-list">
        <div class="setting-row proxy-row">
          ${icon('settings')}<div class="st">本地代理地址<small>填 tools/local_server.py 的地址（如 http://127.0.0.1:8899），书源才能取回跨域网页。仅转发你指定的地址，内容不过第三方。</small>
            <div class="proxy-input-row"><input id="proxyUrlInput" value="${esc(state.proxyUrl || '')}" placeholder="http://127.0.0.1:8899" spellcheck="false"><button class="btn btn-ghost btn-sm" data-action="proxy-save">保存</button></div>
          </div>
        </div>
        ${SRC.list().map((s) => {
          const n = SRC.allBooks().filter((b) => b.sourceId === s.id).length;
          const group = s.group ? ' · ' + esc(s.group) : '';
          const dup = (s._cfg && s._cfg.listUrl)
            ? SRC.list().filter((x) => x !== s && x._cfg && x._cfg.listUrl === s._cfg.listUrl).length : 0;
          const h = (ui.srcHealth || {})[s.id];
          return `<div class="setting-row">
            ${icon(s.online ? 'store' : 'book')}
            <div class="st">${esc(s.name)}<small>${esc(s.desc)}${group}${dup ? ' · ⚠ 与 ' + dup + ' 个源同地址' : ''} · 现有 ${n} 卷${s.online ? ' · 需联网' : ' · 离线可读'}<span class="src-health ${h && h.ok ? 'ok' : 'bad'}" data-health-for="${esc(s.id)}" ${h && !h.skip ? '' : 'hidden'}>${h && !h.skip ? (h.ok ? '✓ ' : '✕ ') + esc(h.msg) : ''}</span></small></div>
            ${s._cfg ? `<button class="btn btn-ghost btn-sm" data-action="source-edit" data-id="${esc(s.id)}">编辑</button>` : ''}
            <button class="switch ${s.enabled === false ? '' : 'on'}" data-action="toggle-source" data-id="${esc(s.id)}" aria-label="${esc(s.name)}"></button>
          </div>`;
        }).join('')}
        <div class="setting-row${ui.srcChecking ? ' src-checking' : ''}" data-action="check-sources">${icon('refresh')}<div class="st">检测书源可用性<small id="srcCheckHint">${ui.srcChecking ? '正在检测…' : Object.keys(ui.srcHealth || {}).length ? '已测 ' + Object.keys(ui.srcHealth).length + ' 个 · 再点可重测' : '逐个拉一次目录，看哪个源挂了'}</small></div>${icon('right', 'ic-sm')}</div>
        <div class="setting-row" data-action="add-source">${icon('plus')}<div class="st">添加书源（可视化）<small>填网页地址与选择器即可，不需要写代码；仅用于公版或你有权使用的资源</small></div>${icon('right', 'ic-sm')}</div>
        <div class="setting-row" data-action="add-source-js">${icon('brush')}<div class="st">添加书源（JS 插件）<small>高级用法：自己写 MJ.sources.register 代码，完全自定义取书逻辑</small></div>${icon('right', 'ic-sm')}</div>
        <div class="setting-row" data-action="import-source-json">${icon('book')}<div class="st">导入书源 / 订阅 JSON<small>选一个 .json 文件批量导入书源与订阅配置</small></div>${icon('right', 'ic-sm')}</div>
        <div class="setting-row" data-action="export-sources">${icon('brush')}<div class="st">导出书源<small>把自定义书源存成 JSON，方便备份或换机</small></div>${icon('right', 'ic-sm')}</div>
      </div></div>`;
    html += `<div class="section">${sectionHead('其他', '', '')}
      <div class="setting-list">
        <div class="setting-row" data-action="import-books">${icon('plus')}<div class="st">导入本地卷<small>TXT / EPUB / MD / HTML / 墨卷包（.mjz），支持多选</small></div>${icon('right', 'ic-sm')}</div>
        <div class="setting-row" data-action="import-comic">${icon('grid')}<div class="st">导入图片成漫画卷<small>选自己电脑里的 JPG / PNG / WebP，按顺序合成一卷；内容只存本机</small></div>${icon('right', 'ic-sm')}</div>
        ${state.localBooks.length ? `<div class="setting-row" data-action="go-local-list">${icon('trash')}<div class="st">整理 / 删除已导入的卷<small>已导入 ${state.localBooks.length} 本，可单本删除；藏卷里长按卷册可批量理卷</small></div>${icon('right', 'ic-sm')}</div>` : ''}
        <div class="setting-row" data-action="go-shelf">${icon('shelf')}<div class="st">管理我的藏卷</div>${icon('right', 'ic-sm')}</div>
        <div class="setting-row" data-go="subscribe">${icon('book')}<div class="st">我的订阅<small>自己接的网页列表 · 仅用于公版与你有权使用的资源</small></div>${icon('right', 'ic-sm')}</div>
        <div class="setting-row" data-go="lists">${icon('grid')}<div class="st">我的书单<small>把书按自己的主题归在一起</small></div>${icon('right', 'ic-sm')}</div>
        <div class="setting-row" data-action="open-shortcut-help">${icon('settings')}<div class="st">键盘捷径<small>按 ? 随时打开，桌面上读墨更快</small></div>${icon('right', 'ic-sm')}</div>
        <div class="setting-row" data-action="reset-data">${icon('trash')}<div class="st">清空本地读墨数据<small>藏卷、进度与设置将恢复初始状态</small></div>${icon('right', 'ic-sm')}</div>
      </div></div>`;
    html += `<div class="about-line">墨卷 MO JUAN · 一卷在手，人间可读<br>公版典藏 · 全文离线内置 · 书源可扩展</div>`;
    return html;
  }

  /* ---------- 阅读器 ---------- */
  /* 正文取不到时，书源返回的是一句提示而不是真章节。
     认出来单独渲染成「取不到 + 重试」，别让人对着括号里的一行字读。 */
  const READER_ERR_RE = /^（?(需要联网|这一章没取回来|这一章暂未取到|这一章暂无|这卷没有|本章内容未能读取)/;
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
    /* 漫画卷一次一图，不走文字分页；图片从内容记录里取 */
    const isComic = b.kind === 'comic';
    const comicImgs = isComic && contentCache[b.id] ? (contentCache[b.id].images || []) : [];
    const comicImg = comicImgs[ch - 1] || null;
    /* 宽屏两台并排：一张一页的漫画在 27 寸屏上会缩成细长纸带，
       两图并排正好接近实体书的对开。没有下一张时不硬拆，免得留半屏空白。 */
    const comicTwo = isComic && wantCols() === 2 && !!comicImgs[ch];
    const comicNext = comicTwo ? comicImgs[ch] : null;
    ui.comicPer = comicTwo ? 2 : 1;
    /* 只有一句提示时分页没有意义，直接走滚动布局 */
    const flip = state.settings.pageMode === 'flip' && !errMsg && !isComic;
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
          ${errMsg ? errBlock : (isComic
            ? `<div class="comic-page${comicTwo ? ' dual' : ''}" data-ch="${ch}" data-per="${comicTwo ? 2 : 1}">
                ${comicImg ? `<img id="comicImg" src="${comicImg}" alt="第 ${ch} 图" draggable="false">`
                  : '<div class="reader-error"><p>这一图没能读取，请重新导入这卷</p></div>'}
                ${comicNext ? `<img class="comic-img2" src="${comicNext}" alt="第 ${ch + 1} 图" draggable="false">` : ''}
               </div>
               <div class="comic-tools" id="comicTools">
                 <button class="btn btn-ghost btn-sm" data-action="comic-zoom" data-val="-" title="缩小">−</button>
                 <button class="btn btn-ghost btn-sm" data-action="comic-zoom" data-val="fit" title="适应宽度">适应</button>
                 <button class="btn btn-ghost btn-sm" data-action="comic-zoom" data-val="+" title="放大">＋</button>
                 <button class="btn btn-ghost btn-sm" data-action="comic-crop" title="切边：跳过留白">切边</button>
               </div>`
            : paras.map((p, j) => `<p class="${p.indexOf('（本章完') === 0 ? 'end-note' : ''}" data-pi="${j}">${highlightHtml(p, b.id, ch, j, hidx)}</p>`).join(''))}
          ${notes.length && !errMsg ? `<button class="ch-notes-entry" data-action="open-notes">${icon('list', 'ic-sm')} 注释 · ${notes.length} 条</button>` : ''}
          ${state.settings.pageMode === 'para' ? `<div class="para-nav">
            <button class="btn btn-ghost btn-sm" data-action="para-prev">${icon('left', 'ic-sm')} 上一段</button>
            <span id="paraTip">—</span>
            <button class="btn btn-ghost btn-sm" data-action="para-next">下一段 ${icon('right', 'ic-sm')}</button>
          </div>` : ''}
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
        <button class="rb-mbtn" data-action="auto-page" id="autoPageBtn" title="自动翻页">${icon('play')}<span>自动翻页</span></button>
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
    /* 章名字体可单独选，留空则随正文 */
    paper.style.setProperty('--chapter-ff', state.settings.chapterFont
      ? (FONT_STACKS[state.settings.chapterFont] || FONT_STACKS.song) : 'inherit');
    paper.style.setProperty('--hl-underline', (state.settings.underlineWidth || 1) + 'px');
    /* 段距 / 首行缩进：老存档没有这两项，缺省就是原来的 1.1em + 缩进两字 */
    paper.style.setProperty('--para-gap', (Number(state.settings.paraGap) || 1.1) + 'em');
    paper.style.setProperty('--indent', state.settings.indent === false ? '0' : '2em');
    r.dataset.paper = state.settings.paper;
  }
  /* A6 按段落：滚动布局上一次显示 3 段，用 class 控制显隐（不用 hidden，
     免得和高亮刷新按 data-pi 查找打架）。不改变已有滚动 / 翻页模式。 */
  const PARA_PER_GROUP = 3;
  function paraGroupCount() {
    const n = $$('#readerPaper p[data-pi]').length;
    return Math.max(1, Math.ceil(n / PARA_PER_GROUP));
  }
  function applyParaGroup() {
    const body = $('#readerBody'); if (!body) return;
    const ps = $$('#readerPaper p[data-pi]');
    const total = paraGroupCount();
    if (ui.paraGroup < 0) ui.paraGroup = 0;
    if (ui.paraGroup >= total) ui.paraGroup = total - 1;
    ps.forEach((el, i) => {
      el.classList.toggle('para-hidden', Math.floor(i / PARA_PER_GROUP) !== ui.paraGroup);
    });
    const tip = $('#paraTip');
    if (tip) tip.textContent = (ui.paraGroup + 1) + ' / ' + total + ' 组';
  }
  function flipParaGroup(dir) {
    const total = paraGroupCount();
    const next = ui.paraGroup + dir;
    const bid = readerRoot.dataset.currentBook;
    const ch = Number(readerRoot.dataset.currentCh) || 1;
    if (next >= total) {
      if (ch < chapterList(getBook(bid)).length) { ui.paraGroup = 0; switchChapter(bid, ch + 1); }
      else toast('已经是最后一章了');
      return;
    }
    if (next < 0) {
      if (ch > 1) { ui.paraGroup = 9999; switchChapter(bid, ch - 1); }
      else toast('已经是第一章了');
      return;
    }
    ui.paraGroup = next;
    applyParaGroup();
    const body = $('#readerBody'); if (body) body.scrollTop = 0;
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
    m.style.setProperty('--para-gap', (Number(state.settings.paraGap) || 1.1) + 'em');
    m.style.setProperty('--indent', state.settings.indent === false ? '0' : '2em');
    document.body.appendChild(m);
    const clsOf = (type) => (type === 'end' ? 'end-note' : type === 'no' ? 'reader-chapter-no' : type === 'notes' ? 'ch-notes-entry' : '');
    const nodeOf = (type) => document.createElement(type === 'h1' ? 'h1' : type === 'no' ? 'div' : 'p');
    const setIndent = (el, type, indent) => {
      if (type === 'p' || type === 'end' || type === 'notes') el.style.textIndent = indent ? 'var(--indent, 2em)' : '0';
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
    const key = [bookId, ch, W, H, st.fs, st.lh, st.font, st.paper,
      Number(st.paraGap) || 1.1, st.indent === false ? 0 : 1, flipSig(items)].join('|');
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
  /* ---------- 宽屏双栏 ----------
     宽屏上一屏只摆一页，中间大片留白，翻得也快。双栏把一屏当两页使：
     分页按「半宽」量，翻页步长变成两页，页脚写成「3–4 / 12」。
     per 由当前版面宽度决定（设置里可选单栏 / 双栏 / 自动），不跨章缓存。 */
  const SPREAD_GAP = 56;
  function flipPer() { return flipState.per || 1; }
  function flipLastStart() {
    const n = flipState.pages.length, per = flipPer();
    return n ? Math.floor((n - 1) / per) * per : 0;
  }
  /* 一屏该摆几页：看视口宽度而不是纸张宽度——纸张宽度正是这里决定的。
     宽屏双栏要放宽纸张上限（720 → 1180），否则两栏各只剩 290px，比手机还窄。 */
  function wantCols() {
    const m = state.settings.columns || 'auto';
    if (m === 'one') return 1;
    const vw = window.innerWidth || document.documentElement.clientWidth || 9999;
    return vw >= (m === 'two' ? 760 : 1000) ? 2 : 1;
  }
  /* 漫画双图并排时一次翻两图，否则会绊在已被并排显示的那张上 */
  function comicPer() {
    const pg = $('.comic-page');
    return pg ? Number(pg.dataset.per || 1) : 1;
  }
  /* 上下图/上下章共用：漫画按「屏」走，文字按章走。
     并排显示到最后一屏时，再点下一章不该把自己重渲染成落单的最后一张。 */
  function comicGo(dir) {
    const id = readerRoot.dataset.currentBook; if (!id) return;
    const ch = Number(readerRoot.dataset.currentCh) || 1;
    const comic = !!$('.comic-page');
    if (!comic) { switchChapter(id, ch + dir); return; }
    const total = chapterList(getBook(id)).length;
    const next = ch + dir * comicPer();
    if (next < 1) { toast('已经是第一图了'); return; }
    if (next > total) { toast('已经是最后一图了'); return; }
    switchChapter(id, next);
  }
  /* 栏数定了才能量宽：类加上去之后再读 clientWidth，只触发一次布局 */
  function applyCols(per) {
    const paper = $('#readerPaper');
    if (paper) paper.classList.toggle('dual', per === 2);
    return per;
  }
  /* 分页 + 定栏数走一处：短章（只有一页）硬拆两栏会留半屏空白，
     这时退回单栏整幅排版；栏数一变纸张宽也变，宽度得重新量。 */
  function paginateFlip(fp, items, H, bookId, ch) {
    let per = applyCols(wantCols());
    let W = fp.clientWidth;
    let colW = per === 2 ? Math.max(160, Math.floor((W - SPREAD_GAP) / 2)) : W;
    let pages = paginateCached(items, colW, H, bookId, ch);
    if (per === 2 && pages.length < 2) {
      per = applyCols(1);
      W = fp.clientWidth;
      colW = W;
      pages = paginateCached(items, W, H, bookId, ch);
    }
    return { pages, per, colW };
  }
  function spreadInner(pos) {
    const per = flipPer();
    if (per !== 2) return pageInner(pos);
    const colW = flipState.colW || 0;
    return `<div class="flip-spread" style="--col-w:${colW}px">`
      + `<div class="flip-col">${pageInner(pos)}</div>`
      + `<div class="flip-col">${pageInner(pos + 1)}</div></div>`;
  }
  /* 落定某一页：换内容、页脚、进度。直接跳页与动画收尾都走这里 */
  function commitPage(pos) {
    const fp = $('#flipPage'); if (!fp) return;
    const per = flipPer(), n = flipState.pages.length;
    /* 双栏时 page 永远停在「一屏的第一页」，跳页 / 进度条给来任意页码都先归位 */
    const start = Math.max(0, Math.min(flipLastStart(), Math.floor(pos / per) * per));
    flipState.page = start;
    fp.innerHTML = spreadInner(start);
    const foot = $('#flipFoot');
    if (foot) {
      const to = Math.min(start + per, n);
      const label = per > 1 && to > start + 1 ? (start + 1) + '–' + to : String(start + 1);
      foot.innerHTML = `第 ${flipState.ch} 章 · <b>${label}</b> / ${n} 页`;
    }
    /* 双栏时 page 是「一屏的第一页」，末屏起点可能小于 n-1，按它算比例才能走到 100% */
    const pct = flipLastStart() > 0 ? start / flipLastStart() : 0;
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
    adj.innerHTML = spreadInner(pos);
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
    const np = flipState.page + delta * flipPer();
    if (!fp || !adj || flipBusy || np < 0 || np > flipLastStart()) return false;
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
  /* 版面此刻到底是不是翻页：在线章取不到正文时会临时降级成滚动版，
     可设置里仍然是「左右翻页」。点击左右、空格、方向键、进度条都要按真实版面走，
     否则会推着上一本书留下的 flipState 空转，翻到页尾还会把阅读器切到另一卷去。 */
  /* 自动翻页：一个定时器统一驱动三种读墨模式，前进一步复用各自已有的逻辑。
     到最后一章末停住，不无限空转。 */
  let autoPageTimer = null;
  function autoPageStop() {
    if (autoPageTimer) { clearInterval(autoPageTimer); autoPageTimer = null; }
    ui.autoPage = false;
    syncReaderMenu();
  }
  function autoPageStep() {
    if (!$('#reader')) { autoPageStop(); return; }
    const mode = readerRoot.dataset.mode;
    if (mode === 'para') { flipParaGroup(1); return; }
    if (mode === 'flip') {
      if (flipState.pages.length && flipState.page < flipLastStart()) {
        commitPage(flipState.page + flipPer());
      } else {
        const id = readerRoot.dataset.currentBook, ch = Number(readerRoot.dataset.currentCh) || 1;
        const b = getBook(id);
        if (b && ch < chapterList(b).length) switchChapter(id, ch + 1);
        else autoPageStop();
      }
      return;
    }
    /* 滚动：滚一屏；到底则下一章，末章停 */
    const body = $('#readerBody');
    if (!body) return;
    const max = Math.max(0, body.scrollHeight - body.clientHeight);
    if (body.scrollTop + 2 < max) { scrollReaderBody(body, body.clientHeight * 0.86, false); return; }
    const id = readerRoot.dataset.currentBook, ch = Number(readerRoot.dataset.currentCh) || 1;
    const b = getBook(id);
    if (b && ch < chapterList(b).length) switchChapter(id, ch + 1);
    else autoPageStop();
  }
  function autoPageToggle() {
    if (ui.autoPage) { autoPageStop(); return; }
    ui.autoPage = true;
    if (autoPageTimer) clearInterval(autoPageTimer);
    autoPageTimer = setInterval(autoPageStep, Math.max(1000, ui.autoPageMs || 6000));
    syncReaderMenu();
    toast('自动翻页已开启 · 每 ' + Math.round((ui.autoPageMs || 6000) / 1000) + ' 秒一页，再点按钮停止');
  }

  function readerFlipMode() {
    return !!$('#reader') && readerRoot.dataset.mode === 'flip';
  }
  function flipBy(delta) {
    const fs = flipState;
    if (!fs.pages.length || flipBusy) return;
    /* 页码状态必须属于当前这一卷这一章：降级版面、刚换章、换卷的空档里都可能对不上 */
    if (fs.id !== readerRoot.dataset.currentBook || fs.ch !== (Number(readerRoot.dataset.currentCh) || 1)) return;
    const np = fs.page + delta * flipPer();
    const totalCh = chapterList(getBook(fs.id)).length;
    if (np < 0) {
      if (fs.ch > 1) { ui.flipHint = 'last'; ui.flipDir = 'prev'; switchChapter(fs.id, fs.ch - 1); }
      else toast('已经是第一页了');
      return;
    }
    if (np > flipLastStart()) {
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
    L.adj.innerHTML = spreadInner(dir > 0 ? pos : cur);
    L.fp.innerHTML = spreadInner(dir > 0 ? cur : pos);
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
    const np = flipState.page + delta * flipPer();
    if (np < 0 || np > flipLastStart()) return false;
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
    const target = flipState.page + dir * flipPer();
    const go = done && target >= 0 && target <= flipLastStart();
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
      if (d && d.active) { abortDrag(); return; }
      if (d) d = null;
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
      const npWant = flipState.page + want * flipPer();
      if (want !== d.dir && Math.abs(ev.clientX - d.x) > 20 && npWant >= 0 && npWant <= flipLastStart()) {
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
    /* 第二根手指按下来（或驱动重复派发 pointerdown）时，前一次跟手必须先安全收尾：
       直接覆盖 d 会让铺好的邻页图层永远留着，flipSwiped 也没人复位，下一次点按
       会被当成「松手那下 click」吞掉。只清理、不提交页码。 */
    const abortDrag = () => {
      const cur = d; d = null;
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      body.classList.remove('flip-dragging');
      if (!cur || !cur.active) return;
      if (cur.mode === 'real') realClear(); else clearAdj();
      const fp = $('#flipPage'); if (fp) fp.style.transform = '';
      ui.flipSwiped = true;
      setTimeout(() => { ui.flipSwiped = false; }, 350);
    };
    const end = (ev) => {
      if (!d) return;
      const cur = d; d = null;
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      body.classList.remove('flip-dragging');
      const cancelled = ev.type === 'pointercancel';
      const raw = cancelled ? cur.lastX : ev.clientX;
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
      /* dx 必须落在目标页那一侧（dir=1 时是负数），往回拖不管拖多远都是弹回。
         pointercancel 是系统掐断手势（来电 / 切后台 / 系统返回手势），不是用户
         松手：只能弹回，绝不能按最后位移判定成甩页并写进度。 */
      const toward = dx * -cur.dir > 0;
      flipDragSettle(cur.dir, dx, cur.W, !cancelled && toward && Math.abs(dx) > 14 && (far || flick));
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
    const target = flipState.page + dir * flipPer();
    const go = done && target >= 0 && target <= flipLastStart();
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
      inner = flipState.page / Math.max(1, flipLastStart());
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
    const ap = $('#autoPageBtn');
    if (ap && ap.dataset.on !== String(!!ui.autoPage)) {
      ap.dataset.on = String(!!ui.autoPage);
      ap.classList.toggle('is-on', !!ui.autoPage);
      ap.innerHTML = icon(ui.autoPage ? 'pause' : 'play')
        + `<span>${ui.autoPage ? '停止翻页' : '自动翻页'}</span>`;
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
    if (readerFlipMode() && flipState.pages.length) {
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
    /* 笔记列表按批渲染，命中可能落在还没渲染的后面几百条里。当前批次一条都没中
       时去全量找一遍；真有命中就把 limit 放到覆盖它，重渲染后本函数会再跑一次，
       那时 shown>0 便不再扩张，不会递归。 */
    if (!shown && (q || bk || col)) {
      let total = 0, hitTotal = 0;
      Object.keys(state.annotations || {}).forEach((bid) => {
        (state.annotations[bid] || []).forEach((a) => {
          total += 1;
          if ((bk && bid !== bk) || (col && (a.color || 'red') !== col)) return;
          const bt = (getBook(bid) || {}).title || '已删除的卷';
          const hay = (bt + ' ' + a.text + ' ' + (a.note || '') + ' 第' + a.ch + '章').toLowerCase();
          if (!q || hay.includes(q)) hitTotal += 1;
        });
      });
      if (hitTotal && ui.noteLimit < total) {
        ui.noteLimit = total;
        const pos = ($('#noteSearch') || {}).selectionStart;
        rerender();
        const inp = $('#noteSearch');
        if (inp) { inp.focus({ preventScroll: true }); if (pos != null) inp.setSelectionRange(pos, pos); }
        return;
      }
    }
    const nm = $('#noteNoMatch'); if (nm) nm.hidden = shown > 0;
    const clr = $('.shelf-search-clear'); if (clr) clr.hidden = !ui.noteSearch;
    if (ui.noteMulti) {
      /* 筛掉的条目要从勾选集合里去掉：否则「已选 N 条」包含看不见的笔记，
         点删除会把它们一起删掉，属于静默数据丢失。 */
      const visible = new Set();
      $$('[data-note-item]').forEach((el) => { if (!el.hidden) visible.add(el.dataset.noteKey); });
      ui.notePicked.forEach((k) => { if (!visible.has(k)) ui.notePicked.delete(k); });
      syncNotePickBar();
    }
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
      /* applyNoteFilter 读的是 DOM 上的 data-note-color，只改圆点会让刚改完色的
         笔记在新颜色筛选下永远找不到（数据还在，界面里却筛不出来） */
      el.dataset.noteColor = col;
    });
    /* chip 的计数与 disabled 是渲染时算死的，改完色要跟着刷新，
       否则「青竹 0」仍是禁用态，用户连这个筛选都点不进去 */
    const cnt = { red: 0, jade: 0, gold: 0 };
    $$('[data-note-item]').forEach((el) => {
      const c = el.dataset.noteColor || 'red';
      if (c in cnt) cnt[c] += 1;
    });
    $$('.note-color-row .chip[data-val]').forEach((chip) => {
      const k = chip.dataset.val;
      if (!(k in cnt)) return;
      chip.textContent = NOTE_COLORS[k] + ' ' + cnt[k];
      chip.disabled = cnt[k] === 0;
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
      page: readerRoot.dataset.mode === 'flip' ? flipState.page : 0
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
    rate: 1, voiceURI: '', voice2URI: '', slot: 'nar', timerMin: 0, timerAt: 0, scope: 'book', fadeOut: false,
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
      /* 旁白和对话选中的那两个永远留着，否则同类音色会被去重成只剩一个，
         用户选完对话音色再打开面板，那个音色就「不见了」 */
      if (listen.voiceURI && v.voiceURI === listen.voiceURI) return true;
      if (listen.voice2URI && v.voiceURI === listen.voice2URI) return true;
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
  /* 分角色朗读：引号里的话换另一个音色念。
     对话音色丢了（换设备 / 卸载语音包）就退回旁白音色，不至于突然没声。 */
  function listenDialogueOn() { return !!listen.voice2URI; }
  function listenVoiceFor(dia) {
    if (!dia || !listen.voice2URI) return listenPickVoice();
    const vs = listenVoices();
    return vs.find((x) => x.voiceURI === listen.voice2URI) || listenPickVoice();
  }
  function fmtTime(sec) {
    sec = Math.max(0, Math.round(sec));
    return String(Math.floor(sec / 60)).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0');
  }
  /* 切句：先按段落，再按句末标点；超过 90 字的再用逗号收短，
     免得一句话合成十几秒，暂停和跳句都变迟钝。
     顺带标出「这句是不是引号里的话」——分角色朗读靠它换音色。 */
  const SENT_RE_SRC = '[^。！？；!?;…]+[。！？；!?;…」』”’"]*';
  const QUOTE_RE = /「[^」]*」|『[^』]*』|“[^”]*”|"[^"]*"|‘[^’]*’/g;
  function listenSplit(parts) {
    const sents = [];
    let offset = 0;
    /* 一段文字按句末标点断句，dia 标记整段断出来的句子是不是对白 */
    const pushSeg = (text, base, pi, dia) => {
      const re = new RegExp(SENT_RE_SRC, 'g');
      let m;
      while ((m = re.exec(text)) !== null) {
        const seg = m[0];
        if (!seg.trim()) continue;
        const at = base + m.index;
        if (seg.length > 90) {
          let cursor = 0;
          /* 不用后顾断言：旧 Safari / 老 WebView 解析整段脚本时会直接抛 SyntaxError */
          (seg.match(/[^，、：,:]*[，、：,:]|[^，、：,:]+/g) || []).forEach((piece) => {
            if (!piece) return;
            sents.push({ t: piece, start: at + cursor, para: pi, dia });
            cursor += piece.length;
          });
        } else {
          sents.push({ t: seg, start: at, para: pi, dia });
        }
      }
    };
    parts.forEach((p, pi) => {
      /* 只认成对的引号；落单的引号当普通文字，免得后半段全被当成对白 */
      const re = new RegExp(QUOTE_RE.source, 'g');
      let last = 0, m;
      while ((m = re.exec(p)) !== null) {
        if (m.index > last) pushSeg(p.slice(last, m.index), offset + last, pi, false);
        const raw = m[0];
        const lead = raw.length - raw.replace(/^[「『“‘"]/, '').length;
        const tail = raw.length - raw.replace(/[」』”’"]$/, '').length;
        const inner = raw.slice(lead, raw.length - tail);
        /* 引号本身不念出来，只念里面的字 */
        if (inner.trim()) pushSeg(inner, offset + m.index + lead, pi, true);
        last = m.index + raw.length;
      }
      if (last < p.length) pushSeg(p.slice(last), offset + last, pi, false);
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
    /* 迷你条常显定时剩余：后台听书时不用展开就知道还有多久停 */
    const lmTimer = $('#lmTimer');
    if (lmTimer) {
      const on = !!listen.timerMin && !!listen.timerAt;
      lmTimer.hidden = !on;
      if (on) lmTimer.textContent = listen.fadeOut ? '收尾' : '⏱' + Math.max(1, Math.ceil((listen.timerAt - Date.now()) / 60000)) + '分';
    }
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
    /* 按真实版面：降级成滚动版时别再往翻页那条路上撞 */
    if (readerFlipMode()) { listenFlipFollow(); return; }
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
          /* 这里拿的是 openAudioDB() 缓存的共享连接，绝不能 close：关掉之后
             所有 audioIDB 的 transaction 都会抛 InvalidStateError 并被静默吞掉，
             第 20 句起缓存全废，同一句反复重新合成（重复计费）。 */
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
    const v = listenVoiceFor(!!s.dia); if (v) u.voice = v;
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
        <span class="lm-timer" id="lmTimer" hidden></span>
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
      const slot = listen.slot === 'dia' && listen.voice2URI ? 'dia' : 'nar';
      const curURI = slot === 'dia' ? listen.voice2URI : listen.voiceURI;
      const row = (v, no) => `<div class="lp-row">
          <button class="lp-item ${curURI === v.voiceURI ? 'active' : ''}" data-action="listen-voice" data-val="${esc(v.voiceURI)}" title="${esc(v.name)}">${voiceLabel(v)}<small>${voiceLangShort(v)} · ${no + 1}</small></button>
          <button class="lp-try" data-action="listen-voice-try" data-val="${esc(v.voiceURI)}" title="试听这个音色">${icon('volume', 'ic-sm')}</button>
        </div>`;
      const group = (title, list) => list.length
        ? `<div class="lp-group">${title}</div><div class="lp-list">${list.map(row).join('')}</div>`
        : '';
      /* 分角色：引号里的话换一个音色念。只有设备里至少两个中文音色时才有意义，
         否则点「对话」也挑不出不同的声音，白占一行。 */
      const nameOf = (uri) => {
        const hit = vs.concat(g.other).find((x) => x.voiceURI === uri);
        return hit ? voiceLabel(hit) : '未选';
      };
      const dualReady = vs.length >= 2;
      const slotBar = dualReady
        ? `<div class="lp-group">分角色朗读</div><div class="rs-pills lp-slots">
            <button class="rs-pill ${!listen.voice2URI ? 'active' : ''}" data-action="listen-slot" data-val="off">关闭<small>一个音色念全篇</small></button>
            <button class="rs-pill ${listen.voice2URI && slot === 'nar' ? 'active' : ''}" data-action="listen-slot" data-val="nar">旁白<small>${esc(nameOf(listen.voiceURI))}</small></button>
            <button class="rs-pill ${listen.voice2URI && slot === 'dia' ? 'active' : ''}" data-action="listen-slot" data-val="dia">对话<small>${listen.voice2URI ? esc(nameOf(listen.voice2URI)) : '引号里的话'}</small></button>
          </div>`
        : '';
      /* 提示放列表上方：面板高度有限，放下面要滚动才看得见 */
      p.innerHTML = head('音色 · ' + (g.zh.length + g.other.length) + ' 个') + onlineBtn + slotBar + tip
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
    listen.voice2URI = state.settings.voice2URI || '';
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
    /* 用「当前页第一个字在全章的偏移」当锚点。字号一变页数全变，
       按页码比例定位会漂到别处，按字数锚点能稳稳停在原来读到的那句话上。 */
    const anchor = flipCharOffset(flipState.pages, flipState.page);
    applyCols(wantCols());
    const W = fp.clientWidth, H = fp.clientHeight;
    if (W < 60 || H < 80) return;
    const pg = paginateFlip(fp, flipItems(b, flipState.ch), H, b.id, flipState.ch);
    flipState.pages = pg.pages;
    flipState.per = pg.per;
    flipState.colW = pg.colW;
    flipState.page = flipPageAtOffset(pg.pages, anchor);
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
    const isFlip = readerFlipMode();
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
      applyCols(wantCols());
      const W = fp.clientWidth, H = fp.clientHeight;
      if (W < 60 || H < 80) return;
      const pg = paginateFlip(fp, flipItems(b, ch), H, b.id, ch);
      const pages = pg.pages;
      let page = 0;
      if (ui.flipHint === 'last') page = pages.length - 1;
      else if (pr && pr.ch === ch && pr.pct > 0) page = Math.min(pages.length - 1, Math.round(pr.pct * (pages.length - 1)));
      if (ui.flipTargetPage != null) { page = Math.min(pages.length - 1, ui.flipTargetPage); ui.flipTargetPage = null; }
      ui.flipHint = null;
      flipState = { pages, page, id: b.id, ch, per: pg.per, colW: pg.colW };
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
    let canReuse = flipMode && b.kind !== 'comic' && prevBook === id && prevMode === 'flip' && !!$('#reader') && !!$('#flipPage');
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
    readerRoot.dataset.mode = flipMode ? 'flip' : (state.settings.pageMode === 'para' ? 'para' : 'scroll');
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
    if (readerRoot.dataset.mode === 'para') { ui.paraGroup = 0; applyParaGroup(); }
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
    if (autoPageTimer) { clearInterval(autoPageTimer); autoPageTimer = null; ui.autoPage = false; }
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
        <div class="rs-row"><label>段距</label><div class="rs-pills">${[[0.55, '紧凑'], [1.1, '适中'], [1.7, '疏朗']].map(([g, l]) =>
          `<button class="rs-pill ${(Number(state.settings.paraGap) || 1.1) === g ? 'active' : ''}" data-action="set-paragap" data-val="${g}">${l}</button>`).join('')}</div></div>
        <div class="rs-row"><label>首行缩进</label><div class="rs-pills">
          <button class="rs-pill ${state.settings.indent !== false ? 'active' : ''}" data-action="set-indent" data-val="1">缩进两字</button>
          <button class="rs-pill ${state.settings.indent === false ? 'active' : ''}" data-action="set-indent" data-val="0">不缩进</button>
        </div></div>
        <div class="rs-row"><label>纸张</label><div class="rs-pills">${paperList.map(([k, c]) =>
          `<button class="rs-pill ${state.settings.paper === k ? 'active' : ''}" data-action="set-paper" data-val="${k}"><span class="paper-dot" style="background:${c};vertical-align:middle;margin-right:6px"></span>${({ xuan: '宣纸', bamboo: '青竹', sheep: '羊皮', night: '夜墨' })[k]}</button>`).join('')}</div></div>
        <div class="rs-row"><label>读墨</label><div class="rs-pills">
          <button class="rs-pill ${state.settings.pageMode === 'flip' ? 'active' : ''}" data-action="set-pagemode" data-val="flip">左右翻页</button>
          <button class="rs-pill ${state.settings.pageMode === 'scroll' ? 'active' : ''}" data-action="set-pagemode" data-val="scroll">上下滚动</button>
          <button class="rs-pill ${state.settings.pageMode === 'para' ? 'active' : ''}" data-action="set-pagemode" data-val="para">按段落</button>
        </div></div>
        <div class="rs-row"><label>版式</label><div class="rs-pills">
          ${[['auto', '自动'], ['one', '单栏'], ['two', '双栏']].map(([k, l]) =>
            `<button class="rs-pill ${(state.settings.columns || 'auto') === k ? 'active' : ''}" data-action="set-columns" data-val="${k}">${l}</button>`).join('')}
        </div></div>
        <div class="rs-row"><label>翻页</label><div class="rs-pills">
          ${[['slide', '滑动'], ['realistic', '仿真'], ['fade', '淡入'], ['none', '无动画']].map(([k, l]) =>
            `<button class="rs-pill ${state.settings.flipAnim === k ? 'active' : ''}" data-action="set-flipanim" data-val="${k}">${l}</button>`).join('')}
        </div></div>
        <div class="rs-row"><label>章名字体</label><div class="rs-pills">
          <button class="rs-pill ${!state.settings.chapterFont ? 'active' : ''}" data-action="set-chapterfont" data-val="">随正文</button>
          ${[['song', '宋体'], ['kai', '楷体'], ['hei', '黑体']].map(([k, l]) =>
            `<button class="rs-pill ${state.settings.chapterFont === k ? 'active' : ''}" data-action="set-chapterfont" data-val="${k}">${l}</button>`).join('')}
        </div></div>
        <div class="rs-row"><label>划线粗细</label><div class="rs-pills">
          ${[1, 2, 3].map((w) => `<button class="rs-pill ${state.settings.underlineWidth === w ? 'active' : ''}" data-action="set-underline" data-val="${w}">${w}px</button>`).join('')}
        </div></div>
        <div class="rs-row"><label>净化</label><div class="rs-pills">
          <button class="rs-pill" data-action="clean-rules">正文替换规则 ${(state.settings.cleanRules || []).length ? '· ' + state.settings.cleanRules.length + ' 条' : ''}</button>
        </div></div>
        <div class="rs-row"><label>字形</label><div class="rs-pills">
          <button class="rs-pill ${!state.settings.s2t ? 'active' : ''}" data-action="set-s2t" data-val="0">简体</button>
          <button class="rs-pill ${state.settings.s2t ? 'active' : ''}" data-action="set-s2t" data-val="1">繁体</button>
        </div></div>
        <div class="rs-row"><label>自动翻页</label><div class="rs-pills">
          ${[[3000, '快'], [6000, '中'], [10000, '慢']].map(([ms, l]) =>
            `<button class="rs-pill ${ui.autoPageMs === ms ? 'active' : ''}" data-action="auto-speed" data-val="${ms}">${l}</button>`).join('')}
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
      /* 筛选只做两件真事：还没读的、记过笔记的。角标数字带上卷数，
         不用点开就知道还有多少章要读。 */
      const filt = ui.catalogFilter || 'all';
      const unreadN = Math.max(0, chs.length - (cur - 1));
      const notedN = Object.keys(noteMap).length;
      const content = kind === 'catalog'
        ? `${resumeHtml}<div class="cat-search">${icon('search', 'ic-sm')}<input id="catalogSearch" placeholder="搜章节名，或直接输入第几章" autocomplete="off"></div>
          <div class="cat-filters">
            ${[['all', '全部 ' + chs.length], ['unread', '未读 ' + unreadN], ['noted', '有笔记 ' + notedN]].map(([k, l]) =>
              `<button class="${filt === k ? 'active' : ''}" data-action="cat-filter" data-val="${k}" ${k === 'noted' && !notedN ? 'disabled' : ''}>${l}</button>`).join('')}
          </div>
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
    /* 筛选项是「粘」的：上次切到「未读」，这次打开目录仍按未读列，先把可见性过一遍，
       否则会先闪一下全量列表再收起 */
    if (kind === 'catalog' && (ui.catalogFilter || 'all') !== 'all') applyCatalogFilter();
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
    state.lastRead = id;
    /* 时间轴事件：翻章记一条，限 500 条，避免长年累积把 state 撑大 */
    state.readEvents = state.readEvents || [];
    state.readEvents.push({ t: Date.now(), id, ch });
    if (state.readEvents.length > 500) state.readEvents.splice(0, state.readEvents.length - 500);
    save();
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
    /* 只数「真拿到正文」的章：失败章在缓存里也留了一条 {paras:null,error} 记录，
       按 filter(Boolean) 数会把断网那一轮全算成已检索，进而 needNet 恒为 false，
       恢复网络后再也没有「联网检索全书 / 重试未取回」的入口。 */
    const cached = (rec && rec.chapters ? rec.chapters.filter((c) => c && c.paras && c.paras.length).length : 0);
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
         <span class="si-ch">第 ${h.ch} 章</span><span class="si-frag">${esc(h.frag)}</span>
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
    const flip = readerFlipMode();
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
      : (['book', 'search', 'category', 'rank'].includes(r.name) ? 'store'
        : (['subscribe', 'lists'].includes(r.name) ? 'me' : ui.nav));
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
      case 'subscribe': html = pageSubscribe(); break;
      case 'lists': html = pageLists(); break;
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
        if (readerFlipMode()) {
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
      case 'import-comic': $('#imageFileInput').click(); break;
      case 'comic-zoom': {
        const img = $('#comicImg'); if (!img) break;
        const cur = Number(img.dataset.zoom || 1);
        const z = val === 'fit' ? 1 : (val === '+' ? Math.min(3, cur + 0.25) : Math.max(0.5, cur - 0.25));
        /* 双图并排时两张一起缩：只放大左边那张，同屏两张大小不一，看着像排版出错 */
        $$('.comic-page img').forEach((x) => {
          x.dataset.zoom = String(z);
          x.style.transform = 'scale(' + z + ')';
        });
        break;
      }
      case 'comic-crop': {
        const pg = $('.comic-page'); if (!pg) break;
        pg.classList.toggle('cropped');
        toast(pg.classList.contains('cropped') ? '切边模式：铺满屏幕' : '适应宽度');
        break;
      }
      case 'check-sources': checkSources(); break;
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
      case 'export-volume': exportVolume(id); break;
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
      case 'webdav-config': openWebdavForm(); break;
      case 'wd-save': {
        state.webdav = {
          url: (($('#wdUrl') || {}).value || '').trim(),
          user: (($('#wdUser') || {}).value || '').trim(),
          pass: ($('#wdPass') || {}).value || ''
        };
        save(); webdavUpload();
        break;
      }
      case 'wd-download': {
        state.webdav = Object.assign({}, state.webdav, {
          url: (($('#wdUrl') || {}).value || '').trim(),
          user: (($('#wdUser') || {}).value || '').trim(),
          pass: ($('#wdPass') || {}).value || ''
        });
        save(); webdavDownload();
        break;
      }
      case 'list-add': openListEditor('add'); break;
      case 'list-rename': openListEditor('rename', id); break;
      case 'list-pick': openListEditor('pick', id); break;
      case 'list-save': {
        const name = (($('#listNameInput') || {}).value || '').trim();
        if (!name) { toast('书单名称必填'); break; }
        if (val) {
          const l = (state.lists || []).find((x) => x.id === val);
          if (l) l.name = name;
        } else {
          state.lists = state.lists || [];
          state.lists.push({ id: 'list-' + Date.now().toString(36), name, bookIds: [] });
        }
        save(); closeSourceEditor(); rerender(); toast('书单已保存');
        break;
      }
      case 'list-add-book': {
        const l = (state.lists || []).find((x) => x.id === id);
        const bookId = val;
        if (!l || !bookId) break;
        l.bookIds = l.bookIds || [];
        if (!l.bookIds.includes(bookId)) l.bookIds.unshift(bookId);
        save(); closeSourceEditor(); toast('已加入《' + l.name + '》');
        break;
      }
      case 'list-del': {
        const l = (state.lists || []).find((x) => x.id === id);
        if (!l || !confirm('删除书单《' + l.name + '》？书本身不会删除。')) break;
        state.lists = state.lists.filter((x) => x.id !== id);
        save(); rerender(); toast('书单已删除');
        break;
      }
      case 'switch-source': openSwitchSource(id); break;
      case 'switch-source-to': switchSourceTo(id); break;
      case 'sub-add': openSubForm(); break;
      case 'sub-edit': openSubForm(id); break;
      case 'sub-refresh': refreshSub(id); break;
      case 'sub-form-save': {
        const g = (sid) => ($('#' + sid) || {}).value || '';
        const cfg = { id: g('sbId').trim(), name: g('sbName').trim(), url: g('sbUrl').trim(),
          ruleArticles: g('sbArticles').trim(), ruleTitle: g('sbTitle').trim(), ruleLink: g('sbLink').trim() };
        if (!cfg.id || !cfg.name || !cfg.url) { toast('标识、名称、地址必填'); break; }
        if (!/^[a-zA-Z0-9_-]+$/.test(cfg.id)) { toast('标识只能用英文、数字、下划线和短横线'); break; }
        const subs = state.subscriptions || (state.subscriptions = []);
        const i = subs.findIndex((s) => s.id === cfg.id);
        if (i >= 0) subs[i] = Object.assign({}, subs[i], cfg, { enabled: true });
        else subs.push(Object.assign({ enabled: true }, cfg));
        closeSourceEditor();
        save(); refreshSub(cfg.id);
        toast('订阅源已保存：' + cfg.name);
        break;
      }
      case 'sub-open': {
        /* 按 key 直接找文章：从缓存的各订阅源列表里取，不靠 Object.keys 遍历
           （错误条目存在 subCache[id+':error']，是字符串，some 会抛 TypeError）。 */
        let a = null;
        for (const sid of (state.subscriptions || []).map((s) => s.id)) {
          const hit = (subCache[sid] || []).find((x) => x.key === val);
          if (hit) { a = hit; break; }
        }
        if (!a) break;
        state.subRead[val] = true; save();
        window.open(a.url, '_blank', 'noopener,noreferrer');
        rerender();
        break;
      }
      case 'sub-toggle-read': {
        if (state.subRead[val]) delete state.subRead[val]; else state.subRead[val] = true;
        save(); rerender();
        break;
      }
      case 'add-source': openSourceForm(); break;
      case 'add-source-js': openSourceEditor(); break;
      case 'proxy-save': {
        const inp = $('#proxyUrlInput');
        let v = (inp ? inp.value : '').trim().replace(/\/+$/, '');
        if (v && !/^https?:\/\//i.test(v)) { toast('代理地址要以 http:// 或 https:// 开头'); break; }
        state.proxyUrl = v;
        save();
        toast(v ? '本地代理已设置：' + v : '已关闭本地代理');
        break;
      }
      case 'import-source-json': $('#sourceFileInput').click(); break;
      case 'export-sources': exportSources(); break;
      case 'source-edit': openSourceForm(id); break;
      case 'source-switch-js': {
        const g = (sid) => ($('#' + sid) || {}).value || '';
        const cfg = { id: g('sfId').trim(), name: g('sfName').trim(), group: g('sfGroup').trim(),
          listUrl: g('sfListUrl').trim(), bookList: g('sfBookList').trim(), bookTitle: g('sfBookTitle').trim(),
          bookLink: g('sfBookLink').trim(), chapterList: g('sfChapterList').trim(), content: g('sfContent').trim(),
          defaultAuthor: g('sfAuthor').trim(), replaceRegex: g('sfReplace').trim() };
        closeSourceEditor();
        openSourceEditor();
        const ta = $('#sourceCode');
        if (ta && cfg.id) ta.value = '/* mj-visual:' + cfg.id + ' */MJ.sources.register(MJ.sourceKit.makeSource(' + JSON.stringify(cfg) + '));';
        break;
      }
      case 'source-form-save': {
        let built;
        try { built = sourceCodeFromForm(); }
        catch (e) { toast(e.message || '表单填写有误'); break; }
        const r = runSourceCodeSafe(built.code);
        if (r.err) { toast('书源接入失败：' + (r.err.message || '未知错误')); break; }
        /* 同 id 覆盖时引用也会变；完全没变说明没真正注册 */
        const changed = r.after.length !== r.before.length || r.after.some((s, i) => s !== r.before[i]);
        if (!changed) { toast('书源没有生效'); break; }
        const mark = '/* mj-visual:' + built.cfg.id + ' */';
        saveCustomSources([...customSources().filter((c) => c.indexOf(mark) < 0), built.code]);
        closeSourceEditor();
        (async () => { await SRC.refresh(); renderNav(ui.nav); rerender(); })();
        toast('书源已接入：' + built.cfg.name);
        break;
      }
      case 'source-dry-run': dryRunSource(); break;
      case 'source-close': closeSourceEditor(); break;
      case 'source-save': {
        const ta = $('#sourceCode');
        const code = ta ? ta.value.trim() : '';
        if (!code) { toast('先写点代码'); break; }
        /* register 覆盖同 id 时列表长度和 id 都不变，只比 id 序列会把「更新书源」
           误判成「没注册」，弹层不关、代码不落盘，当前会话却是新对象——重启就退回旧版。
           改成比对象引用：新增 id 换长度，覆盖同 id 换引用。 */
        const r = runSourceCodeSafe(code);
        if (r.err) {
          toast('书源代码有误：' + (r.err.message || '未知错误'));
          /* 回滚只还原了注册表，index 里可能还留着半注册源 absorb 进来的书 */
          (async () => { await SRC.refresh(); rerender(); })();
          break;
        }
        const changed = r.after.length !== r.before.length || r.after.some((s, i) => s !== r.before[i]);
        if (!changed) { toast('这段代码没有注册任何书源（需要调用 MJ.sources.register）'); break; }
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
      case 'note-more': {
        /* 只多渲染一批，几十万条也不会一次堆出十万个节点 */
        ui.noteLimit += 200;
        const was = restorableFocus();
        rerender();
        const inp = $('#noteSearch');
        if (inp) { inp.focus({ preventScroll: true }); inp.setSelectionRange(inp.value.length, inp.value.length); }
        else if (was) { const again = resolveFocus(was); if (again) again.focus({ preventScroll: true }); }
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
      case 'edit-book-note': {
        const b = getBook(id);
        if (!b) break;
        let root = $('#sourceModal');
        if (!root) { root = document.createElement('div'); root.id = 'sourceModal'; document.body.appendChild(root); }
        root.innerHTML = `<div class="modal-backdrop" data-action="source-close"></div>
          <div class="cover-editor mini-modal"><div class="ce-head"><h3>备注《${esc(b.title)}》</h3>
            <button class="icon-btn" data-action="source-close" title="关闭">${icon('close')}</button></div>
          <div class="mm-body"><label>我的备注<textarea id="bookNoteInput" rows="8" placeholder="这本书的想法、摘记、读后感受…">${esc(state.bookNotes[b.id] || '')}</textarea></label></div>
          <div class="ce-foot"><div></div><button class="btn btn-ghost" data-action="source-close">取消</button>
            <button class="btn btn-primary" data-action="save-book-note" data-id="${esc(b.id)}">保存</button></div></div>`;
        a11ySweep(root);
        break;
      }
      case 'save-book-note': {
        const txt = (($('#bookNoteInput') || {}).value || '').trim();
        if (txt) state.bookNotes[id] = txt; else delete state.bookNotes[id];
        save(); closeSourceEditor(); rerender(); toast('备注已保存');
        break;
      }
      case 'export-book-notes': {
        const entries = Object.keys(state.bookNotes || {}).filter((k) => state.bookNotes[k]);
        if (!entries.length) { toast('还没有书籍备注'); break; }
        const txt = entries.map((k) => {
          const b = getBook(k) || {};
          return '《' + (b.title || k) + '》' + (b.author ? ' · ' + b.author : '') + '\n'
            + state.bookNotes[k] + '\n';
        }).join('\n' + '—'.repeat(20) + '\n');
        const okEx = downloadText('墨卷书籍备注-' + today() + '.txt', txt);
        toast(okEx ? '备注已导出 ' + entries.length + ' 条' : '导出失败，请检查下载权限');
        break;
      }
      case 'toggle-view': state.viewMode = val; save(); rerender(); break;
      case 'set-density': state.density = val; save(); rerender(); break;
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
          fy.innerHTML = pick(allBooks().filter((b) => !state.shelf.includes(b.id)), 7).map((b) => bookCard(b, { quickAdd: true })).join('');
          a11ySweep(fy);
        }
        /* 换荐按钮本身没被替换，焦点不用特意找回来 */
        toast('换了一批荐读'); break;
      }
      case 'toggle-desc': ui.descOpen = !ui.descOpen; $('#bookDesc').classList.toggle('clamp');
        el.innerHTML = (ui.descOpen ? '收起' : '展开简介') + ' ' + icon('right', 'ic-sm'); break;
      case 'hot-word': {
        /* 输入框刚敲过字时还挂着 120ms 的防抖，不取消就会在 120ms 后用旧词
           把热词的结果区覆盖掉，输入框和结果长期对不上 */
        clearTimeout(searchTimer);
        const input = $('#searchInput');
        if (input) input.value = val;
        commitSearch(val); renderSearchBody(val); break;
      }
      case 'clear-query': { clearTimeout(searchTimer); const input = $('#searchInput'); if (input) { input.value = ''; input.focus(); } renderSearchBody(''); break; }
      case 'clear-history': clearTimeout(searchTimer); state.history = []; save(); renderSearchBody(''); toast('寻卷记录已清空'); break;
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
      case 'set-paragap': {
        state.settings.paraGap = Number(val) || 1.1; save(); restyleReader();
        if (!$('#reader')) { rerender(); break; }
        $$('#readerPanel .rs-pill').forEach((p) => { if (p.dataset.action === 'set-paragap') p.classList.toggle('active', Number(p.dataset.val) === Number(state.settings.paraGap)); });
        break;
      }
      case 'set-indent': {
        state.settings.indent = String(val) !== '0'; save(); restyleReader();
        if (!$('#reader')) { rerender(); break; }
        $$('#readerPanel .rs-pill').forEach((p) => { if (p.dataset.action === 'set-indent') p.classList.toggle('active', (p.dataset.val === '0') === (state.settings.indent === false)); });
        break;
      }
      case 'set-paper': {
        /* 夜墨既是「纸」也是「全站主题」：以前只改 paper，theme 还停在 day，
           底栏夜间按钮第一次点等于没反应（toast 说切了、纸色没变），
           而且 lastDayPaper 没记下原来的浅色纸，第二次点亮时回到的是宣纸。
           这里让两者始终同步，和 toggleNight() 的行为对齐。 */
        const prevPaper = state.settings.paper;
        state.settings.paper = val;
        if (val === 'night') {
          if (prevPaper && prevPaper !== 'night') state.settings.lastDayPaper = prevPaper;
          state.settings.theme = 'night';
        } else {
          state.settings.theme = 'day';
        }
        save(); applyTheme(); applyReaderStyle();
        if (!$('#reader')) { rerender(); break; }
        $$('#readerPanel .rs-pill').forEach((p) => { if (p.dataset.action === 'set-paper') p.classList.toggle('active', p.dataset.val === val); });
        break;
      }
      case 'set-columns': {
        state.settings.columns = val === 'one' || val === 'two' ? val : 'auto';
        save();
        $$('#readerPanel .rs-pill').forEach((p) => { if (p.dataset.action === 'set-columns') p.classList.toggle('active', p.dataset.val === state.settings.columns); });
        /* 栏数变了就得按新宽度重新分页，页码会变，锚点仍在当前页首字上 */
        if ($('#reader')) reflowFlip();
        break;
      }
      case 'set-pagemode':
        state.settings.pageMode = val; save();
        if ($('#reader')) {
          closePanel();
          showReader(readerRoot.dataset.currentBook, Number(readerRoot.dataset.currentCh));
        } else rerender();
        break;
      case 'para-prev': flipParaGroup(-1); break;
      case 'para-next': flipParaGroup(1); break;
      case 'set-flipanim':
        state.settings.flipAnim = val; save();
        if (val !== 'slide') { realClear(); clearAdj(); }
        $$('#readerPanel .rs-pill').forEach((p) => { if (p.dataset.action === 'set-flipanim') p.classList.toggle('active', p.dataset.val === val); });
        break;
      case 'set-chapterfont':
        state.settings.chapterFont = val; save(); applyReaderStyle();
        $$('#readerPanel .rs-pill').forEach((p) => { if (p.dataset.action === 'set-chapterfont') p.classList.toggle('active', p.dataset.val === val); });
        break;
      case 'set-underline':
        state.settings.underlineWidth = Number(val) || 1; save(); applyReaderStyle();
        $$('#readerPanel .rs-pill').forEach((p) => { if (p.dataset.action === 'set-underline') p.classList.toggle('active', Number(p.dataset.val) === state.settings.underlineWidth); });
        break;
      case 'clean-rules': {
        let root = $('#sourceModal');
        if (!root) { root = document.createElement('div'); root.id = 'sourceModal'; document.body.appendChild(root); }
        const rules = (state.settings.cleanRules || []);
        const lines = rules.map((r) => {
          const sep = r.isRegex === false ? ' :: ' : ' => ';
          let line = r.pattern + (r.replacement ? sep + r.replacement : '');
          const meta = [];
          if (r.group) meta.push('组:' + r.group);
          if (r.scope) meta.push('源:' + r.scope);
          if (r.scopeTitle) meta.push('标题');
          if (r.isEnabled === false) meta.push('停用');
          if (meta.length) line += '    # ' + meta.join(' ');
          return line;
        }).join('\n');
        root.innerHTML = `<div class="modal-backdrop" data-action="source-close"></div>
          <div class="cover-editor mini-modal"><div class="ce-head"><h3>正文替换规则</h3>
            <button class="icon-btn" data-action="source-close" title="关闭">${icon('close')}</button></div>
          <div class="mm-body">
            <p class="mm-hint">兼容阅读 App 的净化规则。每行一条：<code>正则 =&gt; 替换</code>（删除就省略右侧）；<code>文本 :: 替换</code> 是纯文本替换。<code>#</code> 后写 组/源/标题/停用 等标记。可导入阅读导出的 JSON。</p>
            <textarea id="cleanRulesInput" rows="11" spellcheck="false" placeholder="广告.*\n第\\d+章 请收藏 =>\n本书广告 ::    # 源:my-source">${esc(lines)}</textarea>
            <p class="mm-hint">规则按顺序执行。作用范围填书源标识或书源名，多个用逗号分隔；不填则对所有书生效。</p>
          </div>
          <div class="ce-foot"><div class="rule-actions">
            <button class="btn btn-ghost btn-sm" data-action="clean-rules-import">导入 JSON</button>
            <button class="btn btn-ghost btn-sm" data-action="clean-rules-export">导出</button>
          </div>
            <button class="btn btn-ghost" data-action="source-close">取消</button>
            <button class="btn btn-primary" data-action="clean-rules-save">保存</button></div></div>`;
        a11ySweep(root);
        break;
      }
      case 'clean-rules-import': $('#ruleFileInput').click(); break;
      case 'clean-rules-export': {
        const rules = state.settings.cleanRules || [];
        if (!rules.length) { toast('还没有规则可导出'); break; }
        const okExp = downloadText('墨卷净化规则-' + today() + '.json',
          JSON.stringify({ app: 'mojuan-rules', version: 1, rules }, null, 2));
        toast(okExp ? '净化规则已导出：' + rules.length + ' 条' : '导出失败，请检查下载权限');
        break;
      }
      case 'clean-rules-save': {
        const txt = ($('#cleanRulesInput') || {}).value || '';
        const rules = parseReplaceRules(txt) || [];
        state.settings.cleanRules = rules; save(); closeSourceEditor();
        if ($('#reader')) showReader(readerRoot.dataset.currentBook, Number(readerRoot.dataset.currentCh));
        toast('净化规则已保存：' + rules.length + ' 条');
        break;
      }
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
      case 'reader-prev': comicGo(-1); break;
      case 'set-s2t': {
        state.settings.s2t = val === '1'; save();
        $$('#readerPanel .rs-pill').forEach((x) => { if (x.dataset.action === 'set-s2t') x.classList.toggle('active', (x.dataset.val === '1') === state.settings.s2t); });
        if ($('#reader')) showReader(readerRoot.dataset.currentBook, Number(readerRoot.dataset.currentCh));
        break;
      }
      case 'auto-page': autoPageToggle(); break;
      case 'auto-speed': {
        ui.autoPageMs = Math.max(1000, Number(val) || 6000);
        if (ui.autoPage) { clearInterval(autoPageTimer); autoPageTimer = setInterval(autoPageStep, ui.autoPageMs); }
        $$('#readerPanel .rs-pill').forEach((x) => { if (x.dataset.action === 'auto-speed') x.classList.toggle('active', Number(x.dataset.val) === ui.autoPageMs); });
        break;
      }
      case 'reader-next': comicGo(1); break;
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
      case 'cat-filter': setCatalogFilter(String(val) || 'all'); break;
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
        if (listen.voice2URI && listen.slot === 'dia') {
          if (val === listen.voiceURI) { toast('旁白和对话用同一个音色，等于没分开'); break; }
          listen.voice2URI = val; state.settings.voice2URI = val; save();
        } else {
          listen.voiceURI = val; state.settings.voiceURI = val;
          /* 旁白改成了对话那个音色，分角色就没有意义了，顺手关掉 */
          if (listen.voice2URI === val) { listen.voice2URI = ''; state.settings.voice2URI = ''; listen.slot = 'nar'; }
          save();
        }
        listenPanel('voice');
        if (listen.playing) listenSpeak(true);
        break;
      }
      /* 分角色朗读：打开时自动挑一个跟旁白不同的音色，选完还能在列表里改 */
      case 'listen-slot': {
        if (val === 'off') {
          listen.voice2URI = ''; state.settings.voice2URI = ''; listen.slot = 'nar'; save();
        } else {
          listen.slot = val === 'dia' ? 'dia' : 'nar';
          if (!listen.voice2URI) {
            const vs = listenVoices();
            const other = vs.find((x) => x.voiceURI !== listen.voiceURI) || vs[1];
            if (!other) { toast('这台设备只有一个中文音色，分不开角色'); break; }
            if (!listen.voiceURI) listen.voiceURI = (vs.find((x) => x.voiceURI !== other.voiceURI) || vs[0]).voiceURI;
            listen.voice2URI = other.voiceURI;
            state.settings.voiceURI = listen.voiceURI;
            state.settings.voice2URI = listen.voice2URI;
            save();
          }
        }
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
  /* 目录过滤：按章名匹配，或直接输入章号；「未读 / 有笔记」是叠在搜索之上的第二层条件。
     走 DOM hidden、不重建列表，输入焦点和滚动位置都稳；上千章也只跑一遍 forEach。 */
  function applyCatalogFilter(input) {
    const el = input || $('#catalogSearch');
    if (!el) return 0;
    const q = el.value.trim().toLowerCase();
    const num = parseInt(q, 10);
    const filt = ui.catalogFilter || 'all';
    let shown = 0;
    $$('#catalogList li').forEach((li) => {
      const liNum = parseInt(li.dataset.ch, 10);
      /* 只比章名：li 里还挂着「读过 / ✎N / 序号」，混进来会让搜「读」命中一大片 */
      const t = li.querySelector('.cl-title');
      const name = (t ? t.textContent : li.textContent).toLowerCase();
      const pass = filt === 'all' ? true
        : filt === 'unread' ? !li.classList.contains('read')
        : !!li.querySelector('.ch-note');
      const hit = pass && (!q || name.includes(q) || (!isNaN(num) && liNum === num));
      li.hidden = !hit;
      if (hit) shown += 1;
    });
    /* 一条不剩时把列表整体收起、让空态顶到搜索框下面，否则空列表还占着 flex 高度，
       空态提示会被顶到抽屉最底部 */
    const no = $('#catNoMatch');
    const list = $('#catalogList');
    /* 筛选也算「有条件」：切到「有笔记」时一条没有，同样要给出空态而不是一片空白 */
    const cond = !!q || filt !== 'all';
    const empty = cond && shown === 0;
    if (no) no.hidden = !empty;
    if (list) {
      list.hidden = empty;
      /* 有关键词或换了筛选才回到顶部（结果从第一条看起）；清空时保留原滚动位置 */
      if (cond) list.scrollTop = 0;
    }
    return shown;
  }
  /* 切筛选：只改状态、换高亮，列表走 hidden 复用，不重建 DOM */
  function setCatalogFilter(kind) {
    ui.catalogFilter = kind;
    $$('.cat-filters button').forEach((b) => b.classList.toggle('active', b.dataset.val === kind));
    applyCatalogFilter();
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
      /* append 到 body 的模态弹层优先关：它们开着时主干是 inert，键盘用户出不去。
         放在搜索框清空之前，否则焦点恰好在藏卷搜索框时会只清词、面板还留着。 */
      if ($('#shelfActions')) { closeShelfActions(); return; }
      if ($('#sourceModal')) { closeSourceEditor(); return; }
      /* 听卷的音色配置也在 MODAL_SELS 里：不先关它，Esc 会落到下面的
         listen.active 分支，把朗读收成迷你条甚至停掉，弹层和 inert 却还在 */
      if ($('#voiceModal')) { closeVoiceConfig(); return; }
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
    /* div 补成 button、li 保留 listitem 但补了 tabindex，两者回车/空格都得能按下去 */
    const act = document.activeElement;
    if (act && !NATIVE_CTL.test(act.tagName) && act.dataset && act.dataset.action
      && (act.getAttribute('role') === 'button' || act.hasAttribute('tabindex'))
      && (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar')) {
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
      const paging = readerFlipMode();
      /* 上下滚动模式：空格 / PageUp / PageDown / 上下键先滚正文。
         以前这些键不分模式一律「换章」，按一下空格就跳到下一章，读到哪儿全丢了。 */
      const scrollBody = paging ? null : $('#readerBody');
      if (scrollBody) {
        /* 按段落模式：空格 / 翻页键 / 左右键改成切段组，不再滚屏 */
        if (readerRoot.dataset.mode === 'para') {
          const back = e.shiftKey || e.key === 'PageUp' || e.key === 'ArrowLeft' || e.key === 'ArrowUp';
          if (e.key === ' ' || e.key === 'PageDown' || e.key === 'PageUp'
            || e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault(); flipParaGroup(back ? -1 : 1); return;
          }
        }
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
      /* 快捷键说明写了「Shift+空格 往回翻」：滚动模式上面已按 shift 处理，
         翻页模式原先完全不看 shiftKey，照说明按反而是往后翻，翻到章末还会换章 */
      if (paging && e.key === ' ' && e.shiftKey) {
        e.preventDefault(); flipBy(-1); return;
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
    if (e.target.files && e.target.files.length) handleImportFiles(e.target.files);
    e.target.value = '';
  });
  $('#imageFileInput').addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length) importComicFiles(e.target.files);
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
  $('#sourceFileInput').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) importSourceJson(f);
    e.target.value = '';
  });
  $('#ruleFileInput').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    try {
      const parsed = parseReplaceRules(await f.text());
      if (!parsed) { toast('没识别到净化规则'); }
      else {
        // 导入追加到现有规则后面，不覆盖用户已配的
        state.settings.cleanRules = (state.settings.cleanRules || []).concat(parsed);
        save();
        toast('已导入净化规则 ' + parsed.length + ' 条，点保存生效');
        // 回填文本框让用户确认
        const ta = $('#cleanRulesInput');
        if (ta) {
          ta.value = state.settings.cleanRules.map((r) => {
            const sep = r.isRegex === false ? ' :: ' : ' => ';
            let line = r.pattern + (r.replacement ? sep + r.replacement : '');
            const meta = [];
            if (r.group) meta.push('组:' + r.group);
            if (r.scope) meta.push('源:' + r.scope);
            if (r.scopeTitle) meta.push('标题');
            if (r.isEnabled === false) meta.push('停用');
            return line + (meta.length ? '    # ' + meta.join(' ') : '');
          }).join('\n');
        }
      }
    } catch (err) { toast('导入失败：' + (err.message || '文件读取错误')); }
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
    if (e.dataTransfer && e.dataTransfer.files.length) handleImportFiles(e.dataTransfer.files);
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

  let flipResizeTimer = null, comicResizeTimer = null;
  window.addEventListener('resize', () => {
    markScrollableRows($('#view'));
    if (!$('#reader')) return;
    if (state.settings.pageMode === 'flip') {
      clearTimeout(flipResizeTimer);
      flipResizeTimer = setTimeout(reflowFlip, 200);
      return;
    }
    /* 漫画卷来回跨 1000px 时单图/双图要跟着换：这里按「屏」重渲染同一图号 */
    if ($('.comic-page')) {
      clearTimeout(comicResizeTimer);
      comicResizeTimer = setTimeout(() => {
        const pg = $('.comic-page');
        const id = readerRoot.dataset.currentBook;
        if (!pg || !id) return;
        const ch = Number(readerRoot.dataset.currentCh) || 1;
        const want = wantCols() === 2 && ch < chapterList(getBook(id)).length ? 2 : 1;
        if (Number(pg.dataset.per || 1) === want) return;
        showReader(id, ch);
      }, 220);
    }
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
