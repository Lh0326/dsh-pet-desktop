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
import { createElement, useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { createPortal } from 'react-dom'

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

/** 素材元数据（启动时逐状态拉取） */
interface Meta { frameSize: number; frameCount: number; fps: number }
const metas = new Map<Animation, Meta>()

async function loadMetas(): Promise<void> {
  const states: Animation[] = ['idle','thinking','working','confirm','done','listening','speaking','pet-drag','pet-pat','pet-feed']
  await Promise.all(states.map(async s => {
    const r = await fetch(`/xiaoguai/assets/${s}.meta.json`)
    if (r.ok) metas.set(s, await r.json())
  }))
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

/** 精灵图预加载（消除动画切换时的首次加载空白——"分身/闪白"的第二来源） */
const preloaded = new Set<string>()
function preloadSpritesheet(a: Animation): void {
  if (preloaded.has(a)) return
  preloaded.add(a)
  const img = new Image()
  img.src = `/xiaoguai/assets/${a}_spritesheet.png`
}

export function apply(): (() => void) | void {
  // 双挂载防护：dsh 页面热重载/插件重启用时，旧浮层必须先清理，
  // 否则两个 React root 各画一只小乖（"分身"的第一来源）
  document.querySelectorAll('div[data-xiaoguai-pet-root]').forEach(el => el.remove())
  void loadMetas()

  const container = document.createElement('div')
  container.dataset.xiaoguaiPetRoot = ''
  document.body.appendChild(container)
  const root = createRoot(container)
  root.render(createElement(XiaoguaiEntry))

  const poll = (): void => {
    API.state().then(s => {
      setUi({ snapshot: s })
    }, () => { /* transport 失败下轮重试 */ })
  }
  poll()
  const timer = window.setInterval(() => {
    if (document.visibilityState === 'visible') poll()
  }, 800)

  return () => {
    window.clearInterval(timer)
    root.unmount()
    container.remove()
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
  /** 位置真相只在 ref（命令式世界）：React 渲染永远不带 right/bottom，
   *  重渲染不会覆写位置 → 根治轮询/动画切换时的位置跳变（分身根因） */
  const posRef = useRef<{ right: number; bottom: number } | null>(null)
  const dragRef = useRef<{ startX: number; startY: number; right: number; bottom: number } | null>(null)
  const draggedRef = useRef(false)
  const [hovered, setHovered] = useState(false)
  const hidePanelTimer = useRef<number | null>(null)

  // 位置同步 effect：posRef 变化（含 host 快照里的持久化位置）→ 直写 DOM。
  // 只在"非拖拽中"执行，拖拽由 pointermove 直写。
  useEffect(() => {
    const target = posRef.current ?? { right: display.right, bottom: display.bottom }
    if (floatRef.current !== null && dragRef.current === null) {
      floatRef.current.style.right = `${target.right}px`
      floatRef.current.style.bottom = `${target.bottom}px`
    }
  })

  /** 悬停面板显示策略（修复点击死角）：
   *  面板贴着小乖头顶（无间隙）+ pointerleave 延迟 400ms 收起，
   *  鼠标从人物移到面板的路径全程都在 hit 区内 */
  const showPanel = (): void => {
    if (hidePanelTimer.current !== null) { window.clearTimeout(hidePanelTimer.current); hidePanelTimer.current = null }
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

  // 动画切换瞬间（React 重建了 style）同步补写首帧位置 + 预加载新精灵图，
  // 消除一帧空白/旧帧闪现（分身残影的第三来源：图片未加载完成时 backgroundImage 短暂为空）
  useEffect(() => {
    if (prevAnimRef.current !== animation) {
      prevAnimRef.current = animation
      preloadSpritesheet(animation)
      frameRef.current = { anim: null, index: 0, elapsed: 0, finished: false }
      if (spriteRef.current !== null) {
        spriteRef.current.style.backgroundPosition = '0px 0'
      }
    }
  }, [animation])

  // 帧循环：rAF + meta 驱动（30fps 原速）；暂时态播完一轮停在末帧并回落
  useEffect(() => {
    let raf = 0
    let last = performance.now()
    const FRAME_MS = 1000 / 30
    const tick = (ts: number): void => {
      const delta = ts - last
      last = ts
      const anim = animRef.current
      const meta = metas.get(anim) ?? { frameSize: 512, frameCount: 1, fps: 30 }
      const st = frameRef.current
      if (st.anim !== anim) { st.anim = anim; st.index = 0; st.elapsed = 0; st.finished = false }
      if (!st.finished) {
        st.elapsed += delta
        const frameMs = 1000 / meta.fps
        while (st.elapsed >= frameMs && st.index < meta.frameCount - 1) {
          st.elapsed -= frameMs
          st.index += 1
        }
        if (st.elapsed >= frameMs) {
          if (isTransient(anim)) {
            st.index = meta.frameCount - 1
            st.finished = true
            // 播完一次 → 回落 idle（拖拽例外：pointerup 才回落）
            if (anim !== 'pet-drag') setUi({ local: null })
          } else {
            st.elapsed = 0
            st.index = 0
          }
        }
      }
      if (spriteRef.current !== null) {
        spriteRef.current.style.backgroundPosition = `-${st.index * display.size}px 0`
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

  const float = createElement('div', {
    ref: floatRef,
    style: {
      // right/bottom 不在此！位置 100% 由 posRef effect + pointermove 直写。
      // React style diff 一旦拥有过的属性，任何重渲染都可能用旧值覆写命令式写入，
      // 这是分身残影的根本来源。位置属性从头到尾不给 React。
      position: 'fixed', zIndex: 2147483000,
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      userSelect: 'none', WebkitUserSelect: 'none',
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
        backgroundImage: `url(/xiaoguai/assets/${animation}_spritesheet.png)`,
        backgroundSize: `${size * (metas.get(animation)?.frameCount ?? 1)}px ${size}px`,
        backgroundRepeat: 'no-repeat',
        // backgroundPosition 同理不归 React 管（rAF 直写）
        imageRendering: 'auto',
        touchAction: 'none',
        cursor: dragRef.current === null ? 'grab' : 'grabbing',
      } as React.CSSProperties,
      onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
        e.preventDefault()
        ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
        setHovered(false)   // 按下即收面板：摸头气泡不被面板遮挡（用户反馈#3）
        preloadSpritesheet('pet-drag')
        const rect = floatRef.current?.getBoundingClientRect()
        const current = rect !== undefined
          ? { right: window.innerWidth - rect.right, bottom: window.innerHeight - rect.bottom }
          : (posRef.current ?? { right: display.right, bottom: display.bottom })
        posRef.current = current
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
        dragRef.current = { ...drag, right, bottom }
        posRef.current = { right, bottom }
        if (floatRef.current !== null) {
          floatRef.current.style.right = `${right}px`
          floatRef.current.style.bottom = `${bottom}px`
        }
      },
      onPointerUp: () => {
        if (dragRef.current === null) return
        const wasDrag = draggedRef.current
        const finalPos = { right: dragRef.current.right, bottom: dragRef.current.bottom }
        clearDrag()
        if (wasDrag) {
          posRef.current = finalPos
          void API.interact('dragEnd', finalPos).then(() => {
            // host 确认后的下一轮快照会带新位置；effect 用 posRef 优先，不会跳回旧值
          })
        } else if (!wasDrag) {
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
  return createPortal(float, document.body)
}
