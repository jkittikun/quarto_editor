//! Source control and virtual-environment helpers. Only fixed git subcommands are run (no generic
//! command runner); git never prompts (GIT_TERMINAL_PROMPT=0) so it can't hang on credentials.

use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Command, Stdio};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Serialize, Default, PartialEq)]
pub struct GitFile {
    pub path: String,
    pub index: String,
    pub worktree: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orig: Option<String>,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub installed: bool,
    pub is_repo: bool,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub remote: Option<String>,
    pub has_commits: bool,
    pub files: Vec<GitFile>,
}

#[derive(Debug, Serialize)]
pub struct ProcResult {
    pub ok: bool,
    pub code: Option<i32>,
    pub output: String,
}

fn git(cwd: &Path, args: &[&str]) -> std::io::Result<std::process::Output> {
    Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null())
        .output()
}

fn result(out: std::io::Result<std::process::Output>) -> ProcResult {
    match out {
        Ok(o) => ProcResult {
            ok: o.status.success(),
            code: o.status.code(),
            output: format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr)),
        },
        Err(e) => ProcResult { ok: false, code: None, output: format!("Could not run git: {e}") },
    }
}

/// Parse `git status --porcelain=v2 --branch -z` (same rules as parseGitStatus in src/core/git.ts).
pub fn parse_status(out: &str, st: &mut GitStatus) {
    st.has_commits = true;
    let recs: Vec<&str> = out.split('\0').collect();
    let mut i = 0;
    while i < recs.len() {
        let r = recs[i];
        if let Some(v) = r.strip_prefix("# branch.oid ") {
            st.has_commits = v != "(initial)";
        } else if let Some(v) = r.strip_prefix("# branch.head ") {
            st.branch = Some(if v == "(detached)" { "detached".into() } else { v.into() });
        } else if let Some(v) = r.strip_prefix("# branch.upstream ") {
            st.upstream = Some(v.into());
        } else if let Some(v) = r.strip_prefix("# branch.ab ") {
            for part in v.split(' ') {
                if let Some(n) = part.strip_prefix('+') {
                    st.ahead = n.parse().unwrap_or(0);
                } else if let Some(n) = part.strip_prefix('-') {
                    st.behind = n.parse().unwrap_or(0);
                }
            }
        } else if r.starts_with("1 ") || r.starts_with("2 ") || r.starts_with("u ") {
            let parts: Vec<&str> = r.split(' ').collect();
            let xy: Vec<char> = parts.get(1).unwrap_or(&"..").chars().collect();
            let skip = match &r[..1] {
                "1" => 8,
                "2" => 9,
                _ => 10,
            };
            let path = parts.get(skip..).map(|p| p.join(" ")).unwrap_or_default();
            let mut f = GitFile {
                path,
                index: xy.first().copied().unwrap_or('.').to_string(),
                worktree: xy.get(1).copied().unwrap_or('.').to_string(),
                orig: None,
            };
            if r.starts_with("u ") {
                f.index = "U".into();
                f.worktree = "U".into();
            }
            if r.starts_with("2 ") {
                i += 1;
                f.orig = recs.get(i).map(|s| s.to_string());
            }
            st.files.push(f);
        } else if let Some(p) = r.strip_prefix("? ") {
            st.files.push(GitFile { path: p.into(), index: "?".into(), worktree: "?".into(), orig: None });
        }
        i += 1;
    }
}

pub fn status(root: &Path) -> GitStatus {
    let mut st = GitStatus::default();
    if git(root, &["--version"]).map(|o| o.status.success()).unwrap_or(false) {
        st.installed = true;
    } else {
        return st;
    }
    let prefix = match git(root, &["rev-parse", "--show-prefix"]) {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).trim().to_string(),
        _ => return st,
    };
    st.is_repo = true;
    if let Ok(o) = git(root, &["status", "--porcelain=v2", "--branch", "-z", "--", "."]) {
        parse_status(&String::from_utf8_lossy(&o.stdout), &mut st);
    }
    // the project may be a sub-folder of a larger repository: keep its files, relative to it
    st.files = st
        .files
        .into_iter()
        .filter(|f| f.path.starts_with(&prefix))
        .map(|mut f| {
            f.path = f.path[prefix.len()..].to_string();
            f
        })
        .collect();
    if let Ok(o) = git(root, &["remote", "get-url", "origin"]) {
        if o.status.success() {
            st.remote = Some(String::from_utf8_lossy(&o.stdout).trim().to_string());
        }
    }
    st
}

pub const DEFAULT_GITIGNORE: &[&str] = &["/.quarto/", "/_book/", "/_site/", "/_freeze/", ".folio/", "*_files/", ".venv/"];

/// Append missing entries to a .gitignore (same as mergeGitignore in src/core/git.ts).
pub fn merge_gitignore(existing: &str, entries: &[&str]) -> String {
    let have: Vec<&str> = existing.lines().map(str::trim).collect();
    let missing: Vec<&str> = entries
        .iter()
        .copied()
        .filter(|e| !have.contains(e) && !have.contains(&e.trim_start_matches('/')))
        .collect();
    if missing.is_empty() {
        return existing.to_string();
    }
    let mut out = existing.to_string();
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    out.push_str(&missing.join("\n"));
    out.push('\n');
    out
}

pub fn init(root: &Path) -> ProcResult {
    let mut r = result(git(root, &["init", "-b", "main"]));
    if !r.ok {
        r = result(git(root, &["init"]));
    }
    let gi = root.join(".gitignore");
    let cur = std::fs::read_to_string(&gi).unwrap_or_default();
    let _ = std::fs::write(&gi, merge_gitignore(&cur, DEFAULT_GITIGNORE));
    r
}

/// Commit what is staged (the panel stages everything first for "Commit All").
pub fn commit(root: &Path, message: &str) -> ProcResult {
    result(git(root, &["commit", "-m", message]))
}

pub fn set_identity(root: &Path, name: &str, email: &str) -> ProcResult {
    let a = result(git(root, &["config", "user.name", name]));
    let b = result(git(root, &["config", "user.email", email]));
    ProcResult { ok: a.ok && b.ok, code: b.code, output: a.output + &b.output }
}

pub fn show_head(root: &Path, rel: &str) -> Option<String> {
    let spec = format!("HEAD:./{}", rel.replace('\\', "/"));
    let o = git(root, &["show", &spec]).ok()?;
    o.status.success().then(|| String::from_utf8_lossy(&o.stdout).into_owned())
}

#[derive(Clone, Serialize)]
struct LogLine<'a> {
    req: &'a str,
    line: String,
}

/// Run fixed steps in order, streaming output as `proc-log` events; stops at the first failure.
pub fn run_steps(app: &AppHandle, req: &str, cwd: &Path, steps: &[(String, Vec<String>)]) -> ProcResult {
    let mut output = String::new();
    for (prog, args) in steps {
        let short = Path::new(prog).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let _ = app.emit("proc-log", LogLine { req, line: format!("$ {short} {}", args.join(" ")) });
        let child = Command::new(prog)
            .args(args)
            .current_dir(cwd)
            .env("GIT_TERMINAL_PROMPT", "0")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn();
        let mut child = match child {
            Ok(c) => c,
            Err(e) => {
                let line = format!("Could not run {prog}: {e}");
                let _ = app.emit("proc-log", LogLine { req, line: line.clone() });
                output.push_str(&line);
                return ProcResult { ok: false, code: None, output };
            }
        };
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        let readers: Vec<Box<dyn std::io::Read + Send>> =
            vec![Box::new(child.stdout.take().unwrap()), Box::new(child.stderr.take().unwrap())];
        for r in readers {
            let tx = tx.clone();
            std::thread::spawn(move || {
                for line in BufReader::new(r).lines().map_while(Result::ok) {
                    let _ = tx.send(line);
                }
            });
        }
        drop(tx);
        let status = loop {
            while let Ok(line) = rx.try_recv() {
                output.push_str(&line);
                output.push('\n');
                let _ = app.emit("proc-log", LogLine { req, line });
            }
            match child.try_wait() {
                Ok(Some(s)) => break s,
                Ok(None) => std::thread::sleep(std::time::Duration::from_millis(30)),
                Err(e) => return ProcResult { ok: false, code: None, output: format!("{output}{e}") },
            }
        };
        // drain what is left (don't wait for pipes held open by grandchildren)
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);
        while let Ok(line) = rx.recv_timeout(deadline.saturating_duration_since(std::time::Instant::now())) {
            output.push_str(&line);
            output.push('\n');
            let _ = app.emit("proc-log", LogLine { req, line });
        }
        if !status.success() {
            return ProcResult { ok: false, code: status.code(), output };
        }
    }
    ProcResult { ok: true, code: Some(0), output }
}

fn path_args(paths: &Option<Vec<String>>) -> Vec<String> {
    match paths {
        None => vec![".".into()],
        Some(v) => v.clone(),
    }
}

pub fn stage(root: &Path, paths: &Option<Vec<String>>) -> ProcResult {
    let mut args: Vec<String> = vec!["add".into(), "-A".into(), "--".into()];
    args.extend(path_args(paths));
    result(git(root, &args.iter().map(String::as_str).collect::<Vec<_>>()))
}

pub fn unstage(root: &Path, paths: &Option<Vec<String>>) -> ProcResult {
    let mut args: Vec<String> = vec!["restore".into(), "--staged".into(), "--".into()];
    args.extend(path_args(paths));
    let r = result(git(root, &args.iter().map(String::as_str).collect::<Vec<_>>()));
    if r.ok {
        return r;
    }
    // no commits yet: unstage by removing from the index
    let mut args: Vec<String> = vec!["rm".into(), "--cached".into(), "-r".into(), "-q".into(), "--".into()];
    args.extend(path_args(paths));
    result(git(root, &args.iter().map(String::as_str).collect::<Vec<_>>()))
}

pub fn discard(root: &Path, tracked: &[String], untracked: &[String]) -> ProcResult {
    let mut out = ProcResult { ok: true, code: Some(0), output: String::new() };
    if !tracked.is_empty() {
        let mut args = vec!["restore", "--staged", "--worktree", "--source=HEAD", "--"];
        args.extend(tracked.iter().map(String::as_str));
        let r = result(git(root, &args));
        out.ok &= r.ok;
        out.output += &r.output;
    }
    if !untracked.is_empty() {
        let mut args = vec!["clean", "-f", "-q", "--"];
        args.extend(untracked.iter().map(String::as_str));
        let r = result(git(root, &args));
        out.ok &= r.ok;
        out.output += &r.output;
    }
    if !out.ok {
        out.code = Some(1);
    }
    out
}

pub fn log(root: &Path, limit: u32) -> String {
    let n = format!("-n{}", limit.clamp(1, 1000));
    match git(root, &["log", "--topo-order", "--date=relative", &n, "--all", "--format=%H%x1f%P%x1f%an%x1f%ar%x1f%s%x1f%D"]) {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).into_owned(),
        _ => String::new(),
    }
}

pub fn valid_venv_name(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && name.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_porcelain_v2() {
        let out = "# branch.oid abc\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -1\0\
1 .M N... 100644 100644 100644 aaa bbb intro.qmd\0\
2 RM N... 100644 100644 100644 aaa aaa R100 new name.qmd\0old.qmd\0? notes.txt\0";
        let mut st = GitStatus::default();
        parse_status(out, &mut st);
        assert_eq!(st.branch.as_deref(), Some("main"));
        assert_eq!((st.ahead, st.behind), (2, 1));
        assert!(st.has_commits);
        assert_eq!(st.files.len(), 3);
        assert_eq!(st.files[0], GitFile { path: "intro.qmd".into(), index: ".".into(), worktree: "M".into(), orig: None });
        assert_eq!(st.files[1].path, "new name.qmd");
        assert_eq!(st.files[1].orig.as_deref(), Some("old.qmd"));
        assert_eq!(st.files[2].index, "?");
    }

    #[test]
    fn merges_gitignore_without_duplicates() {
        assert_eq!(merge_gitignore("_book/\n", &["/_book/", ".folio/"]), "_book/\n.folio/\n");
        assert_eq!(merge_gitignore("a", &["a"]), "a");
    }

    #[test]
    fn validates_venv_names() {
        assert!(valid_venv_name(".venv"));
        assert!(!valid_venv_name("../evil"));
        assert!(!valid_venv_name("a/b"));
    }

    #[test]
    fn init_commit_show_in_temp_repo() {
        if git(Path::new("."), &["--version"]).is_err() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("folio-git-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert!(init(&dir).ok);
        assert!(std::fs::read_to_string(dir.join(".gitignore")).unwrap().contains(".folio/"));
        std::fs::write(dir.join("a.qmd"), "# A\n").unwrap();
        assert!(set_identity(&dir, "Test", "test@example.com").ok);
        let st = status(&dir);
        assert!(st.is_repo && !st.has_commits);
        assert!(st.files.iter().any(|f| f.path == "a.qmd" && f.index == "?"));
        assert!(stage(&dir, &None).ok);
        assert!(commit(&dir, "first").ok);
        assert_eq!(show_head(&dir, "a.qmd").as_deref(), Some("# A\n"));
        assert_eq!(show_head(&dir, "missing.qmd"), None);
        // stage / unstage / discard / log
        std::fs::write(dir.join("a.qmd"), "# A changed\n").unwrap();
        std::fs::write(dir.join("b.qmd"), "# B\n").unwrap();
        assert!(stage(&dir, &Some(vec!["a.qmd".into()])).ok);
        let st = status(&dir);
        assert!(st.files.iter().any(|f| f.path == "a.qmd" && f.index == "M"));
        assert!(unstage(&dir, &None).ok);
        let st = status(&dir);
        assert!(st.files.iter().any(|f| f.path == "a.qmd" && f.index == "." && f.worktree == "M"));
        assert!(discard(&dir, &["a.qmd".into()], &["b.qmd".into()]).ok);
        assert_eq!(std::fs::read_to_string(dir.join("a.qmd")).unwrap(), "# A\n");
        assert!(!dir.join("b.qmd").exists());
        assert!(log(&dir, 10).contains("first"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
