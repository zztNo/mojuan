/* 墨卷 · 本地卷编码识别专项
   中文本地书不是只有 UTF-8：老论坛下的 .txt 多是 GBK，港台作者用 Big5，
   Windows 记事本「Unicode」另存出来的是 UTF-16LE。任何一本解错都是满屏乱码，
   而 TextDecoder 只有 utf-8 会因非法字节抛错——gb18030 / big5 对任何字节都
   「解码成功」，所以这里逐字节比对结果，而不是看有没有报错。 */
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const FILE = 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/');
const CHROME = 'C:/Users/15810/AppData/Local/ms-playwright/chromium-1252/chrome-win64/chrome.exe';
const chromium = require('C:/Users/15810/.workbuddy/binaries/node/versions/22.22.2-6/node_modules/@playwright/cli/node_modules/playwright').chromium;

/* 同一段话的六种字节形态（GBK / Big5 / UTF-16LE / UTF-16BE / UTF-8+BOM / 纯 ASCII） */
const CASES = [
  { name: 'gbk.txt', chs: 2, want: '夜里下了雨，屋檐的水',
    hex: 'b5dad2bbd5c220c9bdd4c20a0ad2b9c0efcfc2c1cbd3eaa3accedde9dcb5c4cbaed2bbb5ced2bbb5cec2e4d4dac7e0caafb0e5c9cfa1a30a0ab5dab6fed5c220b3f6b9d80a0accecbbb9c3bbc1c1a3acb3c7c3c5b8d5bfaad2bbccf5b7eca3accad8c3c5b5c4c0cfb1f8b4f2d7c5b9fec7b7a1a30a' },
  { name: 'big5.txt', chs: 2, want: '夜裡下了雨，屋簷的水',
    hex: 'b2c4a440b3b920a473a4eb0a0aa95db8cca455a446ab42a141abcec3b2aabaa4f4a440ba77a440ba77b8a8a662ab43a5dbaa4fa457a1430a0ab2c4a447b3b920a558c3f60a0aa4d1c1d9a853ab47a141abb0aaf9ade8b67da440b1f8c15fa141a675aaf9aabaa6d1a74ca5b4b5dbaba2a4eda1430a' },
  { name: 'u16le.txt', chs: 2, want: '夜里下了雨，屋檐的水',
    hex: '2c7b004ee07a2000715c08670a000a001c59cc910b4e864ee8960cff4b5c906a8476346c004ef46e004ef46e3d8428575297f3777f670a4e02300a000a002c7b8c4ee07a2000fa5173510a000a002959d88fa16cae4e0cffce57e8951a52005f004e61671d7f0cff885be89584760180755153624077c854206b02300a00' },
  { name: 'u16be.txt', chs: 2, want: '夜里下了雨，屋檐的水',
    hex: '7b2c4e007ae000205c716708000a000a591c91cc4e0b4e8696e8ff0c5c4b6a9076846c344e006ef44e006ef4843d5728975277f3677f4e0a3002000a000a7b2c4e8c7ae0002051fa5173000a000a59298fd86ca14eaeff0c57ce95e8521a5f004e0067617f1dff0c5b8895e87684800151756253774054c86b203002000a' },
  { name: 'u8bom.txt', chs: 2, want: '夜里下了雨，屋檐的水',
    hex: 'efbbbfe7acace4b880e7aba020e5b1b1e69c880a0ae5a49ce9878ce4b88be4ba86e99ba8efbc8ce5b18be6aa90e79a84e6b0b4e4b880e6bbb4e4b880e6bbb4e890bde59ca8e99d92e79fb3e69dbfe4b88ae380820a0ae7acace4ba8ce7aba020e587bae585b30a0ae5a4a9e8bf98e6b2a1e4baaeefbc8ce59f8ee997a8e5889ae5bc80e4b880e69da1e7bc9defbc8ce5ae88e997a8e79a84e88081e585b5e68993e79d80e59388e6aca0e380820a' },
  { name: 'ascii.txt', chs: 2, want: 'bright cold day in April',
    hex: '4368617074657220310a0a49742077617320612062726967687420636f6c642064617920696e20417072696c2e0a0a4368617074657220320a0a4d6f726520746578742e0a' },
];

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) pass++; else { fail++; console.log('  ✗ ' + n + (e ? ' :: ' + e : '')); } };
const toB64 = (hex) => Buffer.from(hex, 'hex').toString('base64');

(async () => {
  const b = await chromium.launch({ executablePath: CHROME });
  const p = await b.newPage({ viewport: { width: 430, height: 900 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(FILE + '#/shelf');
  await p.waitForTimeout(700);

  const parse = (b64, name) => p.evaluate(async (arg) => {
    const bin = atob(arg.b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const st = performance.now();
    const out = await MJ.importer.parseFile(new File([u8], arg.name, { type: 'text/plain' }));
    return {
      ms: Math.round(performance.now() - st),
      chs: out.chapters.length,
      text: out.chapters.map((c) => c.paras.join('')).join(''),
    };
  }, { b64, name });

  for (const c of CASES) {
    const r = await parse(toB64(c.hex), c.name);
    ok(c.name + ' 文字未乱码', r.text.indexOf(c.want) >= 0, r.text.slice(0, 40));
    ok(c.name + ' 章节切分正确', r.chs === c.chs, 'chs=' + r.chs);
    /* 乱码的典型特征：替换符、私用区、假名混进来 */
    ok(c.name + ' 无替换符', r.text.indexOf('\uFFFD') < 0);
  }

  /* 空文件 / 只有空白：不该抛错，更不该卡住 */
  const empty = await p.evaluate(async () => {
    try {
      const out = await MJ.importer.parseFile(new File([new Uint8Array(0)], 'e.txt', { type: 'text/plain' }));
      return { ok: true, chs: out.chapters.length };
    } catch (e) { return { ok: false, msg: String(e.message).slice(0, 40) }; }
  });
  ok('空文件不抛错', empty.ok === true, JSON.stringify(empty));

  /* 大文件：GBK 正文重复到 2MB 左右，确认「先探样本再整本解码」没有拖慢导入 */
  const bigB64 = toB64(CASES[0].hex);
  const big = await p.evaluate(async (arg) => {
    const bin = atob(arg.b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const reps = Math.ceil((2 * 1024 * 1024) / u8.length);
    const all = new Uint8Array(u8.length * reps);
    for (let i = 0; i < reps; i++) all.set(u8, i * u8.length);
    const st = performance.now();
    const out = await MJ.importer.parseFile(new File([all], 'big.txt', { type: 'text/plain' }));
    return { ms: Math.round(performance.now() - st), mb: +(all.length / 1048576).toFixed(1), chs: out.chapters.length };
  }, { b64: bigB64 });
  ok('2MB GBK 导入在 800ms 内', big.ms < 800, 'ms=' + big.ms);
  ok('2MB 内容识别未乱码', big.chs > 1, 'chs=' + big.chs);
  console.log(`  2MB GBK 实测 ${big.ms}ms（${big.mb}MB，${big.chs} 章）`);

  ok('无 JS 报错', errs.length === 0, errs.join(' | '));

  console.log(`本地卷编码：${pass} PASS / ${fail} FAIL`);
  await b.close();
  process.exit(fail ? 1 : 0);
})();
