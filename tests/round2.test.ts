import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EditorState, EditorSelection } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { insertChapter, parseQuartoYml, bookOrder } from "../src/core/project";
import { parseFreeze, freezePath } from "../src/core/freeze";
import { projectTemplate } from "../src/core/templates";
import { renderBlocks } from "../src/core/inline";
import { quartoMarkdown } from "../src/editor/quartoSyntax";
import { buildDecorations, focusField, tabsField, collapsedField } from "../src/editor/livePreview";
import { outputsField } from "../src/editor/cells";
import { ctx, toggleCalloutEffect, activateEffect } from "../src/editor/context";

describe("insertChapter", () => {
  const yml = `project:
  type: book

book:
  title: "T"
  chapters:
    - index.qmd   # preface
    - part: "Part one"
      chapters:
        - intro.qmd
        - href: methods.qmd
    - summary.qmd
  appendices:
    - extra.qmd

format: html
`;
  it("inserts after the given chapter with matching indentation, keeping comments", () => {
    const out = insertChapter(yml, "intro.qmd", "new.qmd");
    expect(out).toContain("        - intro.qmd\n        - new.qmd\n        - href: methods.qmd");
    expect(out).toContain("- index.qmd   # preface");
    expect(out.split("\n").length).toBe(yml.split("\n").length + 1);
  });
  it("handles href entries", () => {
    expect(insertChapter(yml, "methods.qmd", "x.qmd")).toContain("- href: methods.qmd\n        - x.qmd");
  });
  it("appends after the last chapter (not into appendices) when there is no anchor", () => {
    const out = insertChapter(yml, null, "x.qmd");
    expect(out).toContain("    - summary.qmd\n    - x.qmd\n  appendices:");
    expect(parseQuartoYml(out).outline.at(-1)).toMatchObject({ kind: "chapter", file: "x.qmd" });
  });
  it("leaves files without book.chapters unchanged", () => {
    expect(insertChapter("project:\n  type: website\n", null, "x.qmd")).toBe("project:\n  type: website\n");
  });
});

describe("parseQuartoYml errors", () => {
  it("reports invalid YAML", () => {
    expect(parseQuartoYml("book: [unclosed").error).toBeTruthy();
    expect(parseQuartoYml("book:\n  title: ok\n").error).toBeNull();
  });
});

describe("freeze", () => {
  const json = readFileSync(join(__dirname, "fixtures/freeze-html.json"), "utf8");
  it("finds the freeze file for a chapter", () => {
    expect(freezePath("chapters/methods.qmd")).toEqual({
      json: "_freeze/chapters/methods/execute-results/html.json",
      dir: "_freeze/chapters/methods",
    });
  });
  it("extracts figures, stdout, html and errors per cell", () => {
    const cells = parseFreeze(json, "/book/_freeze/methods");
    expect(cells.length).toBe(3);
    expect(cells[0].outputs).toEqual([
      { type: "display", data: { "image/x-folio-path": "/book/_freeze/methods/figure-html/fig-sine-output-1.png", "text/plain": "A sine wave" } },
    ]);
    expect(cells[1].outputs[0]).toEqual({ type: "stream", name: "stdout", text: "hello\n" });
    expect(cells[1].outputs[1]).toMatchObject({ type: "display", data: { "text/html": expect.stringContaining("dataframe") } });
    expect(cells[2].outputs[0]).toMatchObject({ type: "error", ename: "ZeroDivisionError", evalue: "division by zero" });
  });
  it("tolerates bad JSON", () => {
    expect(parseFreeze("not json", "/x")).toEqual([]);
  });
});

describe("templates", () => {
  it("creates a valid book", () => {
    const files = projectTemplate("book", 'My "Book"', "Ann");
    const info = parseQuartoYml(files["_quarto.yml"]);
    expect(info.error).toBeNull();
    expect(info.title).toBe('My "Book"');
    expect(bookOrder(info).map((c) => c.file)).toEqual(["index.qmd", "intro.qmd", "summary.qmd", "references.qmd"]);
    for (const c of bookOrder(info)) expect(files[c.file]).toBeTruthy();
  });
  it("creates a revealjs presentation", () => {
    expect(projectTemplate("presentation", "S", "A")["slides.qmd"]).toContain("format: revealjs");
  });
});

describe("renderBlocks", () => {
  it("renders paragraphs, headings, lists, code and images", () => {
    const html = renderBlocks("## Hi\n\nSome *text*\nmore.\n\n- a\n- b\n\n```\nx<1\n```\n\n![cap](i.png)", { image: (s) => "/img/" + s });
    expect(html).toBe(
      '<h2>Hi</h2>\n<p>Some <em>text</em> more.</p>\n<ul><li>a</li><li>b</li></ul>\n<pre><code>x&lt;1</code></pre>\n<figure><img src="/img/i.png" alt="cap"><figcaption>cap</figcaption></figure>',
    );
  });
});

function makeState(doc: string, cursor = 0, focused = false) {
  let state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursor),
    extensions: [markdown({ base: markdownLanguage, extensions: [quartoMarkdown] }), outputsField, tabsField, collapsedField, focusField],
  });
  if (focused) state = state.update({ effects: activateEffect.of(null) }).state;
  return state;
}
function widgets(state: EditorState): string[] {
  const out: string[] = [];
  buildDecorations(state).between(0, state.doc.length, (from, to, v) => {
    const w = (v.spec as any).widget;
    const block = (v.spec as any).block;
    if (w || block) out.push(`${w ? w.constructor.name : "hidden"}${block ? "[block]" : ""}@${from}-${to}`);
  });
  return out;
}

describe("round-2 decorations", () => {
  beforeAll(() => {
    ctx.root = "/book";
    ctx.file = "/book/x.qmd";
    ctx.projectFormats = [];
  });

  const callout = '::: {.callout-note collapse="true"}\n## Title\nBody text\n:::\n';
  it("collapses a collapse=true callout and expands it on toggle", () => {
    const st = makeState(callout);
    const w = widgets(st);
    expect(w).toContain("HiddenBlockWidget[block]@45-54"); // body line hidden
    const expanded = st.update({ effects: toggleCalloutEffect.of({ callout: 0, collapsed: false }) }).state;
    expect(widgets(expanded).some((s) => s.startsWith("HiddenBlockWidget[block]@45"))).toBe(false);
  });
  it("leaves callouts without collapse open", () => {
    expect(widgets(makeState("::: {.callout-tip}\nBody\n:::\n")).some((s) => s.startsWith("HiddenBlockWidget[block]"))).toBe(false);
  });

  const cols = ':::: {.columns}\n::: {.column width="40%"}\nLeft\n:::\n::: {.column width="60%"}\nRight\n:::\n::::\n';
  it("renders columns side by side until the cursor enters", () => {
    expect(widgets(makeState(cols)).map((s) => s.split("@")[0])).toEqual(["ColumnsWidget[block]"]);
    const inside = widgets(makeState(cols, cols.indexOf("Left"), true));
    expect(inside.some((s) => s.startsWith("ColumnsWidget"))).toBe(false);
  });

  it("renders graphviz dot cells as diagrams", () => {
    expect(widgets(makeState("```{dot}\ndigraph { a -> b }\n```\n")).map((s) => s.split("@")[0])).toEqual(["DiagramWidget[block]"]);
  });

  it("marks slide breaks in revealjs documents only", () => {
    const deck = "---\nformat: revealjs\n---\n\n## One\n\ntext\n\n## Two\n";
    const count = (src: string) => {
      let n = 0;
      buildDecorations(makeState(src)).between(0, src.length, (_f, _t, v) => {
        if ((v.spec as any).class === "cm-slide-break") n++;
      });
      return n;
    };
    expect(count(deck)).toBe(2);
    expect(count(deck.replace("revealjs", "html"))).toBe(0);
  });
});
