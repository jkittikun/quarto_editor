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

// ---- history graph ----------------------------------------------------------------------------

export interface LogCommit {
  hash: string;
  parents: string[];
  author: string;
  date: string;
  subject: string;
  refs: string[];
}

/** Parse `git log --format=%H%x1f%P%x1f%an%x1f%ar%x1f%s%x1f%D` output (one commit per line). */
export function parseGitLog(out: string): LogCommit[] {
  return out
    .split("\n")
    .filter((l) => l.includes("\x1f"))
    .map((l) => {
      const [hash, parents, author, date, subject, refs] = l.split("\x1f");
      return {
        hash,
        parents: parents ? parents.split(" ").filter(Boolean) : [],
        author,
        date,
        subject,
        refs: refs ? refs.split(", ").map((r) => r.replace(/^HEAD -> /, "")).filter((r) => r && r !== "HEAD") : [],
      };
    });
}

export interface GraphRow {
  commit: LogCommit;
  col: number; // lane of the commit dot
  /** Lanes entering from above: [fromLane, toLane] (toLane = col when converging on this commit). */
  top: [number, number][];
  /** Lanes leaving below: [fromLane, toLane] (fromLane = col for edges to parents). */
  bottom: [number, number][];
  width: number; // number of lanes in use for this row
}

/** Assign lanes for a commit graph in topological order (newest first), like `git log --graph`. */
export function buildGraph(commits: LogCommit[]): GraphRow[] {
  const lanes: (string | null)[] = [];
  const rows: GraphRow[] = [];
  const free = () => {
    const i = lanes.indexOf(null);
    return i >= 0 ? i : lanes.push(null) - 1;
  };
  for (const c of commits) {
    let col = lanes.indexOf(c.hash);
    const isNew = col < 0; // no child above points to this commit (a branch tip)
    if (isNew) {
      col = free();
      lanes[col] = c.hash;
    }
    const top: [number, number][] = [];
    lanes.forEach((h, i) => {
      if (h === null) return;
      // a lane that was waiting for this commit converges into its dot (only if it existed above)
      if (h === c.hash) {
        if (!(isNew && i === col)) top.push([i, col]);
      } else top.push([i, i]);
    });
    // lanes expecting this commit are now consumed
    lanes.forEach((h, i) => {
      if (h === c.hash) lanes[i] = null;
    });
    const bottom: [number, number][] = [];
    c.parents.forEach((p, k) => {
      let j = lanes.indexOf(p);
      if (j > col && k === 0 && lanes[col] === null) {
        // first parent already expected further right: pull that line into this lane
        lanes[j] = null;
        lanes[col] = p;
        bottom.push([j, col]);
        j = col;
      } else if (j < 0) {
        j = k === 0 && lanes[col] === null ? col : free();
        lanes[j] = p;
      }
      bottom.push([col, j]);
    });
    lanes.forEach((h, i) => {
      if (h !== null && !bottom.some(([from, to]) => to === i || from === i)) bottom.push([i, i]);
    });
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    const width = Math.max(col + 1, ...top.map(([a, b]) => Math.max(a, b) + 1), ...bottom.map(([a, b]) => Math.max(a, b) + 1));
    rows.push({ commit: c, col, top, bottom, width });
  }
  return rows;
}
