"""Builds resources/fonts: the fonts a player may pick in the launcher (game and launcher).

H1Z1 loads its Latin interface fonts by file name from UI/Resource/Fonts when it starts
(12 managed files below). The launcher rewrites those 12 files before every launch from
this bundle: the stock files for "original", the chosen font otherwise. manifest.json is
the allow-list; anything else a player drops there is replaced at the next launch.

usage: python scripts/build-player-fonts.py <stock UI/Resource/Fonts dir> <google fonts dir>
The Google dir holds the files of https://github.com/google/fonts/tree/main/ofl as
<family>/<file> (variable fonts renamed <Family>-VF.ttf).
"""
import hashlib, io, json, os, shutil, sys
from fontTools.pens.boundsPen import BoundsPen
from fontTools.ttLib import TTFont
from fontTools.subset import Options, Subsetter
from fontTools.varLib.instancer import instantiateVariableFont

# Managed file -> weight the game uses it for.
SLOTS = {
    "Roboto-Light.ttf": 300, "Roboto-Regular.ttf": 400, "Roboto-Medium.ttf": 500, "Roboto-Bold.ttf": 700,
    "Montserrat-Regular.ttf": 400, "Montserrat-Medium.ttf": 500, "Montserrat-SemiBold.ttf": 600,
    "Montserrat-Bold.ttf": 700, "Montserrat-ExtraBold.ttf": 800,
    "Oswald-Light_0.ttf": 300, "Oswald-Regular_0.ttf": 400, "Oswald-Bold_0.ttf": 700,
}
# id, menu name, {weight: source}. A source is ("stock", file), ("static", path) or ("vf", path, axes).
FONTS = [
    ("original", "Original", None),
    ("roboto", "Roboto", {300: ("stock", "Roboto-Light.ttf"), 400: ("stock", "Roboto-Regular.ttf"),
                          500: ("stock", "Roboto-Medium.ttf"), 700: ("stock", "Roboto-Bold.ttf")}),
    ("montserrat", "Montserrat", {w: ("stock", f) for f, w in SLOTS.items() if f.startswith("Montserrat")}),
    ("oswald", "Oswald", {w: ("stock", f) for f, w in SLOTS.items() if f.startswith("Oswald")}),
    ("robotomono", "Roboto Mono", {400: ("stock", "RobotoMono-Regular.ttf")}),
    ("permanentmarker", "Permanent Marker", {400: ("stock", "GoogleFonts/PermanentMarker.ttf")}),
    ("rocksalt", "Rock Salt", {400: ("stock", "GoogleFonts/RockSalt.ttf")}),
    ("calligraffitti", "Calligraffitti", {400: ("stock", "GoogleFonts/Calligraffitti-Regular.ttf")}),
    ("inter", "Inter", {w: ("vf", "inter/Inter-VF.ttf", {"wght": w, "opsz": 14}) for w in (300, 400, 500, 600, 700, 800)}),
    ("barlow", "Barlow", {w: ("static", f"barlow/Barlow-{n}.ttf") for w, n in
                          ((300, "Light"), (400, "Regular"), (500, "Medium"), (600, "SemiBold"), (700, "Bold"), (800, "ExtraBold"))}),
    ("exo2", "Exo 2", {w: ("vf", "exo2/Exo2-VF.ttf", {"wght": w}) for w in (300, 400, 500, 600, 700, 800)}),
    ("titilliumweb", "Titillium Web", {w: ("static", f"titilliumweb/TitilliumWeb-{n}.ttf") for w, n in
                                       ((300, "Light"), (400, "Regular"), (600, "SemiBold"), (700, "Bold"))}),
    ("opensans", "Open Sans", {w: ("vf", "opensans/OpenSans-VF.ttf", {"wght": w, "wdth": 100}) for w in (300, 400, 500, 600, 700, 800)}),
]
# Only fonts whose licence allows redistribution (Apache-2.0 or OFL-1.1, checked below):
# the stock ROSA Verde is commercial and stays out.
LICENSE_TEXTS = {"Apache-2.0": "Apache-2.0.txt", "OFL-1.1": "OFL-1.1.txt"}
LICENSES = {"inter": "inter", "barlow": "barlow", "exo2": "exo2", "titilliumweb": "titilliumweb", "opensans": "opensans"}
# Latin, Latin Extended, Greek, Cyrillic, punctuation, currency, letterlike, arrows, maths, shapes.
UNICODES = [*range(0x20, 0x250), *range(0x370, 0x400), *range(0x400, 0x530), *range(0x1e00, 0x1f00),
            *range(0x2000, 0x2070), *range(0x20a0, 0x20d0), *range(0x2100, 0x2200), *range(0x2190, 0x2200),
            *range(0x2200, 0x2300), *range(0x25a0, 0x2600), 0xfeff, 0xfffd]


def nearest(weights, wanted):
    return min(weights, key=lambda w: (abs(w - wanted), -w))


def extra_bytes(google, source):
    path = os.path.join(google, source[1])
    font = TTFont(path)
    if source[0] == "vf":
        font = instantiateVariableFont(font, source[2], updateFontNames=True)
    options = Options()
    options.layout_features = ["*"]
    options.name_IDs = ["*"]
    options.notdef_outline = True
    subsetter = Subsetter(options)
    subsetter.populate(unicodes=UNICODES)
    subsetter.subset(font)
    out = io.BytesIO()
    font.save(out)
    return out.getvalue()


def cap_height(font):
    """Height of a capital H over the em, so the launcher can draw every font at the same size."""
    pen = BoundsPen(font.getGlyphSet())
    font.getGlyphSet()[font.getBestCmap()[ord("H")]].draw(pen)
    return round(pen.bounds[3] / font["head"].unitsPerEm, 4)


def family(slot):
    return slot.split("-")[0].lower()  # roboto, montserrat, oswald


def reserved_name(data):
    return "reserved font name" in (TTFont(io.BytesIO(data))["name"].getDebugName(0) or "").lower()


# A line of the game's own texts, to compare how wide two fonts set it.
WIDTH_SAMPLE = "PRESS ANY KEY Squad Victory Royale Bandage 0123456789"
# A title may come out this much wider than the stock font before it is scaled down.
WIDTH_ALLOWANCE = 1.15


def metrics(font):
    upm = font["head"].unitsPerEm
    cmap, hmtx, hhea, os2 = font.getBestCmap(), font["hmtx"], font["hhea"], font["OS/2"]
    width = sum(hmtx[cmap[ord(c)]][0] for c in WIDTH_SAMPLE if ord(c) in cmap) / upm
    return {"cap": cap_height(font), "width": width, "ascent": hhea.ascent / upm, "descent": -hhea.descent / upm,
            "gap": hhea.lineGap / upm, "winAscent": os2.usWinAscent / upm, "winDescent": os2.usWinDescent / upm}


def fit(data, target):
    """The font at the stock font's size: same capital height (narrowed if it would set titles
    much wider) and the stock line metrics. Only the em changes, so outlines, advances and
    kerning scale together and nothing is redrawn."""
    font = TTFont(io.BytesIO(data))
    source = metrics(font)
    scale = min(target["cap"] / source["cap"], WIDTH_ALLOWANCE * target["width"] / source["width"])
    upm = round(font["head"].unitsPerEm / scale)
    assert 16 <= upm <= 16384, upm
    font["head"].unitsPerEm = upm
    # The game sets text on the baseline: capitals made smaller than the stock ones (a wide
    # font narrowed to fit) would sit low. Move the baseline up by half the difference so
    # they stay centred where the stock capitals are; the line height does not change.
    shift = (target["cap"] - source["cap"] * scale) / 2
    hhea, os2 = font["hhea"], font["OS/2"]
    hhea.ascent = round((target["ascent"] - shift) * upm)
    hhea.descent = -round((target["descent"] + shift) * upm)
    hhea.lineGap = round(target["gap"] * upm)
    os2.sTypoAscender, os2.sTypoDescender, os2.sTypoLineGap = hhea.ascent, hhea.descent, hhea.lineGap
    os2.usWinAscent = round((target["winAscent"] - shift) * upm)
    os2.usWinDescent = round((target["winDescent"] + shift) * upm)
    out = io.BytesIO()
    font.save(out)
    result = metrics(TTFont(io.BytesIO(out.getvalue())))
    assert result["cap"] <= target["cap"] * 1.01 and result["width"] <= target["width"] * WIDTH_ALLOWANCE * 1.01, result
    centre, stock_centre = result["ascent"] - result["cap"] / 2, target["ascent"] - target["cap"] / 2
    assert abs(centre - stock_centre) < 0.003, (centre, stock_centre)
    assert abs(result["ascent"] + result["descent"] - target["ascent"] - target["descent"]) < 0.003, result
    return out.getvalue()


def licence(font):
    names = font["name"]
    text = " ".join(filter(None, (names.getDebugName(13), names.getDebugName(14)))).lower()
    if "apache" in text:
        return "Apache-2.0"
    if "open font license" in text or "scripts.sil.org/ofl" in text or "openfontlicense" in text:
        return "OFL-1.1"
    raise AssertionError(f"{names.getDebugName(4)}: no redistributable licence ({text[:80]})")


def main(stock, google, out):
    assert not os.path.exists(out) or not os.listdir(out), f"{out} must be empty"
    files, fonts = {}, []

    def put(relative, data):
        path = os.path.join(out, relative)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        open(path, "wb").write(data)
        files[relative] = hashlib.sha256(data).hexdigest()
        return relative

    for slot in SLOTS:
        put(f"original/{slot}", open(os.path.join(stock, slot), "rb").read())
    targets = {family(slot): metrics(TTFont(os.path.join(stock, slot)))
               for slot in ("Roboto-Regular.ttf", "Montserrat-Regular.ttf", "Oswald-Regular_0.ttf")}
    for font_id, name, weights in FONTS:
        if weights is None:
            slots = {slot: f"original/{slot}" for slot in SLOTS}
        else:
            sources = {}
            for weight, source in weights.items():
                if source[0] == "stock":
                    sources[weight] = (source[1], open(os.path.join(stock, source[1]), "rb").read())
                else:
                    sources[weight] = (None, extra_bytes(google, source))
            slots = {}
            for slot, wanted in SLOTS.items():
                weight = nearest(sources, wanted)
                stock_name, data = sources[weight]
                if stock_name in SLOTS and family(stock_name) == family(slot):
                    slots[slot] = f"original/{stock_name}"  # the slot's own stock font
                else:
                    # OFL: a modified font may not keep a Reserved Font Name (Lato, Finger Paint),
                    # and every font is resized to the stock size, so such fonts stay out.
                    assert not reserved_name(data), f"{font_id}: Reserved Font Name, it cannot be resized"
                    relative = f"{font_id}/{family(slot)}-{weight}.ttf"
                    slots[slot] = relative if relative in files else put(relative, fit(data, targets[family(slot)]))
        body = TTFont(os.path.join(out, slots["Roboto-Regular.ttf"]))
        cmap = body.getBestCmap()
        fonts.append({"id": font_id, "name": name, "cyrillic": all(c in cmap for c in (0x416, 0x44F)),
                      "capHeight": cap_height(body), "slots": slots})
        if font_id in LICENSES:
            shutil.copyfile(os.path.join(google, LICENSES[font_id], "OFL.txt"), os.path.join(out, font_id, "OFL.txt"))
    notices = ["Fonts shipped in this folder, their copyright and licence (full texts below).", ""]
    for relative in sorted(files):
        font = TTFont(os.path.join(out, relative))
        notices.append(f"{relative}: {font['name'].getDebugName(4)}. {font['name'].getDebugName(0)} Licence: {licence(font)}.")
    here = os.path.join(os.path.dirname(__file__), "font-licenses")
    for name, text in LICENSE_TEXTS.items():
        notices += ["", "=" * 70, name, "=" * 70, open(os.path.join(here, text), encoding="utf-8").read()]
    open(os.path.join(out, "FONT-LICENSES.txt"), "w", encoding="utf-8", newline="\n").write("\n".join(notices))
    manifest = {"version": 1, "slots": list(SLOTS), "fonts": fonts, "files": dict(sorted(files.items()))}
    open(os.path.join(out, "manifest.json"), "w", newline="\n").write(json.dumps(manifest, indent=2) + "\n")
    total = sum(os.path.getsize(os.path.join(out, f)) for f in files)
    print(f"{len(fonts)} fonts, {len(files)} files, {total // 1024} KiB -> {out}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], os.path.join(os.path.dirname(__file__), "..", "resources", "fonts"))
