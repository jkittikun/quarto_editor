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
cpSync(join(ROOT, "examples/book"), book, { recursive: true, filter: (s) => !s.includes(".folio") && !s.includes("_book") });
mkdirSync(empty);

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
  env: { ...process.env, FOLIO_ROOT: book, ...(FAKE_QUARTO ? { QUARTO_PATH: join(ROOT, "tests/e2e/fake-quarto.sh") } : {}) },
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
  await page.locator(".cm-content").click({ position: { x: 5, y: 5 } });
  await page.evaluate(() => folio.view.contentDOM.blur());
  await page.locator(".cm-tab", { hasText: "R" }).dispatchEvent("mousedown");
  await sleep(200);
  await typeAtEndOf("Some R notes.", " GAMMA");
  // collapsible callout: starts collapsed; expand it and type in the body
  await page.evaluate(() => folio.view.contentDOM.blur());
  await sleep(150);
  ok(!(await page.locator(".cm-content").innerText()).includes("Callouts can be collapsible."), "collapse=true callout starts collapsed");
  await page.locator(".cm-callout-toggle").first().dispatchEvent("mousedown");
  await sleep(200);
  ok((await page.locator(".cm-content").innerText()).includes("Callouts can be collapsible."), "callout expands on toggle");
  await typeAtEndOf("Callouts can be collapsible.", " DELTA");
  // raw source view on and off
  await page.click("#toggle-source");
  await sleep(150);
  ok((await page.locator(".cm-content").innerText()).includes("::: {.callout-note}"), "raw view shows the source");
  await shot("raw-view");
  await page.click("#toggle-source");
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
  ok(await waitFor(() => page.locator(".cm-content").innerText().then((t) => t.includes("An EXTERNAL edit."))), "edits made outside Folio appear in the open chapter");
  mkdirSync(join(book, "parts/deep"), { recursive: true });
  await sleep(300);
  writeFileSync(join(book, "parts/deep/new.qmd"), "# Deep\n");
  ok(await waitFor(() => page.evaluate(() => folio.files.includes("parts/deep/new.qmd"))), "files created in new subfolders are picked up");

  // ---------------------------------------------------------------- 2. kernel
  if (!process.env.E2E_SKIP_KERNEL) {
    await page.evaluate(() => folio.openFile(folio.abs("methods.qmd")));
    await sleep(500);
    await page.locator(".cm-cell-run").first().dispatchEvent("mousedown");
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
  const content = await page.locator(".cm-content").boundingBox();
  const off = Math.abs(content.x + content.width / 2 - (pane.x + pane.width / 2));
  ok(off < 3, `content column is centered in the editor pane (off by ${off.toFixed(1)} px)`);
  const inFooter = await page.evaluate(() =>
    ["#python-env", "#run-above", "#run-all", "#kernel-interrupt", "#kernel-restart", "#render-chapter", "#render-book"].every(
      (sel) => document.querySelector(sel)?.closest("#statusbar"),
    ),
  );
  ok(inFooter, "kernel and render controls are in the bottom bar");
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
  const nPy = await page.locator(".pick-item").count();
  ok(nPy >= 3, `interpreter picker lists interpreters (${nPy - 2} found)`);
  await shot("python-picker");
  const firstPy = await page.locator(".pick-item").first().getAttribute("data-id");
  await page.locator(".pick-item").first().dispatchEvent("mousedown");
  ok(await page.evaluate((root) => localStorage.getItem(`folio.python:${root}`), book) === firstPy, "chosen interpreter is remembered for the project");

  // ---------------------------------------------------------------- 4d. delete a chapter
  const ymlBeforeDelete = readFileSync(join(book, "_quarto.yml"), "utf8");
  await page.locator("#outline li.file-row", { hasText: "Fresh Chapter" }).hover();
  await page.locator("#outline li.file-row", { hasText: "Fresh Chapter" }).locator(".row-delete").click();
  await page.waitForSelector(".modal-box [data-confirm]");
  ok(await page.locator(".modal-box input[name=confirm-check]").isChecked(), "delete dialog offers removing the chapter from _quarto.yml");
  await shot("delete-confirm");
  await page.click(".modal-box [data-confirm]");
  ok(await waitFor(() => !existsSync(join(book, "fresh.qmd"))), "deleted file is gone from the project");
  ok(existsSync(join(book, ".folio/trash")) || process.env.FOLIO_BACKEND === "tauri", "deleted file was moved to .folio/trash (recoverable)");
  await waitFor(() => readFileSync(join(book, "_quarto.yml"), "utf8") !== ymlBeforeDelete);
  ok(readFileSync(join(book, "_quarto.yml"), "utf8") === ymlBeforeDelete.replace("        - fresh.qmd\n", ""), "_quarto.yml lost exactly that one line");
  ok(await waitFor(() => page.locator("#outline a.chapter", { hasText: "Fresh Chapter" }).count().then((n) => n === 0)), "sidebar no longer lists the deleted chapter");

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
} finally {
  await browser.close();
  vite.kill();
  if (!process.env.E2E_KEEP) rmSync(work, { recursive: true, force: true });
}
if (failures) console.log("--- dev server output (last 40 lines)\n" + viteOut.split("\n").slice(-40).join("\n"));
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
