import { parseBracketCitation, AT_REF } from "./cite";

export interface InlineContext {
  math?: (tex: string, display: boolean) => string;
  ref?: (key: string, opts: { narrative: boolean; suppressAuthor: boolean }) => string | null;
  cite?: (items: ReturnType<typeof parseBracketCitation> & {}) => string | null;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * Render a short piece of inline Markdown (captions, table cells, callout titles) to HTML.
 * Not a full CommonMark implementation — just the constructs that commonly appear inline.
 */
export function renderInline(src: string, ctx: InlineContext = {}): string {
  const slots: string[] = [];
  const hold = (html: string) => `\u0000${slots.push(html) - 1}\u0000`;
  let s = src;
  // inline code
  s = s.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, _t, code) => hold(`<code>${escapeHtml(code.trim())}</code>`));
  // inline math
  s = s.replace(/(?<![\\$])\$(?!\s)((?:[^$\\]|\\.)+?)(?<!\s)\$(?!\d)/g, (_, tex) =>
    hold(ctx.math ? ctx.math(tex, false) : `<span class="math">${escapeHtml(tex)}</span>`),
  );
  // bracketed citations
  s = s.replace(/\[((?:[^\[\]]*?)@[^\[\]]*)\](?!\()/g, (all, inner) => {
    const items = parseBracketCitation(inner);
    if (!items || !ctx.cite) return all;
    const r = ctx.cite(items);
    return r == null ? all : hold(r);
  });
  // links and images
  s = s.replace(/(!?)\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)(\{[^}]*\})?/g, (_, bang, text, url) =>
    bang
      ? hold(`<img alt="${escapeHtml(text)}" src="${escapeHtml(url)}">`)
      : hold(`<a href="${escapeHtml(url)}">${renderInline(text, ctx)}</a>`),
  );
  // autolinks
  s = s.replace(/<(https?:\/\/[^>\s]+)>/g, (_, url) => hold(`<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`));
  // spans with attributes: [text]{.class}
  s = s.replace(/\[([^\]]+)\]\{([^}]*)\}/g, (_, text, attrs) => {
    const classes = [...String(attrs).matchAll(/\.([\w-]+)/g)].map((m) => m[1]).join(" ");
    return hold(`<span class="${escapeHtml(classes)}">${renderInline(text, ctx)}</span>`);
  });
  // @refs
  if (ctx.ref) {
    s = s.replace(AT_REF, (all, dash, key) => {
      const r = ctx.ref!(key, { narrative: !dash, suppressAuthor: !!dash });
      return r == null ? all : hold(r);
    });
  }
  s = escapeHtml(s);
  s = s
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>")
    .replace(/__(?=\S)([\s\S]*?\S)__/g, "<strong>$1</strong>")
    .replace(/(?<![*\w])\*(?=\S)([\s\S]*?\S)\*(?![*\w])/g, "<em>$1</em>")
    .replace(/(?<![_\w])_(?=\S)([\s\S]*?\S)_(?![_\w])/g, "<em>$1</em>")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>")
    .replace(/\^(?=\S)([^^\s]+)\^/g, "<sup>$1</sup>")
    .replace(/(?<!~)~(?=\S)([^~\s]+)~(?!~)/g, "<sub>$1</sub>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[+i]);
}

export interface BlockContext extends InlineContext {
  image?: (src: string) => string; // resolve an image URL
}

/**
 * Render a small Markdown fragment (paragraphs, headings, lists, images, display math, code)
 * to HTML. Used for read-only previews such as side-by-side columns.
 */
export function renderBlocks(src: string, ctx: BlockContext = {}): string {
  const lines = src.split(/\r?\n/);
  const out: string[] = [];
  let para: string[] = [];
  let list: { tag: "ul" | "ol"; items: string[] } | null = null;
  const flushPara = () => {
    if (para.length) out.push(`<p>${renderInline(para.join(" "), ctx)}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${renderInline(i, ctx)}</li>`).join("")}</${list.tag}>`);
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*(`{3,}|~{3,})\s*(.*)$/.exec(line);
    if (fence) {
      flushPara();
      flushList();
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) body.push(lines[i]);
      out.push(`<pre><code>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }
    if (/^\s*\$\$/.test(line)) {
      flushPara();
      flushList();
      const body: string[] = [line.replace(/^\s*\$\$/, "")];
      if (!/\$\$/.test(body[0])) {
        for (i++; i < lines.length && !/\$\$/.test(lines[i]); i++) body.push(lines[i]);
        if (i < lines.length) body.push(lines[i].replace(/\$\$.*$/, ""));
      } else body[0] = body[0].replace(/\$\$.*$/, "");
      const tex = body.join("\n").trim();
      out.push(`<div class="math-display">${ctx.math ? ctx.math(tex, true) : escapeHtml(tex)}</div>`);
      continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*(\{[^}]*\})?\s*$/.exec(line);
    if (h) {
      flushPara();
      flushList();
      out.push(`<h${h[1].length}>${renderInline(h[2], ctx)}</h${h[1].length}>`);
      continue;
    }
    const img = /^\s*!\[([^\]]*)\]\(([^)\s]+)[^)]*\)(\{[^}]*\})?\s*$/.exec(line);
    if (img) {
      flushPara();
      flushList();
      const url = ctx.image ? ctx.image(img[2]) : img[2];
      out.push(`<figure><img src="${escapeHtml(url)}" alt="${escapeHtml(img[1])}">${img[1] ? `<figcaption>${renderInline(img[1], ctx)}</figcaption>` : ""}</figure>`);
      continue;
    }
    const li = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      flushPara();
      const tag = /\d/.test(li[1]) ? "ol" : "ul";
      if (!list || list.tag !== tag) {
        flushList();
        list = { tag, items: [] };
      }
      list.items.push(li[2]);
      continue;
    }
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    if (list && /^\s+\S/.test(line)) {
      list.items[list.items.length - 1] += " " + line.trim();
      continue;
    }
    flushList();
    para.push(line.trim());
  }
  flushPara();
  flushList();
  return out.join("\n");
}
