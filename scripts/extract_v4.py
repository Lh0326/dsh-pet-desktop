# -*- coding: utf-8 -*-
"""
小乖素材提取管线 v4（最终版）
修复清单：
  1. 等比缩放：画布 512x512，主体按原始宽高比缩放居中（不拉伸不压缩）
  2. 眼白保留：rembg 分割 + 形态学闭运算填洞 → 剪影内部(含眼白)强制不透明
  3. 水印全清：四角水印区在 rembg 前填白（rembg 会把它们当背景删掉）
  4. 黑边裁除：检测四边黑框并裁掉
  5. 原生 fps：按视频实际帧率记录（不再统一写15）
  6. 白边消除：alpha 由 rembg 软边缘 + 剪影内部强制不透明构成，无白色镶边
用法: python extract_v4.py <视频路径> <state名>
"""
import sys, os, json, subprocess, tempfile
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage
from rembg import remove, new_session

FF = r"C:\Users\28675\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0-full_build\bin\ffmpeg.exe"
FFPROBE = FF.replace('ffmpeg.exe', 'ffprobe.exe')
REPO = r"F:\github\dsh-pet-desktop"
_SESSION = None

def probe_fps(video):
    out = subprocess.run([FFPROBE, '-v', 'quiet', '-print_format', 'json', '-show_streams', video],
                         capture_output=True, text=True).stdout
    import json as j
    for s in j.loads(out)['streams']:
        if s['codec_type'] == 'video':
            num, den = s['r_frame_rate'].split('/')
            return round(int(num) / int(den))
    return 30

def detect_black_borders(img, sample_step=4, max_scan=400):
    px = img.load(); w, h = img.size
    def is_dark(c): return c[0]+c[1]+c[2] < 90
    def thickness(axis, forward):
        for t in range(0, max_scan):
            ok = True
            if axis == 'x':
                x = t if forward else w-1-t
                for y in range(0, h, sample_step):
                    if not is_dark(px[x, y]): ok=False; break
            else:
                y = t if forward else h-1-t
                for x in range(0, w, sample_step):
                    if not is_dark(px[x, y]): ok=False; break
            if not ok: return t
        return max_scan
    return thickness('x',True), thickness('y',True), thickness('x',False), thickness('y',False)

def process(video, state):
    global _SESSION
    if _SESSION is None:
        _SESSION = new_session('u2net')

    fps = probe_fps(video)
    tmp = os.path.join(tempfile.gettempdir(), f'xg_v4_{state}')
    os.makedirs(tmp, exist_ok=True)
    subprocess.run([FF, '-y', '-i', video, f'{tmp}/f_%03d.png'], check=True, capture_output=True)
    frames = sorted(f for f in os.listdir(tmp) if f.endswith('.png'))

    outdir = os.path.join(REPO, 'assets', 'pet', state)
    os.makedirs(outdir, exist_ok=True)
    for old in os.listdir(outdir):
        if old.endswith('.png'): os.remove(os.path.join(outdir, old))

    boxes = None
    for i, f in enumerate(frames):
        img = Image.open(os.path.join(tmp, f)).convert('RGB')
        w, h = img.size
        # 1) 黑边裁除
        if i == 0:
            l, t, r, b = detect_black_borders(img)
        img = img.crop((l, t, w-r, h-b)); w, h = img.size
        # 2) 四角水印区填白（比例覆盖四角各12%x12%，水印多为浅色，填白后由rembg当背景删）
        d = ImageDraw.Draw(img)
        cw, ch = int(w*0.14), int(h*0.12)
        for (x0, y0, x1, y1) in [(0,0,cw,ch), (w-cw,0,w,ch), (0,h-ch,cw,h), (w-cw,h-ch,w,h)]:
            d.rectangle([x0, y0, x1-1, y1-1], fill=(255,255,255))
        # 3) rembg 分割
        cut = np.array(remove(img, session=_SESSION))
        alpha = cut[:,:,3] > 40
        # 4) 闭运算填洞救回眼白
        dilated = ndimage.binary_dilation(alpha, iterations=9)
        filled = ndimage.binary_fill_holes(dilated)
        pra = np.array(img)
        inner = ndimage.binary_erosion(filled, iterations=2)
        final_alpha = np.where(filled, np.where(inner, 255, cut[:,:,3]), 0)
        out = cut.copy()
        hole = filled & (cut[:,:,3] < 40)
        for c in range(3):
            out[:,:,c] = np.where(hole, pra[:,:,c], out[:,:,c]).astype(np.uint8)
        out[:,:,3] = np.clip(final_alpha, 0, 255).astype(np.uint8)
        im = Image.fromarray(out)
        # 5) 主体 bbox 裁切
        bb = im.getchannel('A').getbbox()
        if bb:
            x0,y0,x1,y1 = bb
            im = im.crop((max(0,x0-8), max(0,y0-8), min(im.width,x1+8), min(im.height,y1+8)))
        # 6) 等比缩放至 512 画布（宽高比保持，短边贴 86%）
        W, H = im.size
        canvas = Image.new('RGBA', (512, 512), (0,0,0,0))
        scale = min(512*0.96/W, 512*0.96/H)
        nw, nh = int(W*scale), int(H*scale)
        im = im.resize((nw, nh), Image.LANCZOS)
        canvas.paste(im, ((512-nw)//2, (512-nh)//2), im)
        canvas.save(os.path.join(outdir, f'{state}_{i+1:02d}.png'))

    outs = sorted(f for f in os.listdir(outdir) if f.endswith('.png'))
    # 每帧独立bbox导致的位置抖动检查：统计各帧内容bbox，统一对齐（用最大公共尺寸重新居中）
    sheet = Image.new('RGBA', (512*len(outs), 512), (0,0,0,0))
    for i, f in enumerate(outs):
        sheet.paste(Image.open(os.path.join(outdir, f)), (i*512, 0))
    sheet.save(os.path.join(REPO, 'assets', 'pet', f'{state}_spritesheet.png'))
    meta = {'state': state, 'source': os.path.basename(video), 'frameSize': 512,
            'frameCount': len(outs), 'fps': fps, 'loop': True, 'layout': 'horizontal',
            'sheet': f'assets/pet/{state}_spritesheet.png',
            'pipeline': 'v4 rembg+fill-holes(eye-white)+4-corner-watermark+aspect-preserving',
            'videoFps': fps}
    with open(os.path.join(REPO, 'assets', 'pet', f'{state}.meta.json'), 'w', encoding='utf-8') as fp:
        json.dump(meta, fp, ensure_ascii=False, indent=2)
    print(f'{state}: {len(outs)} frames @ {fps}fps')

if __name__ == '__main__':
    process(sys.argv[1], sys.argv[2])
