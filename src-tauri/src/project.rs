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


/// Python interpreter found on this machine (mirrors `PythonEnv` in src/backend/types.ts).
#[derive(Debug, Clone, serde::Serialize, PartialEq)]
pub struct PythonEnv {
    pub path: String,
    pub label: String,
    pub source: String,
    pub version: Option<String>,
    pub ready: bool,
}

/// Python snippet printing "<version> <ready>" (same as PROBE in src/core/python.ts).
const PROBE: &str = "import sys,importlib.util as u;print(sys.version.split()[0], all(u.find_spec(m) is not None for m in ('jupyter_client','ipykernel')))";

/// Reject anything that isn't `python3`/`python` on PATH or an existing file.
pub fn check_python(p: &str) -> Result<(), String> {
    if p == "python3" || p == "python" {
        return Ok(());
    }
    let path = Path::new(p);
    if path.is_absolute() && path.is_file() {
        Ok(())
    } else {
        Err(format!("Not a Python interpreter: {p}"))
    }
}

fn list_dir(dir: &Path) -> Vec<String> {
    std::fs::read_dir(dir)
        .map(|it| it.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect())
        .unwrap_or_default()
}

/// Candidate interpreters in priority order: project venvs, FOLIO_PYTHON/QUARTO_PYTHON, conda,
/// pyenv, then system pythons. Keep in sync with `pythonCandidates` in src/core/python.ts.
pub fn python_candidates(root: &Path, home: &Path) -> Vec<(String, String, String)> {
    let bin = if cfg!(windows) { "Scripts/python.exe" } else { "bin/python" };
    let mut out: Vec<(String, String, String)> = Vec::new();
    let mut add = |path: String, label: String, source: &str| {
        if !out.iter().any(|c| c.0 == path) {
            out.push((path, label, source.to_owned()));
        }
    };
    for name in [".venv", "venv", "env", ".env"] {
        let p = root.join(name).join(bin);
        if p.exists() {
            add(p.to_string_lossy().into_owned(), name.into(), "project");
        }
    }
    let mut names = list_dir(root);
    names.sort();
    for name in names {
        let d = root.join(&name);
        if d.join("pyvenv.cfg").exists() && d.join(bin).exists() {
            add(d.join(bin).to_string_lossy().into_owned(), name, "project");
        }
    }
    for var in ["FOLIO_PYTHON", "QUARTO_PYTHON"] {
        if let Ok(v) = std::env::var(var) {
            if !v.is_empty() {
                add(v, var.into(), "env");
            }
        }
    }
    let conda_roots: Vec<PathBuf> =
        ["miniconda3", "anaconda3", "miniforge3", "mambaforge"].iter().map(|d| home.join(d)).collect();
    let mut conda_dirs: Vec<PathBuf> = std::fs::read_to_string(home.join(".conda/environments.txt"))
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(PathBuf::from)
        .collect();
    for r in &conda_roots {
        if r.join(bin).exists() {
            conda_dirs.push(r.clone());
        }
        let mut envs = list_dir(&r.join("envs"));
        envs.sort();
        for e in envs {
            conda_dirs.push(r.join("envs").join(e));
        }
    }
    for d in conda_dirs {
        if !d.join(bin).exists() {
            continue;
        }
        let name = if conda_roots.contains(&d) {
            "base".to_owned()
        } else {
            d.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
        };
        add(d.join(bin).to_string_lossy().into_owned(), format!("conda: {name}"), "conda");
    }
    let mut versions = list_dir(&home.join(".pyenv/versions"));
    versions.sort();
    for v in versions {
        let p = home.join(".pyenv/versions").join(&v).join(bin);
        if p.exists() {
            add(p.to_string_lossy().into_owned(), format!("pyenv {v}"), "pyenv");
        }
    }
    for p in ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"] {
        if Path::new(p).exists() {
            add(p.into(), if p.starts_with("/opt/homebrew") { "Homebrew".into() } else { "system".into() }, "system");
        }
    }
    add("python3".into(), "python3 on PATH".into(), "system");
    out
}

/// Run the probe with a timeout; returns (version, ready).
fn probe_python(path: &str) -> Option<(String, bool)> {
    let mut child = std::process::Command::new(path)
        .args(["-c", PROBE])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(4);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < deadline => std::thread::sleep(std::time::Duration::from_millis(25)),
            _ => {
                let _ = child.kill();
                return None;
            }
        }
    }
    let mut out = String::new();
    use std::io::Read;
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    let mut parts = out.split_whitespace();
    let version = parts.next()?.to_owned();
    let ready = parts.next()? == "True";
    version.chars().next()?.is_ascii_digit().then_some((version, ready))
}

/// Detect and probe interpreters (in parallel), de-duplicated by real path.
pub fn list_pythons(root: &Path, extra: &[String]) -> Vec<PythonEnv> {
    let home = std::env::var("HOME").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("/"));
    let mut cands = python_candidates(root, &home);
    for e in extra {
        if !e.is_empty() && !cands.iter().any(|c| &c.0 == e) {
            cands.push((e.clone(), "custom".into(), "custom".into()));
        }
    }
    let mut seen = HashSet::new();
    cands.retain(|c| {
        let real = std::fs::canonicalize(&c.0).map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|_| c.0.clone());
        seen.insert(real)
    });
    let handles: Vec<_> = cands
        .into_iter()
        .map(|(path, label, source)| {
            std::thread::spawn(move || {
                let probe = probe_python(&path);
                (path, label, source, probe)
            })
        })
        .collect();
    handles
        .into_iter()
        .filter_map(|h| h.join().ok())
        .filter(|(_, _, source, probe)| probe.is_some() || source == "custom")
        .map(|(path, label, source, probe)| PythonEnv {
            path,
            label,
            source,
            version: probe.as_ref().map(|p| p.0.clone()),
            ready: probe.map(|p| p.1).unwrap_or(false),
        })
        .collect()
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

    #[cfg(unix)]
    #[test]
    fn detects_project_venv() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("folio-py-test-{}", std::process::id()));
        let bin = root.join(".venv/bin");
        std::fs::create_dir_all(&bin).unwrap();
        let py = bin.join("python");
        std::fs::write(&py, "#!/bin/sh\necho '3.12.3 True'\n").unwrap();
        std::fs::set_permissions(&py, std::fs::Permissions::from_mode(0o755)).unwrap();
        let envs = list_pythons(&root, &[]);
        let first = &envs[0];
        assert_eq!(first.label, ".venv");
        assert_eq!(first.source, "project");
        assert_eq!(first.version.as_deref(), Some("3.12.3"));
        assert!(first.ready);
        assert!(check_python(py.to_str().unwrap()).is_ok());
        assert!(check_python("rm").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn ignores_build_output() {
        let root = Path::new("/p");
        assert!(is_ignored(root, Path::new("/p/_book/index.html")));
        assert!(is_ignored(root, Path::new("/p/intro_files/figure-html/a.png")));
        assert!(!is_ignored(root, Path::new("/p/intro.qmd")));
    }
}
