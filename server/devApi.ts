/**
 * Vite plugin that gives the browser build of Folio a local filesystem / kernel / quarto API.
 * Mirrors the Tauri commands in src-tauri so the same frontend runs in both.
 * Only serves paths inside project folders that were explicitly opened.
 */
import type { Plugin } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import os from "node:os";
import { pythonCandidates, PROBE, parseProbe } from "../src/core/python";
import { createInterface } from "node:readline";
import fs from "node:fs";
import path from "node:path";

const IGNORE_DIRS = new Set([".git", "node_modules", ".quarto", "_book", "_site", "_freeze", ".venv", "venv", "__pycache__", ".folio", ".ipynb_checkpoints"]);
const MIME: Record<string, string> = {
  ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml",
  ".webp": "image/webp", ".pdf": "application/pdf", ".woff2": "font/woff2", ".woff": "font/woff",
};

export function listProjectFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") && e.name !== ".folio") continue;
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name) || e.name.endsWith("_files")) continue;
        walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name);
      } else out.push(rel ? `${rel}/${e.name}` : e.name);
    }
  };
  walk(root, "");
  return out.sort();
}

const isIgnoredDir = (name: string) => IGNORE_DIRS.has(name) || name.endsWith("_files") || (name.startsWith(".") && name !== ".folio");

/**
 * Watch a project folder for changes, one non-recursive watcher per directory.
 *
 * Node's `fs.watch(..., { recursive: true })` on Linux throws an uncaught ENOENT (crashing the
 * dev server) when a directory is created and deleted quickly — which is exactly what
 * `quarto render` does with its temporary folders. Watching directories individually lets us
 * skip build/temp folders entirely and treat every fs error as non-fatal.
 */
export function watchTree(root: string, onChange: (absPath: string) => void): { close(): void } {
  const watchers = new Map<string, fs.FSWatcher>();
  let closed = false;
  const unwatch = (dir: string) => {
    for (const [d, w] of watchers) {
      if (d === dir || d.startsWith(dir + path.sep)) {
        w.close();
        watchers.delete(d);
      }
    }
  };
  const watchDir = (dir: string) => {
    if (closed || watchers.has(dir)) return;
    let w: fs.FSWatcher;
    try {
      w = fs.watch(dir, (_ev, file) => {
        if (!file) return;
        const p = path.join(dir, String(file));
        let st: fs.Stats | null = null;
        try {
          st = fs.statSync(p);
        } catch {
          /* deleted */
        }
        if (st?.isDirectory()) {
          if (!isIgnoredDir(path.basename(p))) {
            watchDir(p);
            onChange(p);
          }
          return;
        }
        if (!st && watchers.has(p)) unwatch(p);
        onChange(p);
      });
    } catch {
      return; // vanished before we could watch it
    }
    w.on("error", () => unwatch(dir));
    watchers.set(dir, w);
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) if (e.isDirectory() && !isIgnoredDir(e.name)) watchDir(path.join(dir, e.name));
  };
  watchDir(root);
  return {
    close() {
      closed = true;
      for (const w of watchers.values()) w.close();
      watchers.clear();
    },
  };
}

/** Only allow interpreters that are `python3` on PATH or an existing file. */
function checkPython(p: string): string {
  if (p === "python3" || p === "python") return p;
  if (!path.isAbsolute(p) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) throw Object.assign(new Error(`Not a Python interpreter: ${p}`), { status: 400 });
  return p;
}

function probePython(p: string): Promise<{ version: string; ready: boolean } | null> {
  return new Promise((resolve) => {
    execFile(p, ["-c", PROBE], { timeout: 4000 }, (err, stdout) => resolve(err ? null : parseProbe(String(stdout))));
  });
}

export async function listPythons(root: string, extra: string[] = []) {
  const home = os.homedir();
  const list = (d: string) => {
    try {
      return fs.readdirSync(d);
    } catch {
      return [];
    }
  };
  let condaEnvs: string[] = [];
  try {
    condaEnvs = fs.readFileSync(path.join(home, ".conda", "environments.txt"), "utf8").split("\n");
  } catch {
    /* no conda */
  }
  const cands = pythonCandidates({ root, home, env: process.env, list, exists: (p) => fs.existsSync(p), condaEnvs });
  for (const e of extra) if (e && !cands.some((c) => c.path === e)) cands.push({ path: e, label: "custom", source: "custom" });
  // de-duplicate by real path (symlinked venvs and system pythons often coincide)
  const seen = new Set<string>();
  const unique = cands.filter((c) => {
    let real = c.path;
    try {
      real = fs.realpathSync(c.path);
    } catch {
      /* python3 on PATH */
    }
    if (seen.has(real)) return false;
    seen.add(real);
    return true;
  });
  const probed = await Promise.all(unique.map(async (c) => ({ ...c, probe: await probePython(c.path) })));
  return probed
    .filter((c) => c.probe || c.source === "custom")
    .map((c) => ({ path: c.path, label: c.label, source: c.source, version: c.probe?.version ?? null, ready: c.probe?.ready ?? false }));
}

export function findPython(root: string): string {
  if (process.env.FOLIO_PYTHON) return process.env.FOLIO_PYTHON;
  if (process.env.QUARTO_PYTHON) return process.env.QUARTO_PYTHON;
  for (const c of [".venv/bin/python", "venv/bin/python", "env/bin/python"]) {
    const p = path.join(root, c);
    if (fs.existsSync(p)) return p;
  }
  return "python3";
}

export function folioApi(opts: { defaultRoot?: string; kernelScript: string }): Plugin {
  const roots = new Set<string>();
  const clients = new Set<ServerResponse>();
  const watchers = new Map<string, { close(): void }>();
  let kernel: ChildProcess | null = null;
  let kernelRoot = "";

  const send = (event: string, data: unknown) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(payload);
  };
  const allowed = (p: string) => {
    const abs = path.resolve(p);
    for (const r of roots) if (abs === r || abs.startsWith(r + path.sep)) return abs;
    throw Object.assign(new Error(`Path outside opened projects: ${p}`), { status: 403 });
  };
  const body = (req: IncomingMessage) =>
    new Promise<any>((resolve, reject) => {
      let s = "";
      req.on("data", (c) => (s += c));
      req.on("end", () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
    });
  const json = (res: ServerResponse, v: unknown) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(v));
  };

  let kernelPython = "";
  const ensureKernel = (root: string, python?: string) => {
    const py = python || findPython(root);
    if (kernel && kernel.exitCode === null && kernelRoot === root && kernelPython === py) return kernel;
    kernel?.kill();
    kernelRoot = root;
    kernelPython = py;
    kernel = spawn(py, [opts.kernelScript], { stdio: ["pipe", "pipe", "pipe"] });
    createInterface({ input: kernel.stdout! }).on("line", (line) => {
      try { send("kernel", JSON.parse(line)); } catch { /* ignore */ }
    });
    kernel.stderr!.on("data", () => { /* kernel warnings */ });
    kernel.on("error", (e) => send("kernel", { req: "*", type: "done", ok: false, error: `Could not start ${py}: ${e.message}` }));
    return kernel;
  };

  const openProject = (root: string) => {
    const abs = path.resolve(root);
    if (!fs.statSync(abs).isDirectory()) throw new Error(`Not a folder: ${root}`);
    roots.add(abs);
    if (!watchers.has(abs)) {
      let pending = new Set<string>();
      let timer: NodeJS.Timeout | null = null;
      const notify = (p: string) => {
        pending.add(p);
        timer ??= setTimeout(() => {
          send("fs", [...pending]);
          pending = new Set();
          timer = null;
        }, 120);
      };
      watchers.set(abs, watchTree(abs, notify));
    }
    return listProjectFiles(abs);
  };

  return {
    name: "folio-api",
    configureServer(server) {
      if (opts.defaultRoot) roots.add(path.resolve(opts.defaultRoot));
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://x");
        try {
          if (url.pathname.startsWith("/folio-fs/")) {
            const p = allowed(decodeURIComponent(url.pathname.slice("/folio-fs".length)));
            if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.statusCode = 404; return res.end(); }
            res.setHeader("content-type", MIME[path.extname(p).toLowerCase()] ?? "application/octet-stream");
            return fs.createReadStream(p).pipe(res);
          }
          if (!url.pathname.startsWith("/api/")) return next();
          switch (url.pathname) {
            case "/api/config":
              return json(res, { root: opts.defaultRoot ? path.resolve(opts.defaultRoot) : null });
            case "/api/events":
              res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
              res.write(": hi\n\n");
              clients.add(res);
              req.on("close", () => clients.delete(res));
              return;
            case "/api/open": {
              const { root } = await body(req);
              return json(res, { files: openProject(root) });
            }
            case "/api/read": {
              const { path: p } = await body(req);
              return json(res, { content: fs.readFileSync(allowed(p), "utf8") });
            }
            case "/api/exists": {
              const { path: p } = await body(req);
              return json(res, { exists: fs.existsSync(allowed(p)) });
            }
            case "/api/write": {
              const { path: p, content } = await body(req);
              const abs = allowed(p);
              fs.mkdirSync(path.dirname(abs), { recursive: true });
              const tmp = `${abs}.folio-tmp`;
              fs.writeFileSync(tmp, content);
              fs.renameSync(tmp, abs);
              return json(res, { ok: true });
            }
            case "/api/kernel": {
              const msg = await body(req);
              const cwd = msg.cwd ? allowed(msg.cwd) : undefined;
              const root = [...roots].find((r) => (cwd ?? "").startsWith(r)) ?? kernelRoot;
              if (msg.op === "execute") ensureKernel(root, msg.python ? checkPython(msg.python) : undefined);
              if (kernel && kernel.exitCode === null) kernel.stdin!.write(JSON.stringify({ ...msg, cwd }) + "\n");
              return json(res, { ok: true });
            }
            case "/api/delete": {
              const { path: p } = await body(req);
              const abs = allowed(p);
              const root = [...roots].find((r) => abs.startsWith(r + path.sep))!;
              if (!fs.statSync(abs).isFile()) throw new Error("Only files can be deleted");
              // Recoverable: move into <root>/.folio/trash instead of unlinking.
              const trash = path.join(root, ".folio", "trash");
              fs.mkdirSync(trash, { recursive: true });
              fs.renameSync(abs, path.join(trash, `${Date.now()}-${path.basename(abs)}`));
              return json(res, { ok: true });
            }
            case "/api/pythons": {
              const { root, extra } = await body(req);
              return json(res, { pythons: await listPythons(allowed(root), Array.isArray(extra) ? extra.map(String) : []) });
            }
            case "/api/render": {
              const { req: id, root, target, to, python } = await body(req);
              const cwd = allowed(root);
              const args = ["render", ...(target ? [allowed(target)] : []), ...(to ? ["--to", String(to)] : [])];
              // stdin must be closed: quarto can block waiting on an open stdin pipe and never exit.
              const child = spawn(process.env.QUARTO_PATH ?? "quarto", args, {
                cwd,
                env: { ...process.env, QUARTO_PYTHON: python ? checkPython(python) : findPython(cwd) },
                stdio: ["ignore", "pipe", "pipe"],
              });
              let output: string | null = null;
              const onLine = (line: string) => {
                const m = /Output created:\s*(.+)$/.exec(line);
                if (m) output = path.resolve(cwd, m[1].trim());
                send("render", { req: id, line });
              };
              let open = 2;
              let streamsDone: () => void = () => {};
              const drained = new Promise<void>((r) => (streamsDone = r));
              for (const stream of [child.stdout, child.stderr]) {
                const rl = createInterface({ input: stream });
                rl.on("line", onLine);
                rl.on("close", () => --open === 0 && streamsDone());
              }
              let finished = false;
              const finish = (result: { ok: boolean; code: number | null; output: string | null }) => {
                if (finished) return;
                finished = true;
                send("render", { req: id, done: true, result });
              };
              child.on("error", (e) => {
                send("render", { req: id, line: `Could not run quarto: ${e.message}. Is Quarto installed and on PATH?` });
                finish({ ok: false, code: null, output: null });
              });
              // Finish when quarto *exits*, not when its pipes close: Quarto can leave a background
              // process (its Jupyter daemon) that inherits stdout/stderr and keeps them open.
              child.on("exit", async (code) => {
                await Promise.race([drained, new Promise((r) => setTimeout(r, 500))]);
                child.stdout.destroy();
                child.stderr.destroy();
                finish({ ok: code === 0, code, output });
              });
              return json(res, { ok: true });
            }
          }
          res.statusCode = 404;
          res.end("not found");
        } catch (e: any) {
          res.statusCode = e.status ?? 500;
          res.end(String(e.message ?? e));
        }
      });
    },
  };
}
