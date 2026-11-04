export interface BibEntry {
  key: string;
  type: string;
  fields: Record<string, string>;
  authors: string[]; // family names
  year: string;
  title: string;
}

function cleanTex(s: string): string {
  return s
    .replace(/\\[`'^"~=.uvHtcdb]\{?(\w)\}?/g, "$1")
    .replace(/\\&/g, "&")
    .replace(/--/g, "–")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function familyName(name: string): string {
  const n = name.trim();
  if (n.includes(",")) return n.split(",")[0].trim();
  if (/^\{.*\}$/.test(n)) return n.slice(1, -1);
  const parts = n.split(/\s+/);
  return parts[parts.length - 1];
}

/** Minimal but robust BibTeX parser (handles nested braces and quoted values). */
export function parseBibtex(src: string): BibEntry[] {
  const out: BibEntry[] = [];
  let i = 0;
  while ((i = src.indexOf("@", i)) !== -1) {
    const head = /^@(\w+)\s*[{(]\s*([^,\s]+)\s*,/.exec(src.slice(i));
    if (!head) {
      i++;
      continue;
    }
    const type = head[1].toLowerCase();
    if (type === "comment" || type === "string" || type === "preamble") {
      i += head[0].length;
      continue;
    }
    let j = i + head[0].length;
    const fields: Record<string, string> = {};
    // parse fields until closing brace at depth 0
    while (j < src.length) {
      const fm = /^\s*([\w-]+)\s*=\s*/.exec(src.slice(j));
      if (!fm) break;
      j += fm[0].length;
      let value = "";
      if (src[j] === "{") {
        let depth = 0;
        const start = j;
        for (; j < src.length; j++) {
          if (src[j] === "{") depth++;
          else if (src[j] === "}") {
            depth--;
            if (depth === 0) break;
          }
        }
        value = src.slice(start + 1, j);
        j++;
      } else if (src[j] === '"') {
        const start = ++j;
        let depth = 0;
        for (; j < src.length; j++) {
          if (src[j] === "{") depth++;
          else if (src[j] === "}") depth--;
          else if (src[j] === '"' && depth === 0) break;
        }
        value = src.slice(start, j);
        j++;
      } else {
        const vm = /^[^,}\s]+/.exec(src.slice(j));
        value = vm ? vm[0] : "";
        j += value.length;
      }
      fields[fm[1].toLowerCase()] = value;
      const sep = /^\s*,?/.exec(src.slice(j));
      j += sep ? sep[0].length : 0;
      if (/^\s*[})]/.test(src.slice(j))) break;
    }
    const authorField = fields.author ?? fields.editor ?? "";
    const authors = authorField
      ? authorField.split(/\s+and\s+/i).map((a) => cleanTex(familyName(a)))
      : [];
    out.push({
      key: head[2],
      type,
      fields,
      authors,
      year: cleanTex(fields.year ?? (fields.date ?? "").slice(0, 4) ?? "n.d.") || "n.d.",
      title: cleanTex(fields.title ?? ""),
    });
    i = j;
  }
  return out;
}

export function authorList(e: BibEntry): string {
  const a = e.authors;
  if (a.length === 0) return e.title || e.key;
  if (a.length === 1) return a[0];
  if (a.length === 2) return `${a[0]} and ${a[1]}`;
  if (a.length === 3) return `${a[0]}, ${a[1]}, and ${a[2]}`;
  return `${a[0]} et al.`;
}

/** Author-date citation in the style of Quarto's default (Chicago author-date). */
export function formatCitation(entries: (BibEntry | string)[], opts: { narrative?: boolean; suppressAuthor?: boolean; locators?: string[] } = {}): string {
  const parts = entries.map((e, i) => {
    const loc = opts.locators?.[i] ? `, ${opts.locators[i]}` : "";
    if (typeof e === "string") return `${e}?${loc}`;
    if (opts.suppressAuthor) return `${e.year}${loc}`;
    if (opts.narrative) return `${authorList(e)} (${e.year}${loc})`;
    return `${authorList(e)} ${e.year}${loc}`;
  });
  if (opts.narrative) return parts.join("; ");
  return `(${parts.join("; ")})`;
}

export function formatReference(e: BibEntry): string {
  const f = e.fields;
  const names = (f.author ?? f.editor ?? "")
    .split(/\s+and\s+/i)
    .filter(Boolean)
    .map((n) => cleanTex(n));
  const who = names.length > 1 ? names.slice(0, -1).join(", ") + ", and " + names[names.length - 1] : names[0] ?? "";
  const container = cleanTex(f.journal ?? f.booktitle ?? f.publisher ?? "");
  const extra = [f.volume && cleanTex(f.volume) + (f.number ? ` (${cleanTex(f.number)})` : ""), f.pages && cleanTex(f.pages)]
    .filter(Boolean)
    .join(": ");
  return [who && (who.endsWith(".") ? who : `${who}.`), `${e.year}.`, e.title && `“${e.title}.”`, container && `${container}${extra ? " " + extra : ""}.`]
    .filter(Boolean)
    .join(" ");
}
