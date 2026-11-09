# 墨卷 · 把 js/classics-data.js 拆成「书目元数据 + 每本一个正文分片」
# 运行: python tools/split_classics.py
#
# 为什么要拆：全量数据 1.26MB，占首屏资源的 80%，而书肆只需要书目信息（约 53KB）。
# 拆分后首屏只加载 classics-meta.js，正文在打开某本书时才取 js/books/<id>.js。
#
# 产物：
#   js/classics-meta.js       window.MJ_CLASSICS_META = [...]      书目 + 章节标题 + 字数
#   js/books/<id>.js          window.MJ_BOOKS[id] = [[标题,[段落…]], …]
import os, json, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# 优先读缓存里的全量数据（js/ 下只留分片，避免首屏误加载）；重跑 fetch 后可再从 js/ 读
_CACHE = os.path.join(ROOT, 'tools', 'cache', 'classics-data.full.js')
_LIVE = os.path.join(ROOT, 'js', 'classics-data.js')
SRC = _CACHE if os.path.exists(_CACHE) else _LIVE
BOOKS_DIR = os.path.join(ROOT, 'js', 'books')


def load_data():
    """用 node 执行原文件拿到纯 JSON（正则解析容易在字符串里的 ] 上出错）"""
    script = (
        "global.window = {};"
        "require(" + json.dumps(SRC.replace('\\', '/')) + ");"
        "process.stdout.write(JSON.stringify(window.MJ_CLASSICS || []));"
    )
    out = subprocess.run(['node', '-e', script], capture_output=True, check=True)
    return json.loads(out.stdout.decode('utf-8'))


def main():
    data = load_data()
    if not data:
        print('没有读到任何书，放弃', file=sys.stderr)
        return 1

    os.makedirs(BOOKS_DIR, exist_ok=True)

    meta = []
    total_chars = 0
    for b in data:
        chapters = b.get('chapters') or []
        chars = sum(len(''.join(c.get('paras') or [])) for c in chapters)
        total_chars += chars
        meta.append({
            'id': b['id'],
            'title': b['title'],
            'author': b.get('author', ''),
            'category': b.get('category', ''),
            'status': b.get('status', '完结'),
            'desc': b.get('desc', ''),
            'score': b.get('score', 9.2),
            'tags': b.get('tags') or [],
            'addedAt': b.get('addedAt', 0),
            'chars': chars,
            'cover': b.get('cover') or {},
            # 章目只存标题字符串：{no,title} 每章多占十七八个字节，
            # 二十多本书三千多章就是 45KB，首屏没必要为这些括号和键名买单。
            'chapters': [c.get('title') or ('第%d章' % (i + 1))
                         for i, c in enumerate(chapters)]
        })

        payload = [[c.get('title') or ('第%d章' % (i + 1)), c.get('paras') or []]
                   for i, c in enumerate(chapters)]
        js = '(window.MJ_BOOKS=window.MJ_BOOKS||{})[' + json.dumps(b['id'], ensure_ascii=False) \
             + ']=' + json.dumps(payload, ensure_ascii=False, separators=(',', ':')) + ';\n'
        with open(os.path.join(BOOKS_DIR, b['id'] + '.js'), 'w', encoding='utf-8') as f:
            f.write(js)

    meta_js = '/* 书目元数据：由 tools/split_classics.py 生成，勿手改 */\nwindow.MJ_CLASSICS_META=' \
              + json.dumps(meta, ensure_ascii=False, separators=(',', ':')) + ';\n'
    with open(os.path.join(ROOT, 'js', 'classics-meta.js'), 'w', encoding='utf-8') as f:
        f.write(meta_js)

    meta_kb = os.path.getsize(os.path.join(ROOT, 'js', 'classics-meta.js')) / 1024
    shards = sorted(os.listdir(BOOKS_DIR))
    sizes = [os.path.getsize(os.path.join(BOOKS_DIR, s)) for s in shards]
    print('书 %d 本 · 正文 %d 字' % (len(meta), total_chars))
    print('classics-meta.js  %.1f KB' % meta_kb)
    print('分片 %d 个 · 共 %.1f KB · 最大 %.1f KB（%s）' % (
        len(shards), sum(sizes) / 1024, max(sizes) / 1024, shards[sizes.index(max(sizes))]))
    return 0


if __name__ == '__main__':
    sys.exit(main())
