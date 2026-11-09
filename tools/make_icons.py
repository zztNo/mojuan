# 墨卷 · 应用图标生成（宣纸底 / 展开卷轴 / 行楷墨字 / 朱砂方印）
# 运行: python tools/make_icons.py
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import random, os

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'icons')
os.makedirs(OUT, exist_ok=True)
S = 2                      # 超采样倍数
B = 1024                   # 设计基准边长
W = B * S
PAPER = (243, 238, 226)
INK = (38, 46, 41)
CINNABAR = (170, 59, 48)
FONT_XK = 'C:/Windows/Fonts/STXINGKA.TTF'
FONT_ZS = 'C:/Windows/Fonts/STZHONGS.TTF'


def u(v):
    return int(round(v * S))


def font(path, size):
    try:
        return ImageFont.truetype(path, u(size))
    except OSError:
        return ImageFont.truetype('C:/Windows/Fonts/simsun.ttc', u(size))


def draw_icon(maskable=False):
    img = Image.new('RGB', (W, W), PAPER)
    px = img.load()

    # 宣纸上的淡墨晕
    for cx, cy, r, a in [(170, 180, 430, 0.055), (880, 880, 470, 0.045), (820, 150, 260, 0.03)]:
        for y in range(max(0, u(cy - r)), min(W, u(cy + r)), 3):
            for x in range(max(0, u(cx - r)), min(W, u(cx + r)), 3):
                d = ((x / S - cx) ** 2 + (y / S - cy) ** 2) ** 0.5
                if d < r:
                    k = (1 - d / r) ** 2 * a
                    old = px[x, y]
                    px[x, y] = (int(old[0] * (1 - k) + 60 * k),
                                int(old[1] * (1 - k) + 68 * k),
                                int(old[2] * (1 - k) + 60 * k))
    # 纸纤维颗粒
    random.seed(7)
    grain = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    gd = ImageDraw.Draw(grain)
    for _ in range(2600):
        x, y = random.randrange(W), random.randrange(W)
        gd.point((x, y), fill=(90, 82, 66, random.randrange(4, 12)))
    img = Image.alpha_composite(img.convert('RGBA'), grain)
    d = ImageDraw.Draw(img)

    # maskable: 把主体收进中心安全圆
    if maskable:
        layer = Image.new('RGBA', (W, W), (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        base = layer
    else:
        base = img

    # 投影
    shadow = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        [u(196), u(310), u(828), u(742)], radius=u(34), fill=(40, 38, 30, 92))
    shadow = shadow.filter(ImageFilter.GaussianBlur(u(16)))
    base.alpha_composite(shadow)

    # 卷轴纸面
    d.rounded_rectangle([u(248), u(320), u(776), u(704)], radius=u(12),
                        fill=(252, 248, 235, 255), outline=INK + (255,), width=u(7))
    d.rounded_rectangle([u(270), u(342), u(754), u(682)], radius=u(4),
                        outline=(120, 116, 100, 90), width=u(2))

    # 墨字（华文行楷）
    f_big = font(FONT_XK, 330)
    d.text((u(500), u(500)), '墨', font=f_big, fill=INK + (255,), anchor='mm')

    # 纸面上的两道墨痕，像未干的笔意
    d.line([u(310), u(392), u(430), u(392)], fill=(70, 78, 70, 70), width=u(4))
    d.line([u(310), u(408), u(390), u(408)], fill=(70, 78, 70, 50), width=u(4))
    d.line([u(594), u(610), u(714), u(610)], fill=(70, 78, 70, 50), width=u(4))

    # 左右卷轴杆
    for x0 in (196, 756):
        d.rounded_rectangle([u(x0), u(292), u(x0 + 72), u(732)], radius=u(30), fill=INK + (255,))
        d.rounded_rectangle([u(x0 + 12), u(306), u(x0 + 24), u(718)], radius=u(6),
                            fill=(255, 255, 255, 34))
        d.ellipse([u(x0 + 8), u(300), u(x0 + 64), u(356)], outline=(255, 250, 235, 70), width=u(3))
        d.ellipse([u(x0 + 8), u(668), u(x0 + 64), u(724)], outline=(255, 250, 235, 70), width=u(3))

    # 朱砂方印：单独图层，略作旋转
    seal = Image.new('RGBA', (u(150), u(150)), (0, 0, 0, 0))
    sd = ImageDraw.Draw(seal)
    sd.rounded_rectangle([u(4), u(4), u(146), u(146)], radius=u(8), fill=CINNABAR + (255,))
    sd.rounded_rectangle([u(14), u(14), u(136), u(136)], radius=u(4),
                         outline=(255, 244, 228, 210), width=u(4))
    f_seal = font(FONT_XK, 92)
    sd.text((u(75), u(76)), '卷', font=f_seal, fill=(255, 246, 230, 255), anchor='mm')
    seal = seal.rotate(5, resample=Image.BICUBIC, expand=False)
    base.alpha_composite(seal, (u(690), u(606)))

    if maskable:
        k = 0.80
        small = layer.resize((int(W * k), int(W * k)), Image.LANCZOS)
        canvas = Image.new('RGBA', (W, W), PAPER + (255,))
        # maskable 底也带一点淡墨晕
        dd = ImageDraw.Draw(canvas)
        dd.ellipse([u(60), u(60), u(964), u(964)], fill=(238, 232, 216, 255))
        canvas.alpha_composite(small, ((W - small.width) // 2, (W - small.height) // 2))
        img = canvas
    return img.convert('RGB')


def main():
    normal = draw_icon(False)
    mask = draw_icon(True)
    for size in (192, 512):
        normal.resize((size, size), Image.LANCZOS).save(
            os.path.join(OUT, 'icon-%d.png' % size), optimize=True)
    mask.resize((512, 512), Image.LANCZOS).save(
        os.path.join(OUT, 'icon-maskable-512.png'), optimize=True)
    print('icons written to', OUT)


if __name__ == '__main__':
    main()
