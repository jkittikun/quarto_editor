import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { Backend, KernelMsg, RenderResult, PythonEnv, RenderOptions, ProcResult } from "./types";
import type { GitStatus } from "../core/git";

/** Backend for the native desktop app: talks to the Rust side via Tauri commands/events. */
export class TauriBackend implements Backend {
  readonly kind = "tauri" as const;
  private renderLogs = new Map<string, (line: string) => void>();

  constructor() {
    listen<{ req: string; line: string }>("render-log", (e) => {
      this.renderLogs.get(e.payload.req)?.(e.payload.line);
    });
    listen<{ req: string; line: string }>("proc-log", (e) => {
      this.renderLogs.get(e.payload.req)?.(e.payload.line);
    });
  }

  async pickFolder() {
    const res = await open({ directory: true, multiple: false, title: "Open Quarto project" });
    return typeof res === "string" ? res : null;
  }
  async initialFolder() {
    return localStorage.getItem("folio.lastRoot");
  }
  openProject(root: string) {
    return invoke<string[]>("open_project", { root });
  }
  readFile(path: string) {
    return invoke<string>("read_file", { path });
  }
  writeFile(path: string, content: string) {
    return invoke<void>("write_file", { path, content });
  }
  deleteFile(path: string) {
    return invoke<void>("delete_file", { path });
  }
  listPythons(root: string, extra: string[] = []) {
    return invoke<PythonEnv[]>("list_pythons", { root, extra });
  }
  exists(path: string) {
    return invoke<boolean>("path_exists", { path });
  }
  fileUrl(path: string) {
    return convertFileSrc(path);
  }
  onFsChange(cb: (paths: string[]) => void) {
    listen<string[]>("fs-change", (e) => cb(e.payload));
  }
  kernelExecute(req: string, doc: string, cwd: string, code: string, python?: string) {
    return invoke<void>("kernel_send", { msg: { op: "execute", req, doc, cwd, code, python } });
  }
  kernelControl(op: "interrupt" | "restart" | "shutdown", doc: string) {
    return invoke<void>("kernel_send", { msg: { op, doc, req: "ctl-" + Date.now() } });
  }
  onKernelMsg(cb: (m: KernelMsg) => void) {
    listen<KernelMsg>("kernel-msg", (e) => cb(e.payload));
  }
  async render(root: string, target: string | null, onLog: (line: string) => void, opts: RenderOptions = {}): Promise<RenderResult> {
    const req = "r" + Math.random().toString(36).slice(2);
    this.renderLogs.set(req, onLog);
    try {
      return await invoke<RenderResult>("render", { req, root, target, to: opts.to ?? null, python: opts.python ?? null });
    } finally {
      this.renderLogs.delete(req);
    }
  }
  private async proc<T>(cmd: string, args: Record<string, unknown>, onLog: (line: string) => void): Promise<T> {
    const req = "p" + Math.random().toString(36).slice(2);
    this.renderLogs.set(req, onLog);
    try {
      return await invoke<T>(cmd, { req, ...args });
    } finally {
      this.renderLogs.delete(req);
    }
  }
  createVenv(root: string, name: string, basePython: string, installKernel: boolean, onLog: (line: string) => void) {
    return this.proc<ProcResult>("create_venv", { root, name, basePython, installKernel }, onLog);
  }
  installPackages(root: string, python: string, onLog: (line: string) => void) {
    return this.proc<ProcResult>("install_packages", { root, python }, onLog);
  }
  gitStatus(root: string) {
    return invoke<GitStatus>("git_status", { root });
  }
  gitInit(root: string) {
    return invoke<ProcResult>("git_init", { root });
  }
  gitCommit(root: string, message: string) {
    return invoke<ProcResult>("git_commit", { root, message });
  }
  gitSetIdentity(root: string, name: string, email: string) {
    return invoke<ProcResult>("git_set_identity", { root, name, email });
  }
  gitShowHead(root: string, rel: string) {
    return invoke<string | null>("git_show_head", { root, rel });
  }
  gitPush(root: string, remoteUrl: string | null, onLog: (line: string) => void) {
    return this.proc<ProcResult>("git_push", { root, remoteUrl }, onLog);
  }
  gitStage(root: string, paths: string[] | "all") {
    return invoke<ProcResult>("git_stage", { root, paths: paths === "all" ? null : paths });
  }
  gitUnstage(root: string, paths: string[] | "all") {
    return invoke<ProcResult>("git_unstage", { root, paths: paths === "all" ? null : paths });
  }
  gitDiscard(root: string, tracked: string[], untracked: string[]) {
    return invoke<ProcResult>("git_discard", { root, tracked, untracked });
  }
  gitLog(root: string, limit: number) {
    return invoke<string>("git_log", { root, limit });
  }
  renameFile(from: string, to: string) {
    return invoke<void>("rename_file", { from, to });
  }
  openExternal(pathOrUrl: string) {
    return invoke<void>("open_external", { target: pathOrUrl });
  }
}
