/**
 * 小乖桌宠 host 半区 — 状态机（session/event → 动画相位）+ 显示配置持久化 + API/素材路由。
 * 架构复刻 @linxin666/dsh-pet（鲸鱼娘）：turn/step/tool 事件驱动、
 * 浏览器半区轮询 /api/xiaoguai/state、素材经 /xiaoguai/assets/* 自足服务。
 * @module dsh-xiaoguai-pet
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
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

/** 好感度体系（参考鲸鱼娘：点数+等级+统计） */
export interface XiaoguaiAffinity {
  points: number
  rank: string
  rankEmoji: string
  pets: number
  feeds: number
  turns: number
  patCooldown: boolean
  feedCooldown: boolean
}

const RANKS: { threshold: number; name: string; emoji: string }[] = [
  { threshold: 0, name: '初识', emoji: '🌱' },
  { threshold: 20, name: '熟悉', emoji: '🍀' },
  { threshold: 60, name: '伙伴', emoji: '✨' },
  { threshold: 150, name: '挚友', emoji: '💖' },
]

function rankOf(points: number): { name: string; emoji: string } {
  let r = RANKS[0]
  for (const cand of RANKS) if (points >= cand.threshold) r = cand
  return { name: r.name, emoji: r.emoji }
}

const PAT_COOLDOWN_MS = 3000
/** 投喂冷却与喂食动画时长对齐（24帧@30fps ≈ 0.8s）+ 少量缓冲 */
const FEED_COOLDOWN_MS = 4000

export interface XiaoguaiStateView {
  animation: XiaoguaiAnimation
  phase: ActivityPhase
  sessionActive: boolean
  bubble?: string
  display: XiaoguaiDisplay
  affinity: XiaoguaiAffinity
  /** 最近助手回复文本(截断,语音播报用) */
  lastReply: string
}

interface PersistShape {
  display: XiaoguaiDisplay
  affinity?: { points: number; pets: number; feeds: number; turns: number }
}

/** 诊断探针：atlas 被浏览器实际拉取的次数（排查"隐身"用） */
let __atlasHits = 0
export function atlasHits(): number { return __atlasHits }
export function bumpAtlasHits(): void { __atlasHits += 1 }

/** 小乖服务 */
export class XiaoguaiService extends Service {
  static inject: string[] = []

  private phase: ActivityPhase = 'idle'
  private sessionActive = false
  private celebrateUntil = 0
  private display: XiaoguaiDisplay = { size: 176, right: 24, bottom: 24, visible: true }
  private affinity = { points: 0, pets: 0, feeds: 0, turns: 0 }
  private lastPatAt = 0
  private lastFeedAt = 0
  /** 最近一条助手回复文本（语音播报用），按会话 seq 去重 */
  private lastAssistantText = ''
  private lastAssistantSeq = 0
  /** 最近收到事件的会话(voice/send优先投递目标,取代list().at(-1)的
   *  注册序猜测——孤儿会话曾导致followup投进死会话,turn静默不跑) */
  private lastActiveSessionId = ''
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
      if (loaded.affinity) this.affinity = { ...this.affinity, ...loaded.affinity }
    } catch { /* 首次运行无持久化文件 */ }

    ctx.on('session/event', (s: Session, event: SessionEvent) => {
      this.lastActiveSessionId = String(s.id)
      switch (event.type) {
        case 'assistant/message': {
          // 缓存最后一条模型回复文本(供语音播报取用;只认 source.kind==='model',
          // 排除 agent setup 等非模型来源)
          const msg = (event.data as { message?: { content?: Array<{ type: string; text?: string }>; source?: { kind?: string } } }).message
          if (msg?.content !== undefined && msg?.source?.kind === 'model') {
            const seq = (event as unknown as { seq?: number }).seq ?? 0
            if (seq > this.lastAssistantSeq) {
              const text = msg.content
                .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
                .map(b => b.text).join('').trim()
              if (text.length > 0) {
                this.lastAssistantText = text
                this.lastAssistantSeq = seq
              }
            }
          }
          break
        }
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
            this.affinity.turns += 1
            this.affinity.points += 2   // 陪小乖干完一轮活的奖励
            this.save()
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
      writeFileSync(this.persistPath, JSON.stringify({ display: this.display, affinity: this.affinity }, null, 2))
    } catch { /* 持久化失败不致命 */ }
  }

  private affinityView(): XiaoguaiAffinity {
    const { name, emoji } = rankOf(this.affinity.points)
    const now = Date.now()
    return {
      points: this.affinity.points,
      rank: name,
      rankEmoji: emoji,
      pets: this.affinity.pets,
      feeds: this.affinity.feeds,
      turns: this.affinity.turns,
      patCooldown: now - this.lastPatAt < PAT_COOLDOWN_MS,
      feedCooldown: now - this.lastFeedAt < FEED_COOLDOWN_MS,
    }
  }

  /** RPC: 状态快照 */
  state(): XiaoguaiStateView {
    this.settle()
    return {
      animation: animationForPhase(this.phase),
      phase: this.phase,
      sessionActive: this.sessionActive,
      display: { ...this.display },
      affinity: this.affinityView(),
      /** 最近助手回复(截断,语音播报轮询用) */
      lastReply: this.lastAssistantText.slice(0, 800),
    }
  }

  /** RPC: 互动（含好感度结算，参考鲸鱼娘） */
  interact(kind: 'pat' | 'feed' | 'dragEnd' | 'hide' | 'summon', payload?: { right?: number; bottom?: number }): { animation: XiaoguaiAnimation; bubble?: string; delta?: number; affinity?: XiaoguaiAffinity } {
    const now = Date.now()
    switch (kind) {
      case 'pat': {
        const onCooldown = now - this.lastPatAt < PAT_COOLDOWN_MS
        if (!onCooldown) {
          this.lastPatAt = now
          this.affinity.pets += 1
          this.affinity.points += 1
          this.save()
        }
        const replies = ['小乖舒服地眯起了眼~', '再摸摸头也很开心！', '小乖的头发被摸乱了啦~']
        return {
          animation: 'pet-pat',
          bubble: onCooldown ? '小乖有点被摸晕了…' : replies[this.affinity.pets % replies.length],
          delta: onCooldown ? 0 : 1,
          affinity: this.affinityView(),
        }
      }
      case 'feed': {
        const onCooldown = now - this.lastFeedAt < FEED_COOLDOWN_MS
        if (onCooldown) {
          return { animation: 'pet-feed', bubble: '小乖还嚼着呢，等等再喂~', delta: 0, affinity: this.affinityView() }
        }
        this.lastFeedAt = now
        this.affinity.feeds += 1
        this.affinity.points += 3
        this.save()
        return { animation: 'pet-feed', bubble: '小乖吃得腮帮鼓鼓的！+3 好感', delta: 3, affinity: this.affinityView() }
      }
      case 'dragEnd':
        if (payload?.right !== undefined && payload?.bottom !== undefined) {
          // 持久化前钳制到合理范围（视口内）：异常位置不出现在存储里
          this.display.right = Math.max(0, Math.min(Math.round(payload.right), 4000))
          this.display.bottom = Math.max(0, Math.min(Math.round(payload.bottom), 4000))
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

  /** 语音链路终点：把识别文本投递到当前活跃会话（无会话则自动建一个） */
  async voiceSend(text: string): Promise<{ ok: boolean; error?: string; bubble: string }> {
    const trimmed = text.trim()
    if (trimmed.length === 0) return { ok: false, error: 'empty', bubble: '小乖没听清，再说一次？' }
    try {
      const agents = this.ctx.agents
      // 优先最近活跃会话(事件驱动追踪),fallback注册序最后——
      // 曾因拿到孤儿会话导致followup静默无响应(回复0字,播报无概括)
      let agent = this.lastActiveSessionId !== ''
        ? agents.list().find(a => String(a.session.id) === this.lastActiveSessionId)
        : undefined
      if (agent === undefined) agent = agents.list().at(-1)
      if (agent === undefined) {
        // 没有会话——创建一个（cwd 用默认工作区）
        const { randomUUID } = await import('node:crypto')
        const created = await agents.create({
          sessionId: `xiaoguai-${randomUUID()}` as never,
          meta: { cwd: process.cwd() },
        })
        agent = created.agent
      }
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: trimmed }],   // 原文投递(精简在播报层做)
        source: { kind: 'user' },
      }))
      return { ok: true, bubble: '' }   // 识别回显气泡已足够,不加重复提示
    } catch (error) {
      return { ok: false, error: String(error), bubble: '发送失败了…' }
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    xiaoguai: XiaoguaiService
  }
}

export const name = 'xiaoguai-pet'
export const inject = ['webServer', 'agents']

export function apply(ctx: Context): void {
  const service = new XiaoguaiService(ctx)
  // Service 构造时已向 ctx 注册（super(ctx,'xiaoguai')）；apply 只挂路由
  const routes = makeXiaoguaiRoutes({ service, packageRoot: packageRootFrom(import.meta.url) })
  const disposers = routes.map((route) => ctx.webServer.register(route))
  ctx.effect(() => () => { for (const dispose of disposers) dispose() }, 'xiaoguai: routes')
}

function packageRootFrom(importMetaUrl: string): string {
  // esbuild 打包后 import.meta.url 指向 lib/index.js，包根为其上级
  return dirname(dirname(new URL(importMetaUrl).pathname.replace(/^\/([A-Za-z]:)/, '$1')))
}
