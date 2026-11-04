import { describe, it, expect } from "vitest";
import { parseGitStatus, fileDiff, mergeGitignore, validVenvName, statusLetter } from "../src/core/git";

describe("git status parsing", () => {
  const out =
    "# branch.oid abc\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -1\0" +
    "1 .M N... 100644 100644 100644 aaa bbb chapters/intro.qmd\0" +
    "2 RM N... 100644 100644 100644 aaa aaa R100 new name.qmd\0old.qmd\0? notes.txt\0";
  it("reads branch, ahead/behind and files (incl. renames and spaces)", () => {
    const st = parseGitStatus(out);
    expect(st.branch).toBe("main");
    expect([st.ahead, st.behind]).toEqual([2, 1]);
    expect(st.hasCommits).toBe(true);
    expect(st.files.map((f) => [f.path, statusLetter(f)])).toEqual([
      ["chapters/intro.qmd", "M"],
      ["new name.qmd", "M"],
      ["notes.txt", "?"],
    ]);
    expect(st.files[1].orig).toBe("old.qmd");
  });
  it("detects a repository without commits", () => {
    expect(parseGitStatus("# branch.oid (initial)\0# branch.head main\0").hasCommits).toBe(false);
  });
});

describe("fileDiff", () => {
  it("returns hunks with line numbers in the current text", () => {
    const old = "a\nb\nc\nd\ne\nf\ng\nh\n";
    const cur = "a\nb\nc\nd\nE!\nf\ng\nh\nnew\n";
    const hunks = fileDiff(old, cur);
    expect(hunks).toHaveLength(1);
    const lines = hunks[0].lines;
    expect(lines.filter((l) => l.kind === "del").map((l) => l.text)).toEqual(["e"]);
    expect(lines.filter((l) => l.kind === "add").map((l) => [l.text, l.newLine])).toEqual([
      ["E!", 5],
      ["new", 9],
    ]);
  });
  it("is empty for identical text", () => {
    expect(fileDiff("x\n", "x\n")).toEqual([]);
  });
});

describe("gitignore and venv names", () => {
  it("adds only missing entries", () => {
    expect(mergeGitignore("_book/\nnode_modules\n", ["/_book/", ".folio/"])).toBe("_book/\nnode_modules\n.folio/\n");
    expect(mergeGitignore("", [".venv/"])).toBe(".venv/\n");
    expect(mergeGitignore(".venv/", [".venv/"])).toBe(".venv/");
  });
  it("accepts simple folder names only", () => {
    expect(validVenvName(".venv")).toBe(true);
    expect(validVenvName("env-3.12")).toBe(true);
    expect(validVenvName("../x")).toBe(false);
    expect(validVenvName("a/b")).toBe(false);
    expect(validVenvName("")).toBe(false);
  });
});
