"""Builds the Beyond in Owlbear logo: a calligraphic B on a sheet of paper.

The B comes from the font Great Vibes (SIL Open Font License 1.1, see OFL-GreatVibes.txt):
https://github.com/google/fonts/tree/main/ofl/greatvibes
Download GreatVibes-Regular.ttf next to this script, then run:  python make_logo.py

Outputs (written to the repo):
- icon.svg               single-colour Owlbear toolbar icon (currentColor; Owlbear tints it)
- relay/icon.ico         coloured program icon for Beyond Relay (16-256 px)
- relay/icon-64.png      window icon for Beyond Relay
Requires: fonttools, pillow
"""
from pathlib import Path

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from PIL import Image, ImageChops, ImageDraw, ImageFilter

HERE = Path(__file__).parent
REPO = HERE.parent
FONT = HERE / "GreatVibes-Regular.ttf"

# Geometry in a 64 x 64 box: a portrait sheet with a folded top-right corner.
SHEET = "M19 5 H41 L53 17 V53 Q53 59 47 59 H17 Q11 59 11 53 V11 Q11 5 17 5 Z"
FOLD = "M41 5 V14 Q41 17 44 17 H53"
B_BOX = (38, 40)      # max width/height of the B inside the sheet
B_CENTER = (32, 34)
B_THICKEN = 1.6       # extra stroke so the script hairlines survive at 24 px

font = TTFont(FONT)
glyphs = font.getGlyphSet()
B = font.getBestCmap()[ord("B")]
bounds = BoundsPen(glyphs); glyphs[B].draw(bounds)
X0, Y0, X1, Y1 = bounds.bounds
K = min(B_BOX[0] / (X1 - X0), B_BOX[1] / (Y1 - Y0))
W, H = (X1 - X0) * K, (Y1 - Y0) * K
TRANSFORM = (K, 0, 0, -K, B_CENTER[0] - W / 2 - X0 * K, B_CENTER[1] + H / 2 + Y0 * K)


def b_svg_path():
    pen = SVGPathPen(glyphs, ntos=lambda v: f"{v:.2f}".rstrip("0").rstrip("."))
    glyphs[B].draw(TransformPen(pen, TRANSFORM))
    return pen.getCommands()


class _PolyPen:
    """Collects the glyph outline as polygons (curves flattened), in 64-unit coordinates."""
    def __init__(self):
        self.polys, self.cur, self.pos = [], [], (0, 0)
    def moveTo(self, p):
        self.cur = [p]; self.pos = p
    def lineTo(self, p):
        self.cur.append(p); self.pos = p
    def qCurveTo(self, *pts):
        # TrueType quadratic spline with implied on-curve points
        start, offs, end = self.pos, list(pts[:-1]), pts[-1]
        segs = []
        for i, c in enumerate(offs):
            nxt = end if i == len(offs) - 1 else ((c[0] + offs[i + 1][0]) / 2, (c[1] + offs[i + 1][1]) / 2)
            segs.append((c, nxt))
        p0 = start
        for c, p2 in segs:
            for s in range(1, 11):
                t = s / 10
                self.cur.append(((1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * c[0] + t * t * p2[0],
                                 (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * c[1] + t * t * p2[1]))
            p0 = p2
        self.pos = end
    def curveTo(self, c1, c2, p):
        p0 = self.pos
        for s in range(1, 17):
            t = s / 16
            self.cur.append(tuple((1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t * t * c + t ** 3 * d
                                  for a, b, c, d in zip(p0, c1, c2, p)))
        self.pos = p
    def closePath(self):
        if self.cur: self.polys.append(self.cur); self.cur = []
    endPath = closePath
    def addComponent(self, name, t):
        glyphs[name].draw(TransformPen(self, t))


def b_mask(size):
    """Filled B (even-odd, so counters stay open), thickened like the SVG stroke."""
    pen = _PolyPen(); glyphs[B].draw(TransformPen(pen, TRANSFORM))
    k = size / 64
    mask = Image.new("1", (size, size), 0)
    for poly in pen.polys:
        m = Image.new("1", (size, size), 0)
        ImageDraw.Draw(m).polygon([(x * k, y * k) for x, y in poly], fill=1)
        mask = ImageChops.logical_xor(mask, m)
    mask = mask.convert("L")
    grow = max(3, int(round(B_THICKEN / 2 * k)) * 2 + 1)
    return mask.filter(ImageFilter.MaxFilter(grow))


def toolbar_svg():
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <path d="{SHEET}" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/>
  <path d="{FOLD}" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="{b_svg_path()}" fill="currentColor" stroke="currentColor" stroke-width="{B_THICKEN}" stroke-linejoin="round"/>
</svg>
'''


def relay_icon(size=512):
    """Coloured version: purple sheet, lighter folded corner, white B."""
    k = size / 64
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    purple, fold = (139, 92, 246, 255), (196, 176, 255, 255)
    d.rounded_rectangle([11 * k, 5 * k, 53 * k, 59 * k], radius=6 * k, fill=purple)
    d.polygon([(41 * k, 5 * k), (53 * k, 5 * k), (53 * k, 17 * k)], fill=(0, 0, 0, 0))
    d.polygon([(41 * k, 5 * k), (41 * k, 17 * k), (53 * k, 17 * k)], fill=fold)
    img.paste(Image.new("RGBA", (size, size), (255, 255, 255, 255)), (0, 0), b_mask(size))
    return img


if __name__ == "__main__":
    (REPO / "icon.svg").write_text(toolbar_svg(), encoding="utf-8")
    big = relay_icon(512)
    big.save(REPO / "relay" / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    big.resize((64, 64), Image.LANCZOS).save(REPO / "relay" / "icon-64.png")
    print("written: icon.svg, relay/icon.ico, relay/icon-64.png")
