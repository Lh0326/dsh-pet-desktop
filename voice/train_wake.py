# -*- coding: utf-8 -*-
"""训练'小乖小乖'唤醒模型 v2(正确的流式特征粒度)
关键修正: 官方af(x)流式调用→feature_buffer每80ms一帧embedding,
训练正样本=目标音频末尾16帧窗口,负样本=增强噪声/静音流式帧
"""
import os, glob, wave
import numpy as np
import torch
from openwakeword.utils import AudioFeatures
from openwakeword.train import Model as OWWTrainModel

HERE = os.path.dirname(os.path.abspath(__file__))
SAMPLES = os.path.join(HERE, 'wake_train')
OUTDIR = os.path.join(HERE, 'models')
os.makedirs(OUTDIR, exist_ok=True)

def load_wav_i16(p):
    with wave.open(p, 'rb') as w:
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)

def stream_features(audio, af, chunk=1280):
    """官方流式: 逐80ms喂, 返回全部embedding帧(N,96)"""
    af.reset()
    for s in range(0, len(audio), chunk):
        af(audio[s:s+chunk])
    return af.feature_buffer.copy()

def seq_windows(feats, seq_len=16, hop=2):
    """滑窗构造(N,16,96),hop=2帧(160ms)——唤醒词约1.3s内容对齐"""
    out = []
    for s in range(0, max(1, len(feats) - seq_len + 1), hop):
        out.append(feats[s:s+seq_len])
    return np.array(out, dtype=np.float32)

af = AudioFeatures()
wavs = sorted(glob.glob(os.path.join(SAMPLES, '*.wav')))
print('targets:', len(wavs))

# 正样本: 目标词特征流的多窗口
pos_seqs = []
for p in wavs:
    feats = stream_features(load_wav_i16(p), af)
    if len(feats) >= 16:
        pos_seqs.append(seq_windows(feats))
X_pos = np.concatenate(pos_seqs)
print('pos windows:', X_pos.shape)

# 负样本x4: 噪声/静音/音调/扫频 流式
rng = np.random.default_rng(42)
def synth_neg(kind, n=32000):
    if kind == 'noise': return (rng.normal(0, 2000, n)).astype(np.int16)
    if kind == 'quiet': return (rng.normal(0, 80, n)).astype(np.int16)
    if kind == 'tone':
        t = np.arange(n) / 16000
        return (2500 * np.sin(2 * np.pi * rng.uniform(300, 1800) * t)).astype(np.int16)
    if kind == 'chirp':
        t = np.arange(n) / 16000
        f = np.linspace(200, 3000, n)
        return (2500 * np.sin(2 * np.pi * np.cumsum(f) / 16000)).astype(np.int16)
neg_seqs = []
# 真实语音负样本(非唤醒短语, edge-tts合成)——决策边界的关键
NEG_DIR = os.path.join(HERE, 'neg_samples')
for p in sorted(glob.glob(os.path.join(NEG_DIR, '*.wav'))):
    feats = stream_features(load_wav_i16(p), af)
    if len(feats) >= 16:
        neg_seqs.append(seq_windows(feats))
need = len(X_pos) * 4
kinds = ['noise', 'quiet', 'tone', 'chirp']
i = 0
while sum(len(s) for s in neg_seqs) < need:
    feats = stream_features(synth_neg(kinds[i % 4]), af)
    if len(feats) >= 16:
        neg_seqs.append(seq_windows(feats))
    i += 1
X_neg = np.concatenate(neg_seqs)[:need]
print('neg windows:', X_neg.shape)

X = np.concatenate([X_pos, X_neg])
y = np.concatenate([np.ones(len(X_pos)), np.zeros(len(X_neg))]).astype(np.float32)
idx = rng.permutation(len(X)); X, y = X[idx], y[idx]

model = OWWTrainModel(n_classes=1, input_shape=(16, 96))
opt = torch.optim.Adam(model.parameters(), lr=5e-4)
lossf = torch.nn.BCELoss()  # forward内建Sigmoid,用BCELoss(WithLogits会双sigmoid压死梯度)
Xt, yt = torch.tensor(X), torch.tensor(y).unsqueeze(1)
for epoch in range(60):
    model.train()
    perm = torch.randperm(len(Xt))
    for s in range(0, len(Xt), 64):
        b = perm[s:s+64]
        opt.zero_grad()
        loss = lossf(model(Xt[b]), yt[b])
        loss.backward(); opt.step()
    if epoch % 15 == 14:
        model.eval()
        with torch.no_grad():
            sc = model(Xt).squeeze()
        acc = ((sc > 0.5).float() == yt.squeeze()).float().mean().item()
        print(f'epoch {epoch+1} acc={acc:.3f}')

# 分离度快检
model.eval()
with torch.no_grad():
    ps = model(torch.tensor(X_pos)).max().item()
    ns = model(torch.tensor(X_neg)).max().item()
print(f'separation: pos_max={ps:.3f} neg_max={ns:.3f}')

torch.save(model.state_dict(), os.path.join(OUTDIR, 'xiaoguai_wake.pt'))
dummy = torch.randn(1, 16, 96)
torch.onnx.export(model, dummy, os.path.join(OUTDIR, 'xiaoguai_wake.onnx'),
                  input_names=['input'], output_names=['score'], opset_version=13)
print('exported onnx')
