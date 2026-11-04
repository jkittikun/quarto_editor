import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { type Backend, type KernelMsg, joinPath, dirname, relativeTo } from "../backend/types";
import { parseQuartoYml, bookOrder, type ProjectInfo } from "../core/project";
import { buildIndex, scanTargets, type XrefTarget, type HeadingNumber } from "../core/xref";
import { parseBibtex } from "../core/bibtex";
import { escapeHtml } from "../core/inline";
import { editorExtensions } from "../editor/setup";
import { ctx, refreshEffect } from "../editor/context";
import {
  outputsField, setCellEffect, kernelMsgEffect, loadOutputsEffect, listCells, hashCode,
  serializeOutputs, matchCachedOutputs, type CachedCell,
} from "../editor/cells";
import { md } from "../editor/widgets";
import { QuickOpen } from "./quickOpen";
import { $, h, debounce } from "./dom";

const TEXT_EXT = /\.(qmd|md|markdown|Rmd|txt|yml|yaml|bib|py|R|css|scss|tex|json|lua)$/i;
const DOC_EXT = /\.(qmd|md|markdown|Rmd)$/i;

interface OpenDoc {
  path: string; // absolute
  state: EditorState;
  savedText: string;
  saving: Promise<void> | null;
  dirty: boolean;
}

export class App {
  root = "";
  files: string[] = [];
  info: ProjectInfo | null = null;
  docsText = new Map<string, string>(); // rel path -> text (book chapters + open docs)
  docs = new Map<string, OpenDoc>();
  current: OpenDoc | null = null;
  view: EditorView;
  reqToDoc = new Map<string, string>();
  kernelState = "idle";
  private quickOpen: QuickOpen;

  constructor(readonly backend: Backend) {
    this.view = new EditorView({ parent: $("#editor") });
    this.quickOpen = new QuickOpen((rel) => this.openFile(this.abs(rel)));
    this.wireContext();
    this.wireUi();
    backend.onFsChange((paths) => this.onFsChange(paths));
    backend.onKernelMsg((m) => this.onKernelMsg(m));
  }

  abs(rel: string) {
    return joinPath(this.root, rel);
  }
  rel(abs: string) {
    return relativeTo(this.root, abs);
  }

  // -------------------------------------------------------------------------
  // Project
  // -------------------------------------------------------------------------

  async openProject(root: string) {
    root = root.replace(/\/+$/, "");
    this.root = root;
    ctx.root = root;
    localStorage.setItem("folio.lastRoot", root);
    this.docs.clear();
    this.docsText.clear();
    this.current = null;
    this.files = await this.backend.openProject(root);
    await this.loadProjectConfig();
    $("#welcome").hidden = true;
    $("#app").hidden = false;
    const order = this.info ? bookOrder(this.info).map((c) => c.file) : [];
    const last = localStorage.getItem(`folio.lastFile:${root}`);
    const first =
      (last && this.files.includes(last) && last) ||
      order.find((f) => this.files.includes(f)) ||
      this.files.find((f) => /index\.qmd$/.test(f)) ||
      this.files.find((f) => DOC_EXT.test(f));
    if (first) await this.openFile(this.abs(first));
    else this.renderSidebar();
  }

  async loadProjectConfig() {
    const ymlName = this.files.find((f) => f === "_quarto.yml" || f === "_quarto.yaml");
    this.info = ymlName ? parseQuartoYml(await this.backend.readFile(this.abs(ymlName))) : null;
    document.title = this.info?.title ? `${this.info.title} — Folio` : "Folio";
    // Load all chapters so cross-references resolve across the whole book
    const chapterFiles = this.info ? bookOrder(this.info).map((c) => c.file) : this.files.filter((f) => DOC_EXT.test(f));
    await Promise.all(
      chapterFiles.filter((f) => this.files.includes(f)).map(async (f) => {
        if (!this.docs.has(this.abs(f))) this.docsText.set(f, await this.backend.readFile(this.abs(f)));
      }),
    );
    await this.loadBibliography();
    this.reindex();
  }

  async loadBibliography(extra: string[] = []) {
    const bibs = new Set<string>([...(this.info?.bibliography ?? []), ...extra]);
    ctx.bib = new Map();
    for (const b of bibs) {
      const p = b.startsWith("/") ? b : this.abs(b);
      try {
        if (!(await this.backend.exists(p))) continue;
        for (const e of parseBibtex(await this.backend.readFile(p))) ctx.bib.set(e.key, e);
      } catch {
        /* ignore unreadable bibliography */
      }
    }
  }

  reindex() {
    const book = this.info?.type === "book";
    const order = this.info && book ? bookOrder(this.info) : [...this.docsText.keys()].map((f) => ({ file: f, appendix: false, isPart: false }));
    const docs = order.filter((c) => this.docsText.has(c.file)).map((c) => ({ ...c, src: this.docsText.get(c.file)! }));
    // Open documents that are not part of the book still get their own labels indexed
    for (const [f, src] of this.docsText) if (!docs.some((d) => d.file === f)) docs.push({ file: f, src, appendix: false, isPart: false });
    ctx.index = buildIndex(docs, book);
    this.renderSidebar();
  }

  // -------------------------------------------------------------------------
  // Documents
  // -------------------------------------------------------------------------

  async openFile(path: string, reveal?: { line: number }) {
    if (this.current?.path === path) {
      if (reveal) this.revealLine(reveal.line);
      return;
    }
    if (this.current) {
      this.current.state = this.view.state;
      await this.flushSave(this.current);
    }
    let doc = this.docs.get(path);
    if (!doc) {
      const text = await this.backend.readFile(path);
      doc = { path, state: this.createState(text), savedText: text, saving: null, dirty: false };
      this.docs.set(path, doc);
      if (DOC_EXT.test(path)) this.docsText.set(this.rel(path), text);
      this.loadCachedOutputs(doc);
    }
    this.current = doc;
    ctx.file = path;
    localStorage.setItem(`folio.lastFile:${this.root}`, this.rel(path));
    this.view.setState(doc.state);
    this.reindex();
    this.view.dispatch({ effects: refreshEffect.of(null) });
    this.updateStatus();
    if (reveal) requestAnimationFrame(() => this.revealLine(reveal.line));
    else this.view.scrollDOM.scrollTop = 0;
  }

  createState(text: string) {
    return EditorState.create({
      doc: text,
      extensions: editorExtensions({
        onChange: () => this.onDocChange(),
        onSave: () => this.current && this.flushSave(this.current),
        extraKeys: [
          { key: "Mod-p", run: () => (this.quickOpen.show(this.files.filter((f) => TEXT_EXT.test(f))), true) },
          { key: "Mod-Shift-r", run: () => (this.render(false), true) },
        ],
      }),
    });
  }

  revealLine(line: number) {
    const l = this.view.state.doc.line(Math.min(Math.max(1, line + 1), this.view.state.doc.lines));
    this.view.dispatch({ effects: EditorView.scrollIntoView(l.from, { y: "start", yMargin: 80 }) });
    requestAnimationFrame(() => {
      const block = this.view.lineBlockAt(l.from);
      const flash = h("div", { class: "flash" });
      flash.style.top = `${block.top}px`;
      flash.style.height = `${Math.max(block.height, 24)}px`;
      this.view.contentDOM.parentElement!.appendChild(flash);
      setTimeout(() => flash.remove(), 1200);
    });
  }

  private saveSoon = debounce(() => this.current && this.flushSave(this.current), 600);
  private reindexSoon = debounce(() => {
    if (!this.current) return;
    this.reindex();
    this.view.dispatch({ effects: refreshEffect.of(null) });
  }, 350);

  onDocChange() {
    if (!this.current) return;
    this.current.dirty = true;
    this.current.state = this.view.state;
    if (DOC_EXT.test(this.current.path)) this.docsText.set(this.rel(this.current.path), this.view.state.doc.toString());
    this.setSaveStatus("Editing…");
    this.saveSoon();
    this.reindexSoon();
    this.updateStatusSoon();
  }

  async flushSave(doc: OpenDoc) {
    if (doc.saving) await doc.saving;
    const state = doc === this.current ? this.view.state : doc.state;
    const text = state.doc.toString();
    if (text === doc.savedText) {
      doc.dirty = false;
      if (doc === this.current) this.setSaveStatus("Saved");
      return;
    }
    doc.saving = this.backend.writeFile(doc.path, text).then(
      () => {
        doc.savedText = text;
        doc.dirty = doc === this.current ? this.view.state.doc.toString() !== text : false;
        if (doc === this.current) this.setSaveStatus(doc.dirty ? "Editing…" : "Saved");
      },
      (e) => this.setSaveStatus(`Save failed: ${e}`, true),
    );
    await doc.saving;
    doc.saving = null;
  }

  async onFsChange(paths: string[]) {
    let reloadConfig = false;
    let reloadList = false;
    for (const p of paths) {
      const rel = this.rel(p);
      if (rel.startsWith(".folio/")) continue;
      if (/^_quarto\.ya?ml$/.test(rel)) reloadConfig = true;
      if (/\.bib$/.test(rel)) reloadConfig = true;
      const exists = await this.backend.exists(p).catch(() => false);
      if (exists !== this.files.includes(rel)) reloadList = true;
      if (!exists || !TEXT_EXT.test(rel)) continue;
      const doc = this.docs.get(p);
      if (doc) {
        const text = await this.backend.readFile(p);
        if (text === doc.savedText) continue; // our own write
        const st = doc === this.current ? this.view.state : doc.state;
        if (doc.dirty && st.doc.toString() !== doc.savedText) {
          this.setSaveStatus(`${rel} changed on disk — keeping your edits`, true);
          continue;
        }
        doc.savedText = text;
        const tr = st.update({ changes: { from: 0, to: st.doc.length, insert: text } });
        if (doc === this.current) this.view.dispatch(tr);
        else doc.state = tr.state;
        doc.dirty = false;
        if (DOC_EXT.test(rel)) this.docsText.set(rel, text);
      } else if (this.docsText.has(rel)) {
        this.docsText.set(rel, await this.backend.readFile(p));
      }
    }
    if (reloadList) this.files = await this.backend.openProject(this.root);
    if (reloadConfig) await this.loadProjectConfig();
    else this.reindex();
    this.view.dispatch({ effects: refreshEffect.of(null) });
  }

  // -------------------------------------------------------------------------
  // Code execution
  // -------------------------------------------------------------------------

  runCell(view: EditorView, fencePos: number) {
    const doc = this.current;
    if (!doc || view !== this.view) return;
    const cell = listCells(view.state).find((c) => c.pos === fencePos);
    if (!cell || !cell.executable) return;
    if (cell.lang !== "python") {
      this.setSaveStatus(`Only Python cells can run live (this is ${cell.lang}); use Render for others.`, true);
      return;
    }
    const req = "k" + Math.random().toString(36).slice(2);
    this.reqToDoc.set(req, doc.path);
    view.dispatch({ effects: setCellEffect.of({ pos: cell.pos, value: { outputs: [], running: true, req, hash: hashCode(cell.code) } }) });
    this.setKernel("busy");
    this.backend.kernelExecute(req, doc.path, dirname(doc.path), cell.code).catch((e) => {
      this.onKernelMsg({ req, type: "done", ok: false, error: String(e) });
    });
  }

  runAll(uptoCursor = false) {
    const cells = listCells(this.view.state).filter((c) => c.executable && c.lang === "python");
    const head = this.view.state.selection.main.head;
    for (const c of cells) {
      if (uptoCursor && c.pos > head) break;
      this.runCell(this.view, c.pos);
    }
  }

  onKernelMsg(msg: KernelMsg) {
    if (msg.type === "done" && msg.req === "*") {
      this.setKernel("error", msg.error);
      return;
    }
    if (msg.type === "status" && msg.state === "restarted") {
      this.setKernel("idle");
      return;
    }
    const path = this.reqToDoc.get(msg.req);
    if (!path) return;
    const doc = this.docs.get(path);
    if (!doc) return;
    if (doc === this.current) this.view.dispatch({ effects: kernelMsgEffect.of(msg) });
    else doc.state = doc.state.update({ effects: kernelMsgEffect.of(msg) }).state;
    if (msg.type === "status") this.setKernel(msg.state === "starting" ? "starting" : "busy");
    if (msg.type === "done") {
      this.reqToDoc.delete(msg.req);
      if (![...this.reqToDoc.values()].length) this.setKernel(msg.ok || !msg.error ? "idle" : "error", msg.error);
      this.saveOutputs(doc);
    }
  }

  cachePath(doc: OpenDoc) {
    return joinPath(this.root, ".folio/cache", this.rel(doc.path) + ".json");
  }

  saveOutputs = debounce((doc: OpenDoc) => {
    const state = doc === this.current ? this.view.state : doc.state;
    const data = serializeOutputs(state);
    this.backend.writeFile(this.cachePath(doc), JSON.stringify({ version: 1, cells: data })).catch(() => {});
  }, 500);

  async loadCachedOutputs(doc: OpenDoc) {
    try {
      const p = this.cachePath(doc);
      if (!(await this.backend.exists(p))) return;
      const cached = JSON.parse(await this.backend.readFile(p)).cells as CachedCell[];
      const apply = (st: EditorState) => st.update({ effects: loadOutputsEffect.of(matchCachedOutputs(st, cached)) });
      if (doc === this.current) this.view.dispatch(apply(this.view.state));
      else doc.state = apply(doc.state).state;
    } catch {
      /* no cache */
    }
  }

  setKernel(state: string, error?: string) {
    this.kernelState = state;
    const el = $("#kernel-status");
    el.dataset.state = state;
    el.textContent = { idle: "Python ● idle", busy: "Python ● running", starting: "Python ● starting", error: "Python ● error" }[state] ?? state;
    el.title = error ?? "Jupyter kernel for this document";
    if (error) this.setSaveStatus(error, true);
  }

  // -------------------------------------------------------------------------
  // Rendering with quarto
  // -------------------------------------------------------------------------

  async render(whole: boolean) {
    if (!this.root) return;
    if (this.current) await this.flushSave(this.current);
    const log = $("#log");
    const panel = $("#log-panel");
    panel.hidden = false;
    log.textContent = "";
    const target = whole || !this.current ? null : this.current.path;
    $("#log-title").textContent = target ? `Rendering ${this.rel(target)}…` : "Rendering project…";
    const res = await this.backend.render(this.root, target, (line) => {
      log.textContent += line + "\n";
      log.scrollTop = log.scrollHeight;
    });
    $("#log-title").textContent = res.ok ? "Render complete" : `Render failed${res.code !== null ? ` (exit ${res.code})` : ""}`;
    if (res.ok) {
      let out = res.output;
      if (!out && this.info?.outputDir && target) {
        out = joinPath(this.root, this.info.outputDir, this.rel(target).replace(/\.\w+$/, ".html"));
      }
      if (out) await this.backend.openExternal(out);
    }
  }

  // -------------------------------------------------------------------------
  // UI
  // -------------------------------------------------------------------------

  wireContext() {
    ctx.fileUrl = (p) => this.backend.fileUrl(p);
    ctx.resolvePath = (rel) => (rel.startsWith("/") ? joinPath(this.root, rel) : joinPath(dirname(ctx.file), rel));
    ctx.runCell = (view, pos) => this.runCell(view, pos);
    ctx.openRef = (t: XrefTarget) => this.openFile(this.abs(t.file), { line: t.line });
    ctx.openLink = (url) => {
      if (/^[a-z]+:/i.test(url)) this.backend.openExternal(url);
      else {
        const [p, hash] = url.split("#");
        if (!p && hash) {
          const t = ctx.index.targets.get(hash);
          if (t) ctx.openRef(t);
          return;
        }
        const abs = ctx.resolvePath(p);
        if (DOC_EXT.test(abs)) this.openFile(abs);
        else this.backend.openExternal(abs);
      }
    };
  }

  wireUi() {
    const pick = async () => {
      const root = await this.backend.pickFolder();
      if (root) this.openProject(root).catch((e) => alert(`Could not open ${root}: ${e}`));
    };
    $("#open-folder").onclick = pick;
    $("#welcome-open").onclick = pick;
    $("#quick-open").onclick = () => this.quickOpen.show(this.files.filter((f) => TEXT_EXT.test(f)));
    $("#render-chapter").onclick = () => this.render(false);
    $("#render-book").onclick = () => this.render(true);
    $("#run-all").onclick = () => this.runAll();
    $("#kernel-restart").onclick = () => {
      if (this.current) this.backend.kernelControl("restart", this.current.path);
    };
    $("#kernel-interrupt").onclick = () => {
      if (this.current) this.backend.kernelControl("interrupt", this.current.path);
    };
    $("#log-close").onclick = () => ($("#log-panel").hidden = true);
    $("#toggle-sidebar").onclick = () => document.body.classList.toggle("no-sidebar");
    $("#toggle-theme").onclick = () => {
      const order = ["system", "light", "dark"];
      const cur = localStorage.getItem("folio.theme") ?? "system";
      const next = order[(order.indexOf(cur) + 1) % order.length];
      localStorage.setItem("folio.theme", next);
      applyTheme();
      this.view.dispatch({ effects: refreshEffect.of(null) });
    };
    $("#toggle-source").onclick = () => {
      document.body.classList.toggle("focus-mode");
    };
    document.addEventListener("keydown", (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "p" && !e.shiftKey) {
        e.preventDefault();
        this.quickOpen.show(this.files.filter((f) => TEXT_EXT.test(f)));
      } else if (mod && e.key.toLowerCase() === "o") {
        e.preventDefault();
        pick();
      } else if (mod && e.key === "\\") {
        e.preventDefault();
        document.body.classList.toggle("no-sidebar");
      }
    });
    window.addEventListener("beforeunload", () => {
      if (this.current) this.flushSave(this.current);
    });
    applyTheme();
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
  }

  setSaveStatus(text: string, warn = false) {
    const el = $("#save-status");
    el.textContent = text;
    el.classList.toggle("warn", warn);
  }

  private updateStatusSoon = debounce(() => this.updateStatus(), 400);
  updateStatus() {
    const text = this.view.state.doc.toString();
    const words = text
      .replace(/```[\s\S]*?```/g, "")
      .replace(/^---[\s\S]*?---/, "")
      .split(/\s+/)
      .filter((w) => /\w/.test(w)).length;
    $("#word-count").textContent = `${words.toLocaleString()} words`;
    const rel = this.current ? this.rel(this.current.path) : "";
    const ch = ctx.index.chapters.get(rel);
    $("#crumb").innerHTML = this.current
      ? `${this.info?.title ? `<span class="muted">${escapeHtml(this.info.title)} ›</span> ` : ""}${ch?.number ? `${escapeHtml(ch.number)}. ` : ""}${md(ch?.title ?? rel)}`
      : "";
    this.renderToc();
  }

  chapterLabel(file: string) {
    const ch = ctx.index.chapters.get(file);
    const title = ch?.title ?? file.replace(/\.\w+$/, "");
    return `${ch?.number ? `<span class="num">${escapeHtml(ch.number)}</span>` : ""}<span class="title">${md(title)}</span>`;
  }

  renderSidebar() {
    const nav = $("#outline");
    nav.innerHTML = "";
    $("#book-title").innerHTML = this.info?.title ? md(this.info.title) : escapeHtml(this.root.split("/").pop() ?? "");
    $("#book-author").textContent = this.info?.author ?? "";
    const currentRel = this.current ? this.rel(this.current.path) : "";
    const item = (file: string) => {
      const a = h("a", { class: "chapter" + (file === currentRel ? " active" : "") + (this.files.includes(file) ? "" : " missing"), href: "#", title: file });
      a.innerHTML = this.chapterLabel(file);
      a.onclick = (e) => {
        e.preventDefault();
        if (this.files.includes(file)) this.openFile(this.abs(file));
      };
      const li = h("li", {}, a);
      if (file === currentRel) li.appendChild(h("ul", { id: "toc", class: "toc" }));
      return li;
    };
    const used = new Set<string>();
    if (this.info && this.info.type === "book") {
      const ul = h("ul", { class: "chapters" });
      for (const it of this.info.outline) {
        if (it.kind === "chapter") {
          ul.appendChild(item(it.file));
          used.add(it.file);
        } else {
          const part = h("li", { class: "part" });
          const label = h("div", { class: "part-title" });
          label.innerHTML = md(it.file ? ctx.index.chapters.get(it.file)?.title ?? it.title : it.title);
          if (it.file) {
            used.add(it.file);
            label.classList.add("clickable");
            label.onclick = () => this.openFile(this.abs(it.file!));
          }
          part.appendChild(label);
          const sub = h("ul", {});
          for (const c of it.chapters) {
            sub.appendChild(item(c.file));
            used.add(c.file);
          }
          part.appendChild(sub);
          ul.appendChild(part);
        }
      }
      if (this.info.appendices.length) {
        ul.appendChild(h("li", { class: "part" }, h("div", { class: "part-title" }, "Appendices")));
        for (const a of this.info.appendices) {
          ul.appendChild(item(a.file));
          used.add(a.file);
        }
      }
      nav.appendChild(ul);
    }
    const others = this.files.filter((f) => DOC_EXT.test(f) && !used.has(f));
    if (others.length) {
      if (used.size) nav.appendChild(h("div", { class: "section-title" }, "Other files"));
      const ul = h("ul", { class: "files" });
      for (const f of others) {
        const li = item(f);
        const a = li.querySelector("a")!;
        a.innerHTML = `<span class="title">${escapeHtml(f)}</span>`;
        ul.appendChild(li);
      }
      nav.appendChild(ul);
    }
    this.renderToc();
  }

  renderToc() {
    const toc = document.getElementById("toc");
    if (!toc || !this.current) return;
    const text = this.view.state.doc.toString();
    const rel = this.rel(this.current.path);
    const headings: HeadingNumber[] = [];
    scanTargets(text, rel, ctx.index.chapters.get(rel)?.number ?? null, headings);
    const lines = text.split("\n");
    toc.innerHTML = "";
    for (const hd of headings) {
      if (hd.level < 2 || hd.level > 3) continue;
      const title = lines[hd.line].replace(/^#+\s+/, "").replace(/\s*\{[^}]*\}\s*$/, "");
      const a = h("a", { href: "#", class: `toc-l${hd.level}` });
      a.innerHTML = `${hd.number ? `<span class="num">${escapeHtml(hd.number)}</span>` : ""}${md(title)}`;
      a.onclick = (e) => {
        e.preventDefault();
        this.revealLine(hd.line);
      };
      toc.appendChild(h("li", {}, a));
    }
  }
}

export function applyTheme() {
  const pref = localStorage.getItem("folio.theme") ?? "system";
  const dark = pref === "dark" || (pref === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  const btn = document.getElementById("toggle-theme");
  if (btn) btn.title = `Theme: ${pref}`;
}

export { outputsField };
