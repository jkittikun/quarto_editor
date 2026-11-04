//! `quarto render` with streamed log output.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Serialize)]
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

/// Run `quarto render` from the Tauri command, streaming lines as `render-log` events.
pub fn run(
    app: &AppHandle,
    req: &str,
    root: &Path,
    target: Option<&Path>,
    to: Option<&str>,
    python: Option<&str>,
) -> Result<RenderResult, String> {
    let app = app.clone();
    let req_owned = req.to_owned();
    let emit = move |line: String| {
        let _ = app.emit("render-log", LogLine { req: &req_owned, line });
    };
    let mut extra: Vec<String> = Vec::new();
    if let Some(to) = to {
        extra.push("--to".into());
        extra.push(to.into());
    }
    let python = python.map(str::to_owned).unwrap_or_else(|| crate::project::find_python(Some(root)));
    run_with(&quarto_bin(), root, target, &extra, &python, emit)
}

/// Run `<quarto> render [target]` in `root`, sending each output line to `emit`.
///
/// Completion is decided by the quarto process exiting, not by its pipes closing: Quarto can
/// leave a background process (its Jupyter daemon) that inherits stdout/stderr and keeps them
/// open long after the render is done.
pub fn run_with(
    quarto: &str,
    root: &Path,
    target: Option<&Path>,
    extra_args: &[String],
    python: &str,
    emit: impl Fn(String) + Send + Sync + 'static,
) -> Result<RenderResult, String> {
    let emit = Arc::new(emit);
    let mut cmd = Command::new(quarto);
    cmd.arg("render");
    if let Some(t) = target {
        cmd.arg(t);
    }
    cmd.args(extra_args);
    cmd.current_dir(root)
        .env("QUARTO_PYTHON", python)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            emit(format!("Could not run quarto: {e}. Is Quarto installed (https://quarto.org/docs/get-started/)?"));
            return Ok(RenderResult { ok: false, code: None, output: None });
        }
    };

    let output: Arc<Mutex<Option<PathBuf>>> = Arc::new(Mutex::new(None));
    let (eof_tx, eof_rx) = mpsc::channel::<()>();
    let streams: Vec<Box<dyn std::io::Read + Send>> = vec![
        Box::new(child.stdout.take().unwrap()),
        Box::new(child.stderr.take().unwrap()),
    ];
    let n_streams = streams.len();
    for stream in streams {
        let emit = emit.clone();
        let output = output.clone();
        let root = root.to_path_buf();
        let eof_tx = eof_tx.clone();
        // Detached: if a leftover process keeps the pipe open, the thread ends when it closes.
        std::thread::spawn(move || {
            for line in BufReader::new(stream).lines().map_while(Result::ok) {
                if let Some(p) = parse_output_line(&line) {
                    *output.lock().unwrap() = Some(root.join(p));
                }
                emit(line);
            }
            let _ = eof_tx.send(());
        });
    }
    drop(eof_tx);

    let status = child.wait().map_err(|e| e.to_string())?;
    // Give the readers a moment to drain what quarto wrote before exiting, but don't wait for EOF.
    let deadline = Instant::now() + Duration::from_millis(1000);
    for _ in 0..n_streams {
        let left = deadline.saturating_duration_since(Instant::now());
        if eof_rx.recv_timeout(left).is_err() {
            break;
        }
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

    /// A render whose background process keeps stdout open must still finish promptly.
    #[cfg(unix)]
    #[test]
    fn finishes_when_quarto_exits_even_if_pipes_stay_open() {
        let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/e2e/fake-quarto.sh");
        let dir = std::env::temp_dir().join(format!("folio-render-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let lines = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink = lines.clone();
        let t0 = Instant::now();
        let res = run_with(script.to_str().unwrap(), &dir, None, &[], "python3", move |l| sink.lock().unwrap().push(l)).unwrap();
        assert!(t0.elapsed() < Duration::from_secs(3), "render took {:?}", t0.elapsed());
        assert!(res.ok);
        assert_eq!(res.output.as_deref(), Some(dir.join("_book/intro.html").to_str().unwrap()));
        assert!(lines.lock().unwrap().iter().any(|l| l.contains("Output created")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn passes_extra_args_for_pdf_export() {
        let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/e2e/fake-quarto.sh");
        let dir = std::env::temp_dir().join(format!("folio-pdf-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let args = vec!["--to".to_string(), "pdf".to_string()];
        let res = run_with(script.to_str().unwrap(), &dir, None, &args, "python3", |_| {}).unwrap();
        assert!(res.ok);
        assert_eq!(res.output.as_deref(), Some(dir.join("_book/book.pdf").to_str().unwrap()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reports_missing_quarto() {
        let res = run_with("/nonexistent/quarto", Path::new("."), None, &[], "python3", |_| {}).unwrap();
        assert!(!res.ok);
        assert_eq!(res.code, None);
    }
}
