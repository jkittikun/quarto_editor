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
  try {
    cfg = (load(src) as Record<string, any>) ?? {};
  } catch {
    cfg = {};
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
