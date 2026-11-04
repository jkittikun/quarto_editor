export type MimeBundle = Record<string, string>;

export type KernelOutput =
  | { type: "stream"; name: "stdout" | "stderr"; text: string }
  | { type: "display"; data: MimeBundle }
  | { type: "error"; ename: string; evalue: string; traceback: string[] };

export type KernelMsg =
  | ({ req: string } & KernelOutput)
  | { req: string; type: "clear" }
  | { req: string; type: "status"; state: string }
  | { req: string; type: "done"; ok: boolean; error?: string };

export interface RenderResult {
  ok: boolean;
  code: number | null;
  output: string | null; // absolute path to the rendered output, if known
}

export interface Backend {
  readonly kind: "tauri" | "http";
  /** Ask the user to choose a project folder. */
  pickFolder(): Promise<string | null>;
  /** Folder to open on startup (last used or configured). */
  initialFolder(): Promise<string | null>;
  /** Allow access to a project root and list its files (relative paths, '/' separated). */
  openProject(root: string): Promise<string[]>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** URL that the webview can load for a local file (images, rendered HTML). */
  fileUrl(path: string): string;
  /** Subscribe to file changes under the opened project (absolute paths). */
  onFsChange(cb: (paths: string[]) => void): void;

  kernelExecute(req: string, doc: string, cwd: string, code: string): Promise<void>;
  kernelControl(op: "interrupt" | "restart" | "shutdown", doc: string): Promise<void>;
  onKernelMsg(cb: (msg: KernelMsg) => void): void;

  render(root: string, target: string | null, onLog: (line: string) => void): Promise<RenderResult>;
  openExternal(pathOrUrl: string): Promise<void>;
}

export function joinPath(...parts: string[]): string {
  const joined = parts.filter(Boolean).join("/").replace(/\/+/g, "/");
  const segs: string[] = [];
  for (const s of joined.split("/")) {
    if (s === "..") segs.pop();
    else if (s !== ".") segs.push(s);
  }
  return segs.join("/") || "/";
}

export function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

export function relativeTo(root: string, p: string): string {
  return p.startsWith(root + "/") ? p.slice(root.length + 1) : p;
}
