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
    files.push({ name: `${s}_spritesheet.png`, mime: "image/png" });
    files.push({ name: `${s}.meta.json`, mime: "application/json" });
  }
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
var XiaoguaiService = class extends Service {
  static inject = [];
  phase = "idle";
  sessionActive = false;
  celebrateUntil = 0;
  display = { size: 176, right: 24, bottom: 24, visible: true };
  persistPath;
  constructor(ctx) {
    super(ctx, "xiaoguai");
    const home = process.env.DSH_HOME;
    this.persistPath = home !== void 0 && home !== "" ? join2(home, "xiaoguai.json") : join2(process.env.USERPROFILE ?? ".", ".dsh", "xiaoguai.json");
    try {
      const loaded = JSON.parse(readFileSync(this.persistPath, "utf8"));
      if (loaded.display) this.display = { ...this.display, ...loaded.display };
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
      writeFileSync(this.persistPath, JSON.stringify({ display: this.display }, null, 2));
    } catch {
    }
  }
  /** RPC: 状态快照 */
  state() {
    this.settle();
    return {
      animation: animationForPhase(this.phase),
      phase: this.phase,
      sessionActive: this.sessionActive,
      display: { ...this.display }
    };
  }
  /** RPC: 互动 */
  interact(kind, payload) {
    switch (kind) {
      case "pat":
        return { animation: "pet-pat", bubble: "\u5C0F\u4E56\u8212\u670D\u5730\u772F\u8D77\u4E86\u773C~" };
      case "feed":
        return { animation: "pet-feed", bubble: "\u5C0F\u4E56\u5403\u5F97\u816E\u5E2E\u9F13\u9F13\u7684\uFF01" };
      case "dragEnd":
        if (payload?.right !== void 0 && payload?.bottom !== void 0) {
          this.display.right = Math.max(0, Math.round(payload.right));
          this.display.bottom = Math.max(0, Math.round(payload.bottom));
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
