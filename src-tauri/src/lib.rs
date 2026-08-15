// 助手小乖 · Tauri 壳主逻辑
// 阶段1：主窗（加载本地 dsh Web UI）+ 系统托盘 + dsh 进程托管
mod dsh_host;

use dsh_host::DshHost;
use std::sync::Arc;
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
                        std::thread::spawn(move || {
                            let _ = h.start();
                            let _ = h.wait_ready(60);
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
