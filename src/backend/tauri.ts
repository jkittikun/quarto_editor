import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { Backend, KernelMsg, RenderResult } from "./types";

/** Backend for the native desktop app: talks to the Rust side via Tauri commands/events. */
export class TauriBackend implements Backend {
  readonly kind = "tauri" as const;
  private renderLogs = new Map<string, (line: string) => void>();

  constructor() {
    listen<{ req: string; line: string }>("render-log", (e) => {
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
  exists(path: string) {
    return invoke<boolean>("path_exists", { path });
  }
  fileUrl(path: string) {
    return convertFileSrc(path);
  }
  onFsChange(cb: (paths: string[]) => void) {
    listen<string[]>("fs-change", (e) => cb(e.payload));
  }
  kernelExecute(req: string, doc: string, cwd: string, code: string) {
    return invoke<void>("kernel_send", { msg: { op: "execute", req, doc, cwd, code } });
  }
  kernelControl(op: "interrupt" | "restart" | "shutdown", doc: string) {
    return invoke<void>("kernel_send", { msg: { op, doc, req: "ctl-" + Date.now() } });
  }
  onKernelMsg(cb: (m: KernelMsg) => void) {
    listen<KernelMsg>("kernel-msg", (e) => cb(e.payload));
  }
  async render(root: string, target: string | null, onLog: (line: string) => void): Promise<RenderResult> {
    const req = "r" + Math.random().toString(36).slice(2);
    this.renderLogs.set(req, onLog);
    try {
      return await invoke<RenderResult>("render", { req, root, target });
    } finally {
      this.renderLogs.delete(req);
    }
  }
  openExternal(pathOrUrl: string) {
    return invoke<void>("open_external", { target: pathOrUrl });
  }
}
