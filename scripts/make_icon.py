#!/usr/bin/env python3
"""Convierte una imagen (PNG/JPG) en assets/icon.ico con 16, 32, 48, 64, 128 y 256 px.

Uso:
    python scripts/make_icon.py                       # assets/icon-source.png -> assets/icon.ico
    python scripts/make_icon.py origen.png salida.ico
    python scripts/make_icon.py --fit pad             # rellena en vez de recortar al centro

Requiere Pillow: pip install pillow
"""
import argparse
import os
import sys

from PIL import Image

SIZES = [16, 32, 48, 64, 128, 256]


def to_square(img: Image.Image, mode: str) -> Image.Image:
    w, h = img.size
    if mode == "pad":
        side = max(w, h)
        canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
        canvas.paste(img, ((side - w) // 2, (side - h) // 2))
        return canvas
    side = min(w, h)  # recorte centrado
    left, top = (w - side) // 2, (h - side) // 2
    return img.crop((left, top, left + side, top + side))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("source", nargs="?", default="assets/icon-source.png")
    ap.add_argument("output", nargs="?", default="assets/icon.ico")
    ap.add_argument("--fit", choices=["crop", "pad"], default="crop")
    args = ap.parse_args()

    if not os.path.isfile(args.source):
        print(f"No existe {args.source}", file=sys.stderr)
        return 1

    img = Image.open(args.source).convert("RGBA")
    img = to_square(img, args.fit)
    master = img.resize((256, 256), Image.LANCZOS)
    master.save(args.output, format="ICO", sizes=[(s, s) for s in SIZES])

    with Image.open(args.output) as ico:
        found = sorted(ico.info.get("sizes", []))
    print(f"{args.output}: {[s[0] for s in found]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
