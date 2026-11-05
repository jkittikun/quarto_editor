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

/**
 * Remove the `book.chapters` / `book.appendices` entry for `file` from a _quarto.yml, editing
 * the text so comments and formatting are kept. Only plain `- file` / `- href: file` lines are
 * removed; returns the text unchanged when there is no such line.
 */
export function removeChapter(yml: string, file: string): string {
  const lines = yml.split("\n");
  const esc = file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^\\s*-\\s+(?:href:\\s*)?["']?${esc}["']?\\s*(#.*)?$`);
  const idx = lines.findIndex((l) => re.test(l));
  if (idx < 0) return yml;
  lines.splice(idx, 1);
  return lines.join("\n");
}

/** True when `file` is listed as a chapter or appendix in the book outline. */
export function isInBook(info: ProjectInfo | null, file: string): boolean {
  return !!info && bookOrder(info).some((c) => c.file === file);
}

/**
 * Rename a chapter entry in _quarto.yml by editing the text (comments kept). Only plain
 * `- old` / `- href: old` list items are rewritten; returns the text unchanged otherwise.
 */
export function renameChapter(yml: string, oldFile: string, newFile: string): string {
  const esc = oldFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^(\\s*-\\s+(?:href:\\s*)?)(["']?)${esc}\\2(\\s*(#.*)?)$`, "m");
  return yml.replace(re, (_m, pre: string, q: string, post: string) => `${pre}${q}${newFile}${q}${post}`);
}

export interface TreeNode {
  name: string;
  path: string; // relative path ('' for root)
  dirs: TreeNode[];
  files: string[]; // relative paths
}

/** Build a folder tree (folders first, then files, both alphabetical) from relative paths. */
export function fileTree(paths: string[]): TreeNode {
  const root: TreeNode = { name: "", path: "", dirs: [], files: [] };
  for (const p of paths) {
    const parts = p.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const dirPath = parts.slice(0, i + 1).join("/");
      let next = node.dirs.find((d) => d.path === dirPath);
      if (!next) {
        next = { name: parts[i], path: dirPath, dirs: [], files: [] };
        node.dirs.push(next);
      }
      node = next;
    }
    node.files.push(p);
  }
  const sort = (n: TreeNode) => {
    n.dirs.sort((a, b) => a.name.localeCompare(b.name));
    n.files.sort((a, b) => a.split("/").pop()!.localeCompare(b.split("/").pop()!));
    n.dirs.forEach(sort);
  };
  sort(root);
  return root;
}

/** True when a document is a Reveal.js presentation (front matter or project-level format). */
export function isRevealDoc(src: string, projectFormats: string[]): boolean {
  const head = src.slice(0, 4000);
  const fm = head.startsWith("---") ? splitFrontMatter(head).meta : {};
  const fmt = fm.format;
  const names = typeof fmt === "string" ? [fmt] : fmt && typeof fmt === "object" ? Object.keys(fmt) : [];
  if (names.length) return names.some((n) => n.startsWith("revealjs"));
  return projectFormats.some((n) => n.startsWith("revealjs"));
}
