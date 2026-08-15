/**
 * 小乖桌宠 host 半区 — 状态机（session/event → 动画相位）+ 显示配置持久化 + API/素材路由。
 * 架构复刻 @linxin666/dsh-pet（鲸鱼娘）：turn/step/tool 事件驱动、
 * 浏览器半区轮询 /api/xiaoguai/state、素材经 /xiaoguai/assets/* 自足服务。
 * @module dsh-xiaoguai-pet
 */
import { Context, Service } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { makeXiaoguaiRoutes } from './routes.ts'

/** 小乖动画契约：与 assets/<state>.meta.json 一一对应 */
export type XiaoguaiAnimation =
  | 'idle' | 'thinking' | 'working' | 'confirm' | 'done'
  | 'listening' | 'speaking'
  | 'pet-drag' | 'pet-pat' | 'pet-feed'

export type ActivityPhase = 'idle' | 'waiting' | 'thinking' | 'tool' | 'done'

/** 相位 → 动画（working=搬砖 confirm=挥手求确认 done=庆祝） */
export function animationForPhase(phase: ActivityPhase): XiaoguaiAnimation {
  switch (phase) {
    case 'thinking': return 'thinking'
    case 'tool': return 'working'
    case 'waiting': return 'confirm'
    case 'done': return 'done'
    case 'idle': return 'idle'
  }
}

export interface XiaoguaiDisplay { size: number; right: number; bottom: number; visible: boolean }

export interface XiaoguaiStateView {
  animation: XiaoguaiAnimation
  phase: ActivityPhase
  sessionActive: boolean
  bubble?: string
  display: XiaoguaiDisplay
}

interface PersistShape { display: XiaoguaiDisplay }

/** 小乖服务 */
export class XiaoguaiService extends Service {
  static inject: string[] = []

  private phase: ActivityPhase = 'idle'
  private sessionActive = false
  private celebrateUntil = 0
  private display: XiaoguaiDisplay = { size: 176, right: 24, bottom: 24, visible: true }
  private readonly persistPath: string

  constructor(ctx: Context) {
    super(ctx, 'xiaoguai')
    const home = process.env.DSH_HOME
    this.persistPath = home !== undefined && home !== ''
      ? join(home, 'xiaoguai.json')
      : join(process.env.USERPROFILE ?? '.', '.dsh', 'xiaoguai.json')
    try {
      const loaded = JSON.parse(readFileSync(this.persistPath, 'utf8')) as PersistShape
      if (loaded.display) this.display = { ...this.display, ...loaded.display }
    } catch { /* 首次运行无持久化文件 */ }

    ctx.on('session/event', (_s: Session, event: SessionEvent) => {
      switch (event.type) {
        case 'turn/start':
          this.sessionActive = true
          break
        case 'step/start':
          this.sessionActive = true
          this.phase = 'thinking'
          break
        case 'tool/call':
          this.sessionActive = true
          this.phase = 'tool'
          break
        case 'turn/end':
          this.sessionActive = true
          if (event.data.reason.kind === 'completed') {
            this.phase = 'done'
            this.celebrateUntil = Date.now() + 4000
          } else {
            this.phase = 'idle'
          }
          break
        default:
          break
      }
    })
    ctx.on('session/disposed', () => {
      this.sessionActive = false
      this.phase = 'idle'
    })
  }

  private settle(): void {
    if (this.phase === 'done' && Date.now() >= this.celebrateUntil) this.phase = 'idle'
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true })
      writeFileSync(this.persistPath, JSON.stringify({ display: this.display }, null, 2))
    } catch { /* 持久化失败不致命 */ }
  }

  /** RPC: 状态快照 */
  state(): XiaoguaiStateView {
    this.settle()
    return {
      animation: animationForPhase(this.phase),
      phase: this.phase,
      sessionActive: this.sessionActive,
      display: { ...this.display },
    }
  }

  /** RPC: 互动 */
  interact(kind: 'pat' | 'feed' | 'dragEnd' | 'hide' | 'summon', payload?: { right?: number; bottom?: number }): { animation: XiaoguaiAnimation; bubble?: string } {
    switch (kind) {
      case 'pat':
        return { animation: 'pet-pat', bubble: '小乖舒服地眯起了眼~' }
      case 'feed':
        return { animation: 'pet-feed', bubble: '小乖吃得腮帮鼓鼓的！' }
      case 'dragEnd':
        if (payload?.right !== undefined && payload?.bottom !== undefined) {
          this.display.right = Math.max(0, Math.round(payload.right))
          this.display.bottom = Math.max(0, Math.round(payload.bottom))
          this.save()
        }
        return { animation: this.state().animation }
      case 'hide':
        this.display.visible = false
        this.save()
        return { animation: 'idle', bubble: undefined }
      case 'summon':
        this.display.visible = true
        this.save()
        return { animation: 'idle' }
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    xiaoguai: XiaoguaiService
  }
}

export const name = 'xiaoguai-pet'
export const inject = ['webServer']

export function apply(ctx: Context): void {
  const service = new XiaoguaiService(ctx)
  ctx.service('xiaoguai', service, true)

  // 注册 API + 素材路由（与鲸鱼娘 /api/pet/* 同模式）
  const routes = makeXiaoguaiRoutes({ service, packageRoot: packageRootFrom(import.meta.url) })
  const disposers = routes.map((route) => ctx.webServer.register(route))
  ctx.effect(() => () => { for (const dispose of disposers) dispose() }, 'xiaoguai: routes')
}

function packageRootFrom(importMetaUrl: string): string {
  // esbuild 打包后 import.meta.url 指向 lib/index.js，包根为其上级
  return dirname(dirname(new URL(importMetaUrl).pathname.replace(/^\/([A-Za-z]:)/, '$1')))
}
