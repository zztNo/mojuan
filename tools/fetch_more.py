# -*- coding: utf-8 -*-
"""墨卷 · 批量抓取 chinese-poetry 原始 JSON 到本地缓存（带重试，断点续取）。
用法: python tools/fetch_more.py
"""
import urllib.request, urllib.parse, ssl, json, os, time, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CP_CACHE = os.path.join(ROOT, "tools", "cache", "cp")
os.makedirs(CP_CACHE, exist_ok=True)

CTX = ssl.create_default_context(); CTX.check_hostname = False; CTX.verify_mode = ssl.CERT_NONE
GH = "https://raw.githubusercontent.com/chinese-poetry/chinese-poetry/master/"
UA = "Mozilla/5.0 (MojuanFetcher)"

# 目标文件清单（相对仓库路径）
TARGETS = [
    "蒙学/youxueqionglin.json",
    "蒙学/wenzimengqiu.json",
    "宋词/宋词三百首.json",
    "元曲/yuanqu.json",
    "曹操诗集/caocao.json",
    "纳兰性德/纳兰性德诗集.json",
]


def dest(path):
    return os.path.join(CP_CACHE, path.replace("/", "__"))


def grab(path, tries=6):
    fn = dest(path)
    if os.path.exists(fn) and os.path.getsize(fn) > 100:
        return "cached"
    url = GH + urllib.parse.quote(path)
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            b = urllib.request.urlopen(req, timeout=30, context=CTX).read()
            json.loads(b)  # 校验
            open(fn, "wb").write(b)
            return "ok %d" % len(b)
        except Exception as e:
            last = e
            time.sleep(2 + i)
    return "FAIL %s" % type(last).__name__


def listdir(path, tries=4):
    url = "https://api.github.com/repos/chinese-poetry/chinese-poetry/contents/" + urllib.parse.quote(path)
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            d = json.load(urllib.request.urlopen(req, timeout=25, context=CTX))
            return [x["name"] for x in d]
        except Exception:
            time.sleep(2 + i)
    return []


if __name__ == "__main__":
    # 先探两个多卷目录
    for d in ["五代诗词/huajianji", "五代诗词/nantang"]:
        names = listdir(d)
        print("##", d, "->", names)
        sys.stdout.flush()
        for n in names:
            if n.endswith(".json"):
                TARGETS.append(d + "/" + n)
    for t in TARGETS:
        print(t, grab(t))
        sys.stdout.flush()
