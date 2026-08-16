# -*- coding: utf-8 -*-
"""
小乖唤醒词监听服务 v2 (本地onnx微模型, 常驻CPU<1%)
- 流式: 麦克风80ms块→openWakeWord特征→16帧滑窗→onnx打分
- POST /wake  {audio_wav16k_mono: base64}  → {score}
  (客户端按块推送或整段;轻量化:客户端做音量门限,过阈才发)
- 阈值建议: score>0.85 判唤醒
端口 9341, 仅127.0.0.1
"""
import os, json, base64, tempfile, wave, io
import numpy as np
import onnxruntime as ort
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from openwakeword.utils import AudioFeatures

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = os.path.join(HERE, 'models', 'xiaoguai_wake.onnx')
print('[xg-wake] loading onnx...', flush=True)
sess = ort.InferenceSession(MODEL, providers=['CPUExecutionProvider'])
af = AudioFeatures()
print('[xg-wake] model ready', flush=True)

def score_pcm_i16(pcm: np.ndarray) -> float:
    """int16 PCM 16k mono → 唤醒分(0~1), 流式喂特征后取末16帧"""
    af.reset()
    for s in range(0, len(pcm), 1280):
        af(pcm[s:s+1280])
    feats = af.feature_buffer
    if len(feats) < 16:
        feats = np.pad(feats, ((16 - len(feats), 0), (0, 0)))
    x = feats[-16:][None].astype(np.float32)
    return float(sess.run(['score'], {'input': x})[0].squeeze())

class H(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != '/wake':
            self.send_response(404); self.end_headers(); return
        body = self.rfile.read(int(self.headers.get('content-length', 0)))
        try:
            req = json.loads(body)
            raw = base64.b64decode(req.get('audio_wav16k_mono', ''))
            # 支持两种格式: 裸PCM int16 或 wav容器
            if raw[:4] == b'RIFF':
                w = wave.open(io.BytesIO(raw), 'rb')
                pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
            else:
                pcm = np.frombuffer(raw, dtype=np.int16)
            score = score_pcm_i16(pcm)
        except Exception:
            import traceback; traceback.print_exc()
            out = json.dumps({'error': 'bad-request'}).encode()
            self.send_response(400)
            self.send_header('content-length', str(len(out)))
            self.end_headers(); self.wfile.write(out); return
        out = json.dumps({'score': round(score, 4)}, ensure_ascii=False).encode()
        self.send_response(200)
        self.send_header('content-type', 'application/json; charset=utf-8')
        self.send_header('content-length', str(len(out)))
        self.end_headers(); self.wfile.write(out)
    def log_message(self, *a): pass

if __name__ == '__main__':
    print('[xg-wake] serving on 127.0.0.1:9341', flush=True)
    ThreadingHTTPServer(('127.0.0.1', 9341), H).serve_forever()
