# 墨卷 · 生成零依赖单文件版（双击即可用，不依赖任何服务器）
# 运行: python tools/build_standalone.py
import os, base64, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read(rel):
    with open(os.path.join(ROOT, rel), encoding='utf-8') as f:
        return f.read()


def b64(rel):
    with open(os.path.join(ROOT, rel), 'rb') as f:
        return base64.b64encode(f.read()).decode('ascii')


def inline_script(rel):
    assert os.path.isfile(os.path.join(ROOT, rel)), '单文件版要内联的脚本不存在: ' + rel
    js = read(rel).replace('</script', '<\\/script')
    return '<script>\n' + js + '\n</script>'


html = read('index.html')
css = read('css/style.css').replace('</style', '<\\/style')
# 封面纸纹：单文件版放在 file:// 下没有相对路径可依，内联成 data URI
css = css.replace(
    'url(../img/paper.webp)',
    'url(data:image/webp;base64,' + b64('img/paper.webp') + ')')

html = html.replace(
    '<link rel="icon" type="image/svg+xml" href="icons/favicon.svg">',
    '<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,' + b64('icons/favicon.svg') + '">')
html = html.replace(
    '<link rel="apple-touch-icon" href="icons/icon-192.png">',
    '<link rel="apple-touch-icon" href="data:image/png;base64,' + b64('icons/icon-192.png') + '">')
# 不依赖确切换行符：CRLF 或属性顺序变了也都删得掉
html = re.sub(r'<link rel="manifest"[^>]*>\s*', '', html, count=1)
html = html.replace('<link rel="stylesheet" href="css/style.css">', '<style>\n' + css + '\n</style>')

# 脚本顺序直接从 index.html 读，新增 <script> 不会再被这个清单静默漏掉
JS_ORDER = tuple(re.findall(r'<script[^>]+src="([^"]+)"', html))
assert JS_ORDER, 'index.html 里没找到任何脚本'

BOOKS_DIR = os.path.join(ROOT, 'js', 'books')

for rel in JS_ORDER:
    tag = '<script src="%s"></script>' % rel
    assert tag in html, 'missing script tag: ' + tag
    src = inline_script(rel)
    if rel == 'js/classics-meta.js':
        # 单文件版要把整库正文一并内联，保持「双击即读整库」，不依赖 js/books/ 的按需加载
        shards = []
        for name in sorted(os.listdir(BOOKS_DIR)):
            if name.endswith('.js'):
                shards.append(inline_script('js/books/' + name))
        src = src + '\n' + '\n'.join(shards)
    if rel == 'js/app.js':
        # file:// 下不注册 Service Worker，也没有 manifest
        src, n = re.subn(
            r"if \('serviceWorker' in navigator\) \{[\s\S]*?\n  \}",
            "/* 单文件版：不注册 Service Worker */", src, count=1)
        assert n == 1, 'Service Worker 注册代码没匹配到，检查 app.js 结尾'
    html = html.replace(tag, src)

# 单文件版跑在 file:// 下，任何残留的相对 src 都会 404
_left = re.findall(r'<script[^>]+src="([^"]+)"', html)
assert not _left, '还有未内联的脚本: ' + ', '.join(_left)

html = html.replace('<title>', '<!-- 墨卷单文件版：全部样式、脚本、图标已内联，无需服务器 -->\n<title>', 1)
html = html.replace('<html lang="zh-CN">', '<html lang="zh-CN" data-standalone="1">', 1)

out = os.path.join(ROOT, 'mojuan-offline.html')
with open(out, 'w', encoding='utf-8') as f:
    f.write(html)
print('standalone written:', out, os.path.getsize(out), 'bytes')

# 源码变了就自动升 SW 缓存版本并刷新预缓存清单，省得每次手改
import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sync_sw
if not sync_sw.sync():
    print('sw.js unchanged')
