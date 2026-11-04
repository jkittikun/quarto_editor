import { parseAttrs } from "./attrs";
import { splitFrontMatter } from "./project";

export const XREF_TYPES: Record<string, string> = {
  fig: "Figure",
  tbl: "Table",
  eq: "Equation",
  sec: "Section",
  thm: "Theorem",
  lem: "Lemma",
  cor: "Corollary",
  prp: "Proposition",
  cnj: "Conjecture",
  def: "Definition",
  exm: "Example",
  exr: "Exercise",
  lst: "Listing",
  rem: "Remark",
  sol: "Solution",
};

export function isXrefLabel(label: string): boolean {
  const i = label.indexOf("-");
  return i > 0 && label.slice(0, i) in XREF_TYPES;
}

export interface XrefTarget {
  label: string;
  type: string;
  number: string; // "2.1", "A.3", "1"
  display: string; // "Figure 2.1"
  caption: string | null;
  file: string;
  line: number; // 0-based line within file
}

export interface ChapterInfo {
  file: string;
  title: string | null;
  label: string | null;
  unnumbered: boolean;
  number: string | null; // "2", "A", or null
}

export interface DocInput {
  file: string;
  src: string;
  appendix?: boolean;
  isPart?: boolean;
}

const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/;

/** Strip a trailing attribute block from heading text. */
function headingParts(text: string): { title: string; attrs: ReturnType<typeof parseAttrs> | null } {
  const m = /\s*\{([^{}]*)\}\s*$/.exec(text);
  if (!m) return { title: text.trim(), attrs: null };
  return { title: text.slice(0, m.index).trim(), attrs: parseAttrs(m[1]) };
}

/** Determine chapter-level information for a document (title, unnumbered, label). */
export function chapterHeader(src: string, file: string): Omit<ChapterInfo, "number"> {
  const fm = splitFrontMatter(src);
  const lines = src.slice(fm.bodyOffset).split(/\r?\n/);
  let inFence: string | null = null;
  let title: string | null = typeof fm.meta.title === "string" ? fm.meta.title : null;
  let label: string | null = null;
  let unnumbered = false;
  const fmClasses = fm.meta.number?.toString?.() === "false";
  if (fmClasses) unnumbered = true;
  for (const line of lines) {
    const f = FENCE.exec(line);
    if (f) {
      if (!inFence) inFence = f[2];
      else if (f[2].startsWith(inFence[0]) && f[2].length >= inFence.length && !f[3].trim()) inFence = null;
      continue;
    }
    if (inFence) continue;
    const h = HEADING.exec(line);
    if (h && h[1].length === 1) {
      const p = headingParts(h[2]);
      if (!title) title = p.title;
      if (p.attrs) {
        label = p.attrs.id;
        if (p.attrs.classes.includes("unnumbered") || p.attrs.classes.includes("unlisted")) unnumbered = true;
      }
      break;
    }
  }
  return { file, title, label, unnumbered };
}

function toLetter(n: number): string {
  let s = "";
  n += 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Scan a single document for cross-reference targets. */
export interface HeadingNumber {
  line: number;
  level: number;
  number: string; // "" when unnumbered
}

export function scanTargets(
  src: string,
  file: string,
  chapter: string | null,
  headingsOut?: HeadingNumber[],
): XrefTarget[] {
  const out: XrefTarget[] = [];
  const counters: Record<string, number> = {};
  const secCounters = [0, 0, 0, 0, 0, 0];
  const lines = src.split(/\r?\n/);
  const fm = splitFrontMatter(src);
  const fmLines = fm.bodyOffset ? src.slice(0, fm.bodyOffset).split(/\r?\n/).length - 1 : 0;

  const add = (label: string, line: number, caption: string | null, explicitNumber?: string) => {
    const type = label.slice(0, label.indexOf("-"));
    if (!(type in XREF_TYPES)) return;
    let number = explicitNumber;
    if (number === undefined) {
      counters[type] = (counters[type] ?? 0) + 1;
      number = chapter ? `${chapter}.${counters[type]}` : String(counters[type]);
    }
    const name = XREF_TYPES[type];
    out.push({ label, type, number, display: `${name} ${number}`, caption, file, line });
  };

  let fence: { marker: string; cell: boolean; opts: Record<string, string>; start: number } | null = null;
  const divStack: boolean[] = [];
  for (let i = fmLines; i < lines.length; i++) {
    const line = lines[i];
    const f = FENCE.exec(line);
    if (fence) {
      if (f && f[2][0] === fence.marker[0] && f[2].length >= fence.marker.length && !f[3].trim()) {
        if (fence.cell && fence.opts.label) {
          const t = fence.opts.label.split("-")[0];
          const cap = fence.opts[`${t}-cap`] ?? null;
          add(fence.opts.label, fence.start, cap);
        }
        fence = null;
        continue;
      }
      if (fence.cell) {
        const o = /^\s*#\|\s*([\w-]+)\s*:\s*(.*?)\s*$/.exec(line);
        if (o) fence.opts[o[1]] = o[2].replace(/^["'](.*)["']$/, "$1");
      }
      continue;
    }
    if (f) {
      fence = { marker: f[2], cell: /^\s*\{/.test(f[3]), opts: {}, start: i };
      continue;
    }

    // Track fenced divs: headings inside callouts, tabsets and theorem-like divs are titles, not sections
    const divLine = /^\s*:{3,}\s*(.*?)\s*$/.exec(line);
    if (divLine) {
      const rest = divLine[1].replace(/:+$/, "").trim();
      if (!rest) divStack.pop();
      else {
        const a = rest.startsWith("{") ? parseAttrs(rest) : { id: null, classes: [rest], kv: {} };
        const idType = a.id ? a.id.split("-")[0] : "";
        divStack.push(a.classes.some((c) => /^callout|^panel-tabset$/.test(c)) || (idType in XREF_TYPES && idType !== "sec"));
      }
    }

    const h = HEADING.exec(line);
    if (h && divStack.some(Boolean)) continue;
    if (h) {
      const level = h[1].length;
      const p = headingParts(h[2]);
      const unnumbered = !!p.attrs && (p.attrs.classes.includes("unnumbered"));
      let number = "";
      if (level === 1) {
        number = chapter ?? "";
      } else if (!unnumbered) {
        secCounters[level - 1]++;
        for (let k = level; k < 6; k++) secCounters[k] = 0;
        const parts = secCounters.slice(1, level).map((n) => String(n));
        number = (chapter ? [chapter, ...parts] : parts).join(".");
      }
      if (headingsOut) headingsOut.push({ line: i, level, number: chapter ? number : "" });
      if (p.attrs?.id && p.attrs.id.startsWith("sec-")) {
        const isChapter = level === 1 && !!chapter;
        out.push({
          label: p.attrs.id,
          type: "sec",
          number,
          display: isChapter ? (/^[A-Z]+$/.test(chapter!) ? `Appendix ${number}` : `Chapter ${number}`) : `Section ${number}`,
          caption: p.title,
          file,
          line: i,
        });
      }
      continue;
    }

    // Images / figures with attributes: ![cap](src){#fig-x}
    const imgRe = /!\[((?:[^\]\\]|\\.)*)\]\([^)]*\)\{([^{}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = imgRe.exec(line))) {
      const a = parseAttrs(m[2]);
      if (a.id) add(a.id, i, m[1] || null);
    }
    // Fenced divs: ::: {#fig-x} / {#thm-x}
    const div = /^\s*:{3,}\s*\{([^{}]*)\}/.exec(line);
    if (div) {
      const a = parseAttrs(div[1]);
      if (a.id) {
        // caption/title: next "## Title" heading line inside theorem-type divs
        let cap: string | null = a.kv.title ?? a.kv.name ?? null;
        const next = lines[i + 1] ?? "";
        const nh = /^#{2,6}\s+(.*)$/.exec(next);
        if (!cap && nh) cap = nh[1].trim();
        add(a.id, i, cap);
      }
    }
    // Display math label: $$ ... $$ {#eq-x}
    const eqRe = /\$\$\s*\{([^{}]*#eq-[^{}]*)\}/g;
    while ((m = eqRe.exec(line))) {
      const a = parseAttrs(m[1]);
      if (a.id) add(a.id, i, null);
    }
    // Table caption: ": caption {#tbl-x}"
    const tc = /^:\s+(.*?)\s*\{([^{}]*#tbl-[^{}]*)\}\s*$/.exec(line);
    if (tc) {
      const a = parseAttrs(tc[2]);
      if (a.id) add(a.id, i, tc[1]);
    }
  }
  return out;
}

export interface XrefIndex {
  targets: Map<string, XrefTarget>;
  chapters: Map<string, ChapterInfo>;
}

/** Build a project-wide cross-reference index. `docs` must be in book order. */
export function buildIndex(docs: DocInput[], book: boolean): XrefIndex {
  const targets = new Map<string, XrefTarget>();
  const chapters = new Map<string, ChapterInfo>();
  let chapterN = 0;
  let appendixN = 0;
  for (const d of docs) {
    const head = chapterHeader(d.src, d.file);
    let number: string | null = null;
    if (book && !head.unnumbered && !d.isPart) {
      number = d.appendix ? toLetter(appendixN++) : String(++chapterN);
    }
    chapters.set(d.file, { ...head, number });
    for (const t of scanTargets(d.src, d.file, number)) {
      if (!targets.has(t.label)) targets.set(t.label, t);
    }
  }
  return { targets, chapters };
}
