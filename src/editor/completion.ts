import { autocompletion, snippetCompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { ctx } from "./context";
import { authorList } from "../core/bibtex";

const SLASH_ITEMS: Completion[] = [
  snippetCompletion("# ${Heading}", { label: "/h1", detail: "Heading 1" }),
  snippetCompletion("## ${Heading}", { label: "/h2", detail: "Heading 2" }),
  snippetCompletion("### ${Heading}", { label: "/h3", detail: "Heading 3" }),
  snippetCompletion("::: {.callout-note}\n## ${Title}\n${}\n:::", { label: "/note", detail: "Callout · note" }),
  snippetCompletion("::: {.callout-tip}\n## ${Title}\n${}\n:::", { label: "/tip", detail: "Callout · tip" }),
  snippetCompletion("::: {.callout-warning}\n## ${Title}\n${}\n:::", { label: "/warning", detail: "Callout · warning" }),
  snippetCompletion("::: {.callout-important}\n## ${Title}\n${}\n:::", { label: "/important", detail: "Callout · important" }),
  snippetCompletion("::: {.callout-caution}\n## ${Title}\n${}\n:::", { label: "/caution", detail: "Callout · caution" }),
  snippetCompletion("```{python}\n${}\n```", { label: "/python", detail: "Python code cell" }),
  snippetCompletion("```{python}\n#| label: fig-${name}\n#| fig-cap: \"${Caption}\"\n\n${}\n```", { label: "/plot", detail: "Python figure cell" }),
  snippetCompletion("```${lang}\n${}\n```", { label: "/code", detail: "Code block (not executed)" }),
  snippetCompletion("![${Caption}](${path}){#fig-${name}}", { label: "/figure", detail: "Figure with label" }),
  snippetCompletion("$$\n${}\n$$ {#eq-${name}}", { label: "/equation", detail: "Numbered equation" }),
  snippetCompletion("$$\n${}\n$$", { label: "/math", detail: "Display math" }),
  snippetCompletion("| ${Col 1} | Col 2 |\n|-------|-------|\n|       |       |\n\n: ${Caption} {#tbl-${name}}", { label: "/table", detail: "Table with caption" }),
  snippetCompletion("::: {.panel-tabset}\n## ${Tab 1}\n\n## Tab 2\n\n:::", { label: "/tabset", detail: "Tabbed panel" }),
  snippetCompletion("::: {#thm-${name}}\n## ${Name}\n${}\n:::", { label: "/theorem", detail: "Theorem" }),
  snippetCompletion("::: {.columns}\n::: {.column width=\"50%\"}\n${}\n:::\n::: {.column width=\"50%\"}\n\n:::\n:::", { label: "/columns", detail: "Two columns" }),
  snippetCompletion("```{mermaid}\nflowchart LR\n  A[${Start}] --> B[End]\n```", { label: "/mermaid", detail: "Mermaid diagram" }),
  snippetCompletion("> ${}", { label: "/quote", detail: "Block quote" }),
  snippetCompletion("- [ ] ${}", { label: "/todo", detail: "Task list" }),
  snippetCompletion("{{< pagebreak >}}", { label: "/pagebreak", detail: "Page break shortcode" }),
  snippetCompletion("[^${note}]", { label: "/footnote", detail: "Footnote reference" }),
];

function slashSource(c: CompletionContext): CompletionResult | null {
  const line = c.state.doc.lineAt(c.pos);
  const before = line.text.slice(0, c.pos - line.from);
  const m = /(^|\s)(\/[\w-]*)$/.exec(before);
  if (!m || (!c.explicit && m[2].length === 0)) return null;
  if (before.trim() !== m[2]) return null; // only at the start of an otherwise empty line
  return { from: c.pos - m[2].length, options: SLASH_ITEMS, validFor: /^\/[\w-]*$/ };
}

function refSource(c: CompletionContext): CompletionResult | null {
  const m = c.matchBefore(/(?<![\w@])-?@[\w:.\-]*/);
  if (!m) return null;
  const at = m.text.indexOf("@");
  const options: Completion[] = [];
  for (const t of ctx.index.targets.values()) {
    options.push({
      label: t.label,
      detail: t.display,
      info: t.caption ?? undefined,
      type: "variable",
      boost: t.file && ctx.file.endsWith(t.file) ? 2 : 1,
    });
  }
  for (const e of ctx.bib.values()) {
    options.push({ label: e.key, detail: `${authorList(e)} ${e.year}`, info: e.title, type: "text" });
  }
  return { from: m.from + at + 1, options, validFor: /^[\w:.\-]*$/ };
}

export const quartoCompletion = autocompletion({
  override: [slashSource, refSource],
  icons: false,
  activateOnTyping: true,
});
