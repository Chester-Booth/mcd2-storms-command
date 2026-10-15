"""Build the shared pixel palette and font masks. Requires Pillow only when changing artwork."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import base64, json

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / 'assets/icons'
FONTS = ROOT / 'assets/fonts'
W, H = 560, 744
colours = ['#10323e', '#183e4c', '#0a202b', '#07151b', '#284552', '#426e7e', '#86a6b1', '#f4fbfc', '#74ddd3', '#9bb3bb', '#132630', '#0c1f28', '#31535d', '#58d4cd', '#10222b']
icons = {p.stem: Image.open(p).convert('RGBA') for p in sorted(ICONS.glob('*.png'))}
samples = Image.new('RGB', (512, 512), '#10323e')
y = 0
for icon in icons.values():
 samples.paste(icon.convert('RGB').resize((100, 64)), (0, y)); y += 64
# Reserve shades for antialiased text on the panel backgrounds.
base_palette = [(0, 0, 0)] + [tuple(bytes.fromhex(colour[1:])) for colour in colours]
font_shades = []
for foreground in [8, 9, 10]:
 for background_index in [1, 2, 4, 6, 11, 12]:
  for alpha in [1/3, 2/3]:
   font_shades.append(tuple(round(bg*(1-alpha)+fg*alpha) for bg,fg in zip(base_palette[background_index],base_palette[foreground])))
quant = samples.quantize(colors=256-len(base_palette)-len(font_shades))
palette = [channel for rgb in base_palette+font_shades for channel in rgb]
palette += quant.getpalette()[:768-len(palette)]
palette += [0] * (768-len(palette))
# The renderer blends glyph coverage with the pixel already behind it.
blend = {}
for foreground in [8, 9, 10]:
 ramp = []
 for background_index in range(256):
  bg = palette[background_index*3:background_index*3+3]
  fg = palette[foreground*3:foreground*3+3]
  for coverage in range(4):
   target = [round(b*(1-coverage/3)+f*coverage/3) for b,f in zip(bg,fg)]
   nearest = min(range(256),key=lambda i:sum((palette[i*3+c]-target[c])**2 for c in range(3)))
   ramp.append(nearest)
 blend[str(foreground)] = base64.b64encode(bytes(ramp)).decode()
palette_image = Image.new('P', (1, 1)); palette_image.putpalette(palette)

# Index 0 marks transparent sprite pixels. All sprites share the background palette.
def encode(im, transparent=False):
 rgba = im.convert('RGBA')
 indexed = rgba.convert('RGB').quantize(palette=palette_image, dither=Image.Dither.NONE)
 data = bytearray(indexed.tobytes())
 if transparent:
  for i, alpha in enumerate(rgba.getchannel('A').tobytes()):
   if alpha < 100: data[i] = 0
 return {'w': im.width, 'h': im.height, 'pixels': base64.b64encode(data).decode()}

# Bake the fixed panels once; the Worker only draws text, icons and the countdown.
background = Image.new('RGB', (W, H), colours[0])
d = ImageDraw.Draw(background)
for y in range(0, H, 70):
 for x in range(0, W, 70):
  if (x//70+y//70)%3 == 0: d.rectangle((x,y,x+69,y+69),fill=colours[1])
d.rectangle((1,1,W-2,H-2),outline=colours[4],width=2)
d.rectangle((14,14,545,53),fill=colours[5]); d.line((14,14,545,14),fill=colours[6],width=2)
d.rectangle((14,68,545,239),fill=colours[3],outline=colours[4])
d.rectangle((14,253,545,708),fill=colours[3])
for i in range(7): d.rectangle((22,261+i*63,537,318+i*63),fill=colours[10 if i%2==0 else 11])
fonts = {}
# Render each font at its final output size. Scaling small glyphs changes their outlines.
for name, path, size in [('title','minecraft-ten.woff2',24),('hero','minecraft-ten.woff2',40),('time','minecraft-ten.woff2',24),('body','minecraft-sixteen.woff2',18),('small','minecraft-sixteen.woff2',14)]:
 font = ImageFont.truetype(str(FONTS/path),size)
 glyphs = {}
 for char in ''.join(chr(i) for i in range(32,127))+'·':
  width=max(1,round(font.getlength(char)))
  mask=Image.new('L',(width,size+10))
  ImageDraw.Draw(mask).text((0,0),char,font=font,fill=255,anchor='la')
  bbox=mask.getbbox() or (0,0,0,0)
  glyphs[char]={'w':mask.width,'h':mask.height,'top':bbox[1],'bottom':bbox[3],'baseline':font.getmetrics()[0],'pixels':base64.b64encode(bytes(min(3,(v+42)//85) for v in mask.tobytes())).decode()}
 fonts[name]=glyphs
sprites={}
for name,icon in icons.items():
 size=(100,110) if name=='soulstorm' else (40,40)
 sprites[name]=encode(icon.resize(size,Image.Resampling.NEAREST),True)
result={'width':W,'height':H,'blend':blend,'palette':base64.b64encode(bytes(palette)).decode(),'background':encode(background)['pixels'],'sprites':sprites,'fonts':fonts}
# Keep this output in Git so deploying needs Node and Wrangler, without Python or Pillow.
(ROOT/'src/generated').mkdir(parents=True, exist_ok=True)
(ROOT/'src/generated/art.json').write_text(json.dumps(result,separators=(',',':'))+'\n')
