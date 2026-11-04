import { describe, it, expect } from "vitest";
import { parser as baseParser, GFM, Superscript } from "@lezer/markdown";
import { quartoMarkdown } from "../src/editor/quartoSyntax";

const parser = baseParser.configure([GFM, Superscript, quartoMarkdown]);
function nodes(src: string): string[] {
  const out: string[] = [];
  parser.parse(src).iterate({ enter: (n) => void out.push(`${n.name}:${src.slice(n.from, n.to)}`) });
  return out;
}

describe("round 4 syntax", () => {
  it("parses \\index{} with nested braces and other LaTeX-only commands", () => {
    const n = nodes("SHM\\index{การติดตาม{x}!sub} (structural) \\newpage and \\label{sec:a}.\n");
    expect(n).toContain("LatexCommand:\\index{การติดตาม{x}!sub}");
    expect(n).toContain("LatexCommand:\\newpage");
    expect(n).toContain("LatexCommand:\\label{sec:a}");
  });
  it("leaves ordinary escapes and unknown commands alone", () => {
    const n = nodes("Price \\$5 and \\textbf{x}\n");
    expect(n.some((s) => s.startsWith("LatexCommand"))).toBe(false);
  });
  it("parses footnote references and inline footnotes", () => {
    const n = nodes("Text[^note] and more^[An inline *note*.] end. x^2^\n\n[^note]: The note.\n");
    expect(n).toContain("FootnoteRef:[^note]");
    expect(n).toContain("InlineFootnote:^[An inline *note*.]");
    expect(n.some((s) => s.startsWith("FootnoteRef:[^note]:"))).toBe(false);
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EditorState, EditorSelection } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { parseFreeze, matchFrozen } from "../src/core/freeze";
import { visibleIn, conditionLabel } from "../src/core/conditional";
import { parseAttrs } from "../src/core/attrs";
import { previewTarget } from "../src/core/preview";
import { buildDecorations, focusField, tabsField, collapsedField } from "../src/editor/livePreview";
import { outputsField, listCells } from "../src/editor/cells";
import { ctx } from "../src/editor/context";

describe("freeze alignment", () => {
  const doc = (code: string, options: Record<string, string> = {}, index = 0) => ({ index, code, options });
  it("skips include:false cells (Quarto writes nothing for them)", () => {
    const cells = [
      doc("#| include: false\nimport bookstyle", { include: "false" }, 0),
      doc("plot()", {}, 1),
      doc("table()", {}, 2),
    ];
    const frozen = [
      { index: 0, outputs: [], label: null, code: "plot()" },
      { index: 1, outputs: [], label: null, code: "table()" },
    ];
    expect([...matchFrozen(cells, frozen)]).toEqual([[0, 1], [1, 2]]);
  });
  it("matches by label first, then code, then order (echo:false has no code)", () => {
    const cells = [doc("a()", {}, 0), doc("#| label: fig-x\nb()", { label: "fig-x" }, 1), doc("#| echo: false\nc()", { echo: "false" }, 2)];
    const frozen = [
      { index: 0, outputs: [], label: "fig-x", code: null },
      { index: 1, outputs: [], label: null, code: "a()" },
      { index: 2, outputs: [], label: null, code: null },
    ];
    expect(matchFrozen(cells, frozen)).toEqual(new Map([[0, 1], [1, 0], [2, 2]]));
  });
  it("extracts labels and echoed code from freeze markdown", () => {
    const json = readFileSync(join(__dirname, "fixtures/freeze-html.json"), "utf8");
    const cells = parseFreeze(json, "/b/_freeze/methods");
    expect(cells[0].label).toBe("fig-sine");
    expect(cells[1].code).toContain('print("hello")');
  });
});

describe("conditional content", () => {
  const a = (s: string) => parseAttrs(s);
  it("evaluates when-/unless-format for HTML", () => {
    expect(visibleIn(a('.content-visible when-format="pdf"'), "html")).toBe(false);
    expect(visibleIn(a('.content-visible when-format="html"'), "html")).toBe(true);
    expect(visibleIn(a('.content-hidden when-format="html"'), "html")).toBe(false);
    expect(visibleIn(a('.content-visible unless-format="latex"'), "html")).toBe(true);
    expect(visibleIn(a(".content-hidden"), "html")).toBe(false);
  });
  it("labels conditions", () => {
    expect(conditionLabel(a('.content-visible when-format="pdf"'))).toBe("PDF only");
    expect(conditionLabel(a('.content-hidden when-format="html"'))).toBe("hidden in HTML");
  });
});

describe("hover previews", () => {
  const c = { math: (t: string) => `<m>${t}</m>`, image: (s: string) => `/img/${s}`, table: () => "<table></table>" };
  const src = "# Ch\n\n![A curve](g.svg){#fig-g}\n\n$$\nx^2\n$$ {#eq-x}\n\n| a |\n|---|\n| 1 |\n\n: Cap {#tbl-t}\n\n::: {#thm-p}\n## Name\nStatement $y$.\n:::\n";
  const t = (type: string, label: string, line: number, caption: string | null = null) => ({ label, type, number: "1.1", display: `X 1.1`, caption, file: "c.qmd", line });
  it("shows figures, equations, tables and theorems", () => {
    expect(previewTarget(t("fig", "fig-g", 2, "A curve"), src, c)).toContain('<img src="/img/g.svg"');
    expect(previewTarget(t("eq", "eq-x", 6), src, c)).toContain("<m>x^2</m>");
    expect(previewTarget(t("tbl", "tbl-t", 12, "Cap"), src, c)).toContain("<table>");
    expect(previewTarget(t("thm", "thm-p", 14, "Name"), src, c)).toContain("Statement");
  });
});

function state(doc: string, cursor = 0) {
  return EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursor),
    extensions: [markdown({ base: markdownLanguage, extensions: [quartoMarkdown] }), outputsField, tabsField, collapsedField, focusField],
  });
}
function widgetNames(st: EditorState): string[] {
  const out: string[] = [];
  buildDecorations(st).between(0, st.doc.length, (_f, _t, v) => {
    const w = (v.spec as any).widget;
    if (w) out.push(w.constructor.name + (w.parts ? `(${w.parts.map((p: any) => p.constructor.name).join(",")})` : ""));
  });
  return out;
}

describe("cell options and reader view decorations", () => {
  const doc = "```{python}\n#| include: false\nimport x\n```\n\n```{python}\n#| echo: false\n1+1\n```\n\nText\\index{term} and[^n].\n\n::: {.content-visible when-format=\"pdf\"}\nPDF\n:::\n\n[^n]: A note.\n";
  it("collapses include:false and echo:false cells while editing", () => {
    ctx.reader = false;
    const names = widgetNames(state(doc));
    expect(names.filter((n) => n === "HiddenCellWidget")).toHaveLength(1);
    expect(names).toContain("StackWidget(HiddenCellWidget)");
    expect(names).toContain("IndexMarkWidget");
    expect(names).toContain("FootnoteWidget");
  });
  it("renders like the book in reader view", () => {
    ctx.reader = true;
    try {
      const names = widgetNames(state(doc));
      expect(names).not.toContain("HiddenCellWidget");
      expect(names).not.toContain("IndexMarkWidget");
      expect(names).toContain("FootnotesListWidget");
      expect(listCells(state(doc)).length).toBe(2);
    } finally {
      ctx.reader = false;
    }
  });
});
