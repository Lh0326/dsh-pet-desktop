// 助手小乖 · Tauri 壳主逻辑
// 阶段1：主窗（加载本地 dsh Web UI）+ 系统托盘 + dsh 进程托管
mod dsh_host;

use dsh_host::DshHost;
use std::sync::Arc;
use std::time::Duration;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, WindowEvent, Emitter,
};

#[tauri::command]
fn dsh_status(host: tauri::State<'_, Arc<DshHost>>) -> bool {
    host.is_running()
}

#[tauri::command]
async fn dsh_start(host: tauri::State<'_, Arc<DshHost>>) -> Result<String, String> {
    host.start()?;
    host.wait_ready(60)?;
    Ok(dsh_host::DSH_URL.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let host = Arc::new(DshHost::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(host.clone())
        .invoke_handler(tauri::generate_handler![dsh_status, dsh_start])
        .setup(move |app| {
            // —— 托盘 ——
            let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
            let restart = MenuItem::with_id(app, "restart", "重启 dsh 服务", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &restart, &quit])?;
            TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("助手小乖 · dsh")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "restart" => {
                        let host = app.state::<Arc<DshHost>>();
                        host.stop();
                        let h = host.inner().clone();
                        let handle = app.clone();
                        // 主窗先显示"正在重启"等待页并离开旧 dsh 页面
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.eval(
                                "document.body.innerHTML='<div style=\"display:flex;height:100vh;align-items:center;justify-content:center;font-size:16px;color:#666;font-family:sans-serif\">正在重启 dsh 服务…</div>';document.body.style.margin='0';",
                            );
                        }
                        std::thread::spawn(move || {
                            // 等 3080 端口真正释放（taskkill 异步完成）
                            for _ in 0..40 {
                                if !h.is_running() { break; }
                                std::thread::sleep(Duration::from_millis(500));
                            }
                            let result = h.start().and_then(|()| h.wait_ready(90));
                            match result {
                                Ok(()) => {
                                    // 主窗此刻在"正在重启"占位页（无事件监听），直接导航
                                    if let Some(w) = handle.get_webview_window("main") {
                                        let _ = w.eval(&format!("window.location.href='{}';", dsh_host::DSH_URL));
                                    }
                                }
                                Err(e) => {
                                    if let Some(w) = handle.get_webview_window("main") {
                                        let _ = w.eval(&format!(
                                            "document.body.innerText='dsh 重启失败: {}';",
                                            e.replace('\'', "")
                                        ));
                                    }
                                }
                            }
                        });
                    }
                    "quit" => {
                        let host = app.state::<Arc<DshHost>>();
                        host.stop();
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            // —— dsh 托管：后台线程启动，就绪后广播给前端，前端跳转 DSH_URL ——
            let handle = app.handle().clone();
            let h = host.clone();
            std::thread::spawn(move || {
                if let Err(e) = h.start() {
                    eprintln!("[xiaoguai] dsh start error: {e}");
                    return;
                }
                match h.wait_ready(90) {
                    Ok(()) => {
                        let _ = handle.emit("dsh-ready", dsh_host::DSH_URL);
                    }
                    Err(e) => {
                        eprintln!("[xiaoguai] dsh not ready: {e}");
                        let _ = handle.emit("dsh-error", e);
                    }
                }
            });

            // —— 桌宠已迁至 dsh 插件形态（plugin/xiaoguai-pet，页面内浮层），
            //    Tauri 壳不再创建系统级透明窗 ——

            Ok(())
        })
        .on_window_event(|window, event| {
            // 关窗 = 隐藏到托盘（不退出进程）
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running xiaoguai");
}
