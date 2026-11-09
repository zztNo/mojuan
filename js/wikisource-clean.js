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
      /* 尾注编号 [1][2] 要留着（校勘记靠它分段），但正文里紧跟汉字的引注编号得去掉：
         中文正文的编号一定紧贴前一个字（「天地[1]」），校勘记的编号一定在段首（前面是空格或开头）。 */
      .replace(/(\S)\[\d{1,3}\]/g, '$1 ')
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

  /* ---------- 校勘记（编者注）与正文分离 ----------
   * 维基文库的古籍页常在正文之后附一份校勘记：
   *   [1]浮：原作沉，据《古本难经阐注》、《难经疏证》等改。
   *   [2]儒：原作"涩"，据《古本难经阐注》等改。
   * 这是编者比勘版本写下的注，不是原文；混在正文末尾，读者会以为书就这么写的。
   * 这里把它整段抽出来交给阅读器单独折叠显示，正文只留书的本文。
   *
   * 判定方式：找一段【连续递增编号】的尾注（每条至少 4 字），且起点落在全文后 50%；
   * 没有编号的，退一步认「原作 / 原无 / 据《…》改 / 当作 / 讹作」这类校勘句，
   * 同样要求末尾连续出现 2 条以上才处理，避免把正文里的普通句子误当注文。 */
  /* 一条校勘句：允许「浮：」这种被校字打头，句末到句号为止。
     前面要求空白边界（清洗后段落之间就是空格），否则正文里的「原作」二字也会被认成注。 */
  const NOTE_CLAUSE_RE = /(?:^|\s)(?:[^\s。！？]{1,10}[：:])?(?:原作|原无|原脱|原缺|据《[^》]{1,24}》|当作|疑作|讹作|避讳|一本作|他本)[^。！？]{0,80}[。！？]/g;
  function splitNotes(txt) {
    const src = String(txt || '');
    if (!src) return { body: '', notes: [] };
    const half = Math.floor(src.length * 0.5);
    const marks = [];
    const re = /\[(\d{1,3})\]/g;
    let m;
    while ((m = re.exec(src)) !== null) marks.push({ i: m.index, end: m.index + m[0].length, n: Number(m[1]) });
    /* 找最长的一段「编号连续递增」的尾注区块 */
    let best = null;
    for (let s = 0; s < marks.length; s += 1) {
      let e = s;
      while (e + 1 < marks.length
        && marks[e + 1].n === marks[e].n + 1
        && marks[e + 1].i - marks[e].end >= 4) e += 1;
      const len = e - s + 1;
      if (len >= 2 && (!best || len > best.len)) best = { s, e, len };
      if (e > s) s = e;
    }
    if (best && marks[best.s].i >= half) {
      const cut = marks[best.s].i;
      const notes = [];
      for (let k = best.s; k <= best.e; k += 1) {
        const stop = k < best.e ? marks[k + 1].i : src.length;
        const text = src.slice(marks[k].end, stop).trim();
        if (text) notes.push('〔' + marks[k].n + '〕' + text);
      }
      return { body: src.slice(0, cut).trim(), notes };
    }
    /* 没编号的校勘句：从末尾往前一条条接，接到断为止 */
    const clauses = [];
    NOTE_CLAUSE_RE.lastIndex = 0;
    let c;
    while ((c = NOTE_CLAUSE_RE.exec(src)) !== null) clauses.push({ i: c.index, end: c.index + c[0].length });
    let from = clauses.length;
    let tailEnd = src.trimEnd().length;
    while (from > 0 && src.slice(clauses[from - 1].end, tailEnd).trim() === '') {
      tailEnd = clauses[from - 1].i;
      from -= 1;
    }
    if (clauses.length - from >= 2 && clauses[from].i >= half) {
      const cut = clauses[from].i;
      const notes = clauses.slice(from).map((x) => src.slice(x.i, x.end).trim()).filter(Boolean);
      return { body: src.slice(0, cut).trim(), notes };
    }
    return { body: src, notes: [] };
  }

  return { cleanHtml, trimFoot, splitNotes, stripNav, splitParas, numToCn, prettyTitle };
}));
