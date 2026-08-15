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

export function apply(): void {
  void loadMetas()

  const container = document.createElement('div')
  container.dataset.xiaoguaiPetRoot = ''
  document.body.appendChild(container)
  const root = createRoot(container)
  root.render(createElement(XiaoguaiEntry))

  const poll = (): void => {
    API.state().then(s => {
      // host 相位变化时清除本地暂时态（除非正在拖拽中）
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
    return createElement('button', {
      onClick: () => { void API.interact('summon').then(() => setUi({ snapshot: ui.snapshot ? { ...ui.snapshot, display: { ...ui.snapshot.display, visible: true } } : null })) },
      style: { position: 'fixed', right: 24, bottom: 24, zIndex: 2147483000 } as React.CSSProperties,
    }, '呼唤小乖')
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
  const [dragPos, setDragPos] = useState<{ right: number; bottom: number } | null>(null)
  const dragRef = useRef<{ startX: number; startY: number; right: number; bottom: number } | null>(null)
  const draggedRef = useRef(false)
  const [hovered, setHovered] = useState(false)
  const frameRef = useRef<{ anim: Animation | null; index: number; elapsed: number; finished: boolean }>({
    anim: null, index: 0, elapsed: 0, finished: false,
  })
  const animRef = useRef(animation)
  animRef.current = animation

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

  const pos = dragPos ?? { right: display.right, bottom: display.bottom }
  const size = display.size

  const float = createElement('div', {
    style: {
      position: 'fixed', right: pos.right, bottom: pos.bottom, zIndex: 2147483000,
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      userSelect: 'none', WebkitUserSelect: 'none',
    } as React.CSSProperties,
    onPointerEnter: () => setHovered(true),
    onPointerLeave: () => { setHovered(false) },
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
        backgroundPosition: '0 0',
        imageRendering: 'auto',
        touchAction: 'none',
        cursor: dragRef.current === null ? 'grab' : 'grabbing',
      } as React.CSSProperties,
      onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
        e.preventDefault()
        ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
        const current = dragPos ?? { right: display.right, bottom: display.bottom }
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
        setDragPos({ right, bottom })
      },
      onPointerUp: () => {
        if (dragRef.current === null) return
        const wasDrag = draggedRef.current
        clearDrag()
        if (wasDrag && dragPos !== null) {
          void API.interact('dragEnd', dragPos)
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
        position: 'absolute', bottom: '100%', marginBottom: 6,
        whiteSpace: 'nowrap', padding: '4px 10px', borderRadius: 999,
        fontSize: 12, color: '#fff', background: 'rgba(244,114,182,0.92)',
        boxShadow: '0 2px 8px rgba(0,0,0,0.25)', pointerEvents: 'none',
      } as React.CSSProperties,
    }, state.bubble),
    hovered && dragRef.current === null && createElement('div', {
      style: {
        position: 'absolute', bottom: '100%', marginBottom: 6,
        background: 'rgba(15,23,42,0.92)', border: '1px solid rgba(148,163,184,0.35)',
        borderRadius: 10, padding: '8px 10px', color: '#e2e8f0', fontSize: 12,
        display: 'flex', gap: 6,
      } as React.CSSProperties,
    },
      createElement('button', {
        type: 'button',
        onClick: () => {
          void API.interact('feed').then(r => { if (r.bubble) setUi({ bubble: r.bubble, bubbleAt: Date.now() }) })
          setUi({ local: 'pet-feed' })
        },
        style: { cursor: 'pointer' },
      }, '投喂'),
      createElement('button', {
        type: 'button',
        onClick: () => {
          void API.interact('hide')
          setUi({ snapshot: ui.snapshot ? { ...ui.snapshot, display: { ...ui.snapshot.display, visible: false } } : null })
        },
        style: { cursor: 'pointer' },
      }, '隐藏'),
    ),
  )
  return createPortal(float, document.body)
}
