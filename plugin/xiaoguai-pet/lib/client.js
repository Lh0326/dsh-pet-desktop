window.__ModuleLoader__.load({
	id: "dsh-xiaoguai-pet",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client.ts
var client_exports = {};
__export(client_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(client_exports);
var import_react = require("react");
var import_client = require("react-dom/client");
var import_react_dom = require("react-dom");
var API = {
  state: () => fetch("/api/xiaoguai/state").then((r) => r.json()),
  interact: (kind, extra) => fetch("/api/xiaoguai/interact", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind, ...extra })
  }).then((r) => r.json())
};
var metas = /* @__PURE__ */ new Map();
async function loadMetas() {
  const states = ["idle", "thinking", "working", "confirm", "done", "listening", "speaking", "pet-drag", "pet-pat", "pet-feed"];
  await Promise.all(states.map(async (s) => {
    const r = await fetch(`/xiaoguai/assets/${s}.meta.json`);
    if (r.ok) metas.set(s, await r.json());
  }));
}
function isTransient(a) {
  return a === "pet-pat" || a === "pet-feed" || a === "done";
}
var ui = { snapshot: null, local: null, bubble: null, bubbleAt: 0 };
var listeners = /* @__PURE__ */ new Set();
function setUi(patch) {
  ui = { ...ui, ...patch };
  for (const l of listeners) l();
}
function subscribe(l) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
var inject = [];
var decoded = /* @__PURE__ */ new Map();
function ensureDecoded(a) {
  let p = decoded.get(a);
  if (p === void 0) {
    const img = new Image();
    img.src = `/xiaoguai/assets/${a}_spritesheet.webp`;
    p = img.decode().then(() => void 0).catch(() => void 0);
    decoded.set(a, p);
  }
  return p;
}
var ALL_ANIMS = ["idle", "thinking", "working", "confirm", "done", "listening", "speaking", "pet-drag", "pet-pat", "pet-feed"];
function preloadAll() {
  for (const a of ALL_ANIMS) void ensureDecoded(a);
}
var instance = null;
function apply() {
  if (instance !== null) {
    instance.alive = false;
    window.clearInterval(instance.timer);
  }
  document.querySelectorAll("div[data-xiaoguai-pet-root]").forEach((el) => el.remove());
  const me = { alive: true, timer: 0 };
  instance = me;
  void loadMetas();
  preloadAll();
  const container = document.createElement("div");
  container.dataset.xiaoguaiPetRoot = "";
  document.body.appendChild(container);
  const root = (0, import_client.createRoot)(container);
  root.render((0, import_react.createElement)(XiaoguaiEntry));
  const poll = () => {
    if (!me.alive) return;
    API.state().then((s) => {
      if (me.alive) setUi({ snapshot: s });
    }, () => {
    });
  };
  poll();
  me.timer = window.setInterval(() => {
    if (me.alive && document.visibilityState === "visible") poll();
  }, 800);
  return () => {
    me.alive = false;
    window.clearInterval(me.timer);
    root.unmount();
    container.remove();
    if (instance === me) instance = null;
  };
}
function XiaoguaiEntry() {
  const state = (0, import_react.useSyncExternalStore)(subscribe, () => ui);
  const visible = state.snapshot?.display.visible ?? true;
  if (!visible) {
    return (0, import_react.createElement)("button", {
      type: "button",
      "aria-label": "\u53EC\u56DE\u5C0F\u4E56",
      onClick: () => {
        void API.interact("summon").then(() => setUi({ snapshot: ui.snapshot ? { ...ui.snapshot, display: { ...ui.snapshot.display, visible: true } } : null }));
      },
      style: {
        position: "fixed",
        right: 8,
        bottom: 8,
        zIndex: 2147483e3,
        width: 30,
        height: 30,
        borderRadius: "50%",
        border: "1px solid rgba(148,163,184,0.5)",
        background: "rgba(15,23,42,0.55)",
        color: "#cbd5e1",
        fontSize: 15,
        lineHeight: 1,
        cursor: "pointer",
        padding: 0,
        opacity: 0.35,
        transition: "opacity .15s"
      },
      onPointerEnter: (e) => {
        e.currentTarget.style.opacity = "1";
      },
      onPointerLeave: (e) => {
        e.currentTarget.style.opacity = "0.35";
      }
    }, "\u4E56");
  }
  return (0, import_react.createElement)(XiaoguaiFloat);
}
function XiaoguaiFloat() {
  const state = (0, import_react.useSyncExternalStore)(subscribe, () => ui);
  const snapshot = state.snapshot;
  const display = snapshot?.display ?? { size: 176, right: 24, bottom: 24, visible: true };
  const animation = state.local ?? snapshot?.animation ?? "idle";
  const spriteRef = (0, import_react.useRef)(null);
  const floatRef = (0, import_react.useRef)(null);
  const [dragPos, setDragPos] = (0, import_react.useState)(null);
  const dragRef = (0, import_react.useRef)(null);
  const draggedRef = (0, import_react.useRef)(false);
  const [hovered, setHovered] = (0, import_react.useState)(false);
  const hidePanelTimer = (0, import_react.useRef)(null);
  const showPanel = () => {
    if (hidePanelTimer.current !== null) {
      window.clearTimeout(hidePanelTimer.current);
      hidePanelTimer.current = null;
    }
    if (state.local !== null && state.local !== "pet-drag") return;
    setHovered(true);
  };
  const scheduleHidePanel = () => {
    if (hidePanelTimer.current !== null) window.clearTimeout(hidePanelTimer.current);
    hidePanelTimer.current = window.setTimeout(() => setHovered(false), 400);
  };
  const frameRef = (0, import_react.useRef)({
    anim: null,
    index: 0,
    elapsed: 0,
    finished: false
  });
  const animRef = (0, import_react.useRef)(animation);
  const prevAnimRef = (0, import_react.useRef)(null);
  animRef.current = animation;
  (0, import_react.useEffect)(() => {
    if (prevAnimRef.current !== animation) {
      prevAnimRef.current = animation;
      void ensureDecoded(animation);
      frameRef.current = { anim: null, index: 0, elapsed: 0, finished: false };
      if (spriteRef.current !== null) {
        spriteRef.current.style.backgroundPosition = "0px 0";
      }
    }
  }, [animation]);
  (0, import_react.useEffect)(() => {
    let raf = 0;
    let last = performance.now();
    const FRAME_MS = 1e3 / 30;
    const tick = (ts) => {
      const delta = ts - last;
      last = ts;
      const anim = animRef.current;
      const meta = metas.get(anim) ?? { frameSize: 512, frameCount: 1, fps: 30 };
      const st = frameRef.current;
      if (st.anim !== anim) {
        st.anim = anim;
        st.index = 0;
        st.elapsed = 0;
        st.finished = false;
      }
      if (!st.finished) {
        st.elapsed += delta;
        const frameMs = 1e3 / meta.fps;
        while (st.elapsed >= frameMs && st.index < meta.frameCount - 1) {
          st.elapsed -= frameMs;
          st.index += 1;
        }
        if (st.elapsed >= frameMs) {
          if (isTransient(anim)) {
            st.index = meta.frameCount - 1;
            st.finished = true;
            if (anim !== "pet-drag") setUi({ local: null });
          } else {
            st.elapsed = 0;
            st.index = 0;
          }
        }
      }
      if (spriteRef.current !== null) {
        spriteRef.current.style.backgroundPosition = `-${st.index * display.size}px 0`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [display.size]);
  (0, import_react.useEffect)(() => {
    if (state.bubble === null) return;
    const t = window.setTimeout(() => setUi({ bubble: null }), 2600);
    return () => window.clearTimeout(t);
  }, [state.bubbleAt]);
  const clearDrag = () => {
    dragRef.current = null;
    setUi({ local: null });
  };
  const size = display.size;
  const rawPos = dragPos ?? { right: display.right, bottom: display.bottom };
  const pos = {
    right: Math.max(0, Math.min(rawPos.right, window.innerWidth - 60)),
    bottom: Math.max(0, Math.min(rawPos.bottom, window.innerHeight - 60))
  };
  const float = (0, import_react.createElement)(
    "div",
    {
      ref: floatRef,
      style: {
        position: "fixed",
        right: pos.right,
        bottom: pos.bottom,
        zIndex: 2147483e3,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        userSelect: "none",
        WebkitUserSelect: "none",
        // GPU合成层隔离: WebView2下fixed元素高频改right/bottom会出现
        // 合成器与主文档更新不同步的"残影/第二个小乖"——
        // 提升为独立合成层后位置变化不再牵动主文档重排
        willChange: "right, bottom",
        transform: "translateZ(0)",
        backfaceVisibility: "hidden"
      },
      onPointerEnter: showPanel,
      onPointerLeave: scheduleHidePanel
    },
    (0, import_react.createElement)("div", {
      ref: spriteRef,
      role: "button",
      "aria-label": "\u5C0F\u4E56",
      style: {
        width: size,
        height: size,
        backgroundImage: `url(/xiaoguai/assets/${animation}_spritesheet.webp)`,
        backgroundSize: `${size * (metas.get(animation)?.frameCount ?? 1)}px ${size}px`,
        backgroundRepeat: "no-repeat",
        // backgroundPosition 同理不归 React 管（rAF 直写）
        imageRendering: "auto",
        touchAction: "none",
        cursor: dragRef.current === null ? "grab" : "grabbing"
      },
      onPointerDown: (e) => {
        e.preventDefault();
        e.target.setPointerCapture?.(e.pointerId);
        setHovered(false);
        void ensureDecoded("pet-drag");
        const rect = floatRef.current?.getBoundingClientRect();
        const current = rect !== void 0 ? { right: Math.max(0, window.innerWidth - rect.right), bottom: Math.max(0, window.innerHeight - rect.bottom) } : { right: display.right, bottom: display.bottom };
        dragRef.current = { startX: e.clientX, startY: e.clientY, ...current };
        draggedRef.current = false;
      },
      onPointerMove: (e) => {
        const drag = dragRef.current;
        if (drag === null) return;
        const dx = e.clientX - drag.startX;
        const dy = e.clientY - drag.startY;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
          if (!draggedRef.current) {
            draggedRef.current = true;
            setUi({ local: "pet-drag" });
          }
        }
        const right = Math.max(0, Math.min(drag.right - dx, window.innerWidth - 40));
        const bottom = Math.max(0, Math.min(drag.bottom - dy, window.innerHeight - 40));
        setDragPos({ right, bottom });
      },
      onPointerUp: (e) => {
        if (dragRef.current === null) return;
        const wasDrag = draggedRef.current;
        const drag = dragRef.current;
        const dx = e.clientX - drag.startX;
        const dy = e.clientY - drag.startY;
        const finalPos = wasDrag ? {
          right: Math.max(0, Math.min(drag.right - dx, window.innerWidth - 40)),
          bottom: Math.max(0, Math.min(drag.bottom - dy, window.innerHeight - 40))
        } : null;
        dragRef.current = null;
        setUi({ local: null });
        if (finalPos !== null) {
          void API.interact("dragEnd", finalPos);
        } else {
          void API.interact("pat").then((r) => {
            if (r.bubble) setUi({ bubble: r.bubble, bubbleAt: Date.now() });
          });
          setUi({ local: "pet-pat" });
        }
      }
    }),
    state.bubble !== null && (0, import_react.createElement)("div", {
      key: state.bubbleAt,
      style: {
        position: "absolute",
        bottom: "100%",
        marginBottom: 2,
        whiteSpace: "nowrap",
        padding: "4px 10px",
        borderRadius: 999,
        fontSize: 12,
        color: "#fff",
        background: "rgba(244,114,182,0.92)",
        boxShadow: "0 2px 8px rgba(0,0,0,0.25)",
        pointerEvents: "none"
      }
    }, state.bubble),
    hovered && dragRef.current === null && (0, import_react.createElement)(
      "div",
      {
        onPointerEnter: showPanel,
        onPointerLeave: scheduleHidePanel,
        style: {
          // 贴着小乖头顶零间隙（+400ms 缓冲），鼠标移向面板全程在 hit 区
          position: "absolute",
          bottom: "100%",
          marginBottom: 0,
          background: "rgba(15,23,42,0.92)",
          border: "1px solid rgba(148,163,184,0.35)",
          borderRadius: 10,
          padding: "8px 10px",
          color: "#e2e8f0",
          fontSize: 12,
          display: "flex",
          flexDirection: "column",
          gap: 6,
          minWidth: 128
        }
      },
      (0, import_react.createElement)(
        "div",
        { style: { display: "flex", justifyContent: "space-between", gap: 8 } },
        (0, import_react.createElement)("span", null, `${snapshot?.affinity.rankEmoji ?? "\u{1F331}"} \u5C0F\u4E56 \xB7 ${snapshot?.affinity.rank ?? "\u521D\u8BC6"}`),
        (0, import_react.createElement)("span", { style: { opacity: 0.7 } }, `${snapshot?.affinity.points ?? 0} \u5206`)
      ),
      (0, import_react.createElement)(
        "div",
        { style: { display: "flex", justifyContent: "space-between", gap: 8, opacity: 0.75 } },
        (0, import_react.createElement)("span", null, `\u6478\u5934 ${snapshot?.affinity.pets ?? 0}`),
        (0, import_react.createElement)("span", null, `\u6295\u5582 ${snapshot?.affinity.feeds ?? 0}`),
        (0, import_react.createElement)("span", null, `\u966A\u5DE5 ${snapshot?.affinity.turns ?? 0}`)
      ),
      (0, import_react.createElement)(
        "div",
        { style: { display: "flex", gap: 6 } },
        (0, import_react.createElement)("button", {
          type: "button",
          disabled: snapshot?.affinity.feedCooldown === true,
          onClick: () => {
            void API.interact("feed").then((r) => {
              if (r.bubble) setUi({ bubble: r.bubble, bubbleAt: Date.now() });
            });
            setUi({ local: "pet-feed" });
          },
          style: { cursor: "pointer", flex: 1 }
        }, snapshot?.affinity.feedCooldown === true ? "\u56BC\u7740\u5462\u2026" : "\u6295\u5582"),
        (0, import_react.createElement)("button", {
          type: "button",
          onClick: () => {
            void API.interact("hide");
            setUi({ snapshot: ui.snapshot ? { ...ui.snapshot, display: { ...ui.snapshot.display, visible: false } } : null });
          },
          style: { cursor: "pointer", flex: 1 }
        }, "\u9690\u85CF")
      )
    )
  );
  return (0, import_react_dom.createPortal)(float, document.body);
}

		return module.exports;
	}
});
