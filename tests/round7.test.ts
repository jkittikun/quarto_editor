import { describe, it, expect } from "vitest";
import { parseAttrs } from "../src/core/attrs";
import { parseLayout, splitLayoutBlocks, splitFigureCaption } from "../src/core/layout";
import { sanitizeHtml, isHtmlTable, tableColWidths } from "../src/core/sanitize";
import { scanTargets } from "../src/core/xref";
import { cellOptions, optionList } from "../src/editor/cells";
import { KERNEL_PACKAGES, canInstallInto } from "../src/core/python";

describe("layouts", () => {
  it("lays out ncol / nrow", () => {
    expect(parseLayout(parseAttrs("layout-ncol=2"), 3).rows.map((r) => r.length)).toEqual([2, 1]);
    expect(parseLayout(parseAttrs("layout-nrow=2"), 4).rows.map((r) => r.length)).toEqual([2, 2]);
    expect(parseLayout(parseAttrs("layout-ncol=2"), 2).rows[0][0].pct).toBe(50);
  });
  it("parses explicit layouts with spacers and valign", () => {
    const s = parseLayout(parseAttrs('layout="[[1,1],[1]]" layout-valign="bottom"'), 3);
    expect(s.rows.map((r) => r.map((c) => Math.round(c.pct)))).toEqual([[50, 50], [100]]);
    expect(s.valign).toBe("bottom");
    const sp = parseLayout(parseAttrs('layout="[[40,-20,40]]"'), 2);
    expect(sp.rows[0].map((c) => [Math.round(c.pct), c.spacer])).toEqual([[40, false], [20, true], [40, false]]);
  });
  it("splits blocks and finds the figure caption", () => {
    const blocks = splitLayoutBlocks("![a](a.png){#fig-x-a}\n\n![b](b.png)\n\n```python\nx\n\ny\n```\n\nThe caption\ncontinues.");
    expect(blocks).toHaveLength(4);
    expect(blocks[2]).toContain("\n\ny"); // code fences stay whole
    expect(splitFigureCaption(blocks)).toEqual({ items: blocks.slice(0, 3), caption: "The caption continues." });
    expect(splitFigureCaption(["![a](a.png)", "![b](b.png)"]).caption).toBeNull();
  });
});

describe("subfigure cross-references", () => {
  it("numbers subfigures (a), (b) under their parent figure", () => {
    const src = "# Ch\n\n::: {#fig-pair layout-ncol=2}\n\n![A](a.png){#fig-pair-a}\n\n![B](b.png){#fig-pair-b}\n\nBoth.\n\n:::\n\n![Solo](s.png){#fig-solo}\n";
    const t = Object.fromEntries(scanTargets(src, "c.qmd", "2").map((x) => [x.label, x.display]));
    expect(t).toEqual({
      "fig-pair": "Figure 2.1",
      "fig-pair-a": "Figure 2.1(a)",
      "fig-pair-b": "Figure 2.1(b)",
      "fig-solo": "Figure 2.2",
    });
    expect(scanTargets(src, "c.qmd", "2").find((x) => x.label === "fig-pair")!.caption).toBe("Both.");
  });
});

describe("tables", () => {
  it("reads tbl-colwidths", () => {
    expect(tableColWidths("| a | b |\n|---|---|\n| 1 | 2 |", "[75,25]")).toEqual([75, 25]);
    expect(tableColWidths("| a | b |\n|---|---|", "[3,1]")).toEqual([75, 25]);
  });
  it("uses dash widths only for long rows", () => {
    const long = "| a | b |\n|------|--|\n| " + "x".repeat(80) + " | y |";
    expect(tableColWidths(long, undefined)!.map(Math.round)).toEqual([75, 25]);
    expect(tableColWidths("| a | b |\n|------|--|\n| x | y |", undefined)).toBeNull();
    expect(tableColWidths(long, "auto")).toBeNull();
  });
  it("sanitizes HTML tables", () => {
    const dirty = '<table onmouseover="x()"><tr><td><a href="javascript:alert(1)">l</a><img src=x onerror=alert(1)></td></tr></table><script>alert(1)</script><iframe src="https://e"></iframe>';
    const clean = sanitizeHtml(dirty);
    expect(clean).not.toMatch(/onmouseover|onerror|javascript:|<script|<iframe/i);
    expect(clean).toContain("<table");
    expect(isHtmlTable("<table>\n<tr></tr></table>")).toBe(true);
    expect(isHtmlTable("<div><table></table></div>")).toBe(false);
  });
});

describe("cell options as YAML", () => {
  it("parses lists and booleans", () => {
    const o = cellOptions('#| layout-ncol: 2\n#| fig-subcap:\n#|   - "Sine"\n#|   - Cosine\n#| echo: false\nplot()');
    expect(o["layout-ncol"]).toBe("2");
    expect(optionList(o["fig-subcap"])).toEqual(["Sine", "Cosine"]);
    expect(o.echo).toBe("false");
  });
});

describe("python packages", () => {
  it("installs kernel + Quarto rendering packages only into safe environments", () => {
    expect(KERNEL_PACKAGES).toEqual(expect.arrayContaining(["pyyaml", "nbformat", "nbclient", "ipykernel", "jupyter_client"]));
    expect(canInstallInto("project")).toBe(true);
    expect(canInstallInto("system")).toBe(false);
  });
});
