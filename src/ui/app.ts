import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { type Backend, type KernelMsg, joinPath, dirname, relativeTo } from "../backend/types";
import { parseQuartoYml, bookOrder, insertChapter, type ProjectInfo } from "../core/project";
import { projectTemplate, newDocument, type TemplateKind } from "../core/templates";
import { parseFreeze, freezePath } from "../core/freeze";
import { buildIndex, scanTargets, type XrefTarget, type HeadingNumber } from "../core/xref";
import { parseBibtex } from "../core/bibtex";
import { escapeHtml } from "../core/inline";
import { editorExtensions, fileKind, previewCompartment, previewExtensions } from "../editor/setup";
import { ctx, refreshEffect } from "../editor/context";
import {
  outputsField, setCellEffect, kernelMsgEffect, loadOutputsEffect, listCells, hashCode,
  serializeOutputs, matchCachedOutputs, type CachedCell,
} from "../editor/cells";
import { md } from "../editor/widgets";
import { QuickOpen } from "./quickOpen";
import { formModal, choiceModal } from "./modal";
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
    if (!this.files.some((f) => /^_quarto\.ya?ml$/.test(f) || DOC_EXT.test(f))) {
      await this.offerNewProject(root);
    }
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
    if (this.info?.error) this.setSaveStatus(`_quarto.yml: ${this.info.error}`, true);
    const isBook = this.info?.type === "book";
    $("#render-chapter").textContent = isBook ? "Render chapter" : "Render";
    $("#render-book").textContent = isBook ? "Render book" : "Render project";
    $("#render-book").hidden = !this.info;
    const fmt = this.info?.config.format;
    ctx.projectFormats = typeof fmt === "string" ? [fmt] : fmt && typeof fmt === "object" ? Object.keys(fmt) : [];
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
      doc = { path, state: this.createState(text, path), savedText: text, saving: null, dirty: false };
      this.docs.set(path, doc);
      if (DOC_EXT.test(path)) this.docsText.set(this.rel(path), text);
      this.loadCachedOutputs(doc);
    }
    this.current = doc;
    ctx.file = path;
    localStorage.setItem(`folio.lastFile:${this.root}`, this.rel(path));
    this.view.setState(doc.state);
    this.applyPreviewMode();
    document.body.classList.toggle("source-file", fileKind(path) !== "markdown");
    this.reindex();
    this.view.dispatch({ effects: refreshEffect.of(null) });
    this.updateStatus();
    if (reveal) requestAnimationFrame(() => this.revealLine(reveal.line));
    else this.view.scrollDOM.scrollTop = 0;
  }

  createState(text: string, path: string) {
    return EditorState.create({
      doc: text,
      extensions: editorExtensions({
        kind: fileKind(path),
        preview: this.previewOn(),
        onChange: () => this.onDocChange(),
        onSave: () => this.current && this.flushSave(this.current),
        extraKeys: [
          { key: "Mod-p", run: () => (this.quickOpen.show(this.files.filter((f) => TEXT_EXT.test(f))), true) },
          { key: "Mod-Shift-r", run: () => (this.render(false), true) },
          { key: "Mod-Shift-e", run: () => (this.togglePreview(), true) },
        ],
      }),
    });
  }

  // ---- view options -------------------------------------------------------

  previewOn() {
    return localStorage.getItem("folio.preview") !== "off";
  }

  togglePreview() {
    localStorage.setItem("folio.preview", this.previewOn() ? "off" : "on");
    this.applyPreviewMode();
  }

  /** Make the current editor match the live-preview / raw-source preference. */
  applyPreviewMode() {
    const on = this.previewOn();
    $("#toggle-source").classList.toggle("active", !on);
    $("#toggle-source").title = on ? "Show raw source (⌘⇧E)" : "Show live preview (⌘⇧E)";
    if (previewCompartment.get(this.view.state) !== undefined) {
      this.view.dispatch({ effects: previewCompartment.reconfigure(previewExtensions(on)) });
    }
  }

  fontSize() {
    const v = Number(localStorage.getItem("folio.fontSize"));
    return v >= 12 && v <= 26 ? v : 16;
  }

  setFontSize(px: number) {
    px = Math.min(26, Math.max(12, px));
    localStorage.setItem("folio.fontSize", String(px));
    document.documentElement.style.setProperty("--editor-font", `${px}px`);
    $("#font-size").textContent = `${px}`;
    this.view.requestMeasure();
  }

  // ---- creating files and projects ------------------------------------------

  async newFile() {
    if (!this.root) return;
    const book = this.info?.type === "book";
    const curRel = this.current && DOC_EXT.test(this.current.path) ? this.rel(this.current.path) : null;
    const after = curRel && this.info && bookOrder(this.info).some((c) => c.file === curRel) ? curRel : null;
    const fields = [
      { name: "title", label: "Title", placeholder: "New chapter" },
      { name: "file", label: "File name", placeholder: "new-chapter.qmd" },
    ];
    const res = await formModal(
      "New document",
      book ? [...fields, { name: "add", label: after ? `Add to book after ${after}` : "Add to book chapters", type: "checkbox" as const, value: true }] : fields,
    );
    if (!res) return;
    const title = String(res.title || "Untitled");
    let file = String(res.file || title.toLowerCase().replace(/[^\w]+/g, "-").replace(/^-|-$/g, "") || "untitled");
    if (!/\.(qmd|md)$/i.test(file)) file += ".qmd";
    const dir = curRel && curRel.includes("/") && !String(res.file).includes("/") ? curRel.slice(0, curRel.lastIndexOf("/") + 1) : "";
    const rel = (dir + file).replace(/^\/+/, "");
    if (await this.backend.exists(this.abs(rel))) {
      this.setSaveStatus(`${rel} already exists`, true);
      return this.openFile(this.abs(rel));
    }
    await this.backend.writeFile(this.abs(rel), newDocument(title));
    if (book && res.add) {
      const ymlName = this.files.find((f) => /^_quarto\.ya?ml$/.test(f))!;
      const yml = await this.backend.readFile(this.abs(ymlName));
      const updated = insertChapter(yml, after, rel);
      if (updated !== yml) await this.backend.writeFile(this.abs(ymlName), updated);
      else this.setSaveStatus("Couldn't find book.chapters in _quarto.yml — add the file yourself", true);
    }
    this.files = await this.backend.openProject(this.root);
    await this.loadProjectConfig();
    await this.openFile(this.abs(rel));
  }

  async offerNewProject(root: string) {
    const choice = await choiceModal(
      "This folder is empty",
      "Create a new Quarto project here?",
      [
        { id: "book", label: "Book", description: "Chapters, cross-references and a bibliography (_quarto.yml + chapters)" },
        { id: "presentation", label: "Presentation", description: "Reveal.js slides in slides.qmd" },
        { id: "document", label: "Single document", description: "One document.qmd rendered to HTML" },
        { id: "none", label: "Just open the folder" },
      ],
    );
    if (!choice || choice === "none") return;
    const name = root.split("/").pop() ?? "Untitled";
    const res = await formModal("Project details", [
      { name: "title", label: "Title", value: name.replace(/[-_]+/g, " ") },
      { name: "author", label: "Author", value: localStorage.getItem("folio.author") ?? "" },
    ]);
    if (!res) return;
    localStorage.setItem("folio.author", String(res.author));
    const files = projectTemplate(choice as TemplateKind, String(res.title || name), String(res.author || ""));
    for (const [rel, content] of Object.entries(files)) await this.backend.writeFile(joinPath(root, rel), content);
    this.files = await this.backend.openProject(root);
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

  runAll(above = false) {
    const cells = listCells(this.view.state).filter((c) => c.executable && c.lang === "python");
    const head = this.view.state.selection.main.head;
    // "above" = every cell that starts before the cell containing the cursor (or before the cursor)
    const containing = cells.find((c) => head >= c.pos && head <= c.closeLineEnd);
    const limit = containing ? containing.pos : head;
    let n = 0;
    for (const c of cells) {
      if (above && c.pos >= limit) break;
      this.runCell(this.view, c.pos);
      n++;
    }
    if (above && !n) this.setSaveStatus("No Python cells above the cursor");
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
    if (fileKind(doc.path) !== "markdown") return;
    try {
      const p = this.cachePath(doc);
      let cached: CachedCell[];
      let fromFreeze = false;
      if (await this.backend.exists(p)) cached = JSON.parse(await this.backend.readFile(p)).cells as CachedCell[];
      else {
        // Fall back to the outputs of the last `quarto render` (Quarto's freezer)
        const fz = freezePath(this.rel(doc.path));
        if (!(await this.backend.exists(this.abs(fz.json)))) return;
        const frozen = parseFreeze(await this.backend.readFile(this.abs(fz.json)), this.abs(fz.dir));
        const executable = listCells(doc.state).filter((c) => c.executable);
        const all = listCells(doc.state);
        // freeze cells are listed in executable-cell order; map to document cell indices
        cached = frozen
          .filter((f) => f.outputs.length && executable[f.index])
          .map((f) => ({ index: all.indexOf(executable[f.index]), hash: hashCode(executable[f.index].code), outputs: f.outputs }));
        fromFreeze = true;
      }
      const apply = (st: EditorState) => {
        const m = matchCachedOutputs(st, cached);
        if (fromFreeze) for (const [k, v] of m) m.set(k, { ...v, source: "freeze" });
        return st.update({ effects: loadOutputsEffect.of(m) });
      };
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
    ctx.runAbove = () => this.runAll(true);
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
    $("#run-above").onclick = () => this.runAll(true);
    $("#new-file").onclick = () => this.newFile();
    $("#edit-config").onclick = () => {
      const yml = this.files.find((f) => /^_quarto\.ya?ml$/.test(f));
      if (yml) this.openFile(this.abs(yml));
      else this.setSaveStatus("This folder has no _quarto.yml", true);
    };
    $("#font-dec").onclick = () => this.setFontSize(this.fontSize() - 1);
    $("#font-inc").onclick = () => this.setFontSize(this.fontSize() + 1);
    this.setFontSize(this.fontSize());
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
    $("#toggle-focus").onclick = () => {
      document.body.classList.toggle("focus-mode");
    };
    $("#toggle-source").onclick = () => this.togglePreview();
    document.addEventListener("keydown", (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "p" && !e.shiftKey) {
        e.preventDefault();
        this.quickOpen.show(this.files.filter((f) => TEXT_EXT.test(f)));
      } else if (mod && e.key.toLowerCase() === "o") {
        e.preventDefault();
        pick();
      } else if (mod && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        this.setFontSize(this.fontSize() + 1);
      } else if (mod && e.key === "-") {
        e.preventDefault();
        this.setFontSize(this.fontSize() - 1);
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
