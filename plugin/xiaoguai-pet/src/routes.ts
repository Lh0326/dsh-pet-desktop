/**
 * 小乖 HTTP 路由 — 浏览器半区经同源 /api/xiaoguai/* JSON 端点通信，
 * 素材从 /xiaoguai/assets/* 加载。与 dsh-pet 的 /api/pet/* 同一模式。
 * @module dsh-xiaoguai-pet/routes
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { XiaoguaiService } from './index.ts'

export const XG_API_PREFIX = '/api/xiaoguai'
export const XG_ASSET_PREFIX = '/xiaoguai/assets'

/** 暴露的素材清单（10 状态精灵图 + meta） */
const ASSET_STATES = [
  'idle', 'thinking', 'working', 'confirm', 'done',
  'listening', 'speaking', 'pet-drag', 'pet-pat', 'pet-feed',
] as const

export function xgPackageRoot(importMetaUrl: string): string {
  return fileURLToPath(new URL('../', importMetaUrl))
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function requireMethod(req: IncomingMessage, res: ServerResponse, method: string): boolean {
  if (req.method === method) return true
  json(res, 405, { ok: false, error: 'method-not-allowed' })
  return false
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 16 * 1024) {
        reject(new Error('body-too-large'))
        queueMicrotask(() => req.destroy())
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) { resolve({}); return }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch { reject(new Error('invalid-json')) }
    })
    req.on('error', reject)
  })
}

function getRoute(path: string, run: () => Promise<unknown> | unknown): WebRoute {
  return {
    kind: 'exact', path,
    handler: (req, res) => {
      if (!requireMethod(req, res, 'GET')) return
      Promise.resolve(run()).then(
        (v) => json(res, 200, v),
        (e) => json(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) }),
      )
    },
  }
}

function postRoute(path: string, run: (body: Record<string, unknown>) => Promise<unknown> | unknown): WebRoute {
  return {
    kind: 'exact', path,
    handler: (req, res) => {
      if (!requireMethod(req, res, 'POST')) return
      readJsonBody(req).then((body) => {
        const record = (typeof body === 'object' && body !== null) ? body as Record<string, unknown> : {}
        Promise.resolve(run(record)).then(
          (v) => json(res, 200, v),
          (e) => json(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) }),
        )
      }, (e) => json(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) }))
    },
  }
}

/** 素材静态路由：精灵图 + per-state meta */
function assetRoutes(packageRoot: string): WebRoute[] {
  const files: { name: string; mime: string }[] = []
  for (const s of ASSET_STATES) {
    files.push({ name: `${s}_spritesheet.webp`, mime: 'image/webp' })
    files.push({ name: `${s}.meta.json`, mime: 'application/json' })
  }
  return files.map((file): WebRoute => ({
    kind: 'exact',
    path: `${XG_ASSET_PREFIX}/${file.name}`,
    handler: (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return }
      readFile(join(packageRoot, 'assets', file.name)).then((body) => {
        res.writeHead(200, {
          'content-type': file.mime,
          'content-length': String(body.byteLength),
          'cache-control': 'no-cache',
        })
        if (req.method === 'HEAD') { res.end(); return }
        res.end(body)
      }, () => { res.writeHead(404); res.end() })
    },
  }))
}

/** 完整路由族 */
export function makeXiaoguaiRoutes(deps: { service: XiaoguaiService; packageRoot: string }): WebRoute[] {
  const { service, packageRoot } = deps
  return [
    getRoute(`${XG_API_PREFIX}/state`, () => service.state()),
    postRoute(`${XG_API_PREFIX}/interact`, (body) => {
      const kind = body.kind
      if (kind !== 'pat' && kind !== 'feed' && kind !== 'dragEnd' && kind !== 'hide' && kind !== 'summon') {
        throw new Error('invalid-kind')
      }
      return service.interact(kind, {
        right: typeof body.right === 'number' ? body.right : undefined,
        bottom: typeof body.bottom === 'number' ? body.bottom : undefined,
      })
    }),
    ...assetRoutes(packageRoot),
  ]
}
