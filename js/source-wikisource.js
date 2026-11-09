/* 墨卷 · 示例远程书源插件（维基文库 / Wikisource 中文）
 * -------------------------------------------------------------
 * 这是一个「可扩展书源」的示范：读者浏览器直连维基文库公共 API，
 * 按需拉取真实公有领域全文。演示书源框架如何在不改动主程序的前提下，
 * 接入整座在线书库。需要联网；离线时这些书会提示「需联网读取」。
 *
 * 关键点：长篇（如红楼梦 120 回）只在开卷时取一次目录，正文按章懒加载，
 * 避免一上来就发上百个请求。
 */
(function (global) {
  'use strict';
  const SITE = 'https://zh.wikisource.org/w/api.php';
  /* MediaWiki 对匿名请求开了匿名跨域：带上 origin=* 即可直接 fetch。
   * 注意不要加自定义请求头，否则会触发预检、被 CORS 拦下。 */
  const API = (params, timeout) => {
    /* variant=zh-hans：让维基文库在服务端把繁体原文转成简体，读者不用自己认繁体 */
    const p = Object.assign({}, params);
    if (p.action === 'parse' && !p.variant) p.variant = 'zh-hans';
    const url = SITE + '?origin=*&' + Object.keys(p).map((k) =>
      encodeURIComponent(k) + '=' + encodeURIComponent(p[k])).join('&');
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), timeout || 12000) : 0;
    return fetch(url, ctl ? { mode: 'cors', credentials: 'omit', signal: ctl.signal }
      : { mode: 'cors', credentials: 'omit' })
      .then((r) => r.json())
      .finally(() => { if (timer) clearTimeout(timer); });
  };
  const workCache = {};      /* page -> { chapters:[{no,title,page?|inline?}] } */
  const pageParas = {};      /* page -> string[] */
  /* 正文清洗是纯函数，抽到 js/wikisource-clean.js 统一维护（挂 window.MJ.clean），
     这里解构引用，不再本地重复定义。 */
  const { cleanHtml, trimFoot, splitNotes, stripNav, splitParas, prettyTitle } = global.MJ.clean;
  /* 页面 HTML 留一份：目录里链接的先后就是篇目次序，allpages 给不了这个 */
  const pageHtml = {};
  async function fetchPageRaw(page) {
    if (typeof pageHtml[page] === 'string') return pageHtml[page];
    const d = await API({ action: 'parse', page, prop: 'text', format: 'json' });
    const html = (d && !d.error && d.parse && d.parse.text && d.parse.text['*']) || '';
    if (html) pageHtml[page] = html;   /* 取空了就不记，下次还有机会重取 */
    return html;
  }
  /* 一页清洗完还会顺带把末尾的校勘记拆出来：正文归正文，注文归注文，
     阅读器把注文折叠在章末的「注释」里，不再混着正文一起读 */
  async function fetchPageParts(page) {
    const html = await fetchPageRaw(page);
    if (!html) return { text: '', notes: [] };
    return splitNotes(trimFoot(cleanHtml(html)));
  }
  /* 目录页里的链接：出现先后即篇目次序，链接文字即篇名（页面已转简体，文章原名多是繁体） */
  const domMeta = {};
  function domLinks(page) {
    if (domMeta[page]) return domMeta[page];
    const idx = new Map(), label = new Map();
    const html = pageHtml[page] || '';
    if (!html) return { idx, label };   /* 空的不缓存，等重取回来再说 */
    const re = /<a[^>]+href="\/wiki\/([^"#?]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let m, i = 0;
    while ((m = re.exec(html))) {
      let t = m[1];
      try { t = decodeURIComponent(t); } catch (e) { continue; }
      t = t.replace(/_/g, ' ');
      if (t.indexOf(page + '/') !== 0) continue;
      if (!idx.has(t)) { idx.set(t, i); i += 1; }
      if (!label.has(t)) {
        const txt = m[2].replace(/<[^>]+>/g, '').replace(/\[\d+\]/g, ' ').replace(/\s+/g, ' ').trim();
        if (txt) label.set(t, txt);
      }
    }
    return (domMeta[page] = { idx, label });
  }
  const NAV_LABEL = /^(?:上一|下一|回|返回|目录|索引)/;
  function labelOf(page, rel) {
    const full = page + '/' + rel;
    const lb = domLinks(page).label.get(full) || '';
    if (lb && lb.length <= 16 && !NAV_LABEL.test(lb)) return lb;
    return prettyTitle(rel);
  }

  /* 目录：主页面能直接切章就切；否则拉子页列表（只存标题，不取正文） */
  /* numToCn / prettyTitle 已上移到 js/wikisource-clean.js */  /* 列出一级子页。维基文库的长篇几乎都是「书名/第001回」这种命名，
     用前缀查询最靠得住；页面里的链接只作兜底。 */
  async function listSubpages(page) {
    const out = [], seen = {};
    const push = (t) => {
      if (typeof t !== 'string' || t.indexOf(page + '/') !== 0) return;
      const rel = t.slice(page.length + 1);
      if (!rel || rel.indexOf('/') !== -1) return;   /* 但要一级子页，深层子页不算一章 */
      if (seen[rel]) return;
      seen[rel] = 1; out.push(rel);
    };
    let cont = null;
    for (let i = 0; i < 4; i += 1) {
      try {
        const d = await API(Object.assign(
          { action: 'query', list: 'allpages', apprefix: page + '/', aplimit: 500, format: 'json' }, cont || {}));
        ((d.query && d.query.allpages) || []).forEach((p) => push(p.title));
        if (d.continue && d.continue.apcontinue) cont = Object.assign({}, d.continue); else break;
      } catch (e) { break; }
    }
    if (!out.length) {
      try {
        const ld = await API({ action: 'parse', page, prop: 'links', format: 'json' });
        ((ld.parse && ld.parse.links) || []).forEach((l) => push(l['*']));
      } catch (e) { /* 忽略 */ }
    }
    /* 排序：目录页里链接的先后才是真的篇目次序。庄子、荀子这类篇名不带号的，
       按字典序会排成「逍遥游 / 大宗师 / 盗跖 / 德充符」，读起来前言不搭后语。 */
    let idx = domLinks(page).idx;
    if (!idx.size) {
      /* 目录页那一次没取回来，为了排序再试一次；还不行才退回字典序 */
      try { await fetchPageRaw(page); } catch (e) { /* 忽略 */ }
      idx = domLinks(page).idx;
    }
    const covered = out.filter((x) => idx.has(page + '/' + x)).length;
    if (covered >= 3 && covered >= out.length * 0.6) {
      out.sort((a, b) => {
        const ia = idx.has(page + '/' + a) ? idx.get(page + '/' + a) : 1e9;
        const ib = idx.has(page + '/' + b) ? idx.get(page + '/' + b) : 1e9;
        return ia - ib;
      });
    } else {
      /* 兜底：第1回 / 第10回 / 第2回 这种不补零的命名，字典序会把顺序排乱 */
      out.sort((a, b) => {
        const na = (a.match(/(\d+)/) || [])[1], nb = (b.match(/(\d+)/) || [])[1];
        if (na && nb && Number(na) !== Number(nb)) return Number(na) - Number(nb);
        return a.localeCompare(b, 'zh');
      });
    }
    return out.map((rel) => ({ rel, title: labelOf(page, rel) }));
  }
  async function fetchToc(page) {
    if (workCache[page]) return workCache[page];
    let chapters = [];
    let txt = '';
    let pageNotes = [];
    try {
      const head = await fetchPageParts(page);
      txt = head.text;
      pageNotes = head.notes;
    } catch (e) { /* 网络问题，走子页分支 */ }
    /* 单页大书（古籍常是「第一难 / 卷第一 / 辨太阳病脉证并治」这类非「第X回」命名的章节）。
       准备几套候选分节标记，按特异性从高到低逐套试，选「命中 3~400 处、且平均每节≥100字」的那套——
       既能分章，又不会把满屏「第X回」的目录页误当成正文（目录页每节只有回目本身，平均很短）。 */
    const candidateRes = [
      /辨\S{1,8}病脉证并治/g,                                   /* 伤寒论 / 金匮：特异性最高 */
      /第[一二三四五六七八九十百千0-9]+难/g,                     /* 难经 */
      /第[一二三四五六七八九十百千0-9]+[章回卷篇]/g,             /* 一般古籍 / 小说 */
      /卷[一二三四五六七八九十百零]+/g                           /* 脉经 / 神农本草经等（易与正文引用混淆，兜底） */
    ];
    for (const markerRe of candidateRes) {
      const markers = txt.match(markerRe) || [];
      if (markers.length < 3 || markers.length > 400) continue;
      const parts = txt.split(new RegExp(markerRe.source, 'g'));
      const inline = markers.map((mk, i) => {
        const seg = (parts[i + 1] || '').trim();
        return { no: i + 1, title: prettyTitle(mk), inline: seg ? splitParas(seg) : null };
      }).filter((c) => c.inline && c.inline.length);
      const total = inline.reduce((n, c) => n + c.inline.join('').length, 0);
      if (inline.length && total / inline.length >= 100) {
        chapters = inline;
        break;
      }
    }
    if (!chapters.length) {
      const subs = await listSubpages(page);
      if (subs.length) {
        chapters = subs.map((s, i) => ({ no: i + 1, title: s.title, page: page + '/' + s.rel }));
      } else if (txt) {
        chapters = [{ no: 1, title: page, inline: splitParas(txt) }];
      }
    }
    /* 整本书挤在一个页面上的（难经、伤寒论这类），校勘记在页面末尾，
       分章之后自然落在最后一章的尾巴上 —— 挂到最后一章，既不丢，也不再混进正文 */
    if (pageNotes.length && chapters.length && !chapters[0].page) {
      chapters[chapters.length - 1].notes = pageNotes;
    }
    const result = { chapters };
    if (chapters.length) workCache[page] = result;
    return result;
  }

  async function fetchParas(ch, page) {
    if (ch.inline) return ch.inline;
    const target = ch.page || page;
    if (pageParas[target]) return pageParas[target];
    const parts = await fetchPageParts(target);
    if (parts.notes.length) ch.notes = parts.notes;
    const paras = parts.text ? splitParas(parts.text) : [];
    if (paras.length) pageParas[target] = paras;
    return paras;
  }

  /* CATALOG:BEGIN —— 由 tools/ws_catalog.py 生成，勿手改 */
  const CATALOG = [
    { id: "ws:honglou", title: "红楼梦", author: "曹雪芹 / 高鹗", category: "小说", page: "紅樓夢",
      cover: { motif: "petals", seal: "紅", color: "#7A3B45", color2: "#391A21" },
      tags: ["章回", "世情", "四大名著"],
      desc: "一百二十回。大观园里一场繁盛，终究落得白茫茫大地。中国人的小说读到最后，多半还是要回到这一本。" },
    { id: "ws:sanguo", title: "三国演义", author: "罗贯中", category: "小说", page: "三國演義",
      cover: { motif: "sword", seal: "國", color: "#5A3A2C", color2: "#28170F" },
      tags: ["章回", "历史演义", "四大名著"],
      desc: "一百二十回，自桃园结义到三分归晋。诸葛亮、关云长、曹孟德，几个人物撑起了中国人对政治与忠义的全部想象。" },
    { id: "ws:shuihu", title: "水浒传", author: "施耐庵", category: "小说", page: "水滸傳 (100回本)",
      cover: { motif: "wave", seal: "滸", color: "#2C5550", color2: "#142C2A" },
      tags: ["章回", "英雄", "四大名著"],
      desc: "一百回，一百零八人逼上梁山。官逼民反四个字，写得最痛快也最悲凉的一本。" },
    { id: "ws:xiyou", title: "西游记", author: "吴承恩", category: "小说", page: "西遊記",
      cover: { motif: "pagoda", seal: "遊", color: "#8A5A2E", color2: "#42290F" },
      tags: ["章回", "神魔", "四大名著"],
      desc: "一百回，取经路上八十一难。看似神怪，写的却是人心降伏自己的过程。" },
    { id: "ws:liaozhai", title: "聊斋志异", author: "蒲松龄", category: "小说", page: "聊齋志異",
      cover: { motif: "candle", seal: "齋", color: "#3A4550", color2: "#1A2128" },
      tags: ["笔记", "志怪", "文言"],
      desc: "近五百篇文言短篇。狐狸鬼怪比人更讲情义，蒲松龄在灯下写它们，写的是自己一肚子的不平。" },
    { id: "ws:shiji", title: "史记", author: "司马迁", category: "史部", page: "史記",
      cover: { motif: "brush", seal: "史", color: "#6B4B34", color2: "#33220F" },
      tags: ["纪传体", "通史", "西汉"],
      desc: "一百三十篇，本纪、表、书、世家、列传。究天人之际，通古今之变，“史家之绝唱，无韵之离骚”。" },
    { id: "ws:shishuo", title: "世说新语", author: "刘义庆", category: "史部", page: "世說新語",
      cover: { motif: "bamboo", seal: "世", color: "#3F5E5A", color2: "#1D2E2B" },
      tags: ["笔记", "魏晋", "人物"],
      desc: "三十六门，一千余则。魏晋名士的言语与风度，全在这几行小字里：乘兴而行，兴尽而返，何必见戴。" },
    { id: "ws:tangshi", title: "全唐诗", author: "清·彭定求 等编", category: "诗词", page: "全唐詩",
      cover: { motif: "star", seal: "全", color: "#4A4A6E", color2: "#22223A" },
      tags: ["唐诗", "总集", "清编"],
      desc: "九百卷，收诗四万八千余首，作者两千余家。唐人一代的诗，尽收于此；不必读完，随手翻一页都是好的。" },
    { id: "ws:rulin", title: "儒林外史", author: "吴敬梓", category: "小说", page: "儒林外史",
      cover: { motif: "gate", seal: "儒", color: "#4A5C6E", color2: "#202C38" },
      tags: ["科举", "讽刺", "士林"],
      desc: "清代吴敬梓所著长篇讽刺小说，五十六回。范进中举、严监生临死伸指，都出自此书。写尽读书人的体面与狼狈，笑里带着凉意。" },
    { id: "ws:fengshen", title: "封神演义", author: "许仲琳", category: "小说", page: "封神演義",
      cover: { motif: "cloud", seal: "封", color: "#8A6A2E", color2: "#422E10" },
      tags: ["神魔", "商周", "演义"],
      desc: "明代神魔小说，一百回。武王伐纣为经，阐截二教斗法为纬。哪吒闹海、姜太公封神，民间神谱多半由此书定下。" },
    { id: "ws:lieguo", title: "东周列国志", author: "冯梦龙 / 蔡元放", category: "小说", page: "東周列國志",
      cover: { motif: "mountain", seal: "列", color: "#5A6250", color2: "#282F22" },
      tags: ["春秋", "战国", "历史演义"],
      desc: "演春秋战国五百余年事，一百零八回。五霸七雄、管仲商鞅、苏秦张仪，一部列国，半部中国人的权谋教科书。" },
    { id: "ws:jinghua", title: "镜花缘", author: "李汝珍", category: "小说", page: "鏡花緣",
      cover: { motif: "wave", seal: "鏡", color: "#2E5A6A", color2: "#132C34" },
      tags: ["海外", "才学", "清小说"],
      desc: "清代李汝珍所著，一百回。唐敖海外游历，君子国、女儿国、两面国，借奇邦异域写世情；后半写才女百人，是清人小说里最博学的一部。" },
    { id: "ws:laocan", title: "老残游记", author: "刘鹗", category: "小说", page: "老殘遊記",
      cover: { motif: "pine", seal: "殘", color: "#46564E", color2: "#1F2823" },
      tags: ["晚清", "游记", "白话"],
      desc: "晚清刘鹗所著，二十回。一个摇串铃的郎中走遍山东，大明湖听书、桃花山访贤。写景极工，鲁迅称其“叙景状物，时有可观”。" },
    { id: "ws:guanchang", title: "官场现形记", author: "李宝嘉", category: "小说", page: "官場現形記",
      cover: { motif: "city", seal: "官", color: "#6E5240", color2: "#33241A" },
      tags: ["晚清", "谴责", "官场"],
      desc: "晚清四大谴责小说之首，六十回。从州县到京官，一个个钻营、倾轧、糊弄的场面，拼成一部晚清官场浮世绘。" },
    { id: "ws:ernian", title: "二十年目睹之怪现状", author: "吴趼人", category: "小说", page: "二十年目睹之怪現狀",
      cover: { motif: "pagoda", seal: "怪", color: "#4E4A5E", color2: "#232030" },
      tags: ["晚清", "谴责", "世情"],
      desc: "吴趼人所著，一百零八回。以“九死一生”二十年所见，写官商士绅的种种怪状，蛇虫鼠蚁魑魅魍魉，一一现形。" },
    { id: "ws:niehai", title: "孽海花", author: "曾朴", category: "小说", page: "孽海花",
      cover: { motif: "flower", seal: "孽", color: "#7A4050", color2: "#361B24" },
      tags: ["晚清", "谴责", "名士"],
      desc: "曾朴所著，三十五回。以状元洪钧与名妓赛金花为线，串起同光以来的名士与国事。写士大夫的清谈与溃败，笔致最见风雅。" },
    { id: "ws:sanxia", title: "三侠五义", author: "石玉昆", category: "小说", page: "三俠五義",
      cover: { motif: "sword", seal: "俠", color: "#4A4A58", color2: "#1F1F28" },
      tags: ["武侠", "公案", "清小说"],
      desc: "清代石玉昆说书底本整理而成，一百二十回。包公断案、五鼠闹东京、展昭白玉堂，中国武侠小说的开山之作。" },
    { id: "ws:suitang", title: "隋唐演义", author: "褚人获", category: "小说", page: "隋唐演義",
      cover: { motif: "star", seal: "隋", color: "#5A4A6E", color2: "#282038" },
      tags: ["隋唐", "英雄", "演义"],
      desc: "清人褚人获所著，一百回。隋末群雄并起，秦琼卖马、程咬金三板斧、瓦岗寨聚义，英雄气与儿女情交织。" },
    { id: "ws:shuoyue", title: "说岳全传", author: "钱彩", category: "小说", page: "說岳全傳",
      cover: { motif: "pine", seal: "岳", color: "#4E5A46", color2: "#232A1F" },
      tags: ["岳飞", "忠义", "演义"],
      desc: "清人钱彩所著，八十回。岳鹏举枪挑小梁王，十二道金牌召还，风波亭上一阕《满江红》。民间说岳，尽在此书。" },
    { id: "ws:ernv", title: "儿女英雄传", author: "文康", category: "小说", page: "兒女英雄傳",
      cover: { motif: "willow", seal: "俠", color: "#5C6B48", color2: "#2A3220" },
      tags: ["侠义", "言情", "清小说"],
      desc: "清人文康所著，四十一回。十三妹能文能武，安公子迂而不失其厚。写侠气也写家常，是清代小说里少见的温厚笔调。" },
    { id: "ws:xingshi", title: "醒世恒言", author: "冯梦龙 编", category: "小说", page: "醒世恆言",
      cover: { motif: "candle", seal: "醒", color: "#6E5A3E", color2: "#33291A" },
      tags: ["三言", "话本", "世情"],
      desc: "冯梦龙“三言”之三，四十卷。卖油郎独占花魁、十五贯戏言成巧祸，宋元明话本的精华尽在其中。" },
    { id: "ws:yushi", title: "喻世明言", author: "冯梦龙 编", category: "小说", page: "喻世明言",
      cover: { motif: "window", seal: "喻", color: "#545E6E", color2: "#252C36" },
      tags: ["三言", "话本", "世情"],
      desc: "冯梦龙“三言”之一，四十卷。蒋兴哥重会珍珠衫、金玉奴棒打薄情郎，写市井人情，句句是白话，字字是老练。" },
    { id: "ws:jingshi", title: "警世通言", author: "冯梦龙 编", category: "小说", page: "警世通言",
      cover: { motif: "ink", seal: "警", color: "#3E4A54", color2: "#1B2228" },
      tags: ["三言", "话本", "世情"],
      desc: "冯梦龙“三言”之二，四十卷。俞伯牙摔琴谢知音、白娘子永镇雷峰塔，中国最有名的几段故事都在这本里。" },
    { id: "ws:paian", title: "初刻拍案惊奇", author: "凌濛初", category: "小说", page: "初刻拍案驚奇",
      cover: { motif: "stele", seal: "奇", color: "#5E4A44", color2: "#2B211E" },
      tags: ["二拍", "话本", "世情"],
      desc: "凌濛初“二拍”之一，四十卷。转运汉遇巧洞庭红、宣徽院仕女秋千会，题材更近市井，笔比“三言”更放。" },
    { id: "ws:zhanguo", title: "战国策", author: "刘向 编", category: "史部", page: "戰國策",
      cover: { motif: "brush", seal: "策", color: "#5E5240", color2: "#2B251A" },
      tags: ["纵横", "策士", "先秦"],
      desc: "西汉刘向编订，三十三卷。策士们游说诸侯的言辞，纵横捭阖，气势逼人。“邹忌修八尺有余”“唐雎不辱使命”皆出于此。" },
    { id: "ws:zuozhuan", title: "左传", author: "左丘明", category: "史部", page: "春秋左氏傳",
      cover: { motif: "slips", seal: "傳", color: "#4A5A4E", color2: "#202A22" },
      tags: ["春秋", "编年", "先秦"],
      desc: "《春秋》三传之一，记鲁隐公至哀公二百余年事。战争、盟会、辞令、预言，中国叙事散文的老祖宗。" },
    { id: "ws:guoyu", title: "国语", author: "左丘明", category: "史部", page: "國語",
      cover: { motif: "slips", seal: "語", color: "#525A48", color2: "#242920" },
      tags: ["国别史", "先秦", "记言"],
      desc: "中国最早的国别史，二十一卷。分记周、鲁、齐、晋、郑、楚、吴、越八国之事，重记言而略记事，与《左传》互为表里。" },
    { id: "ws:shanhaijing", title: "山海经", author: "佚名", category: "史部", page: "山海經",
      cover: { motif: "mountain", seal: "海", color: "#3E5A5E", color2: "#1B292C" },
      tags: ["神话", "地理", "上古"],
      desc: "十八卷，山经五、海经十三。精卫填海、夸父逐日、刑天舞干戚，中国神话的老家；也是上古山川物产的一部奇书。" },
    { id: "ws:shuijingzhu", title: "水经注", author: "郦道元", category: "史部", page: "水經注",
      cover: { motif: "water", seal: "水", color: "#2E4E5E", color2: "#13262E" },
      tags: ["地理", "山水", "北魏"],
      desc: "北魏郦道元为《水经》作注，四十卷。一千余条河流，沿途山川、城邑、碑刻、传说一一写来，是地理书，也是山水散文的巅峰。" },
    { id: "ws:xuxiake", title: "徐霞客游记", author: "徐弘祖", category: "史部", page: "徐霞客遊記",
      cover: { motif: "peak", seal: "霞", color: "#4A5E5A", color2: "#1F2A27" },
      tags: ["游记", "地理", "明"],
      desc: "明末徐弘祖三十余年行旅所记。黄山、雁荡、滇黔溶洞，皆以双脚丈量、以实见校正旧说。“五岳归来不看山”的底气在此。" },
    { id: "ws:zhuangzi", title: "庄子", author: "庄周", category: "典籍", page: "莊子",
      cover: { motif: "cloud", seal: "莊", color: "#3A5560", color2: "#18262C" },
      tags: ["道家", "逍遥", "先秦"],
      desc: "三十三篇，内篇七、外篇十五、杂篇十一。逍遥游、齐物论、秋水，汪洋恣肆，中国散文与哲学的最高处之一。" },
    { id: "ws:xunzi", title: "荀子", author: "荀况", category: "典籍", page: "荀子",
      cover: { motif: "pine", seal: "荀", color: "#45564A", color2: "#1E2620" },
      tags: ["儒家", "性恶", "先秦"],
      desc: "三十二篇。主张性恶、重礼法，《劝学》开篇“学不可以已”，两千年来蒙童第一课。李斯、韩非皆出其门。" },
    { id: "ws:hanfeizi", title: "韩非子", author: "韩非", category: "典籍", page: "韓非子",
      cover: { motif: "stele", seal: "韓", color: "#4E4640", color2: "#221F1B" },
      tags: ["法家", "术势", "先秦"],
      desc: "五十五篇，法家集大成之作。守株待兔、自相矛盾、滥竽充数，寓言多出于此；说难、孤愤，写尽人主与臣下的心思。" },
    { id: "ws:mozi", title: "墨子", author: "墨翟", category: "典籍", page: "墨子",
      cover: { motif: "gate", seal: "墨", color: "#4A4E44", color2: "#21241D" },
      tags: ["墨家", "兼爱", "先秦"],
      desc: "五十三篇。兼爱、非攻、尚贤、节用，先秦最像“工程师”的一派：守城器械、光学几何、逻辑辩论，都在这本书里。" },
    { id: "ws:sunzi", title: "孙子兵法", author: "孙武", category: "典籍", page: "孫子兵法",
      cover: { motif: "sword", seal: "孫", color: "#5A4038", color2: "#281C18" },
      tags: ["兵家", "谋略", "先秦"],
      desc: "十三篇，六千言。“兵者，诡道也”“不战而屈人之兵”，世界最古老的兵书，也是被译得最多的一本中文书。" },
    { id: "ws:guanzi", title: "管子", author: "管仲", category: "典籍", page: "管子",
      cover: { motif: "water", seal: "管", color: "#3E5258", color2: "#1B2427" },
      tags: ["法家", "经济", "先秦"],
      desc: "七十六篇，托名管仲。讲治国也讲经济：轻重、盐铁、四民分业。中国最早系统谈财政与市场的一部书。" },
    { id: "ws:liezi", title: "列子", author: "列御寇", category: "典籍", page: "列子",
      cover: { motif: "cloud", seal: "列", color: "#485A62", color2: "#1F282C" },
      tags: ["道家", "寓言", "先秦"],
      desc: "八篇。愚公移山、杞人忧天、两小儿辩日，皆出此书。文气不如《庄子》汪洋，却更清简，多寓言而少玄谈。" },
    { id: "ws:huainanzi", title: "淮南子", author: "刘安", category: "典籍", page: "淮南子",
      cover: { motif: "cosmos", seal: "淮", color: "#4A4A60", color2: "#20202A" },
      tags: ["道家", "杂家", "西汉"],
      desc: "西汉淮南王刘安集门客所著，二十一篇。以道为宗，兼采百家，上谈天文下论兵略，是汉初思想的总结。" },
    { id: "ws:yanshi", title: "颜氏家训", author: "颜之推", category: "典籍", page: "顏氏家訓",
      cover: { motif: "court", seal: "顏", color: "#5A5448", color2: "#28241D" },
      tags: ["家训", "南北朝", "处世"],
      desc: "北齐颜之推所著，七卷二十篇。“积财千万，不如薄伎在身”，中国第一部系统的家训，讲教子、治家、读书、处世。" },
    { id: "ws:yuefu", title: "乐府诗集", author: "郭茂倩 编", category: "诗词", page: "樂府詩集",
      cover: { motif: "qin", seal: "樂", color: "#5A4E6E", color2: "#282238" },
      tags: ["乐府", "民歌", "总集"],
      desc: "宋人郭茂倩编，一百卷。从汉魏到五代，郊庙、燕射、鼓吹、相和、清商、杂曲，一部中国古代歌词的总账。" },
    { id: "ws:taoyuanming", title: "陶渊明集", author: "陶渊明", category: "诗词", page: "陶淵明集",
      cover: { motif: "willow", seal: "陶", color: "#5E6E48", color2: "#2A3220" },
      tags: ["田园", "归隐", "东晋"],
      desc: "东晋陶潜诗文全集。归去来兮、桃花源记、饮酒二十首。中国田园诗的源头，也是后世文人退路的样子。" },
    { id: "ws:libai", title: "李太白全集", author: "李白", category: "诗词", page: "李太白全集",
      cover: { motif: "moon", seal: "白", color: "#6A5A3E", color2: "#302718" },
      tags: ["唐诗", "浪漫", "盛唐"],
      desc: "李白诗文全集，三十卷。蜀道难、将进酒、梦游天姥，笔下有酒有月有剑，盛唐的气象都在这里。" },
    { id: "ws:shuyu", title: "漱玉词", author: "李清照", category: "诗词", page: "漱玉詞 (四庫全書本)",
      cover: { motif: "orchid", seal: "李", color: "#6E4A5E", color2: "#30202A" },
      tags: ["宋词", "婉约", "易安"],
      desc: "李清照词集。前半生“争渡，争渡，惊起一滩鸥鹭”，后半生“寻寻觅觅，冷冷清清”，一册词里有一整个北宋到南宋。" },
    { id: "ws:caigentan", title: "菜根谭", author: "洪应明", category: "文集", page: "菜根譚",
      cover: { motif: "seedling", seal: "根", color: "#4E5E42", color2: "#222A1C" },
      tags: ["清言", "处世", "明"],
      desc: "明人洪应明的语录体小品，三百余则。“宠辱不惊，看庭前花开花落”，说修养，也说世故，嚼得菜根，百事可做。" },
    { id: "ws:xiaochuang", title: "小窗幽记", author: "陈继儒", category: "文集", page: "小窗幽記",
      cover: { motif: "window", seal: "窗", color: "#46525A", color2: "#1E252A" },
      tags: ["清言", "小品", "明"],
      desc: "明人陈继儒辑，十二卷。醒、情、峭、灵、素、景、韵、奇、绮、豪、法、倩，一卷一境，是晚明文人最会过日子的证据。" },
    { id: "ws:weilu", title: "围炉夜话", author: "王永彬", category: "文集", page: "圍爐夜話",
      cover: { motif: "candle", seal: "爐", color: "#5A4A42", color2: "#281F1B" },
      tags: ["清言", "处世", "清"],
      desc: "清人王永彬所著，二百二十一则。冬夜围炉，与家人说些安身立命的话。与《菜根谭》《小窗幽记》并称处世三大奇书。" },
    /* ---- 古医书（医部） ---- */
    { id: "ws:huangdi", title: "黄帝内经", author: "黄帝（托）/ 岐伯 等", category: "医部", page: "黃帝內經",
      cover: { motif: "cloud", seal: "黃", color: "#2E5A4E", color2: "#14261F" },
      tags: ["医经", "素问", "灵枢"],
      desc: "分《素问》《灵枢》两部分，凡一百六十二篇。中医理论的源头：阴阳五行、藏象经络、病因病机，皆由此立。" },
    { id: "ws:shanghan", title: "伤寒论", author: "张仲景", category: "医部", page: "傷寒論",
      cover: { motif: "ink", seal: "傷", color: "#5A3A2C", color2: "#28170F" },
      tags: ["伤寒", "方剂", "东汉"],
      desc: "东汉张仲景所著，十卷二十二篇。外感热病辨证论治之祖，桂枝汤、麻黄汤诸方，沿用一千八百年至今。" },
    { id: "ws:shennong", title: "神农本草经", author: "神农（托）", category: "医部", page: "神農本草經",
      cover: { motif: "seedling", seal: "農", color: "#4E5E42", color2: "#222A1C" },
      tags: ["本草", "药性", "汉"],
      desc: "现存最早的中药学专著，载药三百六十五种，分上中下三品。性味归经、君臣佐使，皆滥觞于此。" },
    { id: "ws:bencao", title: "本草纲目", author: "李时珍", category: "医部", page: "本草綱目",
      cover: { motif: "flower", seal: "草", color: "#3E5C55", color2: "#1B2E2B" },
      tags: ["本草", "明", "李时珍"],
      desc: "明李时珍历时二十七载编成，五十二卷，载药一千八百九十二种。集古代本草之大成，东方药物学的百科全书。" },
    { id: "ws:jingui", title: "金匮要略", author: "张仲景", category: "医部", page: "金匱要略",
      cover: { motif: "slips", seal: "匱", color: "#6B4B34", color2: "#33220F" },
      tags: ["杂病", "汉", "方剂"],
      desc: "张仲景《伤寒杂病论》的杂病部分，三卷二十五篇。脏腑经络先后病、胸痹心痛、妇人妊娠，杂病辨证之绳墨。" },
    { id: "ws:qianjin", title: "备急千金要方", author: "孙思邈", category: "医部", page: "備急千金要方",
      cover: { motif: "gate", seal: "千", color: "#4A5C6E", color2: "#202C38" },
      tags: ["方书", "唐", "孙思邈"],
      desc: "唐孙思邈所著，三十卷。首列大医精诚，集唐以前医方五千余首，妇科儿科伤寒杂病无不赅备，医德与医术并重。" },
    { id: "ws:nanjing", title: "难经", author: "秦越人（扁鹊）", category: "医部", page: "難經",
      cover: { motif: "taiji", seal: "難", color: "#3A5560", color2: "#18262C" },
      tags: ["医经", "脉学", "先秦"],
      desc: "旧题秦越人所作，八十一难。补《内经》之未备，独取寸口、命门三焦，中医基础理论又一柱石。" },
    { id: "ws:maijing", title: "脉经", author: "王叔和", category: "医部", page: "脈經",
      cover: { motif: "water", seal: "脈", color: "#5A4038", color2: "#281C18" },
      tags: ["脉学", "晋", "诊断"],
      desc: "西晋王叔和撰，十卷。首次系统总结二十四脉，浮沉迟数滑涩，中医脉诊从此有章可循。" },
    { id: "ws:wenbing", title: "温病条辨", author: "吴鞠通", category: "医部", page: "溫病條辨",
      cover: { motif: "wave", seal: "溫", color: "#5E6E48", color2: "#2A3220" },
      tags: ["温病", "清", "三焦"],
      desc: "清吴鞠通所著，六卷。以三焦为纲辨治温热，创立桑菊饮、银翘散诸方，温病学派的集大成之作。" },
    { id: "ws:yizong", title: "医宗金鉴", author: "吴谦 等 敕编", category: "医部", page: "醫宗金鑒",
      cover: { motif: "stele", seal: "醫", color: "#4E4640", color2: "#221F1B" },
      tags: ["官修", "清", "综合"],
      desc: "清乾隆敕编，九十卷。御制医典，伤寒金匮、妇科幼科、正骨各科俱备，图文并茂，太医院之课本。" },
    { id: "ws:bbb", title: "本草备要", author: "汪昂", category: "医部", page: "本草備要",
      cover: { motif: "seedling", seal: "備", color: "#425A3E", color2: "#1D281A" },
      tags: ["本草", "清", "入门"],
      desc: "清汪昂编，八卷。择常用药四百六十余种，每药述性味主治兼及辨误，本草入门最通行的读本。" },
    { id: "ws:tangtou", title: "汤头歌诀", author: "汪昂", category: "医部", page: "湯頭歌訣",
      cover: { motif: "qin", seal: "湯", color: "#5C6B48", color2: "#2A3220" },
      tags: ["方剂", "清", "歌诀"],
      desc: "清汪昂以七言歌诀记方，三百余首。解表清热补益攻里，诵之成吟，至今仍是学方之捷径。" },
    { id: "ws:yixue", title: "医学三字经", author: "陈念祖（陈修园）", category: "医部", page: "醫學三字經",
      cover: { motif: "bamboo", seal: "學", color: "#46564A", color2: "#1E2620" },
      tags: ["启蒙", "清", "三字经"],
      desc: "清陈修园撰，四卷。三字一句，韵语成章，从医学源流到各证方治，中医启蒙第一书。" },
    { id: "ws:yinshan", title: "饮膳正要", author: "忽思慧", category: "医部", page: "飲膳正要",
      cover: { motif: "court", seal: "飲", color: "#6E5A3E", color2: "#33291A" },
      tags: ["食疗", "元", "养生"],
      desc: "元忽思慧撰，三卷。宫廷饮膳之方，食药同源、养生避忌，现存最早的中医营养学专著。" },
    /* ---- 兵书（兵家） ---- */
    { id: "ws:wuzi", title: "吴子", author: "吴起", category: "兵书", page: "吳子",
      cover: { motif: "stele", seal: "吳", color: "#5A4A3C", color2: "#2A2018" },
      tags: ["兵家", "战国", "治兵"],
      desc: "战国吴起所著，今存六篇。与《孙子》并称「孙吴」，更重练兵与治军，说的是一支军队怎么带得住。" },
    { id: "ws:liutao", title: "六韬", author: "姜望（托）", category: "兵书", page: "六韜",
      cover: { motif: "gate", seal: "韜", color: "#6A5236", color2: "#2C2114" },
      tags: ["兵家", "先秦", "太公"],
      desc: "托名姜太公，分文、武、龙、虎、豹、犬六韬。讲庙算也讲器用，是先秦兵书里最实在的一部。" },
    { id: "ws:sanshiliu", title: "三十六计", author: "佚名", category: "兵书", page: "三十六計",
      cover: { motif: "moon", seal: "計", color: "#4A4A5E", color2: "#202032" },
      tags: ["兵家", "明清", "谋略"],
      desc: "六套三十六条，每条四个字。成书虽晚，却把中国人数千年的算计收成一本小册子。" },
    { id: "ws:weiliao", title: "尉缭子", author: "尉缭", category: "兵书", page: "尉繚子",
      cover: { motif: "sword", seal: "尉", color: "#5C4A3A", color2: "#28201A" },
      tags: ["兵家", "战国", "法令"],
      desc: "二十四篇，重刑赏与号令。谈兵而先谈法，是先秦兵书里最讲制度的一部。" },
    { id: "ws:jixiao", title: "纪效新书", author: "戚继光", category: "兵书", page: "紀效新書",
      cover: { motif: "wave", seal: "戚", color: "#3A5560", color2: "#182B33" },
      tags: ["兵家", "明", "练兵"],
      desc: "戚继光练兵抗倭的实录，鸳鸯阵、狼筅、藤牌都在里面。不是纸上谈兵，是打完仗写下来的。" },
    { id: "ws:wujing", title: "武经总要", author: "曾公亮 等 奉敕编", category: "兵书", page: "武經總要",
      cover: { motif: "city", seal: "武", color: "#5A4436", color2: "#281C14" },
      tags: ["兵家", "北宋", "类书"],
      desc: "北宋官修军事百科，前集讲制度、后集讲战例，还留下世界上最早的几种火药配方。" },
    /* ---- 笔记杂著（笔记） ---- */
    { id: "ws:mengxi", title: "梦溪笔谈", author: "沈括", category: "笔记", page: "夢溪筆談",
      cover: { motif: "ink", seal: "筆", color: "#3E4A52", color2: "#1B2227" },
      tags: ["笔记", "北宋", "博物"],
      desc: "沈括晚年随笔，六百余条。从活字印刷到「石油」这个名字，中国科技史上最重要的一部笔记。" },
    { id: "ws:rongzhai", title: "容斋随笔", author: "洪迈", category: "笔记", page: "容齋隨筆",
      cover: { motif: "brush", seal: "隨", color: "#5A4A3E", color2: "#271F19" },
      tags: ["笔记", "南宋", "考据"],
      desc: "洪迈写了四十年，七十四卷。考经史、辨典故、记见闻，是历代读书人案头常备的一部书。" },
    { id: "ws:dongjing", title: "东京梦华录", author: "孟元老", category: "笔记", page: "東京夢華錄",
      cover: { motif: "city", seal: "夢", color: "#7A5A3A", color2: "#38261A" },
      tags: ["笔记", "北宋", "汴京"],
      desc: "追忆汴京繁华：州桥夜市、瓦舍勾栏、四时风俗。靖康之后写此书，是回忆，也是挽歌。" },
    { id: "ws:luoyang", title: "洛阳伽蓝记", author: "杨衒之", category: "笔记", page: "洛陽伽藍記",
      cover: { motif: "pagoda", seal: "伽", color: "#6A4A4A", color2: "#2C1E1E" },
      tags: ["笔记", "北魏", "佛寺"],
      desc: "记北魏洛阳一千余所佛寺，兼及人物掌故、市井风物。一部寺庙志，也是一座城的兴亡录。" },
    { id: "ws:youyang", title: "酉阳杂俎", author: "段成式", category: "笔记", page: "酉陽雜俎",
      cover: { motif: "cloud", seal: "俎", color: "#4E4658", color2: "#211C28" },
      tags: ["笔记", "唐", "志怪"],
      desc: "唐人段成式的杂记，志怪、博物、轶闻无所不收。鲁迅说它仙佛人鬼以至动植，弥不毕载。" },
    { id: "ws:yuewei", title: "阅微草堂笔记", author: "纪昀", category: "笔记", page: "閱微草堂筆記",
      cover: { motif: "candle", seal: "閱", color: "#4A4A4A", color2: "#1E1E1E" },
      tags: ["笔记", "清", "志怪"],
      desc: "纪晓岚晚年所作，一千余则。与《聊斋》并称而路子不同：蒲松龄写情，纪昀写理。" },
    { id: "ws:zibuyu", title: "子不语", author: "袁枚", category: "笔记", page: "子不語",
      cover: { motif: "candle", seal: "怪", color: "#5A3E4E", color2: "#2A1B24" },
      tags: ["笔记", "清", "志怪"],
      desc: "袁枚记怪之书，正名《新齐谐》。取「子不语怪力乱神」的反意，写鬼写狐，笔调却俏皮。" },
    { id: "ws:taoan", title: "陶庵梦忆", author: "张岱", category: "笔记", page: "陶庵夢憶",
      cover: { motif: "moon", seal: "陶", color: "#4A4258", color2: "#201C28" },
      tags: ["笔记", "明末", "忆旧"],
      desc: "张岱明亡后追忆前朝风物，湖心亭看雪、金山夜戏皆出于此。文字极美，底子极凉。" },
    { id: "ws:youmeng", title: "幽梦影", author: "张潮", category: "笔记", page: "幽夢影",
      cover: { motif: "bamboo", seal: "幽", color: "#3C5448", color2: "#1A2822" },
      tags: ["清言", "清", "小品"],
      desc: "清人张潮的格言小品，二百余则，友人的批语夹在行间。一句「因雪想高士，因花想美人」，说尽文人趣味。" },
    /* ---- 佛道与诸子（佛道） ---- */
    { id: "ws:daodejing", title: "道德经", author: "老子", category: "佛道", page: "道德經",
      cover: { motif: "taiji", seal: "道", color: "#3A4A52", color2: "#18242A" },
      tags: ["道家", "先秦", "五千言"],
      desc: "五千言，八十一章。中国思想里最深的一口井，两千年来取之不尽，谁也说不完。" },
    { id: "ws:baopuzi", title: "抱朴子", author: "葛洪", category: "佛道", page: "抱朴子",
      cover: { motif: "stele", seal: "朴", color: "#5A4E38", color2: "#271F14" },
      tags: ["道家", "东晋", "神仙"],
      desc: "葛洪所著，内篇言神仙方药、炼丹养生，外篇论人间得失。道教史上极重要的一部书。" },
    { id: "ws:liuzu", title: "六祖坛经", author: "慧能", category: "佛道", page: "六祖壇經",
      cover: { motif: "pagoda", seal: "禪", color: "#7A4A34", color2: "#341C12" },
      tags: ["禅宗", "唐", "顿悟"],
      desc: "唯一一部中国人写的「经」。慧能闻《金刚经》而悟，说的是一念之间，明心见性。" },
    { id: "ws:yunji", title: "云笈七签", author: "张君房 编", category: "佛道", page: "雲笈七籤",
      cover: { motif: "star", seal: "籤", color: "#4C4258", color2: "#1F1A26" },
      tags: ["道教", "北宋", "类书"],
      desc: "北宋张君房编，道教类书之冠，一百二十二卷。道教典籍散佚太多，许多篇章靠它才留下来。" },
    /* ---- 史部（续） ---- */
    { id: "ws:zizhi", title: "资治通鉴", author: "司马光", category: "史部", page: "資治通鑑",
      cover: { motif: "brush", seal: "鑑", color: "#5A3A34", color2: "#271614" },
      tags: ["编年体", "通史", "北宋"],
      desc: "二百九十四卷，自战国至五代一千三百六十二年。司马光写了十九年，为的是「鉴于往事，有资于治道」。" },
    { id: "ws:hanshu", title: "汉书", author: "班固", category: "史部", page: "漢書",
      cover: { motif: "stele", seal: "漢", color: "#4A4038", color2: "#1E1915" },
      tags: ["纪传体", "断代", "东汉"],
      desc: "中国第一部纪传体断代史，一百篇。班固写了二十余年，八表未竟而卒，由妹班昭续成。" },
    { id: "ws:houhanshu", title: "后汉书", author: "范晔", category: "史部", page: "後漢書",
      cover: { motif: "stele", seal: "後", color: "#4A3A40", color2: "#1E161A" },
      tags: ["纪传体", "断代", "南朝"],
      desc: "九十卷，记东汉二百年。范晔自许体大思精，列传的论赞尤见文采，为后世史家所宗。" },
    { id: "ws:sanguozhi", title: "三国志", author: "陈寿", category: "史部", page: "三國志",
      cover: { motif: "sword", seal: "志", color: "#4A3E36", color2: "#1E1813" },
      tags: ["纪传体", "断代", "西晋"],
      desc: "六十五卷，分魏蜀吴三书。陈寿叙事简净，裴松之注补其略，正文与注合看才是全璧。" }
  ];
  /* CATALOG:END */
  const PAGE_OF = {}; CATALOG.forEach((c) => { PAGE_OF[c.id] = c.page; });

  /* 目录缓存：取一次目录要 3–8 秒（目录页 + 子页列举两个请求），
     不存下来，每次进详情页都得重等一遍。存到 localStorage，七天有效。 */
  const TOC_KEY = 'mojuan.toc.v1';
  const TOC_TTL = 7 * 24 * 3600 * 1000;
  const TOC_MAX = 60;
  function tocStore() {
    try { return JSON.parse(localStorage.getItem(TOC_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  /* 缓存里除标题外还存每章的 page（子页名）。否则刷新后 getChapter 拿不到章节定位，
     每次开卷都得重新联网取一遍目录（3–8 秒）。 */
  function cachedToc(id) {
    const rec = tocStore()[id];
    if (!rec || !Array.isArray(rec.titles) || rec.titles.length < 2) return null;
    if (Date.now() - (Number(rec.t) || 0) > TOC_TTL) return null;
    /* 命中即算「访问」：把 t 刷成最近使用时间，让淘汰按 LRU 而不是「最近写入」排序。
       读一次就写回 localStorage 太频繁，距上次刷新超过 1 小时才落一次盘。 */
    touchToc(id, rec);
    const pages = Array.isArray(rec.pages) ? rec.pages : [];
    return rec.titles.map((t, i) => {
      const c = { no: i + 1, title: t };
      if (pages[i]) c.page = pages[i];
      return c;
    });
  }
  /* 访问时间节流写回：超过 1 小时才刷新，避免每次读目录都写 localStorage */
  function touchToc(id, rec) {
    const now = Date.now();
    if (now - (Number(rec.t) || 0) < 3600 * 1000) return;
    try {
      const all = tocStore();
      if (all[id]) { all[id].t = now; localStorage.setItem(TOC_KEY, JSON.stringify(all)); }
    } catch (e) { /* 忽略 */ }
  }
  function saveToc(id, chapters) {
    if (!chapters || chapters.length < 2) return;
    try {
      const all = tocStore();
      all[id] = {
        t: Date.now(),
        titles: chapters.map((c) => String(c.title || '').slice(0, 48)),
        pages: chapters.map((c) => (c && c.page ? String(c.page).slice(0, 160) : ''))
      };
      const keys = Object.keys(all);
      if (keys.length > TOC_MAX) {
        keys.sort((a, b) => (all[a].t || 0) - (all[b].t || 0))
          .slice(0, keys.length - TOC_MAX).forEach((k) => { delete all[k]; });
      }
      localStorage.setItem(TOC_KEY, JSON.stringify(all));
    } catch (e) { /* 存不下就算了，下次再取 */ }
  }

  function metaFrom(c) {
    const cover = c.cover || { motif: 'mountain', color: '#3B4356', color2: '#1B2030', seal: c.title[0] };
    return {
      id: c.id, sourceId: 'wikisource', title: c.title, author: c.author, category: c.category,
      status: '完结', online: true,
      desc: c.desc || '维基文库公有领域全文 · 开卷时联网取回',
      words: '联网取回', chars: 0,
      score: 9.0, readers: '在线书库', hot: 30,
      tags: (c.tags || [c.category, '联网']).slice(0, 3), addedAt: 1,
      cover: cover, motif: cover.motif, color: cover.color, color2: cover.color2, seal: cover.seal,
      chapters: cachedToc(c.id) || [{ no: 1, title: '正文待取回' }]
    };
  }

  const source = {
    id: 'wikisource', name: '维基文库（在线）', desc: '连接维基文库公共书库，按需联网取真实全文',
    online: true, enabled: true,
    metasSync() { return CATALOG.map(metaFrom); },
    async metas() { return CATALOG.map(metaFrom); },
    async getBookMeta(id, opts) {
      const c = CATALOG.find((x) => x.id === id);
      if (!c) return null;
      const m = metaFrom(c);
      if (!(opts && opts.force) && m.chapters.length > 1) return m;   /* 命中本地缓存 */
      try {
        const toc = await fetchToc(c.page);
        if (toc.chapters.length) {
          m.chapters = toc.chapters.map((x, i) => ({ no: i + 1, title: x.title, page: x.page }));
          saveToc(id, toc.chapters);
        }
      } catch (e) { console.warn('[维基文库] 目录取回失败', c.page, e && e.message); }
      return m;
    },
    async search(q) {
      try {
        const d = await API({ action: 'query', list: 'search', srsearch: q, srnamespace: 0, srlimit: 12, format: 'json' });
        const items = (d.query && d.query.search) || [];
        return items.map((it) => {
          const cover = { motif: 'mountain', color: '#3B4356', color2: '#1B2030', seal: it.title[0] };
          return {
            id: 'ws:' + it.title, sourceId: 'wikisource', title: it.title, author: '维基文库',
            category: '在线', status: '完结', online: true,
            desc: (it.snippet || '').replace(/<[^>]+>/g, ''),
            words: '待取全文', chars: 0, score: 9.0, readers: '在线书库', hot: 20, tags: ['联网'], addedAt: 2,
            cover: cover, motif: cover.motif, color: cover.color, color2: cover.color2, seal: cover.seal,
            page: it.title, chapters: [{ no: 1, title: '正文待取回' }]
          };
        });
      } catch (e) { return []; }
    },
    /* 本章的校勘记（编者注）：目录构建或取正文时顺手挂到章节对象上，这里只读不取 */
    getChapterNotes(id, no) {
      const page = PAGE_OF[id] || (global.MJ.sources.getBook(id) || {}).page;
      if (!page) return [];
      const toc = workCache[page];
      const ch = toc && toc.chapters[no - 1];
      return (ch && ch.notes) || [];
    },
    async getChapter(id, no) {
      const page = PAGE_OF[id] || (global.MJ.sources.getBook(id) || {}).page;
      if (!page) return ['（这卷没有可用的在线来源）'];
      let toc;
      /* 目录先从内存 workCache 拿；没有再试本地缓存。缓存里有 page 定位就无需重新联网取目录，
         这是刷新页面后还能秒开正文的关键。 */
      if (workCache[page]) toc = workCache[page];
      else {
        const cached = cachedToc(id);
        if (cached && cached.some((c) => c.page)) {
          toc = { chapters: cached };
          workCache[page] = toc;      /* 回填内存，翻章时直接命中 */
        }
      }
      if (!toc) {
        try { toc = await fetchToc(page); } catch (e) { toc = { chapters: [] }; }
        if (toc.chapters.length) saveToc(id, toc.chapters);
      }
      if (!toc.chapters.length) return ['（需要联网才能读取，请检查网络后重试）'];
      /* 目录拿到后回写索引，阅读器才能翻章 */
      const meta = global.MJ.sources.getBook(id);
      if (meta) meta.chapters = toc.chapters.map((c, i) => ({ no: i + 1, title: c.title, page: c.page }));
      const ch = toc.chapters[no - 1];
      if (!ch) return ['（这一章暂无可读正文）'];
      try {
        const paras = await fetchParas(ch, page);
        return paras && paras.length ? paras : ['（这一章暂无可读正文）'];
      } catch (e) {
        return ['（这一章没取回来，请检查网络后重试）'];
      }
    }
  };

  global.MJ = global.MJ || {};
  if (global.MJ.sources) global.MJ.sources.register(source);

  /* —— 想写自己的书源？照下面这个骨架返回一个对象即可 ——
   * global.MJ.sources.register({
   *   id: 'my-source', name: '我的书源', desc: '一句话说明', online: true,
   *   async metas() { return [{ id, sourceId:'my-source', title, author, category, status,
   *     desc, words, chars:0, score:9, readers:'', hot:0, tags:[], addedAt:0,
   *     cover:{motif:'cloud',color:'#2E3F4A',color2:'#152128',seal:'書'},
   *     chapters:[{no:1,title:'全文'}] }]; },
   *   async getChapter(id, no) {
   *     const text = await fetch('你的接口?book=' + encodeURIComponent(id)).then(r => r.text());
   *     const paras = text.split('\n').filter(Boolean);   // 按需解析成段落
   *     return [paras[no-1] || ''];
   *   }
   * });
   */
})(window);
