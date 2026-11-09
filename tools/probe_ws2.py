# -*- coding: utf-8 -*-
"""探测维基文库候选书：验证目录结构是否可读（章节数 / 每章字数 / 子页数）。
用法: python tools/probe_ws2.py
输出: tools/cache/ws-probe.json
"""
import urllib.request, urllib.parse, ssl, json, re, os, time, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "tools", "cache", "ws-probe.json")
CTX = ssl.create_default_context(); CTX.check_hostname = False; CTX.verify_mode = ssl.CERT_NONE
API = "https://zh.wikisource.org/w/api.php"
UA = "MojuanReader/1.0 (catalog probe)"

CANDIDATES = [
    # 小说
    "儒林外史", "封神演義", "東周列國志", "鏡花緣", "老殘遊記", "官場現形記",
    "二十年目睹之怪現狀", "孽海花", "三俠五義", "隋唐演義", "說岳全傳", "兒女英雄傳",
    "醒世恆言", "喻世明言", "警世通言", "初刻拍案驚奇", "海上花列傳", "品花寶鑑",
    # 史部
    "戰國策", "左傳", "國語", "漢書", "後漢書", "山海經", "水經注", "資治通鑑",
    "徐霞客遊記", "洛陽伽藍記",
    # 诸子
    "莊子", "荀子", "韓非子", "墨子", "孫子兵法", "管子", "列子", "淮南子",
    "商君書", "鬼谷子", "菜根譚", "小窗幽記", "圍爐夜話", "傳習錄", "顏氏家訓",
    # 诗文
    "宋詞三百首", "元曲三百首", "花間集", "樂府詩集", "文選", "陶淵明集",
    "李太白全集", "杜工部集", "漱玉詞", "納蘭詞", "古詩源", "玉臺新詠", "詩品",
    # 佛道
    "金剛經", "六祖壇經", "心經", "抱朴子", "太上感應篇",
]


def api(params, tries=4, timeout=25):
    p = dict(params); p.setdefault("format", "json"); p["origin"] = "*"
    url = API + "?" + urllib.parse.urlencode(p)
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            return json.load(urllib.request.urlopen(req, timeout=timeout, context=CTX))
        except Exception as e:
            last = e; time.sleep(1.5 + i * 2)
    raise last


def clean(html):
    if not html:
        return ""
    html = re.sub(r"<style[\s\S]*?</style>", "", html)
    html = re.sub(r"<script[\s\S]*?</script>", "", html)
    html = re.sub(r"<sup[^>]*class=\"[^\"]*reference[^\"]*\"[\s\S]*?</sup>", "", html)
    html = re.sub(r"<[^>]+>", " ", html)
    html = re.sub(r"\[\d+\]", " ", html)
    return re.sub(r"\s+", " ", html).strip()


def page_text(page):
    d = api({"action": "parse", "page": page, "prop": "text", "variant": "zh-hans"})
    if d.get("error"):
        return None
    return clean((d.get("parse", {}).get("text", {}) or {}).get("*", ""))


def subpages(page):
    out, seen, cont = [], set(), {}
    for _ in range(4):
        q = {"action": "query", "list": "allpages", "apprefix": page + "/", "aplimit": 500}
        q.update(cont)
        try:
            d = api(q)
        except Exception:
            break
        for p in (d.get("query", {}) or {}).get("allpages", []) or []:
            t = p["title"]
            if not t.startswith(page + "/"):
                continue
            rel = t[len(page) + 1:]
            if not rel or "/" in rel or rel in seen:
                continue
            seen.add(rel); out.append(rel)
        c = d.get("continue") or {}
        if c.get("apcontinue"):
            cont = c
        else:
            break
    return out


def resolve(title):
    """简体书名 -> 维基文库实际条目名"""
    try:
        d = api({"action": "query", "list": "search", "srsearch": "intitle:" + title,
                 "srnamespace": 0, "srlimit": 3})
        hits = [x["title"] for x in (d.get("query", {}) or {}).get("search", []) or []]
        if hits:
            return hits
    except Exception:
        pass
    return []


def probe(title):
    r = {"q": title}
    try:
        txt = page_text(title)
    except Exception as e:
        r["err"] = type(e).__name__; return r
    if txt is None:
        r["err"] = "not-found"
        r["hits"] = resolve(title)
        return r
    mk = re.findall(r"第[一二三四五六七八九十百千0-9]+[章回卷篇]", txt)
    subs = subpages(title)
    avg = None
    if mk:
        parts = re.split(r"第[一二三四五六七八九十百千0-9]+[章回卷篇]", txt)
        segs = [s.strip() for s in parts[1:] if s.strip()]
        if segs:
            avg = sum(len(s) for s in segs) // len(segs)
    r.update({"chars": len(txt), "markers": len(mk), "avg": avg, "subs": len(subs),
              "subSample": subs[:3], "head": txt[:30]})
    # 判定可用性
    if mk and 3 <= len(mk) <= 400 and avg is not None and avg >= 200:
        r["verdict"] = "inline"          # 单页内联，可直接读
    elif subs:
        r["verdict"] = "subpages"        # 目录页 + 子页
    elif txt and not mk:
        r["verdict"] = "single"          # 单篇全文
    else:
        r["verdict"] = "toc-only"        # 只有目录，读不到正文
    return r


if __name__ == "__main__":
    args = sys.argv[1:]
    out_path = OUT
    if args and args[0].startswith("--out="):
        out_path = args[0][6:]
        args = args[1:]
    targets = args or CANDIDATES
    res = []
    if os.path.exists(out_path):
        try:
            res = [x for x in json.load(open(out_path, encoding="utf-8")) if "verdict" in x or "err" in x]
        except Exception:
            res = []
    done = {x["q"] for x in res}
    for t in targets:
        if t in done:
            continue
        r = probe(t)
        res.append(r)
        print(json.dumps(r, ensure_ascii=False))
        sys.stdout.flush()
        json.dump(res, open(out_path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        time.sleep(0.5)
    print("total", len(res), file=sys.stderr)
