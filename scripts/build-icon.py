"""Render the desktop mark and its Windows icon sizes. Requires Pillow.

Geometry matches resources/deepblack-download.svg. Run from any directory.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
SCALE = 4
SIZE = 512 * SCALE


def points(values):
    return [(round(x * SCALE), round(y * SCALE)) for x, y in values]


def gradient(stops):
    image = Image.new('RGBA', (SIZE, SIZE))
    draw = ImageDraw.Draw(image)
    for y in range(SIZE):
        t = min(1, max(0, y / SCALE / 512))
        for (left, color_a), (right, color_b) in zip(stops, stops[1:]):
            if left <= t <= right:
                ratio = (t - left) / (right - left)
                color = tuple(round(a + (b - a) * ratio) for a, b in zip(color_a, color_b))
                draw.line([(0, y), (SIZE, y)], fill=color + (255,))
                break
    return image


def stroke(draw, coords, width, fill=255):
    xy = points(coords)
    w = round(width * SCALE)
    draw.line(xy, fill=fill, width=w, joint='curve')
    radius = w / 2
    for x, y in xy:
        draw.ellipse((round(x - radius), round(y - radius), round(x + radius), round(y + radius)), fill=fill)


mask = Image.new('L', (SIZE, SIZE))
ImageDraw.Draw(mask).rounded_rectangle((24*SCALE, 24*SCALE, 488*SCALE, 488*SCALE), radius=108*SCALE, fill=255)
icon = gradient([(0, (32, 45, 43)), (.5, (17, 25, 28)), (1, (9, 14, 19))])
icon.putalpha(mask)
draw = ImageDraw.Draw(icon)
draw.rounded_rectangle((26*SCALE, 26*SCALE, 486*SCALE, 486*SCALE), radius=106*SCALE, outline=(58, 76, 70, 255), width=3*SCALE)

arrow_mask = Image.new('L', (SIZE, SIZE))
arrow_draw = ImageDraw.Draw(arrow_mask)
stroke(arrow_draw, [(256, 132), (256, 310)], 40)
stroke(arrow_draw, [(164, 234), (256, 326), (348, 234)], 40)
arrow = gradient([(0, (139, 243, 200)), (132/512, (139, 243, 200)), (326/512, (61, 220, 151)), (1, (61, 220, 151))])
arrow.putalpha(arrow_mask)
icon.alpha_composite(arrow)

tray = [(142, 330), (142, 364)]
for step in range(1, 33):
    t = step / 32
    tray.append(((1-t)**2*142 + 2*(1-t)*t*142 + t*t*166,
                 (1-t)**2*364 + 2*(1-t)*t*388 + t*t*388))
tray.append((346, 388))
for step in range(1, 33):
    t = step / 32
    tray.append(((1-t)**2*346 + 2*(1-t)*t*370 + t*t*370,
                 (1-t)**2*388 + 2*(1-t)*t*388 + t*t*364))
tray.append((370, 330))
stroke(ImageDraw.Draw(icon), tray, 28, (142, 173, 164, 255))

png = ROOT / 'resources/deepblack-download.png'
ico = ROOT / 'build/deepblack-download.ico'
icon.resize((1024, 1024), Image.Resampling.LANCZOS).save(png)
icon.resize((256, 256), Image.Resampling.LANCZOS).save(
    ico, format='ICO', sizes=[(n, n) for n in (16, 20, 24, 32, 40, 48, 64, 128, 256)]
)

# A review sheet shows the actual desktop sizes on both dark and light surfaces.
preview = Image.new('RGB', (1000, 620), '#080C10')
pd = ImageDraw.Draw(preview)
pd.rounded_rectangle((24, 24, 590, 596), radius=28, fill='#10171C')
hero = icon.resize((420, 420), Image.Resampling.LANCZOS)
preview.paste(hero, (97, 70), hero)
font_path = Path('C:/Windows/Fonts/msyh.ttc')
font = ImageFont.truetype(str(font_path), 22) if font_path.exists() else ImageFont.load_default()
small = ImageFont.truetype(str(font_path), 16) if font_path.exists() else font
pd.text((307, 535), '深黑下载器', font=font, fill='#E8EDF5', anchor='mm')
pd.text((650, 55), 'DESKTOP SIZES', font=small, fill='#8EADA4')
for row, background in enumerate(('#141B22', '#E8EDF1')):
    top = 110 + row * 225
    pd.rounded_rectangle((620, top, 970, top + 195), radius=20, fill=background)
    x = 656
    for n in (64, 48, 32, 16):
        thumb = icon.resize((n, n), Image.Resampling.LANCZOS)
        preview.paste(thumb, (x, top + 50 + (64-n)//2), thumb)
        pd.text((x+n//2, top + 145), str(n), font=small, fill='#8B93A7' if row == 0 else '#465568', anchor='mm')
        x += 82
preview.save(ROOT / 'resources/deepblack-download-preview.png')

with Image.open(ico) as check:
    assert len(check.ico.sizes()) == 9
    assert (256, 256) in check.ico.sizes()
with Image.open(png) as check:
    assert check.mode == 'RGBA' and check.size == (1024, 1024)
    assert check.getpixel((0, 0))[3] == 0
print('Created PNG, ICO (9 sizes), and preview sheet.')
