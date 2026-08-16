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
import { atlasHits, bumpAtlasHits } from './index.ts'

export const XG_API_PREFIX = '/api/xiaoguai'
export const XG_ASSET_PREFIX = '/xiaoguai/assets'

/** 暴露的素材清单（单图集 + 各状态 meta） */
const ASSET_STATES = [
  'idle', 'thinking', 'working', 'confirm', 'done',
  'listening', 'speaking', 'pet-drag', 'pet-pat', 'pet-feed',
] as const
const ASSET_EXTRA = [
  { name: 'atlas.webp', mime: 'image/webp' },
  { name: 'atlas.manifest.json', mime: 'application/json' },
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

function readJsonBody(req: IncomingMessage, maxBytes = 16 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
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

function postRoute(path: string, run: (body: Record<string, unknown>) => Promise<unknown> | unknown, maxBytes = 16 * 1024): WebRoute {
  return {
    kind: 'exact', path,
    handler: (req, res) => {
      if (!requireMethod(req, res, 'POST')) return
      readJsonBody(req, maxBytes).then((body) => {
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
    files.push({ name: `${s}.meta.json`, mime: 'application/json' })
  }
  for (const f of ASSET_EXTRA) files.push({ name: f.name, mime: f.mime })
  return files.map((file): WebRoute => ({
    kind: 'exact',
    path: `${XG_ASSET_PREFIX}/${file.name}`,
    handler: (req, res) => {
      if (file.name === 'atlas.webp' && req.method === 'GET') { try { bumpAtlasHits() } catch { /* 诊断不致命 */ } }
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


/** 语音链路路由（host 侧桥接本地 ASR/TTS 服务）
 *  POST /api/xiaoguai/voice/asr  {audio_wav: base64}      → {text}
 *  POST /api/xiaoguai/voice/tts  {text}                   → {audio_mp3: base64}
 *  ASR: 127.0.0.1:9340 (FunASR/SenseVoice, voice/asr_server.py)
 *  TTS: edge-tts 直接进程调用（无需常驻服务） */
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join as pathJoin } from 'node:path'

const ASR_URL = 'http://127.0.0.1:9340/asr'
const WAKE_URL = 'http://127.0.0.1:9341/wake'

/** 诊断: ASR服务端最近识别记录(唤醒排查数据源) */
async function asrRecent(): Promise<unknown> {
  try {
    const resp = await fetch('http://127.0.0.1:9340/recent', { signal: AbortSignal.timeout(3000) })
    if (resp.ok) return resp.json()
  } catch { /* 服务不支持时返回空 */ }
  return { entries: [] }
}

/** 唤醒词判定桥接(本地onnx微模型,CPU<1%): {audio_wav16k_mono}→{score} */
async function bridgeWake(body: Record<string, unknown>): Promise<unknown> {
  const audio = body.audio_wav16k_mono
  if (typeof audio !== 'string') throw new Error('invalid-audio')
  const resp = await fetch(WAKE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ audio_wav16k_mono: audio }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!resp.ok) throw new Error(`wake-upstream-${resp.status}`)
  return resp.json()
}

async function bridgeAsr(body: Record<string, unknown>): Promise<unknown> {
  const audioB64 = body.audio_wav
  if (typeof audioB64 !== 'string') throw new Error('invalid-audio')
  const resp = await fetch(ASR_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ audio_wav: audioB64 }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!resp.ok) throw new Error(`asr-upstream-${resp.status}`)
  return resp.json()
}

async function bridgeTts(body: Record<string, unknown>): Promise<unknown> {
  const text = body.text
  if (typeof text !== 'string' || text.length === 0 || text.length > 500) throw new Error('invalid-text')
  const dir = await mkdtemp(pathJoin(tmpdir(), 'xg-tts-'))
  try {
    const mp3 = pathJoin(dir, 'out.mp3')
    await new Promise<void>((resolve, reject) => {
      // 用 python -m edge_tts 调用（比 PATH 里的 edge-tts.exe 可靠——
      // dsh 进程的 PATH 常不含 conda Scripts；显式已知 Python 路径，回退 PATH 解析）
      const py = process.env.XIAOGUAI_PYTHON ?? 'F:/study/conda/python.exe'
      // Windows 中文 argv 编码坑两连：
      //  1) shell:true → cmd 引号重写损坏参数（exit-2）
      //  2) 无 shell → node utf8 argv 被 python 按 GBK(ACP) 解码，中文变问号后
      //     edge_tts 服务端拒绝（exit-1 asyncio）
      // 终解：文本经 stdin(utf-8) 传入，python 侧 -c 脚本显式 utf-8 读取
      const pyScript = [
        'import sys, asyncio, edge_tts',
        'async def main():',
        '    text = sys.stdin.buffer.read().decode("utf-8")',
        '    c = edge_tts.Communicate(text, "zh-CN-XiaoyiNeural")',
        '    await c.save(sys.argv[1])',
        'asyncio.run(main())',
      ].join(String.fromCharCode(10)) + String.fromCharCode(10)
      // TTS 子进程强制净化代理环境：edge_tts 走微软云，宿主(dsh/Tauri)env 里
      // 残留的 HTTP(S)_PROXY(如本机clash)会让请求 NoAudioReceived——
      // 继承shell无代理时手动spawn成功、dsh内失败的唯一差异项
      const cleanEnv = { ...process.env } as Record<string, string | undefined>
      delete cleanEnv.HTTP_PROXY; delete cleanEnv.http_proxy
      delete cleanEnv.HTTPS_PROXY; delete cleanEnv.https_proxy
      delete cleanEnv.ALL_PROXY; delete cleanEnv.all_proxy
      const child = spawn(py, ['-c', pyScript, mp3], { env: cleanEnv })
      child.stdin?.write(Buffer.from(text, 'utf-8'))
      child.stdin?.end()
      let stderr = ''
      child.stderr?.on('data', (d: Buffer) => { stderr += d.toString().slice(0, 300) })
      child.on('error', reject)
      child.on('exit', (code) => { code === 0 ? resolve() : reject(new Error(`tts-exit-${code}:${stderr.slice(-150)}`)) })
    })
    const buf = await readFile(mp3)
    return { audio_mp3: buf.toString('base64') }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** 完整路由族 */
export function makeXiaoguaiRoutes(deps: { service: XiaoguaiService; packageRoot: string }): WebRoute[] {
  const { service, packageRoot } = deps
  return [
    getRoute(`${XG_API_PREFIX}/state`, () => service.state()),
    getRoute(`${XG_API_PREFIX}/diag`, () => ({ atlasHits: atlasHits(), time: Date.now() })),
    getRoute(`${XG_API_PREFIX}/diag/asr`, () => asrRecent()),
    postRoute(`${XG_API_PREFIX}/voice/asr`, bridgeAsr, 20 * 1024 * 1024),  // wav base64 可达数MB
    postRoute(`${XG_API_PREFIX}/voice/wake`, bridgeWake, 20 * 1024 * 1024),
    postRoute(`${XG_API_PREFIX}/voice/tts`, bridgeTts),
    postRoute(`${XG_API_PREFIX}/voice/send`, (body) => {
      const text = body.text
      if (typeof text !== 'string') throw new Error('invalid-text')
      return service.voiceSend(text)
    }),
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
