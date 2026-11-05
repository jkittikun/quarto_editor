#!/usr/bin/env node
/**
 * End-to-end test of the browser build against a scratch copy of examples/book.
 *
 *   npm run e2e
 *
 * Checks:
 *  1. Round-trip: editing in rendered mode changes only the typed bytes on disk.
 *  2. Python kernel: running a cell shows a plot and writes the output cache (skip: E2E_SKIP_KERNEL=1).
 *  3. New chapter: the modal creates the file and adds exactly one line to _quarto.yml.
 *  4. Empty folder: choosing "Book" creates a project.
 *  5. Render: `quarto render` produces HTML (only when quarto is on PATH).
 * Set E2E_SHOTS=<dir> to save screenshots.
 */
import { spawn, execSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = 1430 + Math.floor(Math.random() * 50);
const SHOTS = process.env.E2E_SHOTS;
const work = mkdtempSync(join(tmpdir(), "folio-e2e-"));
const book = join(work, "book");
const empty = join(work, "empty");
cpSync(join(ROOT, "examples/book"), book, { recursive: true, filter: (s) => !s.includes(".folio") && !s.includes("_book") && !s.includes("_freeze") });
mkdirSync(empty);
const single = join(work, "single");
mkdirSync(single);
writeFileSync(join(single, "notes.qmd"), "# Notes\n\nOnly file.\n");
const bare = join(work, "remote.git");
const gitConfig = join(work, "gitconfig");
writeFileSync(gitConfig, "[user]\n  name = Folio Test\n  email = test@example.com\n[init]\n  defaultBranch = main\n");
execSync(`git init -q --bare "${bare}"`);

let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeout = 15000, step = 200) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      if (await fn()) return true;
    } catch {}
    await sleep(step);
  }
  return false;
}
const FAKE_QUARTO = !!process.env.E2E_FAKE_QUARTO;
const hasQuarto = FAKE_QUARTO || (() => {
  try {
    execSync("quarto --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const vite = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], {
  cwd: ROOT,
  env: { ...process.env, FOLIO_ROOT: book, GIT_CONFIG_GLOBAL: gitConfig, ...(FAKE_QUARTO ? { QUARTO_PATH: join(ROOT, "tests/e2e/fake-quarto.sh") } : {}) },
  stdio: ["ignore", "pipe", "pipe"],
});
let viteOut = "";
vite.stdout.on("data", (d) => (viteOut += d));
vite.stderr.on("data", (d) => (viteOut += d));

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const shot = async (name) => SHOTS && page.screenshot({ path: join(SHOTS, `${name}.png`) });

try {
  ok(await waitFor(() => viteOut.includes("ready"), 30000), "dev server started");
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  ok(await waitFor(() => page.evaluate(() => !!window.folio?.current)), "app opened the book");

  // ---------------------------------------------------------------- 1. round-trip
  const introPath = join(book, "intro.qmd");
  const original = readFileSync(introPath, "utf8");
  await page.evaluate(() => folio.openFile(folio.abs("intro.qmd")));
  await sleep(500);

  const typeAtEndOf = async (text, typed) => {
    await page.locator(".cm-line", { hasText: text }).first().click();
    await page.keyboard.press("End");
    await page.keyboard.type(typed);
  };
  await typeAtEndOf("renders instantly", " ALPHA");
  await typeAtEndOf("This book shows what", " BETA");
  // tabset: switch to the R tab and type there
  await page.locator(".cm-content").first().click({ position: { x: 5, y: 5 } });
  await page.evaluate(() => folio.view.contentDOM.blur());
  await page.locator(".cm-tab", { hasText: "R" }).dispatchEvent("mousedown");
  await sleep(200);
  await typeAtEndOf("Some R notes.", " GAMMA");
  // collapsible callout: starts collapsed; expand it and type in the body
  await page.evaluate(() => folio.view.contentDOM.blur());
  await sleep(150);
  ok(!(await page.locator(".cm-content").first().innerText()).includes("Callouts can be collapsible."), "collapse=true callout starts collapsed");
  await page.locator(".cm-callout-toggle").first().dispatchEvent("mousedown");
  await sleep(200);
  ok((await page.locator(".cm-content").first().innerText()).includes("Callouts can be collapsible."), "callout expands on toggle");
  await typeAtEndOf("Callouts can be collapsible.", " DELTA");
  // raw source view on and off
  await page.click("#view-switch [data-mode=source]");
  await sleep(150);
  ok((await page.locator(".cm-content").first().innerText()).includes("::: {.callout-note}"), "raw view shows the source");
  await shot("raw-view");
  await page.click("#view-switch [data-mode=edit]");
  // font size
  await page.click("#font-inc");
  await page.click("#font-inc");
  ok((await page.locator("#font-size").innerText()) === "18", "A+ increases the font size");
  await page.click("#font-dec");
  // switch away and back (flushes the save)
  await page.evaluate(() => folio.openFile(folio.abs("methods.qmd")));
  await page.evaluate(() => folio.openFile(folio.abs("intro.qmd")));
  await sleep(1000);
  const expected = original
    .replace("and so does display math:", "and so does display math: ALPHA")
    .replace("can render live. See @knuth84 for literate", "can render live. See @knuth84 for literate BETA")
    .replace("Some R notes.", "Some R notes. GAMMA")
    .replace("Callouts can be collapsible.", "Callouts can be collapsible. DELTA");
  const actual = readFileSync(introPath, "utf8");
  ok(actual === expected, "round-trip: file on disk = original + exactly the typed text");
  if (actual !== expected) {
    console.log("--- expected\n" + expected + "\n--- actual\n" + actual);
  }

  // ---------------------------------------------------------------- 1b. external edits
  writeFileSync(introPath, readFileSync(introPath, "utf8") + "\nAn EXTERNAL edit.\n");
  ok(await waitFor(() => page.locator(".cm-content").first().innerText().then((t) => t.includes("An EXTERNAL edit."))), "edits made outside Folio appear in the open chapter");
  mkdirSync(join(book, "parts/deep"), { recursive: true });
  await sleep(300);
  writeFileSync(join(book, "parts/deep/new.qmd"), "# Deep\n");
  ok(await waitFor(() => page.evaluate(() => folio.files.includes("parts/deep/new.qmd"))), "files created in new subfolders are picked up");

  // ---------------------------------------------------------------- 2. kernel
  if (!process.env.E2E_SKIP_KERNEL) {
    await page.evaluate(() => folio.openFile(folio.abs("methods.qmd")));
    await sleep(500);
    await page.locator(".cm-cell-head", { hasText: "fig-sine" }).locator(".cm-cell-run").dispatchEvent("mousedown");
    ok(await waitFor(() => page.locator(".cm-out-img").count().then((n) => n > 0), 60000), "running a cell shows its plot");
    ok(await waitFor(() => existsSync(join(book, ".folio/cache/methods.qmd.json")), 5000), "outputs are cached in .folio/cache");
    await shot("kernel");
  }

  // ---------------------------------------------------------------- 3. new chapter
  await page.evaluate(() => folio.openFile(folio.abs("methods.qmd")));
  const ymlBefore = readFileSync(join(book, "_quarto.yml"), "utf8");
  await page.click("#new-file");
  await page.fill(".modal input[name=title]", "Fresh Chapter");
  await page.fill(".modal input[name=file]", "fresh.qmd");
  await shot("new-chapter-modal");
  await page.click(".modal button[type=submit]");
  ok(await waitFor(() => existsSync(join(book, "fresh.qmd"))), "new chapter file created");
  await waitFor(() => readFileSync(join(book, "_quarto.yml"), "utf8") !== ymlBefore);
  const ymlAfter = readFileSync(join(book, "_quarto.yml"), "utf8");
  ok(ymlAfter === ymlBefore.replace("        - methods.qmd\n", "        - methods.qmd\n        - fresh.qmd\n"), "_quarto.yml gained exactly one line after the current chapter");
  ok(await waitFor(() => page.locator("#outline a.chapter", { hasText: "Fresh Chapter" }).count().then((n) => n === 1)), "sidebar shows the new chapter");

  // ---------------------------------------------------------------- 4. empty folder
  await page.evaluate((dir) => folio.openProject(dir), empty);
  await page.waitForSelector("#start-panel [data-choice=book]");
  ok(await page.locator("#editor").isHidden(), "empty folder hides the previous document");
  ok((await page.locator("#outline").innerText()).trim() === "", "empty folder shows an empty sidebar");
  ok((await page.locator("#start-panel [data-choice]").count()) === 3, "empty folder offers 3 project types in the content area");
  await shot("empty-folder");
  await page.click("#start-panel [data-choice=book]");
  await page.fill("#start-panel input[name=title]", "Empty Test Book");
  await page.click("#start-panel button[type=submit]");
  ok(await waitFor(() => existsSync(join(empty, "_quarto.yml")) && existsSync(join(empty, "intro.qmd"))), "empty folder → book project created");
  ok(await waitFor(() => page.locator("#book-title").innerText().then((t) => t.includes("Empty Test Book"))), "new book opens in the app");

  // ---------------------------------------------------------------- 4b. layout: centered, footer, resizer
  await page.evaluate((dir) => folio.openProject(dir), book);
  await waitFor(() => page.evaluate(() => !!folio.current));
  await page.evaluate(() => folio.openFile(folio.abs("intro.qmd")));
  await sleep(300);
  const pane = await page.locator("#editor").boundingBox();
  const content = await page.locator(".cm-content").first().boundingBox();
  const off = Math.abs(content.x + content.width / 2 - (pane.x + pane.width / 2));
  ok(off < 3, `content column is centered in the editor pane (off by ${off.toFixed(1)} px)`);
  const inFooter = await page.evaluate(() =>
    ["#python-env", "#run-above", "#run-all", "#kernel-interrupt", "#kernel-restart"].every(
      (sel) => document.querySelector(sel)?.closest("#statusbar"),
    ),
  );
  ok(inFooter, "kernel controls are in the bottom bar");
  const topBar = await page.evaluate(() => [...document.querySelectorAll("#toolbar button[id]")].map((b) => b.id).filter((id) => /render|export|present/.test(id)).join(","));
  ok(topBar === "render-chapter,render-book,export-pdf", `Render buttons sit in the top bar before Export PDF (${topBar})`);
  const pyH = await page.evaluate(() => document.querySelector("#python-env").getBoundingClientRect().height);
  const barH = await page.evaluate(() => document.querySelector("#statusbar").getBoundingClientRect().height);
  ok(pyH < 24 && barH < 30, `Python status fits on one line (button ${pyH}px, bar ${barH}px)`);
  const w0 = (await page.locator("#sidebar").boundingBox()).width;
  const rz = await page.locator("#sidebar-resizer").boundingBox();
  await page.mouse.move(rz.x + 2, rz.y + 100);
  await page.mouse.down();
  await page.mouse.move(rz.x + 122, rz.y + 100, { steps: 5 });
  await page.mouse.up();
  const w1 = (await page.locator("#sidebar").boundingBox()).width;
  ok(Math.abs(w1 - w0 - 120) < 4, `sidebar can be dragged wider (${w0} → ${w1})`);
  await page.reload();
  await waitFor(() => page.evaluate(() => !!window.folio?.current));
  ok(Math.abs((await page.locator("#sidebar").boundingBox()).width - w0) < 2, "sidebar width is not remembered after reopening");
  await shot("layout");

  // ---------------------------------------------------------------- 4c. python picker
  ok(await waitFor(() => page.locator("#python-label").innerText().then((t) => /Python \d/.test(t)), 20000), "footer shows the detected Python version");
  await page.click("#python-env");
  await page.waitForSelector(".pick-item");
  const nPy = await page.locator('.pick-item:not([data-id^="__"])').count();
  ok(nPy >= 1, `interpreter picker lists interpreters (${nPy} found)`);
  await shot("python-picker");
  const firstPy = await page.locator('.pick-item:not([data-id^="__"])').first().getAttribute("data-id");
  await page.locator('.pick-item:not([data-id^="__"])').first().dispatchEvent("mousedown");
  ok(await page.evaluate((root) => localStorage.getItem(`folio.python:${root}`), book) === firstPy, "chosen interpreter is remembered for the project");

  // ---------------------------------------------------------------- 4d. delete a chapter
  const ymlBeforeDelete = readFileSync(join(book, "_quarto.yml"), "utf8");
  ok((await page.locator("#outline .row-delete").count()) === 0, "no trash icons in the sidebar");
  await page.locator("#outline a.chapter", { hasText: "Fresh Chapter" }).first().click({ button: "right" });
  ok((await page.locator(".ctx-menu .ctx-item").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim()).join("|") === "Duplicate ⌘D|Rename… ↩|Delete ⌘⌫", "context menu shows Duplicate / Rename… / Delete with shortcuts");
  await page.click(".ctx-menu [data-item=delete]");
  await page.waitForSelector(".modal-box [data-confirm]");
  ok(await page.locator(".modal-box input[name=confirm-check]").isChecked(), "delete dialog offers removing the chapter from _quarto.yml");
  await shot("delete-confirm");
  await page.click(".modal-box [data-confirm]");
  ok(await waitFor(() => !existsSync(join(book, "fresh.qmd"))), "deleted file is gone from the project");
  ok(existsSync(join(book, ".folio/trash")) || process.env.FOLIO_BACKEND === "tauri", "deleted file was moved to .folio/trash (recoverable)");
  await waitFor(() => readFileSync(join(book, "_quarto.yml"), "utf8") !== ymlBeforeDelete);
  ok(readFileSync(join(book, "_quarto.yml"), "utf8") === ymlBeforeDelete.replace("        - fresh.qmd\n", ""), "_quarto.yml lost exactly that one line");
  ok(await waitFor(() => page.locator("#outline a.chapter", { hasText: "Fresh Chapter" }).count().then((n) => n === 0)), "sidebar no longer lists the deleted chapter");

  // ---------------------------------------------------------------- 4e. cell options, \index, footnotes, includes, margin, reader
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.evaluate(() => folio.openFile(folio.abs("methods.qmd")));
  await sleep(400);
  const methodsText = await page.locator(".cm-content").first().innerText();
  ok(methodsText.includes("#| include: false") && (await page.locator(".cm-cell-badge", { hasText: /^hidden in book$/ }).count()) === 1, "Edit view shows include: false cells in full, with a 'hidden in book' badge");
  ok(methodsText.includes("pd.DataFrame") && (await page.locator(".cm-cell-badge", { hasText: "code hidden in book" }).count()) === 1, "Edit view shows echo: false code, with a badge");
  await page.evaluate(() => folio.openFile(folio.abs("summary.qmd")));
  ok(await waitFor(() => page.locator(".cm-include").count().then((n) => n === 1)), "{{< include >}} content is shown inline");
  const sumText = await page.locator(".cm-content").first().innerText();
  ok(!sumText.includes("\\index{"), "\\index{} is hidden");
  ok((await page.locator(".cm-fn").count()) === 2, "footnotes render as numbered markers");
  await page.locator(".cm-fn").first().hover();
  ok(await waitFor(() => page.locator(".hover-card").innerText().then((t) => t.includes("SHM combines")), 3000), "hovering a footnote shows its text");
  await page.mouse.move(5, 500);
  const note = await page.locator(".cm-margin-note").boundingBox();
  const col = await page.locator(".cm-content").first().boundingBox();
  ok(note && note.x > col.x + col.width - 40, "margin note sits in the right margin on wide screens");
  await page.evaluate(() => folio.openFile(folio.abs("intro.qmd")));
  await sleep(300);
  await page.locator(".cm-ref", { hasText: "Figure 1.1" }).first().hover();
  ok(await waitFor(() => page.locator(".hover-card img").count().then((n) => n === 1), 3000), "hovering @fig-… previews the figure");
  await page.mouse.move(5, 500);
  // reader view
  await page.evaluate(() => folio.openFile(folio.abs("summary.qmd")));
  // regression: Source → Reader used to stay on raw code
  await page.click("#view-switch [data-mode=source]");
  await sleep(150);
  await page.click("#view-switch [data-mode=reader]");
  await sleep(300);
  const readerText = await page.locator(".cm-content").first().innerText();
  ok(!readerText.includes("only appears in the PDF") && !readerText.includes("LaTeX ·"), "reader view hides PDF-only content");
  ok(readerText.includes("Footnotes"), "reader view lists footnotes at the end");
  const lenBefore = readFileSync(join(book, "summary.qmd"), "utf8");
  await page.locator(".cm-content").first().click({ position: { x: 60, y: 120 } });
  await page.keyboard.type("SHOULD NOT APPEAR");
  await sleep(900);
  ok(readFileSync(join(book, "summary.qmd"), "utf8") === lenBefore, "reader view is read-only");
  await page.evaluate(() => folio.openFile(folio.abs("methods.qmd")));
  await sleep(300);
  const readerMethods = await page.locator(".cm-content").first().innerText();
  ok(!readerMethods.includes("#| include") && !readerMethods.includes("#| label") && !readerMethods.includes("```"), "reader view renders cells like the book (also after Source)");
  ok((await page.locator("#view-switch [data-mode=reader]").getAttribute("aria-pressed")) === "true", "Reader is the active segment");
  await shot("reader");
  await page.reload();
  await waitFor(() => page.evaluate(() => !!window.folio?.current));
  ok(await page.evaluate(() => folio.viewMode === "reader" && document.body.classList.contains("reader-mode")), "view mode is remembered after reopening");
  await page.keyboard.press("Control+1");
  await sleep(150);
  ok(await page.evaluate(() => folio.viewMode === "edit"), "Ctrl/⌘1 switches to Edit");
  await page.keyboard.press("Control+2");
  await sleep(150);
  ok(await page.evaluate(() => folio.viewMode === "source"), "Ctrl/⌘2 switches to Source");
  await page.keyboard.press("Control+3");
  await sleep(150);
  ok(await page.evaluate(() => folio.viewMode === "reader"), "Ctrl/⌘3 switches to Reader");
  await page.click("#view-switch [data-mode=edit]");
  await page.setViewportSize({ width: 1300, height: 900 });

  // ---------------------------------------------------------------- 4f. deleting the only file → start page
  await page.evaluate((dir) => folio.openProject(dir), single);
  await waitFor(() => page.evaluate(() => !!folio.current));
  await page.locator(".cm-content").first().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" edited");
  ok(await page.locator("#edit-config").isHidden(), "settings icon is hidden when there is no _quarto.yml");
  await page.locator("#outline a.chapter", { hasText: "notes.qmd" }).first().click({ button: "right" });
  await page.click(".ctx-menu [data-item=delete]");
  await page.click(".modal-box [data-confirm]");
  ok(await waitFor(() => page.locator("#start-panel").isVisible()), "deleting the only file returns to the start page");
  ok(await page.locator("#editor").isHidden(), "deleted file's content is no longer shown");
  await sleep(1200);
  ok(!existsSync(join(single, "notes.qmd")), "autosave did not recreate the deleted file");

  // ---------------------------------------------------------------- 4g. line numbers
  await page.evaluate((dir) => folio.openProject(dir), book);
  await waitFor(() => page.evaluate(() => !!folio.current));
  await page.evaluate(() => folio.openFile(folio.abs("intro.qmd")));
  await page.click("#toggle-lines");
  ok(await waitFor(() => page.locator(".cm-lineNumbers").first().isVisible(), 2000), "line numbers can be turned on");
  await page.click("#toggle-lines");
  ok(await waitFor(() => page.locator(".cm-lineNumbers").count().then((n) => n === 0), 2000), "and off again");

  // ---------------------------------------------------------------- 4h. create a .venv from the picker
  await page.evaluate(() => folio.refreshPythons());
  await page.click("#python-env");
  await page.waitForSelector(".pick-item");
  ok((await page.locator(".pick-item", { hasText: "Create virtual environment" }).count()) === 1, "picker offers to create a .venv");
  await page.locator(".pick-item", { hasText: "Create virtual environment" }).dispatchEvent("mousedown");
  await page.waitForSelector(".modal input[name=name]");
  ok((await page.inputValue(".modal input[name=name]")) === ".venv", "venv name defaults to .venv");
  await page.uncheck(".modal input[name=kernel]"); // skip pip install to keep the test fast
  await page.click(".modal button[type=submit]");
  ok(await waitFor(() => page.locator("#log-title").innerText().then((t) => /^Created \.venv$|failed/.test(t)), 90000), "venv creation finishes");
  ok(existsSync(join(book, ".venv/bin/python")), ".venv/bin/python exists");
  ok(await waitFor(() => page.evaluate((root) => (localStorage.getItem(`folio.python:${root}`) ?? "").endsWith(".venv/bin/python"), book)), "new .venv is selected");
  await page.click("#log-close");

  // ---------------------------------------------------------------- 4i. git: init, commit, live diff, push
  await page.click("#toggle-scm");
  await page.waitForSelector("#scm-panel [data-scm=init]");
  await page.click("#scm-panel [data-scm=init]");
  ok(await waitFor(() => existsSync(join(book, ".git")) && readFileSync(join(book, ".gitignore"), "utf8").includes(".folio/")), "Initialize repository creates .git and .gitignore");
  await page.waitForSelector("#scm-message");
  ok((await page.locator(".scm-file").count()) > 3, "changed files are listed");
  ok(!(await page.locator(".scm-file", { hasText: ".venv" }).count()), ".venv is ignored");
  await page.fill("#scm-message", "First draft");
  await page.click("#scm-panel [data-scm=commit]");
  ok(await waitFor(() => execSync("git log --oneline", { cwd: book, env: { ...process.env, GIT_CONFIG_GLOBAL: gitConfig } }).toString().includes("First draft")), "Commit creates a commit");
  await page.locator(".cm-content").first().click({ position: { x: 40, y: 60 } });
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\nA DIFF LINE\n");
  ok(await waitFor(() => page.locator(".scm-add .scm-text", { hasText: "A DIFF LINE" }).count().then((n) => n === 1), 4000), "live diff shows the added line in green");
  await shot("scm");
  await page.locator(".scm-hunk").last().click();
  await page.click("#scm-panel [data-scm=push]");
  await page.waitForSelector(".modal input[name=url]");
  await page.fill(".modal input[name=url]", bare);
  await page.click(".modal button[type=submit]");
  ok(await waitFor(() => page.locator("#log-title").innerText().then((t) => /Push complete|Push failed/.test(t)), 20000) && (await page.locator("#log-title").innerText()) === "Push complete", "Publish pushes to the remote");
  ok(execSync("git log --oneline main", { cwd: bare }).toString().includes("First draft"), "remote has the commit");
  await page.click("#toggle-scm");
  await page.click("#log-close");

  // ---------------------------------------------------------------- 4j. sidebar: ALL FILES, duplicate, rename, highlight
  await page.evaluate(() => folio.openFile(folio.abs("methods.qmd")));
  ok(await page.locator("#edit-config").isVisible(), "settings icon is shown for a project with _quarto.yml");
  const allFiles = await page.locator("#outline .section-title", { hasText: /all files/i }).count();
  ok(allFiles === 1 && (await page.locator('#outline ul.tree a.chapter[data-file="intro.qmd"]').count()) === 1, "ALL FILES lists every .qmd including book chapters");
  ok((await page.locator('#outline ul.tree .dir[data-dir="parts"]').count()) === 1, "sub-folders appear as a tree");
  const ymlBeforeDup = readFileSync(join(book, "_quarto.yml"), "utf8");
  await page.locator('#outline a.chapter[data-file="methods.qmd"]').first().click({ button: "right" });
  await page.click(".ctx-menu [data-item=duplicate]");
  ok(await waitFor(() => existsSync(join(book, "methods copy.qmd"))), "Duplicate creates 'methods copy.qmd'");
  ok(await waitFor(() => readFileSync(join(book, "_quarto.yml"), "utf8") === ymlBeforeDup.replace("        - methods.qmd\n", "        - methods.qmd\n        - methods copy.qmd\n")), "the copy is added to the book right after the original");
  // duplicate goes straight into rename: type a new name
  await page.waitForSelector("#outline .rename-input");
  await page.keyboard.press("Control+a");
  await page.keyboard.type("analysis");
  await page.keyboard.press("Enter");
  ok(await waitFor(() => existsSync(join(book, "analysis.qmd")) && !existsSync(join(book, "methods copy.qmd"))), "inline rename renames the file on disk");
  ok(await waitFor(() => readFileSync(join(book, "_quarto.yml"), "utf8") === ymlBeforeDup.replace("        - methods.qmd\n", "        - methods.qmd\n        - analysis.qmd\n")), "rename updates _quarto.yml (only that line)");
  // Enter on the selected file renames it (Finder-style)
  await page.locator('#outline a.chapter[data-file="analysis.qmd"]').first().click();
  await page.keyboard.press("Enter");
  await page.waitForSelector("#outline .rename-input");
  await page.keyboard.press("Escape");
  ok((await page.locator("#outline .rename-input").count()) === 0 && existsSync(join(book, "analysis.qmd")), "Enter starts rename, Esc cancels");
  // highlight: accent while the sidebar has focus, grey after clicking into the editor
  await page.locator('#outline a.chapter[data-file="analysis.qmd"]').first().click();
  const bgFocused = await page.locator("#outline a.chapter.selected").first().evaluate((el) => getComputedStyle(el).backgroundColor);
  await page.locator(".cm-content").first().click({ position: { x: 30, y: 30 } });
  const bgBlurred = await page.locator("#outline a.chapter.selected").first().evaluate((el) => getComputedStyle(el).backgroundColor);
  ok(bgFocused !== bgBlurred && !/rgba\(0, 0, 0, 0\)/.test(bgBlurred), `selection is accent when focused (${bgFocused}) and grey otherwise (${bgBlurred})`);
  // keyboard: arrow down selects and opens the next file
  await page.locator('#outline a.chapter[data-file="analysis.qmd"]').first().click();
  await page.keyboard.press("ArrowUp");
  ok(await waitFor(() => page.evaluate(() => folio.rel(folio.current.path) === "methods.qmd")), "↑ selects and opens the previous file");

  // ---------------------------------------------------------------- 4k. copy button, selection visible in code
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  // start from a known state: Edit view, methods.qmd at the top, cursor outside the cells
  await page.evaluate(async () => {
    folio.setViewMode("edit");
    await folio.openFile(folio.abs("methods.qmd"));
    folio.view.dispatch({ selection: { anchor: 0 } });
    folio.view.contentDOM.blur();
    folio.view.scrollDOM.scrollTop = 0;
  });
  const sineHead = page.locator(".cm-cell-head", { hasText: "fig-sine" });
  await sineHead.waitFor({ state: "attached", timeout: 10000 });
  await sineHead.locator(".cm-cell-copy").dispatchEvent("mousedown");
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  ok(clip.startsWith("import numpy as np") && !clip.includes("#|"), "copy button copies the code without #| lines");
  // select a word inside a code cell and check the selection layer shows through
  const line = page.locator(".cm-line.cm-code", { hasText: "x = np.linspace" }).first();
  await line.scrollIntoViewIfNeeded();
  await sleep(200);
  const box = await line.boundingBox();
  await page.mouse.click(box.x + box.width - 20, box.y + box.height / 2); // focus the editor first
  await sleep(150);
  const before = await page.screenshot({ clip: { x: box.x + 20, y: box.y + 4, width: 60, height: 10 } });
  await page.mouse.move(box.x + 18, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + box.height / 2, { steps: 4 });
  await page.mouse.up();
  await sleep(150);
  const after = await page.screenshot({ clip: { x: box.x + 20, y: box.y + 4, width: 60, height: 10 } });
  ok(!before.equals(after), "selected text inside a code block is visibly highlighted");

  // ---------------------------------------------------------------- 4l. source control: stage, discard, history, connect
  await page.click("#toggle-scm");
  await page.waitForSelector("#scm-panel [data-group=changes]");
  // the push button reads "Connect repository…" until a remote exists → the earlier publish added one, so check via a fresh repo below
  writeFileSync(join(book, "summary.qmd"), readFileSync(join(book, "summary.qmd"), "utf8") + "\nStaged line.\n");
  writeFileSync(join(book, "scratch.qmd"), "# Scratch\n");
  await page.evaluate(() => folio.scm.refresh(true));
  await page.locator('.scm-file[data-path="summary.qmd"] [data-act=stage]').dispatchEvent("click");
  ok(await waitFor(() => page.locator('[data-list=staged] .scm-file[data-path="summary.qmd"]').count().then((n) => n === 1)), "＋ moves a file to Staged Changes");
  ok((await page.locator("#scm-panel [data-scm=commit]").innerText()) === "Commit", "with staged files the button commits only those");
  await page.fill("#scm-message", "Only summary");
  await page.click("#scm-panel [data-scm=commit]");
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: gitConfig };
  ok(await waitFor(() => execSync("git show --stat --format=%s HEAD", { cwd: book, env: gitEnv }).toString().startsWith("Only summary")), "commit created");
  const committed = execSync("git show --stat --format= HEAD", { cwd: book, env: gitEnv }).toString();
  ok(committed.includes("summary.qmd") && !committed.includes("scratch.qmd") && !committed.includes("intro.qmd"), "only the staged file was committed");
  // discard: untracked file is deleted, modified file restored
  await page.evaluate(() => folio.scm.refresh(true));
  await page.locator('.scm-file[data-path="scratch.qmd"] [data-act=discard]').dispatchEvent("click");
  await page.click(".modal-box [data-confirm]");
  ok(await waitFor(() => !existsSync(join(book, "scratch.qmd"))), "Discard deletes an untracked file");
  const introOnDisk = readFileSync(join(book, "intro.qmd"), "utf8");
  await page.evaluate(() => folio.scm.refresh(true));
  await page.locator('.scm-file[data-path="intro.qmd"] [data-act=discard]').dispatchEvent("click");
  await page.click(".modal-box [data-confirm]");
  ok(await waitFor(() => readFileSync(join(book, "intro.qmd"), "utf8") !== introOnDisk && !readFileSync(join(book, "intro.qmd"), "utf8").includes("A DIFF LINE")), "Discard restores a modified file to the last commit");
  // stage all / unstage all
  writeFileSync(join(book, "a1.qmd"), "# A1\n");
  await page.evaluate(() => folio.scm.refresh(true));
  await page.locator("[data-group=changes] [data-act=stage-all]").dispatchEvent("click");
  ok(await waitFor(() => page.locator("[data-list=staged] .scm-file").count().then((n) => n >= 1)), "Stage All stages everything");
  await page.locator("[data-group=staged] [data-act=unstage-all]").dispatchEvent("click");
  ok(await waitFor(() => page.locator("[data-list=staged]").count().then((n) => n === 0)), "Unstage All moves everything back");
  ok(await waitFor(() => page.locator(".scm-commit-row svg.scm-graph").count().then((n) => n >= 2)), "History shows commits with a graph");
  await shot("scm-graph");
  await page.click("#toggle-scm");
  // a project without a remote shows "Connect repository…"
  await page.evaluate((dir) => folio.openProject(dir), empty);
  await waitFor(() => page.evaluate(() => !!folio.current));
  await page.click("#toggle-scm");
  await page.click("#scm-panel [data-scm=init]");
  await page.waitForSelector("#scm-message");
  await page.fill("#scm-message", "init");
  await page.click("#scm-panel [data-scm=commit]");
  ok(await waitFor(() => page.locator("#scm-panel [data-scm=push]").innerText().then((t) => t.includes("Connect repository"))), "no remote → 'Connect repository…'");
  await page.click("#toggle-scm");

  // ---------------------------------------------------------------- 4m. no Present button (removed)
  ok((await page.locator("#present-btn, #present").count()) === 0, "there is no Present button");
  await page.evaluate((dir) => folio.openProject(dir), book);
  await waitFor(() => page.evaluate(() => !!folio.current));

  // ---------------------------------------------------------------- 4n. figure layouts, tables, slash menu, Python packages
  await page.evaluate(() => folio.openFile(folio.abs("summary.qmd")));
  await sleep(500);
  ok(await waitFor(() => page.locator(".cm-layout-block").count().then((n) => n >= 2)), "layout divs render as figure panels / custom layouts");
  const subcaps = await page.locator(".cm-layout-block").first().locator("figcaption").allInnerTexts();
  ok(subcaps.join("|") === "(a) Early growth|(b) Late growth", `subfigures get (a)/(b) sub-captions (${subcaps.join("|")})`);
  ok(/^Figure \d+\.1: Two views/.test(await page.locator(".cm-layout-caption").first().innerText()), "subfigure panel has the main 'Figure n.1:' caption");
  ok(await page.locator(".cm-ref", { hasText: /^Figure \d+\.1\(b\)$/ }).count().then((n) => n === 1), "@fig-…-late resolves to 'Figure n.1(b)'");
  const firstRow = page.locator(".cm-layout-block").nth(1).locator(".cm-layout-row").first();
  ok((await firstRow.locator(".cm-layout-cell").count()) === 2 && (await page.locator(".cm-layout-block").nth(1).locator(".cm-layout-row").count()) === 2, 'layout="[[1,1],[1]]" gives two rows (2 + 1)');
  const widths = await page.locator("table.cm-table-fixed th").evaluateAll((ths) => ths.map((t) => t.getBoundingClientRect().width));
  ok(widths.length === 2 && Math.abs(widths[0] / widths[1] - 3) < 0.3, `tbl-colwidths [75,25] applied (${widths.map(Math.round).join(" / ")})`);
  ok((await page.locator(".cm-html-table table").count()) === 1 && (await page.locator(".cm-html-table [onclick]").count()) === 0, "HTML table renders, sanitized");
  // slash menu
  await page.locator(".cm-content").first().click({ position: { x: 30, y: 30 } });
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/");
  await page.waitForSelector(".cm-tooltip-autocomplete");
  const opts = await page.locator(".cm-tooltip-autocomplete li").allInnerTexts();
  ok(["/subfigures", "/figure-panel", "/layout", "/table-widths"].every((o) => opts.some((t) => t.startsWith(o))), "slash menu offers /subfigures, /figure-panel, /layout, /table-widths");
  await page.keyboard.type("figure");
  await page.waitForTimeout(200);
  await page.keyboard.press("Enter");
  await sleep(200);
  ok((await page.evaluate(() => folio.view.state.doc.toString())).includes("{#fig-name width=50%}"), "/figure inserts a width");
  for (let i = 0; i < 4; i++) await page.keyboard.press("Control+z");
  // Python: the .venv created earlier has no packages → Render asks before failing
  await page.evaluate(() => folio.openFile(folio.abs("methods.qmd")));
  await page.evaluate(() => { folio.pythons = null; return folio.refreshPythons(); });
  ok(await page.evaluate(() => (folio.effectivePython()?.missing ?? []).includes("pyyaml")), "probe reports pyyaml missing in the bare .venv");
  ok(await page.locator("#python-env.warn").count().then((n) => n === 1), "footer Python is flagged");
  await page.click("#render-chapter");
  ok(await waitFor(() => page.locator(".modal-box", { hasText: "Python packages missing" }).count().then((n) => n === 1), 5000), "Render warns about missing packages before running Quarto");
  ok((await page.locator(".modal-choice[data-choice=install]").count()) === 1, "…and offers to install them");
  await shot("python-missing");
  await page.click(".modal-choice[data-choice=cancel]");

  // ---------------------------------------------------------------- 5. quarto render
  if (hasQuarto) {
    await page.evaluate((dir) => folio.openProject(dir), book);
    await waitFor(() => page.evaluate(() => !!folio.current));
    await page.evaluate(() => folio.openFile(folio.abs("intro.qmd")));
    await page.click("#render-chapter");
    const t0 = Date.now();
    const done = await waitFor(() => page.locator("#log-title").innerText().then((t) => /complete|failed/.test(t)), FAKE_QUARTO ? 15000 : 240000, 250);
    const title = await page.locator("#log-title").innerText();
    ok(done && title.includes("complete"), `quarto render finished (${title}, ${((Date.now() - t0) / 1000).toFixed(1)} s${FAKE_QUARTO ? ", fake quarto" : ""})`);
    ok(existsSync(join(book, "_book/intro.html")), "_book/intro.html exists");
    if (!title.includes("complete")) console.log((await page.locator("#log").innerText()).split("\n").slice(-30).join("\n"));
    if (!title.includes("complete")) {
      try {
        console.log(execSync("ps -ef --forest | grep -i -E 'quarto|deno|pandoc|python|sass|esbuild' | grep -v grep", { encoding: "utf8" }));
      } catch {}
    }
    if (FAKE_QUARTO) {
      await page.click("#export-pdf");
      await waitFor(() => page.locator(".modal-choice[data-choice=anyway]").count().then((n) => n > 0), 3000);
      if (await page.locator(".modal-choice[data-choice=anyway]").count()) await page.click(".modal-choice[data-choice=anyway]");
      const pdfDone = await waitFor(() => page.locator("#log-title").innerText().then((t) => /PDF exported|failed/.test(t)), 15000, 250);
      ok(pdfDone && (await page.locator("#log-title").innerText()) === "PDF exported", "Export PDF runs quarto render --to pdf");
      ok((await page.locator("#log").innerText()).includes("fake quarto args: render --to pdf"), "whole book exported with --to pdf");
      ok(existsSync(join(book, "_book/book.pdf")), "_book/book.pdf exists");
    }
  } else {
    console.log("- quarto not on PATH: skipping render test");
  }

  ok(errors.length === 0, `no page errors${errors.length ? ": " + errors.join("; ") : ""}`);
  ok(vite.exitCode === null, `dev server still running${vite.exitCode !== null ? ` (exited with ${vite.exitCode})` : ""}`);
} catch (e) {
  ok(false, `unexpected error: ${e.stack ?? e}`);
  if (errors.length) console.log("page errors:\n  " + errors.join("\n  "));
  try {
    const state = await page.evaluate(() => ({
      mode: folio.viewMode,
      file: folio.current ? folio.rel(folio.current.path) : null,
      selection: folio.view.state.selection.main.head,
      cellHeads: [...document.querySelectorAll(".cm-cell-head")].map((el) => el.textContent),
      startPanel: !document.querySelector("#start-panel")?.hidden,
      modal: document.querySelector(".modal")?.textContent ?? null,
    }));
    console.log("app state: " + JSON.stringify(state));
    await page.screenshot({ path: join(ROOT, "e2e-failure.png") });
  } catch {}
} finally {
  await browser.close();
  vite.kill();
  if (!process.env.E2E_KEEP) rmSync(work, { recursive: true, force: true });
}
if (failures) console.log("--- dev server output (last 40 lines)\n" + viteOut.split("\n").slice(-40).join("\n"));
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
