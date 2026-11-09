# -*- coding: utf-8 -*-
"""墨卷 · 在线书源（维基文库）书目表 + 可用性校验 + 生成 CATALOG 代码。

用法:
  python tools/ws_catalog.py verify     # 校验每本书能否取到目录/正文，结果写 tools/cache/ws-verify.json
  python tools/ws_catalog.py emit       # 把通过校验的书目写进 js/source-wikisource.js

每项字段: id, title, author, page(维基文库条目名), category, motif, seal, c1, c2, tags, desc
"""
import urllib.request, urllib.parse, ssl, json, re, os, sys, time
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "tools", "cache", "ws-verify.json")
TARGET = os.path.join(ROOT, "js", "source-wikisource.js")
CTX = ssl.create_default_context(); CTX.check_hostname = False; CTX.verify_mode = ssl.CERT_NONE
API = "https://zh.wikisource.org/w/api.php"
UA = "MojuanReader/1.0 (catalog builder)"

# (id, 标题, 作者, 维基页面, 分类, motif, 印章, 主色, 深色, tags, 简介)
CATALOG = [
    # ---------------- 明清长篇小说（原有，补上简介） ----------------
    ("ws:honglou", "红楼梦", "曹雪芹 / 高鹗", "紅樓夢", "小说", "petals", "紅", "#7A3B45", "#391A21",
     ["章回", "世情", "四大名著"],
     "一百二十回。大观园里一场繁盛，终究落得白茫茫大地。中国人的小说读到最后，多半还是要回到这一本。"),
    ("ws:sanguo", "三国演义", "罗贯中", "三國演義", "小说", "sword", "國", "#5A3A2C", "#28170F",
     ["章回", "历史演义", "四大名著"],
     "一百二十回，自桃园结义到三分归晋。诸葛亮、关云长、曹孟德，几个人物撑起了中国人对政治与忠义的全部想象。"),
    ("ws:shuihu", "水浒传", "施耐庵", "水滸傳 (100回本)", "小说", "wave", "滸", "#2C5550", "#142C2A",
     ["章回", "英雄", "四大名著"],
     "一百回，一百零八人逼上梁山。官逼民反四个字，写得最痛快也最悲凉的一本。"),
    ("ws:xiyou", "西游记", "吴承恩", "西遊記", "小说", "pagoda", "遊", "#8A5A2E", "#42290F",
     ["章回", "神魔", "四大名著"],
     "一百回，取经路上八十一难。看似神怪，写的却是人心降伏自己的过程。"),
    ("ws:liaozhai", "聊斋志异", "蒲松龄", "聊齋志異", "小说", "candle", "齋", "#3A4550", "#1A2128",
     ["笔记", "志怪", "文言"],
     "近五百篇文言短篇。狐狸鬼怪比人更讲情义，蒲松龄在灯下写它们，写的是自己一肚子的不平。"),
    # ---------------- 史部 ----------------
    ("ws:shiji", "史记", "司马迁", "史記", "史部", "brush", "史", "#6B4B34", "#33220F",
     ["纪传体", "通史", "西汉"],
     "一百三十篇，本纪、表、书、世家、列传。究天人之际，通古今之变，“史家之绝唱，无韵之离骚”。"),
    ("ws:shishuo", "世说新语", "刘义庆", "世說新語", "史部", "bamboo", "世", "#3F5E5A", "#1D2E2B",
     ["笔记", "魏晋", "人物"],
     "三十六门，一千余则。魏晋名士的言语与风度，全在这几行小字里：乘兴而行，兴尽而返，何必见戴。"),
    ("ws:tangshi", "全唐诗", "清·彭定求 等编", "全唐詩", "诗词", "star", "全", "#4A4A6E", "#22223A",
     ["唐诗", "总集", "清编"],
     "九百卷，收诗四万八千余首，作者两千余家。唐人一代的诗，尽收于此；不必读完，随手翻一页都是好的。"),
    # ---------------- 白话小说 ----------------
    ("ws:rulin", "儒林外史", "吴敬梓", "儒林外史", "小说", "gate", "儒", "#4A5C6E", "#202C38",
     ["科举", "讽刺", "士林"],
     "清代吴敬梓所著长篇讽刺小说，五十六回。范进中举、严监生临死伸指，都出自此书。写尽读书人的体面与狼狈，笑里带着凉意。"),
    ("ws:fengshen", "封神演义", "许仲琳", "封神演義", "小说", "cloud", "封", "#8A6A2E", "#422E10",
     ["神魔", "商周", "演义"],
     "明代神魔小说，一百回。武王伐纣为经，阐截二教斗法为纬。哪吒闹海、姜太公封神，民间神谱多半由此书定下。"),
    ("ws:lieguo", "东周列国志", "冯梦龙 / 蔡元放", "東周列國志", "小说", "mountain", "列", "#5A6250", "#282F22",
     ["春秋", "战国", "历史演义"],
     "演春秋战国五百余年事，一百零八回。五霸七雄、管仲商鞅、苏秦张仪，一部列国，半部中国人的权谋教科书。"),
    ("ws:jinghua", "镜花缘", "李汝珍", "鏡花緣", "小说", "wave", "鏡", "#2E5A6A", "#132C34",
     ["海外", "才学", "清小说"],
     "清代李汝珍所著，一百回。唐敖海外游历，君子国、女儿国、两面国，借奇邦异域写世情；后半写才女百人，是清人小说里最博学的一部。"),
    ("ws:laocan", "老残游记", "刘鹗", "老殘遊記", "小说", "pine", "殘", "#46564E", "#1F2823",
     ["晚清", "游记", "白话"],
     "晚清刘鹗所著，二十回。一个摇串铃的郎中走遍山东，大明湖听书、桃花山访贤。写景极工，鲁迅称其“叙景状物，时有可观”。"),
    ("ws:guanchang", "官场现形记", "李宝嘉", "官場現形記", "小说", "city", "官", "#6E5240", "#33241A",
     ["晚清", "谴责", "官场"],
     "晚清四大谴责小说之首，六十回。从州县到京官，一个个钻营、倾轧、糊弄的场面，拼成一部晚清官场浮世绘。"),
    ("ws:ernian", "二十年目睹之怪现状", "吴趼人", "二十年目睹之怪現狀", "小说", "pagoda", "怪", "#4E4A5E", "#232030",
     ["晚清", "谴责", "世情"],
     "吴趼人所著，一百零八回。以“九死一生”二十年所见，写官商士绅的种种怪状，蛇虫鼠蚁魑魅魍魉，一一现形。"),
    ("ws:niehai", "孽海花", "曾朴", "孽海花", "小说", "flower", "孽", "#7A4050", "#361B24",
     ["晚清", "谴责", "名士"],
     "曾朴所著，三十五回。以状元洪钧与名妓赛金花为线，串起同光以来的名士与国事。写士大夫的清谈与溃败，笔致最见风雅。"),
    ("ws:sanxia", "三侠五义", "石玉昆", "三俠五義", "小说", "sword", "俠", "#4A4A58", "#1F1F28",
     ["武侠", "公案", "清小说"],
     "清代石玉昆说书底本整理而成，一百二十回。包公断案、五鼠闹东京、展昭白玉堂，中国武侠小说的开山之作。"),
    ("ws:suitang", "隋唐演义", "褚人获", "隋唐演義", "小说", "star", "隋", "#5A4A6E", "#282038",
     ["隋唐", "英雄", "演义"],
     "清人褚人获所著，一百回。隋末群雄并起，秦琼卖马、程咬金三板斧、瓦岗寨聚义，英雄气与儿女情交织。"),
    ("ws:shuoyue", "说岳全传", "钱彩", "說岳全傳", "小说", "pine", "岳", "#4E5A46", "#232A1F",
     ["岳飞", "忠义", "演义"],
     "清人钱彩所著，八十回。岳鹏举枪挑小梁王，十二道金牌召还，风波亭上一阕《满江红》。民间说岳，尽在此书。"),
    ("ws:ernv", "儿女英雄传", "文康", "兒女英雄傳", "小说", "willow", "俠", "#5C6B48", "#2A3220",
     ["侠义", "言情", "清小说"],
     "清人文康所著，四十一回。十三妹能文能武，安公子迂而不失其厚。写侠气也写家常，是清代小说里少见的温厚笔调。"),
    ("ws:xingshi", "醒世恒言", "冯梦龙 编", "醒世恆言", "小说", "candle", "醒", "#6E5A3E", "#33291A",
     ["三言", "话本", "世情"],
     "冯梦龙“三言”之三，四十卷。卖油郎独占花魁、十五贯戏言成巧祸，宋元明话本的精华尽在其中。"),
    ("ws:yushi", "喻世明言", "冯梦龙 编", "喻世明言", "小说", "window", "喻", "#545E6E", "#252C36",
     ["三言", "话本", "世情"],
     "冯梦龙“三言”之一，四十卷。蒋兴哥重会珍珠衫、金玉奴棒打薄情郎，写市井人情，句句是白话，字字是老练。"),
    ("ws:jingshi", "警世通言", "冯梦龙 编", "警世通言", "小说", "ink", "警", "#3E4A54", "#1B2228",
     ["三言", "话本", "世情"],
     "冯梦龙“三言”之二，四十卷。俞伯牙摔琴谢知音、白娘子永镇雷峰塔，中国最有名的几段故事都在这本里。"),
    ("ws:paian", "初刻拍案惊奇", "凌濛初", "初刻拍案驚奇", "小说", "stele", "奇", "#5E4A44", "#2B211E",
     ["二拍", "话本", "世情"],
     "凌濛初“二拍”之一，四十卷。转运汉遇巧洞庭红、宣徽院仕女秋千会，题材更近市井，笔比“三言”更放。" ),
    # ---------------- 史部 ----------------
    ("ws:zhanguo", "战国策", "刘向 编", "戰國策", "史部", "brush", "策", "#5E5240", "#2B251A",
     ["纵横", "策士", "先秦"],
     "西汉刘向编订，三十三卷。策士们游说诸侯的言辞，纵横捭阖，气势逼人。“邹忌修八尺有余”“唐雎不辱使命”皆出于此。"),
    ("ws:zuozhuan", "左传", "左丘明", "春秋左氏傳", "史部", "slips", "傳", "#4A5A4E", "#202A22",
     ["春秋", "编年", "先秦"],
     "《春秋》三传之一，记鲁隐公至哀公二百余年事。战争、盟会、辞令、预言，中国叙事散文的老祖宗。"),
    ("ws:guoyu", "国语", "左丘明", "國語", "史部", "slips", "語", "#525A48", "#242920",
     ["国别史", "先秦", "记言"],
     "中国最早的国别史，二十一卷。分记周、鲁、齐、晋、郑、楚、吴、越八国之事，重记言而略记事，与《左传》互为表里。"),
    ("ws:shanhaijing", "山海经", "佚名", "山海經", "史部", "mountain", "海", "#3E5A5E", "#1B292C",
     ["神话", "地理", "上古"],
     "十八卷，山经五、海经十三。精卫填海、夸父逐日、刑天舞干戚，中国神话的老家；也是上古山川物产的一部奇书。"),
    ("ws:shuijingzhu", "水经注", "郦道元", "水經注", "史部", "water", "水", "#2E4E5E", "#13262E",
     ["地理", "山水", "北魏"],
     "北魏郦道元为《水经》作注，四十卷。一千余条河流，沿途山川、城邑、碑刻、传说一一写来，是地理书，也是山水散文的巅峰。"),
    ("ws:xuxiake", "徐霞客游记", "徐弘祖", "徐霞客遊記", "史部", "peak", "霞", "#4A5E5A", "#1F2A27",
     ["游记", "地理", "明"],
     "明末徐弘祖三十余年行旅所记。黄山、雁荡、滇黔溶洞，皆以双脚丈量、以实见校正旧说。“五岳归来不看山”的底气在此。"),
    # ---------------- 诸子典籍 ----------------
    ("ws:zhuangzi", "庄子", "庄周", "莊子", "典籍", "cloud", "莊", "#3A5560", "#18262C",
     ["道家", "逍遥", "先秦"],
     "三十三篇，内篇七、外篇十五、杂篇十一。逍遥游、齐物论、秋水，汪洋恣肆，中国散文与哲学的最高处之一。"),
    ("ws:xunzi", "荀子", "荀况", "荀子", "典籍", "pine", "荀", "#45564A", "#1E2620",
     ["儒家", "性恶", "先秦"],
     "三十二篇。主张性恶、重礼法，《劝学》开篇“学不可以已”，两千年来蒙童第一课。李斯、韩非皆出其门。"),
    ("ws:hanfeizi", "韩非子", "韩非", "韓非子", "典籍", "stele", "韓", "#4E4640", "#221F1B",
     ["法家", "术势", "先秦"],
     "五十五篇，法家集大成之作。守株待兔、自相矛盾、滥竽充数，寓言多出于此；说难、孤愤，写尽人主与臣下的心思。"),
    ("ws:mozi", "墨子", "墨翟", "墨子", "典籍", "gate", "墨", "#4A4E44", "#21241D",
     ["墨家", "兼爱", "先秦"],
     "五十三篇。兼爱、非攻、尚贤、节用，先秦最像“工程师”的一派：守城器械、光学几何、逻辑辩论，都在这本书里。"),
    ("ws:sunzi", "孙子兵法", "孙武", "孫子兵法", "典籍", "sword", "孫", "#5A4038", "#281C18",
     ["兵家", "谋略", "先秦"],
     "十三篇，六千言。“兵者，诡道也”“不战而屈人之兵”，世界最古老的兵书，也是被译得最多的一本中文书。"),
    ("ws:guanzi", "管子", "管仲", "管子", "典籍", "water", "管", "#3E5258", "#1B2427",
     ["法家", "经济", "先秦"],
     "七十六篇，托名管仲。讲治国也讲经济：轻重、盐铁、四民分业。中国最早系统谈财政与市场的一部书。"),
    ("ws:liezi", "列子", "列御寇", "列子", "典籍", "cloud", "列", "#485A62", "#1F282C",
     ["道家", "寓言", "先秦"],
     "八篇。愚公移山、杞人忧天、两小儿辩日，皆出此书。文气不如《庄子》汪洋，却更清简，多寓言而少玄谈。"),
    ("ws:huainanzi", "淮南子", "刘安", "淮南子", "典籍", "cosmos", "淮", "#4A4A60", "#20202A",
     ["道家", "杂家", "西汉"],
     "西汉淮南王刘安集门客所著，二十一篇。以道为宗，兼采百家，上谈天文下论兵略，是汉初思想的总结。"),
    ("ws:yanshi", "颜氏家训", "颜之推", "顏氏家訓", "典籍", "court", "顏", "#5A5448", "#28241D",
     ["家训", "南北朝", "处世"],
     "北齐颜之推所著，七卷二十篇。“积财千万，不如薄伎在身”，中国第一部系统的家训，讲教子、治家、读书、处世。"),
    # ---------------- 诗词文 ----------------
    ("ws:yuefu", "乐府诗集", "郭茂倩 编", "樂府詩集", "诗词", "qin", "樂", "#5A4E6E", "#282238",
     ["乐府", "民歌", "总集"],
     "宋人郭茂倩编，一百卷。从汉魏到五代，郊庙、燕射、鼓吹、相和、清商、杂曲，一部中国古代歌词的总账。"),
    ("ws:taoyuanming", "陶渊明集", "陶渊明", "陶淵明集", "诗词", "willow", "陶", "#5E6E48", "#2A3220",
     ["田园", "归隐", "东晋"],
     "东晋陶潜诗文全集。归去来兮、桃花源记、饮酒二十首。中国田园诗的源头，也是后世文人退路的样子。"),
    ("ws:libai", "李太白全集", "李白", "李太白全集", "诗词", "moon", "白", "#6A5A3E", "#302718",
     ["唐诗", "浪漫", "盛唐"],
     "李白诗文全集，三十卷。蜀道难、将进酒、梦游天姥，笔下有酒有月有剑，盛唐的气象都在这里。"),
    ("ws:shuyu", "漱玉词", "李清照", "漱玉詞 (四庫全書本)", "诗词", "orchid", "李", "#6E4A5E", "#30202A",
     ["宋词", "婉约", "易安"],
     "李清照词集。前半生“争渡，争渡，惊起一滩鸥鹭”，后半生“寻寻觅觅，冷冷清清”，一册词里有一整个北宋到南宋。"),
    ("ws:caigentan", "菜根谭", "洪应明", "菜根譚", "文集", "seedling", "根", "#4E5E42", "#222A1C",
     ["清言", "处世", "明"],
     "明人洪应明的语录体小品，三百余则。“宠辱不惊，看庭前花开花落”，说修养，也说世故，嚼得菜根，百事可做。"),
    ("ws:xiaochuang", "小窗幽记", "陈继儒", "小窗幽記", "文集", "window", "窗", "#46525A", "#1E252A",
     ["清言", "小品", "明"],
     "明人陈继儒辑，十二卷。醒、情、峭、灵、素、景、韵、奇、绮、豪、法、倩，一卷一境，是晚明文人最会过日子的证据。"),
    ("ws:weilu", "围炉夜话", "王永彬", "圍爐夜話", "文集", "candle", "爐", "#5A4A42", "#281F1B",
     ["清言", "处世", "清"],
     "清人王永彬所著，二百二十一则。冬夜围炉，与家人说些安身立命的话。与《菜根谭》《小窗幽记》并称处世三大奇书。"),
]


_LOCK = __import__("threading").Lock()
_last = [0.0]
MIN_GAP = 1.2          # 维基对匿名请求有限速，请求之间至少隔这么久


def _throttle():
    with _LOCK:
        wait = MIN_GAP - (time.time() - _last[0])
        if wait > 0:
            time.sleep(wait)
        _last[0] = time.time()


def api(params, tries=4, timeout=20):
    p = dict(params); p.setdefault("format", "json"); p["origin"] = "*"
    url = API + "?" + urllib.parse.urlencode(p)
    last = None
    for i in range(tries):
        _throttle()
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            return json.load(urllib.request.urlopen(req, timeout=timeout, context=CTX))
        except urllib.error.HTTPError as e:
            last = e
            # 429 = 被限流，退让久一点，别把重试也搭进去
            time.sleep((8 if e.code == 429 else 2) * (i + 1))
        except Exception as e:
            last = e; time.sleep(2 * (i + 1))
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


def check(item):
    _, title, _a, page, *_ = item
    r = {"id": item[0], "page": page, "title": title}
    try:
        txt = page_text(page)
    except Exception as e:
        r["err"] = type(e).__name__; r["retry"] = True; return r
    if txt is None:
        r["err"] = "not-found"; return r
    subs = subpages(page)
    mk = re.findall(r"第[一二三四五六七八九十百千0-9]+[章回卷篇]", txt)
    avg = 0
    if mk:
        segs = [s.strip() for s in re.split(r"第[一二三四五六七八九十百千0-9]+[章回卷篇]", txt)[1:] if s.strip()]
        avg = (sum(len(s) for s in segs) // len(segs)) if segs else 0
    r.update({"chars": len(txt), "markers": len(mk), "avg": avg, "subs": len(subs)})
    if len(subs) >= 3:
        r["verdict"] = "subpages"
    elif txt and (not mk or avg >= 200) and len(txt) > 800:
        r["verdict"] = "single"
    elif not txt or (len(subs) <= 1 and len(txt) < 800):
        # 页面空白、子页只列出一条，多半是网络中途断了，别把它当成结论
        r["verdict"] = "inconclusive"
        r["retry"] = True
    else:
        r["verdict"] = "toc-only"
    return r


def usable(rec):
    if not rec:
        return False
    if rec.get("verdict") == "subpages" and (rec.get("subs") or 0) >= 3:
        return True
    if rec.get("verdict") == "single" and (rec.get("chars") or 0) > 800:
        return True
    return False


def verify():
    old = {}
    if os.path.exists(CACHE):
        try:
            old = {x["id"]: x for x in json.load(open(CACHE, encoding="utf-8"))}
        except Exception:
            old = {}
    todo = [c for c in CATALOG if not usable(old.get(c[0]))]
    print("校验 %d 本（已有可用 %d）" % (len(todo), len(CATALOG) - len(todo)))
    if todo:
        from concurrent.futures import as_completed
        with ThreadPoolExecutor(max_workers=2) as ex:
            futs = {ex.submit(check, c): c for c in todo}
            # 谁先回来先记谁：map 会按提交顺序卡住，网络一慢就整批看不到进展
            for f in as_completed(futs):
                r = f.result()
                old[r["id"]] = r
                json.dump(list(old.values()), open(CACHE, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
                print("  %-14s %-12s subs=%-4s mk=%-4s avg=%-4s %s" % (
                    r["title"], r.get("verdict") or r.get("err"), r.get("subs"), r.get("markers"), r.get("avg"), r.get("page")))
                sys.stdout.flush()
    ok = [c for c in CATALOG if usable(old.get(c[0]))]
    bad = [c for c in CATALOG if c not in ok]
    print("\n可用 %d / %d" % (len(ok), len(CATALOG)))
    for c in bad:
        print("  [不可用] %s (%s) -> %s" % (c[1], c[3], old.get(c[0], {}).get("verdict") or old.get(c[0], {}).get("err")))
    return ok


def js_str(s):
    return json.dumps(s, ensure_ascii=False)


def emit(ok):
    lines = []
    for (bid, title, author, page, cat, motif, seal, c1, c2, tags, desc) in ok:
        lines.append(
            "    { id: %s, title: %s, author: %s, category: %s, page: %s,\n"
            "      cover: { motif: %s, seal: %s, color: %s, color2: %s },\n"
            "      tags: %s,\n"
            "      desc: %s }" % (
                js_str(bid), js_str(title), js_str(author), js_str(cat), js_str(page),
                js_str(motif), js_str(seal), js_str(c1), js_str(c2),
                "[" + ", ".join(js_str(t) for t in tags) + "]", js_str(desc)))
    block = ("  /* CATALOG:BEGIN —— 由 tools/ws_catalog.py 生成，勿手改 */\n"
             "  const CATALOG = [\n" + ",\n".join(lines) + "\n  ];\n"
             "  /* CATALOG:END */\n")
    src = open(TARGET, encoding="utf-8").read()
    a = src.index("  /* CATALOG:BEGIN")
    b = src.index("  /* CATALOG:END */") + len("  /* CATALOG:END */\n")
    open(TARGET, "w", encoding="utf-8").write(src[:a] + block + src[b:])
    print("已写入 %s：%d 部" % (TARGET, len(ok)))


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "verify"
    if cmd == "verify":
        verify()
    elif cmd == "emit":
        ok = verify()
        emit(ok)
