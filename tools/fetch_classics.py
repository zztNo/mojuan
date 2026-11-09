# -*- coding: utf-8 -*-
"""
抓取真实公版中文典籍，清洗 + 繁->简，生成 js/classics-data.js。

数据来源：
  1. chinese-poetry/chinese-poetry（GitHub 开源，公有领域古籍整理）
     - 诗经 / 论语 / 楚辞 / 唐诗三百首 / 千家诗 / 水墨唐诗 / 四书五经 / 蒙学 / 幽梦影 / 古文观止
  2. 维基文库 zh.wikisource.org（道德经 王弼本，已缓存）
性质：全部为公有领域（作者逝世逾千年），可自由分发。
本地缓存：tools/cache/cp/ 与 tools/cache/api/，断点续取、失败不中断。
"""
import urllib.request, ssl, re, json, time, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CP_CACHE = os.path.join(ROOT, "tools", "cache", "cp")
API_CACHE = os.path.join(ROOT, "tools", "cache", "api")
os.makedirs(CP_CACHE, exist_ok=True)
os.makedirs(API_CACHE, exist_ok=True)

CTX = ssl.create_default_context(); CTX.check_hostname = False; CTX.verify_mode = ssl.CERT_NONE
GH = "https://raw.githubusercontent.com/chinese-poetry/chinese-poetry/master/"

# ---------- 网络（带缓存） ----------
def fetch_raw(url, timeout=60, tries=4):
    last = None
    for _ in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (MojuanFetcher)"})
            return urllib.request.urlopen(req, timeout=timeout, context=CTX).read().decode("utf-8", "ignore")
        except Exception as e:
            last = e; time.sleep(1.5)
    raise last

def cp(path):
    """取 chinese-poetry 仓库里的 JSON（带磁盘缓存）"""
    fn = os.path.join(CP_CACHE, path.replace("/", "__"))
    if os.path.exists(fn):
        try:
            return json.load(open(fn, encoding="utf-8"))
        except Exception:
            pass
    raw = fetch_raw(GH + urllib.parse.quote(path))
    open(fn, "w", encoding="utf-8").write(raw)
    return json.loads(raw)

# ---------- 繁 -> 简 ----------
TS = {}
_ts = os.path.join(ROOT, "tools", "cache", "ts.txt")
if os.path.exists(_ts):
    for line in open(_ts, encoding="utf-8").read().splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        p = line.split("\t")
        if len(p) >= 2 and p[1].split():
            TS[p[0].strip()] = p[1].split()[0]

def simp(s):
    if not s:
        return s
    s = "".join(TS.get(c, c) for c in s)
    # 繁简表把「乾」一律折成「干」，但「乾坤」是固定词，折了就成了「干坤」
    return s.replace("干坤", "乾坤")

def clean(s):
    if not s:
        return ""
    s = simp(s)
    s = s.replace("\u3000", " ")
    s = re.sub(r"[ \t]+", " ", s).strip()
    return s

def paras(lst):
    out = []
    for p in lst or []:
        c = clean(p)
        if c:
            out.append(c)
    return out

# ---------- 书名 / 封面 ----------
BOOKS = [
    dict(id="shijing", title="诗经", author="佚名 · 孔子删定", cat="诗词", motif="reeds", seal="詩",
         c1="#61735F", c2="#2A352A", tags=["风雅颂", "三百篇", "先秦"],
         desc="中国最早的诗歌总集，收西周至春秋诗歌三百零五篇。风、雅、颂三体，赋、比、兴三法，一句“关关雎鸠”开了三千年诗的门。"),
    dict(id="chuci", title="楚辞", author="屈原 等", cat="诗词", motif="orchid", seal="騷",
         c1="#4C3A63", c2="#241A33", tags=["屈原", "骚体", "香草美人"],
         desc="以屈原作品为主体的南方诗歌总集。句式参差、多用“兮”字，奇崛瑰丽，与《诗经》并称“风骚”。《离骚》《九歌》《天问》皆在其中。"),
    dict(id="tang300", title="唐诗三百首", author="蘅塘退士 编", cat="诗词", motif="moon", seal="唐",
         c1="#8C6438", c2="#4A3419", tags=["唐诗", "选本", "启蒙"],
         desc="清人蘅塘退士所编唐诗选本，收七十七家诗三百余首。五古七古、五律七律、绝句乐府兼备，是读唐诗最省力也最耐读的一本。"),
    dict(id="qianjia", title="千家诗", author="谢枋得 编", cat="诗词", motif="willow", seal="家",
         c1="#6E7C48", c2="#333B20", tags=["绝句", "律诗", "蒙学"],
         desc="旧时蒙学读诗的第一本。所选多五七言绝律，浅近上口，一册在手，四季晨昏皆有可诵之句。"),
    dict(id="shuimo", title="水墨唐诗", author="唐人 著", cat="诗词", motif="ink", seal="墨",
         c1="#2F4B6E", c2="#16263C", tags=["唐诗", "赏析", "意境"],
         desc="一百七十余首唐诗，每首附一段白话赏析。诗是水墨，赏析是题跋，读来如展一册旧画。"),
    dict(id="songci300", title="宋词三百首", author="朱祖谋 编", cat="诗词", motif="flower", seal="詞",
         c1="#7A4E5A", c2="#3A2028", tags=["宋词", "选本", "婉约"],
         desc="清人朱祖谋所编宋词选本，收两宋词人八十余家、词近三百阕。苏轼、辛弃疾、周邦彦、李清照皆在其中，一编在手，可见词体之盛。"),
    dict(id="huajianji", title="花间集", author="赵崇祚 编", cat="诗词", motif="petals", seal="花",
         c1="#8A4A5C", c2="#3E1E28", tags=["词总集", "温庭筠", "晚唐五代"],
         desc="后蜀赵崇祚所编，十卷五百首，是中国最早的文人词总集。温庭筠、韦庄为首，词风秾丽，如“镂玉雕琼，拟化工而迥巧”。"),
    dict(id="nantang", title="南唐二主词", author="李璟 / 李煜", cat="诗词", motif="candle", seal="煜",
         c1="#5C5470", c2="#2A2438", tags=["李煜", "李璟", "五代词"],
         desc="南唐中主李璟、后主李煜父子词合集。亡国之前的绮丽，亡国之后的沉痛——“问君能有几多愁，恰似一江春水向东流”。"),
    dict(id="nalan", title="纳兰词", author="纳兰性德", cat="诗词", motif="window", seal="納",
         c1="#4E5A68", c2="#232B33", tags=["纳兰性德", "清词", "饮水词"],
         desc="清初第一词人纳兰性德的词集。悼亡、边塞、友情，语极浅而情极深，“人生若只如初见”一句，三百年无人能出其右。"),
    dict(id="caocao", title="曹操集", author="曹操", cat="诗词", motif="sword", seal="曹",
         c1="#4A4E5A", c2="#20232B", tags=["曹操", "四言", "建安"],
         desc="曹操存诗二十余首，四言承《诗经》余绪，五言开建安风骨。“老骥伏枥，志在千里”，是英雄语，也是诗人语。"),
    dict(id="lunyu", title="论语", author="孔子弟子 辑", cat="典籍", motif="slips", seal="論",
         c1="#4A5F45", c2="#24301F", tags=["孔子", "四书", "语录"],
         desc="孔子与弟子的言行记录，二十篇。中国人做人的底子，多半在这本书里——“学而时习之”到“不知命，无以为君子”。"),
    dict(id="daxue", title="大学", author="曾子", cat="典籍", motif="gate", seal="學",
         c1="#8E5752", c2="#46292A", tags=["四书", "修身", "明德"],
         desc="四书之首。三纲领、八条目，从格物致知到治国平天下，一部最短却最系统的儒家纲领。"),
    dict(id="zhongyong", title="中庸", author="子思", cat="典籍", motif="taiji", seal="庸",
         c1="#6C5878", c2="#352A41", tags=["四书", "中和", "诚"],
         desc="四书之一。讲“不偏不倚、无过不及”的中道，以“诚”贯天人。读之如走一条极窄却极远的路。"),
    dict(id="mengzi", title="孟子", author="孟子 及其弟子", cat="典籍", motif="pine", seal="孟",
         c1="#3D4B45", c2="#1C2420", tags=["四书", "性善", "仁义"],
         desc="四书之一，十四篇。孟子见梁惠王，开口便是“王何必曰利”。性善、仁政、浩然之气，尽在这本书里。"),
    dict(id="daodejing", title="道德经", author="老子", cat="典籍", motif="water", seal="道",
         c1="#2C4150", c2="#131F27", tags=["老子", "道家", "五千言"],
         desc="五千言，八十一章。道可道，非常道。中国最薄的一本大书，读一遍有一遍的读法。"),
    dict(id="sanzi", title="三字经", author="王应麟", cat="蒙学", motif="seedling", seal="三",
         c1="#93773C", c2="#4A3A18", tags=["蒙学", "识字", "三字"],
         desc="三字一句，两句一韵。从“人之初”讲到朝代更迭，旧时孩童的第一本书。"),
    dict(id="qianzi", title="千字文", author="周兴嗣", cat="蒙学", motif="cosmos", seal="千",
         c1="#3E6472", c2="#1B3038", tags=["蒙学", "千字", "对仗"],
         desc="一千个不重复的字，四言协韵，写成一部小百科。据说周兴嗣一夜白头而成。"),
    dict(id="dizigui", title="弟子规", author="李毓秀", cat="蒙学", motif="court", seal="規",
         c1="#77583F", c2="#3A2A1D", tags=["蒙学", "行为", "孝弟"],
         desc="依《论语·学而》编成的行为守则，三字一句。讲的是最琐碎的日常：怎么应声、怎么走路、怎么待人。"),
    dict(id="baijiaxing", title="百家姓", author="佚名", cat="蒙学", motif="surname", seal="姓",
         c1="#8A4A44", c2="#43211F", tags=["蒙学", "姓氏", "四言"],
         desc="四言韵语串起的姓氏册。“赵钱孙李，周吴郑王”，八个字里藏着一部中国家族史。"),
    dict(id="shenglv", title="声律启蒙", author="车万育", cat="蒙学", motif="qin", seal="聲",
         c1="#56607A", c2="#282E40", tags=["蒙学", "对仗", "声韵"],
         desc="按韵分编的对子书。“云对雨，雪对风，晚照对晴空”，读起来像唱歌，是学格律最近的门。"),
    dict(id="zengguang", title="增广贤文", author="佚名", cat="蒙学", motif="stele", seal="賢",
         c1="#5C4E40", c2="#2C251D", tags=["蒙学", "格言", "世情"],
         desc="明清两代不断增补的民间格言集。“画虎画皮难画骨，知人知面不知心”，句句是世故，也句句是经验。"),
    dict(id="zhuzi", title="朱子家训", author="朱柏庐", cat="蒙学", motif="window", seal="訓",
         c1="#454E52", c2="#1F2528", tags=["家训", "治家", "勤俭"],
         desc="五百余字的治家格言。“黎明即起，洒扫庭除”，一粥一饭里讲的都是分寸。"),
    dict(id="youxueqionglin", title="幼学琼林", author="程登吉 编", cat="蒙学", motif="city", seal="瓊",
         c1="#7A6034", c2="#3A2C14", tags=["蒙学", "百科", "对偶"],
         desc="明代程登吉编，四卷三十三类。天文地舆、岁时朝廷、婚丧器物，全用对偶写成，是旧时孩童的一部古代常识百科。"),
    dict(id="youmengying", title="幽梦影", author="张潮", cat="文集", motif="shadow", seal="夢",
         c1="#6A4C5C", c2="#32212B", tags=["清言", "小品", "性灵"],
         desc="清人张潮的随笔小品，二百余则。写读书、写花月、写朋友，句短意长，后附时人评语，如围炉闲话。"),
    dict(id="guwen", title="古文观止", author="吴楚材 吴调侯 编", cat="文集", motif="peak", seal="觀",
         c1="#3E5C55", c2="#1B2E2B", tags=["散文", "选本", "先秦至明"],
         desc="清人所编古文选本，十二卷二百二十余篇。自《左传》至明代，读古文从这一部入手，路数最正。"),
]

# ---------- 各书 -> 章节 ----------
def ch(title, ps):
    ps = [p for p in ps if p]
    return {"title": title, "paras": ps} if ps else None

def build_shijing():
    d = cp("诗经/shijing.json")
    out = []
    for it in d:
        t = clean(it.get("title") or "")
        sec = clean(it.get("section") or "")
        chn = clean(it.get("chapter") or "")
        grp = chn + ("·" + sec if sec and sec != chn else "")
        label = t + (" · " + grp if grp else "")
        c = ch(label, paras(it.get("content")))
        if c:
            out.append(c)
    return out

def build_lunyu():
    d = cp("论语/lunyu.json")
    return [c for c in (ch(clean(x.get("chapter") or ""), paras(x.get("paragraphs"))) for x in d) if c]

def build_chuci():
    d = cp("楚辞/chuci.json")
    out = []
    for x in d:
        t = clean(x.get("title") or "")
        a = clean(x.get("author") or "")
        label = t + (" · " + a if a and a not in t else "")
        c = ch(label, paras(x.get("content")))
        if c:
            out.append(c)
    return out

def _nested_poems(d):
    """唐诗三百首 / 千家诗：{title, content:[{type, content:[{chapter,author,paragraphs}]}]}"""
    out = []
    for grp in d.get("content", []) or []:
        for po in grp.get("content", []) or []:
            t = clean(po.get("chapter") or "")
            a = clean(po.get("author") or "")
            label = t + (" · " + a if a else "")
            c = ch(label, paras(po.get("paragraphs")))
            if c:
                out.append(c)
    return out

def build_tang300():
    return _nested_poems(cp("蒙学/tangshisanbaishou.json"))

def build_qianjia():
    return _nested_poems(cp("蒙学/qianjiashi.json"))

def build_shuimo():
    d = cp("水墨唐诗/shuimotangshi.json")
    out = []
    for x in d:
        t = clean(x.get("title") or "")
        a = clean(x.get("author") or "")
        ps = paras(x.get("paragraphs"))
        pro = clean(x.get("prologue") or "")
        if pro:
            ps.append("【赏析】" + pro)
        c = ch(t + (" · " + a if a else ""), ps)
        if c:
            out.append(c)
    return out

def _plain(path, label="全文", merge=1):
    """单篇型：{paragraphs:[...]} / {content:[{chapter,paragraphs}]} / [{chapter,paragraphs}]"""
    d = cp(path)
    if isinstance(d, list) and d and isinstance(d[0], dict) and "chapter" in d[0]:
        out = []
        for x in d:
            c = ch(clean(x.get("chapter") or label), paras(x.get("paragraphs")))
            if c:
                out.append(c)
        if out:
            return out
    if isinstance(d, dict) and d.get("content") and isinstance(d["content"], list) and d["content"] and isinstance(d["content"][0], dict):
        out = []
        for x in d["content"]:
            c = ch(clean(x.get("chapter") or label), paras(x.get("paragraphs")))
            if c:
                out.append(c)
        if out:
            return out
    ps = paras(d.get("paragraphs") if isinstance(d, dict) else d)
    if merge > 1:
        merged, buf = [], []
        for p in ps:
            buf.append(p)
            if len(buf) >= merge:
                merged.append("".join(buf)); buf = []
        if buf:
            merged.append("".join(buf))
        ps = merged
    c = ch(label, ps)
    return [c] if c else []

def build_qianzi():
    """千字文：源数据是 4 字一条，两两并成“天地玄黄，宇宙洪荒。”"""
    d = cp("蒙学/qianziwen.json")
    units = paras(d.get("paragraphs"))
    ps = []
    for i in range(0, len(units), 2):
        pair = units[i:i + 2]
        ps.append("，".join(pair) + "。")
    c = ch("全文", ps)
    return [c] if c else []

def build_shenglv():
    d = cp("蒙学/shenglvqimeng.json")
    out = []
    for juan in d.get("content", []) or []:
        for x in juan.get("content", []) or []:
            c = ch(clean(x.get("chapter") or ""), paras(x.get("paragraphs")))
            if c:
                out.append(c)
    return out

def build_youmengying():
    d = cp("幽梦影/youmengying.json")
    out, per = [], 10
    for i in range(0, len(d), per):
        ps = []
        for x in d[i:i + per]:
            c = clean(x.get("content") or "")
            if not c:
                continue
            ps.append(c)
            for cm in (x.get("comment") or [])[:2]:
                cm = clean(cm)
                if cm:
                    ps.append("○ " + cm)
        c = ch("卷" + cn(i // per + 1) + " · 第" + cn(i + 1) + "则起", ps)
        if c:
            out.append(c)
    return out

def cn(n):
    dg = "零一二三四五六七八九"
    if n < 10:
        return dg[n]
    if n < 20:
        return "十" + (dg[n % 10] if n % 10 else "")
    if n < 100:
        return dg[n // 10] + "十" + (dg[n % 10] if n % 10 else "")
    h, rest = divmod(n, 100)
    s = dg[h] + "百"
    if rest == 0:
        return s
    if rest < 10:
        return s + "零" + dg[rest]
    return s + cn(rest)

def build_guwen():
    d = cp("蒙学/guwenguanzhi.json")
    out = []
    for juan in d.get("content", []) or []:
        for x in juan.get("content", []) or []:
            t = clean(x.get("chapter") or "")
            a = clean(x.get("author") or "")
            src = clean(x.get("source") or "")
            meta = " ".join([v for v in [a, src] if v])
            c = ch(t + (" · " + meta if meta else ""), paras(x.get("paragraphs")))
            if c:
                out.append(c)
    return out

def build_daodejing():
    """道德经：取已缓存的维基文库 王弼本 全文。
    该页正文与王弼注混排（注在〈〉内），此处只取经文，注文略去。"""
    fn = None
    for f in os.listdir(API_CACHE):
        if "E9_81_93_E5_BE_B7" in f:
            fn = os.path.join(API_CACHE, f); break
    if not fn:
        return []
    d = json.load(open(fn, encoding="utf-8"))
    html = (d.get("parse") or {}).get("text", {}).get("*", "")
    html = re.sub(r"<style.*?</style>|<script.*?</script>", "", html, flags=re.S)
    html = re.sub(r'<sup[^>]*class="[^"]*reference[^"]*".*?</sup>', "", html, flags=re.S)
    txt = re.sub(r"<[^>]+>", "\n", html)
    txt = re.sub(r"\[\d+\]", "", txt)
    txt = simp(txt)
    # 去掉编辑链接残留
    for junk in ("编辑", "姊妹计划", "数据项", "版本信息"):
        txt = txt.replace(junk, "")
    txt = txt.replace("\n[\n]\n", "\n")
    # 去掉王弼注（〈…〉）
    txt = re.sub(r"〈[^〈〉]*〉", "", txt)
    lines = [re.sub(r"[ \t\u3000]+", " ", l).strip() for l in txt.split("\n")]
    lines = [l for l in lines if l and l not in ("[", "]", ":", "，", "。")]
    mark = re.compile(r"^[一二三四五六七八九十百]+章$")
    chapters, cur, cur_title = [], [], None
    for l in lines:
        if mark.match(l):
            if cur_title and cur:
                chapters.append(ch("第" + cur_title, cur))
            cur_title, cur = l, []
        elif cur_title and len(l) > 3:
            cur.append(l)
    if cur_title and cur:
        chapters.append(ch("第" + cur_title, cur))
    return [c for c in chapters if c]

# ---------- 诗词别集 / 词总集（chinese-poetry 各家整理本） ----------
def _poem_label(x, use_rhythmic=False):
    t = clean(x.get("rhythmic") if use_rhythmic else (x.get("title") or x.get("rhythmic")))
    a = clean(x.get("author") or "")
    if not t:
        t = clean(x.get("rhythmic") or "")
    return t + (" · " + a if a and a not in t else "")

def _poem_ps(x):
    return paras(x.get("paragraphs") if x.get("paragraphs") is not None else x.get("para"))

def build_songci300():
    """宋词三百首：一首一章，题作「词牌 · 作者」"""
    out = []
    for x in cp("宋词/宋词三百首.json"):
        c = ch(_poem_label(x, use_rhythmic=True), _poem_ps(x))
        if c:
            out.append(c)
    return out

def build_huajianji():
    """花间集：十卷补遗一卷，一首一章，题前冠卷次"""
    out = []
    for i in list(range(1, 10)) + ["x"]:
        try:
            d = cp("五代诗词/huajianji/huajianji-%s-juan.json" % i)
        except Exception:
            continue
        vol = "卷" + (cn(int(i)) if i != "x" else "十·补遗")
        for x in d:
            c = ch(vol + " · " + _poem_label(x), _poem_ps(x))
            if c:
                out.append(c)
    return out

def build_nantang():
    """南唐二主词：李璟、李煜父子词，一首一章"""
    out = []
    for x in cp("五代诗词/nantang/poetrys.json"):
        c = ch(_poem_label(x), _poem_ps(x))
        if c:
            out.append(c)
    return out

def build_nalan():
    """纳兰词：词牌·首句为题，一首一章。
    源本的句子按断句分行、不含标点，展示时在句末补一个句号，免得读起来像残句。"""
    out = []
    for x in cp("纳兰性德/纳兰性德诗集.json"):
        ps = []
        for p in _poem_ps(x):
            p = p.rstrip()
            if p and p[-1] not in "。！？；：，、…":
                p += "。"
            ps.append(p)
        c = ch(clean(x.get("title") or ""), ps)
        if c:
            out.append(c)
    return out

def build_caocao():
    """曹操集：存诗二十余首，一首一章"""
    out = []
    for x in cp("曹操诗集/caocao.json"):
        c = ch(clean(x.get("title") or ""), _poem_ps(x))
        if c:
            out.append(c)
    return out

def build_youxueqionglin():
    """幼学琼林：四卷三十三类，每类一章，题作「卷一 · 天文」"""
    out = []
    for juan in cp("蒙学/youxueqionglin.json").get("content") or []:
        jt = clean(juan.get("title") or "")
        for x in juan.get("content") or []:
            t = clean(x.get("chapter") or x.get("title") or "")
            label = (jt + " · " + t) if jt and t else (t or jt)
            c = ch(label, paras(x.get("paragraphs")))
            if c:
                out.append(c)
    return out

BUILDERS = {
    "shijing": build_shijing, "lunyu": build_lunyu, "chuci": build_chuci,
    "tang300": build_tang300, "qianjia": build_qianjia, "shuimo": build_shuimo,
    "shenglv": build_shenglv, "youmengying": build_youmengying, "guwen": build_guwen,
    "songci300": build_songci300, "huajianji": build_huajianji, "nantang": build_nantang,
    "nalan": build_nalan, "caocao": build_caocao, "youxueqionglin": build_youxueqionglin,
    "mengzi": lambda: _plain("四书五经/mengzi.json", "全文"),
    "daodejing": build_daodejing,
}

def main():
    out = []
    for b in BOOKS:
        bid = b["id"]
        try:
            if bid in BUILDERS:
                chapters = BUILDERS[bid]()
            elif bid == "daxue":
                chapters = _plain("四书五经/daxue.json", "全文")
            elif bid == "zhongyong":
                chapters = _plain("四书五经/zhongyong.json", "全文")
            elif bid == "sanzi":
                chapters = _plain("蒙学/sanzijing-new.json", "全文")
            elif bid == "qianzi":
                chapters = build_qianzi()
            elif bid == "zhuzi":
                chapters = _plain("蒙学/zhuzijiaxun.json", "全文", merge=2)
            elif bid == "baijiaxing":
                chapters = _plain("蒙学/baijiaxing.json", "全文")
            elif bid == "zengguang":
                chapters = _plain("蒙学/zengguangxianwen.json", "全文")
            elif bid == "dizigui":
                chapters = _plain("蒙学/dizigui.json", "全文")
            else:
                chapters = []
        except Exception as e:
            print(f"  [FAIL] {b['title']}: {type(e).__name__}: {e}")
            continue
        if not chapters:
            print(f"  [EMPTY] {b['title']}")
            continue
        for i, c in enumerate(chapters):
            c["no"] = i + 1
        chars = sum(len(p) for c in chapters for p in c["paras"])
        print(f"  [OK] {b['title']}: {len(chapters)} 章 / {chars} 字")
        out.append({
            "id": bid, "title": b["title"], "author": b["author"], "category": b["cat"],
            "status": "完结", "desc": b["desc"], "tags": b["tags"],
            "cover": {"motif": b["motif"], "seal": b["seal"], "color": b["c1"], "color2": b["c2"]},
            "chapters": chapters,
        })

    payload = json.dumps(out, ensure_ascii=False, separators=(",", ":"))
    js = ("// 墨卷 · 内置公版书库（真实公有领域文本）\n"
          "// 来源：chinese-poetry/chinese-poetry、维基文库。由 tools/fetch_classics.py 生成，请勿手改。\n"
          "window.MJ_CLASSICS = " + payload + ";\n")
    dst = os.path.join(ROOT, "js", "classics-data.js")
    open(dst, "w", encoding="utf-8").write(js)
    print(f"\n写入 {dst}：{len(out)} 部书，{len(payload)} 字符")

if __name__ == "__main__":
    main()
