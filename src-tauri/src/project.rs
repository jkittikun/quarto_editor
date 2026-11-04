use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

use notify::{RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter};

const IGNORE_DIRS: &[&str] = &[
    ".git", "node_modules", ".quarto", "_book", "_site", "_freeze", ".venv", "venv",
    "__pycache__", ".folio", ".ipynb_checkpoints",
];

fn ignored_dir(name: &str) -> bool {
    IGNORE_DIRS.contains(&name) || name.ends_with("_files")
}

/// List project files (relative, '/'-separated), skipping build output and hidden folders.
pub fn list_files(root: &Path) -> Vec<String> {
    fn walk(dir: &Path, rel: &str, out: &mut Vec<String>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let child_rel = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                if !ignored_dir(&name) {
                    walk(&e.path(), &child_rel, out);
                }
            } else {
                out.push(child_rel);
            }
        }
    }
    let mut out = Vec::new();
    walk(root, "", &mut out);
    out.sort();
    out
}

fn is_ignored(root: &Path, p: &Path) -> bool {
    let Ok(rel) = p.strip_prefix(root) else { return true };
    rel.components().any(|c| {
        let s = c.as_os_str().to_string_lossy();
        ignored_dir(&s) || s.ends_with(".folio-tmp")
    })
}

/// Watch a project recursively and emit debounced `fs-change` events with absolute paths.
pub fn watch(app: AppHandle, root: PathBuf) -> notify::Result<notify::RecommendedWatcher> {
    let (tx, rx) = mpsc::channel::<PathBuf>();
    let root2 = root.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            for p in ev.paths {
                if !is_ignored(&root2, &p) {
                    let _ = tx.send(p);
                }
            }
        }
    })?;
    watcher.watch(&root, RecursiveMode::Recursive)?;
    std::thread::spawn(move || {
        while let Ok(first) = rx.recv() {
            let mut batch: HashSet<String> = HashSet::new();
            batch.insert(first.to_string_lossy().into_owned());
            while let Ok(p) = rx.recv_timeout(Duration::from_millis(120)) {
                batch.insert(p.to_string_lossy().into_owned());
            }
            let _ = app.emit("fs-change", batch.into_iter().collect::<Vec<_>>());
        }
    });
    Ok(watcher)
}

/// Apps launched from Finder get a minimal PATH; borrow the user's login-shell PATH so
/// `quarto` and `python3` (Homebrew, conda, pyenv…) can be found.
pub fn fix_path_env() {
    #[cfg(unix)]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        if let Ok(out) = std::process::Command::new(shell)
            .args(["-ilc", "printf '__FOLIO_PATH__%s' \"$PATH\""])
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output()
        {
            let s = String::from_utf8_lossy(&out.stdout);
            if let Some(idx) = s.rfind("__FOLIO_PATH__") {
                let path = s[idx + "__FOLIO_PATH__".len()..].trim();
                if !path.is_empty() {
                    let extra = ["/usr/local/bin", "/opt/homebrew/bin", "/Applications/quarto/bin"];
                    let mut parts: Vec<String> = path.split(':').map(str::to_owned).collect();
                    for e in extra {
                        if !parts.iter().any(|p| p == e) {
                            parts.push(e.to_owned());
                        }
                    }
                    std::env::set_var("PATH", parts.join(":"));
                }
            }
        }
    }
}

/// Pick the Python interpreter for a project: FOLIO_PYTHON, QUARTO_PYTHON, a local venv, then python3.
pub fn find_python(root: Option<&Path>) -> String {
    for var in ["FOLIO_PYTHON", "QUARTO_PYTHON"] {
        if let Ok(v) = std::env::var(var) {
            if !v.is_empty() {
                return v;
            }
        }
    }
    if let Some(root) = root {
        for c in [".venv/bin/python", "venv/bin/python", "env/bin/python", ".venv/Scripts/python.exe"] {
            let p = root.join(c);
            if p.exists() {
                return p.to_string_lossy().into_owned();
            }
        }
    }
    if cfg!(windows) { "python".into() } else { "python3".into() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_example_book() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/book");
        let files = list_files(&root);
        assert!(files.contains(&"_quarto.yml".to_string()));
        assert!(files.contains(&"images/growth.svg".to_string()));
        assert!(!files.iter().any(|f| f.starts_with(".folio")));
    }

    #[test]
    fn ignores_build_output() {
        let root = Path::new("/p");
        assert!(is_ignored(root, Path::new("/p/_book/index.html")));
        assert!(is_ignored(root, Path::new("/p/intro_files/figure-html/a.png")));
        assert!(!is_ignored(root, Path::new("/p/intro.qmd")));
    }
}
