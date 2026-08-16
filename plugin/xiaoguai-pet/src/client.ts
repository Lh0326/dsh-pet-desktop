/**
 * 小乖桌宠浏览器半区 — 全局浮层（React root → document.body）。
 * 交互契约（按用户实测反馈修正）：
 *   - 拖拽：pointer 按下移动 → pet-drag 动画；**pointerup 一律回落**
 *     （无论 host 状态如何——拖拽是纯客户端暂时态）
 *   - 单击（未拖动）：摸头（pat），动画播完一次即回落
 *   - 悬停面板：投喂 / 隐藏
 *   - 动画时长 = 帧数 ÷ fps（meta.json 为准，30fps 原速），只播一次不重复
 * 轮询 /api/xiaoguai/state（800ms）驱动会话联动相位。
 * @module dsh-xiaoguai-pet/client
 */
import { createElement, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'

type Animation = 'idle' | 'thinking' | 'working' | 'confirm' | 'done'
  | 'listening' | 'speaking' | 'pet-drag' | 'pet-pat' | 'pet-feed'

interface StateView {
  animation: Animation
  phase: string
  sessionActive: boolean
  bubble?: string
  display: { size: number; right: number; bottom: number; visible: boolean }
  lastReply?: string
  affinity: {
    points: number
    rank: string
    rankEmoji: string
    pets: number
    feeds: number
    turns: number
    patCooldown: boolean
    feedCooldown: boolean
  }
}

const API = {
  state: () => fetch('/api/xiaoguai/state').then(r => r.json()) as Promise<StateView>,
  interact: (kind: string, extra?: Record<string, unknown>) =>
    fetch('/api/xiaoguai/interact', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind, ...extra }),
    }).then(r => r.json()) as Promise<{ animation: Animation; bubble?: string }>,
}

/** 素材：单图集（鲸鱼娘模式）。所有状态共用一张 atlas.webp（每状态一行，
 *  行内帧横排），动画切换 = 只改 backgroundPosition——backgroundImage/Size
 *  终身恒定，从根上消除"换图瞬间的缩放/残留帧"（切背景图时浏览器要在
 *  新旧图×新旧尺寸的中间组合上渲染，无法干净）。 */
interface AtlasManifest { frameSize: number; rows: Record<Animation, number>; frames: Record<Animation, number>; fps: number }
let atlas: AtlasManifest | null = null

async function loadMetas(): Promise<void> {
  const r = await fetch('/xiaoguai/assets/atlas.manifest.json')
  if (r.ok) atlas = await r.json()
}

/** 暂时态：播完一整轮立即回落 idle */
function isTransient(a: Animation): boolean {
  return a === 'pet-pat' || a === 'pet-feed' || a === 'done'
}

// —— 极简外部 store（轮询快照 + 本地暂时态覆盖） ——
interface UiState {
  snapshot: StateView | null
  /** 客户端本地暂时态（拖拽/摸头/投喂），优先于 host 相位 */
  local: Animation | null
  bubble: string | null
  bubbleAt: number
}
let ui: UiState = { snapshot: null, local: null, bubble: null, bubbleAt: 0 }
const listeners = new Set<() => void>()
function setUi(patch: Partial<UiState>): void {
  ui = { ...ui, ...patch }
  for (const l of listeners) l()
}
function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => { listeners.delete(l) }
}

/** 客户端半区无需宿主服务（纯浮层+fetch），inject 为空数组（loader 约定必须存在） */
export const inject: string[] = []

/** 精灵图预加载+解码门（重影主源治理）：
 *  加载≠就绪——大图下载后仍需解码,解码期间 backgroundImage 切换会露出
 *  旧图/空白,与位置更新叠加成"第二个小乖"。用 decode() 确保像素真正
 *  进显存后才允许动画切到该状态;启动时全部预解码。 */
/** 图集加载失败兜底标记（atlas 404/解码失败 → 橙色虚线边框占位，
 *  绝不出现"隐身但可交互"的迷惑状态） */
let atlasBroken = false
let atlasDecoded: Promise<void> | null = null
function ensureDecoded(_a: Animation): Promise<void> {
  if (atlasDecoded === null) {
    const img = new Image()
    img.src = '/xiaoguai/assets/atlas.webp'
    atlasDecoded = img.decode().then(() => undefined).catch(() => { atlasBroken = true })
  }
  return atlasDecoded
}
function preloadAll(): void { void ensureDecoded('idle') }

/** 单例守护（跨 bundle 强化版）：
 *  dsh 重启/热重载会加载新 client.js bundle——新 bundle 的模块级变量是全新的，
 *  看不到旧 bundle 的实例（模块级令牌失效 = 修复后一拖拽旧分身复活的根因）。
 *  令牌必须挂在 window 上（跨 bundle 唯一共享的存储），新 apply 到来时：
 *  1. 杀旧实例的轮询（alive=false + clearInterval）
 *  2. unmount 旧 React root（持有 window 引用才能做到）
 *  3. 移除旧容器 DOM */
interface PetInstance { alive: boolean; timer: number; dispose: () => void }
const WINDOW_KEY = '__xiaoguaiPetInstance'

export function apply(): (() => void) | void {
  const prev = (window as unknown as Record<string, PetInstance | undefined>)[WINDOW_KEY]
  if (prev !== undefined) {
    prev.alive = false
    window.clearInterval(prev.timer)
    prev.dispose()
  }
  document.querySelectorAll('div[data-xiaoguai-pet-root]').forEach(el => el.remove())

  const me: PetInstance = { alive: true, timer: 0, dispose: () => {} }
  ;(window as unknown as Record<string, PetInstance | undefined>)[WINDOW_KEY] = me
  void loadMetas()
  preloadAll()
  // 唤醒词待机: 延迟2s启动(避开页面加载高峰,麦克风权限框也不至于打断首屏)
  window.setTimeout(() => { if (me.alive) void wakeStart() }, 2000)

  const container = document.createElement('div')
  container.dataset.xiaoguaiPetRoot = ''
  document.body.appendChild(container)
  const root = createRoot(container)
  root.render(createElement(XiaoguaiEntry))

  let pollFails = 0
  const poll = (): void => {
    if (!me.alive) return
    API.state().then(s => {
      pollFails = 0
      if (me.alive) setUi({ snapshot: s })
    }, () => {
      // 连续失败=dsh服务死了(页面静默断连)——明示用户,唤醒/语音都不可用
      pollFails += 1
      if (pollFails === 5) {
        setUi({ bubble: '⚠ 与dsh服务断开——语音不可用,请从托盘重启dsh', bubbleAt: Date.now() })
      }
    })
  }
  poll()
  me.timer = window.setInterval(() => {
    if (me.alive && document.visibilityState === 'visible') poll()
  }, 800)

  me.dispose = () => {
    wakeStop()
    try { root.unmount() } catch { /* 已卸载 */ }
    container.remove()
  }
  return () => {
    me.alive = false
    window.clearInterval(me.timer)
    me.dispose()
    if ((window as unknown as Record<string, PetInstance | undefined>)[WINDOW_KEY] === me) {
      delete (window as unknown as Record<string, PetInstance | undefined>)[WINDOW_KEY]
    }
  }
}


// —— 语音链路客户端 v2（点击说话 + 实时声纹 + VAD 自动断句 + 3s 无声超时） ——
interface VoiceSession {
  stream: MediaStream
  recorder: MediaRecorder
  audioCtx: AudioContext
  analyser: AnalyserNode
  chunks: Blob[]
  /** VAD 状态机 */
  hasSpoken: boolean          // 本轮是否检测到过人声
  lastVoiceAt: number         // 最近一次音量超阈值的时间
  startedAt: number
  timer: number               // 状态机轮询 interval
  levels: number[]            // 声纹历史(最近40帧音量0~1)
  cancelled: boolean
}
let voice: VoiceSession | null = null

/** 全局播放用 AudioContext：在用户手势（点击说话）中 resume 解锁，
 *  之后 TTS 播报不再被 autoplay 策略拦截（Chromium 的手势激活在
 *  长异步链路后会过期，Audio.play() 会被静默拒绝——语音"无输出"的根因） */
let playbackCtx: AudioContext | null = null
function ensurePlaybackUnlocked(): void {
  if (playbackCtx === null) {
    playbackCtx = new AudioContext()
  }
  if (playbackCtx.state === 'suspended') void playbackCtx.resume()
}

/** 音量阈值（RMS）：环境噪声通常 <0.02，正常说话 >0.06 */
const VAD_THRESHOLD = 0.045
/** 开口前容忍：3s 无声 → 超时退出 */
const SILENCE_TIMEOUT_MS = 3000
/** 说完判定：检测到说话后连续 0.9s 低于阈值 → 自动断句 */
const TRAILING_SILENCE_MS = 900
/** 最短有效时长（防误触） */
const MIN_DURATION_MS = 700

/** 点击开始（非按住）：小乖进 listening，面板声纹条实时跳动 */
async function voiceStart(): Promise<void> {
  if (voice !== null) return   // 会话进行中
  ensurePlaybackUnlocked()     // 手势内解锁音频播放(TTS输出依赖)
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } })
    const audioCtx = new AudioContext({ sampleRate: 16000 })
    const src = audioCtx.createMediaStreamSource(stream)
    const analyser = audioCtx.createAnalyser()
    analyser.fftSize = 512
    src.connect(analyser)   // analyser 不连 destination（避免回环啸叫）

    const chunks: Blob[] = []
    const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' })
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data) }
    recorder.start(250)

    const session: VoiceSession = {
      stream, recorder, audioCtx, analyser, chunks,
      hasSpoken: false, lastVoiceAt: performance.now(),
      startedAt: performance.now(), timer: 0, levels: [], cancelled: false,
    }
    voice = session
    setUi({ local: 'listening', bubble: '我在听，请说…', bubbleAt: Date.now() })

    const buf = new Float32Array(analyser.fftSize)
    session.timer = window.setInterval(() => {
      if (voice !== session) return
      analyser.getFloatTimeDomainData(buf)
      // RMS 音量
      let sum = 0
      for (let i = 0; i < buf.length; i++) sum += buf[i]! * buf[i]!
      const rms = Math.sqrt(sum / buf.length)
      session.levels.push(Math.min(1, rms * 6))   // 归一化显示增益
      if (session.levels.length > 40) session.levels.shift()
      setVoiceLevels(session.levels.slice())

      const now = performance.now()
      if (rms > VAD_THRESHOLD) {
        session.lastVoiceAt = now
        if (!session.hasSpoken) {
          session.hasSpoken = true

        }
      }
      if (!session.hasSpoken && now - session.startedAt > SILENCE_TIMEOUT_MS) {
        // 3s 没听到声音 → 超时退出
        void voiceCancel('没听到声音，下次记得说话哦~')
        return
      }
      if (session.hasSpoken && now - session.lastVoiceAt > TRAILING_SILENCE_MS) {
        // 说完停顿 0.9s → 自动断句发送
        void voiceFinish(session)
      }
    }, 100)
  } catch {
    setUi({ bubble: '麦克风不可用（检查浏览器权限）', bubbleAt: Date.now() })
    setUi({ local: null })
  }
}

/** 用户主动取消（面板"取消"按钮） */
async function voiceCancel(msg?: string): Promise<void> {
  const session = voice
  if (session === null) return
  voice = null
  window.clearInterval(session.timer)
  setVoiceLevels(null)
  session.recorder.stop()
  session.stream.getTracks().forEach(t => t.stop())
  void session.audioCtx.close()
  setUi({ local: null, ...(msg !== undefined ? { bubble: msg, bubbleAt: Date.now() } : {}) })
}

/** VAD 自动断句 → 采集收尾 → ASR → 发会话 */
async function voiceFinish(session: VoiceSession): Promise<void> {
  if (voice !== session) return
  voice = null
  window.clearInterval(session.timer)
  setVoiceLevels(null)
  setUi({ local: 'thinking' })
  const elapsed = performance.now() - session.startedAt
  const blob: Blob = await new Promise((resolve) => {
    session.recorder.onstop = () => resolve(new Blob(session.chunks, { type: 'audio/webm' }))
    session.recorder.stop()
  })
  session.stream.getTracks().forEach(t => t.stop())
  void session.audioCtx.close()
  if (blob.size < 2000 || elapsed < MIN_DURATION_MS) {
    setUi({ local: null, bubble: '说太短啦，再说一次？', bubbleAt: Date.now() })
    return
  }
  const wavB64 = await blobToWavBase64(blob)
  let text = ''
  try {
    const r = await fetch('/api/xiaoguai/voice/asr', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ audio_wav: wavB64 }),
    })
    if (r.ok) text = ((await r.json()) as { text?: string }).text ?? ''
  } catch { /* ASR 失败 */ }
  if (text.length === 0) {
    setUi({ local: null, bubble: '小乖没听清…', bubbleAt: Date.now() })
    return
  }
  setUi({ bubble: `“${text}”`, bubbleAt: Date.now() })
  try {
    const r = await fetch('/api/xiaoguai/voice/send', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    const res = await r.json() as { bubble?: string }
    if (res.bubble) setUi({ bubble: res.bubble, bubbleAt: Date.now() })
  } catch { /* 发送失败 */ }
  setUi({ local: null })
  void speakFeedback()
}

// —— 声纹条 UI 状态（面板内实时波形） ——
let voiceLevels: number[] | null = null
const voiceLevelListeners = new Set<() => void>()
function setVoiceLevels(levels: number[] | null): void {
  voiceLevels = levels
  for (const l of voiceLevelListeners) l()
}

/** 语音播报轮询用的会话起点（只播报语音发起后的新回复） */
let speakSinceSeq = 0
let lastReplySeen = ''


/** TTS播报文本清洗: 只留人类语言内容
 *  - Markdown: **加粗** *斜体* `code` #标题 -列表 >引用 ~~删除~~ |表格|
 *  - Emoji/符号图标(含变体选择符/零宽连接符组合)
 *  原因: edge-tts会把**念成"星号星号",emoji会被跳过或乱念 */
function cleanForTts(text: string): string {
  let t = text
  t = t.replace(/```[\s\S]*?```/g, '，代码略，')
  t = t.replace(/`([^`]+)`/g, '$1')
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1')
  t = t.replace(/\*([^*]+)\*/g, '$1')
  t = t.replace(/~~([^~]+)~~/g, '$1')
  t = t.replace(/^#{1,6}\s*/gm, '')
  t = t.replace(/^\s*[-*+]\s+/gm, '')
  t = t.replace(/^>\s?/gm, '')
  t = t.replace(/\|/g, ' ')
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  t = t.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu, '')
  t = t.replace(/[*#~`>_]+/g, ' ')
  t = t.replace(/\s{2,}/g, ' ').trim()
  return t
}

async function speakFeedback(): Promise<void> {
  // 等 done 相位(最多60s)→取 lastReply 真实回复→TTS播报
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 1000))
    const st = ui.snapshot
    if (st?.animation === 'done') break
  }
  sfxDone()   // 任务完成提示音(播报摘要前奏)
  // 立即进入speaking动画——掩盖summarize+tts的1-4秒准备空窗
  // (此前空窗回落idle,出现"播报中却待机"的错位)
  setUi({ local: 'speaking' })
  // 再等最后一条assistant消息落到state(轮询延迟容错)
  let reply = ''
  for (let i = 0; i < 5; i++) {
    const st = ui.snapshot
    if (st?.lastReply !== undefined && st.lastReply !== lastReplySeen && st.lastReply.length > 0) {
      reply = st.lastReply
      break
    }
    await new Promise(r => setTimeout(r, 800))
  }
  if (reply.length === 0) reply = '任务完成啦！'
  lastReplySeen = reply
  // 播报层精简: 完整回复留在会话界面,语音只播DeepSeek二次概括(≤80字纯文字)
  let spoken = cleanForTts(reply).slice(0, 300)
  try {
    const r = await fetch('/api/xiaoguai/voice/summarize', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: reply }),
    })
    if (r.ok) {
      const { summary } = (await r.json()) as { summary?: string }
      if ((summary ?? '').length > 0) spoken = summary!
    }
  } catch { /* 摘要失败退回清洗截断 */ }
  try {
    const r = await fetch('/api/xiaoguai/voice/tts', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: spoken }),
    })
    if (!r.ok) return
    const { audio_mp3 } = await r.json() as { audio_mp3: string }
    setUi({ local: 'speaking' })   // speaking动画即反馈,不加文字
    await playBase64Mp3(audio_mp3)
  } catch { /* TTS失败静默 */ }
  setUi({ local: null })
}

async function playBase64Mp3(b64: string): Promise<void> {
  // WebAudio播放: 手势期解锁的AudioContext不受autoplay限制;
  // 兼容回退HTMLAudio(浏览器放行时)
  try {
    const ctx = playbackCtx ?? new AudioContext()
    playbackCtx = ctx
    if (ctx.state === 'suspended') await ctx.resume()
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    const buf = await ctx.decodeAudioData(bytes.buffer)
    await new Promise<void>((resolve) => {
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.connect(ctx.destination)
      src.onended = () => resolve()
      src.start()
    })
    return
  } catch { /* WebAudio失败→回退HTMLAudio */ }
  await new Promise<void>((resolve) => {
    const audio = new Audio(`data:audio/mp3;base64,${b64}`)
    audio.onended = () => resolve()
    audio.onerror = () => resolve()
    audio.play().catch(() => {
      setUi({ bubble: '🔊 浏览器拦截了播放，点一下页面再试', bubbleAt: Date.now() })
      resolve()
    })
  })
}

async function blobToWavBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer()
  const ctx = new AudioContext({ sampleRate: 16000 })
  const decoded = await ctx.decodeAudioData(buf)
  void ctx.close()
  // decodeAudioData 不跟随 AudioContext 的采样率(仍为原始48k)——
  // 必须 OfflineAudioContext 显式重采样到 16k,否则 wav 头写 16k 而数据
  // 是 48k,服务端 3 倍慢放变形(唤醒模型对时间结构敏感,必死)
  let ch: Float32Array
  if (Math.abs(decoded.sampleRate - 16000) > 1) {
    const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000)
    const src = off.createBufferSource()
    src.buffer = decoded
    src.connect(off.destination)
    src.start()
    const rendered = await off.startRendering()
    ch = rendered.getChannelData(0)
  } else {
    ch = decoded.getChannelData(0)
  }
  // PCM16 wav编码
  const len = ch.length
  const wav = new ArrayBuffer(44 + len * 2)
  const view = new DataView(wav)
  const w = (off: number, str: string) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)) }
  w(0, 'RIFF'); view.setUint32(4, 36 + len * 2, true); w(8, 'WAVE')
  w(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  w(36, 'data'); view.setUint32(40, len * 2, true)
  for (let i = 0; i < len; i++) view.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, ch[i]! * 32767)), true)
  void ctx.close()
  // ArrayBuffer→base64
  const bytes = new Uint8Array(wav)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return btoa(bin)
}



// —— 唤醒词待机（"小乖小乖"语音入口,替代点击说话） ——
// 两层漏斗: 音量门限(零开销,静默时完全不跑) → 疑似语音1.5s → ASR文本匹配
// "小乖"。命中→自动进入语音模式。回复播报/语音交互进行中不监听(防自触发)。
interface WakeService {
  stream: MediaStream
  audioCtx: AudioContext
  analyser: AnalyserNode
  proc: ScriptProcessorNode
  /** PCM环形缓冲(最近~3s): 待机持续收集原始采样,判定时整段直取。
   *  取代webm块ring——MediaRecorder的块拼接在cluster边界上不可靠
   *  (实测唤醒判定异常的直接根因),PCM数组拼接零歧义 */
  pcmRing: Float32Array[]
  timer: number
  state: 'idle' | 'armed' | 'cooldown'
  armedAt: number
  cancelled: boolean
}
let wake: WakeService | null = null
const WAKE_VOLUME_THRESHOLD = 0.06    // 待机门限(略高于语音模式VAD,压低误触发)
const WAKE_ARM_MS = 2200              // 触发后采集窗口(2.2s: '小乖小乖'含起音/换气全程)
const WAKE_COOLDOWN_MS = 2500         // 判定后冷却(含进入语音模式的过渡)
/** 唤醒判定: 本地onnx微模型(voice/wake_server.py)
 *  正样本0.98+/负样本0.05-,阈值0.85 */
const WAKE_SCORE_THRESHOLD = 0.85

async function wakeStart(): Promise<void> {
  if (wake !== null) return
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } })
    const audioCtx = new AudioContext({ sampleRate: 16000 })
    const src = audioCtx.createMediaStreamSource(stream)
    const analyser = audioCtx.createAnalyser()
    analyser.fftSize = 512
    src.connect(analyser)

    // PCM环形缓冲: ScriptProcessor逐帧收原始采样(无容器/拼接问题)
    const PROC_SIZE = 2048
    const proc = audioCtx.createScriptProcessor(PROC_SIZE, 1, 1)
    proc.onaudioprocess = (ev) => {
      const w = wake
      if (w === null) return
      w.pcmRing.push(new Float32Array(ev.inputBuffer.getChannelData(0)))
      // ring上限~3s(3*16000/2048≈24块)——词头预滚全在
      while (w.pcmRing.length > 24) w.pcmRing.shift()
    }
    src.connect(proc)
    // ScriptProcessor须连destination才运行;经0增益节点防回环啸叫
    const mute = audioCtx.createGain(); mute.gain.value = 0
    proc.connect(mute); mute.connect(audioCtx.destination)

    wake = { stream, audioCtx, analyser, proc, pcmRing: [], timer: 0, state: 'idle', armedAt: 0, cancelled: false }
    const buf = new Float32Array(analyser.fftSize)
    wake.timer = window.setInterval(() => {
      const w = wake
      if (w === null) return
      // 语音模式/播报进行中挂起判定(避免TTS自己唤醒自己)
      if (voice !== null || ui.local !== null) { w.state = 'idle'; return }
      analyser.getFloatTimeDomainData(buf)
      let sum = 0
      for (let i = 0; i < buf.length; i++) sum += buf[i]! * buf[i]!
      const rms = Math.sqrt(sum / buf.length)
      const now = performance.now()
      if (w.state === 'idle' && rms > WAKE_VOLUME_THRESHOLD) {
        w.state = 'armed'
        console.log(`[xg-wake] ARMED rms=${rms.toFixed(3)} ringBlocks=${w.pcmRing.length}`)

        w.armedAt = now
      } else if (w.state === 'armed') {
        if (now - w.armedAt >= WAKE_ARM_MS) {
          // 窗口结束→判定: ring全部PCM(ring持续滚动,词头+词身一体)
          w.state = 'cooldown'
          const pcm = new Float32Array(w.pcmRing.length * PROC_SIZE)
          let off = 0
          for (const blk of w.pcmRing) { pcm.set(blk, off); off += blk.length }
          w.pcmRing = []
          void wakeJudgePcm(pcm)
          setTimeout(() => { if (wake !== null && wake.state === 'cooldown') wake.state = 'idle' }, WAKE_COOLDOWN_MS)
        }
        // 不做"提前静默放弃": PCM ring无成本,让时间窗自然结束
        // (旧放弃逻辑在句中低音量帧误判,造成armed/idle高频抖动)
      }
      // 待机静默: 无气泡(测试期音量峰值诊断已移除)
    }, 120)
    setUi({ bubble: '说「小乖小乖」唤我', bubbleAt: Date.now() })
  } catch {
    // 麦克风权限未授予——静默降级(点击说话仍可用)
    wake = null
  }
}


// —— 提示音效(WebAudio合成,零音频文件) ——
/** 单音: freq(Hz) t0(起始秒) dur(秒) type(波形) gain */
function tone(freq: number, t0: number, dur: number, type: OscillatorType = 'sine', gain = 0.12): void {
  const ctx = playbackCtx ?? (playbackCtx = new AudioContext())
  if (ctx.state === 'suspended') { void ctx.resume() }
  const osc = ctx.createOscillator()
  const g = ctx.createGain()
  osc.type = type
  osc.frequency.value = freq
  // 包络: 快起缓落(避免咔哒声)
  const t = ctx.currentTime + t0
  g.gain.setValueAtTime(0, t)
  g.gain.linearRampToValueAtTime(gain, t + 0.015)
  g.gain.exponentialRampToValueAtTime(0.001, t + dur)
  osc.connect(g); g.connect(ctx.destination)
  osc.start(t); osc.stop(t + dur + 0.05)
}

/** 唤醒成功: 上行"叮-咚"(清脆双音) */
function sfxWake(): void {
  tone(880, 0, 0.12, 'sine', 0.14)
  tone(1318, 0.11, 0.18, 'sine', 0.12)
}

/** 任务完成: 欢快三连琶音(C-E-G上行) */
function sfxDone(): void {
  tone(659, 0, 0.12, 'triangle', 0.13)
  tone(830, 0.10, 0.12, 'triangle', 0.12)
  tone(988, 0.20, 0.25, 'triangle', 0.12)
}

/** PCM(Float32 16k)直接编码wav base64——无webm容器/解码/拼接环节 */
function pcmToWavBase64(pcm: Float32Array): string {
  const len = pcm.length
  const wav = new ArrayBuffer(44 + len * 2)
  const view = new DataView(wav)
  const w = (off: number, str: string) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)) }
  w(0, 'RIFF'); view.setUint32(4, 36 + len * 2, true); w(8, 'WAVE')
  w(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  w(36, 'data'); view.setUint32(40, len * 2, true)
  for (let i = 0; i < len; i++) view.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, pcm[i]! * 32767)), true)
  const bytes = new Uint8Array(wav)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return btoa(bin)
}

async function wakeJudgePcm(pcm: Float32Array): Promise<void> {
  console.log(`[xg-wake] JUDGE-START pcm=${(pcm.length / 16000).toFixed(2)}s`)

  if (pcm.length < 8000) { console.log('[xg-wake] drop: too short'); return }
  try {
    // STT文字匹配路线: SeCo-Paraformer在海量人声上训练,天生认任何说话人
    // (实测: 用户真声'小乖小乖'识别为'小乖3乖'完全正确)。
    // 旧onnx模型只学过edge-tts合成音色,对真实人声0.002分——弃用。
    const wavB64 = pcmToWavBase64(pcm)
    const r = await fetch('/api/xiaoguai/voice/asr', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ audio_wav: wavB64 }),
    })
    console.log(`[xg-wake] asr fetch ${r.status}`)
    if (!r.ok) { setUi({ bubble: `⚠ 唤醒接口 ${r.status}`, bubbleAt: Date.now() }); return }
    const { text } = (await r.json()) as { text?: string }
    console.log(`[xg-wake] heard="${text ?? ''}"`)
    if ((text ?? '').length <= 16 && /小乖|小怪|晓乖|小乘/.test(text ?? '')) {
      setUi({ bubble: '我在听！', bubbleAt: Date.now() })
      sfxWake()
      void voiceStart()
    }
  } catch (e) { console.log('[xg-wake] JUDGE-ERR', e); setUi({ bubble: '⚠ 唤醒判定异常', bubbleAt: Date.now() }) }
}

function wakeStop(): void {
  const w = wake
  wake = null
  if (w === null) return
  window.clearInterval(w.timer)
  w.proc.onaudioprocess = null
  w.proc.disconnect()
  w.stream.getTracks().forEach(t => t.stop())
  void w.audioCtx.close()
}

/** 面板内语音区：声纹波形 + 说话/取消按钮 */
function VoicePanel(): ReactElement {
  const state = useSyncExternalStore(subscribe, () => ui)
  const [, force] = useState(0)
  useEffect(() => {
    const l = () => force(n => n + 1)
    voiceLevelListeners.add(l)
    return () => { voiceLevelListeners.delete(l) }
  }, [])
  const recording = state.local === 'listening'
  const bars = voiceLevels ?? []
  return createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } as React.CSSProperties },
    recording && createElement('div', {
      style: {
        display: 'flex', alignItems: 'center', gap: 2, height: 24,
        padding: '4px 6px', borderRadius: 6,
        background: 'rgba(30,41,59,0.8)',
      } as React.CSSProperties,
      'data-testid': 'voice-waveform',
    },
      // 声纹: 40根柱,高度=音量
      ...Array.from({ length: 40 }, (_, i) => {
        const v = bars[i] ?? 0
        const h = Math.max(2, Math.round(v * 20))
        return createElement('div', {
          key: i,
          style: {
            width: 3, height: h, borderRadius: 1,
            background: v > 0.12 ? '#34d399' : 'rgba(148,163,184,0.4)',   // 说话绿色,静默灰
            transition: 'height .08s linear',
          } as React.CSSProperties,
        })
      }),
    ),
    createElement('div', { style: { display: 'flex', gap: 6 } as React.CSSProperties },
      recording
        ? createElement('button', {
            type: 'button',
            onClick: () => { void voiceCancel() },
            style: { cursor: 'pointer', flex: 1 } as React.CSSProperties,
          }, '■ 取消')
        : createElement('button', {
            type: 'button',
            disabled: state.local !== null,   // 其他暂时态进行中禁用
            onClick: () => { void voiceStart() },
            style: { cursor: 'pointer', flex: 1 } as React.CSSProperties,
            title: '点击说话，说完停顿自动发送',
          }, '🎤 说话'),
    ),
  )
}

function XiaoguaiEntry(): ReactElement {
  const state = useSyncExternalStore(subscribe, () => ui)
  const visible = state.snapshot?.display.visible ?? true
  if (!visible) {
    // 召回按钮：贴边低调小圆钮（参考鲸鱼娘的召唤入口，不遮挡内容）
    return createElement('button', {
      type: 'button',
      'aria-label': '召回小乖',
      onClick: () => {
        void API.interact('summon').then(() => setUi({ snapshot: ui.snapshot ? { ...ui.snapshot, display: { ...ui.snapshot.display, visible: true } } : null }))
      },
      style: {
        position: 'fixed', right: 8, bottom: 8, zIndex: 2147483000,
        width: 30, height: 30, borderRadius: '50%',
        border: '1px solid rgba(148,163,184,0.5)',
        background: 'rgba(15,23,42,0.55)',
        color: '#cbd5e1', fontSize: 15, lineHeight: 1,
        cursor: 'pointer', padding: 0, opacity: 0.35,
        transition: 'opacity .15s',
      } as React.CSSProperties,
      onPointerEnter: (e: React.PointerEvent<HTMLButtonElement>) => { e.currentTarget.style.opacity = '1' },
      onPointerLeave: (e: React.PointerEvent<HTMLButtonElement>) => { e.currentTarget.style.opacity = '0.35' },
    }, '乖')
  }
  return createElement(XiaoguaiFloat)
}

function XiaoguaiFloat(): ReactElement {
  const state = useSyncExternalStore(subscribe, () => ui)
  const snapshot = state.snapshot
  const display = snapshot?.display ?? { size: 176, right: 24, bottom: 24, visible: true }

  // 动画选择：本地暂时态 > host 相位
  const animation: Animation = state.local ?? snapshot?.animation ?? 'idle'

  const spriteRef = useRef<HTMLDivElement | null>(null)
  const floatRef = useRef<HTMLDivElement | null>(null)
  /** 拖拽位置：React state 驱动（与鲸鱼娘 WhalePet 同构）。
   *  位置真相只有这一份 state + host 持久化值，style 带出；
   *  分身残影的真正来源是双挂载与精灵图首载空白，已在 apply()/预加载处修复。 */
  const [dragPos, setDragPos] = useState<{ right: number; bottom: number } | null>(null)
  const dragRef = useRef<{ startX: number; startY: number; right: number; bottom: number } | null>(null)
  const draggedRef = useRef(false)
  const [hovered, setHovered] = useState(false)
  const hidePanelTimer = useRef<number | null>(null)

  /** 悬停面板显示策略（修复点击死角）：
   *  面板贴着小乖头顶（无间隙）+ pointerleave 延迟 400ms 收起，
   *  鼠标从人物移到面板的路径全程都在 hit 区内 */
  const showPanel = (): void => {
    if (hidePanelTimer.current !== null) { window.clearTimeout(hidePanelTimer.current); hidePanelTimer.current = null }
    // 暂时态(摸头/投喂/庆祝)播放期间不弹面板,动画完整可见
    if (state.local !== null && state.local !== 'pet-drag') return
    setHovered(true)
  }
  const scheduleHidePanel = (): void => {
    if (hidePanelTimer.current !== null) window.clearTimeout(hidePanelTimer.current)
    hidePanelTimer.current = window.setTimeout(() => setHovered(false), 400)
  }
  const frameRef = useRef<{ anim: Animation | null; index: number; elapsed: number; finished: boolean }>({
    anim: null, index: 0, elapsed: 0, finished: false,
  })
  const animRef = useRef(animation)
  const prevAnimRef = useRef<Animation | null>(null)
  animRef.current = animation

  // 动画切换瞬间处理（扁平化/闪变治理）：
  // 切换时 React 重建 style 应用新 backgroundSize，但 rAF 的 backgroundPosition
  // 还是旧动画的像素偏移（如 -3168px），在新尺寸(5984px宽)下偏移语义突变，
  // 视觉呈现"压缩变形一瞬"。修法：在 React 提交新 style 的同一微任务里
  // 立即写入新动画首帧 position(0px 0)——不让旧偏移在新尺寸下存活任何一帧。
  useEffect(() => {
    if (prevAnimRef.current !== animation) {
      prevAnimRef.current = animation
      void ensureDecoded(animation)
      frameRef.current = { anim: null, index: 0, elapsed: 0, finished: false }
    }
  }, [animation])

  // 切换瞬间同步写新状态首帧（useLayoutEffect 在浏览器绘制前执行）。
  // 图集模式下图与尺寸不变,只是 position 的 y 换到新行——天然无中间态。
  useLayoutEffect(() => {
    const row = atlas?.rows[animation] ?? 0
    if (spriteRef.current !== null) {
      spriteRef.current.style.backgroundPosition = `0px -${row * display.size}px`
    }
  }, [animation, display.size])

  // 帧循环：rAF + meta 驱动（30fps 原速）；暂时态播完一轮停在末帧并回落
  // 时钟重构：单一绝对时钟 + 取模相位（消除循环重置丢相位导致的节奏抽搐；
  // 旧实现重置时 elapsed 截断丢 0.x 帧相位，每循环累计成肉眼可见的抖动）
  useEffect(() => {
    let raf = 0
    let last = performance.now()
    const tick = (ts: number): void => {
      const delta = ts - last
      last = ts
      const anim = animRef.current
      const fps = atlas?.fps ?? 30
      const frameCount = atlas?.frames[anim] ?? 1
      const row = atlas?.rows[anim] ?? 0
      const st = frameRef.current
      if (st.anim !== anim) { st.anim = anim; st.index = 0; st.elapsed = 0; st.finished = false }
      if (!st.finished) {
        st.elapsed += delta
        const frameMs = 1000 / fps
        if (isTransient(anim)) {
          while (st.elapsed >= frameMs && st.index < frameCount - 1) {
            st.elapsed -= frameMs
            st.index += 1
          }
          if (st.elapsed >= frameMs) {
            st.index = frameCount - 1
            st.finished = true
            // 只有local仍是本动画时才回落——播报流程(done→speaking交接)
            // 可能已把local切到speaking,不能误清(播报中显示idle的根因)
            if (anim !== 'pet-drag' && ui.local === anim) setUi({ local: null })
          }
        } else {
          const phase = st.elapsed % (frameMs * frameCount)
          st.index = Math.floor(phase / frameMs)
        }
      }
      if (spriteRef.current !== null) {
        // 图集坐标: x=帧列 y=状态行(切换只动这两个数,图与尺寸永不变)
        spriteRef.current.style.backgroundPosition = `-${st.index * display.size}px -${row * display.size}px`
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [display.size])

  // 气泡 2.6s 自动消散
  useEffect(() => {
    if (state.bubble === null) return
    const t = window.setTimeout(() => setUi({ bubble: null }), 2600)
    return () => window.clearTimeout(t)
  }, [state.bubbleAt])

  const clearDrag = (): void => {
    dragRef.current = null
    setUi({ local: null })   // 拖拽结束一律回落（用户反馈修复）
  }

  const size = display.size
  const rawPos = dragPos ?? { right: display.right, bottom: display.bottom }
  // 渲染前钳制: 持久化位置可能来自旧窗口尺寸/异常拖拽,一律拉回视口内
  const pos = {
    right: Math.max(0, Math.min(rawPos.right, window.innerWidth - 60)),
    bottom: Math.max(0, Math.min(rawPos.bottom, window.innerHeight - 60)),
  }

  const float = createElement('div', {
    ref: floatRef,
    style: {
      position: 'fixed', right: pos.right, bottom: pos.bottom, zIndex: 2147483000,
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      userSelect: 'none', WebkitUserSelect: 'none',
      // GPU合成层隔离: WebView2下fixed元素高频改right/bottom会出现
      // 合成器与主文档更新不同步的"残影/第二个小乖"——
      // 提升为独立合成层后位置变化不再牵动主文档重排
      willChange: 'right, bottom',
      transform: 'translateZ(0)',
      backfaceVisibility: 'hidden',
    } as React.CSSProperties,
    onPointerEnter: showPanel,
    onPointerLeave: scheduleHidePanel,
  },
    createElement('div', {
      ref: spriteRef,
      role: 'button',
      'aria-label': '小乖',
      style: {
        width: size, height: size,
        // 单图集: backgroundImage/Size 恒定不随动画变(动画只改position)
        // 图集失效时以边框占位提示(不隐身)
        border: atlasBroken ? '2px dashed #f59e0b' : undefined,
        backgroundImage: 'url(/xiaoguai/assets/atlas.webp)',
        backgroundSize: `${size * (atlas ? Math.max(...Object.values(atlas.frames)) : 34)}px ${size * (atlas ? Object.keys(atlas.rows).length : 10)}px`,
        backgroundRepeat: 'no-repeat',
        // backgroundPosition 不归 React 管（rAF 直写,x=帧列y=状态行）
        imageRendering: 'auto',
        touchAction: 'none',
        cursor: dragRef.current === null ? 'grab' : 'grabbing',
      } as React.CSSProperties,
      onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
        e.preventDefault()
        ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
        setHovered(false)   // 按下即收面板：摸头气泡不被面板遮挡（用户反馈#3）
        void ensureDecoded('pet-drag')
        // 锚点取"当前真实渲染位置"——DOM rect 是唯一不骗人的来源
        const rect = floatRef.current?.getBoundingClientRect()
        const current = rect !== undefined
          ? { right: Math.max(0, window.innerWidth - rect.right), bottom: Math.max(0, window.innerHeight - rect.bottom) }
          : { right: display.right, bottom: display.bottom }
        dragRef.current = { startX: e.clientX, startY: e.clientY, ...current }
        draggedRef.current = false
      },
      onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
        const drag = dragRef.current
        if (drag === null) return
        const dx = e.clientX - drag.startX
        const dy = e.clientY - drag.startY
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
          if (!draggedRef.current) {
            draggedRef.current = true
            setUi({ local: 'pet-drag' })   // 开始真拖拽才切拎起动画
          }
        }
        const right = Math.max(0, Math.min(drag.right - dx, window.innerWidth - 40))
        const bottom = Math.max(0, Math.min(drag.bottom - dy, window.innerHeight - 40))
        // 铁律（鲸鱼娘同款）：move 中绝不改写 dragRef！
        // dragRef.right 必须保持"按下时的锚点"，位移 = 锚点 - (client - startX)。
        // 一旦在 move 里更新 right，下一步就从新位置起算 → 位移按步幅累加，
        // 鼠标折返时误差指数放大 = "快速漂移"的真凶（数学实锤：1160+80≠1120+80）。
        setDragPos({ right, bottom })
      },
      onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => {
        if (dragRef.current === null) return
        const wasDrag = draggedRef.current
        // 松手位置：直接用锚点+总位移重算（与最后一次 move 同公式），
        // 不依赖任何中间状态
        const drag = dragRef.current
        const dx = e.clientX - drag.startX
        const dy = e.clientY - drag.startY
        const finalPos = wasDrag
          ? {
              right: Math.max(0, Math.min(drag.right - dx, window.innerWidth - 40)),
              bottom: Math.max(0, Math.min(drag.bottom - dy, window.innerHeight - 40)),
            }
          : null
        dragRef.current = null
        setUi({ local: null })   // 拖拽结束一律回落
        if (finalPos !== null) {
          void API.interact('dragEnd', finalPos)
        } else {
          // 单击 = 摸头（只播一次）
          void API.interact('pat').then(r => { if (r.bubble) setUi({ bubble: r.bubble, bubbleAt: Date.now() }) })
          setUi({ local: 'pet-pat' })
        }
      },
    }),
    state.bubble !== null && createElement('div', {
      key: state.bubbleAt,
      style: {
        position: 'absolute', bottom: '100%', marginBottom: 2,
        whiteSpace: 'nowrap', padding: '4px 10px', borderRadius: 999,
        fontSize: 12, color: '#fff', background: 'rgba(244,114,182,0.92)',
        boxShadow: '0 2px 8px rgba(0,0,0,0.25)', pointerEvents: 'none',
      } as React.CSSProperties,
    }, state.bubble),
    hovered && dragRef.current === null && createElement('div', {
      onPointerEnter: showPanel,
      onPointerLeave: scheduleHidePanel,
      style: {
        // 贴着小乖头顶零间隙（+400ms 缓冲），鼠标移向面板全程在 hit 区
        position: 'absolute', bottom: '100%', marginBottom: 0,
        background: 'rgba(15,23,42,0.92)', border: '1px solid rgba(148,163,184,0.35)',
        borderRadius: 10, padding: '8px 10px', color: '#e2e8f0', fontSize: 12,
        display: 'flex', flexDirection: 'column', gap: 6, minWidth: 128,
      } as React.CSSProperties,
    },
      createElement('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8 } as React.CSSProperties },
        createElement('span', null, `${snapshot?.affinity.rankEmoji ?? '🌱'} 小乖 · ${snapshot?.affinity.rank ?? '初识'}`),
        createElement('span', { style: { opacity: 0.7 } as React.CSSProperties }, `${snapshot?.affinity.points ?? 0} 分`),
      ),
      createElement('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8, opacity: 0.75 } as React.CSSProperties },
        createElement('span', null, `摸头 ${snapshot?.affinity.pets ?? 0}`),
        createElement('span', null, `投喂 ${snapshot?.affinity.feeds ?? 0}`),
        createElement('span', null, `陪工 ${snapshot?.affinity.turns ?? 0}`),
      ),
      createElement(VoicePanel),
      createElement('div', { style: { display: 'flex', gap: 6 } as React.CSSProperties },
        createElement('button', {
          type: 'button',
          disabled: snapshot?.affinity.feedCooldown === true,
          onClick: () => {
            void API.interact('feed').then(r => { if (r.bubble) setUi({ bubble: r.bubble, bubbleAt: Date.now() }) })
            setUi({ local: 'pet-feed' })
          },
          style: { cursor: 'pointer', flex: 1 } as React.CSSProperties,
        }, snapshot?.affinity.feedCooldown === true ? '嚼着呢…' : '投喂'),
        createElement('button', {
          type: 'button',
          onClick: () => {
            void API.interact('hide')
            setUi({ snapshot: ui.snapshot ? { ...ui.snapshot, display: { ...ui.snapshot.display, visible: false } } : null })
          },
          style: { cursor: 'pointer', flex: 1 } as React.CSSProperties,
        }, '隐藏'),
      ),
    ),
  )
  // 不用 createPortal：portal 节点挂在 document.body 上，即使插件容器被
  // remove 它仍存活（旧 bundle 的分身杀不死的原因）。
  // 本组件本来就渲染在 body 下的专属容器里，直接返回元素即可。
  return float
}
