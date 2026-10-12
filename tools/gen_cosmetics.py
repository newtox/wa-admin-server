# Draws the unlockable cosmetics: themed clothes, hats, accessories, sunglasses and companions.
#
#   python3 tools/gen_cosmetics.py <WorkAdventure>/play/public/resources/customisation data/cosmetics
#
# Clothes are recoloured from WorkAdventure's own shirt/hoodie sprites (so they fit every body and walk frame)
# and get patterns, capes and prints on top. Hats, accessories and companions are drawn pixel by pixel.
# Every sheet is 96x128: 3 walk frames x 4 directions (down, left, right, up), 32x32 each.
import os
import sys
from PIL import Image

sys.path.insert(0, os.path.dirname(__file__))
from gen_accessories import blit, handheld, sheet, size  # noqa: E402

DIRS = ["down", "left", "right", "up"]
K = (26, 24, 30)


def rgb(h):
    return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))


def ramp(stops, t):
    t = max(0.0, min(1.0, t))
    n = len(stops) - 1
    i = min(int(t * n), n - 1)
    f = t * n - i
    a, b = stops[i], stops[i + 1]
    return tuple(round(a[k] + (b[k] - a[k]) * f) for k in range(3))


def lum(p):
    return (0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]) / 255


# ======================= clothes =======================
def frames(im):
    for r in range(4):
        for c in range(3):
            yield r, c, im.crop((c * 32, r * 32, c * 32 + 32, r * 32 + 32))


def assemble(parts):
    out = Image.new("RGBA", (96, 128), (0, 0, 0, 0))
    for (r, c), f in parts.items():
        out.alpha_composite(f, (c * 32, r * 32))
    return out


def waist_line(frame, split=0.47):
    """First row below the chest where the trousers (mostly dark pixels) start."""
    for y in range(20, 32):
        row = [frame.getpixel((x, y)) for x in range(32)]
        row = [p for p in row if p[3]]
        if len(row) >= 4 and sum(1 for p in row if lum(p) < split) * 2 > len(row):
            return y
    return 32


def garment(template, top, bottom, pattern=None, split=0.47, extra=None):
    """Recolours a WorkAdventure clothes sprite.

    template: RGBA sheet. Light pixels above the waist (the shirt) get the `top` colour ramp, everything below the
    waist (trousers, including the template's lighter belt and pocket lines) the `bottom` ramp.
    pattern(x, y, dir, frame) -> colour or None, applied to shirt pixels. extra(frame_img, dir, col, bob) draws on top.
    """
    parts = {}
    for r, c, f in frames(template):
        d = DIRS[r]
        g = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
        waist = waist_line(f, split)
        for y in range(32):
            for x in range(32):
                p = f.getpixel((x, y))
                if p[3] == 0:
                    continue
                L = lum(p)
                if L < 0.2:
                    col = K
                elif y >= waist:
                    col = ramp(bottom, min(1.0, (L - 0.2) / 0.6))
                elif L >= split:
                    col = ramp(top, (L - split) / (1 - split))
                    if pattern:
                        pc = pattern(x, y, d, c)
                        if pc:
                            col = pc
                else:
                    col = ramp(bottom, (L - 0.2) / (split - 0.2))
                g.putpixel((x, y), col + (255,))
        if extra:
            extra(g, d, c, 0 if c == 1 else 1)
        parts[(r, c)] = g
    return assemble(parts)


def put(img, x, y, col):
    if 0 <= x < 32 and 0 <= y < 32:
        img.putpixel((x, y), col + (255,))


BODY = None   # WorkAdventure body sheet, set by build_clothes(): from the front the cape hangs behind the arms


def cape(main, lining, collar=None, fur=False):
    """Cape over the shoulders: from the front only the edges show beside and behind the arms, the full cape from
    behind."""
    dark = tuple(max(0, v - 30) for v in main)

    def behind(g, c, x, y, col):
        """Draws only where neither the garment nor the body (arms) is, so the cape stays behind them."""
        if not (0 <= x < 32 and 0 <= y < 32) or g.getpixel((x, y))[3]:
            return
        if BODY is not None and BODY.getpixel((c * 32 + x, y))[3]:
            return
        put(g, x, y, col)

    def draw(g, d, c, bob):
        top = 18 + bob - 1
        bottom = 29 + bob
        if d == "down":
            for y in range(top + 1, bottom):
                spread = (y - top) // 4
                for x in range(6 - spread, 11):
                    behind(g, c, x, y, K if x == 6 - spread or y == bottom - 1 else lining)
                for x in range(22, 27 + spread):
                    behind(g, c, x, y, K if x == 26 + spread or y == bottom - 1 else lining)
            if fur:
                for x in range(9, 24):
                    put(g, x, top + 1, (244, 242, 236))
                for x in (10, 14, 18, 22):
                    put(g, x, top + 1, (20, 20, 22))
        elif d == "up":
            for y in range(top, bottom + 1):
                spread = (y - top) // 4
                for x in range(9 - spread, 24 + spread):
                    edge = x in (9 - spread, 23 + spread) or y == bottom
                    fold = (x - 9) % 5 == 0
                    put(g, x, y, K if edge else (dark if fold else main))
            if fur:
                for x in range(10, 23):
                    put(g, x, top, (244, 242, 236))
                for x in (11, 15, 19):
                    put(g, x, top, (20, 20, 22))
        else:
            # the back is on the right when facing left, on the left when facing right
            back = 19 if d == "left" else 12
            step = 1 if d == "left" else -1
            for y in range(top, bottom):
                spread = (y - top) // 4
                for i in range(0, 2 + spread):
                    x = back + step * (i + 1)
                    put(g, x, y, K if i == 1 + spread else main)
            if fur:
                for i in range(-1, 3):                 # fur collar at the back of the neck only
                    put(g, back + step * i, top, (20, 20, 22) if i == 1 else (244, 242, 236))
    return draw


def chest_print(art_down, pal, y=20):
    """A small print on the chest, only visible from the front."""
    def draw(g, d, c, bob):
        if d != "down":
            return
        w, h = size(art_down)
        for j, row in enumerate(art_down):
            for i, ch in enumerate(row):
                if ch != ".":
                    put(g, 16 - w // 2 + i, y + bob + j, pal[ch])
    return draw


def build_clothes(src):
    global BODY
    BODY = Image.open(os.path.join(src, "character_color", "character_color3.png")).convert("RGBA")
    shirt = Image.open(os.path.join(src, "character_clothes", "character_clothes17.png")).convert("RGBA")
    hoodie = Image.open(os.path.join(src, "character_clothes", "white_hoodie.png")).convert("RGBA")
    jeans = [rgb("#1c2a48"), rgb("#2c4272"), rgb("#4a66a0")]
    black = [rgb("#141418"), rgb("#2a2a32"), rgb("#44444e")]
    out = {}

    # Halloween
    out["vampire-cape"] = garment(shirt, [rgb("#3a0a14"), rgb("#7a1426"), rgb("#b02238")], black,
                                  extra=cape(rgb("#18161c"), rgb("#b01e34")))

    def ribs(x, y, d, c):
        if d == "down" and y in (19, 21) and 12 <= x <= 20 and x != 16:
            return (236, 232, 220)
        if d in ("down", "up") and x == 16 and 18 <= y <= 23:
            return (236, 232, 220)
        if d in ("left", "right") and y in (19, 21):
            return (236, 232, 220)
        return None
    out["skeleton-shirt"] = garment(shirt, [rgb("#101014"), rgb("#1e1e26"), rgb("#2e2e38")], black, pattern=ribs)

    # Winter
    def knit(x, y, d, c):
        if y == 20:
            return (250, 250, 250) if (x + y) % 2 else (40, 150, 70)
        if y == 22 and x % 3 == 0:
            return (250, 250, 250)
        return None
    out["xmas-sweater"] = garment(shirt, [rgb("#7c0f18"), rgb("#c0202c"), rgb("#e8404a")], jeans, pattern=knit)

    # Summer
    def flowers(x, y, d, c):
        k = (x * 3 + y * 5) % 11
        if k == 0:
            return (255, 255, 255)
        if k == 5:
            return (255, 226, 70)
        return None
    out["hawaii-shirt"] = garment(shirt, [rgb("#b23c10"), rgb("#ec6a1c"), rgb("#ffa040")],
                                  [rgb("#8a7048"), rgb("#bfa070"), rgb("#e0c898")], pattern=flowers)

    # Gamer
    pad = {"k": (20, 18, 26), "w": (240, 240, 250), "r": (255, 70, 110), "c": (90, 220, 250)}
    out["gamer-hoodie"] = garment(hoodie, [rgb("#3a1a6a"), rgb("#6a34b4"), rgb("#9a6ae6")], black,
                                  extra=chest_print(["kkkkk", "kwkck", "kkkkk"], pad, y=21))

    def neon(x, y, d, c):
        if y == 20:
            return (255, 60, 170)
        if y == 22:
            return (60, 230, 250)
        return None
    out["arcade-shirt"] = garment(shirt, [rgb("#121218"), rgb("#1e1e28"), rgb("#2c2c3a")], jeans, pattern=neon)

    # Roles
    def royal(x, y, d, c):
        bob = 0 if c == 1 else 1
        if d == "down" and x in (16, 17) and y >= 19 + bob:  # gold trim down the front, with buttons
            return (255, 236, 140) if y % 2 else (226, 176, 48)
        return None
    # red velvet coat, gold trim, ermine collar (white fur, black tips) and a long red cape
    out["royal-robe"] = garment(shirt, [rgb("#5a0814"), rgb("#9a1428"), rgb("#c8283c")], black, pattern=royal,
                                extra=cape(rgb("#8a1024"), rgb("#6a0a1c"), fur=True))
    return out


# ======================= hats =======================
# Sized like WorkAdventure's own hats: about 22-28 px wide, sitting on the hair (which spans x 5..27, top y 2..3)
# so that the hair underneath is covered. Drawn from shapes, then outlined, then details on top.
from PIL import ImageDraw  # noqa: E402

HAT_PAL = {
    "o": rgb("#ee7a18"), "O": rgb("#b04e0a"), "q": rgb("#ffb050"), "y": rgb("#ffe060"), "Y": rgb("#ffb000"),
    "g": rgb("#3a8a2a"), "G": rgb("#24601a"), "m": rgb("#3c2a5a"), "M": rgb("#24183a"), "v": rgb("#8a4ac8"),
    "r": rgb("#d02030"), "R": rgb("#8a1018"), "w": rgb("#f6f6f6"), "W": rgb("#c8c8d0"), "n": rgb("#8a5a2c"),
    "N": rgb("#5a3818"), "s": rgb("#e8c878"), "S": rgb("#b89848"), "b": rgb("#2a5ad0"), "B": rgb("#183a90"),
    "u": rgb("#60c8ff"), "p": rgb("#ff60b0"), "c": rgb("#40e0d0"), "k": K, "x": rgb("#ffd84a"),
}
P = HAT_PAL


def outline(img, col=K):
    """1 px dark outline around everything drawn so far (like WorkAdventure's sprites)."""
    src = img.copy()
    for y in range(32):
        for x in range(32):
            if src.getpixel((x, y))[3]:
                continue
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx, ny = x + dx, y + dy
                if 0 <= nx < 32 and 0 <= ny < 32 and src.getpixel((nx, ny))[3] and src.getpixel((nx, ny))[:3] != col:
                    img.putpixel((x, y), col + (255,))
                    break


def shaded_ellipse(d, cx, cy, rx, ry, base, dark, light=None, clip=None):
    for y in range(int(cy - ry) - 1, int(cy + ry) + 2):
        for x in range(int(cx - rx) - 1, int(cx + rx) + 2):
            if ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 > 1:
                continue
            if clip and not clip(x, y):
                continue
            col = base
            if x + 0.5 > cx + rx * 0.45:
                col = dark
            elif light and x + 0.5 < cx - rx * 0.35 and y + 0.5 < cy - ry * 0.2:
                col = light
            d.point((x, y), fill=col + (255,))


def hat_sheet(draw):
    """Calls draw(frame, direction, bob) for each of the 12 frames."""
    out = Image.new("RGBA", (96, 128), (0, 0, 0, 0))
    for r in range(4):
        for c in range(3):
            f = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
            draw(f, DIRS[r], 0 if c == 1 else 1)
            out.alpha_composite(f, (c * 32, r * 32))
    return out


def mirror_for(d):
    return d == "right"


def finish(f, d, details=None):
    outline(f)
    if details:
        details(ImageDraw.Draw(f))
    if mirror_for(d):
        f.paste(f.transpose(Image.FLIP_LEFT_RIGHT))


def witch_hat(f, d, b):
    g = ImageDraw.Draw(f)
    # cone, its tip bent backwards (to the right from the front and when facing left)
    g.polygon([(9, 9 + b), (23, 9 + b), (19, 2 + b), (14, 2 + b)], fill=P["m"] + (255,))
    g.polygon([(15, 3 + b), (19, 2 + b), (24, 0 + b), (25, 1 + b), (20, 4 + b)], fill=P["m"] + (255,))
    for y in range(2 + b, 10 + b):
        for x in range(9, 24):
            if f.getpixel((x, y))[3] and x >= 19:
                f.putpixel((x, y), P["M"] + (255,))
    shaded_ellipse(g, 16, 10.0 + b, 13.5, 2.3, P["m"], P["M"])
    g.rectangle([10, 7 + b, 22, 8 + b], fill=P["v"] + (255,))

    def details(g):
        if d in ("down", "left", "right"):
            bx = 16 if d == "down" else 13
            g.rectangle([bx - 1, 7 + b, bx + 1, 8 + b], fill=P["x"] + (255,))
            g.point((bx, 7 + b), fill=P["M"] + (255,))
    finish(f, d, details)


def santa_hat(f, d, b):
    g = ImageDraw.Draw(f)
    shaded_ellipse(g, 15.5, 8.5 + b, 10.5, 7.0, P["r"], P["R"], clip=lambda x, y: y <= 8 + b)
    # floppy tip hanging down at the back side with the pompom
    g.polygon([(20, 2 + b), (25, 4 + b), (28, 9 + b), (26, 10 + b), (22, 6 + b)], fill=P["R"] + (255,))
    g.rectangle([5, 8 + b, 26, 10 + b], fill=P["w"] + (255,))
    for x in range(6, 26, 3):
        g.point((x, 10 + b), fill=P["W"] + (255,))
    g.ellipse([25, 8 + b, 29, 12 + b], fill=P["w"] + (255,))
    g.point((28, 11 + b), fill=P["W"] + (255,))
    finish(f, d)


def straw_hat(f, d, b):
    g = ImageDraw.Draw(f)
    shaded_ellipse(g, 15.5, 6.0 + b, 7.5, 5.0, P["s"], P["S"], clip=lambda x, y: y <= 7 + b)
    g.rectangle([8, 6 + b, 23, 7 + b], fill=P["r"] + (255,))
    shaded_ellipse(g, 15.5, 9.0 + b, 14.5, 2.4, P["s"], P["S"])
    for y in range(8 + b, 11 + b):
        for x in range(2, 30):
            if f.getpixel((x, y))[3] and (x + y) % 3 == 0 and f.getpixel((x, y))[:3] == P["s"]:
                f.putpixel((x, y), P["S"] + (255,))
    finish(f, d)


def crown(f, d, b):
    g = ImageDraw.Draw(f)
    x0, x1 = (8, 24) if d in ("down", "up") else (10, 22)
    g.rectangle([x0, 5 + b, x1, 8 + b], fill=P["x"] + (255,))
    n = 5 if d in ("down", "up") else 4
    for i in range(n):
        px = x0 + round(i * (x1 - x0) / (n - 1))
        g.polygon([(px - 2, 5 + b), (px + 2, 5 + b), (px, 0 + b)], fill=P["x"] + (255,))
    g.rectangle([x0, 8 + b, x1, 8 + b], fill=P["Y"] + (255,))

    def details(g):
        for i in range(n):
            px = x0 + round(i * (x1 - x0) / (n - 1))
            g.point((px, 1 + b), fill=(255, 255, 220, 255))
        gems = [(x0 + 3, "r"), ((x0 + x1) // 2, "b"), (x1 - 3, "r")] if d in ("down", "up") else [((x0 + x1) // 2, "r")]
        for gx, gc in gems:
            g.rectangle([gx - 1, 6 + b, gx, 7 + b], fill=P[gc] + (255,))
    finish(f, d, details)


def party_hat(f, d, b):
    g = ImageDraw.Draw(f)
    g.polygon([(10, 8 + b), (22, 8 + b), (16, 0 + b)], fill=P["p"] + (255,))
    stripes = [P["p"], P["u"], P["y"], P["c"]]
    for y in range(0 + b, 9 + b):
        for x in range(9, 24):
            if f.getpixel((x, y))[3]:
                f.putpixel((x, y), stripes[((y - b) // 2) % 4] + (255,))
    finish(f, d)
    g = ImageDraw.Draw(f)
    g.ellipse([14, 0 + b - 1, 18, 2 + b], fill=P["w"] + (255,))
    for x in (11, 21):
        g.point((x, 8 + b), fill=(255, 255, 255, 255))


def antlers(f, d, b):
    g = ImageDraw.Draw(f)
    col = P["n"] + (255,)

    def antler(x0, sgn):
        g.line([(x0, 8 + b), (x0 - 3 * sgn, 1 + b)], fill=col, width=2)
        g.line([(x0 - 1 * sgn, 5 + b), (x0 - 6 * sgn, 3 + b)], fill=col, width=2)
        g.line([(x0 - 2 * sgn, 3 + b), (x0 + 1 * sgn, 0 + b)], fill=col, width=1)
    if d in ("down", "up"):
        antler(10, 1)
        antler(22, -1)
    else:
        antler(16, -1)  # one antler seen from the side, growing backwards
    finish(f, d)


def pumpkin_head(f, d, b):
    """A big jack-o'-lantern over the whole head and hair (x 2..29, y 1..21), like WorkAdventure's own pumpkin."""
    o, O, q = P["o"], P["O"], P["q"]
    glow, glow2 = P["y"], P["Y"]
    cx, cy, rx, ry = 15.5, 11.0 + b, 13.8, 10.2
    face = {"down": 0, "left": -6, "right": -6, "up": None}[d]  # left/right are drawn facing left, mirrored later
    for y in range(32):
        for x in range(32):
            if ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 > 1:
                continue
            rib = round(x - cx + (face or 0) * 0.5) % 5 == 0
            col = O if rib else o
            if x + 0.5 > cx + rx * 0.5:
                col = O
            if x + 0.5 < cx - rx * 0.45 and y < cy - 2:
                col = o if rib else q
            f.putpixel((x, y), col + (255,))
    outline(f)
    g = ImageDraw.Draw(f)
    sx = 16 if d in ("down", "up") else 18
    g.rectangle([sx - 1, 0 + b, sx, 1 + b], fill=P["g"] + (255,))
    g.point((sx + 1, 0 + b), fill=P["G"] + (255,))
    if face is not None:
        fx = 16 + face
        eyes = (fx - 7, fx + 3) if d == "down" else (fx - 3,)
        for ex in eyes:
            ey = 6 + b
            for i, w in enumerate((1, 3, 5)):
                g.line([(ex + 2 - w // 2, ey + i), (ex + 2 + w // 2, ey + i)], fill=(glow if i < 2 else glow2) + (255,))
            g.point((ex + 2, ey + 1), fill=(255, 250, 210, 255))
        mx0, mx1 = (fx - 7, fx + 8) if d == "down" else (fx - 4, fx + 4)
        my = 13 + b
        for x in range(mx0, mx1):
            g.point((x, my), fill=glow + (255,))
            g.point((x, my + 1), fill=glow2 + (255,))
            if (x - mx0) % 3 == 1:
                g.point((x, my), fill=O + (255,))
            if (x - mx0) % 3 == 2:
                g.point((x, my + 1), fill=O + (255,))
        for x in (mx0 - 1, mx1):
            g.point((x, my - 1), fill=glow2 + (255,))
    if mirror_for(d):
        f.paste(f.transpose(Image.FLIP_LEFT_RIGHT))


def build_hats():
    return {
        "pumpkin-head": hat_sheet(pumpkin_head),
        "witch-hat": hat_sheet(witch_hat),
        "santa-hat": hat_sheet(santa_hat),
        "antlers": hat_sheet(antlers),
        "straw-hat": hat_sheet(straw_hat),
        "crown": hat_sheet(crown),
        "party-hat": hat_sheet(party_hat),
    }


# ======================= sunglasses (eyes part) =======================
def sunglasses():
    out = Image.new("RGBA", (96, 128), (0, 0, 0, 0))
    lens = (18, 18, 24)
    shine = (120, 130, 160)
    gold = rgb("#e8c040")
    for r in range(4):
        for c in range(3):
            f = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
            y = 12 + (0 if c == 1 else 1) - 1
            d = DIRS[r]
            if d == "down":
                for x0 in (9, 18):
                    for yy in range(y, y + 4):
                        for xx in range(x0, x0 + 6):
                            put(f, xx, yy, lens)
                    put(f, x0 + 1, y, shine)
                    put(f, x0 + 2, y, shine)
                for xx in range(15, 18):
                    put(f, xx, y, gold)
                put(f, 8, y, gold)
                put(f, 24, y, gold)
            elif d in ("left", "right"):
                xs = range(10, 16) if d == "left" else range(16, 22)
                for yy in range(y, y + 4):
                    for xx in xs:
                        put(f, xx, yy, lens)
                put(f, xs[1], y, shine)
                arm = range(16, 22) if d == "left" else range(10, 16)
                for xx in arm:
                    put(f, xx, y, gold)
            # from behind: nothing to see
            out.alpha_composite(f, (c * 32, r * 32))
    return out


# ======================= accessories =======================
# About the size of WorkAdventure's own hand-held accessories (9-12 px wide, 12-16 px high).
LANTERN = [
    "...kkkkk...",
    "..k.....k..",
    ".kkkkkkkkk.",
    "kooqoooooOk",
    "koyykoyykOk",
    "koyyyoyyyOk",
    "koooooooOOk",
    "kokyykyykOk",
    "kooyyyyyOOk",
    ".koooooOOk.",
    "..kkkkkkk..",
]
CANDY_CANE = [
    "..kkkk..",
    ".kwrrwk.",
    "kwrkkrwk",
    "krk..kwk",
    "kk...krk",
    ".....kwk",
    ".....krk",
    ".....kwk",
    ".....krk",
    ".....kwk",
    ".....krk",
    ".....kwk",
    ".....kkk",
]
ICE = [
    ".kkkkk.",
    "kpppppk",
    "kpwpppk",
    "kpppppk",
    "kuuuuuk",
    "kuuwuuk",
    "kuuuuuk",
    "kuuuuuk",
    ".kkkkk.",
    "...n...",
    "...n...",
    "...n...",
]
TROPHY = [
    "..kkkkkkkk..",
    "kkkxxxxxxkkk",
    "kxkxwxxxYkxk",
    "kxkxxxxxYkxk",
    ".kkxxxxxYkk.",
    "...kxxxYk...",
    "....kxYk....",
    ".....kk.....",
    "....kxYk....",
    "...kkkkkk...",
    "..kxxxxxYk..",
    "..kkkkkkkk..",
]


def worn(down, side, back=None, y=19, pal=None):
    """Something worn on the chest (necklace, medal): drawn below the chin."""
    def draw(f, d, c, bob, hand):
        if d == "up":
            if back:
                w, h = size(back)
                blit(f, back, 16 - w // 2, y + bob - 2, pal=pal)
            return
        art = down if d == "down" else side
        w, h = size(art)
        if d == "down":
            x = 16 - w // 2
        elif d == "left":
            x = 11
        else:
            x = 32 - 11 - w
        blit(f, art, x, y + bob - 1, flip=(d == "right"), pal=pal)
    return draw


MEDAL = [
    "b.........b",
    "kb.......bk",
    ".kb.....bk.",
    "..kbB.Bbk..",
    "....kxk....",
    "...kxxYk...",
    "...kxYYk...",
    "....kkk....",
]
MEDAL_SIDE = [
    "b...",
    "kb..",
    ".kxk",
    ".kYk",
    "..k.",
]
MEDAL_BACK = ["bbbbbbbbbbb"]


def build_accessories():
    pal = dict(HAT_PAL)
    return {
        "pumpkin-lantern": handheld(LANTERN, LANTERN, LANTERN, grip=(5, 4)),
        "candy-cane": handheld(CANDY_CANE, CANDY_CANE, CANDY_CANE, grip=(6, 7)),
        "ice-cream": handheld(ICE, ICE, ICE, grip=(3, 10)),
        "trophy": handheld(TROPHY, TROPHY, TROPHY, grip=(6, 8)),
        "medal": worn(MEDAL, MEDAL_SIDE, MEDAL_BACK, y=18, pal=pal),
    }, pal


# ======================= companions =======================
# Companions use the same layout as Pipoya characters: 3 frames x 4 directions of 32x32, the creature at the bottom.
def companion(draw_frame):
    out = Image.new("RGBA", (96, 128), (0, 0, 0, 0))
    for r in range(4):
        for c in range(3):
            f = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
            draw_frame(f, DIRS[r], c)
            out.alpha_composite(f, (c * 32, r * 32))
    return out


def art_at(f, art, x, y, pal, flip=False):
    for j, row in enumerate(art):
        if flip:
            row = row[::-1]
        for i, ch in enumerate(row):
            if ch != ".":
                put(f, x + i, y + j, pal[ch])


BAT_PAL = {"k": K, "d": rgb("#3a2a4a"), "D": rgb("#24182e"), "e": rgb("#ff4040"), "p": rgb("#f0a0b0")}
BAT_UP = [
    "k.......k.........k.......k",
    "dk.....kdk.......kdk.....kd",
    "ddk...kdddk.kkk.kdddk...kdd",
    ".ddkkkddddkkdddkkddddkkkdd.",
    "..ddddddddkdedekdddddddd...",
    "....dddDDkdddddkDDddd......",
    "........kkkdpdkkk..........",
    "...........kkk.............",
]
BAT_DOWN = [
    "...........kkk.............",
    "......kk..kdddk..kk........",
    "....kkddkkdedekkddkk.......",
    "..kkddddddkdddkdddddkk.....",
    ".kddddddddkdpdkddddddddk...",
    "kddDD..kddkkkkkddk..DDddk..",
    "kdD.....kk.....kk.....Ddk..",
    "kk...................kk....",
]


def bat(f, d, c):
    """Flies with spread wings in every direction (a side view would hide the wings), flapping each frame."""
    y = 12 + (c % 2) * 2
    art = BAT_UP if c != 1 else BAT_DOWN
    w = len(art[0])
    shift = {"down": 0, "up": 0, "left": -1, "right": 1}[d]
    art_at(f, art, 16 - w // 2 + shift, y, BAT_PAL, flip=(d == "right"))


GHOST_PAL = {"k": rgb("#3a4a6a"), "w": rgb("#f4f8ff"), "W": rgb("#c8d4ec"), "e": rgb("#1a1a2a"), "p": rgb("#ffb0c8")}
def ghost(f, d, c):
    """A round little ghost, floating up and down."""
    w_, W_, k_ = GHOST_PAL["w"], GHOST_PAL["W"], GHOST_PAL["k"]
    lift = [0, -1, 1][c]
    cx, top, rx = 16, 9 + lift, 8.5
    bottom = 27 + lift
    for y in range(top, bottom + 1):
        for x in range(32):
            dx = (x + 0.5 - cx) / rx
            if y < top + rx:
                inside = dx * dx + ((y + 0.5 - (top + rx)) / rx) ** 2 <= 1
            else:
                inside = abs(dx) <= 1
            if y >= bottom - 2:  # wavy hem, moving with the frame
                wave = (x + c * 2) % 6
                inside = inside and (y < bottom - 1 or wave < 3) and (y < bottom or wave in (1,))
            if inside:
                col = W_ if x + 0.5 > cx + rx * 0.4 or y > bottom - 4 else w_
                f.putpixel((x, y), col + (255,))
    outline(f, k_)
    g = ImageDraw.Draw(f)
    e = GHOST_PAL["e"] + (255,)
    pk = GHOST_PAL["p"] + (255,)
    ey = top + 7
    if d == "down":
        g.rectangle([12, ey, 13, ey + 2], fill=e)
        g.rectangle([18, ey, 19, ey + 2], fill=e)
        g.point((12, ey), fill=(255, 255, 255, 255))
        g.point((18, ey), fill=(255, 255, 255, 255))
        g.rectangle([10, ey + 3, 11, ey + 3], fill=pk)
        g.rectangle([20, ey + 3, 21, ey + 3], fill=pk)
        g.line([(15, ey + 4), (16, ey + 4)], fill=e)
    elif d in ("left", "right"):
        ex = 10 if d == "left" else 20
        g.rectangle([ex, ey, ex + 1, ey + 2], fill=e)
        g.point((ex, ey), fill=(255, 255, 255, 255))
        g.rectangle([ex - 1 if d == "left" else ex + 1, ey + 3, ex if d == "left" else ex + 2, ey + 3], fill=pk)
        # little arm trailing behind
        ax = 24 if d == "left" else 7
        g.rectangle([ax, top + 12, ax, top + 13], fill=W_ + (255,))


# ======================= frog and dragon (drawn like WorkAdventure's Pipoya pets) =======================
# Pipoya pets are about 26-30 px long from the side and 17 px wide from the front, with a dark outline in the
# animal's own colour, a light top-left and a dark lower-right. Shapes are filled first, then shaded and outlined.

class Pet:
    def __init__(self, base, light, dark, line):
        self.f = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
        self.base, self.light, self.dark, self.line = base, light, dark, line

    def ellipse(self, cx, cy, rx, ry, col=None, shade=True):
        for y in range(int(cy - ry) - 1, int(cy + ry) + 2):
            for x in range(int(cx - rx) - 1, int(cx + rx) + 2):
                if not (0 <= x < 32 and 0 <= y < 32):
                    continue
                u, v = (x + 0.5 - cx) / rx, (y + 0.5 - cy) / ry
                if u * u + v * v > 1:
                    continue
                c = col or self.base
                if shade and col is None:
                    if u + v > 0.75:
                        c = self.dark
                    elif u + v < -0.85:
                        c = self.light
                self.f.putpixel((x, y), c + (255,))

    def poly(self, pts, col=None):
        ImageDraw.Draw(self.f).polygon(pts, fill=(col or self.base) + (255,))

    def px(self, x, y, col):
        if 0 <= x < 32 and 0 <= y < 32:
            self.f.putpixel((x, y), col + (255,))

    def rect(self, x0, y0, x1, y1, col):
        ImageDraw.Draw(self.f).rectangle([x0, y0, x1, y1], fill=col + (255,))

    def outline(self):
        outline(self.f, self.line)
        return self.f


def pet_eye(p, x, y, big=False):
    """Eye with white, pupil and highlight."""
    if big:
        p.rect(x, y, x + 2, y + 2, (255, 255, 255))
        p.rect(x + 1, y + 1, x + 2, y + 2, (30, 26, 34))
        p.px(x + 1, y + 1, (255, 255, 255))
    else:
        p.rect(x, y, x + 1, y + 1, (30, 26, 34))
        p.px(x, y, (255, 255, 255))


FROG = dict(base=rgb("#5cc24a"), light=rgb("#9ae86a"), dark=rgb("#3a8e34"), line=rgb("#1f4a1c"))
FROG_BELLY = rgb("#e6f2a2")


def frog_frame(d, c):
    """Frog: sits in frames 0 and 2, hops in the middle frame."""
    p = Pet(**FROG)
    hop = c == 1
    up = 4 if hop else 0
    if d == "down":
        by = 24 - up
        p.ellipse(16, by, 10, 6.5)                     # body
        p.ellipse(16, by + 2.5, 6, 3.5, FROG_BELLY)    # belly
        for ex in (10.5, 21.5):                        # eye bumps
            p.ellipse(ex, by - 6, 3.6, 3.4)
        if hop:                                        # legs stretched down
            p.ellipse(9, by + 7, 2.2, 2.5)
            p.ellipse(23, by + 7, 2.2, 2.5)
        else:                                          # feet on the ground
            p.ellipse(8.5, by + 5, 3, 1.8)
            p.ellipse(23.5, by + 5, 3, 1.8)
        f = p.outline()
        for ex in (9, 20):
            pet_eye(p, ex, by - 7, big=True)
        g = ImageDraw.Draw(f)
        g.line([(11, by), (21, by)], fill=FROG["line"] + (255,))     # wide smile
        p.px(10, by - 1, FROG["line"])
        p.px(22, by - 1, FROG["line"])
        p.px(9, by - 2, (255, 130, 150))
        p.px(23, by - 2, (255, 130, 150))
        return f
    if d == "up":
        by = 24 - up
        p.ellipse(16, by, 10, 6.5)
        for ex in (10.5, 21.5):
            p.ellipse(ex, by - 6, 3.6, 3.4)
        if hop:
            p.ellipse(9, by + 7, 2.2, 2.5)
            p.ellipse(23, by + 7, 2.2, 2.5)
        else:
            p.ellipse(8.5, by + 5, 3, 1.8)
            p.ellipse(23.5, by + 5, 3, 1.8)
        f = p.outline()
        for sx, sy in ((13, by - 2), (19, by - 1), (16, by + 2), (11, by + 2), (21, by + 3)):   # spots on the back
            p.rect(sx, sy, sx + 1, sy + 1, FROG["dark"])
        return f
    # side, drawn facing left (mirrored for right)
    by = 24 - up
    if hop:
        p.ellipse(22, by + 5, 5.5, 2)                  # back leg stretched out behind
        p.ellipse(27, by + 7, 2.5, 1.5)
    else:
        p.ellipse(21, by + 2, 4.5, 4)                  # folded back leg (thigh)
        p.ellipse(22, by + 6, 4, 1.6)                  # foot
    p.ellipse(16, by, 9, 6)                            # body
    p.ellipse(13, by + 3, 6, 2.6, FROG_BELLY)          # light throat and belly
    p.ellipse(11, by - 5.5, 3.6, 3.4)                  # eye bump
    p.ellipse(9, by + 5 + (1 if hop else 0), 2, 2.2)   # front leg
    if not hop:
        p.ellipse(21, by + 2, 4.5, 4)                  # thigh over the body
    f = p.outline()
    pet_eye(p, 9, by - 7, big=True)
    ImageDraw.Draw(f).line([(7, by + 1), (12, by + 1)], fill=FROG["line"] + (255,))
    p.px(13, by, FROG["line"])
    p.px(11, by - 1, (255, 130, 150))
    if d == "right":
        f = f.transpose(Image.FLIP_LEFT_RIGHT)
    return f


DRAGON = dict(base=rgb("#4aa8e0"), light=rgb("#8fd2ff"), dark=rgb("#2a6ea8"), line=rgb("#173a66"))
DRAGON_BELLY = rgb("#ffe08a")
WING = rgb("#b06ad8")
WING_DARK = rgb("#7a3ea8")


def dragon_frame(d, c):
    """Small dragon: walks on four legs, wings flap with the steps."""
    p = Pet(**DRAGON)
    step = [-1, 0, 1][c]
    wing_up = c != 1
    bob = 0 if c == 1 else 1
    if d in ("left", "right"):
        by = 23 + bob
        # wing behind the body
        if wing_up:
            p.poly([(15, by - 4), (20, by - 13), (26, by - 11), (23, by - 6), (20, by - 3)], WING)
        else:
            p.poly([(15, by - 4), (22, by - 9), (27, by - 6), (22, by - 3)], WING)
        # tail
        p.poly([(21, by - 1), (28, by - 5), (30, by - 6), (29, by - 3), (22, by + 3)])
        p.poly([(28, by - 8), (31, by - 7), (29, by - 4)], DRAGON_BELLY)
        # legs (far pair darker), alternating
        p.ellipse(12 - step, by + 5, 1.8, 2.6, DRAGON["dark"])
        p.ellipse(20 + step, by + 5, 1.8, 2.6, DRAGON["dark"])
        p.ellipse(16, by, 7, 5)                        # body
        p.ellipse(14, by + 2.5, 5, 2.2, DRAGON_BELLY)  # belly
        p.ellipse(13 + step, by + 6, 1.9, 2.4)         # near legs
        p.ellipse(19 - step, by + 6, 1.9, 2.4)
        p.ellipse(9, by - 6, 5, 4.2)                   # head
        p.ellipse(4.5, by - 4.5, 2.6, 2.2)             # snout
        p.poly([(10, by - 10), (12, by - 14), (13, by - 9)], DRAGON_BELLY)   # horn
        for i, sx in enumerate(range(13, 22, 3)):      # spikes along the back
            p.poly([(sx, by - 4 + (i > 1)), (sx + 1, by - 7 + (i > 1)), (sx + 2, by - 4 + (i > 1))], WING_DARK)
        f = p.outline()
        pet_eye(p, 7, by - 8, big=True)
        p.px(3, by - 5, DRAGON["line"])               # nostril
        ImageDraw.Draw(f).line([(3, by - 3), (7, by - 3)], fill=DRAGON["line"] + (255,))
        p.px(6, by - 2, (255, 130, 150))
        if d == "right":
            f = f.transpose(Image.FLIP_LEFT_RIGHT)
        return f
    by = 23 + bob
    # wings spread to both sides, behind
    wy = by - 9 if wing_up else by - 6
    p.poly([(12, by - 3), (4, wy), (5, wy + 5), (11, by + 1)], WING)
    p.poly([(20, by - 3), (28, wy), (27, wy + 5), (21, by + 1)], WING)
    if d == "up":
        p.poly([(14, by + 4), (16, by + 9), (18, by + 4)])      # tail hanging down behind
    p.ellipse(16, by + 1, 6.5, 5.5)                             # body
    if d == "down":
        p.ellipse(16, by + 2, 4, 3.6, DRAGON_BELLY)
    p.ellipse(11.5 + step, by + 6.5, 2, 2)                      # feet
    p.ellipse(20.5 - step, by + 6.5, 2, 2)
    p.ellipse(16, by - 7, 6, 5)                                 # head
    p.poly([(11, by - 10), (10, by - 15), (13, by - 11)], DRAGON_BELLY)   # horns
    p.poly([(21, by - 10), (22, by - 15), (19, by - 11)], DRAGON_BELLY)
    if d == "down":
        p.ellipse(16, by - 4.5, 3.5, 2.2, DRAGON["light"])      # snout
    f = p.outline()
    if d == "down":
        pet_eye(p, 12, by - 9, big=True)
        pet_eye(p, 18, by - 9, big=True)
        p.px(15, by - 5, DRAGON["line"])
        p.px(17, by - 5, DRAGON["line"])
        p.px(11, by - 5, (255, 130, 150))
        p.px(21, by - 5, (255, 130, 150))
    else:
        for i, sy in enumerate(range(by - 3, by + 4, 3)):        # spikes down the back
            p.poly([(15, sy), (16, sy - 2), (17, sy)], WING_DARK)
    return f


def frog(f, d, c):
    f.alpha_composite(frog_frame(d, c))


def dragon(f, d, c):
    f.alpha_composite(dragon_frame(d, c))


def build_companions():
    return {
        "bat": companion(bat),
        "ghost": companion(ghost),
        "dragon": companion(dragon),
        "frog": companion(frog),
    }


def build(src, out_dir):
    import gen_accessories
    for key, col in HAT_PAL.items():  # colours the hand-held art uses that the shared palette lacks
        gen_accessories.PALETTE.setdefault(key, col)
    os.makedirs(out_dir, exist_ok=True)
    files = {}
    for name, im in build_clothes(src).items():
        files[f"clothes-{name}.png"] = im
    for name, im in build_hats().items():
        files[f"hat-{name}.png"] = im
    files["eyes-sunglasses.png"] = sunglasses()
    acc, _ = build_accessories()
    for name, draw in acc.items():
        files[f"accessory-{name}.png"] = sheet(draw)
    for name, im in build_companions().items():
        files[f"companion-{name}.png"] = im
    for fn, im in list(files.items()):
        files[f"icon-{fn}"] = icon(im)
    for fn, im in files.items():
        im.save(os.path.join(out_dir, fn), optimize=True)
    return sorted(files)


def icon(im):
    """Still picture for the admin pages: the standing frame of each direction (down, left, right, up), the item
    alone, centred and enlarged by a whole factor when it is small. All four use the same offset and size, so the item
    does not jump between directions."""
    cells = [im.crop((32, r * 32, 64, r * 32 + 32)) for r in range(4)]
    boxes = [c.getbbox() for c in cells if c.getbbox()]
    if not boxes:
        return Image.new("RGBA", (128, 32), (0, 0, 0, 0))
    x0, y0 = min(b[0] for b in boxes), min(b[1] for b in boxes)
    x1, y1 = max(b[2] for b in boxes), max(b[3] for b in boxes)
    k = max(1, 28 // max(x1 - x0, y1 - y0))
    w, h = (x1 - x0) * k, (y1 - y0) * k
    left, top = (32 - w) // 2, (32 - h) // 2
    out = Image.new("RGBA", (128, 32), (0, 0, 0, 0))
    for i, c in enumerate(cells):
        out.alpha_composite(c.crop((x0, y0, x1, y1)).resize((w, h), Image.NEAREST), (i * 32 + left, top))
    return out


if __name__ == "__main__":
    print("\n".join(build(sys.argv[1], sys.argv[2])))
