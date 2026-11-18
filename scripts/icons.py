"""Regenera os ícones PNG com Pillow (somente para alterações de identidade)."""
from PIL import Image, ImageDraw
from pathlib import Path
for filename, size, safe in [('icon-180',180,False),('icon-192',192,False),('icon-512',512,False),('icon-maskable',512,True)]:
    im=Image.new('RGB',(1024,1024),'#091c36')
    d=ImageDraw.Draw(im)
    for i,(x,y) in enumerate([(223,659),(379,549),(535,423),(691,293)]):
        d.rounded_rectangle((x,y,x+101,799),radius=21,fill=['#45d9ed','#27cbdf','#f4c04d','#ffc951'][i])
    d.line([(217,554),(381,418),(500,457),(763,223)],fill='#5ae6f0',width=43,joint='curve')
    d.polygon([(620,222),(795,184),(762,357)],fill='#5ae6f0')
    if safe:
        out=Image.new('RGB',im.size,'#091c36');out.paste(im.resize((820,820),Image.Resampling.LANCZOS),(102,102));im=out
    im.resize((size,size),Image.Resampling.LANCZOS).save(Path('public')/(filename+'.png'))
# Telas de abertura do iOS por resolução lógica e densidade.
from PIL import ImageFont
splash=Path('public/splash')
splash.mkdir(exist_ok=True)
# A mesma arte serve às duas orientações de cada classe de tela.
devices=[(375,667,2),(375,812,3),(390,844,3),(393,852,3),(402,874,3),(414,896,2),(414,896,3),(428,926,3),(430,932,3),(440,956,3),(768,1024,2),(820,1180,2),(834,1194,2),(1024,1366,2)]
links=[]
for w,h,density in devices:
    for orientation in ['portrait','landscape']:
        width,height=(w*density,h*density) if orientation=='portrait' else (h*density,w*density)
        canvas=Image.new('RGB',(width,height),'#091c36')
        mark=Image.open('public/icon-512.png').resize((86*density,86*density),Image.Resampling.LANCZOS)
        canvas.paste(mark,((width-mark.width)//2,(height-mark.height)//2))
        name=f'{width}x{height}.png'
        canvas.save(splash/name,optimize=True)
        links.append(f'<link rel="apple-touch-startup-image" media="(device-width: {w}px) and (device-height: {h}px) and (-webkit-device-pixel-ratio: {density}) and (orientation: {orientation})" href="/splash/{name}">')
html=Path('index.html').read_text()
import re
html=re.sub(r'<link rel="apple-touch-startup-image"[^>]*>\s*','',html)
Path('index.html').write_text(html.replace('</head>','\n'+'\n'.join(links)+'\n</head>'))
