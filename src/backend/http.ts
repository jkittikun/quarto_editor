import type { Backend, KernelMsg, RenderResult, PythonEnv, RenderOptions, ProcResult } from "./types";
import type { GitStatus } from "../core/git";

/** Backend used when running in a normal browser against the Vite dev server (`npm run dev`). */
export class HttpBackend implements Backend {
  readonly kind = "http" as const;
  private fsCbs: ((p: string[]) => void)[] = [];
  private kernelCbs: ((m: KernelMsg) => void)[] = [];
  private renderCbs = new Map<string, (ev: any) => void>();

  constructor() {
    const es = new EventSource("/api/events");
    es.addEventListener("fs", (e) => {
      const paths = JSON.parse((e as MessageEvent).data);
      this.fsCbs.forEach((cb) => cb(paths));
    });
    es.addEventListener("kernel", (e) => {
      const msg = JSON.parse((e as MessageEvent).data);
      this.kernelCbs.forEach((cb) => cb(msg));
    });
    es.addEventListener("proc", (e) => {
      const ev = JSON.parse((e as MessageEvent).data);
      this.renderCbs.get(ev.req)?.(ev);
    });
    es.addEventListener("render", (e) => {
      const ev = JSON.parse((e as MessageEvent).data);
      this.renderCbs.get(ev.req)?.(ev);
    });
  }

  private async api(path: string, body?: unknown): Promise<any> {
    const res = await fetch(path, body === undefined ? undefined : {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await res.text());
    const ct = res.headers.get("content-type") ?? "";
    return ct.includes("json") ? res.json() : res.text();
  }

  async pickFolder() {
    return window.prompt("Path to a Quarto project folder:", localStorage.getItem("folio.lastRoot") ?? "");
  }
  async initialFolder() {
    const cfg = await this.api("/api/config");
    return cfg.root ?? null;
  }
  async openProject(root: string) {
    return (await this.api("/api/open", { root })).files as string[];
  }
  async readFile(path: string) {
    return (await this.api("/api/read", { path })).content as string;
  }
  async writeFile(path: string, content: string) {
    await this.api("/api/write", { path, content });
  }
  async deleteFile(path: string) {
    await this.api("/api/delete", { path });
  }
  async listPythons(root: string, extra: string[] = []) {
    return (await this.api("/api/pythons", { root, extra })).pythons as PythonEnv[];
  }
  async exists(path: string) {
    return (await this.api("/api/exists", { path })).exists as boolean;
  }
  fileUrl(path: string) {
    return "/folio-fs" + path.split("/").map(encodeURIComponent).join("/");
  }
  onFsChange(cb: (paths: string[]) => void) {
    this.fsCbs.push(cb);
  }
  async kernelExecute(req: string, doc: string, cwd: string, code: string, python?: string) {
    await this.api("/api/kernel", { op: "execute", req, doc, cwd, code, python });
  }
  async kernelControl(op: "interrupt" | "restart" | "shutdown", doc: string) {
    await this.api("/api/kernel", { op, doc, req: "ctl-" + Date.now() });
  }
  onKernelMsg(cb: (m: KernelMsg) => void) {
    this.kernelCbs.push(cb);
  }
  render(root: string, target: string | null, onLog: (line: string) => void, opts: RenderOptions = {}): Promise<RenderResult> {
    const req = "r" + Math.random().toString(36).slice(2);
    return new Promise((resolve, reject) => {
      this.renderCbs.set(req, (ev) => {
        if (ev.line !== undefined) onLog(ev.line);
        if (ev.done) {
          this.renderCbs.delete(req);
          resolve(ev.result);
        }
      });
      this.api("/api/render", { req, root, target, ...opts }).catch((e) => {
        this.renderCbs.delete(req);
        reject(e);
      });
    });
  }
  /** Long-running server process with streamed lines (venv creation, git push). */
  private proc(path: string, body: Record<string, unknown>, onLog: (line: string) => void): Promise<ProcResult> {
    const req = "p" + Math.random().toString(36).slice(2);
    return new Promise((resolve, reject) => {
      this.renderCbs.set(req, (ev) => {
        if (ev.line !== undefined) onLog(ev.line);
        if (ev.done) {
          this.renderCbs.delete(req);
          resolve(ev.result);
        }
      });
      this.api(path, { req, ...body }).catch((e) => {
        this.renderCbs.delete(req);
        reject(e);
      });
    });
  }
  createVenv(root: string, name: string, basePython: string, installKernel: boolean, onLog: (line: string) => void) {
    return this.proc("/api/venv", { root, name, basePython, installKernel }, onLog);
  }
  async gitStatus(root: string) {
    return (await this.api("/api/git/status", { root })) as GitStatus;
  }
  async gitInit(root: string) {
    return (await this.api("/api/git/init", { root })) as ProcResult;
  }
  async gitCommit(root: string, message: string) {
    return (await this.api("/api/git/commit", { root, message })) as ProcResult;
  }
  async gitSetIdentity(root: string, name: string, email: string) {
    return (await this.api("/api/git/identity", { root, name, email })) as ProcResult;
  }
  async gitShowHead(root: string, rel: string) {
    return ((await this.api("/api/git/show", { root, rel })) as { content: string | null }).content;
  }
  gitPush(root: string, remoteUrl: string | null, onLog: (line: string) => void) {
    return this.proc("/api/git/push", { root, remoteUrl }, onLog);
  }
  async openExternal(pathOrUrl: string) {
    window.open(pathOrUrl.startsWith("/") ? this.fileUrl(pathOrUrl) : pathOrUrl, "_blank");
  }
}
