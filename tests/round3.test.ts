import { describe, it, expect } from "vitest";
import { removeChapter, insertChapter, parseQuartoYml, bookOrder } from "../src/core/project";
import { pythonCandidates, parseProbe, defaultPython } from "../src/core/python";

const yml = `book:
  title: "T"
  chapters:
    - index.qmd   # preface
    - part: "Part one"
      chapters:
        - intro.qmd
        - href: methods.qmd
    - summary.qmd
  appendices:
    - extra.qmd
`;

describe("removeChapter", () => {
  it("removes exactly one plain entry and keeps comments", () => {
    const out = removeChapter(yml, "intro.qmd");
    expect(out).toBe(yml.replace("        - intro.qmd\n", ""));
    expect(bookOrder(parseQuartoYml(out)).map((c) => c.file)).toEqual(["index.qmd", "methods.qmd", "summary.qmd", "extra.qmd"]);
  });
  it("handles href entries, appendices and commented lines", () => {
    expect(removeChapter(yml, "methods.qmd")).not.toContain("methods.qmd");
    expect(removeChapter(yml, "extra.qmd")).not.toContain("extra.qmd");
    expect(removeChapter(yml, "index.qmd")).not.toContain("index.qmd");
  });
  it("does not touch files that are not listed, or partial name matches", () => {
    expect(removeChapter(yml, "missing.qmd")).toBe(yml);
    expect(removeChapter(yml, "tro.qmd")).toBe(yml);
  });
  it("round-trips with insertChapter", () => {
    expect(removeChapter(insertChapter(yml, "intro.qmd", "new.qmd"), "new.qmd")).toBe(yml);
  });
});

describe("pythonCandidates", () => {
  const files = new Set([
    "/p/.venv/bin/python",
    "/p/tools/pyvenv.cfg",
    "/p/tools/bin/python",
    "/h/miniconda3/bin/python",
    "/h/miniconda3/envs/sci/bin/python",
    "/h/.pyenv/versions/3.11.9/bin/python",
    "/usr/bin/python3",
    "/opt/conda-elsewhere/bin/python",
  ]);
  const dirs: Record<string, string[]> = {
    "/p": [".venv", "tools", "chapters"],
    "/h/miniconda3/envs": ["sci"],
    "/h/.pyenv/versions": ["3.11.9"],
  };
  const c = pythonCandidates({
    root: "/p",
    home: "/h",
    env: { QUARTO_PYTHON: "/custom/python" },
    list: (d) => dirs[d] ?? [],
    exists: (p) => files.has(p),
    condaEnvs: ["/opt/conda-elsewhere", ""],
  });
  it("orders project venvs first, then configured, conda, pyenv, system", () => {
    expect(c.map((x) => `${x.source}:${x.label}`)).toEqual([
      "project:.venv",
      "project:tools",
      "env:QUARTO_PYTHON",
      "conda:conda: conda-elsewhere",
      "conda:conda: base",
      "conda:conda: sci",
      "pyenv:pyenv 3.11.9",
      "system:python3 on PATH",
      "system:system",
    ]);
  });
  it("parses probe output", () => {
    expect(parseProbe("3.12.3 True\n")).toEqual({ version: "3.12.3", ready: true });
    expect(parseProbe("3.9.1 False")).toEqual({ version: "3.9.1", ready: false });
    expect(parseProbe("Traceback")).toBeNull();
  });
});

describe("defaultPython", () => {
  const sys = (path: string, ready: boolean) => ({ path, label: "system", source: "system", version: "3.12.0", ready });
  const venv = { path: "/p/.venv/bin/python", label: ".venv", source: "project", version: "3.11.0", ready: false };
  it("prefers a project venv even if it lacks ipykernel", () => {
    expect(defaultPython([sys("/usr/bin/python3", true), venv], null)).toBe(venv);
  });
  it("otherwise picks the first interpreter that can run cells", () => {
    const ready = sys("/opt/homebrew/bin/python3", true);
    expect(defaultPython([sys("/usr/bin/python3", false), ready], null)).toBe(ready);
  });
  it("falls back to the first one found", () => {
    const first = sys("/usr/bin/python3", false);
    expect(defaultPython([first, sys("python3", false)], null)).toBe(first);
    expect(defaultPython([], null)).toBeNull();
  });
  it("always honours an explicit choice, even one not detected", () => {
    const a = sys("/a/python", false);
    expect(defaultPython([venv, a], "/a/python")).toBe(a);
    expect(defaultPython([venv], "/custom/python")).toMatchObject({ path: "/custom/python", source: "custom" });
  });
});
