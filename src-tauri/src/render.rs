//! `quarto render` with streamed log output.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Serialize)]
pub struct RenderResult {
    ok: bool,
    code: Option<i32>,
    output: Option<String>,
}

#[derive(Clone, Serialize)]
struct LogLine<'a> {
    req: &'a str,
    line: String,
}

pub fn quarto_bin() -> String {
    std::env::var("QUARTO_PATH").unwrap_or_else(|_| "quarto".into())
}

/// Parse quarto's "Output created: <path>" line.
pub fn parse_output_line(line: &str) -> Option<&str> {
    line.split_once("Output created:").map(|(_, p)| p.trim()).filter(|p| !p.is_empty())
}

pub fn run(app: &AppHandle, req: &str, root: &Path, target: Option<&Path>) -> Result<RenderResult, String> {
    let mut cmd = Command::new(quarto_bin());
    cmd.arg("render");
    if let Some(t) = target {
        cmd.arg(t);
    }
    cmd.current_dir(root)
        .env("QUARTO_PYTHON", crate::project::find_python(Some(root)))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let _ = app.emit("render-log", LogLine {
                req,
                line: format!("Could not run quarto: {e}. Is Quarto installed (https://quarto.org/docs/get-started/)?"),
            });
            return Ok(RenderResult { ok: false, code: None, output: None });
        }
    };

    let output: Arc<Mutex<Option<PathBuf>>> = Arc::new(Mutex::new(None));
    let mut readers = Vec::new();
    let streams: Vec<Box<dyn std::io::Read + Send>> = vec![
        Box::new(child.stdout.take().unwrap()),
        Box::new(child.stderr.take().unwrap()),
    ];
    for stream in streams {
        let app = app.clone();
        let req = req.to_owned();
        let output = output.clone();
        let root = root.to_path_buf();
        readers.push(std::thread::spawn(move || {
            for line in BufReader::new(stream).lines().map_while(Result::ok) {
                if let Some(p) = parse_output_line(&line) {
                    *output.lock().unwrap() = Some(root.join(p));
                }
                let _ = app.emit("render-log", LogLine { req: &req, line });
            }
        }));
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    for r in readers {
        let _ = r.join();
    }
    let out = output.lock().unwrap().take();
    Ok(RenderResult {
        ok: status.success(),
        code: status.code(),
        output: out.map(|p| p.to_string_lossy().into_owned()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_output_created() {
        assert_eq!(parse_output_line("Output created: _book/intro.html"), Some("_book/intro.html"));
        assert_eq!(parse_output_line("[1/3] intro.qmd"), None);
    }
}
