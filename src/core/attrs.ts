/** Pandoc attribute blocks: `{#id .class1 .class2 key=value key2="quoted value"}` */
export interface Attrs {
  id: string | null;
  classes: string[];
  kv: Record<string, string>;
}

export function emptyAttrs(): Attrs {
  return { id: null, classes: [], kv: {} };
}

/** Parse the inside of an attribute block (with or without the surrounding braces). */
export function parseAttrs(src: string): Attrs {
  let s = src.trim();
  if (s.startsWith("{") && s.endsWith("}")) s = s.slice(1, -1);
  const out = emptyAttrs();
  const re = /([#.][^\s"'=}]+)|([^\s=]+)=("((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+))|(-)(?=\s|$)|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m[1]) {
      if (m[1][0] === "#") out.id = m[1].slice(1);
      else out.classes.push(m[1].slice(1));
    } else if (m[2]) {
      out.kv[m[2]] = m[4] !== undefined ? m[4].replace(/\\(.)/g, "$1") : m[5] !== undefined ? m[5] : m[6];
    } else if (m[7]) {
      out.classes.push("unnumbered");
    } else if (m[8]) {
      // bare word, e.g. "{python}" engine names; treat as class
      out.classes.push(m[8]);
    }
  }
  return out;
}

/** Find a trailing `{...}` attribute block at the end of a line of text. */
export function splitTrailingAttrs(text: string): { text: string; attrs: Attrs | null; attrStart: number } {
  const m = /\s*(\{[^{}]*\})\s*$/.exec(text);
  if (!m) return { text, attrs: null, attrStart: -1 };
  return { text: text.slice(0, m.index), attrs: parseAttrs(m[1]), attrStart: m.index };
}
