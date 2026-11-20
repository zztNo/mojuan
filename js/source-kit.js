/* 墨卷 · 可视化书源解析工具箱（纯浏览器 API，零依赖）
 * -------------------------------------------------------------
 * 只做三件事：取回网页文本、用 CSS 选择器抽字段、拼成墨卷书源契约对象。
 * 不内置任何站点，也不预置任何规则——填什么由用户自己决定，
 * 且浏览器 CORS 会拦下不允许跨域的站点，能否取回完全取决于目标站。
 *
 * 公开给自定义书源插件：MJ.sourceKit
 */
(function (global) {
  'use strict';

  /* 取网页文本：超时 + 编码探测（复用中文打分思路，gbk 网页很常见）。 */
  async function fetchText(url, headers, timeout) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout || 12000);
    try {
      const opt = { signal: ctl.signal, credentials: 'omit', redirect: 'follow' };
      if (headers) opt.headers = headers;
      const r = await fetch(url, opt);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const buf = await r.arrayBuffer();
      return decode(buf);
    } finally { clearTimeout(timer); }
  }

  function decode(buf) {
    const bytes = new Uint8Array(buf);
    /* UTF-8 用 TextDecoder 严格模式试，失败再退回 gb18030 */
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (_) {
      try { return new TextDecoder('gb18030').decode(bytes); }
      catch (_2) { return new TextDecoder('utf-8').decode(bytes); }
    }
  }

  function parseHtml(html, baseUrl) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    if (baseUrl) {
      /* 让 a[href] 之类相对地址能正确解析成绝对地址 */
      const base = doc.createElement('base');
      base.href = baseUrl;
      doc.head.insertBefore(base, doc.head.firstChild);
    }
    return doc;
  }

  /* 选择器语法：'selector' 取文本 / 'selector@href' 取属性 /
     'selector||regex' 先取文本再正则（支持 $1）/ 多个选择器用 '|' 依次尝试，取第一个非空。 */
  function pick(doc, rule, fallback) {
    if (!rule) return fallback != null ? fallback : '';
    const parts = String(rule).split('||');
    const selPart = parts[0];
    const re = parts[1];
    for (const one of selPart.split('|')) {
      const s = one.trim();
      if (!s) continue;
      const m = s.match(/^(.*?)@([a-zA-Z-]+)$/);
      const sel = m ? m[1] : s;
      const attr = m ? m[2] : null;
      let el = null;
      try { el = doc.querySelector(sel); } catch (_) { continue; }
      if (!el) continue;
      let v = attr ? (el.getAttribute(attr) || '') : (el.textContent || '');
      if (re) {
        try {
          const rx = new RegExp(re);
          const mm = v.match(rx);
          v = mm ? (mm[1] != null ? mm[1] : mm[0]) : '';
        } catch (_) { /* 正则写错就当没匹配 */ }
      }
      v = clean(v);
      if (v) return v;
    }
    return fallback != null ? fallback : '';
  }

  function pickAll(doc, rule) {
    if (!rule) return [];
    const sel = String(rule).split('||')[0].split('|')[0].trim();
    try { return Array.from(doc.querySelectorAll(sel)); } catch (_) { return []; }
  }

  function clean(s) {
    return String(s == null ? '' : s)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
      .replace(/[\t ]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function abs(href, base) {
    if (!href) return '';
    try { return new URL(href, base).href; } catch (_) { return href; }
  }

  /* 用配置生成墨卷书源对象。配置结构见 openSourceEditor 的表单字段。 */
  function makeSource(cfg) {
    if (!cfg || !cfg.id || !cfg.name) throw new Error('书源需要 id 与名称');
    const self = {
      id: String(cfg.id), name: String(cfg.name),
      desc: String(cfg.desc || '可视化书源'), online: true,
      enabled: cfg.enabled !== false, group: String(cfg.group || '自定义'),
      listUrl: String(cfg.listUrl || ''),
      _cfg: cfg
    };

    /* 目录页：抓书单 -> 每本书的标题/链接 */
    self.metas = async function () {
      /* 本地 file:// 没法被 fetch（origin null），也就不当成网络源 */
      if (!self.listUrl || /^file:/i.test(self.listUrl)) return [];
      const html = await fetchText(self.listUrl, cfg.header ? JSON.parse(cfg.header) : null, cfg.timeout);
      const doc = parseHtml(html, self.listUrl);
      const items = pickAll(doc, cfg.bookList || 'a');
      const out = [];
      items.forEach((el, i) => {
        const sub = { querySelector: (s) => el.querySelector(s), querySelectorAll: (s) => el.querySelectorAll(s),
          textContent: el.textContent, getAttribute: (a) => el.getAttribute(a) };
        const title = pick(sub, cfg.bookTitle || '', clean(el.textContent));
        const href = pick(sub, cfg.bookLink || 'a@href', el.getAttribute('href'));
        if (!title) return;
        const url = abs(href, self.listUrl);
        if (!url) return;
        out.push({
          id: self.id + ':' + (url.replace(/[^a-zA-Z0-9]/g, '').slice(-40) || i),
          sourceId: self.id, title, author: clean(cfg.defaultAuthor || '网络书源'),
          category: '网络', status: '连载', desc: '来自可视化书源《' + self.name + '》',
          words: '—', tags: [self.name], chapters: [], online: true, url
        });
      });
      return out;
    };

    /* 正文：打开书页抓目录（章节链接），按章取正文 */
    async function bookDoc(meta) {
      const url = meta.url || (cfg.bookUrlPrefix || '') + meta.id;
      const html = await fetchText(url, cfg.header ? JSON.parse(cfg.header) : null, cfg.timeout);
      return { doc: parseHtml(html, url), url };
    }
    self.getChapter = async function (id, no) {
      const meta = (global.MJ.sources.getBook(id)) || {};
      const { doc, url } = await bookDoc(meta);
      const links = pickAll(doc, cfg.chapterList || 'a');
      const el = links[no - 1];
      if (!el) return ['（这一章暂时取不到，换个书源试试）'];
      const href = abs(el.getAttribute('href') || '', url);
      if (!href) return ['（章节链接无效）'];
      const chHtml = await fetchText(href, cfg.header ? JSON.parse(cfg.header) : null, cfg.timeout);
      const chDoc = parseHtml(chHtml, href);
      let text = pick(chDoc, cfg.content || 'body', '');
      if (cfg.replaceRegex) {
        try { text = text.replace(new RegExp(cfg.replaceRegex, 'g'), ''); } catch (_) { /* 忽略写错的正则 */ }
      }
      return text.split(/\n+/).map((s) => clean(s)).filter(Boolean);
    };
    return self;
  }

  global.MJ = global.MJ || {};
  global.MJ.sourceKit = { fetchText, decode, parseHtml, pick, pickAll, clean, abs, makeSource };

  /* 订阅源：和书源共用同一套抓取工具，只是抽「文章列表」而非「书目列表」。
     同样不预置任何地址，规则由用户提供。 */
  async function fetchArticles(cfg) {
    if (!cfg || !cfg.url || /^file:/i.test(cfg.url)) return [];
    const html = await fetchText(cfg.url, cfg.header ? JSON.parse(cfg.header) : null, cfg.timeout);
    const doc = parseHtml(html, cfg.url);
    const items = pickAll(doc, cfg.ruleArticles || 'a');
    return items.map((el) => {
      const mini = { querySelector: (s) => el.querySelector(s), querySelectorAll: (s) => el.querySelectorAll(s),
        textContent: el.textContent, getAttribute: (a) => el.getAttribute(a) };
      const title = pick(mini, cfg.ruleTitle || '', clean(el.textContent));
      const href = pick(mini, cfg.ruleLink || 'a@href', el.getAttribute('href'));
      if (!title) return null;
      return { key: abs(href, cfg.url) || title, title, url: abs(href, cfg.url) };
    }).filter(Boolean);
  }
  global.MJ.subKit = { fetchArticles };
})(window);
