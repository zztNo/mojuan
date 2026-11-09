/* 墨卷 · 书肆配置与水墨封面
 * 说明：书目的真实内容已全部移到书源（js/classics.js 等），这里只留
 * 与内容无关的展示素材：水墨封面绘制、书肆页签、榜单、热搜词。
 */
(function (global) {
  'use strict';

  /* 分类由书源的 category 字段驱动，这里不再维护固定分类表 */
  const HOT_SEARCH = ['道德经', '诗经', '关雎', '论语', '唐诗三百首', '古文观止', '千字文', '幽梦影'];
  /* 榜单只按书里真实存在的两个量排序：字数、篇目数。
   * 没有联网统计，就不编「热度」「读者评分」这类数据。 */
  const RANK_TABS = [
    { key: 'long', label: '长卷榜' },
    { key: 'short', label: '短卷榜' },
    { key: 'many', label: '篇目榜' }
  ];
  const BANNERS = [
    { title: '关关雎鸠，在河之洲', sub: '三百篇风雅颂 · 诗经', book: 'shijing', color: '#61735F', color2: '#2A352A', motif: 'reeds', tag: '公版典藏' },
    { title: '道可道，非常道', sub: '五千言八十一章 · 道德经', book: 'daodejing', color: '#2C4150', color2: '#131F27', motif: 'water', tag: '镇卷之宝' },
    { title: '观止矣，何以加焉', sub: '先秦至明二百二十篇 · 古文观止', book: 'guwen', color: '#3E5C55', color2: '#1B2E2B', motif: 'peak', tag: '大部头' }
  ];

  /* 可选的封面纹样（自定义封面面板用） */
  const MOTIFS = [
    ['reeds', '蒹葭'], ['orchid', '香草'], ['moon', '明月'], ['willow', '春柳'],
    ['ink', '泼墨'], ['slips', '竹简'], ['gate', '学宫'], ['water', '流水'],
    ['taiji', '中和'], ['seedling', '新芽'], ['cosmos', '星野'], ['court', '庭院'],
    ['surname', '姓册'], ['qin', '古琴'], ['stele', '碑刻'], ['window', '窗灯'],
    ['shadow', '花影'], ['pine', '松风'], ['peak', '层峦'], ['petals', '落花'],
    ['candle', '孤灯'], ['brush', '史笔'], ['pagoda', '古塔'], ['mountain', '远山'], ['bamboo', '青竹'],
    ['cloud', '云纹'], ['wave', '潮纹'], ['city', '楼阁'], ['star', '星轨'],
    ['flower', '梅枝'], ['sword', '剑气']
  ];

  /* 水墨书封背景图形。w = 白，d = 黑，逐层叠加出水墨层次。
   * 画幅 200×290，右上留白给竖排书名，左下留白给作者。 */
  function motifSvg(motif, c1, c2, uid) {
    const w = 'rgba(255,255,255,';
    const d = 'rgba(0,0,0,';
    let art = '';
    switch (motif) {
      /* ---------- 诗词 ---------- */
      case 'reeds': /* 蒹葭苍苍，白露为霜 */
        art = `<circle cx="150" cy="58" r="25" fill="${w}.18)"/>
          <g stroke="${d}.30)" fill="none" stroke-width="2" stroke-linecap="round">
            <path d="M28 290Q34 214 26 156"/><path d="M50 290Q56 220 62 162"/><path d="M12 290Q14 230 6 182"/>
            <path d="M168 290Q160 216 168 158"/><path d="M186 290Q192 226 198 174"/>
          </g>
          <g fill="${d}.28)">
            <path d="M26 156q-9-18 2-34q10 16-2 34Z"/><path d="M62 162q-8-16 3-30q9 14-3 30Z"/>
            <path d="M168 158q9-18-2-34q-10 16 2 34Z"/><path d="M198 174q8-15-2-28q-9 13 2 28Z"/>
          </g>
          <g fill="none" stroke="${w}.15)" stroke-width="1.5">
            <path d="M-10 232Q40 222 90 232T210 232"/><path d="M-10 254Q40 244 90 254T210 254"/>
          </g>
          <path d="M-10 268Q100 252 210 268L210 290L-10 290Z" fill="${d}.24)"/>
          <path d="M104 92q7-6 13 0M120 86q7-6 13 0" stroke="${d}.30)" stroke-width="1.6" fill="none" stroke-linecap="round"/>`;
        break;
      case 'orchid': /* 香草美人 · 兰 */
        art = `<circle cx="148" cy="62" r="24" fill="${w}.14)"/>
          <g fill="${d}.20)">
            <path d="M42 290C24 220 44 150 88 92C74 168 62 236 58 290Z"/>
            <path d="M66 290C58 226 66 158 98 106C88 176 84 240 84 290Z"/>
            <path d="M148 290C160 222 152 156 118 100C128 172 134 240 136 290Z"/>
            <path d="M126 290C132 232 128 178 108 140C114 196 116 246 118 290Z"/>
          </g>
          <g stroke="${d}.26)" fill="none" stroke-width="1.6" stroke-linecap="round">
            <path d="M92 200Q110 156 118 92"/><path d="M74 178Q84 134 60 96"/>
          </g>
          <g transform="translate(118 92)" fill="${w}.40)">
            <ellipse cx="0" cy="-15" rx="6" ry="15"/>
            <ellipse cx="0" cy="-15" rx="6" ry="15" transform="rotate(72)"/>
            <ellipse cx="0" cy="-15" rx="6" ry="15" transform="rotate(144)"/>
            <ellipse cx="0" cy="-15" rx="6" ry="15" transform="rotate(216)"/>
            <ellipse cx="0" cy="-15" rx="6" ry="15" transform="rotate(288)"/>
            <circle r="4" fill="${d}.32)"/>
          </g>
          <g fill="${w}.34)">
            <circle cx="58" cy="104" r="3"/><circle cx="50" cy="96" r="2.4"/><circle cx="66" cy="96" r="2.4"/>
            <circle cx="152" cy="128" r="2.6"/><circle cx="146" cy="120" r="2.2"/><circle cx="160" cy="120" r="2.2"/>
          </g>
          <path d="M-10 278Q100 262 210 278L210 290L-10 290Z" fill="${d}.20)"/>`;
        break;
      case 'moon': /* 举头望明月 · 一叶扁舟 */
        art = `<circle cx="122" cy="78" r="40" fill="${w}.20)"/>
          <circle cx="122" cy="78" r="54" fill="none" stroke="${w}.10)" stroke-width="1"/>
          <g fill="${w}.10)"><circle cx="112" cy="66" r="7"/><circle cx="134" cy="88" r="5"/></g>
          <path d="M-10 208L44 158L78 194L116 150L158 194L210 166L210 290L-10 290Z" fill="${d}.16)"/>
          <path d="M-10 244Q100 230 210 244L210 290L-10 290Z" fill="${d}.26)"/>
          <path d="M-10 258Q50 250 110 258T210 258" stroke="${w}.24)" stroke-width="1.4" fill="none"/>
          <path d="M62 268q26 0 34 8q-17 5-34 3q-17 2-34-3q8-8 34-8Z" fill="${w}.34)"/>
          <path d="M92 262v-20" stroke="${w}.26)" stroke-width="1.6"/>`;
        break;
      case 'willow': /* 春城无处不飞花 · 柳燕 */
        art = `<g stroke="${d}.28)" fill="none" stroke-width="1.8" stroke-linecap="round">
            <path d="M22 -10Q50 54 36 126"/><path d="M70 -10Q78 62 62 146"/>
            <path d="M116 -10Q126 58 112 132"/><path d="M162 -10Q176 54 166 120"/>
          </g>
          <g fill="${d}.24)">
            <ellipse cx="40" cy="46" rx="8" ry="3" transform="rotate(40 40 46)"/><ellipse cx="28" cy="78" rx="8" ry="3" transform="rotate(-28 28 78)"/>
            <ellipse cx="66" cy="62" rx="8" ry="3" transform="rotate(36 66 62)"/><ellipse cx="58" cy="104" rx="8" ry="3" transform="rotate(-24 58 104)"/>
            <ellipse cx="112" cy="54" rx="8" ry="3" transform="rotate(38 112 54)"/><ellipse cx="106" cy="92" rx="8" ry="3" transform="rotate(-26 106 92)"/>
            <ellipse cx="166" cy="44" rx="8" ry="3" transform="rotate(40 166 44)"/><ellipse cx="158" cy="82" rx="8" ry="3" transform="rotate(-22 158 82)"/>
          </g>
          <g stroke="${d}.26)" stroke-width="1.5" fill="none" stroke-linecap="round">
            <path d="M96 172q7-8 14 0q7-8 14 0"/><path d="M62 200q6-7 12 0q6-7 12 0"/>
          </g>
          <path d="M-10 250Q100 232 210 250L210 290L-10 290Z" fill="${d}.22)"/>`;
        break;
      case 'ink': /* 泼墨飞白 */
        art = `<path d="M44 54q28-32 62-10q24 17 6 44q-21 32-58 23q-32-10-10-57Z" fill="${d}.24)"/>
          <path d="M118 120q32-17 48 6q13 19-8 32q-26 17-46-4q-13-15 6-34Z" fill="${d}.16)"/>
          <path d="M-12 236q56-20 114-6t110-10" stroke="${d}.20)" stroke-width="7" fill="none" stroke-linecap="round"/>
          <g fill="${w}.30)"><circle cx="88" cy="196" r="2.6"/><circle cx="122" cy="210" r="2"/><circle cx="156" cy="182" r="2.4"/><circle cx="62" cy="214" r="1.8"/></g>
          <path d="M-10 254Q60 236 112 254Q164 272 210 248L210 290L-10 290Z" fill="${d}.26)"/>`;
        break;
      /* ---------- 典籍 ---------- */
      case 'slips': /* 竹简编绳 */
        art = `<circle cx="150" cy="56" r="22" fill="${w}.12)"/>
          <g fill="${d}.20)">
            <rect x="18" y="70" width="13" height="176" rx="3"/><rect x="35" y="64" width="13" height="182" rx="3"/>
            <rect x="52" y="70" width="13" height="176" rx="3"/><rect x="69" y="64" width="13" height="182" rx="3"/>
            <rect x="86" y="70" width="13" height="176" rx="3"/><rect x="103" y="64" width="13" height="182" rx="3"/>
            <rect x="120" y="70" width="13" height="176" rx="3"/><rect x="137" y="64" width="13" height="182" rx="3"/>
          </g>
          <g stroke="${w}.22)" stroke-width="2"><path d="M14 106H154"/><path d="M14 214H154"/></g>
          <g stroke="${w}.16)" stroke-width="1.2">
            <path d="M41 128v38M58 132v30M75 126v44M92 134v32M109 128v40M126 132v34M143 126v42"/>
          </g>
          <path d="M-10 276Q100 262 210 276L210 290L-10 290Z" fill="${d}.20)"/>`;
        break;
      case 'gate': /* 学宫牌坊 · 明明德 */
        art = `<circle cx="150" cy="52" r="18" fill="${w}.10)"/>
          <path d="M16 136Q100 96 184 136" stroke="${d}.30)" stroke-width="10" fill="none" stroke-linecap="round"/>
          <path d="M30 120Q100 88 170 120" stroke="${w}.14)" stroke-width="2" fill="none"/>
          <path d="M10 134q8-16 24-8M190 134q-8-16-24-8" stroke="${d}.26)" stroke-width="5" fill="none" stroke-linecap="round"/>
          <g stroke="${d}.26)" stroke-width="7" fill="none"><path d="M50 290V146"/><path d="M150 290V146"/></g>
          <rect x="74" y="160" width="52" height="32" rx="2" fill="${d}.22)" stroke="${w}.20)" stroke-width="1.2"/>
          <path d="M50 216h100" stroke="${w}.16)" stroke-width="2"/>
          <path d="M56 232h88" stroke="${w}.10)" stroke-width="1.2"/>
          <path d="M36 288h128" stroke="${d}.24)" stroke-width="4"/>
          <path d="M-10 278Q100 264 210 278L210 290L-10 290Z" fill="${d}.18)"/>`;
        break;
      case 'water': /* 上善若水 */
        art = `<circle cx="152" cy="56" r="22" fill="${w}.14)"/>
          <path d="M-14 210Q30 150 74 186Q118 222 160 176Q186 148 214 164" stroke="${w}.22)" stroke-width="3" fill="none"/>
          <path d="M-14 236Q30 176 74 212Q118 248 160 202Q186 174 214 190" stroke="${d}.22)" stroke-width="2.4" fill="none"/>
          <g stroke="${w}.16)" stroke-width="1.4" fill="none">
            <path d="M-10 252Q40 242 90 252T210 252"/><path d="M-10 268Q40 258 90 268T210 268"/>
          </g>
          <g fill="${w}.28)"><circle cx="46" cy="196" r="3"/><circle cx="132" cy="212" r="2.4"/><circle cx="96" cy="176" r="2"/></g>
          <path d="M-10 280Q100 268 210 280L210 290L-10 290Z" fill="${d}.24)"/>`;
        break;
      case 'taiji': /* 致中和 */
        art = `<g transform="translate(100 130)">
            <circle r="50" fill="${w}.08)"/>
            <path d="M0 -50A50 50 0 0 1 0 50A25 25 0 0 1 0 0A25 25 0 0 0 0 -50Z" fill="${d}.34)"/>
            <circle cx="0" cy="-25" r="7" fill="${w}.40)"/>
            <circle cx="0" cy="25" r="7" fill="${d}.42)"/>
            <circle r="50" fill="none" stroke="${w}.22)" stroke-width="1.4"/>
          </g>
          <g fill="none" stroke="${w}.10)" stroke-width="1"><circle cx="100" cy="130" r="64"/><circle cx="100" cy="130" r="76"/></g>
          <path d="M-10 276Q100 262 210 276L210 290L-10 290Z" fill="${d}.18)"/>`;
        break;
      case 'pine': /* 浩然之气 · 松风 */
        art = `<circle cx="148" cy="58" r="22" fill="${w}.14)"/>
          <path d="M106 290Q96 214 98 150Q100 112 88 86" stroke="${d}.34)" stroke-width="8" fill="none" stroke-linecap="round"/>
          <path d="M98 176Q72 172 50 150" stroke="${d}.32)" stroke-width="3.5" fill="none" stroke-linecap="round"/>
          <path d="M98 134Q126 128 150 108" stroke="${d}.32)" stroke-width="3.5" fill="none" stroke-linecap="round"/>
          <g transform="translate(50 150) rotate(-16)">
            <path d="M0 0L-26-10L-22-22L-12-30L0-34L12-30L22-22L26-10Z" fill="${d}.24)"/>
            <g stroke="${w}.26)" stroke-width="1.1" stroke-linecap="round">
              <path d="M0 0L-26-10"/><path d="M0 0L-22-22"/><path d="M0 0L-12-30"/><path d="M0 0L0-34"/>
              <path d="M0 0L12-30"/><path d="M0 0L22-22"/><path d="M0 0L26-10"/>
            </g>
          </g>
          <g transform="translate(150 108) rotate(18)">
            <path d="M0 0L-24-8L-20-20L-10-28L0-32L10-28L20-20L24-8Z" fill="${d}.22)"/>
            <g stroke="${w}.24)" stroke-width="1.1" stroke-linecap="round">
              <path d="M0 0L-24-8"/><path d="M0 0L-20-20"/><path d="M0 0L-10-28"/><path d="M0 0L0-32"/>
              <path d="M0 0L10-28"/><path d="M0 0L20-20"/><path d="M0 0L24-8"/>
            </g>
          </g>
          <g transform="translate(88 86)">
            <path d="M0 0L-20-8L-16-22L-8-30L0-34L8-30L16-22L20-8Z" fill="${d}.22)"/>
            <g stroke="${w}.26)" stroke-width="1.1" stroke-linecap="round">
              <path d="M0 0L-20-8"/><path d="M0 0L-16-22"/><path d="M0 0L-8-30"/><path d="M0 0L0-34"/>
              <path d="M0 0L8-30"/><path d="M0 0L16-22"/><path d="M0 0L20-8"/>
            </g>
          </g>
          <path d="M-10 272Q100 258 210 272L210 290L-10 290Z" fill="${d}.20)"/>`;
        break;
      /* ---------- 蒙学 ---------- */
      case 'seedling': /* 人之初 · 新芽 */
        art = `<circle cx="146" cy="58" r="26" fill="${w}.14)"/>
          <path d="M-10 254Q100 236 210 254L210 290L-10 290Z" fill="${d}.24)"/>
          <path d="M92 256Q90 214 96 182" stroke="${d}.30)" stroke-width="3" fill="none" stroke-linecap="round"/>
          <path d="M96 196Q68 190 58 168Q88 172 96 190Z" fill="${w}.36)"/>
          <path d="M96 208Q124 198 132 176Q102 180 96 202Z" fill="${w}.28)"/>
          <path d="M-10 274Q50 264 110 274T210 274" stroke="${w}.16)" stroke-width="1.4" fill="none"/>`;
        break;
      case 'cosmos': /* 天地玄黄，宇宙洪荒 */
        art = `<circle cx="150" cy="62" r="26" fill="${w}.22)"/>
          <g fill="${w}.55)">
            <circle cx="34" cy="52" r="1.6"/><circle cx="68" cy="34" r="1.2"/><circle cx="104" cy="60" r="1.5"/>
            <circle cx="52" cy="102" r="1.2"/><circle cx="128" cy="106" r="1.4"/><circle cx="176" cy="128" r="1.2"/>
            <circle cx="26" cy="140" r="1.4"/><circle cx="92" cy="132" r="1.1"/>
          </g>
          <path d="M-10 176Q40 150 90 176T210 176" stroke="${w}.10)" stroke-width="1" fill="none"/>
          <path d="M-10 212L54 150L96 190L134 142L210 206L210 290L-10 290Z" fill="${d}.18)"/>
          <path d="M-10 250Q100 232 210 250L210 290L-10 290Z" fill="${d}.22)"/>`;
        break;
      case 'court': /* 入则孝 · 庭院 */
        art = `<path d="M14 150L100 108L186 150Z" fill="${d}.30)"/>
          <path d="M2 150H198" stroke="${w}.20)" stroke-width="2"/>
          <path d="M44 150V248M156 150V248" stroke="${w}.16)" stroke-width="2"/>
          <rect x="82" y="176" width="36" height="72" fill="${w}.12)"/>
          <path d="M100 176v72" stroke="${w}.10)" stroke-width="1.4"/>
          <path d="M44 196H156" stroke="${w}.10)" stroke-width="1.2"/>
          <path d="M-10 262Q100 248 210 262L210 290L-10 290Z" fill="${d}.20)"/>`;
        break;
      case 'surname': /* 姓氏册 */
        art = `<g fill="none" stroke="${w}.16)" stroke-width="1.4">
            <rect x="28" y="62" width="46" height="46"/><rect x="78" y="62" width="46" height="46"/><rect x="128" y="62" width="46" height="46"/>
            <rect x="28" y="112" width="46" height="46"/><rect x="78" y="112" width="46" height="46"/><rect x="128" y="112" width="46" height="46"/>
            <rect x="28" y="162" width="46" height="46"/><rect x="78" y="162" width="46" height="46"/><rect x="128" y="162" width="46" height="46"/>
          </g>
          <rect x="78" y="112" width="46" height="46" fill="${w}.14)"/>
          <g stroke="${w}.24)" stroke-width="1.6">
            <path d="M42 76v18M62 76v12M92 76v18M112 76v12M142 76v18M162 76v12"/>
            <path d="M42 200v18M62 200v12M92 200v18M112 200v12M142 200v18M162 200v12"/>
          </g>
          <path d="M-10 258Q100 244 210 258L210 290L-10 290Z" fill="${d}.20)"/>`;
        break;
      case 'qin': /* 声律 · 古琴 */
        art = `<circle cx="148" cy="58" r="20" fill="${w}.12)"/>
          <path d="M14 152q10-22 30-22h112q20 0 30 22q-10 22-30 22H44q-20 0-30-22Z" fill="${d}.30)"/>
          <g stroke="${w}.30)" stroke-width=".9" fill="none">
            <path d="M30 145h140"/><path d="M26 150h148"/><path d="M26 155h148"/><path d="M28 160h144"/>
          </g>
          <g fill="${w}.36)"><circle cx="58" cy="153" r="1.8"/><circle cx="90" cy="153" r="1.8"/><circle cx="122" cy="153" r="1.8"/><circle cx="152" cy="153" r="1.8"/></g>
          <g stroke="${w}.16)" stroke-width="1.4" fill="none"><path d="M146 172v20M156 172v15"/></g>
          <path d="M-10 244Q100 228 210 244L210 290L-10 290Z" fill="${d}.18)"/>`;
        break;
      case 'stele': /* 格言刻石 */
        art = `<circle cx="146" cy="56" r="20" fill="${w}.10)"/>
          <path d="M68 244V96q0-28 32-28t32 28v148Z" fill="${d}.24)"/>
          <path d="M60 244V96q0-36 40-36t40 36v148Z" fill="none" stroke="${w}.14)" stroke-width="1.6"/>
          <g stroke="${w}.18)" stroke-width="1.4">
            <path d="M84 106v40M98 106v52M112 106v34M126 106v46"/>
          </g>
          <path d="M44 244h112v20H44Z" fill="${d}.30)"/>
          <path d="M-10 268Q100 254 210 268L210 290L-10 290Z" fill="${d}.18)"/>`;
        break;
      case 'window': /* 窗棂灯火 */
        art = `<circle cx="100" cy="120" r="44" fill="${w}.10)"/>
          <rect x="44" y="64" width="112" height="112" rx="2" fill="${d}.20)"/>
          <circle cx="100" cy="120" r="13" fill="${w}.22)"/>
          <g stroke="${w}.24)" stroke-width="2.4" fill="none"><path d="M100 64v112M44 120h112"/></g>
          <g stroke="${w}.12)" stroke-width="1.2" fill="none">
            <path d="M44 92h112M44 148h112M72 64v112M128 64v112"/>
          </g>
          <path d="M-10 246Q100 232 210 246L210 290L-10 290Z" fill="${d}.20)"/>`;
        break;
      /* ---------- 文集 ---------- */
      case 'shadow': /* 幽梦影 · 花影 */
        art = `<circle cx="136" cy="74" r="30" fill="${w}.16)"/>
          <path d="M-12 272Q40 214 66 158Q88 112 122 86" stroke="${d}.24)" fill="none" stroke-width="3" stroke-linecap="round"/>
          <g fill="${d}.16)">
            <ellipse cx="150" cy="228" rx="26" ry="12" transform="rotate(-16 150 228)"/>
            <ellipse cx="112" cy="252" rx="30" ry="12" transform="rotate(-8 112 252)"/>
            <ellipse cx="66" cy="238" rx="20" ry="9" transform="rotate(12 66 238)"/>
          </g>
          <g fill="${w}.34)"><circle cx="122" cy="86" r="4"/><circle cx="112" cy="76" r="3"/><circle cx="132" cy="78" r="3"/><circle cx="118" cy="96" r="2.6"/></g>
          <path d="M-10 282Q100 270 210 282L210 290L-10 290Z" fill="${d}.22)"/>`;
        break;
      case 'peak': /* 层峦叠嶂 · 观止 */
        art = `<circle cx="146" cy="56" r="22" fill="${w}.16)"/>
          <path d="M-10 196L48 104L90 168L128 116L210 194L210 290L-10 290Z" fill="${d}.18)"/>
          <path d="M-10 234L64 152L108 204L148 166L210 230L210 290L-10 290Z" fill="${d}.28)"/>
          <path d="M-10 236Q60 218 124 240T210 232" stroke="${w}.14)" stroke-width="1.4" fill="none"/>
          <path d="M-10 272Q60 256 120 274T210 266L210 290L-10 290Z" fill="${d}.20)"/>`;
        break;
      /* ---------- 在线长篇 ---------- */
      case 'petals': /* 落花成冢 */
        art = `<circle cx="144" cy="66" r="26" fill="${w}.12)"/>
          <g fill="${w}.42)">
            <ellipse cx="60" cy="70" rx="7" ry="4" transform="rotate(28 60 70)"/>
            <ellipse cx="86" cy="106" rx="6" ry="3.4" transform="rotate(-22 86 106)"/>
            <ellipse cx="40" cy="128" rx="6" ry="3.4" transform="rotate(42 40 128)"/>
            <ellipse cx="112" cy="150" rx="7" ry="4" transform="rotate(-38 112 150)"/>
            <ellipse cx="62" cy="182" rx="6" ry="3.4" transform="rotate(18 62 182)"/>
            <ellipse cx="126" cy="200" rx="6" ry="3.4" transform="rotate(-52 126 200)"/>
          </g>
          <g stroke="${d}.26)" stroke-width="2.4" fill="none" stroke-linecap="round">
            <path d="M-10 272Q60 226 78 168Q92 122 130 96"/>
            <path d="M44 290Q92 246 98 196"/>
          </g>
          <g fill="${d}.16)"><ellipse cx="130" cy="248" rx="34" ry="15"/><ellipse cx="70" cy="262" rx="28" ry="12"/></g>
          <path d="M-10 282Q100 270 210 282L210 290L-10 290Z" fill="${d}.22)"/>`;
        break;
      case 'candle': /* 孤灯说鬼 */
        art = `<circle cx="120" cy="112" r="42" fill="${w}.10)"/>
          <path d="M120 62q11 14 0 30q-11-16 0-30Z" fill="${w}.55)"/>
          <rect x="112" y="96" width="16" height="66" rx="3" fill="${w}.26)"/>
          <path d="M100 162h40l-6 10h-28Z" fill="${d}.26)"/>
          <path d="M86 172h68" stroke="${w}.22)" stroke-width="2"/>
          <g fill="${w}.18)"><circle cx="152" cy="200" r="2"/><circle cx="74" cy="150" r="1.6"/><circle cx="62" cy="196" r="2.2"/></g>
          <path d="M-10 254Q100 240 210 254L210 290L-10 290Z" fill="${d}.22)"/>`;
        break;
      case 'brush': /* 史笔如椽 */
        art = `<circle cx="148" cy="60" r="22" fill="${w}.12)"/>
          <g transform="rotate(25 100 170)">
            <rect x="92" y="86" width="16" height="98" rx="8" fill="${d}.28)"/>
            <rect x="95" y="66" width="10" height="22" rx="3" fill="${w}.26)"/>
            <path d="M91 184h18l-9 46Z" fill="${d}.34)"/>
          </g>
          <path d="M-10 258Q40 248 90 258T210 258" stroke="${w}.14)" stroke-width="1.4" fill="none"/>
          <path d="M-10 274Q100 260 210 274L210 290L-10 290Z" fill="${d}.20)"/>`;
        break;
      case 'pagoda': /* 西行取经 · 古塔 */
        art = `<circle cx="148" cy="52" r="20" fill="${w}.12)"/>
          <g fill="${d}.24)">
            <path d="M100 34l6 12h-12Z"/>
            <path d="M92 50h16v10H92Z"/>
            <path d="M78 62h44l-5 12H83Z"/>
            <path d="M68 76h64l-7 13H75Z"/>
            <path d="M58 91h84l-8 14H66Z"/>
            <path d="M48 107h104l-10 16H58Z"/>
          </g>
          <path d="M64 125h72v126H64Z" fill="${d}.20)"/>
          <path d="M46 251h108v24H46Z" fill="${d}.26)"/>
          <g fill="${w}.14)">
            <rect x="92" y="190" width="16" height="34" rx="8"/>
            <rect x="74" y="148" width="10" height="16" rx="1"/>
            <rect x="116" y="148" width="10" height="16" rx="1"/>
          </g>
          <g stroke="${w}.13)" stroke-width="1.2"><path d="M64 176h72M64 230h72"/></g>
          <path d="M-10 282Q100 272 210 282L210 290L-10 290Z" fill="${d}.18)"/>`;
        break;
      /* ---------- 通用旧纹样 ---------- */
      case 'mountain':
        art = `<circle cx="146" cy="60" r="25" fill="${w}.30)"/><circle cx="146" cy="60" r="38" fill="none" stroke="${w}.12)" stroke-width="1"/>
          <path d="M-10 196 L38 130 L76 172 L118 106 L172 184 L210 152 L210 290 L-10 290Z" fill="${d}.14)"/>
          <path d="M-10 232 L52 170 L96 214 L148 152 L210 224 L210 290 L-10 290Z" fill="${d}.26)"/>
          <path d="M-10 262 L60 218 L120 258 L180 214 L210 240 L210 290 L-10 290Z" fill="${d}.18)"/>`;
        break;
      case 'city':
        art = `<circle cx="152" cy="58" r="22" fill="${w}.22)"/>
          <path d="M20 200 h160 v90 H20Z" fill="${d}.18)"/>
          <path d="M10 200 L100 168 L190 200 Z" fill="${d}.28)"/>
          <path d="M40 168 L100 142 L160 168 Z" fill="${d}.22)"/>
          <path d="M62 142 L100 124 L138 142 Z" fill="${d}.26)"/>
          <rect x="88" y="238" width="24" height="52" fill="${w}.10)"/>
          <path d="M20 216 h160 M20 232 h160" stroke="${w}.10)" stroke-width="1"/>
          <path d="M-10 276 Q100 258 210 276" stroke="${w}.14)" fill="none" stroke-width="2"/>`;
        break;
      case 'flower':
        art = `<circle cx="150" cy="62" r="26" fill="${w}.16)"/>
          <path d="M-10 280 Q46 210 62 160 Q78 112 128 66" stroke="${d}.34)" fill="none" stroke-width="4" stroke-linecap="round"/>
          <path d="M62 160 Q92 150 112 122 M78 116 Q52 108 40 86 M100 92 Q118 100 142 88" stroke="${d}.30)" fill="none" stroke-width="2"/>
          <g fill="${w}.48)"><circle cx="112" cy="122" r="5"/><circle cx="128" cy="70" r="6"/><circle cx="40" cy="86" r="5"/><circle cx="142" cy="88" r="5"/><circle cx="88" cy="150" r="4"/><circle cx="60" cy="196" r="4"/></g>`;
        break;
      case 'star':
        art = `<g fill="none" stroke="${w}" stroke-width="1"><ellipse cx="100" cy="128" rx="88" ry="34" opacity=".20" transform="rotate(-24 100 128)"/><ellipse cx="100" cy="128" rx="126" ry="52" opacity=".13" transform="rotate(-24 100 128)"/><ellipse cx="100" cy="128" rx="60" ry="22" opacity=".22" transform="rotate(-24 100 128)"/></g>
          <circle cx="100" cy="128" r="30" fill="${w}.12)"/><circle cx="100" cy="128" r="16" fill="${w}.26)"/>
          <g fill="${w}.7)"><circle cx="34" cy="72" r="1.6"/><circle cx="168" cy="86" r="2"/><circle cx="52" cy="196" r="1.4"/><circle cx="150" cy="222" r="1.8"/><circle cx="80" cy="46" r="1.3"/><circle cx="184" cy="164" r="1.4"/><circle cx="24" cy="140" r="1.5"/></g>`;
        break;
      case 'sword': /* 剑气 · 长剑垂穗 */
        art = `<circle cx="146" cy="150" r="52" fill="${w}.07)"/>
          <g transform="rotate(14 100 150)">
            <path d="M100 32L107 62V198H93V62Z" fill="${w}.30)"/>
            <path d="M100 40V198" stroke="${w}.18)" stroke-width="1"/>
            <rect x="76" y="198" width="48" height="8" rx="4" fill="${d}.30)"/>
            <rect x="93" y="206" width="14" height="46" rx="6" fill="${d}.26)"/>
            <circle cx="100" cy="256" r="7" fill="${d}.32)"/>
            <path d="M100 262q-16 10-11 28" stroke="${w}.24)" stroke-width="1.8" fill="none" stroke-linecap="round"/>
            <path d="M100 262q16 10 11 28" stroke="${w}.16)" stroke-width="1.8" fill="none" stroke-linecap="round"/>
          </g>
          <path d="M-10 268Q100 252 210 268L210 290L-10 290Z" fill="${d}.20)"/>`;
        break;
      case 'bamboo':
        art = `<g stroke="${d}.30)" fill="none" stroke-width="5" stroke-linecap="round"><path d="M46 290 Q40 170 52 40"/><path d="M92 290 Q98 190 86 88"/><path d="M150 290 Q142 160 156 54"/></g>
          <g stroke="${w}.14)" stroke-width="1"><path d="M40 100 h24 M42 168 h22 M88 138 h22 M144 104 h24 M146 190 h22"/></g>
          <g fill="${d}.28)"><path d="M52 108 Q86 88 116 96 Q86 112 52 108Z"/><path d="M50 152 Q18 132 -8 142 Q20 160 50 152Z"/><path d="M90 176 Q122 158 152 166 Q122 184 90 176Z"/><path d="M154 128 Q184 110 212 118 Q184 138 154 128Z"/><path d="M152 208 Q120 194 96 202 Q124 218 152 208Z"/></g>`;
        break;
      case 'wave':
        art = `<circle cx="146" cy="66" r="24" fill="${w}.18)"/>
          <path d="M-10 210L46 152L84 190L120 158L166 196L210 170L210 244L-10 244Z" fill="${d}.14)"/>
          <g fill="none" stroke="${w}" stroke-linecap="round" stroke-width="2">
            <path d="M-10 216Q30 200 70 216T150 216T230 216" opacity=".22"/>
            <path d="M-10 240Q30 224 70 240T150 240T230 240" opacity=".26"/>
            <path d="M-10 260Q30 244 70 260T150 260T230 260" opacity=".18"/>
          </g>
          <path d="M-10 268Q46 246 104 270Q160 292 210 264L210 290L-10 290Z" fill="${d}.28)"/>`;
        break;
      default: /* cloud */
        art = `<circle cx="146" cy="64" r="27" fill="${w}.22)"/>
          <g fill="none" stroke="${w}.20)" stroke-width="2"><path d="M-10 176 Q24 146 58 176 Q88 142 122 174 Q154 146 190 174 Q204 158 220 168"/><path d="M-10 212 Q26 184 62 212 Q94 180 128 210 Q160 182 194 210 Q206 198 220 204"/><path d="M-10 248 Q26 220 62 248 Q94 216 128 246 Q160 218 194 246 Q206 234 220 240"/></g>
          <path d="M-10 262 Q100 240 210 262 L210 290 L-10 290Z" fill="${d}.18)"/>`;
    }
    return `<svg class="cover-art" viewBox="0 0 200 290" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs><linearGradient id="g${uid}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="${c1}"/><stop offset="100%" stop-color="${c2}"/></linearGradient>
        <linearGradient id="f${uid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="55%" stop-color="rgba(0,0,0,0)"/><stop offset="100%" stop-color="rgba(0,0,0,.34)"/></linearGradient></defs>
      <rect width="200" height="290" fill="url(#g${uid})"/>
      <circle cx="26" cy="242" r="96" fill="rgba(255,255,255,.045)"/>
      ${art}
      <rect width="200" height="290" fill="url(#f${uid})"/>
      <rect x="8" y="8" width="184" height="274" fill="none" stroke="rgba(255,255,255,.20)" stroke-width="1"/>
    </svg>`;
  }

  global.MJ = global.MJ || {};
  global.MJ.data = {
    HOT_SEARCH, RANK_TABS, BANNERS, MOTIFS,
    motifSvg
  };
})(window);
