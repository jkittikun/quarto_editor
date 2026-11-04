import { EditorSelection, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, drawSelection, dropCursor, rectangularSelection, placeholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { pythonLanguage } from "@codemirror/lang-python";
import { yamlLanguage } from "@codemirror/lang-yaml";
import { tags as t } from "@lezer/highlight";
import { quartoMarkdown } from "./quartoSyntax";
import { livePreviewField, livePreviewHandlers, tabsField, focusField, focusTracking } from "./livePreview";
import { outputsField, listCells } from "./cells";
import { quartoCompletion } from "./completion";
import { ctx } from "./context";

const highlight = HighlightStyle.define([
  { tag: t.heading, fontWeight: "700" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, color: "var(--accent)" },
  { tag: t.url, color: "var(--muted)" },
  { tag: t.monospace, fontFamily: "var(--mono)" },
  { tag: t.processingInstruction, color: "var(--muted)" },
  { tag: t.meta, color: "var(--muted)" },
  { tag: t.quote, color: "var(--fg-soft)" },
  { tag: t.keyword, color: "var(--code-keyword)" },
  { tag: [t.string, t.special(t.string)], color: "var(--code-string)" },
  { tag: [t.number, t.bool, t.null], color: "var(--code-number)" },
  { tag: t.comment, color: "var(--code-comment)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--code-fn)" },
  { tag: [t.definition(t.variableName), t.className], color: "var(--code-def)" },
  { tag: t.operator, color: "var(--code-op)" },
  { tag: t.propertyName, color: "var(--code-prop)" },
  { tag: t.attributeName, color: "var(--muted)" },
  { tag: t.macroName, color: "var(--code-keyword)" },
]);

const codeLanguages = (info: string) => {
  const lang = info.replace(/[{}]/g, " ").trim().split(/[\s,]+/)[0]?.toLowerCase();
  if (lang === "python" || lang === "py") return pythonLanguage;
  if (lang === "yaml" || lang === "yml") return yamlLanguage;
  return null;
};

/** Find the executable cell containing the cursor and run it. */
function runCellAtCursor(view: EditorView, advance: boolean): boolean {
  const pos = view.state.selection.main.head;
  const cells = listCells(view.state);
  const cell = cells.find((c) => c.executable && pos >= c.pos && pos <= c.closeLineEnd);
  if (!cell) return false;
  ctx.runCell(view, cell.pos);
  if (advance) {
    const next = cells.find((c) => c.executable && c.pos > cell.pos);
    if (next) view.dispatch({ selection: { anchor: next.codeFrom }, scrollIntoView: true });
  }
  return true;
}

function wrapSelection(mark: string) {
  return (view: EditorView) => {
    const n = mark.length;
    const tr = view.state.changeByRange((r) => {
      const text = view.state.sliceDoc(r.from, r.to);
      if (text.length >= 2 * n && text.startsWith(mark) && text.endsWith(mark)) {
        return {
          changes: { from: r.from, to: r.to, insert: text.slice(n, -n) },
          range: EditorSelection.range(r.from, r.to - 2 * n),
        };
      }
      return {
        changes: [{ from: r.from, insert: mark }, { from: r.to, insert: mark }],
        range: EditorSelection.range(r.from + n, r.to + n),
      };
    });
    view.dispatch(view.state.update(tr, { scrollIntoView: true, userEvent: "input" }));
    return true;
  };
}

export interface SetupOptions {
  onChange: (state: EditorState) => void;
  onSave: () => void;
  extraKeys?: { key: string; run: () => boolean }[];
}

export function editorExtensions(opts: SetupOptions): Extension[] {
  return [
    history(),
    drawSelection(),
    dropCursor(),
    rectangularSelection(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    highlightSelectionMatches(),
    EditorView.lineWrapping,
    placeholder("Start writing… (type / for blocks, @ for references)"),
    markdown({ base: markdownLanguage, codeLanguages, extensions: [quartoMarkdown], addKeymap: true }),
    syntaxHighlighting(highlight),
    outputsField,
    tabsField,
    focusField,
    focusTracking,
    EditorView.theme({ ".cm-scroller": { fontFamily: "var(--sans)", lineHeight: "1.7" } }),
    livePreviewField,
    livePreviewHandlers,
    quartoCompletion,
    keymap.of([
      { key: "Mod-Enter", run: (v) => runCellAtCursor(v, false) },
      { key: "Shift-Enter", run: (v) => runCellAtCursor(v, true) },
      { key: "Mod-b", run: wrapSelection("**") },
      { key: "Mod-i", run: wrapSelection("*") },
      { key: "Mod-e", run: wrapSelection("`") },
      { key: "Mod-s", run: () => (opts.onSave(), true), preventDefault: true },
      ...(opts.extraKeys ?? []).map((k) => ({ key: k.key, run: k.run, preventDefault: true })),
      ...closeBracketsKeymap,
      ...completionKeymap,
      ...searchKeymap,
      ...historyKeymap,
      indentWithTab,
      ...defaultKeymap,
    ]),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) opts.onChange(u.state);
    }),
  ];
}
