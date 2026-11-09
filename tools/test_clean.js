#!/usr/bin/env node
/* 墨卷 · 维基文库清洗函数的 golden test
 * 运行：node tools/test_clean.js
 * 零依赖，直接断言固定输入 → 期望输出。改清洗逻辑后跑一遍，防止回归。
 */
'use strict';
const assert = require('assert');
const c = require('../js/wikisource-clean.js');

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.error('  ✗ ' + name + '\n    期望 ' + w + '\n    实得 ' + g); }
}

console.log('cleanHtml');
eq('剥标签去空白', c.cleanHtml('<p>甲</p><p>乙</p>'), '甲 乙');
eq('去掉注释脚注 [1]', c.cleanHtml('<p>甲[1]乙</p>'), '甲 乙');
eq('去掉 style/script', c.cleanHtml('<style>x{}</style><script>a</script><p>正文</p>'), '正文');
eq('去掉 ws-header 导航表格', c.cleanHtml('<table class="ws-header"><tr><td>目录</td></tr></table><p>第一段</p>'), '第一段');
eq('去掉 reference 上标', c.cleanHtml('<p>甲<sup class="reference">[1]</sup>乙</p>'), '甲 乙');
eq('&nbsp; 转空格并折叠', c.cleanHtml('<p>甲&nbsp;&nbsp;乙</p>'), '甲 乙');
eq('空输入返回空', c.cleanHtml(''), '');

console.log('trimFoot');
/* 页脚标记只在正文末尾才截断；短文本里出现的「分类：」属于正文，不能拦腰砍 */
eq('末尾页脚被截断', c.trimFoot('正文很长'.repeat(20) + '分类：某某'), '正文很长'.repeat(20));
eq('顶部导航框不误杀', c.trimFoot('姊妹计划：百科 数据项 ' + '正文很长'.repeat(30)), '姊妹计划：百科 数据项 ' + '正文很长'.repeat(30));
eq('无标记原样返回', c.trimFoot('正文没有标记'), '正文没有标记');
eq('空输入兜底', c.trimFoot(''), '');

console.log('stripNav');
eq('剥开头「目录」', c.stripNav('目录：第一回正文'), '第一回正文');
eq('连续剥多层导航', c.stripNav('回目录 上一回 下一回 正文'), '正文');
eq('中间导航不动', c.stripNav('正文 上一回 后面'), '正文 上一回 后面');

console.log('splitParas');
eq('按句号断句', c.splitParas('第一句。第二句。第三句。第四句。'), ['第一句。第二句。第三句。第四句。']);
eq('每4句合成一段', c.splitParas('一。二。三。四。五。'), ['一。二。三。四。', '五。']);
eq('右引号后不误断', c.splitParas('所谓「仁者。”」说完。'), ['所谓「仁者。”」说完。']);
eq('开头导航被剥掉', c.splitParas('下一回 正文第一句。'), ['正文第一句。']);
eq('空输入兜底', c.splitParas(''), ['']);

console.log('numToCn');
eq('个位', c.numToCn(5), '五');
eq('十', c.numToCn(10), '十');
eq('十一', c.numToCn(11), '十一');
eq('二十', c.numToCn(20), '二十');
eq('九十九', c.numToCn(99), '九十九');
eq('一百', c.numToCn(100), '一百');
eq('一百零五', c.numToCn(105), '一百零五');
eq('一百一十', c.numToCn(110), '一百一十');
eq('一百二十', c.numToCn(120), '一百二十');

console.log('prettyTitle');
eq('第001回→第一回', c.prettyTitle('第001回'), '第一回');
eq('第120回→第一百二十回', c.prettyTitle('第120回'), '第一百二十回');
eq('带空格第 3 章', c.prettyTitle('第 3 章'), '第三章');
eq('非数字章节不动', c.prettyTitle('逍遥游'), '逍遥游');

console.log('');
if (fail) { console.error('❌ ' + fail + ' 个失败，' + pass + ' 个通过'); process.exit(1); }
console.log('✅ 全部 ' + pass + ' 个断言通过');
