/** Pure helpers for the source-control panel: status parsing, diffs, .gitignore merging. */
import { structuredPatch } from "diff";

export interface GitFile {
  path: string;
  index: string; // staged status letter ("." = unchanged)
  worktree: string; // working-tree status letter
  orig?: string; // original path for renames
}

export interface GitStatus {
  installed: boolean;
  isRepo: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  remote: string | null;
  hasCommits: boolean;
  files: GitFile[];
}

export const NO_REPO: GitStatus = {
  installed: true,
  isRepo: false,
  branch: null,
  upstream: null,
  ahead: 0,
  behind: 0,
  remote: null,
  hasCommits: false,
  files: [],
};

/** Parse `git status --porcelain=v2 --branch -z` output. */
export function parseGitStatus(out: string): Omit<GitStatus, "installed" | "isRepo" | "remote"> {
  const st = { branch: null as string | null, upstream: null as string | null, ahead: 0, behind: 0, hasCommits: true, files: [] as GitFile[] };
  const recs = out.split("\0");
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    if (!r) continue;
    if (r.startsWith("# branch.oid ")) st.hasCommits = r.slice(13) !== "(initial)";
    else if (r.startsWith("# branch.head ")) st.branch = r.slice(14) === "(detached)" ? "detached" : r.slice(14);
    else if (r.startsWith("# branch.upstream ")) st.upstream = r.slice(18);
    else if (r.startsWith("# branch.ab ")) {
      const m = /\+(\d+) -(\d+)/.exec(r);
      if (m) {
        st.ahead = +m[1];
        st.behind = +m[2];
      }
    } else if (r.startsWith("1 ")) {
      // 1 XY sub mH mI mW hH hI path
      const parts = r.split(" ");
      st.files.push({ index: parts[1][0], worktree: parts[1][1], path: parts.slice(8).join(" ") });
    } else if (r.startsWith("2 ")) {
      // 2 XY sub mH mI mW hH hI Xscore path \0 origPath
      const parts = r.split(" ");
      st.files.push({ index: parts[1][0], worktree: parts[1][1], path: parts.slice(9).join(" "), orig: recs[++i] });
    } else if (r.startsWith("u ")) {
      const parts = r.split(" ");
      st.files.push({ index: "U", worktree: "U", path: parts.slice(10).join(" ") });
    } else if (r.startsWith("? ")) {
      st.files.push({ index: "?", worktree: "?", path: r.slice(2) });
    }
  }
  return st;
}

/** One-letter label for the panel: M, A, D, R, U or ? (untracked). */
export function statusLetter(f: GitFile): string {
  if (f.index === "?") return "?";
  if (f.index === "U" || f.worktree === "U") return "U";
  for (const c of [f.worktree, f.index]) if (c && c !== ".") return c === "T" ? "M" : c;
  return "M";
}

export interface DiffLine {
  kind: "add" | "del" | "ctx";
  text: string;
  oldLine: number | null;
  newLine: number | null;
}
export interface DiffHunk {
  newStart: number; // 1-based line in the current text
  oldStart: number;
  lines: DiffLine[];
}

/** Unified-diff hunks between the committed and current text (3 lines of context). */
export function fileDiff(oldText: string, newText: string): DiffHunk[] {
  const patch = structuredPatch("a", "b", oldText, newText, "", "", { context: 3 });
  return patch.hunks.map((h) => {
    let o = h.oldStart;
    let n = h.newStart;
    const lines: DiffLine[] = [];
    for (const l of h.lines) {
      if (l.startsWith("\\")) continue; // "\ No newline at end of file"
      const kind = l[0] === "+" ? "add" : l[0] === "-" ? "del" : "ctx";
      lines.push({ kind, text: l.slice(1), oldLine: kind === "add" ? null : o, newLine: kind === "del" ? null : n });
      if (kind !== "add") o++;
      if (kind !== "del") n++;
    }
    return { newStart: h.newStart, oldStart: h.oldStart, lines };
  });
}

export const DEFAULT_GITIGNORE = ["/.quarto/", "/_book/", "/_site/", "/_freeze/", ".folio/", "*_files/", ".venv/"];

/** Append missing entries to a .gitignore without duplicating or reordering existing lines. */
export function mergeGitignore(existing: string, entries: string[]): string {
  const have = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
  const missing = entries.filter((e) => !have.has(e) && !have.has(e.replace(/^\//, "")));
  if (!missing.length) return existing;
  const base = existing && !existing.endsWith("\n") ? existing + "\n" : existing;
  return base + missing.join("\n") + "\n";
}

/** A virtual-environment folder name: one path segment, no traversal. */
export function validVenvName(name: string): boolean {
  return /^[\w.-]+$/.test(name) && name !== "." && name !== "..";
}
