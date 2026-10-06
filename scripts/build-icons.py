#!/usr/bin/env python3
"""Render the geometric design in native/assets/RemoteControl.svg (requires Pillow)."""
import os
from pathlib import Path
import subprocess
import tempfile
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / 'native' / 'assets'
ASSETS.mkdir(parents=True, exist_ok=True)
SCALE = 2
SIZE = 1024 * SCALE
image = Image.new('RGBA', (SIZE, SIZE))
pixels = image.load()
for y in range(SIZE):
    for x in range(SIZE):
        t = max(0, min(1, ((x / SCALE - 80) + (y / SCALE - 80)) / 1728))
        pixels[x, y] = tuple(round(a + (b - a) * t) for a, b in zip((23, 54, 89), (8, 24, 47))) + (255,)
mask = Image.new('L', image.size)
ImageDraw.Draw(mask).rounded_rectangle(tuple(v * SCALE for v in (80, 80, 944, 944)), radius=196 * SCALE, fill=255)
image.putalpha(mask)
draw = ImageDraw.Draw(image)
cyan, blue, mint = '#62dcdf', '#83cfff', '#63ebc1'
# Center the monitor outline on the SVG's 36px stroke.
draw.rounded_rectangle(tuple(v * SCALE for v in (218, 258, 806, 656)), radius=66 * SCALE, outline=cyan, width=36 * SCALE)
def line(points, color, width):
    coords = [(x * SCALE, y * SCALE) for x, y in points]
    draw.line(coords, fill=color, width=width * SCALE, joint='curve')
    radius = width * SCALE / 2
    for x, y in coords:
        draw.ellipse((x-radius, y-radius, x+radius, y+radius), fill=color)
line([(512, 650), (512, 730)], cyan, 36)
line([(404, 730), (620, 730)], cyan, 36)
line([(350, 394), (674, 394)], blue, 34)
line([(622, 342), (674, 394), (622, 446)], blue, 34)
line([(674, 522), (350, 522)], mint, 34)
line([(402, 470), (350, 522), (402, 574)], mint, 34)
image = image.resize((1024, 1024), Image.Resampling.LANCZOS)
image.save(ASSETS / 'RemoteControl.png')
image.save(ASSETS / 'RemoteControl.ico', sizes=[(16,16), (24,24), (32,32), (48,48), (64,64), (128,128), (256,256)])
with tempfile.TemporaryDirectory(prefix='remotecontrol-icons-', dir=os.environ.get('PI_SCRATCH_DIR')) as temp:
    iconset = Path(temp) / 'RemoteControl.iconset'
    iconset.mkdir()
    for size in (16, 32, 128, 256, 512):
        for multiplier in (1, 2):
            pixels = size * multiplier
            suffix = '@2x' if multiplier == 2 else ''
            image.resize((pixels, pixels), Image.Resampling.LANCZOS).save(iconset / f'icon_{size}x{size}{suffix}.png')
    subprocess.run(['iconutil', '-c', 'icns', str(iconset), '-o', str(ASSETS / 'RemoteControl.icns')], check=True)
print('Generated RemoteControl.png, RemoteControl.ico, RemoteControl.icns')
