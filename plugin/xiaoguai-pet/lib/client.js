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
function apply() {
  void loadMetas();
  const container = document.createElement("div");
  container.dataset.xiaoguaiPetRoot = "";
  document.body.appendChild(container);
  const root = (0, import_client.createRoot)(container);
  root.render((0, import_react.createElement)(XiaoguaiEntry));
  const poll = () => {
    API.state().then((s) => {
      setUi({ snapshot: s });
    }, () => {
    });
  };
  poll();
  const timer = window.setInterval(() => {
    if (document.visibilityState === "visible") poll();
  }, 800);
  return () => {
    window.clearInterval(timer);
    root.unmount();
    container.remove();
  };
}
function XiaoguaiEntry() {
  const state = (0, import_react.useSyncExternalStore)(subscribe, () => ui);
  const visible = state.snapshot?.display.visible ?? true;
  if (!visible) {
    return (0, import_react.createElement)("button", {
      onClick: () => {
        void API.interact("summon").then(() => setUi({ snapshot: ui.snapshot ? { ...ui.snapshot, display: { ...ui.snapshot.display, visible: true } } : null }));
      },
      style: { position: "fixed", right: 24, bottom: 24, zIndex: 2147483e3 }
    }, "\u547C\u5524\u5C0F\u4E56");
  }
  return (0, import_react.createElement)(XiaoguaiFloat);
}
function XiaoguaiFloat() {
  const state = (0, import_react.useSyncExternalStore)(subscribe, () => ui);
  const snapshot = state.snapshot;
  const display = snapshot?.display ?? { size: 176, right: 24, bottom: 24, visible: true };
  const animation = state.local ?? snapshot?.animation ?? "idle";
  const spriteRef = (0, import_react.useRef)(null);
  const [dragPos, setDragPos] = (0, import_react.useState)(null);
  const dragRef = (0, import_react.useRef)(null);
  const draggedRef = (0, import_react.useRef)(false);
  const [hovered, setHovered] = (0, import_react.useState)(false);
  const frameRef = (0, import_react.useRef)({
    anim: null,
    index: 0,
    elapsed: 0,
    finished: false
  });
  const animRef = (0, import_react.useRef)(animation);
  animRef.current = animation;
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
  const pos = dragPos ?? { right: display.right, bottom: display.bottom };
  const size = display.size;
  const float = (0, import_react.createElement)(
    "div",
    {
      style: {
        position: "fixed",
        right: pos.right,
        bottom: pos.bottom,
        zIndex: 2147483e3,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        userSelect: "none",
        WebkitUserSelect: "none"
      },
      onPointerEnter: () => setHovered(true),
      onPointerLeave: () => {
        setHovered(false);
      }
    },
    (0, import_react.createElement)("div", {
      ref: spriteRef,
      role: "button",
      "aria-label": "\u5C0F\u4E56",
      style: {
        width: size,
        height: size,
        backgroundImage: `url(/xiaoguai/assets/${animation}_spritesheet.png)`,
        backgroundSize: `${size * (metas.get(animation)?.frameCount ?? 1)}px ${size}px`,
        backgroundRepeat: "no-repeat",
        backgroundPosition: "0 0",
        imageRendering: "auto",
        touchAction: "none",
        cursor: dragRef.current === null ? "grab" : "grabbing"
      },
      onPointerDown: (e) => {
        e.preventDefault();
        e.target.setPointerCapture?.(e.pointerId);
        const current = dragPos ?? { right: display.right, bottom: display.bottom };
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
      onPointerUp: () => {
        if (dragRef.current === null) return;
        const wasDrag = draggedRef.current;
        clearDrag();
        if (wasDrag && dragPos !== null) {
          void API.interact("dragEnd", dragPos);
        } else if (!wasDrag) {
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
        marginBottom: 6,
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
        style: {
          position: "absolute",
          bottom: "100%",
          marginBottom: 6,
          background: "rgba(15,23,42,0.92)",
          border: "1px solid rgba(148,163,184,0.35)",
          borderRadius: 10,
          padding: "8px 10px",
          color: "#e2e8f0",
          fontSize: 12,
          display: "flex",
          gap: 6
        }
      },
      (0, import_react.createElement)("button", {
        type: "button",
        onClick: () => {
          void API.interact("feed").then((r) => {
            if (r.bubble) setUi({ bubble: r.bubble, bubbleAt: Date.now() });
          });
          setUi({ local: "pet-feed" });
        },
        style: { cursor: "pointer" }
      }, "\u6295\u5582"),
      (0, import_react.createElement)("button", {
        type: "button",
        onClick: () => {
          void API.interact("hide");
          setUi({ snapshot: ui.snapshot ? { ...ui.snapshot, display: { ...ui.snapshot.display, visible: false } } : null });
        },
        style: { cursor: "pointer" }
      }, "\u9690\u85CF")
    )
  );
  return (0, import_react_dom.createPortal)(float, document.body);
}

		return module.exports;
	}
});
