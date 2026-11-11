# 墨卷 · 自动同步 Service Worker 的缓存清单与版本号
# 运行: python tools/sync_sw.py（也可单独跑；build_standalone.py 会自动调用）
# 原理：把 index.html 引用的脚本、icons/img、正文分片的内容算一个哈希写进 sw.js 顶部。
#       内容没变 → 什么都不做；内容变了 → 自动把 CACHE 版本号 +1 并刷新清单。
#       这样就不会出现「改了 js 却忘了升版本，老用户一直吃旧缓存」。
import os
import re
import hashlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read(rel):
    with open(os.path.join(ROOT, rel), encoding='utf-8') as f:
        return f.read()


def read_bytes(rel):
    with open(os.path.join(ROOT, rel), 'rb') as f:
        return f.read()


def collect():
    html = read('index.html')
    scripts = re.findall(r'<script[^>]+src="([^"]+)"', html)
    links = re.findall(r'<link[^>]+href="([^"]+)"', html)

    assets = ['./', './index.html']
    for u in scripts + links:
        if u.startswith(('http://', 'https://', 'data:', '#')):
            continue
        p = './' + u.lstrip('./')
        if p not in assets:
            assets.append(p)
    for folder in ('icons', 'img'):
        d = os.path.join(ROOT, folder)
        if not os.path.isdir(d):
            continue
        for name in sorted(os.listdir(d)):
            p = './' + folder + '/' + name
            if p not in assets:
                assets.append(p)
    for must in ('./manifest.webmanifest', './css/style.css'):
        if must not in assets:
            assets.append(must)

    books = os.path.join(ROOT, 'js', 'books')
    shards = sorted(f[:-3] for f in os.listdir(books) if f.endswith('.js'))
    return assets, shards


def content_hash(assets, shards):
    paths = set()
    for a in assets:
        rel = a.lstrip('./')
        if rel and os.path.isfile(os.path.join(ROOT, rel)):
            paths.add(rel)
    for s in shards:
        rel = 'js/books/' + s + '.js'
        if os.path.isfile(os.path.join(ROOT, rel)):
            paths.add(rel)
    h = hashlib.sha256()
    for rel in sorted(paths):
        h.update(rel.encode('utf-8'))
        h.update(read_bytes(rel))
    return h.hexdigest()[:12]


def sync():
    sw_path = os.path.join(ROOT, 'sw.js')
    sw = read('sw.js')
    assets, shards = collect()
    digest = content_hash(assets, shards)

    old = re.search(r'^// content-hash: ([0-9a-f]+)\s*$', sw, re.M)
    if old and old.group(1) == digest:
        return False  # 内容没变，别制造无意义的 diff

    m = re.search(r"const CACHE = 'mojuan-v(\d+)'", sw)
    ver = (int(m.group(1)) + 1) if m else 1

    asset_block = 'const ASSETS = [\n' + ''.join(
        "  %r,\n" % a for a in assets).rstrip(',\n') + '\n];'
    shard_block = 'const SHARDS = [%s].map((id) => \'./js/books/\' + id + \'.js\');' % (
        ', '.join("'%s'" % s for s in shards))

    sw = re.sub(r'^// content-hash: [0-9a-f]+\n', '', sw, count=1, flags=re.M)
    sw = re.sub(r"const CACHE = 'mojuan-v\d+';", "const CACHE = 'mojuan-v%d';" % ver, sw, count=1)
    sw = re.sub(r'const ASSETS = \[[\s\S]*?\];', lambda _: asset_block, sw, count=1)
    sw = re.sub(r'const SHARDS = \[[\s\S]*?\);', lambda _: shard_block, sw, count=1)

    with open(sw_path, 'w', encoding='utf-8') as f:
        f.write('// content-hash: %s\n' % digest + sw)
    print('sw.js synced -> mojuan-v%d (%d assets, %d shards)' % (ver, len(assets), len(shards)))
    return True


if __name__ == '__main__':
    if not sync():
        print('sw.js unchanged')
