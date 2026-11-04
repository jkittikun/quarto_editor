import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAttrs } from "../src/core/attrs";
import { parseQuartoYml, bookOrder, splitFrontMatter } from "../src/core/project";
import { buildIndex, scanTargets } from "../src/core/xref";
import { parseBibtex, formatCitation } from "../src/core/bibtex";
import { parseBracketCitation } from "../src/core/cite";
import { renderInline } from "../src/core/inline";

const BOOK = join(__dirname, "../examples/book");
const read = (f: string) => readFileSync(join(BOOK, f), "utf8");

describe("attrs", () => {
  it("parses ids, classes and key-values", () => {
    const a = parseAttrs('{#fig-x .wide .cool width=60% fig-alt="A long alt" -}');
    expect(a.id).toBe("fig-x");
    expect(a.classes).toEqual(["wide", "cool", "unnumbered"]);
    expect(a.kv).toEqual({ width: "60%", "fig-alt": "A long alt" });
  });
  it("parses callout attributes", () => {
    const a = parseAttrs('.callout-warning collapse="true"');
    expect(a.classes).toEqual(["callout-warning"]);
    expect(a.kv.collapse).toBe("true");
  });
});

describe("project", () => {
  it("parses a book outline with parts and appendices", () => {
    const info = parseQuartoYml(read("_quarto.yml"));
    expect(info.type).toBe("book");
    expect(info.title).toBe("A Sample Folio Book");
    expect(info.bibliography).toEqual(["references.bib"]);
    expect(info.outline[1]).toMatchObject({ kind: "part", title: "Foundations" });
    expect(bookOrder(info).map((c) => c.file)).toEqual([
      "index.qmd",
      "intro.qmd",
      "methods.qmd",
      "summary.qmd",
      "references.qmd",
      "appendix.qmd",
    ]);
  });
  it("splits front matter", () => {
    const fm = splitFrontMatter('---\ntitle: "Hi"\n---\n\nBody');
    expect(fm.meta.title).toBe("Hi");
    expect(fm.bodyOffset).toBe(20);
  });
});

describe("xref", () => {
  const info = parseQuartoYml(read("_quarto.yml"));
  const docs = bookOrder(info).map((c) => ({ ...c, src: read(c.file) }));
  const idx = buildIndex(docs, true);

  it("numbers chapters, skipping unnumbered ones", () => {
    expect(idx.chapters.get("index.qmd")!.number).toBeNull();
    expect(idx.chapters.get("intro.qmd")!.number).toBe("1");
    expect(idx.chapters.get("methods.qmd")!.number).toBe("2");
    expect(idx.chapters.get("summary.qmd")!.number).toBe("3");
    expect(idx.chapters.get("references.qmd")!.number).toBeNull();
    expect(idx.chapters.get("appendix.qmd")!.number).toBe("A");
  });

  it("indexes figures, tables, equations, theorems and sections", () => {
    const t = idx.targets;
    expect(t.get("fig-growth")!.display).toBe("Figure 1.1");
    expect(t.get("fig-growth")!.caption).toBe("A growth curve");
    expect(t.get("eq-gauss")!.display).toBe("Equation 1.1");
    expect(t.get("tbl-models")!.display).toBe("Table 1.1");
    expect(t.get("tbl-models")!.caption).toBe("Model comparison");
    expect(t.get("fig-sine")!.display).toBe("Figure 2.1");
    expect(t.get("fig-sine")!.caption).toBe("A sine wave");
    expect(t.get("thm-pythag")!.display).toBe("Theorem 2.1");
    expect(t.get("sec-intro")!.display).toBe("Chapter 1");
    expect(t.get("sec-extra")!.display).toBe("Appendix A");
  });

  it("numbers subsections", () => {
    const ts = scanTargets("# Ch\n\n## A {#sec-a}\n\n### B {#sec-b}\n\n## C {#sec-c}\n", "x.qmd", "4");
    expect(ts.map((t) => t.display)).toEqual(["Section 4.1", "Section 4.1.1", "Section 4.2"]);
  });

  it("ignores labels inside non-cell code blocks", () => {
    const ts = scanTargets("```\n![a](b){#fig-no}\n```\n", "x.qmd", null);
    expect(ts).toEqual([]);
  });
});

describe("bibtex & citations", () => {
  const bib = parseBibtex(read("references.bib"));
  it("parses entries", () => {
    expect(bib.map((b) => b.key)).toEqual(["knuth84", "xie2018"]);
    expect(bib[0].authors).toEqual(["Knuth"]);
    expect(bib[1].authors).toEqual(["Xie", "Allaire", "Grolemund"]);
  });
  it("formats author-date citations", () => {
    expect(formatCitation([bib[0]])).toBe("(Knuth 1984)");
    expect(formatCitation([bib[0]], { narrative: true })).toBe("Knuth (1984)");
    expect(formatCitation([bib[0], bib[1]], { locators: ["p. 3"] })).toBe(
      "(Knuth 1984, p. 3; Xie, Allaire, and Grolemund 2018)",
    );
  });
  it("parses bracket citations", () => {
    expect(parseBracketCitation("see @a, p. 33; -@b")).toEqual([
      { prefix: "see", suppressAuthor: false, key: "a", locator: "p. 33" },
      { prefix: "", suppressAuthor: true, key: "b", locator: "" },
    ]);
    expect(parseBracketCitation("not a cite")).toBeNull();
  });
});

describe("inline rendering", () => {
  it("renders emphasis, code and links safely", () => {
    expect(renderInline("**b** *i* `<x>` [l](u) <tag>")).toBe(
      '<strong>b</strong> <em>i</em> <code>&lt;x&gt;</code> <a href="u">l</a> &lt;tag&gt;',
    );
  });
  it("resolves refs through the context", () => {
    const html = renderInline("See @fig-a.", { ref: (k) => `<a>${k}</a>` });
    expect(html).toBe("See <a>fig-a</a>.");
  });
});
