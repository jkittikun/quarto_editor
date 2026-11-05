import { describe, it, expect } from "vitest";
import { buildGraph, parseGitLog, type LogCommit } from "../src/core/git";
import { renameChapter, fileTree, isRevealDoc } from "../src/core/project";
import { codeBody } from "../src/core/freeze";

const c = (hash: string, parents: string[] = []): LogCommit => ({ hash, parents, author: "a", date: "now", subject: hash, refs: [] });

describe("commit graph", () => {
  it("keeps a linear history in one lane", () => {
    const rows = buildGraph([c("c", ["b"]), c("b", ["a"]), c("a")]);
    expect(rows.map((r) => r.col)).toEqual([0, 0, 0]);
    expect(rows[0].top).toEqual([]); // branch tip: nothing above
    expect(rows[1].top).toEqual([[0, 0]]);
    expect(rows[2].bottom).toEqual([]); // root
  });
  it("draws a branch and merge in two lanes", () => {
    // m merges f (feature) into d; f and d both come from a
    const rows = buildGraph([c("m", ["d", "f"]), c("f", ["a"]), c("d", ["a"]), c("a")]);
    expect(rows[0].bottom).toEqual([[0, 0], [0, 1]]);
    expect(rows.find((r) => r.commit.hash === "f")!.col).toBe(1);
    expect(rows.find((r) => r.commit.hash === "d")!.col).toBe(0);
    const a = rows.find((r) => r.commit.hash === "a")!;
    expect(a.col).toBe(0);
    expect(a.top).toEqual([[0, 0]]);
    // the feature lane bends back into lane 0 right below d
    expect(rows.find((r) => r.commit.hash === "d")!.bottom).toEqual(expect.arrayContaining([[1, 0], [0, 0]]));
    expect(Math.max(...rows.map((r) => r.width))).toBe(2);
  });
  it("handles two unrelated roots", () => {
    const rows = buildGraph([c("x", []), c("y", [])]);
    expect(rows.map((r) => r.col)).toEqual([0, 0]);
  });
  it("parses git log records", () => {
    const out = "abc\x1fdef 123\x1fJane\x1f2 hours ago\x1fMerge it\x1fHEAD -> main, origin/main, tag: v1\n";
    expect(parseGitLog(out)[0]).toEqual({ hash: "abc", parents: ["def", "123"], author: "Jane", date: "2 hours ago", subject: "Merge it", refs: ["main", "origin/main", "tag: v1"] });
  });
});

describe("file helpers", () => {
  const yml = "book:\n  chapters:\n    - index.qmd\n    - intro.qmd  # first\n    - href: methods.qmd\n";
  it("renames a chapter entry keeping comments", () => {
    expect(renameChapter(yml, "intro.qmd", "start.qmd")).toBe(yml.replace("- intro.qmd  # first", "- start.qmd  # first"));
    expect(renameChapter(yml, "methods.qmd", "m.qmd")).toContain("- href: m.qmd");
    expect(renameChapter(yml, "tro.qmd", "x.qmd")).toBe(yml);
  });
  it("builds a folder tree, folders first", () => {
    const t = fileTree(["b.qmd", "parts/z.qmd", "a.qmd", "parts/deep/x.md", "notes/n.md"]);
    expect(t.files).toEqual(["a.qmd", "b.qmd"]);
    expect(t.dirs.map((d) => d.name)).toEqual(["notes", "parts"]);
    expect(t.dirs[1].dirs[0].files).toEqual(["parts/deep/x.md"]);
  });
  it("detects Reveal.js documents", () => {
    expect(isRevealDoc("---\nformat: revealjs\n---\n", [])).toBe(true);
    expect(isRevealDoc("---\nformat:\n  revealjs:\n    theme: dark\n---\n", [])).toBe(true);
    expect(isRevealDoc("---\nformat: html\n---\n", ["revealjs"])).toBe(false);
    expect(isRevealDoc("# x\n", ["revealjs"])).toBe(true);
  });
  it("strips cell option lines for copying", () => {
    expect(codeBody("#| label: fig-a\n#| echo: false\nimport x\nx()")).toBe("import x\nx()");
  });
});
