// src/index.ts
import { Service } from "@deepseek-ai/cordis";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join as join2, dirname } from "node:path";

// src/routes.ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 16 * 1024) {
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
function postRoute(path, run) {
  return {
    kind: "exact",
    path,
    handler: (req, res) => {
      if (!requireMethod(req, res, "POST")) return;
      readJsonBody(req).then((body) => {
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
function makeXiaoguaiRoutes(deps) {
  const { service, packageRoot } = deps;
  return [
    getRoute(`${XG_API_PREFIX}/state`, () => service.state()),
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
var XiaoguaiService = class extends Service {
  static inject = [];
  phase = "idle";
  sessionActive = false;
  celebrateUntil = 0;
  display = { size: 176, right: 24, bottom: 24, visible: true };
  affinity = { points: 0, pets: 0, feeds: 0, turns: 0 };
  lastPatAt = 0;
  lastFeedAt = 0;
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
      affinity: this.affinityView()
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
};
var name = "xiaoguai-pet";
var inject = ["webServer"];
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
  inject,
  name
};
