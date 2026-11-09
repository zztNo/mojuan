/* 墨卷 · 可扩展书源插件框架
 * -------------------------------------------------------------
 * 书源（source）契约：
 *   id        唯一标识（字符串）
 *   name      展示名
 *   desc      一句话说明
 *   online    true=需要联网，false=离线可读
 *   enabled   是否启用（默认 true）
 *   metas()               -> Promise<Meta[]>   该源全部书目元数据
 *   metasSync()           -> Meta[]|null       （可选）同步取元数据，本地源用，启动即可见
 *   getBookMeta(id)       -> Promise<Meta|null>
 *   getChapter(id, no)    -> Promise<string[]>      第 no 章正文（段落数组）
 *   getChapterSync(id,no) -> string[]|null          （可选）同步取正文，内置源用
 *   search(q)             -> Promise<Meta[]>        （可选）按关键词检索
 *
 * Meta 字段：
 *   id, sourceId, title, author, category, status,
 *   desc, cover{motif,color,color2,seal}, motif,color,color2,seal,
 *   words(展示串，如 "3.7万"), chars(数字，用于排序), chapters(篇目，用于排序)、
 *   score / readers / hot（旧字段，已不参与排序与展示，可省略）,
 *   tags[], addedAt(时间戳), online, chapters:[{no,title}]
 */
(function (global) {
  'use strict';
  const registry = new Map();
  const order = [];
  let onChange = null;
  let index = new Map();
  let ready = false;

  function absorb(metas, sid) {
    let n = 0;
    (metas || []).forEach((m) => {
      if (!m || !m.id) return;
      if (!m.sourceId) m.sourceId = sid;
      index.set(m.id, m);
      n += 1;
    });
    return n;
  }

  function register(source) {
    if (!source || !source.id || typeof source.id !== 'string') throw new Error('书源需要 id 字段');
    if (typeof source.enabled === 'undefined') source.enabled = true;
    registry.set(source.id, source);
    if (!order.includes(source.id)) order.push(source.id);
    /* 本地源可以同步进索引，启动即可见，无需等 Promise */
    if (source.enabled !== false && typeof source.metasSync === 'function') {
      try { absorb(source.metasSync(), source.id); } catch (e) { console.warn('[sources] metabSync 失败', e); }
    }
    if (onChange) try { onChange(list()); } catch (e) { console.warn('[sources] onChange', e); }
    return source;
  }
  function unregister(id) {
    registry.delete(id);
    const i = order.indexOf(id); if (i >= 0) order.splice(i, 1);
    if (onChange) try { onChange(list()); } catch (e) { console.warn(e); }
  }
  function get(id) { return registry.get(id); }
  function list() { return order.map((id) => registry.get(id)); }
  function enabled() { return list().filter((s) => s.enabled !== false); }
  function setOnChange(fn) { onChange = fn; }

  function setEnabled(id, on) {
    const s = registry.get(id);
    if (!s) return false;
    s.enabled = !!on;
    if (!on) invalidate(id);
    else if (typeof s.metasSync === 'function') {
      try { absorb(s.metasSync(), id); } catch (e) { /* 忽略 */ }
    }
    if (onChange) try { onChange(list()); } catch (e) { console.warn(e); }
    return true;
  }
  function invalidate(sid) {
    Array.from(index.keys()).forEach((k) => {
      const m = index.get(k);
      if (m && (m.sourceId === sid)) index.delete(k);
    });
  }

  /* 聚合所有启用书源，建立 id -> Meta 索引 */
  async function refresh() {
    index = new Map();
    ready = false;
    const sources = enabled();
    /* 先吸收同步源，保证离线/首屏立刻有书 */
    sources.forEach((s) => {
      if (typeof s.metasSync !== 'function') return;
      try { absorb(s.metasSync(), s.id); } catch (e) { /* 忽略 */ }
    });
    const results = await Promise.all(sources.map(async (s) => {
      try { return await (s.metas ? s.metas() : []); }
      catch (e) { console.warn('[sources] ' + s.id + ' metas 失败', e); return null; }
    }));
    results.forEach((metas, i) => { if (metas) absorb(metas, sources[i].id); });
    ready = true;
    if (onChange) try { onChange(list()); } catch (e) { console.warn(e); }
    return index;
  }

  function getBook(id) { return index.get(id) || null; }
  function allBooks() { return Array.from(index.values()); }

  /* 正文：先问同步源，再查异步缓存 */
  function getChapterSync(id, no) {
    const m = index.get(id);
    const s = m && registry.get(m.sourceId);
    if (!s || typeof s.getChapterSync !== 'function') return null;
    try { return s.getChapterSync(id, no); } catch (e) { return null; }
  }
  async function getChapter(id, no) {
    const m = index.get(id);
    const s = m && registry.get(m.sourceId);
    if (!s) return null;
    const sync = getChapterSync(id, no);
    if (sync && sync.length) return sync;
    if (!s.getChapter) return null;
    return s.getChapter(id, no);
  }

  global.MJ = global.MJ || {};
  global.MJ.sources = {
    register, unregister, get, list, enabled, setOnChange, setEnabled, refresh,
    getBook, allBooks, getChapter, getChapterSync,
    get index() { return index; },
    get ready() { return ready; },
    _registry: registry, _order: order
  };
})(window);
