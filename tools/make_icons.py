"""Draws the two Windows notification-area icons (menubar/energia.ico and
menubar/energia-over.ico): a lightning bolt, yellow, and red above a threshold.

Standard library only. Run again after changing the shape or the colours:
    python3 tools/make_icons.py
"""

import os
import struct

HERE = os.path.dirname(os.path.realpath(__file__))
SIZES = (16, 20, 24, 32, 48)  # the sizes Windows picks from, depending on the display scale
BOLT = [(0.62, 0.02), (0.16, 0.57), (0.45, 0.57), (0.36, 0.98), (0.84, 0.41), (0.55, 0.41)]
ICONS = {"energia.ico": (245, 179, 1), "energia-over.ico": (229, 72, 77)}
SAMPLES = 4  # per pixel and per axis, to smooth the edges


def inside(x, y, polygon):
    """Even-odd rule: is the point inside the polygon?"""
    hit = False
    for (x1, y1), (x2, y2) in zip(polygon, polygon[1:] + polygon[:1]):
        if (y1 > y) != (y2 > y) and x < x1 + (y - y1) * (x2 - x1) / (y2 - y1):
            hit = not hit
    return hit


def coverage(size):
    """For each pixel, the share of it covered by the bolt (0 to 1), top row first."""
    rows = []
    for py in range(size):
        row = []
        for px in range(size):
            hits = sum(inside((px + (i + 0.5) / SAMPLES) / size, (py + (j + 0.5) / SAMPLES) / size, BOLT)
                       for i in range(SAMPLES) for j in range(SAMPLES))
            row.append(hits / SAMPLES ** 2)
        rows.append(row)
    return rows


def image(size, colour):
    """One icon image: a 32-bit bitmap, bottom row first, followed by its transparency mask."""
    red, green, blue = colour
    rows = coverage(size)
    pixels = b"".join(bytes((blue, green, red, round(255 * alpha))) for row in reversed(rows) for alpha in row)
    mask_row = (size + 31) // 32 * 4
    mask = b""
    for row in reversed(rows):
        bits = bytearray(mask_row)
        for x, alpha in enumerate(row):
            if alpha == 0:
                bits[x // 8] |= 0x80 >> (x % 8)
        mask += bytes(bits)
    header = struct.pack("<IiiHHIIiiII", 40, size, 2 * size, 1, 32, 0, len(pixels) + len(mask), 0, 0, 0, 0)
    return header + pixels + mask


def icon(colour):
    images = [image(size, colour) for size in SIZES]
    out = struct.pack("<HHH", 0, 1, len(images))
    offset = 6 + 16 * len(images)
    for size, data in zip(SIZES, images):
        out += struct.pack("<BBBBHHII", size, size, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    return out + b"".join(images)


if __name__ == "__main__":
    for name, colour in ICONS.items():
        path = os.path.join(HERE, "..", "menubar", name)
        with open(path, "wb") as f:
            f.write(icon(colour))
        print(os.path.normpath(path))
