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

  const container = document.createElement('div')
  container.dataset.xiaoguaiPetRoot = ''
  document.body.appendChild(container)
  const root = createRoot(container)
  root.render(createElement(XiaoguaiEntry))

  const poll = (): void => {
    if (!me.alive) return
    API.state().then(s => {
      if (me.alive) setUi({ snapshot: s })
    }, () => { /* transport 失败下轮重试 */ })
  }
  poll()
  me.timer = window.setInterval(() => {
    if (me.alive && document.visibilityState === 'visible') poll()
  }, 800)

  me.dispose = () => {
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
            if (anim !== 'pet-drag') setUi({ local: null })
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
