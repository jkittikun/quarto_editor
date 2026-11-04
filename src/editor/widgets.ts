import { WidgetType, EditorView } from "@codemirror/view";
import katex from "katex";
import { renderInline, escapeHtml, type InlineContext } from "../core/inline";
import { formatCitation, formatReference } from "../core/bibtex";
import { isXrefLabel, type XrefTarget } from "../core/xref";
import type { CiteItem } from "../core/cite";
import { ctx, setTabEffect, type CellOutputs } from "./context";
import type { KernelOutput } from "../backend/types";

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

const mathCache = new Map<string, string>();
export function renderMath(tex: string, display: boolean): string {
  const key = (display ? "D" : "I") + tex;
  let html = mathCache.get(key);
  if (html === undefined) {
    try {
      html = katex.renderToString(tex, { displayMode: display, throwOnError: false, strict: "ignore", trust: false });
    } catch (e: any) {
      html = `<span class="cm-math-error">${escapeHtml(String(e.message ?? e))}</span>`;
    }
    if (mathCache.size > 2000) mathCache.clear();
    mathCache.set(key, html);
  }
  return html;
}

export function refText(key: string, opts: { narrative: boolean; suppressAuthor: boolean }): { text: string; target: XrefTarget | null; ok: boolean; kind: "xref" | "cite" } {
  if (isXrefLabel(key)) {
    const t = ctx.index.targets.get(key) ?? null;
    return { text: t ? t.display : `?@${key}`, target: t, ok: !!t, kind: "xref" };
  }
  const e = ctx.bib.get(key);
  if (!e) return { text: `${key}?`, target: null, ok: false, kind: "cite" };
  return { text: formatCitation([e], { narrative: opts.narrative, suppressAuthor: opts.suppressAuthor }).replace(/^\((.*)\)$/, opts.narrative ? "$1" : "($1)"), target: null, ok: true, kind: "cite" };
}

export function citeText(items: CiteItem[]): { text: string; ok: boolean } {
  // A bracketed group of only cross-refs renders as a list of refs
  if (items.every((i) => isXrefLabel(i.key))) {
    const parts = items.map((i) => [i.prefix, ctx.index.targets.get(i.key)?.display ?? `?@${i.key}`, i.locator].filter(Boolean).join(" "));
    return { text: parts.join("; "), ok: items.every((i) => ctx.index.targets.has(i.key)) };
  }
  const parts = items.map((i) => {
    const e = ctx.bib.get(i.key);
    const core = e ? (i.suppressAuthor ? e.year : formatCitation([e]).slice(1, -1)) : `${i.key}?`;
    return [i.prefix, core + (i.locator ? `, ${i.locator}` : "")].filter(Boolean).join(" ");
  });
  return { text: `(${parts.join("; ")})`, ok: items.every((i) => ctx.bib.has(i.key)) };
}

export const inlineCtx: InlineContext = {
  math: renderMath,
  ref: (key, opts) => {
    const r = refText(key, opts);
    return `<span class="cm-ref ${r.ok ? "" : "cm-ref-missing"}">${escapeHtml(r.text)}</span>`;
  },
  cite: (items) => {
    const r = citeText(items);
    return `<span class="cm-ref ${r.ok ? "" : "cm-ref-missing"}">${escapeHtml(r.text)}</span>`;
  },
};

export const md = (s: string) => renderInline(s, inlineCtx);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

/** Move the cursor into the source of a rendered block when it is clicked. */
function revealOnClick(dom: HTMLElement, view: EditorView, pos: () => number) {
  dom.addEventListener("mousedown", (e) => {
    if ((e.target as HTMLElement).closest("a, button, input, .cm-no-reveal")) return;
    e.preventDefault();
    view.dispatch({ selection: { anchor: pos() } });
    view.focus();
  });
}

// ---------------------------------------------------------------------------
// Widgets
// ---------------------------------------------------------------------------

export class MathWidget extends WidgetType {
  constructor(readonly tex: string, readonly display: boolean, readonly number: string | null, readonly pos: number) {
    super();
  }
  eq(o: MathWidget) {
    return o.tex === this.tex && o.display === this.display && o.number === this.number;
  }
  toDOM(view: EditorView) {
    const dom = el(this.display ? "div" : "span", this.display ? "cm-math-display" : "cm-math-inline", renderMath(this.tex, this.display));
    if (this.number) dom.appendChild(el("span", "cm-eq-number", `(${escapeHtml(this.number)})`));
    if (this.display) revealOnClick(dom, view, () => this.pos);
    return dom;
  }
  ignoreEvent() {
    return false;
  }
}

export class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly caption: string,
    readonly label: string | null,
    readonly width: string | null,
    readonly block: boolean,
    readonly pos: number,
  ) {
    super();
  }
  eq(o: ImageWidget) {
    return o.src === this.src && o.caption === this.caption && o.label === this.label && o.width === this.width && o.block === this.block;
  }
  toDOM(view: EditorView) {
    const fig = el(this.block ? "figure" : "span", this.block ? "cm-figure" : "cm-figure-inline");
    const img = el("img");
    img.src = this.src;
    img.alt = this.caption;
    img.draggable = false;
    if (this.width) img.style.width = /^\d+$/.test(this.width) ? `${this.width}px` : this.width;
    img.onerror = () => fig.classList.add("cm-figure-broken");
    fig.appendChild(img);
    if (this.block && (this.caption || this.label)) {
      const t = this.label ? ctx.index.targets.get(this.label) : null;
      const prefix = t ? `<span class="cm-cap-label">${escapeHtml(t.display)}:</span> ` : "";
      fig.appendChild(el("figcaption", "", prefix + md(this.caption)));
    }
    revealOnClick(fig, view, () => this.pos);
    return fig;
  }
  ignoreEvent() {
    return false;
  }
}

export class RefWidget extends WidgetType {
  constructor(readonly text: string, readonly ok: boolean, readonly kind: "xref" | "cite", readonly label: string, readonly title: string) {
    super();
  }
  eq(o: RefWidget) {
    return o.text === this.text && o.ok === this.ok && o.title === this.title;
  }
  toDOM() {
    const s = el("span", `cm-ref cm-ref-${this.kind}${this.ok ? "" : " cm-ref-missing"}`);
    s.textContent = this.text;
    s.title = this.title;
    s.dataset.ref = this.label;
    return s;
  }
  ignoreEvent() {
    return false;
  }
}

export class FrontMatterWidget extends WidgetType {
  constructor(readonly meta: Record<string, any>, readonly pos: number) {
    super();
  }
  eq(o: FrontMatterWidget) {
    return JSON.stringify(o.meta) === JSON.stringify(this.meta);
  }
  toDOM(view: EditorView) {
    const dom = el("div", "cm-frontmatter");
    const { title, subtitle, ...rest } = this.meta;
    if (title) dom.appendChild(el("div", "cm-fm-title", md(String(title))));
    if (subtitle) dom.appendChild(el("div", "cm-fm-subtitle", md(String(subtitle))));
    const keys = Object.keys(rest);
    const chips = el("div", "cm-fm-chips");
    for (const k of keys.slice(0, 8)) {
      const v = rest[k];
      const short = typeof v === "object" ? "…" : String(v);
      chips.appendChild(el("span", "cm-chip", `<b>${escapeHtml(k)}</b> ${escapeHtml(short.length > 30 ? short.slice(0, 30) + "…" : short)}`));
    }
    if (keys.length > 8) chips.appendChild(el("span", "cm-chip", `+${keys.length - 8}`));
    if (!title && !keys.length) chips.appendChild(el("span", "cm-chip", "front matter"));
    dom.appendChild(chips);
    revealOnClick(dom, view, () => this.pos + 4);
    return dom;
  }
  ignoreEvent() {
    return false;
  }
}

const CALLOUT_LABEL: Record<string, string> = { note: "Note", tip: "Tip", warning: "Warning", important: "Important", caution: "Caution" };
const CALLOUT_ICON: Record<string, string> = { note: "ℹ", tip: "💡", warning: "⚠", important: "❗", caution: "🔥" };

export class CalloutHeaderWidget extends WidgetType {
  constructor(readonly type: string, readonly title: string | null, readonly collapse: boolean) {
    super();
  }
  eq(o: CalloutHeaderWidget) {
    return o.type === this.type && o.title === this.title && o.collapse === this.collapse;
  }
  toDOM() {
    const d = el("span", `cm-callout-head`);
    d.appendChild(el("span", "cm-callout-icon", CALLOUT_ICON[this.type] ?? "ℹ"));
    d.appendChild(el("span", "cm-callout-titletext", this.title ? md(this.title) : CALLOUT_LABEL[this.type] ?? this.type));
    if (this.collapse) d.appendChild(el("span", "cm-callout-collapse", "collapsible"));
    return d;
  }
}

export class LabelWidget extends WidgetType {
  constructor(readonly html: string, readonly cls: string) {
    super();
  }
  eq(o: LabelWidget) {
    return o.html === this.html && o.cls === this.cls;
  }
  toDOM() {
    return el("span", this.cls, this.html);
  }
}

export class TabBarWidget extends WidgetType {
  constructor(readonly tabset: number, readonly titles: string[], readonly active: number) {
    super();
  }
  eq(o: TabBarWidget) {
    return o.tabset === this.tabset && o.active === this.active && o.titles.join("\0") === this.titles.join("\0");
  }
  toDOM(view: EditorView) {
    const bar = el("span", "cm-tabbar cm-no-reveal");
    this.titles.forEach((t, i) => {
      const b = el("button", `cm-tab${i === this.active ? " cm-tab-active" : ""}`, md(t));
      b.addEventListener("mousedown", (e) => {
        e.preventDefault();
        view.dispatch({ effects: setTabEffect.of({ tabset: this.tabset, tab: i }) });
      });
      bar.appendChild(b);
    });
    return bar;
  }
  ignoreEvent() {
    return true;
  }
}

export class CellHeaderWidget extends WidgetType {
  constructor(
    readonly lang: string,
    readonly label: string | null,
    readonly executable: boolean,
    readonly running: boolean,
    readonly fencePos: number,
  ) {
    super();
  }
  eq(o: CellHeaderWidget) {
    return o.lang === this.lang && o.label === this.label && o.executable === this.executable && o.running === this.running && o.fencePos === this.fencePos;
  }
  toDOM(view: EditorView) {
    const d = el("span", "cm-cell-head");
    d.appendChild(el("span", "cm-cell-lang", escapeHtml(this.lang || "code")));
    if (this.label) d.appendChild(el("span", "cm-cell-label", escapeHtml(this.label)));
    if (this.executable && this.lang === "python") {
      const b = el("button", "cm-cell-run cm-no-reveal", this.running ? "◼ Running…" : "▶ Run");
      b.title = "Run cell (⌘↵)";
      b.addEventListener("mousedown", (e) => {
        e.preventDefault();
        ctx.runCell(view, this.fencePos);
      });
      d.appendChild(b);
    }
    return d;
  }
  ignoreEvent() {
    return true;
  }
}

function stripAnsi(s: string) {
  return s.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}

function renderOutput(o: KernelOutput): HTMLElement {
  if (o.type === "stream") {
    const pre = el("pre", `cm-out-stream cm-out-${o.name}`);
    pre.textContent = stripAnsi(o.text);
    return pre;
  }
  if (o.type === "error") {
    const pre = el("pre", "cm-out-error");
    pre.textContent = stripAnsi(o.traceback.length ? o.traceback.join("\n") : `${o.ename}: ${o.evalue}`);
    return pre;
  }
  const d = o.data;
  if (d["image/png"] || d["image/jpeg"]) {
    const img = el("img", "cm-out-img");
    const mime = d["image/png"] ? "image/png" : "image/jpeg";
    img.src = `data:${mime};base64,${d[mime].replace(/\s/g, "")}`;
    img.onload = () => {
      // retina figures: show at half their pixel size
      img.style.width = `${Math.min(img.naturalWidth / 2, 720)}px`;
    };
    return img;
  }
  if (d["image/svg+xml"]) {
    const img = el("img", "cm-out-img");
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(d["image/svg+xml"]);
    return img;
  }
  if (d["text/html"]) {
    const div = el("div", "cm-out-html");
    div.innerHTML = d["text/html"].replace(/<script[\s\S]*?<\/script>/gi, "");
    return div;
  }
  if (d["text/markdown"]) return el("div", "cm-out-md", md(d["text/markdown"]));
  if (d["text/latex"]) return el("div", "cm-out-md", renderMath(d["text/latex"].replace(/^\$+|\$+$/g, ""), true));
  const pre = el("pre", "cm-out-stream");
  pre.textContent = d["text/plain"] ?? "";
  return pre;
}

export class CellOutputWidget extends WidgetType {
  constructor(readonly state: CellOutputs, readonly stale: boolean, readonly caption: string | null) {
    super();
  }
  eq(o: CellOutputWidget) {
    return o.state === this.state && o.stale === this.stale && o.caption === this.caption;
  }
  toDOM() {
    const d = el("div", `cm-cell-output${this.stale ? " cm-cell-stale" : ""}${this.state.running ? " cm-cell-running" : ""}`);
    if (this.state.running && !this.state.outputs.length) d.appendChild(el("div", "cm-out-busy", "Running…"));
    for (const o of this.state.outputs) d.appendChild(renderOutput(o));
    if (this.state.error) d.appendChild(el("pre", "cm-out-error", escapeHtml(this.state.error)));
    if (this.caption) d.appendChild(el("div", "cm-out-caption", this.caption));
    if (this.stale) d.title = "Code changed since this output was produced";
    return d;
  }
  get estimatedHeight() {
    return this.state.outputs.some((o) => o.type === "display") ? 300 : 40;
  }
}

let mermaidPromise: Promise<typeof import("mermaid")["default"]> | null = null;
const diagramCache = new Map<string, string>();
let diagramSeq = 0;
function isDark() {
  return document.documentElement.dataset.theme === "dark" ||
    (document.documentElement.dataset.theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
}

export class DiagramWidget extends WidgetType {
  constructor(readonly code: string, readonly pos: number) {
    super();
  }
  eq(o: DiagramWidget) {
    return o.code === this.code;
  }
  toDOM(view: EditorView) {
    const d = el("div", "cm-diagram");
    const key = (isDark() ? "d" : "l") + this.code;
    const cached = diagramCache.get(key);
    if (cached) d.innerHTML = cached;
    else {
      d.textContent = "Rendering diagram…";
      mermaidPromise ??= import("mermaid").then((m) => m.default);
      mermaidPromise
        .then(async (mermaid) => {
          mermaid.initialize({ startOnLoad: false, theme: isDark() ? "dark" : "default", securityLevel: "strict" });
          const body = this.code.replace(/^\s*%%\|.*$/gm, "");
          const { svg } = await mermaid.render(`folio-mmd-${++diagramSeq}`, body);
          diagramCache.set(key, svg);
          d.innerHTML = svg;
          view.requestMeasure();
        })
        .catch((e) => {
          d.innerHTML = `<pre class="cm-out-error">${escapeHtml(String(e?.message ?? e))}</pre>`;
        });
    }
    revealOnClick(d, view, () => this.pos);
    return d;
  }
  ignoreEvent() {
    return false;
  }
}

export class TableWidget extends WidgetType {
  constructor(readonly src: string, readonly caption: string | null, readonly label: string | null, readonly pos: number) {
    super();
  }
  eq(o: TableWidget) {
    return o.src === this.src && o.caption === this.caption && o.label === this.label &&
      (ctx.index.targets.get(this.label ?? "")?.display ?? null) === (ctx.index.targets.get(o.label ?? "")?.display ?? null);
  }
  toDOM(view: EditorView) {
    const wrap = el("div", "cm-table-wrap");
    const rows = this.src.split("\n").filter((l) => l.trim());
    const split = (l: string) => {
      let s = l.trim();
      if (s.startsWith("|")) s = s.slice(1);
      if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
      return s.split(/(?<!\\)\|/).map((c) => c.trim());
    };
    const aligns = rows.length > 1 ? split(rows[1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : "left")) : [];
    let html = "";
    if (this.caption) {
      const t = this.label ? ctx.index.targets.get(this.label) : null;
      html += `<caption>${t ? `<span class="cm-cap-label">${escapeHtml(t.display)}:</span> ` : ""}${md(this.caption)}</caption>`;
    }
    html += "<thead><tr>" + split(rows[0]).map((c, i) => `<th style="text-align:${aligns[i] ?? "left"}">${md(c)}</th>`).join("") + "</tr></thead><tbody>";
    for (const r of rows.slice(2)) html += "<tr>" + split(r).map((c, i) => `<td style="text-align:${aligns[i] ?? "left"}">${md(c)}</td>`).join("") + "</tr>";
    wrap.appendChild(el("table", "cm-table", html + "</tbody>"));
    revealOnClick(wrap, view, () => this.pos);
    return wrap;
  }
  ignoreEvent() {
    return false;
  }
}

export class BulletWidget extends WidgetType {
  constructor(readonly depth: number) {
    super();
  }
  eq(o: BulletWidget) {
    return o.depth === this.depth;
  }
  toDOM() {
    return el("span", "cm-bullet", ["•", "◦", "▪"][this.depth % 3]);
  }
}

export class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean, readonly pos: number) {
    super();
  }
  eq(o: CheckboxWidget) {
    return o.checked === this.checked && o.pos === this.pos;
  }
  toDOM(view: EditorView) {
    const box = el("input", "cm-task cm-no-reveal");
    box.type = "checkbox";
    box.checked = this.checked;
    box.addEventListener("mousedown", (e) => {
      e.preventDefault();
      view.dispatch({ changes: { from: this.pos + 1, to: this.pos + 2, insert: this.checked ? " " : "x" } });
    });
    return box;
  }
  ignoreEvent() {
    return true;
  }
}

export class HrWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    return el("span", "cm-hr");
  }
}

export class RefsWidget extends WidgetType {
  constructor(readonly keys: string) {
    super();
  }
  eq(o: RefsWidget) {
    return o.keys === this.keys;
  }
  toDOM() {
    const d = el("div", "cm-refs");
    const entries = [...ctx.bib.values()].sort((a, b) => (a.authors[0] ?? a.key).localeCompare(b.authors[0] ?? b.key));
    if (!entries.length) d.appendChild(el("div", "cm-muted", "No bibliography entries found."));
    for (const e of entries) d.appendChild(el("div", "cm-ref-entry", md(formatReference(e))));
    return d;
  }
}

/** Wraps a block widget so it keeps the styling of the container (e.g. callout) it sits in. */
export class WrapWidget extends WidgetType {
  constructor(readonly inner: WidgetType, readonly cls: string) {
    super();
  }
  eq(o: WrapWidget) {
    return o.cls === this.cls && o.inner.constructor === this.inner.constructor && this.inner.eq(o.inner as any);
  }
  toDOM(view: EditorView) {
    const d = el("div", "cm-wrap " + this.cls);
    d.appendChild(this.inner.toDOM(view));
    return d;
  }
  ignoreEvent(e: Event) {
    return this.inner.ignoreEvent(e);
  }
  get estimatedHeight() {
    return this.inner.estimatedHeight;
  }
}
