// src/index.ts
import { Service } from "@deepseek-ai/cordis";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join as join2, dirname } from "node:path";

// src/routes.ts
import { join } from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
var XG_API_PREFIX = "/api/xiaoguai";
var XG_ASSET_PREFIX = "/xiaoguai/assets";
var ASSET_STATES = [
  "idle",
  "thinking",
  "working",
  "confirm",
  "done",
  "listening",
  "speaking",
  "pet-drag",
  "pet-pat",
  "pet-feed"
];
var ASSET_EXTRA = [
  { name: "atlas.webp", mime: "image/webp" },
  { name: "atlas.manifest.json", mime: "application/json" }
];
function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}
function requireMethod(req, res, method) {
  if (req.method === method) return true;
  json(res, 405, { ok: false, error: "method-not-allowed" });
  return false;
}
function readJsonBody(req, maxBytes = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("body-too-large"));
        queueMicrotask(() => req.destroy());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("invalid-json"));
      }
    });
    req.on("error", reject);
  });
}
function getRoute(path, run) {
  return {
    kind: "exact",
    path,
    handler: (req, res) => {
      if (!requireMethod(req, res, "GET")) return;
      Promise.resolve(run()).then(
        (v) => json(res, 200, v),
        (e) => json(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) })
      );
    }
  };
}
function postRoute(path, run, maxBytes = 16 * 1024) {
  return {
    kind: "exact",
    path,
    handler: (req, res) => {
      if (!requireMethod(req, res, "POST")) return;
      readJsonBody(req, maxBytes).then((body) => {
        const record = typeof body === "object" && body !== null ? body : {};
        Promise.resolve(run(record)).then(
          (v) => json(res, 200, v),
          (e) => json(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) })
        );
      }, (e) => json(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) }));
    }
  };
}
function assetRoutes(packageRoot) {
  const files = [];
  for (const s of ASSET_STATES) {
    files.push({ name: `${s}.meta.json`, mime: "application/json" });
  }
  for (const f of ASSET_EXTRA) files.push({ name: f.name, mime: f.mime });
  return files.map((file) => ({
    kind: "exact",
    path: `${XG_ASSET_PREFIX}/${file.name}`,
    handler: (req, res) => {
      if (file.name === "atlas.webp" && req.method === "GET") {
        try {
          bumpAtlasHits();
        } catch {
        }
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405);
        res.end();
        return;
      }
      readFile(join(packageRoot, "assets", file.name)).then((body) => {
        res.writeHead(200, {
          "content-type": file.mime,
          "content-length": String(body.byteLength),
          "cache-control": "no-cache"
        });
        if (req.method === "HEAD") {
          res.end();
          return;
        }
        res.end(body);
      }, () => {
        res.writeHead(404);
        res.end();
      });
    }
  }));
}
var ASR_URL = "http://127.0.0.1:9340/asr";
var WAKE_URL = "http://127.0.0.1:9341/wake";
async function asrRecent() {
  try {
    const resp = await fetch("http://127.0.0.1:9340/recent", { signal: AbortSignal.timeout(3e3) });
    if (resp.ok) return resp.json();
  } catch {
  }
  return { entries: [] };
}
async function bridgeWake(body) {
  const audio = body.audio_wav16k_mono;
  if (typeof audio !== "string") throw new Error("invalid-audio");
  const resp = await fetch(WAKE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ audio_wav16k_mono: audio }),
    signal: AbortSignal.timeout(15e3)
  });
  if (!resp.ok) throw new Error(`wake-upstream-${resp.status}`);
  return resp.json();
}
async function bridgeAsr(body) {
  const audioB64 = body.audio_wav;
  if (typeof audioB64 !== "string") throw new Error("invalid-audio");
  const resp = await fetch(ASR_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ audio_wav: audioB64 }),
    signal: AbortSignal.timeout(3e4)
  });
  if (!resp.ok) throw new Error(`asr-upstream-${resp.status}`);
  return resp.json();
}
async function bridgeTts(body) {
  const text = body.text;
  if (typeof text !== "string" || text.length === 0 || text.length > 500) throw new Error("invalid-text");
  const dir = await mkdtemp(pathJoin(tmpdir(), "xg-tts-"));
  try {
    const mp3 = pathJoin(dir, "out.mp3");
    await new Promise((resolve, reject) => {
      const py = process.env.XIAOGUAI_PYTHON ?? "F:/study/conda/python.exe";
      const pyScript = [
        "import sys, asyncio, edge_tts",
        "async def main():",
        '    text = sys.stdin.buffer.read().decode("utf-8")',
        '    c = edge_tts.Communicate(text, "zh-CN-XiaoyiNeural")',
        "    await c.save(sys.argv[1])",
        "asyncio.run(main())"
      ].join(String.fromCharCode(10)) + String.fromCharCode(10);
      const cleanEnv = { ...process.env };
      delete cleanEnv.HTTP_PROXY;
      delete cleanEnv.http_proxy;
      delete cleanEnv.HTTPS_PROXY;
      delete cleanEnv.https_proxy;
      delete cleanEnv.ALL_PROXY;
      delete cleanEnv.all_proxy;
      const child = spawn(py, ["-c", pyScript, mp3], { env: cleanEnv });
      child.stdin?.write(Buffer.from(text, "utf-8"));
      child.stdin?.end();
      let stderr = "";
      child.stderr?.on("data", (d) => {
        stderr += d.toString().slice(0, 300);
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        code === 0 ? resolve() : reject(new Error(`tts-exit-${code}:${stderr.slice(-150)}`));
      });
    });
    const buf = await readFile(mp3);
    return { audio_mp3: buf.toString("base64") };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
function makeXiaoguaiRoutes(deps) {
  const { service, packageRoot } = deps;
  return [
    getRoute(`${XG_API_PREFIX}/state`, () => service.state()),
    getRoute(`${XG_API_PREFIX}/diag`, () => ({ atlasHits: atlasHits(), time: Date.now() })),
    getRoute(`${XG_API_PREFIX}/diag/asr`, () => asrRecent()),
    postRoute(`${XG_API_PREFIX}/voice/asr`, bridgeAsr, 20 * 1024 * 1024),
    // wav base64 可达数MB
    postRoute(`${XG_API_PREFIX}/voice/wake`, bridgeWake, 20 * 1024 * 1024),
    postRoute(`${XG_API_PREFIX}/voice/tts`, bridgeTts),
    postRoute(`${XG_API_PREFIX}/voice/send`, (body) => {
      const text = body.text;
      if (typeof text !== "string") throw new Error("invalid-text");
      return service.voiceSend(text);
    }),
    postRoute(`${XG_API_PREFIX}/interact`, (body) => {
      const kind = body.kind;
      if (kind !== "pat" && kind !== "feed" && kind !== "dragEnd" && kind !== "hide" && kind !== "summon") {
        throw new Error("invalid-kind");
      }
      return service.interact(kind, {
        right: typeof body.right === "number" ? body.right : void 0,
        bottom: typeof body.bottom === "number" ? body.bottom : void 0
      });
    }),
    ...assetRoutes(packageRoot)
  ];
}

// src/index.ts
function animationForPhase(phase) {
  switch (phase) {
    case "thinking":
      return "thinking";
    case "tool":
      return "working";
    case "waiting":
      return "confirm";
    case "done":
      return "done";
    case "idle":
      return "idle";
  }
}
var RANKS = [
  { threshold: 0, name: "\u521D\u8BC6", emoji: "\u{1F331}" },
  { threshold: 20, name: "\u719F\u6089", emoji: "\u{1F340}" },
  { threshold: 60, name: "\u4F19\u4F34", emoji: "\u2728" },
  { threshold: 150, name: "\u631A\u53CB", emoji: "\u{1F496}" }
];
function rankOf(points) {
  let r = RANKS[0];
  for (const cand of RANKS) if (points >= cand.threshold) r = cand;
  return { name: r.name, emoji: r.emoji };
}
var PAT_COOLDOWN_MS = 3e3;
var FEED_COOLDOWN_MS = 4e3;
var __atlasHits = 0;
function atlasHits() {
  return __atlasHits;
}
function bumpAtlasHits() {
  __atlasHits += 1;
}
var XiaoguaiService = class extends Service {
  static inject = [];
  phase = "idle";
  sessionActive = false;
  celebrateUntil = 0;
  display = { size: 176, right: 24, bottom: 24, visible: true };
  affinity = { points: 0, pets: 0, feeds: 0, turns: 0 };
  lastPatAt = 0;
  lastFeedAt = 0;
  /** 最近一条助手回复文本（语音播报用），按会话 seq 去重 */
  lastAssistantText = "";
  lastAssistantSeq = 0;
  persistPath;
  constructor(ctx) {
    super(ctx, "xiaoguai");
    const home = process.env.DSH_HOME;
    this.persistPath = home !== void 0 && home !== "" ? join2(home, "xiaoguai.json") : join2(process.env.USERPROFILE ?? ".", ".dsh", "xiaoguai.json");
    try {
      const loaded = JSON.parse(readFileSync(this.persistPath, "utf8"));
      if (loaded.display) this.display = { ...this.display, ...loaded.display };
      if (loaded.affinity) this.affinity = { ...this.affinity, ...loaded.affinity };
    } catch {
    }
    ctx.on("session/event", (_s, event) => {
      switch (event.type) {
        case "assistant/message": {
          const msg = event.data.message;
          if (msg?.content !== void 0 && msg?.source?.kind === "model") {
            const seq = event.seq ?? 0;
            if (seq > this.lastAssistantSeq) {
              const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
              if (text.length > 0) {
                this.lastAssistantText = text;
                this.lastAssistantSeq = seq;
              }
            }
          }
          break;
        }
        case "turn/start":
          this.sessionActive = true;
          break;
        case "step/start":
          this.sessionActive = true;
          this.phase = "thinking";
          break;
        case "tool/call":
          this.sessionActive = true;
          this.phase = "tool";
          break;
        case "turn/end":
          this.sessionActive = true;
          if (event.data.reason.kind === "completed") {
            this.phase = "done";
            this.celebrateUntil = Date.now() + 4e3;
            this.affinity.turns += 1;
            this.affinity.points += 2;
            this.save();
          } else {
            this.phase = "idle";
          }
          break;
        default:
          break;
      }
    });
    ctx.on("session/disposed", () => {
      this.sessionActive = false;
      this.phase = "idle";
    });
  }
  settle() {
    if (this.phase === "done" && Date.now() >= this.celebrateUntil) this.phase = "idle";
  }
  save() {
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      writeFileSync(this.persistPath, JSON.stringify({ display: this.display, affinity: this.affinity }, null, 2));
    } catch {
    }
  }
  affinityView() {
    const { name: name2, emoji } = rankOf(this.affinity.points);
    const now = Date.now();
    return {
      points: this.affinity.points,
      rank: name2,
      rankEmoji: emoji,
      pets: this.affinity.pets,
      feeds: this.affinity.feeds,
      turns: this.affinity.turns,
      patCooldown: now - this.lastPatAt < PAT_COOLDOWN_MS,
      feedCooldown: now - this.lastFeedAt < FEED_COOLDOWN_MS
    };
  }
  /** RPC: 状态快照 */
  state() {
    this.settle();
    return {
      animation: animationForPhase(this.phase),
      phase: this.phase,
      sessionActive: this.sessionActive,
      display: { ...this.display },
      affinity: this.affinityView(),
      /** 最近助手回复(截断,语音播报轮询用) */
      lastReply: this.lastAssistantText.slice(0, 800)
    };
  }
  /** RPC: 互动（含好感度结算，参考鲸鱼娘） */
  interact(kind, payload) {
    const now = Date.now();
    switch (kind) {
      case "pat": {
        const onCooldown = now - this.lastPatAt < PAT_COOLDOWN_MS;
        if (!onCooldown) {
          this.lastPatAt = now;
          this.affinity.pets += 1;
          this.affinity.points += 1;
          this.save();
        }
        const replies = ["\u5C0F\u4E56\u8212\u670D\u5730\u772F\u8D77\u4E86\u773C~", "\u518D\u6478\u6478\u5934\u4E5F\u5F88\u5F00\u5FC3\uFF01", "\u5C0F\u4E56\u7684\u5934\u53D1\u88AB\u6478\u4E71\u4E86\u5566~"];
        return {
          animation: "pet-pat",
          bubble: onCooldown ? "\u5C0F\u4E56\u6709\u70B9\u88AB\u6478\u6655\u4E86\u2026" : replies[this.affinity.pets % replies.length],
          delta: onCooldown ? 0 : 1,
          affinity: this.affinityView()
        };
      }
      case "feed": {
        const onCooldown = now - this.lastFeedAt < FEED_COOLDOWN_MS;
        if (onCooldown) {
          return { animation: "pet-feed", bubble: "\u5C0F\u4E56\u8FD8\u56BC\u7740\u5462\uFF0C\u7B49\u7B49\u518D\u5582~", delta: 0, affinity: this.affinityView() };
        }
        this.lastFeedAt = now;
        this.affinity.feeds += 1;
        this.affinity.points += 3;
        this.save();
        return { animation: "pet-feed", bubble: "\u5C0F\u4E56\u5403\u5F97\u816E\u5E2E\u9F13\u9F13\u7684\uFF01+3 \u597D\u611F", delta: 3, affinity: this.affinityView() };
      }
      case "dragEnd":
        if (payload?.right !== void 0 && payload?.bottom !== void 0) {
          this.display.right = Math.max(0, Math.min(Math.round(payload.right), 4e3));
          this.display.bottom = Math.max(0, Math.min(Math.round(payload.bottom), 4e3));
          this.save();
        }
        return { animation: this.state().animation };
      case "hide":
        this.display.visible = false;
        this.save();
        return { animation: "idle", bubble: void 0 };
      case "summon":
        this.display.visible = true;
        this.save();
        return { animation: "idle" };
    }
  }
  /** 语音链路终点：把识别文本投递到当前活跃会话（无会话则自动建一个） */
  async voiceSend(text) {
    const trimmed = text.trim();
    if (trimmed.length === 0) return { ok: false, error: "empty", bubble: "\u5C0F\u4E56\u6CA1\u542C\u6E05\uFF0C\u518D\u8BF4\u4E00\u6B21\uFF1F" };
    try {
      const agents = this.ctx.agents;
      let agent = agents.list().at(-1);
      if (agent === void 0) {
        const { randomUUID } = await import("node:crypto");
        const created = await agents.create({
          sessionId: `xiaoguai-${randomUUID()}`,
          meta: { cwd: process.cwd() }
        });
        agent = created.agent;
      }
      agent.followup(createUserMessage({
        content: [{ type: "text", text: trimmed }],
        source: { kind: "user" }
      }));
      return { ok: true, bubble: "\u5C0F\u4E56\u6536\u5230\uFF0C\u8FD9\u5C31\u53BB\u529E\uFF01" };
    } catch (error) {
      return { ok: false, error: String(error), bubble: "\u53D1\u9001\u5931\u8D25\u4E86\u2026" };
    }
  }
};
var name = "xiaoguai-pet";
var inject = ["webServer", "agents"];
function apply(ctx) {
  const service = new XiaoguaiService(ctx);
  const routes = makeXiaoguaiRoutes({ service, packageRoot: packageRootFrom(import.meta.url) });
  const disposers = routes.map((route) => ctx.webServer.register(route));
  ctx.effect(() => () => {
    for (const dispose of disposers) dispose();
  }, "xiaoguai: routes");
}
function packageRootFrom(importMetaUrl) {
  return dirname(dirname(new URL(importMetaUrl).pathname.replace(/^\/([A-Za-z]:)/, "$1")));
}
export {
  XiaoguaiService,
  animationForPhase,
  apply,
  atlasHits,
  bumpAtlasHits,
  inject,
  name
};
