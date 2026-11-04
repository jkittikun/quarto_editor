//! Runs `kernel/folio_kernel.py` (a small jupyter_client bridge) and relays its
//! newline-delimited JSON messages to the webview as `kernel-msg` events.

use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};

use tauri::{AppHandle, Emitter, Manager};

const SCRIPT: &str = include_str!("../../kernel/folio_kernel.py");

pub struct Kernel {
    child: Child,
    stdin: ChildStdin,
    pub python: String,
}

impl Kernel {
    pub fn spawn(app: &AppHandle, root: Option<&Path>, python: Option<&str>) -> Result<Self, String> {
        let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let script = dir.join("folio_kernel.py");
        std::fs::write(&script, SCRIPT).map_err(|e| e.to_string())?;

        let python = python.map(str::to_owned).unwrap_or_else(|| crate::project::find_python(root));
        let mut child = Command::new(&python)
            .arg(&script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("Could not start Python ({python}): {e}. Set FOLIO_PYTHON to your interpreter."))?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let app = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                    let _ = app.emit("kernel-msg", v);
                }
            }
        });
        Ok(Kernel { child, stdin, python })
    }

    pub fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    pub fn send(&mut self, msg: &serde_json::Value) -> Result<(), String> {
        let line = serde_json::to_string(msg).map_err(|e| e.to_string())?;
        writeln!(self.stdin, "{line}").map_err(|e| e.to_string())?;
        self.stdin.flush().map_err(|e| e.to_string())
    }

    pub fn shutdown(&mut self) {
        let _ = self.send(&serde_json::json!({ "op": "shutdown" }));
        std::thread::sleep(std::time::Duration::from_millis(300));
        let _ = self.child.kill();
    }
}
