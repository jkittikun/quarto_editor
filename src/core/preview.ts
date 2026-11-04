/** Build hover-preview HTML for cross-reference targets from their source text. */
import type { XrefTarget } from "./xref";
import { renderBlocks, escapeHtml, type BlockContext } from "./inline";

export interface PreviewContext extends BlockContext {
  math: (tex: string, display: boolean) => string;
  /** Resolve an image path relative to the target's file to a URL. */
  image: (src: string) => string;
  table?: (src: string, caption: string | null, label: string | null) => string;
}

export function previewTarget(t: XrefTarget, src: string, c: PreviewContext): string {
  const lines = src.split(/\r?\n/);
  const line = lines[t.line] ?? "";
  const head = `<div class="pv-head">${escapeHtml(t.display)}${t.caption && t.type !== "fig" && t.type !== "tbl" ? ` — ${renderBlocks(t.caption, c).replace(/^<p>|<\/p>$/g, "")}` : ""}</div>`;
  let body = "";
  switch (t.type) {
    case "fig": {
      const img = /!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/.exec(line);
      if (img) body = `<img src="${escapeHtml(c.image(img[2]))}" alt="">`;
      else if (/^\s*(`{3,}|~{3,})/.test(line)) body = `<div class="pv-muted">Figure produced by a code cell</div>`;
      if (t.caption) body += `<div class="pv-cap">${renderBlocks(t.caption, c).replace(/^<p>|<\/p>$/g, "")}</div>`;
      break;
    }
    case "eq": {
      // find the $$ … $$ block that ends on (or contains) this line
      // the label sits on the closing line: "$$ {#eq-x}" (or a one-line "$$ x $$ {#eq-x}")
      let m = /\$\$([\s\S]*?)\$\$/.exec(line);
      if (!m) {
        let start = t.line - 1;
        while (start > 0 && !/^\s*\$\$/.test(lines[start]) && t.line - start < 60) start--;
        m = /\$\$([\s\S]*?)\$\$/.exec(lines.slice(start, t.line + 1).join("\n"));
      }
      if (m) body = `<div class="pv-math">${c.math(m[1].trim(), true)}</div>`;
      break;
    }
    case "tbl": {
      // caption line ": caption {#tbl-x}" follows the table (optionally after a blank line)
      let end = t.line - 1;
      while (end >= 0 && !lines[end].trim()) end--;
      let start = end;
      while (start > 0 && /^\s*\|/.test(lines[start - 1])) start--;
      const table = lines.slice(start, end + 1).join("\n");
      if (/^\s*\|/.test(table) && c.table) body = c.table(table, t.caption, t.label);
      else if (/^\s*(`{3,}|~{3,})/.test(line)) body = `<div class="pv-muted">Table produced by a code cell</div>`;
      break;
    }
    case "sec": {
      let i = t.line + 1;
      while (i < lines.length && !lines[i].trim()) i++;
      const para: string[] = [];
      for (; i < lines.length && lines[i].trim() && !/^(#|:::|```|\$\$)/.test(lines[i]); i++) para.push(lines[i]);
      if (para.length) body = renderBlocks(para.join("\n"), c);
      break;
    }
    default: {
      // theorem-like div: ::: {#thm-x} … :::
      if (/^\s*:{3,}/.test(line)) {
        const inner: string[] = [];
        let depth = 0;
        for (let i = t.line + 1; i < lines.length; i++) {
          const l = lines[i];
          const fence = /^\s*:{3,}\s*(.*)$/.exec(l);
          if (fence) {
            if (fence[1].trim()) depth++;
            else if (depth-- === 0) break;
          }
          inner.push(l);
        }
        const text = inner.join("\n").replace(/^#{1,6}\s+.*\n?/, "");
        body = renderBlocks(text, c);
      }
    }
  }
  return `<div class="pv pv-${escapeHtml(t.type)}">${head}${body}</div>`;
}
