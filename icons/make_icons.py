"""Render every icon of both plugins from the SVGs in ./src. All icons are white.

- Key images: stroke 1.25, the glyph (stroke included, longer side) is 48 px on the 72 px key.
- Action-list and category icons: stroke 1.25, the glyph fills the image.
- Plugin icons: stroke 1.5, padded, on #3d354b.
The Simple Clock key image is intentionally blank and is not generated.

usage: python -I make_icons.py [output root, default: the folder above this one]
"""
import re
import sys
from pathlib import Path

import pymupdf

HERE = Path(__file__).resolve().parent
repo = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else HERE.parent
api = repo / "api-tools" / "io.github.tekinozbek.api-tools.sdPlugin" / "imgs"
util = repo / "utilities" / "io.github.tekinozbek.utilities.sdPlugin" / "imgs"


def load(name, stroke="1.25"):
    text = (HERE / "src" / f"{name}.svg").read_text(encoding="utf-8").replace("#000000", "#FFFFFF")
    text, n = re.subn(r'stroke-width="[\d.]+"', f'stroke-width="{stroke}"', text)
    assert n, name
    root = re.search(r"<svg[^>]*>", text).group(0)
    return text.replace(root, re.sub(r'\s(width|height)="[^"]*"', "", root))


def pixels(svg, box, size, background=None):
    x, y, side = box
    view = f'viewBox="{x:.4f} {y:.4f} {side:.4f} {side:.4f}" width="{size}" height="{size}"'
    s, n = re.subn(r'viewBox="[^"]*"', view, svg, count=1)
    assert n == 1
    if background:
        at = s.index("<path")
        s = s[:at] + f'<rect x="{x}" y="{y}" width="{side}" height="{side}" fill="{background}"/>' + s[at:]
    page = pymupdf.open(stream=s.encode(), filetype="svg")[0]
    zoom = size / page.rect.width
    return page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=True)


def extent(pix):
    """(left, top, right, bottom) of the visible pixels."""
    alpha = bytes(pix.samples[pix.n - 1 :: pix.n])
    w = pix.width
    ys = [i for i in range(pix.height) if max(alpha[i * w : (i + 1) * w]) > 64]
    xs = [i for i in range(w) if max(alpha[i::w]) > 64]
    return xs[0], ys[0], xs[-1] + 1, ys[-1] + 1


def bounds(svg):
    """Visible bounds of the glyph, stroke included, in viewBox units."""
    side, px = 32.0, 1280
    l, t, r, b = extent(pixels(svg, (-4, -4, side), px))
    u = side / px
    return -4 + l * u, -4 + t * u, -4 + r * u, -4 + b * u


def save(pix, size, dest):
    assert pix.width == pix.height == size, (dest, pix.width, pix.height)
    dest.parent.mkdir(parents=True, exist_ok=True)
    pix.save(dest)
    print("wrote", dest.relative_to(repo).as_posix(), size)


def fitted(name, dest_dir, stem, base, glyph, canvas):
    """The glyph's longer side takes `glyph` of `canvas` units, centred."""
    svg = load(name)
    l, t, r, b = bounds(svg)
    side = max(r - l, b - t) * canvas / glyph
    box = ((l + r - side) / 2, (t + b - side) / 2, side)
    for suffix, size in (("", base), ("@2x", base * 2)):
        save(pixels(svg, box, size), size, dest_dir / f"{stem}{suffix}.png")


def key(name, dest_dir, stem):
    fitted(name, dest_dir, stem, 72, 48, 72)


def listed(name, dest_dir, stem, base):
    fitted(name, dest_dir, stem, base, 1, 1)


def plugin_icon(name, dest_dir):
    svg = load(name, "1.5")
    for suffix, size in (("", 256), ("@2x", 512)):
        save(pixels(svg, (-5, -5, 34), size, "#3d354b"), size, dest_dir / f"plugin-icon{suffix}.png")


actions = api / "actions"
key("code-brackets", actions / "webhook", "key")
for source, stem in (("square", "off"), ("check-square", "on"), ("help-square", "unknown"), ("warning-square", "error")):
    key(source, actions / "toggle", stem)
listed("code-brackets", actions / "webhook", "icon", 20)
listed("check-square", actions / "toggle", "icon", 20)
listed("wristwatch", util / "actions" / "clock", "icon", 20)
listed("developer", api, "category-icon", 28)
listed("tools", util, "category-icon", 28)
plugin_icon("developer", api)
plugin_icon("tools", util)
