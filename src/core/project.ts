import { load } from "js-yaml";

export interface OutlineChapter {
  kind: "chapter";
  file: string; // relative to project root
  appendix: boolean;
}
export interface OutlinePart {
  kind: "part";
  title: string;
  file: string | null;
  chapters: OutlineChapter[];
}
export type OutlineItem = OutlineChapter | OutlinePart;

export interface ProjectInfo {
  type: "book" | "website" | "default" | "none";
  title: string | null;
  author: string | null;
  outline: OutlineItem[]; // book chapters in order (parts may contain chapters)
  appendices: OutlineChapter[];
  bibliography: string[]; // relative paths
  outputDir: string | null;
  config: Record<string, any>;
  error: string | null; // YAML parse error, if any
}

function asList(v: unknown): unknown[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function chapterFile(entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object" && typeof (entry as any).href === "string") return (entry as any).href;
  if (entry && typeof entry === "object" && typeof (entry as any).file === "string") return (entry as any).file;
  return null;
}

function parseChapterList(list: unknown, appendix: boolean): OutlineItem[] {
  const out: OutlineItem[] = [];
  for (const entry of asList(list)) {
    if (entry && typeof entry === "object" && "part" in (entry as any)) {
      const p = (entry as any).part;
      const isFile = typeof p === "string" && /\.(q?md|ipynb|Rmd)$/i.test(p);
      out.push({
        kind: "part",
        title: isFile ? p.replace(/\.[^.]+$/, "") : String(p),
        file: isFile ? p : null,
        chapters: parseChapterList((entry as any).chapters, appendix).filter(
          (c): c is OutlineChapter => c.kind === "chapter",
        ),
      });
      continue;
    }
    const f = chapterFile(entry);
    if (f) out.push({ kind: "chapter", file: f, appendix });
  }
  return out;
}

export function parseQuartoYml(src: string): ProjectInfo {
  let cfg: Record<string, any> = {};
  let error: string | null = null;
  try {
    cfg = (load(src) as Record<string, any>) ?? {};
    if (typeof cfg !== "object") cfg = {};
  } catch (e: any) {
    cfg = {};
    error = String(e?.message ?? e).split("\n")[0];
  }
  const project = cfg.project ?? {};
  const type = (project.type ?? "default") as ProjectInfo["type"];
  const book = cfg.book ?? {};
  const site = cfg.website ?? {};
  const bibliography = asList(cfg.bibliography ?? book.bibliography).map(String);
  const author = book.author ?? cfg.author ?? null;
  return {
    type: type === "book" || type === "website" ? type : "default",
    title: book.title ?? site.title ?? cfg.title ?? null,
    author: Array.isArray(author) ? author.map((a) => (typeof a === "string" ? a : a?.name)).join(", ") : author,
    outline: parseChapterList(book.chapters, false),
    appendices: parseChapterList(book.appendices, true).flatMap((i) =>
      i.kind === "part" ? i.chapters : [i],
    ),
    bibliography,
    outputDir: project["output-dir"] ?? null,
    config: cfg,
    error,
  };
}

/** Flatten the book into chapter files in reading order (parts' own files included). */
export function bookOrder(info: ProjectInfo): { file: string; appendix: boolean; isPart: boolean }[] {
  const out: { file: string; appendix: boolean; isPart: boolean }[] = [];
  for (const item of info.outline) {
    if (item.kind === "part") {
      if (item.file) out.push({ file: item.file, appendix: false, isPart: true });
      for (const c of item.chapters) out.push({ file: c.file, appendix: false, isPart: false });
    } else out.push({ file: item.file, appendix: false, isPart: false });
  }
  for (const a of info.appendices) out.push({ file: a.file, appendix: true, isPart: false });
  return out;
}

/** Split a document into its YAML front matter (if any) and body. */
export function splitFrontMatter(src: string): { yaml: string | null; meta: Record<string, any>; bodyOffset: number } {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(---|\.\.\.)[ \t]*(\r?\n|$)/.exec(src);
  if (!m) return { yaml: null, meta: {}, bodyOffset: 0 };
  let meta: Record<string, any> = {};
  try {
    meta = (load(m[1]) as Record<string, any>) ?? {};
  } catch {
    meta = {};
  }
  return { yaml: m[1], meta: typeof meta === "object" ? meta : {}, bodyOffset: m[0].length };
}

/**
 * Insert `newFile` into `book.chapters` of a _quarto.yml by editing the text (comments and
 * formatting are preserved). Inserts after the entry for `afterFile` when found, otherwise after
 * the last chapter entry. Returns the text unchanged when there is no `book.chapters` list.
 */
export function insertChapter(yml: string, afterFile: string | null, newFile: string): string {
  const lines = yml.split("\n");
  const itemRe = /^(\s*)-\s+(?:href:\s*)?["']?([^"'#\s]+)["']?\s*(#.*)?$/;
  // locate book: and its chapters: key
  let bookLine = -1;
  let bookIndent = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)book:\s*(#.*)?$/.exec(lines[i]);
    if (m) {
      bookLine = i;
      bookIndent = m[1].length;
      break;
    }
  }
  if (bookLine < 0) return yml;
  let chaptersLine = -1;
  let chaptersIndent = -1;
  for (let i = bookLine + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim() || /^\s*#/.test(l)) continue;
    const ind = l.length - l.trimStart().length;
    if (ind <= bookIndent) break;
    const m = /^(\s*)chapters:\s*(#.*)?$/.exec(l);
    if (m) {
      chaptersLine = i;
      chaptersIndent = m[1].length;
      break;
    }
  }
  if (chaptersLine < 0) return yml;
  // the chapters block: following lines indented deeper than `chapters:` (or "- " at same indent)
  let end = chaptersLine;
  let lastItem = -1;
  let lastItemIndent = chaptersIndent + 2;
  let afterIdx = -1;
  for (let i = chaptersLine + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim() || /^\s*#/.test(l)) continue;
    const ind = l.length - l.trimStart().length;
    if (ind < chaptersIndent || (ind === chaptersIndent && !l.trimStart().startsWith("-"))) break;
    end = i;
    const m = itemRe.exec(l);
    if (m && /\.(q?md|ipynb|Rmd)$/i.test(m[2])) {
      lastItem = i;
      lastItemIndent = m[1].length;
      if (afterFile && m[2] === afterFile) afterIdx = i;
    }
  }
  const at = afterIdx >= 0 ? afterIdx : lastItem >= 0 ? lastItem : end;
  const indent = " ".repeat(afterIdx >= 0 ? itemRe.exec(lines[afterIdx])![1].length : lastItemIndent);
  lines.splice(at + 1, 0, `${indent}- ${newFile}`);
  return lines.join("\n");
}
