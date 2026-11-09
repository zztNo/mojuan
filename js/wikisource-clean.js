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

  const foots = ['检索自', '分类：', '分类:', '本作品', '版权所有', '数据项', '姊妹计划'];

  /* 版权许可模板（{{PD-old}} / {{PD-old-100}} 等）会渲染成一整块横幅，挂在每个章节页末尾。
     它的措辞是模板固定文案，古籍正文里不可能出现，所以不必受"后 40%"阈值约束，
     出现在哪个位置都直接切断（短页面里 60% 阈值会漏掉，导致尾巴留下半句「…都属于」）。 */
  const LIC_FOOTS = ['此作品在全世界', '本作品在全世界', '此作品在全世界都屬', 'Public domain', '公有领域 ，因为', '公有領域 ，因為'];

  function cleanHtml(html) {
    if (!html) return '';
    return html
      .replace(/<style[\s\S]*?<\/style>/g, '')
      .replace(/<script[\s\S]*?<\/script>/g, '')
      /* 章节页顶部那张表是「目录 / 书名 / 下一回▶」的导航条，剥标签后会粘成正文第一句 */
      .replace(/<table[^>]*class="[^"]*ws-header[^"]*"[\s\S]*?<\/table>/g, ' ')
      /* 顶部信息框（书名/作者/朝代）在 <div id="headerContainer"> 里，
         该 div 内部只有 table/ul/dl 无嵌套 div，故匹配到首个 </div> 即为其结束，不会误吞正文 */
      .replace(/<div[^>]*id="headerContainer"[\s\S]*?<\/div>/g, ' ')
      /* 正文之前那堆「通知 / 姊妹计划 / 校对提示 / 注本导航」框，都带这些 class：
         sistersitebox(姊妹计划) · messagebox/ambox/mbox(校对与通知) · noprint/dynlayout-exempt(不打印的辅助框) · navbox(导航框)。
         它们在 headerContainer 之外还有一份，若不剥掉，剥完标签会粘成正文第一句
         （「维基百科 条目：难经…」「本作品由于校订不足而错误百出…」就是这么来的） */
      .replace(/<table[^>]*class="[^"]*(?:sistersitebox|ambox|mbox|messagebox|dynlayout-exempt|noprint|navbox|metadata)[^"]*"[\s\S]*?<\/table>/g, ' ')
      .replace(/<ul[^>]*id="plainSister"[\s\S]*?<\/ul>/g, ' ')
      /* 版权许可横幅（PD-old / CC 等模板渲染出来的那一大块）：
         <div class="licenseContainer licenseBanner dynlayout-exempt"> … <div class="licensetpl">…</div></div>
         它是正文结束后的最后一个块，直接连壳端掉，免得图片、Public domain 一类残留混进正文 */
      .replace(/<div[^>]*class="[^"]*licenseContainer[^"]*"[\s\S]*?<div[^>]*class="[^"]*licensetpl[^"]*"[\s\S]*?<\/div>\s*<\/div>/gi, ' ')
      .replace(/<div[^>]*class="[^"]*licenseContainer[^"]*"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/gi, ' ')
      .replace(/<div[^>]*class="[^"]*licensetpl[^"]*"[\s\S]*?<\/div>/gi, ' ')
      .replace(/<div[^>]*class="[^"]*mw-message-box[^"]*"[\s\S]*?<\/div>/g, ' ')
      .replace(/<sup[^>]*class="[^"]*reference[^"]*"[\s\S]*?<\/sup>/g, ' ')
      /* 先还原 &nbsp;，否则「[ 编辑 ]」里的不换行空格会让下面的正则匹配不上 */
      .replace(/&nbsp;|&#160;|&#xa0;/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\[\d+\]/g, ' ')
      .replace(/\[\s*编辑\s*\]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /* 页脚标记（检索自 / 分类 / 版权所有等）只可能出现在正文【末尾】。
     现代维基文库把"姊妹计划 / 数据项"导航框放到了【顶部】，若按"首次出现即截断"
     会把整页正文从顶部一刀切断（难经、伤寒论等古籍因此只剩头部几个字）。
     这里只在文本后 40% 区域里用 lastIndexOf 找页脚，顶部导航框一律视为误报不截断。 */
  function trimFoot(txt) {
    if (!txt) return '';
    let t = txt;
    for (const f of LIC_FOOTS) {
      const i = t.indexOf(f);
      if (i >= 0) t = t.slice(0, i);
    }
    const threshold = Math.floor(t.length * 0.6);
    for (const f of foots) {
      const i = t.lastIndexOf(f);
      if (i >= threshold) t = t.slice(0, i);
    }
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
