// 助手小乖 · 前端入口（阶段1：等待页 + dsh 就绪跳转）
// 主窗初始加载本页（Vite dev / 打包 dist），监听 Rust 侧 dsh-ready 事件后整页跳转到 dsh Web UI。
import { listen } from "@tauri-apps/api/event";

const DSH_URL_FALLBACK = "http://127.0.0.1:3080";
let jumped = false;

function show(msg: string) {
  const el = document.querySelector("#status");
  if (el) el.textContent = msg;
}

function jump(url: string) {
  if (jumped) return;
  jumped = true;
  show(`dsh 已就绪，正在打开 ${url} …`);
  window.location.href = url;
}

window.addEventListener("DOMContentLoaded", async () => {
  show("正在启动 dsh 服务…（首次可能需要数十秒）");
  // 监听 Rust 广播
  await listen<string>("dsh-ready", (e) => jump(e.payload));
  await listen<string>("dsh-error", (e) => show(`dsh 启动失败：${e.payload}（请检查 F:\\github\\dsh 是否就绪，或从托盘重启）`));
  // 兜底轮询：若事件早于监听注册已发出，5s 后开始主动查询
  setInterval(async () => {
    if (jumped) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const running = await invoke<boolean>("dsh_status");
      if (running) jump(DSH_URL_FALLBACK);
    } catch { /* invoke 不可用时静默 */ }
  }, 5000);
});
