# -*- coding: utf-8 -*-
"""
小乖素材提取管线 v2（通用版）
用法: python extract_pet_assets.py <视频路径> <state名>
流程: 抽帧(全帧) → 水印区填白 → 白底转透明 → 主体裁切 → 512归一 → 单帧+精灵图+meta
水印区默认右下角 (1750,950)-(1920,1080)（1920x1080 源），按比例自适应其他分辨率。
"""
import sys, os, json, subprocess, tempfile
from PIL import Image, ImageDraw

FF = r"C:\Users\28675\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0-full_build\bin\ffmpeg.exe"
REPO = r"F:\github\dsh-pet-desktop"

def extract_frames(video, outdir):
    os.makedirs(outdir, exist_ok=True)
    subprocess.run([FF, '-y', '-i', video, '-vf', 'scale=960:540', f'{outdir}/f_%03d.png'],
                   check=True, capture_output=True)
    return sorted(f for f in os.listdir(outdir) if f.endswith('.png'))

def wm_box_frac():
    # 检测到的水印区(1920x1080): 1750-1920 x 950-1080 → 比例
    return (1750/1920, 950/1080, 1.0, 1.0)

def remove_white(img, thresh=232):
    img = img.convert('RGBA')
    px = img.load()
    w, h = img.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            m = min(r, g, b)
            if r > thresh and g > thresh and b > thresh:
                px[x, y] = (r, g, b, 0)
            elif m > 200:
                t = (m - 200) / (thresh - 200)
                px[x, y] = (r, g, b, int(255 * (1 - t)))
    return img

def normalize(img, size=512, fill=0.86):
    canvas = Image.new('RGBA', (size, size), (0,0,0,0))
    target_h = int(size * fill)
    ratio = target_h / img.height
    nw = int(img.width * ratio)
    if nw > size:
        ratio = size / img.width
        nh = int(img.height * ratio)
        im = img.resize((size, nh), Image.LANCZOS)
    else:
        im = img.resize((nw, target_h), Image.LANCZOS)
    canvas.paste(im, ((size-im.width)//2, (size-im.height)//2), im)
    return canvas

def process(video, state):
    tmp = os.path.join(tempfile.gettempdir(), f'xg_pipe_{state}')
    frames = extract_frames(video, tmp)
    outdir = os.path.join(REPO, 'assets', 'pet', state)
    os.makedirs(outdir, exist_ok=True)
    bx0, by0, bx1, by1 = wm_box_frac()
    for i, f in enumerate(frames):
        img = Image.open(os.path.join(tmp, f)).convert('RGB')
        w, h = img.size
        d = ImageDraw.Draw(img)
        d.rectangle([int(w*bx0), int(h*by0), int(w*bx1)-1, int(h*by1)-1], fill=(255,255,255))
        img = remove_white(img)
        bbox = img.getchannel('A').getbbox()
        if bbox:
            x0,y0,x1,y1 = bbox
            img = img.crop((max(0,x0-12), max(0,y0-12), min(img.width,x1+12), min(img.height,y1+12)))
        normalize(img).save(os.path.join(outdir, f'{state}_{i+1:02d}.png'))
    # 精灵图
    outs = sorted(f for f in os.listdir(outdir) if f.endswith('.png'))
    sheet = Image.new('RGBA', (512*len(outs), 512), (0,0,0,0))
    for i, f in enumerate(outs):
        sheet.paste(Image.open(os.path.join(outdir, f)), (i*512, 0))
    sheet.save(os.path.join(REPO, 'assets', 'pet', f'{state}_spritesheet.png'))
    meta = {'state': state, 'source': os.path.basename(video), 'frameSize': 512,
            'frameCount': len(outs), 'fps': 15, 'loop': True, 'layout': 'horizontal',
            'sheet': f'assets/pet/{state}_spritesheet.png',
            'pipeline': 'v2 watermark-fill + white-removal + crop + normalize'}
    with open(os.path.join(REPO, 'assets', 'pet', f'{state}.meta.json'), 'w', encoding='utf-8') as fp:
        json.dump(meta, fp, ensure_ascii=False, indent=2)
    print(f'{state}: {len(outs)} frames OK')

if __name__ == '__main__':
    process(sys.argv[1], sys.argv[2])
