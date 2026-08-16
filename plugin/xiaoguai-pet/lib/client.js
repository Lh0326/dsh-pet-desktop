window.__ModuleLoader__.load({
	id: "dsh-xiaoguai-pet",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client.ts
var client_exports = {};
__export(client_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(client_exports);
var import_react = require("react");
var import_client = require("react-dom/client");
var API = {
  state: () => fetch("/api/xiaoguai/state").then((r) => r.json()),
  interact: (kind, extra) => fetch("/api/xiaoguai/interact", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind, ...extra })
  }).then((r) => r.json())
};
var atlas = null;
async function loadMetas() {
  const r = await fetch("/xiaoguai/assets/atlas.manifest.json");
  if (r.ok) atlas = await r.json();
}
function isTransient(a) {
  return a === "pet-pat" || a === "pet-feed" || a === "done";
}
var ui = { snapshot: null, local: null, bubble: null, bubbleAt: 0 };
var listeners = /* @__PURE__ */ new Set();
function setUi(patch) {
  ui = { ...ui, ...patch };
  for (const l of listeners) l();
}
function subscribe(l) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
var inject = [];
var atlasBroken = false;
var atlasDecoded = null;
function ensureDecoded(_a) {
  if (atlasDecoded === null) {
    const img = new Image();
    img.src = "/xiaoguai/assets/atlas.webp";
    atlasDecoded = img.decode().then(() => void 0).catch(() => {
      atlasBroken = true;
    });
  }
  return atlasDecoded;
}
function preloadAll() {
  void ensureDecoded("idle");
}
var WINDOW_KEY = "__xiaoguaiPetInstance";
function apply() {
  const prev = window[WINDOW_KEY];
  if (prev !== void 0) {
    prev.alive = false;
    window.clearInterval(prev.timer);
    prev.dispose();
  }
  document.querySelectorAll("div[data-xiaoguai-pet-root]").forEach((el) => el.remove());
  const me = { alive: true, timer: 0, dispose: () => {
  } };
  window[WINDOW_KEY] = me;
  void loadMetas();
  preloadAll();
  window.setTimeout(() => {
    if (me.alive) void wakeStart();
  }, 2e3);
  const container = document.createElement("div");
  container.dataset.xiaoguaiPetRoot = "";
  document.body.appendChild(container);
  const root = (0, import_client.createRoot)(container);
  root.render((0, import_react.createElement)(XiaoguaiEntry));
  let pollFails = 0;
  const poll = () => {
    if (!me.alive) return;
    API.state().then((s) => {
      pollFails = 0;
      if (me.alive) setUi({ snapshot: s });
    }, () => {
      pollFails += 1;
      if (pollFails === 5) {
        setUi({ bubble: "\u26A0 \u4E0Edsh\u670D\u52A1\u65AD\u5F00\u2014\u2014\u8BED\u97F3\u4E0D\u53EF\u7528,\u8BF7\u4ECE\u6258\u76D8\u91CD\u542Fdsh", bubbleAt: Date.now() });
      }
    });
  };
  poll();
  me.timer = window.setInterval(() => {
    if (me.alive && document.visibilityState === "visible") poll();
  }, 800);
  me.dispose = () => {
    wakeStop();
    try {
      root.unmount();
    } catch {
    }
    container.remove();
  };
  return () => {
    me.alive = false;
    window.clearInterval(me.timer);
    me.dispose();
    if (window[WINDOW_KEY] === me) {
      delete window[WINDOW_KEY];
    }
  };
}
var voice = null;
var playbackCtx = null;
function ensurePlaybackUnlocked() {
  if (playbackCtx === null) {
    playbackCtx = new AudioContext();
  }
  if (playbackCtx.state === "suspended") void playbackCtx.resume();
}
var VAD_THRESHOLD = 0.045;
var SILENCE_TIMEOUT_MS = 3e3;
var TRAILING_SILENCE_MS = 900;
var MIN_DURATION_MS = 700;
async function voiceStart() {
  if (voice !== null) return;
  ensurePlaybackUnlocked();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
    const audioCtx = new AudioContext({ sampleRate: 16e3 });
    const src = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    const chunks = [];
    const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    recorder.start(250);
    const session = {
      stream,
      recorder,
      audioCtx,
      analyser,
      chunks,
      hasSpoken: false,
      lastVoiceAt: performance.now(),
      startedAt: performance.now(),
      timer: 0,
      levels: [],
      cancelled: false
    };
    voice = session;
    setUi({ local: "listening", bubble: "\u6211\u5728\u542C\uFF0C\u8BF7\u8BF4\u2026", bubbleAt: Date.now() });
    const buf = new Float32Array(analyser.fftSize);
    session.timer = window.setInterval(() => {
      if (voice !== session) return;
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      session.levels.push(Math.min(1, rms * 6));
      if (session.levels.length > 40) session.levels.shift();
      setVoiceLevels(session.levels.slice());
      const now = performance.now();
      if (rms > VAD_THRESHOLD) {
        session.lastVoiceAt = now;
        if (!session.hasSpoken) {
          session.hasSpoken = true;
        }
      }
      if (!session.hasSpoken && now - session.startedAt > SILENCE_TIMEOUT_MS) {
        void voiceCancel("\u6CA1\u542C\u5230\u58F0\u97F3\uFF0C\u4E0B\u6B21\u8BB0\u5F97\u8BF4\u8BDD\u54E6~");
        return;
      }
      if (session.hasSpoken && now - session.lastVoiceAt > TRAILING_SILENCE_MS) {
        void voiceFinish(session);
      }
    }, 100);
  } catch {
    setUi({ bubble: "\u9EA6\u514B\u98CE\u4E0D\u53EF\u7528\uFF08\u68C0\u67E5\u6D4F\u89C8\u5668\u6743\u9650\uFF09", bubbleAt: Date.now() });
    setUi({ local: null });
  }
}
async function voiceCancel(msg) {
  const session = voice;
  if (session === null) return;
  voice = null;
  window.clearInterval(session.timer);
  setVoiceLevels(null);
  session.recorder.stop();
  session.stream.getTracks().forEach((t) => t.stop());
  void session.audioCtx.close();
  setUi({ local: null, ...msg !== void 0 ? { bubble: msg, bubbleAt: Date.now() } : {} });
}
async function voiceFinish(session) {
  if (voice !== session) return;
  voice = null;
  window.clearInterval(session.timer);
  setVoiceLevels(null);
  setUi({ local: "thinking" });
  const elapsed = performance.now() - session.startedAt;
  const blob = await new Promise((resolve) => {
    session.recorder.onstop = () => resolve(new Blob(session.chunks, { type: "audio/webm" }));
    session.recorder.stop();
  });
  session.stream.getTracks().forEach((t) => t.stop());
  void session.audioCtx.close();
  if (blob.size < 2e3 || elapsed < MIN_DURATION_MS) {
    setUi({ local: null, bubble: "\u8BF4\u592A\u77ED\u5566\uFF0C\u518D\u8BF4\u4E00\u6B21\uFF1F", bubbleAt: Date.now() });
    return;
  }
  const wavB64 = await blobToWavBase64(blob);
  let text = "";
  try {
    const r = await fetch("/api/xiaoguai/voice/asr", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ audio_wav: wavB64 })
    });
    if (r.ok) text = (await r.json()).text ?? "";
  } catch {
  }
  if (text.length === 0) {
    setUi({ local: null, bubble: "\u5C0F\u4E56\u6CA1\u542C\u6E05\u2026", bubbleAt: Date.now() });
    return;
  }
  setUi({ bubble: `\u201C${text}\u201D`, bubbleAt: Date.now() });
  try {
    const r = await fetch("/api/xiaoguai/voice/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text })
    });
    const res = await r.json();
    if (res.bubble) setUi({ bubble: res.bubble, bubbleAt: Date.now() });
  } catch {
  }
  setUi({ local: null });
  void speakFeedback();
}
var voiceLevels = null;
var voiceLevelListeners = /* @__PURE__ */ new Set();
function setVoiceLevels(levels) {
  voiceLevels = levels;
  for (const l of voiceLevelListeners) l();
}
var lastReplySeen = "";
function cleanForTts(text) {
  let t = text;
  t = t.replace(/```[\s\S]*?```/g, "\uFF0C\u4EE3\u7801\u7565\uFF0C");
  t = t.replace(/`([^`]+)`/g, "$1");
  t = t.replace(/\*\*([^*]+)\*\*/g, "$1");
  t = t.replace(/\*([^*]+)\*/g, "$1");
  t = t.replace(/~~([^~]+)~~/g, "$1");
  t = t.replace(/^#{1,6}\s*/gm, "");
  t = t.replace(/^\s*[-*+]\s+/gm, "");
  t = t.replace(/^>\s?/gm, "");
  t = t.replace(/\|/g, " ");
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  t = t.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu, "");
  t = t.replace(/[*#~`>_]+/g, " ");
  t = t.replace(/\s{2,}/g, " ").trim();
  return t;
}
async function speakFeedback() {
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1e3));
    const st = ui.snapshot;
    if (st?.animation === "done") break;
  }
  sfxDone();
  let reply = "";
  for (let i = 0; i < 5; i++) {
    const st = ui.snapshot;
    if (st?.lastReply !== void 0 && st.lastReply !== lastReplySeen && st.lastReply.length > 0) {
      reply = st.lastReply;
      break;
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  if (reply.length === 0) reply = "\u4EFB\u52A1\u5B8C\u6210\u5566\uFF01";
  lastReplySeen = reply;
  let spoken = cleanForTts(reply).slice(0, 300);
  try {
    const r = await fetch("/api/xiaoguai/voice/summarize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: reply })
    });
    if (r.ok) {
      const { summary } = await r.json();
      if ((summary ?? "").length > 0) spoken = summary;
    }
  } catch {
  }
  try {
    const r = await fetch("/api/xiaoguai/voice/tts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: spoken })
    });
    if (!r.ok) return;
    const { audio_mp3 } = await r.json();
    setUi({ local: "speaking" });
    await playBase64Mp3(audio_mp3);
  } catch {
  }
  setUi({ local: null });
}
async function playBase64Mp3(b64) {
  try {
    const ctx = playbackCtx ?? new AudioContext();
    playbackCtx = ctx;
    if (ctx.state === "suspended") await ctx.resume();
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const buf = await ctx.decodeAudioData(bytes.buffer);
    await new Promise((resolve) => {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.onended = () => resolve();
      src.start();
    });
    return;
  } catch {
  }
  await new Promise((resolve) => {
    const audio = new Audio(`data:audio/mp3;base64,${b64}`);
    audio.onended = () => resolve();
    audio.onerror = () => resolve();
    audio.play().catch(() => {
      setUi({ bubble: "\u{1F50A} \u6D4F\u89C8\u5668\u62E6\u622A\u4E86\u64AD\u653E\uFF0C\u70B9\u4E00\u4E0B\u9875\u9762\u518D\u8BD5", bubbleAt: Date.now() });
      resolve();
    });
  });
}
async function blobToWavBase64(blob) {
  const buf = await blob.arrayBuffer();
  const ctx = new AudioContext({ sampleRate: 16e3 });
  const decoded = await ctx.decodeAudioData(buf);
  void ctx.close();
  let ch;
  if (Math.abs(decoded.sampleRate - 16e3) > 1) {
    const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16e3), 16e3);
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start();
    const rendered = await off.startRendering();
    ch = rendered.getChannelData(0);
  } else {
    ch = decoded.getChannelData(0);
  }
  const len = ch.length;
  const wav = new ArrayBuffer(44 + len * 2);
  const view = new DataView(wav);
  const w = (off, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
  };
  w(0, "RIFF");
  view.setUint32(4, 36 + len * 2, true);
  w(8, "WAVE");
  w(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16e3, true);
  view.setUint32(28, 32e3, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  w(36, "data");
  view.setUint32(40, len * 2, true);
  for (let i = 0; i < len; i++) view.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, ch[i] * 32767)), true);
  void ctx.close();
  const bytes = new Uint8Array(wav);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(bin);
}
var wake = null;
var WAKE_VOLUME_THRESHOLD = 0.06;
var WAKE_ARM_MS = 2200;
var WAKE_COOLDOWN_MS = 2500;
async function wakeStart() {
  if (wake !== null) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
    const audioCtx = new AudioContext({ sampleRate: 16e3 });
    const src = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    const PROC_SIZE = 2048;
    const proc = audioCtx.createScriptProcessor(PROC_SIZE, 1, 1);
    proc.onaudioprocess = (ev) => {
      const w = wake;
      if (w === null) return;
      w.pcmRing.push(new Float32Array(ev.inputBuffer.getChannelData(0)));
      while (w.pcmRing.length > 24) w.pcmRing.shift();
    };
    src.connect(proc);
    const mute = audioCtx.createGain();
    mute.gain.value = 0;
    proc.connect(mute);
    mute.connect(audioCtx.destination);
    wake = { stream, audioCtx, analyser, proc, pcmRing: [], timer: 0, state: "idle", armedAt: 0, cancelled: false };
    const buf = new Float32Array(analyser.fftSize);
    wake.timer = window.setInterval(() => {
      const w = wake;
      if (w === null) return;
      if (voice !== null || ui.local !== null) {
        w.state = "idle";
        return;
      }
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      const now = performance.now();
      if (w.state === "idle" && rms > WAKE_VOLUME_THRESHOLD) {
        w.state = "armed";
        console.log(`[xg-wake] ARMED rms=${rms.toFixed(3)} ringBlocks=${w.pcmRing.length}`);
        w.armedAt = now;
      } else if (w.state === "armed") {
        if (now - w.armedAt >= WAKE_ARM_MS) {
          w.state = "cooldown";
          const pcm = new Float32Array(w.pcmRing.length * PROC_SIZE);
          let off = 0;
          for (const blk of w.pcmRing) {
            pcm.set(blk, off);
            off += blk.length;
          }
          w.pcmRing = [];
          void wakeJudgePcm(pcm);
          setTimeout(() => {
            if (wake !== null && wake.state === "cooldown") wake.state = "idle";
          }, WAKE_COOLDOWN_MS);
        }
      }
    }, 120);
    setUi({ bubble: "\u8BF4\u300C\u5C0F\u4E56\u5C0F\u4E56\u300D\u5524\u6211", bubbleAt: Date.now() });
  } catch {
    wake = null;
  }
}
function tone(freq, t0, dur, type = "sine", gain = 0.12) {
  const ctx = playbackCtx ?? (playbackCtx = new AudioContext());
  if (ctx.state === "suspended") {
    void ctx.resume();
  }
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  const t = ctx.currentTime + t0;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.015);
  g.gain.exponentialRampToValueAtTime(1e-3, t + dur);
  osc.connect(g);
  g.connect(ctx.destination);
  osc.start(t);
  osc.stop(t + dur + 0.05);
}
function sfxWake() {
  tone(880, 0, 0.12, "sine", 0.14);
  tone(1318, 0.11, 0.18, "sine", 0.12);
}
function sfxDone() {
  tone(659, 0, 0.12, "triangle", 0.13);
  tone(830, 0.1, 0.12, "triangle", 0.12);
  tone(988, 0.2, 0.25, "triangle", 0.12);
}
function pcmToWavBase64(pcm) {
  const len = pcm.length;
  const wav = new ArrayBuffer(44 + len * 2);
  const view = new DataView(wav);
  const w = (off, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
  };
  w(0, "RIFF");
  view.setUint32(4, 36 + len * 2, true);
  w(8, "WAVE");
  w(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16e3, true);
  view.setUint32(28, 32e3, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  w(36, "data");
  view.setUint32(40, len * 2, true);
  for (let i = 0; i < len; i++) view.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, pcm[i] * 32767)), true);
  const bytes = new Uint8Array(wav);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(bin);
}
async function wakeJudgePcm(pcm) {
  console.log(`[xg-wake] JUDGE-START pcm=${(pcm.length / 16e3).toFixed(2)}s`);
  if (pcm.length < 8e3) {
    console.log("[xg-wake] drop: too short");
    return;
  }
  try {
    const wavB64 = pcmToWavBase64(pcm);
    const r = await fetch("/api/xiaoguai/voice/asr", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ audio_wav: wavB64 })
    });
    console.log(`[xg-wake] asr fetch ${r.status}`);
    if (!r.ok) {
      setUi({ bubble: `\u26A0 \u5524\u9192\u63A5\u53E3 ${r.status}`, bubbleAt: Date.now() });
      return;
    }
    const { text } = await r.json();
    console.log(`[xg-wake] heard="${text ?? ""}"`);
    if ((text ?? "").length <= 16 && /小乖|小怪|晓乖|小乘/.test(text ?? "")) {
      setUi({ bubble: "\u6211\u5728\u542C\uFF01", bubbleAt: Date.now() });
      sfxWake();
      void voiceStart();
    }
  } catch (e) {
    console.log("[xg-wake] JUDGE-ERR", e);
    setUi({ bubble: "\u26A0 \u5524\u9192\u5224\u5B9A\u5F02\u5E38", bubbleAt: Date.now() });
  }
}
function wakeStop() {
  const w = wake;
  wake = null;
  if (w === null) return;
  window.clearInterval(w.timer);
  w.proc.onaudioprocess = null;
  w.proc.disconnect();
  w.stream.getTracks().forEach((t) => t.stop());
  void w.audioCtx.close();
}
function VoicePanel() {
  const state = (0, import_react.useSyncExternalStore)(subscribe, () => ui);
  const [, force] = (0, import_react.useState)(0);
  (0, import_react.useEffect)(() => {
    const l = () => force((n) => n + 1);
    voiceLevelListeners.add(l);
    return () => {
      voiceLevelListeners.delete(l);
    };
  }, []);
  const recording = state.local === "listening";
  const bars = voiceLevels ?? [];
  return (0, import_react.createElement)(
    "div",
    { style: { display: "flex", flexDirection: "column", gap: 6 } },
    recording && (0, import_react.createElement)(
      "div",
      {
        style: {
          display: "flex",
          alignItems: "center",
          gap: 2,
          height: 24,
          padding: "4px 6px",
          borderRadius: 6,
          background: "rgba(30,41,59,0.8)"
        },
        "data-testid": "voice-waveform"
      },
      ...Array.from({ length: 40 }, (_, i) => {
        const v = bars[i] ?? 0;
        const h = Math.max(2, Math.round(v * 20));
        return (0, import_react.createElement)("div", {
          key: i,
          style: {
            width: 3,
            height: h,
            borderRadius: 1,
            background: v > 0.12 ? "#34d399" : "rgba(148,163,184,0.4)",
            // 说话绿色,静默灰
            transition: "height .08s linear"
          }
        });
      })
    ),
    (0, import_react.createElement)(
      "div",
      { style: { display: "flex", gap: 6 } },
      recording ? (0, import_react.createElement)("button", {
        type: "button",
        onClick: () => {
          void voiceCancel();
        },
        style: { cursor: "pointer", flex: 1 }
      }, "\u25A0 \u53D6\u6D88") : (0, import_react.createElement)("button", {
        type: "button",
        disabled: state.local !== null,
        // 其他暂时态进行中禁用
        onClick: () => {
          void voiceStart();
        },
        style: { cursor: "pointer", flex: 1 },
        title: "\u70B9\u51FB\u8BF4\u8BDD\uFF0C\u8BF4\u5B8C\u505C\u987F\u81EA\u52A8\u53D1\u9001"
      }, "\u{1F3A4} \u8BF4\u8BDD")
    )
  );
}
function XiaoguaiEntry() {
  const state = (0, import_react.useSyncExternalStore)(subscribe, () => ui);
  const visible = state.snapshot?.display.visible ?? true;
  if (!visible) {
    return (0, import_react.createElement)("button", {
      type: "button",
      "aria-label": "\u53EC\u56DE\u5C0F\u4E56",
      onClick: () => {
        void API.interact("summon").then(() => setUi({ snapshot: ui.snapshot ? { ...ui.snapshot, display: { ...ui.snapshot.display, visible: true } } : null }));
      },
      style: {
        position: "fixed",
        right: 8,
        bottom: 8,
        zIndex: 2147483e3,
        width: 30,
        height: 30,
        borderRadius: "50%",
        border: "1px solid rgba(148,163,184,0.5)",
        background: "rgba(15,23,42,0.55)",
        color: "#cbd5e1",
        fontSize: 15,
        lineHeight: 1,
        cursor: "pointer",
        padding: 0,
        opacity: 0.35,
        transition: "opacity .15s"
      },
      onPointerEnter: (e) => {
        e.currentTarget.style.opacity = "1";
      },
      onPointerLeave: (e) => {
        e.currentTarget.style.opacity = "0.35";
      }
    }, "\u4E56");
  }
  return (0, import_react.createElement)(XiaoguaiFloat);
}
function XiaoguaiFloat() {
  const state = (0, import_react.useSyncExternalStore)(subscribe, () => ui);
  const snapshot = state.snapshot;
  const display = snapshot?.display ?? { size: 176, right: 24, bottom: 24, visible: true };
  const animation = state.local ?? snapshot?.animation ?? "idle";
  const spriteRef = (0, import_react.useRef)(null);
  const floatRef = (0, import_react.useRef)(null);
  const [dragPos, setDragPos] = (0, import_react.useState)(null);
  const dragRef = (0, import_react.useRef)(null);
  const draggedRef = (0, import_react.useRef)(false);
  const [hovered, setHovered] = (0, import_react.useState)(false);
  const hidePanelTimer = (0, import_react.useRef)(null);
  const showPanel = () => {
    if (hidePanelTimer.current !== null) {
      window.clearTimeout(hidePanelTimer.current);
      hidePanelTimer.current = null;
    }
    if (state.local !== null && state.local !== "pet-drag") return;
    setHovered(true);
  };
  const scheduleHidePanel = () => {
    if (hidePanelTimer.current !== null) window.clearTimeout(hidePanelTimer.current);
    hidePanelTimer.current = window.setTimeout(() => setHovered(false), 400);
  };
  const frameRef = (0, import_react.useRef)({
    anim: null,
    index: 0,
    elapsed: 0,
    finished: false
  });
  const animRef = (0, import_react.useRef)(animation);
  const prevAnimRef = (0, import_react.useRef)(null);
  animRef.current = animation;
  (0, import_react.useEffect)(() => {
    if (prevAnimRef.current !== animation) {
      prevAnimRef.current = animation;
      void ensureDecoded(animation);
      frameRef.current = { anim: null, index: 0, elapsed: 0, finished: false };
    }
  }, [animation]);
  (0, import_react.useLayoutEffect)(() => {
    const row = atlas?.rows[animation] ?? 0;
    if (spriteRef.current !== null) {
      spriteRef.current.style.backgroundPosition = `0px -${row * display.size}px`;
    }
  }, [animation, display.size]);
  (0, import_react.useEffect)(() => {
    let raf = 0;
    let last = performance.now();
    const tick = (ts) => {
      const delta = ts - last;
      last = ts;
      const anim = animRef.current;
      const fps = atlas?.fps ?? 30;
      const frameCount = atlas?.frames[anim] ?? 1;
      const row = atlas?.rows[anim] ?? 0;
      const st = frameRef.current;
      if (st.anim !== anim) {
        st.anim = anim;
        st.index = 0;
        st.elapsed = 0;
        st.finished = false;
      }
      if (!st.finished) {
        st.elapsed += delta;
        const frameMs = 1e3 / fps;
        if (isTransient(anim)) {
          while (st.elapsed >= frameMs && st.index < frameCount - 1) {
            st.elapsed -= frameMs;
            st.index += 1;
          }
          if (st.elapsed >= frameMs) {
            st.index = frameCount - 1;
            st.finished = true;
            if (anim !== "pet-drag") setUi({ local: null });
          }
        } else {
          const phase = st.elapsed % (frameMs * frameCount);
          st.index = Math.floor(phase / frameMs);
        }
      }
      if (spriteRef.current !== null) {
        spriteRef.current.style.backgroundPosition = `-${st.index * display.size}px -${row * display.size}px`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [display.size]);
  (0, import_react.useEffect)(() => {
    if (state.bubble === null) return;
    const t = window.setTimeout(() => setUi({ bubble: null }), 2600);
    return () => window.clearTimeout(t);
  }, [state.bubbleAt]);
  const clearDrag = () => {
    dragRef.current = null;
    setUi({ local: null });
  };
  const size = display.size;
  const rawPos = dragPos ?? { right: display.right, bottom: display.bottom };
  const pos = {
    right: Math.max(0, Math.min(rawPos.right, window.innerWidth - 60)),
    bottom: Math.max(0, Math.min(rawPos.bottom, window.innerHeight - 60))
  };
  const float = (0, import_react.createElement)(
    "div",
    {
      ref: floatRef,
      style: {
        position: "fixed",
        right: pos.right,
        bottom: pos.bottom,
        zIndex: 2147483e3,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        userSelect: "none",
        WebkitUserSelect: "none",
        // GPU合成层隔离: WebView2下fixed元素高频改right/bottom会出现
        // 合成器与主文档更新不同步的"残影/第二个小乖"——
        // 提升为独立合成层后位置变化不再牵动主文档重排
        willChange: "right, bottom",
        transform: "translateZ(0)",
        backfaceVisibility: "hidden"
      },
      onPointerEnter: showPanel,
      onPointerLeave: scheduleHidePanel
    },
    (0, import_react.createElement)("div", {
      ref: spriteRef,
      role: "button",
      "aria-label": "\u5C0F\u4E56",
      style: {
        width: size,
        height: size,
        // 单图集: backgroundImage/Size 恒定不随动画变(动画只改position)
        // 图集失效时以边框占位提示(不隐身)
        border: atlasBroken ? "2px dashed #f59e0b" : void 0,
        backgroundImage: "url(/xiaoguai/assets/atlas.webp)",
        backgroundSize: `${size * (atlas ? Math.max(...Object.values(atlas.frames)) : 34)}px ${size * (atlas ? Object.keys(atlas.rows).length : 10)}px`,
        backgroundRepeat: "no-repeat",
        // backgroundPosition 不归 React 管（rAF 直写,x=帧列y=状态行）
        imageRendering: "auto",
        touchAction: "none",
        cursor: dragRef.current === null ? "grab" : "grabbing"
      },
      onPointerDown: (e) => {
        e.preventDefault();
        e.target.setPointerCapture?.(e.pointerId);
        setHovered(false);
        void ensureDecoded("pet-drag");
        const rect = floatRef.current?.getBoundingClientRect();
        const current = rect !== void 0 ? { right: Math.max(0, window.innerWidth - rect.right), bottom: Math.max(0, window.innerHeight - rect.bottom) } : { right: display.right, bottom: display.bottom };
        dragRef.current = { startX: e.clientX, startY: e.clientY, ...current };
        draggedRef.current = false;
      },
      onPointerMove: (e) => {
        const drag = dragRef.current;
        if (drag === null) return;
        const dx = e.clientX - drag.startX;
        const dy = e.clientY - drag.startY;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
          if (!draggedRef.current) {
            draggedRef.current = true;
            setUi({ local: "pet-drag" });
          }
        }
        const right = Math.max(0, Math.min(drag.right - dx, window.innerWidth - 40));
        const bottom = Math.max(0, Math.min(drag.bottom - dy, window.innerHeight - 40));
        setDragPos({ right, bottom });
      },
      onPointerUp: (e) => {
        if (dragRef.current === null) return;
        const wasDrag = draggedRef.current;
        const drag = dragRef.current;
        const dx = e.clientX - drag.startX;
        const dy = e.clientY - drag.startY;
        const finalPos = wasDrag ? {
          right: Math.max(0, Math.min(drag.right - dx, window.innerWidth - 40)),
          bottom: Math.max(0, Math.min(drag.bottom - dy, window.innerHeight - 40))
        } : null;
        dragRef.current = null;
        setUi({ local: null });
        if (finalPos !== null) {
          void API.interact("dragEnd", finalPos);
        } else {
          void API.interact("pat").then((r) => {
            if (r.bubble) setUi({ bubble: r.bubble, bubbleAt: Date.now() });
          });
          setUi({ local: "pet-pat" });
        }
      }
    }),
    state.bubble !== null && (0, import_react.createElement)("div", {
      key: state.bubbleAt,
      style: {
        position: "absolute",
        bottom: "100%",
        marginBottom: 2,
        whiteSpace: "nowrap",
        padding: "4px 10px",
        borderRadius: 999,
        fontSize: 12,
        color: "#fff",
        background: "rgba(244,114,182,0.92)",
        boxShadow: "0 2px 8px rgba(0,0,0,0.25)",
        pointerEvents: "none"
      }
    }, state.bubble),
    hovered && dragRef.current === null && (0, import_react.createElement)(
      "div",
      {
        onPointerEnter: showPanel,
        onPointerLeave: scheduleHidePanel,
        style: {
          // 贴着小乖头顶零间隙（+400ms 缓冲），鼠标移向面板全程在 hit 区
          position: "absolute",
          bottom: "100%",
          marginBottom: 0,
          background: "rgba(15,23,42,0.92)",
          border: "1px solid rgba(148,163,184,0.35)",
          borderRadius: 10,
          padding: "8px 10px",
          color: "#e2e8f0",
          fontSize: 12,
          display: "flex",
          flexDirection: "column",
          gap: 6,
          minWidth: 128
        }
      },
      (0, import_react.createElement)(
        "div",
        { style: { display: "flex", justifyContent: "space-between", gap: 8 } },
        (0, import_react.createElement)("span", null, `${snapshot?.affinity.rankEmoji ?? "\u{1F331}"} \u5C0F\u4E56 \xB7 ${snapshot?.affinity.rank ?? "\u521D\u8BC6"}`),
        (0, import_react.createElement)("span", { style: { opacity: 0.7 } }, `${snapshot?.affinity.points ?? 0} \u5206`)
      ),
      (0, import_react.createElement)(
        "div",
        { style: { display: "flex", justifyContent: "space-between", gap: 8, opacity: 0.75 } },
        (0, import_react.createElement)("span", null, `\u6478\u5934 ${snapshot?.affinity.pets ?? 0}`),
        (0, import_react.createElement)("span", null, `\u6295\u5582 ${snapshot?.affinity.feeds ?? 0}`),
        (0, import_react.createElement)("span", null, `\u966A\u5DE5 ${snapshot?.affinity.turns ?? 0}`)
      ),
      (0, import_react.createElement)(VoicePanel),
      (0, import_react.createElement)(
        "div",
        { style: { display: "flex", gap: 6 } },
        (0, import_react.createElement)("button", {
          type: "button",
          disabled: snapshot?.affinity.feedCooldown === true,
          onClick: () => {
            void API.interact("feed").then((r) => {
              if (r.bubble) setUi({ bubble: r.bubble, bubbleAt: Date.now() });
            });
            setUi({ local: "pet-feed" });
          },
          style: { cursor: "pointer", flex: 1 }
        }, snapshot?.affinity.feedCooldown === true ? "\u56BC\u7740\u5462\u2026" : "\u6295\u5582"),
        (0, import_react.createElement)("button", {
          type: "button",
          onClick: () => {
            void API.interact("hide");
            setUi({ snapshot: ui.snapshot ? { ...ui.snapshot, display: { ...ui.snapshot.display, visible: false } } : null });
          },
          style: { cursor: "pointer", flex: 1 }
        }, "\u9690\u85CF")
      )
    )
  );
  return float;
}

		return module.exports;
	}
});
