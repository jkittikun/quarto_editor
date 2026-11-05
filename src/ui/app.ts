import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { type Backend, type KernelMsg, type PythonEnv, joinPath, dirname, relativeTo } from "../backend/types";
import { parseQuartoYml, bookOrder, insertChapter, removeChapter, isInBook, renameChapter, fileTree, isRevealDoc, type ProjectInfo, type TreeNode } from "../core/project";
import { projectTemplate, newDocument, type TemplateKind } from "../core/templates";
import { defaultPython, canInstallInto, KERNEL_PACKAGES } from "../core/python";
import { parseFreeze, freezePath, matchFrozen } from "../core/freeze";
import { buildIndex, scanTargets, type XrefTarget, type HeadingNumber } from "../core/xref";
import { parseBibtex } from "../core/bibtex";
import { escapeHtml } from "../core/inline";
import { editorExtensions, fileKind, previewCompartment, previewExtensions, readerCompartment, readerExtensions, lineNumbersCompartment, lineNumberExtensions } from "../editor/setup";
import { ctx, refreshEffect } from "../editor/context";
import {
  outputsField, setCellEffect, kernelMsgEffect, loadOutputsEffect, listCells, hashCode,
  serializeOutputs, matchCachedOutputs, type CachedCell,
} from "../editor/cells";
import { md } from "../editor/widgets";
import { QuickOpen } from "./quickOpen";
import { ScmPanel } from "./scm";
import { validVenvName } from "../core/git";
import { formModal, confirmModal, pickModal, choiceModal, type PickItem } from "./modal";
import { $, h, debounce } from "./dom";

const TEXT_EXT = /\.(qmd|md|markdown|Rmd|txt|yml|yaml|bib|py|R|css|scss|tex|json|lua)$/i;
const DOC_EXT = /\.(qmd|md|markdown|Rmd)$/i;

interface OpenDoc {
  path: string; // absolute
  state: EditorState;
  savedText: string;
  saving: Promise<void> | null;
  dirty: boolean;
  deleted?: boolean; // never write a deleted file back to disk
}

export type ViewMode = "edit" | "source" | "reader";

export class App {
  root = "";
  files: string[] = [];
  info: ProjectInfo | null = null;
  docsText = new Map<string, string>(); // rel path -> text (book chapters + open docs)
  docs = new Map<string, OpenDoc>();
  current: OpenDoc | null = null;
  view: EditorView;
  reqToDoc = new Map<string, string>();
  /** Files loaded only for {{< include >}} / previews (absolute path → text). */
  aux = new Map<string, string>();
  private auxLoading = new Set<string>();
  kernelState = "idle";
  private quickOpen: QuickOpen;
  scm!: ScmPanel;

  constructor(readonly backend: Backend) {
    this.view = new EditorView({ parent: $("#editor") });
    this.quickOpen = new QuickOpen((rel) => this.openFile(this.abs(rel)));
    this.wireContext();
    this.wireUi();
    this.scm = new ScmPanel(this);
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
    this.reqToDoc.clear();
    // Never show the previous folder's document while the new one loads.
    ctx.file = "";
    this.view.setState(EditorState.create({ doc: "" }));
    $("#crumb").innerHTML = "";
    $("#word-count").textContent = "";
    this.files = await this.backend.openProject(root);
    await this.loadProjectConfig();
    $("#welcome").hidden = true;
    $("#app").hidden = false;
    this.pythons = null;
    this.updatePythonLabel();
    this.refreshPythons(); // background detection of interpreters
    this.scm?.reset();
    if (!this.hasQuartoFiles()) {
      this.showEmptyProject();
      return;
    }
    this.hideStartPanel();
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
    $("#edit-config").hidden = !ymlName;
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
    const docs = order.filter((c) => this.docsText.has(c.file)).map((c) => ({ ...c, src: this.expandIncludes(this.docsText.get(c.file)!, c.file) }));
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
    this.selected = this.rel(path);
    this.hideStartPanel();
    localStorage.setItem(`folio.lastFile:${this.root}`, this.rel(path));
    this.view.setState(doc.state);
    this.applyViewMode();
    this.applyLineNumbers();
    this.updatePresentButton();
    if (this.scm?.open) {
      this.scm.render();
      this.scm.renderDiff();
    }
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
        preview: this.viewMode !== "source",
        reader: ctx.reader,
        lineNumbers: this.lineNumbersOn(),
        onChange: () => this.onDocChange(),
        onSave: () => this.current && this.flushSave(this.current),
        extraKeys: [
          { key: "Mod-p", run: () => (this.quickOpen.show(this.files.filter((f) => TEXT_EXT.test(f))), true) },
          { key: "Mod-Shift-r", run: () => (this.render(false), true) },
          { key: "Mod-Shift-e", run: () => (this.setViewMode(this.viewMode === "source" ? "edit" : "source"), true) },
          { key: "Mod-1", run: () => (this.setViewMode("edit"), true) },
          { key: "Mod-Shift-l", run: () => (this.toggleLineNumbers(), true) },
          { key: "Mod-Shift-g", run: () => (this.scm.toggle(), true) },
          { key: "Mod-2", run: () => (this.setViewMode("source"), true) },
          { key: "Mod-3", run: () => (this.setViewMode("reader"), true) },
        ],
      }),
    });
  }

  /** Load a file needed for an include or preview, then refresh the decorations. */
  loadAux(abs: string) {
    if (this.auxLoading.has(abs) || !abs.startsWith(this.root + "/")) return;
    this.auxLoading.add(abs);
    this.backend
      .readFile(abs)
      .then((text) => {
        this.aux.set(abs, text);
        this.reindex();
        this.view.dispatch({ effects: refreshEffect.of(null) });
      })
      .catch(() => this.aux.set(abs, `*Could not read ${this.rel(abs)}*`))
      .finally(() => this.auxLoading.delete(abs));
  }

  /** Inline {{< include >}} content (when loaded) so labels inside included files are indexed. */
  expandIncludes(src: string, relFile: string, depth = 0): string {
    if (depth > 3 || !src.includes("{{<")) return src;
    return src.replace(/^[ \t]*\{\{<\s*include\s+["']?([^"'\s>]+)["']?\s*>\}\}[ \t]*$/gm, (line, p: string) => {
      const abs = p.startsWith("/") ? joinPath(this.root, p) : joinPath(dirname(this.abs(relFile)), p);
      const text = this.docsText.get(this.rel(abs)) ?? this.aux.get(abs);
      if (text === undefined) {
        this.loadAux(abs);
        return line;
      }
      return this.expandIncludes(text, this.rel(abs), depth + 1);
    });
  }

  // ---- view mode: Edit / Source / Reader ------------------------------------

  viewMode: ViewMode = "edit";
  private lastNonReader: ViewMode = "edit";

  /** Read the saved mode, migrating the old independent toggles (folio.preview / folio.reader). */
  loadViewMode(): ViewMode {
    let m = localStorage.getItem("folio.viewMode") as ViewMode | null;
    if (m !== "edit" && m !== "source" && m !== "reader") {
      m = localStorage.getItem("folio.reader") === "on" ? "reader" : localStorage.getItem("folio.preview") === "off" ? "source" : "edit";
      localStorage.setItem("folio.viewMode", m);
    }
    localStorage.removeItem("folio.reader");
    localStorage.removeItem("folio.preview");
    return m;
  }

  setViewMode(mode: ViewMode) {
    if (mode === this.viewMode) return;
    if (mode === "reader" && this.viewMode !== "reader") this.lastNonReader = this.viewMode;
    this.viewMode = mode;
    localStorage.setItem("folio.viewMode", mode);
    this.applyViewMode();
  }

  toggleReader() {
    this.setViewMode(this.viewMode === "reader" ? this.lastNonReader : "reader");
  }

  /** Apply the mode to the open editor: both compartments are reconfigured together. */
  applyViewMode() {
    const mode = this.viewMode;
    ctx.reader = mode === "reader";
    document.body.classList.toggle("reader-mode", mode === "reader");
    document.body.classList.toggle("source-mode", mode === "source");
    for (const b of document.querySelectorAll<HTMLButtonElement>("#view-switch [data-mode]")) {
      const on = b.dataset.mode === mode;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", String(on));
    }
    const st = this.view.state;
    if (previewCompartment.get(st) === undefined) return; // non-Markdown file
    // keep the reading position across the switch
    const scroller = this.view.scrollDOM;
    const ratio = scroller.scrollHeight > scroller.clientHeight ? scroller.scrollTop / (scroller.scrollHeight - scroller.clientHeight) : 0;
    this.view.dispatch({
      effects: [
        previewCompartment.reconfigure(previewExtensions(mode !== "source")),
        readerCompartment.reconfigure(readerExtensions(mode === "reader")),
        refreshEffect.of(null),
      ],
    });
    if (mode === "reader") this.view.contentDOM.blur();
    requestAnimationFrame(() => {
      scroller.scrollTop = ratio * (scroller.scrollHeight - scroller.clientHeight);
    });
  }

  // ---- view options -------------------------------------------------------

  lineNumbersOn() {
    return localStorage.getItem("folio.lineNumbers") === "on";
  }

  toggleLineNumbers() {
    localStorage.setItem("folio.lineNumbers", this.lineNumbersOn() ? "off" : "on");
    this.applyLineNumbers();
  }

  applyLineNumbers() {
    const on = this.lineNumbersOn();
    $("#toggle-lines").setAttribute("aria-pressed", String(on));
    $("#toggle-lines").classList.toggle("active", on);
    if (lineNumbersCompartment.get(this.view.state) !== undefined) {
      this.view.dispatch({ effects: lineNumbersCompartment.reconfigure(lineNumberExtensions(on)) });
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

  /** Empty folder: offer project templates inline in the content area. */
  showStartPanel(root: string) {
    const panel = $("#start-panel");
    $("#editor").hidden = true;
    panel.hidden = false;
    panel.innerHTML = "";
    const name = root.split("/").pop() ?? "Untitled";
    const inner = h("div", { class: "start-inner" });
    inner.appendChild(h("h1", {}, "Start a new Quarto project"));
    inner.appendChild(h("p", { class: "start-sub" }, `“${name}” has no Quarto files yet. Choose what to create:`));
    const cards = h("div", { class: "start-cards" });
    const choices: { id: TemplateKind; title: string; text: string; icon: string }[] = [
      { id: "book", title: "Book", text: "Chapters, parts, cross-references and a bibliography.", icon: "📖" },
      { id: "presentation", title: "Presentation", text: "Reveal.js slides — each ## heading is a slide.", icon: "🖥" },
      { id: "document", title: "Single document", text: "One document.qmd rendered to HTML or PDF.", icon: "📄" },
    ];
    for (const c of choices) {
      const card = h("button", { class: "start-card", "data-choice": c.id });
      card.append(h("span", { class: "start-icon" }, c.icon), h("b", {}, c.title), h("span", {}, c.text));
      card.onclick = () => this.startProjectForm(root, c.id, c.title);
      cards.appendChild(card);
    }
    inner.appendChild(cards);
    const skip = h("button", { class: "start-skip" }, "Just open the folder");
    skip.onclick = () => this.hideStartPanel();
    inner.appendChild(skip);
    panel.appendChild(inner);
  }

  startProjectForm(root: string, kind: TemplateKind, title: string) {
    const panel = $("#start-panel");
    const name = root.split("/").pop() ?? "Untitled";
    panel.innerHTML = "";
    const form = h("form", { class: "start-inner start-form" });
    form.appendChild(h("h1", {}, `New ${title.toLowerCase()}`));
    const t = h("input", { name: "title", type: "text", spellcheck: "false" });
    t.value = name.replace(/[-_]+/g, " ");
    const a = h("input", { name: "author", type: "text", spellcheck: "false" });
    a.value = localStorage.getItem("folio.author") ?? "";
    form.append(
      h("label", { class: "modal-field" }, h("span", {}, "Title"), t),
      h("label", { class: "modal-field" }, h("span", {}, "Author"), a),
    );
    const back = h("button", { type: "button" }, "Back");
    back.onclick = () => this.showStartPanel(root);
    form.appendChild(h("div", { class: "modal-actions" }, back, h("button", { type: "submit", class: "primary" }, "Create")));
    form.onsubmit = async (e) => {
      e.preventDefault();
      localStorage.setItem("folio.author", a.value.trim());
      const files = projectTemplate(kind, t.value.trim() || name, a.value.trim());
      for (const [rel, content] of Object.entries(files)) await this.backend.writeFile(joinPath(root, rel), content);
      await this.openProject(root);
    };
    panel.appendChild(form);
    t.focus();
    t.select();
  }

  hideStartPanel() {
    $("#start-panel").hidden = true;
    $("#editor").hidden = false;
  }

  // ---- deleting files ---------------------------------------------------------

  async deleteFile(rel: string) {
    const inBook = isInBook(this.info, rel);
    const { ok, checked } = await confirmModal(
      `Delete ${rel.split("/").pop()}?`,
      this.backend.kind === "tauri"
        ? `“${rel}” will be moved to the Trash.`
        : `“${rel}” will be moved to .folio/trash in this project.`,
      { confirm: "Move to Trash", danger: true, checkbox: inBook ? { label: "Also remove it from the book (_quarto.yml)", value: true } : undefined },
    );
    if (!ok) return;
    const path = this.abs(rel);
    const open = this.docs.get(path);
    if (open) open.deleted = true; // no autosave may recreate it
    try {
      await this.backend.deleteFile(path);
    } catch (e) {
      if (open) open.deleted = false;
      this.setSaveStatus(`Could not delete ${rel}: ${e}`, true);
      return;
    }
    if (inBook && checked) {
      const ymlName = this.files.find((f) => /^_quarto\.ya?ml$/.test(f));
      if (ymlName) {
        const yml = await this.backend.readFile(this.abs(ymlName));
        const updated = removeChapter(yml, rel);
        if (updated !== yml) await this.backend.writeFile(this.abs(ymlName), updated);
      }
    }
    const doc = this.docs.get(path);
    if (doc) this.docs.delete(path);
    this.docsText.delete(rel);
    const cache = joinPath(this.root, ".folio/cache", rel + ".json");
    if (await this.backend.exists(cache).catch(() => false)) await this.backend.deleteFile(cache).catch(() => {});
    this.files = await this.backend.openProject(this.root);
    await this.loadProjectConfig();
    this.setSaveStatus(`Deleted ${rel}`);
    await this.afterFileGone(path);
  }

  /** Re-read files changed behind Folio's back (e.g. git discard) into open documents. */
  async reloadFromDisk(paths: string[]) {
    this.files = await this.backend.openProject(this.root);
    for (const p of paths) {
      const doc = this.docs.get(p);
      if (!doc) continue;
      if (!(await this.backend.exists(p))) {
        await this.afterFileGone(p);
        continue;
      }
      const text = await this.backend.readFile(p);
      doc.savedText = text;
      doc.dirty = false;
      const st = doc === this.current ? this.view.state : doc.state;
      if (st.doc.toString() === text) continue;
      const tr = st.update({ changes: { from: 0, to: st.doc.length, insert: text } });
      if (doc === this.current) this.view.dispatch(tr);
      else doc.state = tr.state;
      if (DOC_EXT.test(p)) this.docsText.set(this.rel(p), text);
    }
    this.renderSidebar();
  }

  hasQuartoFiles() {
    return this.files.some((f) => /^_quarto\.ya?ml$/.test(f) || DOC_EXT.test(f));
  }

  /** No document open: clear the editor; show the start page when the folder has no Quarto files. */
  showEmptyProject() {
    this.current = null;
    ctx.file = "";
    this.view.setState(EditorState.create({ doc: "" }));
    $("#crumb").innerHTML = "";
    $("#word-count").textContent = "";
    this.renderSidebar();
    if (!this.hasQuartoFiles()) this.showStartPanel(this.root);
  }

  /** A document was deleted (in Folio or on disk): forget it and move on to another file. */
  async afterFileGone(path: string) {
    const doc = this.docs.get(path);
    if (doc) doc.deleted = true;
    this.docs.delete(path);
    this.docsText.delete(this.rel(path));
    if (this.current?.path !== path) {
      if (!this.hasQuartoFiles()) this.showEmptyProject();
      return;
    }
    this.current = null;
    const order = this.info ? bookOrder(this.info).map((c) => c.file) : [];
    const next = order.find((f) => this.files.includes(f)) ?? this.files.find((f) => DOC_EXT.test(f));
    if (next) await this.openFile(this.abs(next));
    else this.showEmptyProject();
  }

  showFileMenu(rel: string, x: number, y: number) {
    document.querySelector(".ctx-menu")?.remove();
    const menu = h("div", { class: "ctx-menu", role: "menu" });
    const close = () => {
      menu.remove();
      document.removeEventListener("keydown", onKey, true);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    const item = (label: string, keys: string, fn: () => void, cls = "") => {
      const b = h("button", { class: `ctx-item ${cls}`, role: "menuitem", "data-item": label.replace(/…$/, "").toLowerCase() });
      b.append(h("span", {}, label), h("span", { class: "ctx-keys" }, keys));
      b.onclick = () => {
        close();
        fn();
      };
      menu.appendChild(b);
    };
    item("Duplicate", "⌘D", () => this.duplicateFile(rel));
    item("Rename…", "↩", () => this.startRename(rel));
    menu.appendChild(h("div", { class: "ctx-sep" }));
    item("Delete", "⌘⌫", () => this.deleteFile(rel), "danger-text");
    document.body.appendChild(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(x, window.innerWidth - r.width - 8)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - r.height - 8)}px`;
    document.addEventListener("keydown", onKey, true);
    setTimeout(() => document.addEventListener("mousedown", (e) => !menu.contains(e.target as Node) && close(), { once: true }));
  }


  // ---- Python interpreter ------------------------------------------------------

  pythons: PythonEnv[] | null = null;

  /** The interpreter chosen for this project (or null = auto-detect, like before). */
  selectedPython(): string | null {
    return localStorage.getItem(`folio.python:${this.root}`);
  }

  /** The interpreter that will actually be used: user choice, else the first detected. */
  effectivePython(): PythonEnv | null {
    return defaultPython(this.pythons ?? [], this.selectedPython()) as PythonEnv | null;
  }

  async refreshPythons() {
    const root = this.root;
    try {
      const sel = this.selectedPython();
      const list = await this.backend.listPythons(root, sel ? [sel] : []);
      if (root !== this.root) return;
      this.pythons = list;
    } catch {
      this.pythons = [];
    }
    this.updatePythonLabel();
  }

  updatePythonLabel() {
    const env = this.effectivePython();
    const label = $("#python-label");
    if (!this.pythons) label.textContent = "Python …";
    else if (!env) label.textContent = "No Python found";
    else label.textContent = `Python ${env.version ?? ""}${env.source === "project" || env.source === "conda" || env.source === "pyenv" ? ` (${env.label})` : ""}`.replace("  ", " ");
    const missing = env?.missing ?? [];
    $("#python-env").title = env
      ? `${env.path}${missing.length ? `\n⚠ missing: ${missing.join(", ")}${env.ready ? " (needed by Quarto to render Python cells)" : ""}` : ""}\nClick to choose another interpreter`
      : "Choose a Python interpreter";
    $("#python-env").classList.toggle("warn", !!env && env.version !== null && env.renderReady === false);
  }

  async pickPython(): Promise<void> {
    if (!this.pythons) await this.refreshPythons();
    const current = this.effectivePython()?.path;
    const groups: Record<string, string> = { project: "This project", env: "Configured", conda: "Conda", pyenv: "pyenv", system: "System", custom: "Custom" };
    const items: PickItem[] = (this.pythons ?? []).map((p) => ({
      id: p.path,
      label: `Python ${p.version ?? "?"}  ${p.label}`,
      detail: p.path,
      group: groups[p.source],
      badge: p.missing?.length ? `missing: ${p.missing.join(", ")}` : undefined,
      selected: p.path === current,
    }));
    const eff = this.effectivePython();
    if (eff && eff.version && eff.renderReady === false && canInstallInto(eff.source)) {
      items.unshift({ id: "__install", label: `＋ Install missing packages into ${eff.label}`, detail: eff.missing.join(", "), group: "This project" });
    }
    if (!(this.pythons ?? []).some((p) => p.source === "project")) {
      items.unshift({ id: "__venv", label: "＋ Create virtual environment (.venv)", detail: "python -m venv in this project", group: "This project" });
    }
    items.push({ id: "__path", label: "Enter interpreter path…", group: "More" }, { id: "__refresh", label: "Refresh list", group: "More" });
    const choice = await pickModal("Select Python interpreter", items, "Filter interpreters…");
    if (!choice) return;
    if (choice === "__refresh") {
      this.pythons = null;
      this.updatePythonLabel();
      await this.refreshPythons();
      return this.pickPython();
    }
    if (choice === "__venv") return this.createVenv();
    if (choice === "__install") {
      await this.installPackages();
      return;
    }
    let path = choice;
    if (choice === "__path") {
      const res = await formModal("Python interpreter", [{ name: "path", label: "Path to python", placeholder: "/path/to/venv/bin/python" }], "Use");
      if (!res || !res.path) return;
      path = String(res.path);
    }
    localStorage.setItem(`folio.python:${this.root}`, path);
    await this.refreshPythons();
    const env = this.effectivePython();
    if (env && !env.version) this.setSaveStatus(`Couldn't run ${path}`, true);
    else if (env && !env.ready) this.setSaveStatus(`Python selected. To run cells, install: ${path} -m pip install jupyter_client ipykernel`, true);
    else this.setSaveStatus(`Using ${env?.label} (${path})`);
  }

  /** pip-install the packages Folio and Quarto need into the selected environment. */
  async installPackages(): Promise<boolean> {
    const env = this.effectivePython();
    if (!env) return false;
    if (!canInstallInto(env.source)) {
      this.setSaveStatus(`Folio doesn't install into ${env.label} Python; create a project .venv instead`, true);
      return false;
    }
    $("#log-panel").hidden = false;
    $("#log-title").textContent = `Installing packages into ${env.label}…`;
    const log = $("#log");
    log.textContent = "";
    const r = await this.backend.installPackages(this.root, env.path, (line) => {
      log.textContent += line + "\n";
      log.scrollTop = log.scrollHeight;
    });
    $("#log-title").textContent = r.ok ? `Installed packages into ${env.label}` : "Installing packages failed";
    this.pythons = null;
    await this.refreshPythons();
    return r.ok;
  }

  /**
   * Quarto runs Python cells with the selected interpreter, which then needs pyyaml, nbformat and
   * nbclient. Offer to install them before a render that would fail. Returns false to cancel.
   */
  async ensureRenderPython(target: string | null): Promise<boolean> {
    if (!this.pythons) await this.refreshPythons();
    const env = this.effectivePython();
    if (!env || !env.version || env.renderReady !== false) return true;
    const texts = target ? [this.docsText.get(this.rel(target)) ?? this.view.state.doc.toString()] : [...this.docsText.values()];
    if (!texts.some((t) => /^\s*(`{3,}|~{3,})\s*\{python/m.test(t))) return true;
    const installable = canInstallInto(env.source);
    const choice = await choiceModal(
      "Python packages missing",
      `Quarto needs ${env.missing.join(", ")} in ${env.label} (${env.path}) to render Python cells.`,
      [
        ...(installable ? [{ id: "install", label: "Install now", description: `pip install ${KERNEL_PACKAGES.join(" ")}` }] : []),
        { id: "anyway", label: "Render anyway", description: installable ? "It will probably fail" : "Or pick a project .venv via the Python button in the bottom bar" },
        { id: "cancel", label: "Cancel" },
      ],
    );
    if (choice === "install") return this.installPackages();
    return choice === "anyway";
  }

  /** After a failed render: point at missing Python modules and offer to install them. */
  private renderFailureHint(logText: string) {
    if (!/ModuleNotFoundError: No module named/.test(logText)) return;
    const env = this.effectivePython();
    const log = $("#log");
    log.textContent += "\nHint: the selected Python is missing packages that Quarto needs.\n";
    if (env && canInstallInto(env.source)) {
      const btn = h("button", { class: "primary log-action" }, `Install missing packages into ${env.label}`);
      btn.onclick = () => this.installPackages();
      log.appendChild(btn);
    } else log.textContent += "Choose or create a project .venv with the Python button in the bottom bar.\n";
    log.scrollTop = log.scrollHeight;
  }

  /** Create a project virtual environment and select it. */
  async createVenv() {
    const bases = (this.pythons ?? []).filter((p) => p.source !== "project" && p.version);
    if (!bases.length) return this.setSaveStatus("No Python interpreter found to create the environment with", true);
    const def = defaultPython(bases, null)?.path ?? bases[0].path;
    const res = await formModal(
      "Create virtual environment",
      [
        { name: "name", label: "Folder name", value: ".venv" },
        { name: "base", label: "Base interpreter", type: "select", value: def, options: bases.map((p) => ({ value: p.path, label: `Python ${p.version} · ${p.label}` })) },
        { name: "kernel", label: `Install packages for running cells and Quarto rendering (${KERNEL_PACKAGES.join(", ")})`, type: "checkbox", value: true },
      ],
      "Create",
    );
    if (!res) return;
    const name = String(res.name || ".venv");
    if (!validVenvName(name)) return this.setSaveStatus(`“${name}” isn't a valid folder name`, true);
    $("#log-panel").hidden = false;
    $("#log-title").textContent = `Creating ${name}…`;
    const log = $("#log");
    log.textContent = "";
    const r = await this.backend.createVenv(this.root, name, String(res.base), !!res.kernel, (line) => {
      log.textContent += line + "\n";
      log.scrollTop = log.scrollHeight;
    });
    $("#log-title").textContent = r.ok ? `Created ${name}` : `Creating ${name} failed`;
    if (!r.ok) return;
    const py = joinPath(this.root, name, "bin/python");
    localStorage.setItem(`folio.python:${this.root}`, py);
    this.pythons = null;
    await this.refreshPythons();
    this.setSaveStatus(`Using ${name} (${this.effectivePython()?.version ?? "?"})`);
  }

  // ---- sidebar resizing --------------------------------------------------------

  wireResizer() {
    const handle = $("#sidebar-resizer");
    const sidebar = $("#sidebar");
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startW = sidebar.getBoundingClientRect().width;
      document.body.classList.add("resizing");
      const move = (ev: PointerEvent) => {
        sidebar.style.width = `${Math.min(520, Math.max(180, startW + ev.clientX - startX))}px`;
      };
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        document.body.classList.remove("resizing");
        this.view.requestMeasure();
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
    });
    handle.addEventListener("dblclick", () => {
      sidebar.style.width = "";
      this.view.requestMeasure();
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
    this.scm?.diffSoon();
    this.updatePresentSoon();
    this.updateStatusSoon();
  }

  async flushSave(doc: OpenDoc) {
    if (doc.saving) await doc.saving;
    if (doc.deleted) return;
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
        this.scm?.refreshSoon();
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
      if (this.aux.has(p)) {
        this.aux.set(p, await this.backend.readFile(p));
        continue;
      }
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
    this.scm?.refreshSoon();
    // documents deleted outside Folio (Finder, git checkout, …)
    for (const p of paths) {
      const doc = this.docs.get(p);
      if (doc && !doc.deleted && !this.files.includes(this.rel(p)) && !(await this.backend.exists(p).catch(() => true))) {
        await this.afterFileGone(p);
      }
    }
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
    this.backend.kernelExecute(req, doc.path, dirname(doc.path), cell.code, this.effectivePython()?.path).catch((e) => {
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
        const all = listCells(doc.state);
        const docCells = all.map((c, index) => ({ index, code: c.code, options: c.options, exec: c.executable })).filter((c) => c.exec);
        const match = matchFrozen(docCells, frozen);
        cached = frozen
          .filter((f) => f.outputs.length && match.has(f.index))
          .map((f) => {
            const i = match.get(f.index)!;
            return { index: i, hash: hashCode(all[i].code), outputs: f.outputs };
          });
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
    el.title = error ?? `Kernel ${state}`;
    if (error) this.setSaveStatus(error, true);
  }

  // -------------------------------------------------------------------------
  // Rendering with quarto
  // -------------------------------------------------------------------------

  /** Show ▶ Present only for Reveal.js documents. */
  updatePresentButton() {
    const show = !!this.current && fileKind(this.current.path) === "markdown" && isRevealDoc(this.view.state.doc.toString(), ctx.projectFormats);
    $("#present-btn").hidden = !show;
  }

  /** Render the slides with Quarto, then show the real Reveal.js output full-screen inside Folio. */
  async present() {
    if (!this.current || $("#present-btn").hidden) return;
    const file = this.current.path;
    await this.flushSave(this.current);
    if (!(await this.ensureRenderPython(file))) return;
    const log = $("#log");
    $("#log-panel").hidden = false;
    $("#log-title").textContent = `Preparing slides: ${this.rel(file)}…`;
    log.textContent = "";
    const res = await this.backend.render(this.root, file, (line) => {
      log.textContent += line + "\n";
      log.scrollTop = log.scrollHeight;
    }, { to: "revealjs", python: this.effectivePython()?.path });
    if (!res.ok) {
      $("#log-title").textContent = "Couldn't render the slides";
      this.renderFailureHint(log.textContent ?? "");
      return;
    }
    $("#log-title").textContent = "Slides ready";
    $("#log-panel").hidden = true;
    const out = res.output ?? file.replace(/\.[^./]+$/, ".html");
    const overlay = $("#present");
    const frame = $<HTMLIFrameElement>("#present-frame");
    frame.src = this.backend.fileUrl(out) + `?t=${Date.now()}`;
    overlay.hidden = false;
    frame.onload = () => frame.contentWindow?.focus();
    try {
      await overlay.requestFullscreen?.();
    } catch {
      /* full screen not available: the overlay still fills the window */
    }
  }

  closePresentation() {
    const overlay = $("#present");
    if (overlay.hidden) return;
    overlay.hidden = true;
    $<HTMLIFrameElement>("#present-frame").src = "about:blank";
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    this.view.focus();
  }

  async exportPdf() {
    if (!this.root) return;
    const book = this.info?.type === "book";
    if (!book && !this.current) return this.setSaveStatus("Open a document to export", true);
    return this.render(book, { to: "pdf" });
  }

  async render(whole: boolean, opts: { to?: string } = {}) {
    if (!this.root) return;
    if (this.current) await this.flushSave(this.current);
    if (!(await this.ensureRenderPython(whole || !this.current ? null : this.current.path))) return;
    const log = $("#log");
    const panel = $("#log-panel");
    panel.hidden = false;
    log.textContent = "";
    const target = whole || !this.current ? null : this.current.path;
    const what = opts.to === "pdf" ? "Exporting PDF" : "Rendering";
    $("#log-title").textContent = target ? `${what}: ${this.rel(target)}…` : `${what}: whole project…`;
    const res = await this.backend.render(
      this.root,
      target,
      (line) => {
        log.textContent += line + "\n";
        log.scrollTop = log.scrollHeight;
      },
      { to: opts.to, python: this.effectivePython()?.path },
    );
    const done = opts.to === "pdf" ? "PDF exported" : "Render complete";
    if (!res.ok) this.renderFailureHint(log.textContent ?? "");
    $("#log-title").textContent = res.ok ? done : `${what} failed${res.code !== null ? ` (exit ${res.code})` : ""}`;
    if (!res.ok && opts.to === "pdf" && /tex|tlmgr|xelatex|pdflatex|lualatex/i.test(log.textContent ?? "")) {
      log.textContent += "\nHint: PDF export needs a LaTeX installation. Install one with:  quarto install tinytex\n";
      log.scrollTop = log.scrollHeight;
    }
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
    ctx.openFile = (abs) => this.openFile(abs);
    ctx.toggleReader = () => this.toggleReader();
    ctx.sourceOf = (abs) => {
      const rel = this.rel(abs);
      if (this.docsText.has(rel)) return this.docsText.get(rel)!;
      if (this.aux.has(abs)) return this.aux.get(abs)!;
      this.loadAux(abs);
      return null;
    };
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
    $("#export-pdf").onclick = () => this.exportPdf();
    $("#toggle-lines").onclick = () => this.toggleLineNumbers();
    $("#outline").addEventListener("keydown", (e) => this.onSidebarKey(e));
    $("#present-btn").onclick = () => this.present();
    $("#present-close").onclick = () => this.closePresentation();
    document.addEventListener("fullscreenchange", () => {
      if (!document.fullscreenElement) this.closePresentation();
    });
    this.viewMode = this.loadViewMode();
    ctx.reader = this.viewMode === "reader";
    for (const b of document.querySelectorAll<HTMLButtonElement>("#view-switch [data-mode]")) {
      b.onclick = () => this.setViewMode(b.dataset.mode as ViewMode);
    }
    $("#python-env").onclick = () => this.pickPython();
    this.wireResizer();
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

    document.addEventListener("keydown", (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "p" && !e.shiftKey) {
        e.preventDefault();
        this.quickOpen.show(this.files.filter((f) => TEXT_EXT.test(f)));
      } else if (mod && e.key.toLowerCase() === "o") {
        e.preventDefault();
        pick();
      } else if (mod && !e.shiftKey && !e.altKey && ["1", "2", "3"].includes(e.key)) {
        e.preventDefault();
        this.setViewMode((["edit", "source", "reader"] as const)[+e.key - 1]);
      } else if (e.key === "Escape" && !$("#present").hidden) {
        e.preventDefault();
        this.closePresentation();
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        this.present();
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "g") {
        e.preventDefault();
        this.scm.toggle();
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "l") {
        e.preventDefault();
        this.toggleLineNumbers();
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

  private updatePresentSoon = debounce(() => this.updatePresentButton(), 500);
  private updateStatusSoon = debounce(() => this.updateStatus(), 400);
  updateStatus() {
    const text = this.view.state.doc.toString();
    const words = text
      .replace(/```[\s\S]*?```/g, "")
      .replace(/^---[\s\S]*?---/, "")
      .replace(/\\index\{[^{}]*(\{[^{}]*\}[^{}]*)*\}/g, "")
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

  /** Sidebar selection (Finder-like): the file keyboard actions apply to. */
  selected: string | null = null;
  /** Folders collapsed in the ALL FILES tree (kept for this session only). */
  private collapsedDirs = new Set<string>();

  private sidebarRendering = false;

  renderSidebar() {
    const nav = $("#outline");
    this.sidebarRendering = true;
    try {
      nav.innerHTML = "";
    } finally {
      this.sidebarRendering = false;
    }
    $("#book-title").innerHTML = this.info?.title ? md(this.info.title) : escapeHtml(this.root.split("/").pop() ?? "");
    $("#book-author").textContent = this.info?.author ?? "";
    const currentRel = this.current ? this.rel(this.current.path) : "";
    if (this.selected && !this.files.includes(this.selected)) this.selected = null;
    let tocPlaced = false;
    const item = (file: string, labelHtml?: string) => {
      const exists = this.files.includes(file);
      const cls = ["chapter", file === currentRel ? "active" : "", file === this.selected ? "selected" : "", exists ? "" : "missing"].filter(Boolean).join(" ");
      const a = h("a", { class: cls, href: "#", title: file, "data-file": file, draggable: "false" });
      a.innerHTML = labelHtml ?? this.chapterLabel(file);
      a.onclick = (e) => {
        e.preventDefault();
        if (!exists) return;
        this.select(file);
        nav.focus({ preventScroll: true });
        if (this.current?.path !== this.abs(file)) this.openFile(this.abs(file));
      };
      a.oncontextmenu = (e) => {
        e.preventDefault();
        if (!exists) return;
        this.select(file);
        nav.focus({ preventScroll: true });
        this.showFileMenu(file, e.clientX, e.clientY);
      };
      const li = h("li", { class: "file-row" }, a);
      if (file === currentRel && !tocPlaced) {
        li.appendChild(h("ul", { id: "toc", class: "toc" }));
        tocPlaced = true;
      }
      return li;
    };
    const isBook = !!this.info && this.info.type === "book";
    if (isBook) {
      const ul = h("ul", { class: "chapters" });
      for (const it of this.info!.outline) {
        if (it.kind === "chapter") ul.appendChild(item(it.file));
        else {
          const part = h("li", { class: "part" });
          const label = h("div", { class: "part-title" });
          label.innerHTML = md(it.file ? ctx.index.chapters.get(it.file)?.title ?? it.title : it.title);
          if (it.file) {
            label.classList.add("clickable");
            label.onclick = () => this.openFile(this.abs(it.file!));
          }
          part.appendChild(label);
          const sub = h("ul", {});
          for (const c of it.chapters) sub.appendChild(item(c.file));
          part.appendChild(sub);
          ul.appendChild(part);
        }
      }
      if (this.info!.appendices.length) {
        ul.appendChild(h("li", { class: "part" }, h("div", { class: "part-title" }, "Appendices")));
        for (const a of this.info!.appendices) ul.appendChild(item(a.file));
      }
      nav.appendChild(ul);
    }
    // ALL FILES: every .qmd / .md in the folder and its sub-folders, as a tree
    const docs = this.files.filter((f) => DOC_EXT.test(f));
    if (docs.length) {
      nav.appendChild(h("div", { class: "section-title" }, "All files"));
      const tree = fileTree(docs);
      const renderNode = (node: TreeNode): HTMLUListElement => {
        const ul = h("ul", { class: "files tree" });
        for (const d of node.dirs) {
          const containsCurrent = currentRel.startsWith(d.path + "/");
          const collapsed = this.collapsedDirs.has(d.path) && !containsCurrent;
          const li = h("li", { class: "dir-row" });
          const btn = h("button", { class: "dir", "data-dir": d.path, title: d.path }, `${collapsed ? "▸" : "▾"} ${d.name}`);
          btn.onclick = () => {
            if (this.collapsedDirs.has(d.path) || containsCurrent) this.collapsedDirs.delete(d.path);
            else this.collapsedDirs.add(d.path);
            if (containsCurrent && !collapsed) this.collapsedDirs.add(d.path);
            this.renderSidebar();
          };
          li.appendChild(btn);
          if (!collapsed) li.appendChild(renderNode(d));
          ul.appendChild(li);
        }
        for (const f of node.files) ul.appendChild(item(f, `<span class="title">${escapeHtml(f.split("/").pop()!)}</span>`));
        return ul;
      };
      nav.appendChild(renderNode(tree));
    }
    this.renderToc();
    if (this.renaming) this.mountRename();
  }

  select(file: string | null) {
    this.selected = file;
    for (const a of document.querySelectorAll<HTMLElement>("#outline a.chapter")) a.classList.toggle("selected", a.dataset.file === file);
  }

  /** Keyboard in the sidebar: ↑/↓ select and open, Enter renames, ⌘⌫ deletes, ⌘D duplicates. */
  onSidebarKey(e: KeyboardEvent) {
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    const mod = e.metaKey || e.ctrlKey;
    const order = [...new Set([...document.querySelectorAll<HTMLElement>("#outline a.chapter[data-file]:not(.missing)")].map((a) => a.dataset.file!))];
    const sel = this.selected ?? (this.current ? this.rel(this.current.path) : null);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!order.length) return;
      const i = sel ? order.indexOf(sel) : -1;
      const next = order[Math.max(0, Math.min(order.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
      this.select(next);
      document.querySelector(`#outline a.chapter[data-file="${CSS.escape(next)}"]`)?.scrollIntoView({ block: "nearest" });
      this.openFile(this.abs(next));
    } else if (e.key === "Enter" && sel) {
      e.preventDefault();
      this.startRename(sel);
    } else if (mod && e.key === "Backspace" && sel) {
      e.preventDefault();
      this.deleteFile(sel);
    } else if (mod && e.key.toLowerCase() === "d" && sel) {
      e.preventDefault();
      this.duplicateFile(sel);
    }
  }

  /** An inline rename in progress; survives sidebar re-renders (file watcher, reindex). */
  private renaming: { rel: string; value: string; selStart: number; selEnd: number } | null = null;

  /** Inline rename in the sidebar (Finder-style): Enter saves, Esc cancels. */
  startRename(rel: string) {
    const name = rel.split("/").pop()!;
    const dot = name.lastIndexOf(".");
    this.renaming = { rel, value: name, selStart: 0, selEnd: dot > 0 ? dot : name.length };
    this.mountRename();
  }

  private mountRename() {
    const r = this.renaming;
    if (!r) return;
    const rel = r.rel;
    const a = document.querySelector<HTMLElement>(`#outline a.chapter[data-file="${CSS.escape(rel)}"]`);
    if (!a) return;
    const name = rel.split("/").pop()!;
    const input = h("input", { class: "rename-input", type: "text", spellcheck: "false", value: r.value });
    a.replaceChildren(input);
    input.focus();
    input.setSelectionRange(r.selStart, r.selEnd);
    input.addEventListener("input", () => {
      r.value = input.value;
      r.selStart = input.selectionStart ?? 0;
      r.selEnd = input.selectionEnd ?? 0;
    });
    input.addEventListener("select", () => {
      r.selStart = input.selectionStart ?? 0;
      r.selEnd = input.selectionEnd ?? 0;
    });
    let done = false;
    const finish = async (commit: boolean) => {
      // a sidebar re-render removed this input: it is re-mounted, not finished
      // (browsers fire blur *before* removing a focused element, hence the flag)
      if (done || !input.isConnected || this.sidebarRendering) return;
      done = true;
      this.renaming = null;
      const value = input.value.trim();
      if (commit && value && value !== name) await this.renameFile(rel, value);
      else this.renderSidebar();
      $("#outline").focus({ preventScroll: true });
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("click", (e) => e.stopPropagation());
  }

  async renameFile(rel: string, newName: string) {
    if (/[\\/:]/.test(newName) || newName.startsWith(".")) {
      this.setSaveStatus(`“${newName}” isn't a valid file name`, true);
      return this.renderSidebar();
    }
    const ext = rel.slice(rel.lastIndexOf("."));
    if (!/\.(qmd|md|markdown|Rmd)$/i.test(newName)) newName += ext;
    const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/") + 1) : "";
    const newRel = dir + newName;
    const from = this.abs(rel);
    const to = this.abs(newRel);
    const doc = this.docs.get(from);
    if (doc) await this.flushSave(doc);
    try {
      await this.backend.renameFile(from, to);
    } catch (e) {
      this.setSaveStatus(`Could not rename: ${String(e).replace(/^Error:\s*/, "")}`, true);
      return this.renderSidebar();
    }
    // keep the book in sync
    if (isInBook(this.info, rel)) {
      const ymlName = this.files.find((f) => /^_quarto\.ya?ml$/.test(f));
      if (ymlName) {
        const yml = await this.backend.readFile(this.abs(ymlName));
        const updated = renameChapter(yml, rel, newRel);
        if (updated !== yml) await this.backend.writeFile(this.abs(ymlName), updated);
      }
    }
    // move in-memory state and the output cache
    if (doc) {
      this.docs.delete(from);
      doc.path = to;
      this.docs.set(to, doc);
    }
    if (this.docsText.has(rel)) {
      this.docsText.set(newRel, this.docsText.get(rel)!);
      this.docsText.delete(rel);
    }
    const cacheFrom = joinPath(this.root, ".folio/cache", rel + ".json");
    if (await this.backend.exists(cacheFrom).catch(() => false)) await this.backend.renameFile(cacheFrom, joinPath(this.root, ".folio/cache", newRel + ".json")).catch(() => {});
    if (this.current === doc && doc) {
      ctx.file = to;
      localStorage.setItem(`folio.lastFile:${this.root}`, newRel);
    }
    this.selected = newRel;
    this.files = await this.backend.openProject(this.root);
    await this.loadProjectConfig();
    this.updateStatus();
    this.setSaveStatus(`Renamed to ${newName}`);
  }

  async duplicateFile(rel: string) {
    const dot = rel.lastIndexOf(".");
    const base = rel.slice(0, dot);
    const ext = rel.slice(dot);
    let newRel = `${base} copy${ext}`;
    for (let n = 2; await this.backend.exists(this.abs(newRel)); n++) newRel = `${base} copy ${n}${ext}`;
    const open = this.docs.get(this.abs(rel));
    const text = open ? (open === this.current ? this.view.state.doc.toString() : open.state.doc.toString()) : await this.backend.readFile(this.abs(rel));
    await this.backend.writeFile(this.abs(newRel), text);
    if (isInBook(this.info, rel)) {
      const ymlName = this.files.find((f) => /^_quarto\.ya?ml$/.test(f));
      if (ymlName) {
        const yml = await this.backend.readFile(this.abs(ymlName));
        const updated = insertChapter(yml, rel, newRel);
        if (updated !== yml) await this.backend.writeFile(this.abs(ymlName), updated);
      }
    }
    this.files = await this.backend.openProject(this.root);
    await this.loadProjectConfig();
    await this.openFile(this.abs(newRel));
    this.select(newRel);
    this.renderSidebar();
    this.startRename(newRel);
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
