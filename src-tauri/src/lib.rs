//! Folio native backend: file access scoped to opened projects, a file watcher,
//! the Python kernel bridge and `quarto render`.

mod git;
mod kernel;
mod project;
mod render;

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

#[derive(Default)]
pub struct AppState {
    roots: Mutex<Vec<PathBuf>>,
    watchers: Mutex<Vec<notify::RecommendedWatcher>>,
    kernel: Mutex<Option<kernel::Kernel>>,
}

#[derive(Debug, Serialize)]
pub struct CmdError(String);
impl<E: std::fmt::Display> From<E> for CmdError {
    fn from(e: E) -> Self {
        CmdError(e.to_string())
    }
}
type CmdResult<T> = Result<T, CmdError>;

/// Resolve `path` and make sure it lives inside one of the opened project roots.
fn checked(state: &AppState, path: &str) -> CmdResult<PathBuf> {
    let p = PathBuf::from(path);
    // For files that don't exist yet, canonicalize the closest existing ancestor.
    let mut existing = p.clone();
    let mut tail = Vec::new();
    while !existing.exists() {
        match (existing.file_name(), existing.parent()) {
            (Some(name), Some(parent)) => {
                tail.push(name.to_owned());
                existing = parent.to_path_buf();
            }
            _ => return Err(CmdError(format!("invalid path: {path}"))),
        }
    }
    let mut canon = existing.canonicalize()?;
    for t in tail.iter().rev() {
        if t == ".." {
            return Err(CmdError(format!("invalid path: {path}")));
        }
        canon.push(t);
    }
    let roots = state.roots.lock().unwrap();
    if roots.iter().any(|r| canon.starts_with(r)) {
        Ok(canon)
    } else {
        Err(CmdError(format!("path is outside the opened project: {path}")))
    }
}

#[tauri::command]
fn open_project(app: AppHandle, state: State<'_, AppState>, root: String) -> CmdResult<Vec<String>> {
    let root = Path::new(&root).canonicalize()?;
    if !root.is_dir() {
        return Err(CmdError(format!("not a folder: {}", root.display())));
    }
    {
        let mut roots = state.roots.lock().unwrap();
        if !roots.contains(&root) {
            roots.push(root.clone());
            app.asset_protocol_scope().allow_directory(&root, true)?;
            let watcher = project::watch(app.clone(), root.clone())?;
            state.watchers.lock().unwrap().push(watcher);
        }
    }
    Ok(project::list_files(&root))
}

#[tauri::command]
fn read_file(state: State<'_, AppState>, path: String) -> CmdResult<String> {
    Ok(std::fs::read_to_string(checked(&state, &path)?)?)
}

#[tauri::command]
fn write_file(state: State<'_, AppState>, path: String, content: String) -> CmdResult<()> {
    let p = checked(&state, &path)?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // Atomic write: never leave a half-written chapter behind.
    let tmp = p.with_extension(format!(
        "{}.folio-tmp",
        p.extension().and_then(|e| e.to_str()).unwrap_or("")
    ));
    std::fs::write(&tmp, content)?;
    std::fs::rename(&tmp, &p)?;
    Ok(())
}

#[tauri::command]
fn path_exists(state: State<'_, AppState>, path: String) -> CmdResult<bool> {
    Ok(checked(&state, &path)?.exists())
}

#[tauri::command]
fn kernel_send(app: AppHandle, state: State<'_, AppState>, msg: serde_json::Value) -> CmdResult<()> {
    let mut msg = msg;
    if let Some(cwd) = msg.get("cwd").and_then(|v| v.as_str()).map(str::to_owned) {
        msg["cwd"] = serde_json::Value::String(checked(&state, &cwd)?.to_string_lossy().into_owned());
    }
    let op = msg.get("op").and_then(|v| v.as_str()).unwrap_or("");
    let mut guard = state.kernel.lock().unwrap();
    if op == "execute" {
        let root = {
            let cwd = msg.get("cwd").and_then(|v| v.as_str()).unwrap_or("");
            let roots = state.roots.lock().unwrap();
            roots.iter().find(|r| Path::new(cwd).starts_with(r)).cloned()
        };
        let python = msg.get("python").and_then(|v| v.as_str()).filter(|p| !p.is_empty()).map(str::to_owned);
        if let Some(p) = &python {
            project::check_python(p)?;
        }
        let wanted = python.clone().unwrap_or_else(|| project::find_python(root.as_deref()));
        let reuse = guard.as_mut().map(|k| k.alive() && k.python == wanted).unwrap_or(false);
        if !reuse {
            if let Some(mut old) = guard.take() {
                old.shutdown();
            }
            *guard = Some(kernel::Kernel::spawn(&app, root.as_deref(), Some(&wanted))?);
        }
    }
    if let Some(k) = guard.as_mut() {
        k.send(&msg)?;
    }
    Ok(())
}

#[tauri::command]
async fn render(
    app: AppHandle,
    req: String,
    root: String,
    target: Option<String>,
    to: Option<String>,
    python: Option<String>,
) -> CmdResult<render::RenderResult> {
    let state = app.state::<AppState>();
    let root = checked(&state, &root)?;
    let target = match target {
        Some(t) => Some(checked(&state, &t)?),
        None => None,
    };
    if let Some(p) = &python {
        project::check_python(p)?;
    }
    let app2 = app.clone();
    let res = tauri::async_runtime::spawn_blocking(move || {
        render::run(&app2, &req, &root, target.as_deref(), to.as_deref(), python.as_deref())
    })
        .await
        .map_err(|e| CmdError(e.to_string()))??;
    Ok(res)
}

// ---- git -------------------------------------------------------------------

#[tauri::command]
async fn git_status(app: AppHandle, root: String) -> CmdResult<git::GitStatus> {
    let root = checked(&app.state::<AppState>(), &root)?;
    tauri::async_runtime::spawn_blocking(move || git::status(&root)).await.map_err(|e| CmdError(e.to_string()))
}

#[tauri::command]
async fn git_init(app: AppHandle, root: String) -> CmdResult<git::ProcResult> {
    let root = checked(&app.state::<AppState>(), &root)?;
    tauri::async_runtime::spawn_blocking(move || git::init(&root)).await.map_err(|e| CmdError(e.to_string()))
}

#[tauri::command]
async fn git_commit(app: AppHandle, root: String, message: String) -> CmdResult<git::ProcResult> {
    let root = checked(&app.state::<AppState>(), &root)?;
    tauri::async_runtime::spawn_blocking(move || git::commit(&root, &message)).await.map_err(|e| CmdError(e.to_string()))
}

#[tauri::command]
async fn git_set_identity(app: AppHandle, root: String, name: String, email: String) -> CmdResult<git::ProcResult> {
    let root = checked(&app.state::<AppState>(), &root)?;
    tauri::async_runtime::spawn_blocking(move || git::set_identity(&root, &name, &email))
        .await
        .map_err(|e| CmdError(e.to_string()))
}

#[tauri::command]
async fn git_show_head(app: AppHandle, root: String, rel: String) -> CmdResult<Option<String>> {
    let state = app.state::<AppState>();
    let root = checked(&state, &root)?;
    checked(&state, &root.join(&rel).to_string_lossy())?;
    tauri::async_runtime::spawn_blocking(move || git::show_head(&root, &rel)).await.map_err(|e| CmdError(e.to_string()))
}

#[tauri::command]
async fn git_push(app: AppHandle, req: String, root: String, remote_url: Option<String>) -> CmdResult<git::ProcResult> {
    let root = checked(&app.state::<AppState>(), &root)?;
    let mut steps: Vec<(String, Vec<String>)> = Vec::new();
    if let Some(url) = remote_url.filter(|u| !u.trim().is_empty()) {
        steps.push(("git".into(), vec!["remote".into(), "add".into(), "origin".into(), url]));
    }
    steps.push(("git".into(), vec!["push".into(), "-u".into(), "origin".into(), "HEAD".into()]));
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || git::run_steps(&app2, &req, &root, &steps))
        .await
        .map_err(|e| CmdError(e.to_string()))
}

/// Create a virtual environment in the project (fixed commands: venv, then optional pip install).
#[tauri::command]
async fn create_venv(
    app: AppHandle,
    req: String,
    root: String,
    name: String,
    base_python: String,
    install_kernel: bool,
) -> CmdResult<git::ProcResult> {
    let root = checked(&app.state::<AppState>(), &root)?;
    if !git::valid_venv_name(&name) {
        return Err(CmdError(format!("Invalid environment name: {name}")));
    }
    project::check_python(&base_python)?;
    let target = root.join(&name);
    let mut steps = vec![(base_python, vec!["-m".into(), "venv".into(), target.to_string_lossy().into_owned()])];
    if install_kernel {
        let py = if cfg!(windows) { target.join("Scripts/python.exe") } else { target.join("bin/python") };
        steps.push((
            py.to_string_lossy().into_owned(),
            vec!["-m".into(), "pip".into(), "install".into(), "jupyter_client".into(), "ipykernel".into()],
        ));
    }
    let app2 = app.clone();
    let root2 = root.clone();
    let res = tauri::async_runtime::spawn_blocking(move || git::run_steps(&app2, &req, &root2, &steps))
        .await
        .map_err(|e| CmdError(e.to_string()))?;
    if res.ok {
        // keep the environment out of git
        let gi = root.join(".gitignore");
        if gi.exists() || root.join(".git").exists() {
            let cur = std::fs::read_to_string(&gi).unwrap_or_default();
            let entry = format!("{name}/");
            let _ = std::fs::write(&gi, git::merge_gitignore(&cur, &[entry.as_str()]));
        }
    }
    Ok(res)
}

/// Move a project file to the system Trash (recoverable).
#[tauri::command]
fn delete_file(state: State<'_, AppState>, path: String) -> CmdResult<()> {
    let p = checked(&state, &path)?;
    if !p.is_file() {
        return Err(CmdError(format!("not a file: {path}")));
    }
    trash::delete(&p)?;
    Ok(())
}

/// Detect Python interpreters for the project (venvs, conda, pyenv, system) and probe them.
#[tauri::command]
async fn list_pythons(app: AppHandle, root: String, extra: Vec<String>) -> CmdResult<Vec<project::PythonEnv>> {
    let state = app.state::<AppState>();
    let root = checked(&state, &root)?;
    let list = tauri::async_runtime::spawn_blocking(move || project::list_pythons(&root, &extra))
        .await
        .map_err(|e| CmdError(e.to_string()))?;
    Ok(list)
}

#[tauri::command]
fn open_external(app: AppHandle, target: String) -> CmdResult<()> {
    if target.starts_with("http://") || target.starts_with("https://") || target.starts_with("mailto:") {
        app.opener().open_url(target, None::<&str>)?;
    } else {
        let state = app.state::<AppState>();
        let p = checked(&state, &target)?;
        app.opener().open_path(p.to_string_lossy(), None::<&str>)?;
    }
    Ok(())
}

pub fn run() {
    project::fix_path_env();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            open_project,
            read_file,
            write_file,
            path_exists,
            kernel_send,
            render,
            open_external,
            delete_file,
            list_pythons,
            git_status,
            git_init,
            git_commit,
            git_set_identity,
            git_show_head,
            git_push,
            create_venv
        ])
        .build(tauri::generate_context!())
        .expect("error while building Folio")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(mut k) = app.state::<AppState>().kernel.lock().unwrap().take() {
                    k.shutdown();
                }
            }
        });
}
