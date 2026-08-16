# -*- coding: utf-8 -*-
"""
小乖语音识别服务(FunASR/SenseVoice, 本地HTTP)
POST /asr  {audio_wav: base64}  ->  {text}
端口 9340, 仅监听127.0.0.1
"""
from funasr import AutoModel
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
import base64, json, tempfile, os, sys

print('[xg-asr] loading SenseVoice...', flush=True)
model = AutoModel(
    model='iic/SenseVoiceSmall',
    trust_remote_code=True,
    disable_update=True,
    # 6060/int8 量化加速(4060可用);不可用时自动回退
)
print('[xg-asr] model ready', flush=True)

class H(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != '/asr':
            self.send_response(404); self.end_headers(); return
        body = self.rfile.read(int(self.headers['content-length']))
        try:
            req = json.loads(body)
            wav_b64 = req.get('audio_wav', '')
            raw = base64.b64decode(wav_b64)
        except Exception:
            out = json.dumps({'error': 'bad-request'}).encode()
            self.send_response(400)
            self.send_header('content-length', str(len(out)))
            self.end_headers()
            self.wfile.write(out)
            return
        with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as f:
            f.write(raw); tmp = f.name
        try:
            try:
                res = model.generate(input=tmp, cache={}, language='zh', use_itn=True)
                text = res[0]['text'] if res else ''
                import re as _re
                text = _re.sub(r'<\|[^|]*\|>', '', text).strip()
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
        self.end_headers()
        self.wfile.write(out)
    def log_message(self, *a): pass

print('[xg-asr] serving on 127.0.0.1:9340', flush=True)
ThreadingHTTPServer(('127.0.0.1', 9340), H).serve_forever()
