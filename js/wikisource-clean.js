/* 墨卷 · 维基文库正文清洗（纯函数模块）
 * -------------------------------------------------------------
 * 把维基文库取回的 HTML 洗成可读正文，是「脏活集中地」。
 * 这些函数都是纯函数（同样输入必得同样输出），所以单独拆出来，
 * 方便用 tools/test_clean.js 做 golden test 离线回归。
 *
 * UMD 风格：浏览器挂到 window.MJ.clean，Node 里走 module.exports。
 * 保持纯函数、不碰 DOM / 网络 / 全局状态，是这个模块唯一的约定。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = api; }
  else { root.MJ = root.MJ || {}; root.MJ.clean = api; }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const foots = ['姊妹计划', '数据项', '检索自', '分类：', '分类:', '本作品', '版权所有'];

  function cleanHtml(html) {
    if (!html) return '';
    return html
      .replace(/<style[\s\S]*?<\/style>/g, '')
      .replace(/<script[\s\S]*?<\/script>/g, '')
      /* 章节页顶部那张表是「目录 / 书名 / 下一回▶」的导航条，剥标签后会粘成正文第一句 */
      .replace(/<table[^>]*class="[^"]*ws-header[^"]*"[\s\S]*?<\/table>/g, ' ')
      .replace(/<sup[^>]*class="[^"]*reference[^"]*"[\s\S]*?<\/sup>/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\[\d+\]/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function trimFoot(txt) {
    let t = txt;
    for (const f of foots) { const i = t.indexOf(f); if (i > 0) t = t.slice(0, i); }
    return t.trim();
  }

  /* 章节页顶部有「回目录 · 上一回 · 下一回」这类导航，剥掉标签后会粘在正文第一句前面，
     读起来像正文里混进了目录栏。只在开头循环剥几个导航词，中间位置不动。 */
  const NAV_HEAD = /^(?:(?:回|返回|回到)?目录|上一[回章篇]|下一[回章篇]|上一篇|下一篇)[:：\s　]*/;
  function stripNav(txt) {
    let s = txt, i = 0;
    while (i < 5 && NAV_HEAD.test(s)) { s = s.replace(NAV_HEAD, ''); i += 1; }
    return s;
  }

  function splitParas(txt) {
    txt = stripNav(String(txt || '')).trim();
    /* 句号后面紧跟右引号时不要在这里断，否则「…者也。”」的引号会被甩到下一句开头 */
    const sents = txt.split(/(?<=[。！？；])(?![”’"'」』）])/).map((s) => s.trim()).filter(Boolean);
    const paras = [], buf = [];
    sents.forEach((s, i) => {
      buf.push(s);
      if (buf.length >= 4 || i === sents.length - 1) { paras.push(buf.join('')); buf.length = 0; }
    });
    return paras.length ? paras : [txt];
  }

  const CN_DIGIT = '零一二三四五六七八九';
  function numToCn(n) {
    if (n < 10) return CN_DIGIT[n];
    if (n < 100) {
      const t = Math.floor(n / 10), u = n % 10;
      return (t === 1 ? '十' : CN_DIGIT[t] + '十') + (u ? CN_DIGIT[u] : '');
    }
    const h = Math.floor(n / 100), r = n % 100;
    if (r === 0) return CN_DIGIT[h] + '百';
    if (r < 10) return CN_DIGIT[h] + '百零' + CN_DIGIT[r];
    if (r < 20) return CN_DIGIT[h] + '百一' + numToCn(r);
    return CN_DIGIT[h] + '百' + numToCn(r);
  }

  /* 子页名多是「紅樓夢/第001回」，直接摆出来像文件名，转成「第一回」 */
  function prettyTitle(name) {
    return String(name).replace(/第\s*(\d{1,4})\s*([回章卷篇節节])/g, (m, d, u) => '第' + numToCn(Number(d)) + u);
  }

  return { cleanHtml, trimFoot, stripNav, splitParas, numToCn, prettyTitle };
}));
