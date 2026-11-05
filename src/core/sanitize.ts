/**
 * Conservative sanitizer for raw HTML tables shown in the preview: removes active content
 * (scripts, styles, frames, embedded objects, forms), event-handler attributes and javascript: URLs.
 * The widget additionally strips on* attributes after parsing, so this is defence in depth.
 */
export function sanitizeHtml(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|iframe|object|embed|form|template|noscript)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(script|style|iframe|object|embed|form|link|meta|base|input|button|textarea|select)\b[^>]*>/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src|xlink:href|action|formaction)\s*=\s*(["']?)\s*(javascript|vbscript|data:text\/html)[^"'\s>]*\2/gi, '$1="#"');
}

/** True when a raw HTML block is (mostly) a table. */
export function isHtmlTable(html: string): boolean {
  return /^\s*(<!--[\s\S]*?-->\s*)*<table[\s>]/i.test(html);
}

/** Column widths from `tbl-colwidths="[75,25]"`, or from relative dash widths in a long pipe table. */
export function tableColWidths(src: string, attr: string | undefined): number[] | null {
  if (attr && attr !== "auto" && attr !== "true") {
    try {
      const v = JSON.parse(attr);
      if (Array.isArray(v) && v.length) {
        const total = v.reduce((s: number, x: number) => s + Number(x), 0) || 1;
        return v.map((x: number) => (Number(x) / total) * 100);
      }
    } catch {
      /* ignore */
    }
  }
  if (attr === "auto") return null;
  // Pandoc: when a line is longer than the text width (72 chars), widths follow the dash counts
  const lines = src.split("\n").filter((l) => l.trim());
  if (lines.length < 2 || !lines.some((l) => l.length > 72)) return null;
  let delim = lines[1].trim();
  if (delim.startsWith("|")) delim = delim.slice(1);
  if (delim.endsWith("|")) delim = delim.slice(0, -1);
  const dashes = delim.split("|").map((c) => c.replace(/[^-]/g, "").length);
  const total = dashes.reduce((a, b) => a + b, 0) || 1;
  return dashes.map((d) => (d / total) * 100);
}
