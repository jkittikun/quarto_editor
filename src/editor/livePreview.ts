/**
 * Obsidian-style live preview: Markdown/Quarto syntax is rendered in place and the raw
 * source is revealed only where the selection touches it. The document text is never changed.
 */
import { StateField, StateEffect, type EditorState, type Range, type Text } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { syntaxTree, ensureSyntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import { parseAttrs, type Attrs } from "../core/attrs";
import { splitFrontMatter } from "../core/project";
import { parseBracketCitation } from "../core/cite";
import { scanTargets, XREF_TYPES, type HeadingNumber } from "../core/xref";
import { escapeHtml, renderBlocks } from "../core/inline";
import { ctx, refreshEffect, setTabEffect, toggleCalloutEffect, activateEffect } from "./context";
import { outputsField, parseInfo, cellOptions, hashCode } from "./cells";
import {
  MathWidget, ImageWidget, RefWidget, FrontMatterWidget, CalloutHeaderWidget, LabelWidget, TabBarWidget,
  CellHeaderWidget, CellOutputWidget, DiagramWidget, TableWidget, BulletWidget, CheckboxWidget, HrWidget,
  RefsWidget, WrapWidget, ColumnsWidget, HiddenBlockWidget, refText, citeText, md, inlineCtx, renderMath,
} from "./widgets";

const hidden = Decoration.replace({});
const lineDeco = (cls: string) => Decoration.line({ class: cls });
const markDeco = (cls: string, attrs?: Record<string, string>) => Decoration.mark({ class: cls, attributes: attrs });

export const setFocusEffect = StateEffect.define<boolean>();
/**
 * 0 = blurred (everything rendered), 1 = focused but the cursor hasn't been placed yet,
 * 2 = editing (source revealed around the cursor). The pending state avoids revealing source
 * around a stale cursor when focus returns, which would shift the layout under the user's click.
 */
export const focusField = StateField.define<number>({
  create: () => 0,
  update: (v, tr) => {
    for (const e of tr.effects) {
      if (e.is(setFocusEffect)) v = e.value ? Math.max(v, 1) : 0;
      if (e.is(activateEffect)) v = 2;
    }
    if (v === 1 && (tr.docChanged || (tr.selection && tr.isUserEvent("select")) || tr.isUserEvent("input"))) v = 2;
    return v;
  },
});
export const focusTracking = EditorView.focusChangeEffect.of((_state, focusing) => setFocusEffect.of(focusing));

/** Active tab per tabset (by ordinal). */
export const tabsField = StateField.define<Map<number, number>>({
  create: () => new Map(),
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setTabEffect)) {
      v = new Map(v);
      v.set(e.value.tabset, e.value.tab);
    }
    return v;
  },
});

/** Collapsed state per callout (by ordinal); absent means "use the collapse attribute". */
export const collapsedField = StateField.define<Map<number, boolean>>({
  create: () => new Map(),
  update(v, tr) {
    for (const e of tr.effects) if (e.is(toggleCalloutEffect)) {
      v = new Map(v);
      v.set(e.value.callout, e.value.collapsed);
    }
    return v;
  },
});

const slideCache = new WeakMap<Text, boolean>();
/** True when the document is a Reveal.js presentation (front matter or project format). */
function isSlides(doc: Text): boolean {
  let v = slideCache.get(doc);
  if (v === undefined) {
    const head = doc.sliceString(0, Math.min(doc.length, 4000));
    const fm = head.startsWith("---") ? splitFrontMatter(head).meta : {};
    const fmt = fm.format;
    const names = typeof fmt === "string" ? [fmt] : fmt && typeof fmt === "object" ? Object.keys(fmt) : [];
    v = names.some((n) => n.startsWith("revealjs")) || (!names.length && ctx.projectFormats.some((n) => n.startsWith("revealjs")));
    slideCache.set(doc, v);
  }
  return v;
}

const headingCache = new WeakMap<Text, { chapter: string | null; headings: HeadingNumber[] }>();
function headingNumbers(doc: Text): Map<number, string> {
  const rel = ctx.file.startsWith(ctx.root + "/") ? ctx.file.slice(ctx.root.length + 1) : ctx.file;
  const chapter = ctx.index.chapters.get(rel)?.number ?? null;
  let c = headingCache.get(doc);
  if (!c || c.chapter !== chapter) {
    const headings: HeadingNumber[] = [];
    scanTargets(doc.toString(), rel, chapter, headings);
    c = { chapter, headings };
    headingCache.set(doc, c);
  }
  return new Map(c.headings.filter((h) => h.number).map((h) => [h.line, h.number]));
}

interface Div {
  openFrom: number;
  openTo: number;
  closeFrom: number | null;
  closeTo: number | null;
  attrs: Attrs;
  depth: number;
}

function resolveImage(url: string): string {
  if (/^(https?:|data:|blob:)/.test(url)) return url;
  return ctx.fileUrl(ctx.resolvePath(decodeURI(url)));
}

export function buildDecorations(state: EditorState): DecorationSet {
  const doc = state.doc;
  const tree = ensureSyntaxTree(state, doc.length, 80) ?? syntaxTree(state);
  const ranges: Range<Decoration>[] = [];
  const blocks: { from: number; to: number }[] = [];
  const blockRanges = new Set<Range<Decoration>>();
  // Reveal source only around the cursor while the editor has focus.
  const sel = state.field(focusField, false) === 2 ? state.selection.ranges : [];

  const touches = (from: number, to: number) => sel.some((r) => r.from <= to && r.to >= from);
  const linesTouch = (from: number, to: number) => touches(doc.lineAt(from).from, doc.lineAt(to).to);
  const inBlock = (from: number, to: number) => blocks.some((b) => from < b.to && to > b.from) || blocks.some((b) => from === to && from >= b.from && from <= b.to);
  /** Line classes contributed by enclosing divs, keyed by line number. */
  const divLineClass = new Map<number, string>();
  const addLine = (lineNo: number, cls: string) => {
    divLineClass.set(lineNo, ((divLineClass.get(lineNo) ?? "") + " " + cls).trim());
  };
  /** Container (div) classes for a line, for block widgets that replace it. */
  const containerClass = (lineNo: number) =>
    (divLineClass.get(lineNo) ?? "")
      .split(" ")
      .filter((c) => /^cm-(callout|xdiv|div$|tabset|depth-)/.test(c))
      .concat(divLineClass.get(lineNo)?.includes("cm-div-") ? ["cm-div-inner"] : [])
      .join(" ");
  const addBlock = (from: number, to: number, widget: WidgetType | null) => {
    if (inBlock(from, to)) return;
    blocks.push({ from, to });
    const cls = containerClass(doc.lineAt(from).number);
    const w = widget && cls ? new WrapWidget(widget, cls) : widget ?? new HiddenBlockWidget();
    const r = Decoration.replace({ widget: w, block: true }).range(from, to);
    blockRanges.add(r);
    ranges.push(r);
  };
  const hide = (from: number, to: number) => {
    if (to > from) ranges.push(hidden.range(from, to));
  };

  // ---- Pass 1: fenced divs (callouts, tabsets, theorems, #refs) --------------------------
  const fences: SyntaxNode[] = [];
  const codeBlocks: { from: number; to: number }[] = [];
  tree.iterate({
    enter(n) {
      if (n.name === "DivFence") fences.push(n.node);
      if (n.name === "FencedCode") {
        codeBlocks.push({ from: n.from, to: n.to });
        return false;
      }
    },
  });
  const divs: Div[] = [];
  const stack: Div[] = [];
  for (const f of fences) {
    const line = doc.lineAt(f.from);
    const m = /^\s*:{3,}\s*(.*?)\s*:*\s*$/.exec(line.text);
    const rest = m ? m[1] : "";
    if (rest) {
      const attrs = rest.startsWith("{") ? parseAttrs(rest) : { id: null, classes: [rest.split(/\s+/)[0]], kv: {} };
      const d: Div = { openFrom: line.from, openTo: line.to, closeFrom: null, closeTo: null, attrs, depth: stack.length };
      stack.push(d);
      divs.push(d);
    } else {
      const d = stack.pop();
      if (d) {
        d.closeFrom = line.from;
        d.closeTo = line.to;
      }
    }
  }

  let tabsetN = 0;
  let calloutN = 0;
  const tabs = state.field(tabsField, false) ?? new Map<number, number>();
  const collapsedMap = state.field(collapsedField, false) ?? new Map<number, boolean>();
  for (const d of divs) {
    const openLine = doc.lineAt(d.openFrom);
    const closeLine = d.closeFrom !== null ? doc.lineAt(d.closeFrom) : doc.line(doc.lines);
    const innerFirst = openLine.number + 1;
    const innerLast = d.closeFrom !== null ? closeLine.number - 1 : closeLine.number;
    const cls = d.attrs.classes;
    const callout = cls.map((c) => /^callout(?:-(\w+))?$/.exec(c)).find(Boolean);
    const isTabset = cls.includes("panel-tabset");
    const idType = d.attrs.id ? d.attrs.id.split("-")[0] : "";
    const isRefs = d.attrs.id === "refs";
    const isXref = !!d.attrs.id && idType in XREF_TYPES && idType !== "sec";
    const kind = callout ? `cm-callout cm-callout-${callout[1] ?? "note"}` : isXref ? `cm-xdiv cm-xdiv-${idType}` : isTabset ? "cm-tabset" : "cm-div";
    const openTouched = linesTouch(openLine.from, openLine.to);
    const closeTouched = d.closeFrom !== null && linesTouch(closeLine.from, closeLine.to);

    if (isRefs && !linesTouch(openLine.from, closeLine.to)) {
      addBlock(openLine.from, closeLine.to, new RefsWidget([...ctx.bib.keys()].join(",")));
      continue;
    }
    // Side-by-side columns: rendered read-only until the cursor enters the block.
    if (cls.includes("columns") && d.closeFrom !== null && !linesTouch(openLine.from, closeLine.to)) {
      const cols = divs
        .filter((c) => c.depth === d.depth + 1 && c.openFrom > d.openFrom && c.openFrom < d.closeFrom! && c.attrs.classes.includes("column") && c.closeFrom !== null)
        .map((c) => {
          const from = doc.lineAt(c.openFrom).number + 1;
          const to = doc.lineAt(c.closeFrom!).number - 1;
          const text = from <= to ? doc.sliceString(doc.line(from).from, doc.line(to).to) : "";
          const html = renderBlocks(text, { ...inlineCtx, math: renderMath, image: (src) => resolveImage(src) });
          return { width: c.attrs.kv.width ?? null, html };
        });
      if (cols.length) {
        addBlock(openLine.from, closeLine.to, new ColumnsWidget(cols, openLine.from));
        continue;
      }
    }

    addLine(openLine.number, `${kind} cm-div-open cm-depth-${d.depth}`);
    for (let ln = innerFirst; ln <= innerLast; ln++) addLine(ln, `${kind} cm-div-inner cm-depth-${d.depth}`);
    if (d.closeFrom !== null) addLine(closeLine.number, `${kind} cm-div-close cm-depth-${d.depth}`);

    const firstInner = innerFirst <= innerLast ? doc.line(innerFirst) : null;
    const firstIsHeading = !!firstInner && /^#{1,6}\s/.test(firstInner.text);

    const titleLine = firstIsHeading ? firstInner! : null;
    const titleText = titleLine ? titleLine.text.replace(/^#+\s+/, "").replace(/\s*\{[^{}]*\}\s*$/, "") : null;
    const headTouched = linesTouch(openLine.from, (titleLine ?? openLine).to);
    if (callout || isXref) {
      if (titleLine) addLine(titleLine.number, callout ? "cm-callout-title" : "cm-xdiv-title");
      let collapsible = false;
      let collapsed = false;
      let calloutIdx = -1;
      if (callout) {
        calloutIdx = calloutN++;
        collapsible = d.attrs.kv.collapse === "true" || d.attrs.kv.collapse === "false";
        collapsed = collapsible && (collapsedMap.get(calloutIdx) ?? d.attrs.kv.collapse === "true");
        const bodyFirst = titleLine ? titleLine.number + 1 : innerFirst;
        if (collapsed && bodyFirst <= innerLast) {
          const from = doc.line(bodyFirst).from;
          const to = doc.line(innerLast).to;
          if (touches(from, to)) collapsed = false;
          else addBlock(from, to, null);
        }
      }
      if (!headTouched) {
        let widget: WidgetType;
        if (callout) {
          widget = new CalloutHeaderWidget(callout[1] ?? "note", titleText ?? d.attrs.kv.title ?? null, collapsible, collapsed, calloutIdx);
        } else {
          const t = ctx.index.targets.get(d.attrs.id!);
          const label = t ? t.display : XREF_TYPES[idType];
          const name = titleText ?? d.attrs.kv.name ?? d.attrs.kv.title;
          widget = new LabelWidget(`<b>${escapeHtml(label)}</b>${name ? ` (${md(name)})` : ""}`, "cm-xdiv-label");
        }
        ranges.push(Decoration.replace({ widget }).range(openLine.from, openLine.to));
        if (titleLine) addBlock(titleLine.from, titleLine.to, null);
      }
    } else if (isTabset) {
      const idx = tabsetN++;
      // tabs are the headings at the shallowest level inside the tabset
      const heads: { line: number; level: number; title: string }[] = [];
      for (let ln = innerFirst; ln <= innerLast; ln++) {
        const l = doc.line(ln);
        if (codeBlocks.some((c) => l.from > c.from && l.from < c.to)) continue;
        const h = /^(#{1,6})\s+(.*?)\s*(\{[^}]*\})?\s*$/.exec(l.text);
        if (h) heads.push({ line: ln, level: h[1].length, title: h[2] });
      }
      const minLevel = Math.min(...heads.map((h) => h.level));
      const tabHeads = heads.filter((h) => h.level === minLevel);
      if (tabHeads.length) {
        const spans = tabHeads.map((h, i) => ({
          from: doc.line(h.line).from,
          to: doc.line((tabHeads[i + 1]?.line ?? innerLast + 1) - 1).to,
          head: h,
        }));
        let active = Math.min(tabs.get(idx) ?? 0, spans.length - 1);
        const touchedTab = spans.findIndex((s) => touches(s.from, s.to));
        if (touchedTab >= 0) active = touchedTab;
        if (!openTouched) {
          ranges.push(Decoration.replace({ widget: new TabBarWidget(idx, tabHeads.map((h) => h.title), active) }).range(openLine.from, openLine.to));
        }
        spans.forEach((s, i) => {
          if (i !== active) addBlock(s.from, s.to, null);
          else {
            const hl = doc.line(s.head.line);
            if (!touches(hl.from, hl.to) && s.to > hl.to) addBlock(hl.from, hl.to, null);
          }
        });
      }
    } else if (!openTouched) {
      const chips = [d.attrs.id ? `#${d.attrs.id}` : "", ...cls.map((c) => `.${c}`)].filter(Boolean).join(" ");
      ranges.push(Decoration.replace({ widget: new LabelWidget(escapeHtml(chips), "cm-div-label") }).range(openLine.from, openLine.to));
    }
    if (d.closeFrom !== null && !closeTouched) hide(closeLine.from, closeLine.to);
  }

  // ---- Pass 2: the syntax tree ------------------------------------------------------------
  const headingNums = headingNumbers(doc);
  const slides = isSlides(doc);
  let slideN = 0;
  const slideBreak = (lineFrom: number) => {
    slideN++;
    ranges.push(Decoration.line({ class: "cm-slide-break", attributes: { "data-slide": `Slide ${slideN}` } }).range(lineFrom));
  };
  const outputs = state.field(outputsField, false);
  const listDepth = (n: SyntaxNode) => {
    let d = 0;
    for (let p = n.parent; p; p = p.parent) if (p.name === "BulletList" || p.name === "OrderedList") d++;
    return d - 1;
  };

  tree.iterate({
    enter(n) {
      const node = n.node;
      if (inBlock(n.from, n.to) && n.name !== "Document") return false;
      switch (n.name) {
        case "FrontMatter": {
          if (!linesTouch(n.from, n.to)) {
            const fm = splitFrontMatter(doc.sliceString(0, Math.min(doc.length, n.to + 1)));
            addBlock(doc.lineAt(n.from).from, doc.lineAt(n.to).to, new FrontMatterWidget(fm.meta, n.from));
          } else {
            for (let ln = doc.lineAt(n.from).number; ln <= doc.lineAt(n.to).number; ln++) addLine(ln, "cm-fm-src");
          }
          return false;
        }
        case "ATXHeading1": case "ATXHeading2": case "ATXHeading3":
        case "ATXHeading4": case "ATXHeading5": case "ATXHeading6": {
          const level = +n.name.slice(-1);
          const line = doc.lineAt(n.from);
          addLine(line.number, `cm-h cm-h${level}`);
          if (slides && level <= 2) slideBreak(line.from);
          if (!touches(line.from, line.to)) {
            const mark = node.getChild("HeaderMark");
            if (mark) {
              hide(mark.from, Math.min(mark.to + 1, line.to));
              const num = headingNums.get(line.number - 1);
              if (num) ranges.push(Decoration.widget({ widget: new LabelWidget(escapeHtml(num), "cm-heading-num"), side: 1 }).range(Math.min(mark.to + 1, line.to)));
            }
            const attrs = /\s*\{[^{}]*\}\s*$/.exec(line.text);
            if (attrs) hide(line.from + attrs.index, line.to);
          }
          return;
        }
        case "SetextHeading1": case "SetextHeading2": {
          const level = +n.name.slice(-1);
          for (let ln = doc.lineAt(n.from).number; ln < doc.lineAt(n.to).number; ln++) addLine(ln, `cm-h cm-h${level}`);
          return;
        }
        case "Emphasis": case "StrongEmphasis": case "Strikethrough": case "InlineCode":
        case "Subscript": case "Superscript": {
          if (n.name === "InlineCode") ranges.push(markDeco("cm-inline-code").range(n.from, n.to));
          if (!touches(n.from, n.to)) {
            for (let c = node.firstChild; c; c = c.nextSibling) {
              if (/Mark$/.test(c.name)) hide(c.from, c.to);
            }
          }
          return;
        }
        case "Link": {
          const marks = node.getChildren("LinkMark");
          const url = node.getChild("URL");
          const after = doc.sliceString(n.to, Math.min(doc.length, n.to + 300));
          const attrM = /^\{[^{}\n]*\}/.exec(after);
          const end = attrM ? n.to + attrM[0].length : n.to;
          if (marks.length >= 2 && (url || attrM) && !touches(n.from, end)) {
            const textFrom = marks[0].to;
            const textTo = marks[1].from;
            hide(n.from, textFrom);
            hide(textTo, end);
            if (textTo > textFrom) {
              if (url) ranges.push(markDeco("cm-link", { "data-url": doc.sliceString(url.from, url.to) }).range(textFrom, textTo));
              else {
                const a = parseAttrs(attrM![0]);
                ranges.push(markDeco("cm-span " + a.classes.map((c) => "cm-span-" + c).join(" ")).range(textFrom, textTo));
              }
            }
          } else if (url) ranges.push(markDeco("cm-link-src").range(url.from, url.to));
          return;
        }
        case "Autolink": {
          const url = node.getChild("URL");
          if (url) ranges.push(markDeco("cm-link", { "data-url": doc.sliceString(url.from, url.to) }).range(url.from, url.to));
          if (!touches(n.from, n.to)) for (const m of node.getChildren("LinkMark")) hide(m.from, m.to);
          return false;
        }
        case "URL": {
          if (node.parent?.name === "Paragraph" || node.parent?.name === "TableCell") {
            ranges.push(markDeco("cm-link", { "data-url": doc.sliceString(n.from, n.to) }).range(n.from, n.to));
          }
          return;
        }
        case "Image": {
          const marks = node.getChildren("LinkMark");
          const url = node.getChild("URL");
          if (!url || marks.length < 2) return false;
          const after = doc.sliceString(n.to, Math.min(doc.length, n.to + 300));
          const attrM = /^\{[^{}\n]*\}/.exec(after);
          const end = attrM ? n.to + attrM[0].length : n.to;
          const line = doc.lineAt(n.from);
          if (touches(line.from, line.to)) return false;
          const attrs = attrM ? parseAttrs(attrM[0]) : null;
          const alt = doc.sliceString(marks[0].to, marks[1].from);
          const isBlock = line.text.trim() === doc.sliceString(n.from, end).trim() && node.parent?.name === "Paragraph" &&
            doc.lineAt(node.parent.from).number === doc.lineAt(node.parent.to).number;
          const w = new ImageWidget(resolveImage(doc.sliceString(url.from, url.to)), alt, attrs?.id ?? null, attrs?.kv.width ?? null, isBlock, n.from);
          if (isBlock) addBlock(line.from, line.to, w);
          else ranges.push(Decoration.replace({ widget: w }).range(n.from, end));
          return false;
        }
        case "InlineMath": {
          const marks = node.getChildren("InlineMathMark");
          if (marks.length < 2) return false;
          if (!touches(n.from, n.to)) {
            const display = marks[0].to - marks[0].from === 2;
            const tex = doc.sliceString(marks[0].to, marks[1].from);
            ranges.push(Decoration.replace({ widget: new MathWidget(tex, display, null, n.from) }).range(n.from, n.to));
          } else ranges.push(markDeco("cm-math-src").range(n.from, n.to));
          return false;
        }
        case "DisplayMath": {
          const marks = node.getChildren("DisplayMathMark");
          const first = doc.lineAt(n.from);
          const last = doc.lineAt(n.to);
          if (!linesTouch(n.from, n.to) && marks.length >= 2) {
            const tex = doc.sliceString(marks[0].to, marks[marks.length - 1].from);
            const tail = doc.sliceString(marks[marks.length - 1].to, last.to);
            const am = /\{([^{}]*)\}/.exec(tail);
            const id = am ? parseAttrs(am[1]).id : null;
            const number = id ? ctx.index.targets.get(id)?.number ?? "?" : null;
            addBlock(first.from, last.to, new MathWidget(tex.trim(), true, number, n.from));
          } else {
            for (let ln = first.number; ln <= last.number; ln++) addLine(ln, "cm-math-src-line");
          }
          return false;
        }
        case "FencedCode": {
          const info = node.getChild("CodeInfo");
          const infoText = info ? doc.sliceString(info.from, info.to) : "";
          const { lang, executable } = parseInfo(infoText);
          const first = doc.lineAt(n.from);
          const last = doc.lineAt(n.to);
          const closed = last.number > first.number && /^\s*(`{3,}|~{3,})\s*$/.test(last.text);
          const codeFrom = Math.min(first.to + 1, doc.length);
          const codeTo = closed ? Math.max(codeFrom, last.from - 1) : n.to;
          const code = doc.sliceString(codeFrom, codeTo);
          if (executable && (lang === "mermaid" || lang === "dot") && !linesTouch(n.from, n.to) && closed) {
            addBlock(first.from, last.to, new DiagramWidget(code, n.from, lang));
            return false;
          }
          const opts = executable ? cellOptions(code) : {};
          const out = executable ? outputs?.get(n.from) : undefined;
          addLine(first.number, "cm-code cm-code-open");
          for (let ln = first.number + 1; ln < last.number; ln++) {
            const l = doc.line(ln);
            addLine(ln, /^\s*(#|%%|\/\/)\|/.test(l.text) ? "cm-code cm-cell-opt" : "cm-code");
          }
          if (closed) addLine(last.number, "cm-code cm-code-close");
          if (!touches(first.from, first.to)) {
            ranges.push(Decoration.replace({ widget: new CellHeaderWidget(lang, opts.label ?? null, executable, !!out?.running, n.from) }).range(first.from, first.to));
          }
          if (closed && !touches(last.from, last.to)) hide(last.from, last.to);
          if (out && closed) {
            const label = opts.label;
            const t = label ? ctx.index.targets.get(label) : null;
            const capKey = label ? `${label.split("-")[0]}-cap` : "";
            const cap = t && opts[capKey] ? `${t.display}: ${opts[capKey]}` : opts[capKey] ?? null;
            const w = new CellOutputWidget(out, hashCode(code) !== out.hash, cap);
            const cls = containerClass(last.number);
            ranges.push(Decoration.widget({ widget: cls ? new WrapWidget(w, cls) : w, block: true, side: 1 }).range(last.to));
          }
          return false;
        }
        case "Table": {
          const first = doc.lineAt(n.from);
          let last = doc.lineAt(n.to);
          let caption: string | null = null;
          let label: string | null = null;
          // Pandoc table caption: a following paragraph starting with ": "
          let ln = last.number + 1;
          if (ln <= doc.lines && !doc.line(ln).text.trim()) ln++;
          if (ln <= doc.lines && /^:\s/.test(doc.line(ln).text)) {
            const capLine = doc.line(ln);
            const m = /^:\s+(.*?)\s*(\{[^{}]*\})?\s*$/.exec(capLine.text)!;
            caption = m[1];
            label = m[2] ? parseAttrs(m[2]).id : null;
            last = capLine;
          }
          if (!linesTouch(first.from, last.to)) addBlock(first.from, last.to, new TableWidget(doc.sliceString(n.from, n.to), caption, label, n.from));
          return false;
        }
        case "Blockquote": {
          for (let ln = doc.lineAt(n.from).number; ln <= doc.lineAt(n.to).number; ln++) addLine(ln, "cm-quote");
          return;
        }
        case "QuoteMark": {
          const line = doc.lineAt(n.from);
          if (!touches(line.from, line.to)) hide(n.from, Math.min(n.to + (doc.sliceString(n.to, n.to + 1) === " " ? 1 : 0), line.to));
          return;
        }
        case "ListMark": {
          const line = doc.lineAt(n.from);
          if (node.parent?.parent?.name === "BulletList" && !touches(line.from, line.to)) {
            const task = node.nextSibling?.name === "Task";
            if (task) hide(n.from, Math.min(n.to + 1, line.to));
            else ranges.push(Decoration.replace({ widget: new BulletWidget(listDepth(node)) }).range(n.from, n.to));
          }
          return;
        }
        case "TaskMarker": {
          const line = doc.lineAt(n.from);
          if (!touches(line.from, line.to)) {
            const checked = /x/i.test(doc.sliceString(n.from, n.to));
            ranges.push(Decoration.replace({ widget: new CheckboxWidget(checked, n.from) }).range(n.from, n.to));
            if (checked) ranges.push(markDeco("cm-task-done").range(n.to, line.to));
          }
          return;
        }
        case "HorizontalRule": {
          const line = doc.lineAt(n.from);
          if (slides) {
            slideBreak(line.from);
            if (!touches(line.from, line.to)) hide(n.from, n.to);
            return;
          }
          if (!touches(line.from, line.to)) ranges.push(Decoration.replace({ widget: new HrWidget() }).range(n.from, n.to));
          return;
        }
        case "AtRef": {
          const key = doc.sliceString(n.from + 1, n.to);
          const r = refText(key, { narrative: true, suppressAuthor: false });
          if (!touches(n.from, n.to)) {
            const title = r.target ? (r.target.caption ? `${r.target.display}: ${r.target.caption}` : r.target.display) + "\n⌘-click to open" : ctx.bib.get(key)?.title ?? (r.ok ? "" : `Unresolved reference @${key}`);
            ranges.push(Decoration.replace({ widget: new RefWidget(r.text, r.ok, r.kind, key, title) }).range(n.from, n.to));
          } else ranges.push(markDeco(r.ok ? "cm-ref-src" : "cm-ref-src cm-ref-missing").range(n.from, n.to));
          return false;
        }
        case "Citation": {
          const inner = doc.sliceString(n.from + 1, n.to - 1);
          const items = parseBracketCitation(inner);
          if (items && !touches(n.from, n.to)) {
            const r = citeText(items);
            const title = items.map((i) => ctx.bib.get(i.key)?.title ?? ctx.index.targets.get(i.key)?.caption ?? i.key).join("\n");
            ranges.push(Decoration.replace({ widget: new RefWidget(r.text, r.ok, "cite", items[0].key, title) }).range(n.from, n.to));
          } else ranges.push(markDeco("cm-ref-src").range(n.from, n.to));
          return false;
        }
        case "Shortcode": {
          ranges.push(markDeco("cm-shortcode").range(n.from, n.to));
          return false;
        }
        case "Attributes": {
          ranges.push(markDeco("cm-attrs").range(n.from, n.to));
          return false;
        }
      }
    },
  });

  for (const [lineNo, cls] of divLineClass) {
    const line = doc.line(lineNo);
    ranges.push(lineDeco(cls).range(line.from));
  }

  const filtered = ranges.filter((r) => {
    if (blockRanges.has(r)) return true;
    if (r.from === r.to) return !blocks.some((b) => r.from >= b.from && r.from <= b.to);
    return !blocks.some((b) => r.from < b.to && r.to > b.from);
  });
  return Decoration.set(filtered, true);
}

export const livePreviewField = StateField.define<DecorationSet>({
  create: (state) => buildDecorations(state),
  update(deco, tr) {
    const changed =
      tr.docChanged ||
      tr.selection ||
      tr.effects.some((e) => e.is(refreshEffect) || e.is(setTabEffect) || e.is(toggleCalloutEffect)) ||
      tr.startState.field(focusField, false) !== tr.state.field(focusField, false) ||
      tr.startState.field(outputsField, false) !== tr.state.field(outputsField, false) ||
      syntaxTree(tr.startState) !== syntaxTree(tr.state);
    return changed ? buildDecorations(tr.state) : deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** ⌘/Ctrl-click on links and references navigates. */
export const livePreviewHandlers = EditorView.domEventHandlers({
  mousedown(e, view) {
    const target = e.target as HTMLElement;
    if (!(e.metaKey || e.ctrlKey)) {
      // First click into an unfocused editor: place the cursor using the layout the user
      // actually clicked on, then reveal the source around it.
      if (e.button !== 0 || e.defaultPrevented || e.shiftKey || view.state.field(focusField, false) === 2) return false;
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
      if (pos == null) return false;
      e.preventDefault();
      view.dispatch({ selection: { anchor: pos }, effects: activateEffect.of(null), userEvent: "select.pointer" });
      view.focus();
      return true;
    }
    const link = target.closest<HTMLElement>(".cm-link");
    if (link?.dataset.url) {
      e.preventDefault();
      ctx.openLink(link.dataset.url);
      return true;
    }
    const ref = target.closest<HTMLElement>(".cm-ref");
    const key = ref?.dataset.ref;
    if (key) {
      const t = ctx.index.targets.get(key);
      if (t) {
        e.preventDefault();
        ctx.openRef(t);
        return true;
      }
    }
    // Clicking on revealed source of a ref
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
    if (pos != null) {
      const m = /@([\w:.\-]+)$/.exec(view.state.doc.sliceString(Math.max(0, pos - 60), pos) + (/[\w:.\-]*/.exec(view.state.doc.sliceString(pos, pos + 60))?.[0] ?? ""));
      const t = m && ctx.index.targets.get(m[1].replace(/[.:]+$/, ""));
      if (t) {
        e.preventDefault();
        ctx.openRef(t);
        return true;
      }
    }
    return false;
  },
});

export { md };
