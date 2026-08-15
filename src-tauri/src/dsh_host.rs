// dsh 进程托管：启动/停止/健康检查本地 dsh Web UI 服务
// 设计要点（留痕：阶段1核心决策）：
// - dsh 以源码检出方式运行（F:\github\dsh，用户已有完整构建），用 pnpm dsh web 启动
// - 服务地址固定 http://127.0.0.1:3080（dsh 默认）
// - 健康检查：GET / 返回 200 即认为就绪，主窗加载前轮询
// - 单实例：dsh 本身允许多实例但会话日志可能损坏（社区已知 bug），这里用端口探测避免重复拉起

use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::Duration;

pub const DSH_URL: &str = "http://127.0.0.1:3080";
const DSH_DIR: &str = "F:\\github\\dsh";

pub struct DshHost {
    child: Mutex<Option<Child>>,
}

impl DshHost {
    pub fn new() -> Self {
        Self { child: Mutex::new(None) }
    }

    /// 端口是否已有服务在听（可能是本应用先前启动的，也可能是用户手动起的）
    pub fn is_running(&self) -> bool {
        TcpStream::connect(("127.0.0.1", 3080)).is_ok()
    }

    /// 启动 dsh web 服务（若已在跑则直接返回 ok）
    pub fn start(&self) -> Result<(), String> {
        if self.is_running() {
            return Ok(());
        }
        let mut guard = self.child.lock().map_err(|e| e.to_string())?;
        if let Some(c) = guard.as_mut() {
            if let Ok(None) = c.try_wait() {
                return Ok(()); // 已启动且未退出
            }
        }
        let child = spawn_dsh()?;
        *guard = Some(child);
        Ok(())
    }

    /// 轮询直到服务就绪（最多 timeout_secs 秒）
    pub fn wait_ready(&self, timeout_secs: u32) -> Result<(), String> {
        for _ in 0..(timeout_secs * 4) {
            if self.is_running() {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        Err(format!("dsh 服务 {timeout_secs}s 内未就绪"))
    }

    /// 应用退出时结束子进程（仅当是我们拉起的）
    pub fn stop(&self) {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(c) = guard.as_mut() {
                let _ = c.kill();
                let _ = c.wait();
            }
            *guard = None;
        }
    }
}

// 平台封装：Windows 不弹控制台黑框，其他平台直接 spawn
#[cfg(windows)]
fn spawn_dsh() -> Result<Child, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    Command::new("cmd")
        .args(["/C", "pnpm dsh web"])
        .current_dir(PathBuf::from(DSH_DIR))
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("启动 dsh 失败: {e}"))
}

#[cfg(not(windows))]
fn spawn_dsh() -> Result<Child, String> {
    Command::new("pnpm")
        .args(["dsh", "web"])
        .current_dir(PathBuf::from(DSH_DIR))
        .spawn()
        .map_err(|e| format!("启动 dsh 失败: {e}"))
}
