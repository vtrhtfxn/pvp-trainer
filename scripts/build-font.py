#!/usr/bin/env python3
"""
Builds src/assets/fonts/minecraft.woff2 — Minecraft's own font — from the bitmap glyph sheets of
the default resource pack (font/ascii.png, accented.png, nonlatin_european.png, laid out by
default.json and space.json), so text in the game is drawn with the real glyphs.

Every glyph pixel becomes a square of the outline (1 px = 128 units, 8 px = 1 em); a glyph is as
wide as its rightmost opaque column plus one, and advances one more pixel (vanilla spacing).

    pip install fonttools brotli
    python3 scripts/build-font.py
"""
import json
import os

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'font-src')
OUT = os.path.join(HERE, '..', 'src', 'assets', 'fonts', 'minecraft.woff2')
U = 128  # font units per glyph pixel
UPEM = 8 * U


def load_glyphs():
    """codepoint -> (rows of opaque pixels, ascent) for every bitmap provider, first one wins."""
    glyphs = {}
    providers = json.load(open(os.path.join(SRC, 'default.json')))['providers']
    for p in providers:
        if p.get('type') != 'bitmap':
            continue
        name = os.path.basename(p['file'].split(':')[-1])
        path = os.path.join(SRC, name)
        if not os.path.exists(path):
            continue
        img = Image.open(path).convert('RGBA')
        rows = p['chars']
        cols = max(len(r) for r in rows)
        cw, ch = img.width // cols, img.height // len(rows)
        height = p.get('height', 8)
        ascent = p['ascent']
        scale = height / ch  # the sheet may be drawn at a different resolution than 8 px cells
        for ri, row in enumerate(rows):
            for ci, c in enumerate(row):
                cp = ord(c)
                if cp == 0 or cp in glyphs:
                    continue
                cell = img.crop((ci * cw, ri * ch, (ci + 1) * cw, (ri + 1) * ch))
                px = cell.load()
                mask = [[px[x, y][3] > 0 for x in range(cw)] for y in range(ch)]
                if not any(any(r) for r in mask):
                    continue
                glyphs[cp] = (mask, ascent, scale)
    return glyphs


def outline(mask, ascent, scale):
    """Rectangles (x0, y0, x1, y1) in pixels, merging horizontal runs and identical rows."""
    open_runs = {}
    rects = []
    for y, row in enumerate(mask + [[False] * len(mask[0])]):
        runs = []
        x = 0
        while x < len(row):
            if row[x]:
                x0 = x
                while x < len(row) and row[x]:
                    x += 1
                runs.append((x0, x))
            else:
                x += 1
        nxt = {}
        for r in runs:
            nxt[r] = open_runs.pop(r, y)
        for r, top in open_runs.items():
            rects.append((r[0], top, r[1], y))
        open_runs = nxt
    return [(x0 * scale, (ascent - y1 * scale), x1 * scale, (ascent - y0 * scale)) for x0, y0, x1, y1 in rects]


def main():
    glyphs = load_glyphs()
    order = ['.notdef', 'space']
    cmap = {0x20: 'space', 0xA0: 'space'}
    shapes = {}
    advances = {'.notdef': 5 * U, 'space': 4 * U}
    # .notdef: a hollow box like vanilla's missing-glyph.
    box = TTGlyphPen(None)
    box.moveTo((0, 0)); box.lineTo((0, 7 * U)); box.lineTo((4 * U, 7 * U)); box.lineTo((4 * U, 0)); box.closePath()
    box.moveTo((U, U)); box.lineTo((3 * U, U)); box.lineTo((3 * U, 6 * U)); box.lineTo((U, 6 * U)); box.closePath()
    shapes['.notdef'] = box.glyph()
    empty = TTGlyphPen(None).glyph()
    shapes['space'] = empty
    for cp in sorted(glyphs):
        if cp in (0x20, 0xA0) or cp > 0xFFFF:
            continue
        mask, ascent, scale = glyphs[cp]
        rects = outline(mask, ascent, scale)
        name = 'uni%04X' % cp
        gp = TTGlyphPen(None)
        width = 0
        for x0, y0, x1, y1 in rects:
            # Clockwise contours (TrueType's outside direction).
            gp.moveTo((round(x0 * U), round(y0 * U)))
            gp.lineTo((round(x0 * U), round(y1 * U)))
            gp.lineTo((round(x1 * U), round(y1 * U)))
            gp.lineTo((round(x1 * U), round(y0 * U)))
            gp.closePath()
            width = max(width, x1)
        shapes[name] = gp.glyph()
        advances[name] = round((width + 1) * U)
        cmap[cp] = name
        order.append(name)

    fb = FontBuilder(UPEM, isTTF=True)
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap(cmap)
    fb.setupGlyf({n: shapes[n] for n in order})
    fb.setupHorizontalMetrics({n: (advances.get(n, 4 * U), 0) for n in order})
    # Vanilla's line: 8 px of glyph (7 above the baseline) and 1 px between lines.
    fb.setupHorizontalHeader(ascent=7 * U, descent=-1 * U, lineGap=U)
    fb.setupNameTable({'familyName': 'Minecraft', 'styleName': 'Regular'})
    fb.setupOS2(version=4, sTypoAscender=7 * U, sTypoDescender=-1 * U, sTypoLineGap=U, usWinAscent=7 * U, usWinDescent=U, fsSelection=0x40 | 0x80)
    fb.setupPost()
    fb.font.flavor = 'woff2'
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    fb.save(OUT)
    print(f'{len(order)} glyphs -> {os.path.getsize(OUT) / 1024:.1f} KB')


if __name__ == '__main__':
    main()
