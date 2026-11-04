import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parser as baseParser, GFM } from "@lezer/markdown";
import { EditorState, EditorSelection } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { quartoMarkdown } from "../src/editor/quartoSyntax";
import { activateEffect } from "../src/editor/context";
import { buildDecorations, focusField, tabsField } from "../src/editor/livePreview";
import { outputsField, listCells, cellOptions, matchCachedOutputs, hashCode } from "../src/editor/cells";
import { ctx } from "../src/editor/context";
import { parseQuartoYml, bookOrder } from "../src/core/project";
import { buildIndex } from "../src/core/xref";
import { parseBibtex } from "../src/core/bibtex";

const BOOK = join(__dirname, "../examples/book");
const read = (f: string) => readFileSync(join(BOOK, f), "utf8");
const parser = baseParser.configure([GFM, quartoMarkdown]);

function nodes(src: string): string[] {
  const out: string[] = [];
  parser.parse(src).iterate({ enter: (n) => void out.push(`${n.name}:${src.slice(n.from, n.to)}`) });
  return out;
}

describe("quarto syntax extensions", () => {
  it("parses front matter without turning it into a setext heading", () => {
    const n = nodes("---\ntitle: x\n---\n\n# Hi\n");
    expect(n.some((s) => s.startsWith("FrontMatter:---\ntitle: x\n---"))).toBe(true);
    expect(n.some((s) => s.startsWith("SetextHeading"))).toBe(false);
  });
  it("parses inline and display math", () => {
    const n = nodes("Euler $e^{i\\pi}$ costs $5 and $6.\n\n$$\nx^2\n$$ {#eq-a}\n");
    expect(n).toContain("InlineMath:$e^{i\\pi}$");
    expect(n.filter((s) => s.startsWith("InlineMath:")).length).toBe(1);
    expect(n).toContain("DisplayMath:$$\nx^2\n$$ {#eq-a}");
  });
  it("lets display math interrupt a paragraph", () => {
    const n = nodes("Some text\n$$\na\n$$\n");
    expect(n.some((s) => s.startsWith("DisplayMath:"))).toBe(true);
  });
  it("parses fenced div markers", () => {
    const n = nodes("::: {.callout-note}\nBody\n:::\n");
    expect(n.filter((s) => s.startsWith("DivFence:"))).toEqual(["DivFence:::: {.callout-note}", "DivFence::::"]);
  });
  it("parses citations, refs, shortcodes and attributes", () => {
    const n = nodes("See [@a; @b, p. 3] and @fig-x. Mail me@x.com {{< pagebreak >}} ![c](i.png){#fig-y}\n");
    expect(n).toContain("Citation:[@a; @b, p. 3]");
    expect(n).toContain("AtRef:@fig-x");
    expect(n.some((s) => s.startsWith("AtRef:@x"))).toBe(false);
    expect(n).toContain("Shortcode:{{< pagebreak >}}");
    expect(n).toContain("Attributes:{#fig-y}");
  });
  it("does not treat links as citations", () => {
    const n = nodes("[text](http://x.com/@y)\n");
    expect(n.some((s) => s.startsWith("Citation"))).toBe(false);
    expect(n.some((s) => s.startsWith("Link"))).toBe(true);
  });
});

function makeState(doc: string, cursor?: number, focused = true) {
  let state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursor ?? 0),
    extensions: [markdown({ base: markdownLanguage, extensions: [quartoMarkdown] }), outputsField, tabsField, focusField],
  });
  if (focused) state = state.update({ effects: activateEffect.of(null) }).state;
  return state;
}

function widgets(state: EditorState): string[] {
  const out: string[] = [];
  buildDecorations(state).between(0, state.doc.length, (from, to, v) => {
    const w = (v.spec as any).widget;
    if (w) out.push(`${w.constructor.name}${(v.spec as any).block ? "[block]" : ""}@${from}-${to}`);
  });
  return out;
}

describe("live preview decorations", () => {
  beforeAll(() => {
    const info = parseQuartoYml(read("_quarto.yml"));
    const docs = bookOrder(info).map((c) => ({ ...c, src: read(c.file) }));
    ctx.root = BOOK;
    ctx.file = join(BOOK, "intro.qmd");
    ctx.index = buildIndex(docs, true);
    ctx.bib = new Map(parseBibtex(read("references.bib")).map((e) => [e.key, e]));
  });

  it("renders everything when the editor is not focused", () => {
    const w = widgets(makeState(read("intro.qmd"), 0, false));
    const names = w.map((s) => s.split("@")[0]);
    expect(names).toContain("FrontMatterWidget[block]");
    expect(names).toContain("CalloutHeaderWidget");
    expect(names).toContain("MathWidget");
    expect(names.filter((n) => n.startsWith("WrapWidget[block]")).length).toBeGreaterThan(0); // display math inside callout
    expect(names).toContain("ImageWidget[block]");
    expect(names).toContain("TableWidget[block]");
    expect(names).toContain("TabBarWidget");
    expect(names.filter((n) => n === "RefWidget").length).toBeGreaterThanOrEqual(4);
  });

  it("reveals source around the cursor", () => {
    const src = "Inline $x^2$ here.\n";
    expect(widgets(makeState(src, 0))).toEqual(["MathWidget@7-12"]); // cursor elsewhere on the line: still rendered
    expect(widgets(makeState(src, 9))).toEqual([]); // inside the math: source shown
    const off = widgets(makeState(src + "\nother line\n", src.length + 3));
    expect(off.map((s) => s.split("@")[0])).toEqual(["MathWidget"]);
  });

  it("never changes the document", () => {
    const src = read("intro.qmd");
    const state = makeState(src, 0, false);
    buildDecorations(state);
    expect(state.doc.toString()).toBe(src);
  });
});

describe("cells", () => {
  const src = "Text\n\n```{python}\n#| label: fig-a\n#| fig-cap: \"Cap\"\nprint(1)\n```\n\n```python\nnot executed\n```\n";
  it("lists cells with options", () => {
    const cells = listCells(makeState(src));
    expect(cells.map((c) => [c.lang, c.executable])).toEqual([["python", true], ["python", false]]);
    expect(cells[0].options).toEqual({ label: "fig-a", "fig-cap": "Cap" });
    expect(cells[0].code).toBe('#| label: fig-a\n#| fig-cap: "Cap"\nprint(1)');
  });
  it("parses cell options only from the leading comment block", () => {
    expect(cellOptions("#| echo: false\nx = 1\n#| label: no")).toEqual({ echo: "false" });
  });
  it("matches cached outputs by code hash even when cells move", () => {
    const state = makeState("```{python}\nnew()\n```\n\n" + src);
    const cells = listCells(state);
    const cached = [{ index: 0, hash: hashCode(cells[1].code), outputs: [{ type: "stream" as const, name: "stdout" as const, text: "1\n" }] }];
    const m = matchCachedOutputs(state, cached);
    expect([...m.keys()]).toEqual([cells[1].pos]);
  });
});
