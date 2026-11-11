/* 墨卷 · 本地书导入：TXT / EPUB 解析（纯浏览器，无依赖） */
(function (global) {
  'use strict';

  const CH_RE = /^(?:第\s*[零〇一二三四五六七八九十百千万两0-9０-９]+\s*[章节回卷集部篇](?:[\s:：、.．\-]*[^\n]{0,28})?|卷\s*[零〇一二三四五六七八九十百千万两0-9０-９]+(?:[\s:：、.．\-]*[^\n]{0,28})?|(?:Chapter|CHAPTER)\s+[\w\d]+[^\n]{0,28}|序章|楔子|引子|前言|后记|尾声|终章|番外(?:[零〇一二三四五六七八九十\d]+)?(?:[\s:：、.．\-]*[^\n]{0,20})?)\s*$/;

  /* 用户文件内容统一清洗：杜绝 HTML 注入，去掉控制字符 */
  function clean(s) {
    return String(s == null ? '' : s)
      .replace(/[<>&]/g, (c) => ({ '<': '〈', '>': '〉', '&': '＆' }[c]))
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
      .trim();
  }

  /* 正解码出来的中文里，汉字与全角标点占绝对多数；解错编码则混进假名、
     西里尔、注音、私用区、替换符……按这个给候选编码打分，比分最高的就是它。
     （TextDecoder 只有 utf-8 会因非法字节抛错，gb18030 / big5 对任何字节
     都「解码成功」，所以不能靠 try/catch 逐一试，必须比分数。） */
  const CN_PUNCT = '，。、；：？！“”‘’（）《》〈〉…—·「」『』～';

  function scoreText(t) {
    const s = t.slice(0, 4000);
    if (!s) return -1e9;
    let score = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 0xFFFD) score -= 12;                                   /* 替换符：解不动 */
      else if (c < 0x20) score += (c === 9 || c === 10 || c === 13) ? 0 : -10;
      else if (c >= 0x4E00 && c <= 0x9FFF) score += 1;                 /* 汉字 */
      else if (CN_PUNCT.indexOf(s[i]) >= 0) score += 1.5;
      else if (c < 0x80) score += 0.2;                                 /* ASCII：正常但没信息量 */
      else if (c >= 0xE000 && c <= 0xF8FF) score -= 6;                  /* 私用区 */
      else if (c >= 0x3400 && c <= 0x4DBF) score -= 2;                  /* 扩展 A：中文正文少见 */
      else if (c >= 0x3000 && c <= 0x30FF) score -= 5;                  /* 假名 / 日文标点 */
      else if (c >= 0x0400 && c <= 0x04FF) score -= 6;                  /* 西里尔 */
      else if (c >= 0x0370 && c <= 0x03FF) score -= 6;                  /* 希腊 */
      else if (c >= 0x3100 && c <= 0x312F) score -= 5;                  /* 注音 */
    }
    return score;
  }

  /* 只在样本上判编码：30MB 的卷不该为「试几种编码」解码五遍 */
  function sampleOf(buf) {
    const u8 = new Uint8Array(buf);
    if (u8.length <= 262144) return buf;
    /* 跳过开头一长串 ASCII（英文目录、版权声明），否则这一段对中文编码没有区分力 */
    let pre = 0;
    for (let i = 0, n = Math.min(u8.length, 200000); i < n; i++) {
      if (u8[i] > 0x7F) { pre = Math.max(0, i - 16) & ~1; break; }
    }
    return buf.slice(pre, Math.min(buf.byteLength, pre + 131072));
  }

  function decode(buf) {
    const u8 = new Uint8Array(buf);
    /* 1) 有 BOM 就按 BOM 来，不用猜 */
    let enc = null;
    if (u8[0] === 0xFF && u8[1] === 0xFE) enc = 'utf-16le';
    else if (u8[0] === 0xFE && u8[1] === 0xFF) enc = 'utf-16be';
    else if (u8[0] === 0xEF && u8[1] === 0xBB && u8[2] === 0xBF) enc = 'utf-8';
    /* 2) 严格 UTF-8 能过就是 UTF-8（中文 TXT 绝大多数是它） */
    if (!enc) {
      try { new TextDecoder('utf-8', { fatal: true }).decode(sampleOf(buf)); enc = 'utf-8'; }
      catch (e) { /* 交给打分 */ }
    }
    if (!enc) {
      const head = sampleOf(buf);
      let best = null;
      /* gb18030 / big5 对任何字节都「解码成功」，utf-16 无 BOM 也能被当成双字节文本，
         所以不看谁不报错，只看谁解出来的东西像中文。 */
      for (const c of ['gb18030', 'big5', 'utf-16le', 'utf-16be', 'utf-8']) {
        let t = null;
        try { t = new TextDecoder(c).decode(head); } catch (e) { continue; }
        if (t == null) continue;
        const s = scoreText(t);
        if (!best || s > best.s) best = { enc: c, s };
      }
      enc = best ? best.enc : 'utf-8';
    }
    try { return new TextDecoder(enc).decode(buf); }
    catch (e) { return new TextDecoder('utf-8').decode(buf); }
  }

  /* 超长段落切成适合阅读的短段 */
  function splitLong(line, max) {
    const out = [];
    let s = line;
    while (s.length > max) {
      let cut = -1;
      for (const p of ['。', '！', '？', '；', '”', '」']) {
        const i = s.lastIndexOf(p, max);
        if (i > cut) cut = i;
      }
      if (cut < max * 0.4) cut = max;
      out.push(s.slice(0, cut + 1));
      s = s.slice(cut + 1);
    }
    if (s) out.push(s);
    return out;
  }

  function parasFromText(text) {
    return text.split(/\n+/).map((s) => clean(s.replace(/^[\s\u3000]+/, '')))
      .filter(Boolean).reduce((acc, line) => acc.concat(splitLong(line, 260)), []);
  }

  /* 没有章节标记时，按字数均分 */
  function splitByLength(paras) {
    const chapters = [];
    let cur = { title: '第一节', paras: [] }, size = 0, n = 1;
    for (const p of paras) {
      cur.paras.push(p); size += p.length;
      if (size >= 2600) {
        chapters.push(cur); n += 1;
        cur = { title: '第' + n + '节', paras: [] }; size = 0;
      }
    }
    if (cur.paras.length) chapters.push(cur);
    return chapters.length ? chapters : [{ title: '全文', paras: ['（这个文件里没有可读取的文字）'] }];
  }

  function parseTxt(text) {
    text = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/\u0000/g, '');
    const lines = text.split('\n');
    const chapters = [];
    let cur = null;
    for (const raw of lines) {
      const t = clean(raw.replace(/^[\s\u3000]+/, ''));
      if (t && t.length <= 40 && CH_RE.test(t)) {
        if (cur && cur.paras.length) chapters.push(cur);
        cur = { title: t, paras: [] };
        continue;
      }
      if (!cur) cur = { title: '开篇', paras: [] };
      if (t) { for (const p of splitLong(t, 260)) cur.paras.push(p); }
    }
    if (cur && cur.paras.length) chapters.push(cur);
    if (chapters.length <= 1) {
      const all = chapters.length ? chapters[0].paras : parasFromText(text);
      return splitByLength(all);
    }
    /* 目录页/书名行产生的短「开篇」不算一章 */
    if (chapters[0].title === '开篇' && chapters[0].paras.join('').length < 80) chapters.shift();
    return chapters;
  }

  /* ---------- 极简 ZIP 读取（EPUB） ---------- */
  async function unzip(buf) {
    const dv = new DataView(buf), u8 = new Uint8Array(buf);
    let eocd = -1;
    const from = Math.max(0, u8.length - 65558);
    for (let i = u8.length - 22; i >= from; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 EPUB 压缩文件');
    const count = dv.getUint16(eocd + 10, true);
    let off = dv.getUint32(eocd + 16, true);
    const entries = {};
    const td = new TextDecoder('utf-8');
    for (let i = 0; i < count; i++) {
      if (off + 46 > u8.length || dv.getUint32(off, true) !== 0x02014b50) break;
      const method = dv.getUint16(off + 10, true);
      const csize = dv.getUint32(off + 20, true);
      const nlen = dv.getUint16(off + 28, true);
      const elen = dv.getUint16(off + 30, true);
      const clen = dv.getUint16(off + 32, true);
      const lho = dv.getUint32(off + 42, true);
      const name = td.decode(u8.subarray(off + 46, off + 46 + nlen));
      entries[name] = { method, csize, lho };
      off += 46 + nlen + elen + clen;
    }
    const names = Object.keys(entries);
    function resolve(name) {
      if (entries[name]) return entries[name];
      const lower = name.toLowerCase();
      const hit = names.find((n) => n.toLowerCase() === lower) ||
        names.find((n) => n.toLowerCase().endsWith('/' + lower)) ||
        names.find((n) => n.toLowerCase().endsWith(lower));
      return hit ? entries[hit] : null;
    }
    async function readBytes(name) {
      const f = resolve(name);
      if (!f) return null;
      const ln = dv.getUint16(f.lho + 26, true), le = dv.getUint16(f.lho + 28, true);
      const start = f.lho + 30 + ln + le;
      const data = u8.subarray(start, start + f.csize);
      if (f.method === 0) return data;
      if (f.method === 8) {
        if (typeof DecompressionStream === 'undefined') throw new Error('当前浏览器不支持 EPUB 解压，请改用 TXT');
        const ds = new DecompressionStream('deflate-raw');
        return new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(ds)).arrayBuffer());
      }
      throw new Error('EPUB 使用了不支持的压缩方式');
    }
    async function read(name) {
      const bytes = await readBytes(name);
      return bytes ? new TextDecoder('utf-8').decode(bytes) : null;
    }
    return { names, read, readBytes };
  }

  /* EPUB 内嵌封面 → 裁成书封比例的压缩 data URL */
  async function coverFromBytes(bytes) {
    if (!bytes || bytes.length < 200) return null;
    let mime = null;
    if (bytes[0] === 0x89 && bytes[1] === 0x50) mime = 'image/png';
    else if (bytes[0] === 0xFF && bytes[1] === 0xD8) mime = 'image/jpeg';
    else if (bytes[0] === 0x52 && bytes[1] === 0x49) mime = 'image/webp';
    if (!mime) return null;
    try {
      const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
      const cv = document.createElement('canvas');
      cv.width = 300; cv.height = 435;
      const ctx = cv.getContext('2d');
      const scale = Math.max(300 / img.width, 435 / img.height);
      const sw = 300 / scale, sh = 435 / scale;
      ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, 0, 0, 300, 435);
      URL.revokeObjectURL(url);
      return cv.toDataURL('image/jpeg', 0.78);
    } catch (e) { return null; }
  }

  function htmlEntities(s) {
    const d = document.createElement('div');
    d.innerHTML = s;
    return d.textContent || '';
  }

  async function parseEpub(file) {
    const zip = await unzip(await file.arrayBuffer());
    const container = await zip.read('META-INF/container.xml');
    const m = container && container.match(/full-path\s*=\s*["']([^"']+\.opf)["']/i);
    const opfPath = (m && m[1]) || zip.names.find((n) => n.toLowerCase().endsWith('.opf'));
    if (!opfPath) throw new Error('EPUB 缺少目录文件（container.xml / .opf）');
    const opf = await zip.read(opfPath);
    if (!opf) throw new Error('无法读取 EPUB 目录');
    const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
    const title = clean(htmlEntities((opf.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i) || [])[1] || '')) || '未命名';
    const author = clean(htmlEntities((opf.match(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i) || [])[1] || '')) || '佚名';
    const manifest = {};
    opf.replace(/<item\b[^>]*\/?>/gi, (tag) => {
      const id = (tag.match(/\bid\s*=\s*["']([^"']+)["']/i) || [])[1];
      const href = (tag.match(/\bhref\s*=\s*["']([^"']+)["']/i) || [])[1];
      if (id && href) manifest[id] = decodeURIComponent(href);
    });
    const spine = [];
    opf.replace(/<itemref\b[^>]*\/?>/gi, (tag) => {
      const ref = (tag.match(/\bidref\s*=\s*["']([^"']+)["']/i) || [])[1];
      if (ref && manifest[ref]) spine.push(base + manifest[ref]);
    });
    if (!spine.length) throw new Error('EPUB 正文目录为空（可能受 DRM 保护）');
    const chapters = [];
    for (let i = 0; i < spine.length; i++) {
      const html = await zip.read(spine[i]);
      if (!html) continue;
      const body = (html.match(/<body[^>]*>([\s\S]*?)<\/body>/i) || [])[1] || html;
      const heading = clean(htmlEntities((body.match(/<(?:h[1-4]|title)[^>]*>([\s\S]*?)<\/(?:h[1-4]|title)>/i) || [])[1] || ''));
      const plain = body
        .replace(/<(script|style)[\s\S]*?<\/\1\s*>/gi, '')
        .replace(/<\/(p|div|h[1-6]|li|section|blockquote|tr)\s*>/gi, '\n')
        .replace(/<br\s*\/?\s*>/gi, '\n')
        .replace(/<[^>]+>/g, '');
      const paras = parasFromText(htmlEntities(plain));
      if (!paras.length || paras.join('').length < 12) continue;
      const title = (heading || '第' + (chapters.length + 1) + '章').slice(0, 40);
      /* 正文里的 h1 常与章节标题重复，去掉重复段 */
      if (paras[0].replace(/\s/g, '') === title.replace(/\s/g, '')) paras.shift();
      chapters.push({ title, paras });
    }
    if (!chapters.length) throw new Error('EPUB 中没有可读取的正文');
    /* 优先用 EPUB 自带封面，避免每本书都是自动生成的水墨图 */
    let coverPath = null;
    const coverId = (opf.match(/<meta[^>]*name=["']cover["'][^>]*content=["']([^"']+)["']/i) || [])[1] ||
      (opf.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']cover["']/i) || [])[1];
    if (coverId && manifest[coverId]) coverPath = base + manifest[coverId];
    if (!coverPath) {
      const tag = opf.match(/<item\b[^>]*properties=["'][^"']*cover-image[^"']*["'][^>]*\/?>/i);
      const href = tag && (tag[0].match(/href=["']([^"']+)["']/i) || [])[1];
      if (href) coverPath = base + decodeURIComponent(href);
    }
    if (!coverPath) coverPath = zip.names.find((n) => /cover[^/]*\.(jpe?g|png|webp)$/i.test(n)) || null;
    let cover = null;
    if (coverPath) {
      try { cover = await coverFromBytes(await zip.readBytes(coverPath)); } catch (e) { cover = null; }
    }
    return { title, author, chapters, cover };
  }

  async function parseFile(file) {
    const name = file.name || '本地书';
    const ext = (name.split('.').pop() || '').toLowerCase();
    const baseName = clean(name.replace(/\.[^.]+$/, '')) || '本地书';
    if (ext === 'epub') {
      const r = await parseEpub(file);
      return { ext, title: r.title === '未命名' ? baseName : r.title, author: r.author, chapters: r.chapters, cover: r.cover };
    }
    if (['txt', 'md', 'text', 'log'].includes(ext) || file.type.startsWith('text/') || !ext) {
      const text = decode(await file.arrayBuffer());
      const chapters = parseTxt(text);
      let title = baseName, author = '本地导入';
      /* 只在「中文书名 - 中文作者」这种明确形式下拆出作者 */
      const mm = baseName.match(/^(.+?)[\s_\-—]+([\u4e00-\u9fa5]{2,5})$/);
      if (mm && /[\u4e00-\u9fa5]/.test(mm[1]) && !/(全集|完整版|合集|修正版)/.test(baseName)) {
        title = mm[1].trim(); author = mm[2].trim();
      }
      title = clean(title.replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ')) || baseName;
      return { ext, title, author, chapters };
    }
    throw new Error('暂不支持 .' + ext + ' 格式，请导入 TXT 或 EPUB');
  }

  global.MJ = global.MJ || {};
  global.MJ.importer = { parseFile, clean };
})(window);
