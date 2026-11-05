/** Quarto figure/content layouts: layout-ncol, layout-nrow, layout="[[1,1],[1]]". */
import type { Attrs } from "./attrs";

export interface LayoutCell {
  pct: number; // width in percent of the row
  spacer: boolean; // negative entry in `layout`: empty space
}
export interface LayoutSpec {
  rows: LayoutCell[][];
  valign: "top" | "center" | "bottom";
}

export function hasLayout(a: Attrs): boolean {
  return "layout-ncol" in a.kv || "layout-nrow" in a.kv || "layout" in a.kv;
}

/** Arrange `n` items according to the layout attributes. */
export function parseLayout(a: Attrs, n: number): LayoutSpec {
  const valign = (a.kv["layout-valign"] as LayoutSpec["valign"]) ?? "top";
  const rows: LayoutCell[][] = [];
  if (a.kv.layout) {
    let spec: number[][] = [];
    try {
      const parsed = JSON.parse(a.kv.layout.replace(/'/g, '"'));
      spec = Array.isArray(parsed[0]) ? parsed : [parsed];
    } catch {
      spec = [];
    }
    if (spec.length) {
      let placed = 0;
      // repeat the pattern until every item is placed (Quarto cycles rows the same way)
      for (let r = 0; placed < n && r < 100; r++) {
        const pattern = spec[r % spec.length].map(Number).filter((x) => !Number.isNaN(x) && x !== 0);
        const total = pattern.reduce((s, x) => s + Math.abs(x), 0) || 1;
        const row = pattern.map((x) => ({ pct: (Math.abs(x) / total) * 100, spacer: x < 0 }));
        placed += row.filter((c) => !c.spacer).length;
        rows.push(row);
        if (!pattern.some((x) => x > 0)) break;
      }
      return { rows, valign };
    }
  }
  let ncol = Number(a.kv["layout-ncol"]) || 0;
  const nrow = Number(a.kv["layout-nrow"]) || 0;
  if (!ncol) ncol = nrow ? Math.ceil(n / nrow) : n || 1;
  for (let i = 0; i < n; i += ncol) rows.push(Array.from({ length: Math.min(ncol, n - i) }, () => ({ pct: 100 / ncol, spacer: false })));
  return { rows, valign };
}

/** Split div content into blocks separated by blank lines (code fences kept whole). */
export function splitLayoutBlocks(text: string): string[] {
  const blocks: string[] = [];
  let cur: string[] = [];
  let fence: string | null = null;
  for (const line of text.split("\n")) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      cur.push(line);
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !line.trim().slice(f[1].length).trim()) fence = null;
      continue;
    }
    if (f) fence = f[1];
    if (!line.trim() && !fence) {
      if (cur.length) blocks.push(cur.join("\n"));
      cur = [];
    } else cur.push(line);
  }
  if (cur.length) blocks.push(cur.join("\n"));
  return blocks;
}

/** For a figure div: the last block is the caption when it is a plain paragraph. */
export function splitFigureCaption(blocks: string[]): { items: string[]; caption: string | null } {
  const last = blocks[blocks.length - 1];
  if (blocks.length > 1 && last && !/^\s*(!\[|```|~~~|:::|\||<)/.test(last)) return { items: blocks.slice(0, -1), caption: last.replace(/\s+/g, " ").trim() };
  return { items: blocks, caption: null };
}
