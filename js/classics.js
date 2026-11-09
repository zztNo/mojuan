/* 墨卷 · 内置公版书库（离线可读，真实公有领域文本）
 * 数据分两层：
 *   js/classics-meta.js  书目元数据 + 章节标题 + 字数（约 80KB，首屏加载）
 *   js/books/<id>.js     某一本书的全部正文（打开时才取，约 20–420KB）
 * 这样首屏不必为 39 万字正文买单，而整本加载后仍可同步取任意一章。
 */
(function (global) {
  'use strict';
  const META = global.MJ_CLASSICS_META || [];
  const BY_ID = {};
  META.forEach((b) => { BY_ID[b.id] = b; });

  /* 已加载的正文：id -> [[标题, [段落…]], …] */
  const LOADED = global.MJ_BOOKS || (global.MJ_BOOKS = {});
  const PENDING = {};
  const SHARD_BASE = 'js/books/';

  /* 取一本书的正文分片；已加载或单文件版内联时直接命中 */
  function ensureBook(id) {
    if (LOADED[id]) return Promise.resolve(LOADED[id]);
    if (PENDING[id]) return PENDING[id];
    if (!BY_ID[id]) return Promise.resolve(null);
    PENDING[id] = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = SHARD_BASE + id + '.js';
      s.async = true;
      s.onload = () => { delete PENDING[id]; resolve(LOADED[id] || null); };
      s.onerror = () => { delete PENDING[id]; reject(new Error('正文分片加载失败: ' + id)); };
      document.head.appendChild(s);
    });
    return PENDING[id];
  }

  function metaFrom(b) {
    const chars = b.chars || 0;
    const cover = b.cover && b.cover.motif ? b.cover : { motif: 'cloud', seal: '墨', color: '#2E3F4A', color2: '#152128' };
    /* 元数据里的章目是纯标题串（省首屏体积），这里补回 {no,title} 结构 */
    const chs = (b.chapters || []).map((c, i) => (typeof c === 'string'
      ? { no: i + 1, title: c }
      : { no: c.no || i + 1, title: c.title || ('第' + (i + 1) + '章') }));
    return {
      id: b.id, sourceId: 'classic', title: b.title, author: b.author, category: b.category,
      status: b.status || '完结',
      desc: b.desc,
      words: (chars >= 10000 ? (chars / 10000).toFixed(1) + '万' : String(chars)) + '字',
      chars: chars,
      score: b.score || 9.2,
      readers: '公版典藏',
      hot: 45 + Math.min(45, Math.round(chars / 8000)),
      tags: (b.tags || []).slice(0, 3),
      addedAt: b.addedAt || 0,
      online: false,
      cover: cover, motif: cover.motif, color: cover.color, color2: cover.color2, seal: cover.seal,
      chapters: chs
    };
  }

  const META_CACHE = {};
  function metaOf(id) {
    if (!META_CACHE[id] && BY_ID[id]) META_CACHE[id] = metaFrom(BY_ID[id]);
    return META_CACHE[id] || null;
  }

  const source = {
    id: 'classic', name: '墨卷公版书库', desc: '内置中国古典公版书，全书离线可读',
    online: false, enabled: true,
    /* 书目同步可用，所以首屏不用等任何网络 */
    metasSync() { return META.map((b) => metaOf(b.id)); },
    async metas() { return this.metasSync(); },
    async getBookMeta(id) { return metaOf(id); },
    /* 正文：分片已加载时同步返回，否则 null（调用方走 getChapter 异步取） */
    getChapterSync(id, no) {
      const bk = LOADED[id];
      const c = bk && bk[no - 1];
      const ps = c && c[1];
      return ps && ps.length ? ps : null;
    },
    async getChapter(id, no) {
      const sync = this.getChapterSync(id, no);
      if (sync) return sync;
      const bk = await ensureBook(id).catch(() => null);
      const c = bk && bk[no - 1];
      const ps = c && c[1];
      return ps && ps.length ? ps : ['（这一卷暂未取到正文）'];
    },
    /* 预取整本，供阅读器在显示「正在展卷」时调用 */
    async prefetch(id) { return ensureBook(id).catch(() => null); },
    async search(q) {
      const s = String(q || '').trim().toLowerCase();
      if (!s) return [];
      return META.map((b) => metaOf(b.id)).filter((m) => m &&
        [m.title, m.author, m.category, m.desc, (m.tags || []).join('')].join(' ').toLowerCase().includes(s));
    }
  };

  global.MJ = global.MJ || {};
  if (global.MJ.sources) global.MJ.sources.register(source);
})(window);
