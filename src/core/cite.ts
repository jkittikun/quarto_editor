/** Parsing of Pandoc citation syntax and @-references. */

export interface CiteItem {
  key: string;
  suppressAuthor: boolean;
  prefix: string;
  locator: string;
}

/** Parse the inside of a bracketed citation, e.g. `see @a, p. 3; -@b`. Returns null if not a citation. */
export function parseBracketCitation(inner: string): CiteItem[] | null {
  const items: CiteItem[] = [];
  for (const raw of inner.split(";")) {
    const m = /^\s*(.*?)(-?)@([\w:.#$%&\-+?<>~/]*\w)(.*)$/s.exec(raw);
    if (!m) return null;
    items.push({
      prefix: m[1].trim(),
      suppressAuthor: m[2] === "-",
      key: m[3],
      locator: m[4].replace(/^\s*,?\s*/, "").trim(),
    });
  }
  return items.length ? items : null;
}

/** Regex for a bare `@key` reference (narrative citation or cross-ref). */
export const AT_REF = /(?<![\w@])(-?)@([A-Za-z0-9_][\w:.#$%&\-+?<>~/]*[A-Za-z0-9_])/g;
