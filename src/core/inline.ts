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
