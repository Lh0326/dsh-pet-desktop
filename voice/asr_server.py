# -*- coding: utf-8 -*-
"""
小乖语音识别服务 v2 (SeCo-Paraformer + 热词)
- 模型: paraformer-large 系(识别精度优于SenseVoiceSmall,"精简"等词不再错)
- 热词: hotwords.txt(GBK编码——funasr按系统ANSI读取), 每行"词 权重"
- POST /asr {audio_wav: base64} -> {text}
- 端口 9340, 仅127.0.0.1
"""
from funasr import AutoModel
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
import base64, json, tempfile, os, re, sys

# 热词文件(GBK!funasr在Windows按ANSI读)——不存在则自动生成默认
HOTWORD_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'hotwords.txt')
if not os.path.exists(HOTWORD_PATH):
    with open(HOTWORD_PATH, 'w', encoding='gbk') as f:
        f.write('小乖 30\n桌宠 25\n精简 20\n语音 15\n识别 15\n优化 15\n'
                '插件 15\n皮肤 15\n拖拽 15\n投喂 15\n摸头 15\n'
                'DeepSeek 20\ndsh 20\n代理 10\n端口 10\n重启 10\n')

print('[xg-asr] loading SeCo-Paraformer...', flush=True)
model = AutoModel(
    model='iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch',
    trust_remote_code=True,
    disable_update=True,
)
print('[xg-asr] model ready', flush=True)

# 诊断: 最近20条识别结果(唤醒排查用,经/diag/asr暴露)
__recent = []
def recent_texts():
    return __recent[-20:]

def clean(text: str) -> str:
    # paraformer输出带字间空格 -> 中文邻接的空格删除(英文单词间距保留)
    out = []
    for i, ch in enumerate(text):
        if ch == ' ' and 0 < i < len(text) - 1:
            prev, nxt = text[i-1], text[i+1]
            if ('一' <= prev <= '鿿') or ('一' <= nxt <= '鿿') or prev in '，。！？、':
                continue
        out.append(ch)
    return re.sub(r'<\|[^|]*\|>', '', ''.join(out)).strip()

class H(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != '/asr':
            self.send_response(404); self.end_headers(); return
        body = self.rfile.read(int(self.headers.get('content-length', 0)))
        try:
            req = json.loads(body)
            raw = base64.b64decode(req.get('audio_wav', ''))
        except Exception:
            out = json.dumps({'error': 'bad-request'}).encode()
            self.send_response(400)
            self.send_header('content-length', str(len(out)))
            self.end_headers(); self.wfile.write(out); return
        with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as f:
            f.write(raw); tmp = f.name
        try:
            try:
                res = model.generate(input=tmp, cache={}, hotword=HOTWORD_PATH)
                text = clean(res[0]['text']) if res else ''
                __recent.append({'t': __import__('time').strftime('%H:%M:%S'), 'text': text, 'bytes': len(raw)})
                del __recent[:-20]
            except Exception:
                import traceback; traceback.print_exc()
                text = ''
        finally:
            try: os.unlink(tmp)
            except OSError: pass
        out = json.dumps({'text': text}, ensure_ascii=False).encode()
        self.send_response(200)
        self.send_header('content-type', 'application/json; charset=utf-8')
        self.send_header('content-length', str(len(out)))
        self.end_headers(); self.wfile.write(out)
    def log_message(self, *a): pass

if __name__ == '__main__':
    print('[xg-asr] serving on 127.0.0.1:9340 (seaco-paraformer + hotwords)', flush=True)
    ThreadingHTTPServer(('127.0.0.1', 9340), H).serve_forever()
