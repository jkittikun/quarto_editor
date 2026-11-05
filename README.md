# Folio

A lightweight desktop editor for **Quarto** (`.qmd`) books, with what-you-see-is-what-you-get live preview.
It feels like Obsidian or Notion, but it understands Quarto.

* **One pane, live preview.** Headings, emphasis, math, callouts, figures, tables, tabsets, diagrams,
  citations and cross-references render in place as you type. The raw syntax appears only where your
  cursor is, the same way Obsidian's live preview works.
* **Your source is never rewritten.** Folio decorates the text and never round-trips it through a converter.
  Saving writes exactly the bytes you typed, so diffs stay clean (unlike some visual editors that
  reformat Markdown).
* **Book-aware.**
  * The sidebar shows your book from `_quarto.yml`: parts, chapters, appendices, and the headings of
    the current chapter.
  * Chapter and section numbers match Quarto's.
  * Cross-references resolve across the whole book: `@fig-…`, `@tbl-…`, `@eq-…`, `@sec-…`, `@thm-…`
    and the other theorem types. Each shows as "Figure 2.1", and ⌘-click jumps to the target, even in
    another chapter.
  * Citations (`[@key]`, `@key`, `[-@key]`) come from your `.bib` and render author-date. The `::: {#refs}`
    div shows the bibliography.
* **Python cells run live.** Press ⌘↵ in a ```` ```{python} ```` cell (or click **▶ Run**).
  * Each chapter gets its own Jupyter kernel, working directory = the chapter's folder, the same as Quarto.
  * Plots, pandas tables, stdout and errors appear inline under the cell.
  * Outputs are cached in `.folio/cache/`, so reopening a chapter shows them without re-running.
  * Outputs fade when the code has changed since the last run.
* **Full fidelity when you want it.** **Render chapter** / **Render book** runs `quarto render`,
  streams the log, and opens the result.
* **Notion-style inserts.** Type `/` on an empty line for callouts, figures, equations, tables, tabsets,
  theorems, columns, Python cells and Mermaid diagrams. Type `@` to autocomplete labels and citation keys.
* **Light.** It's a Tauri 2 app that uses the system WebView, so the bundle is a few MB instead of
  Electron's 150+, and it starts instantly.

## Download (no Rust needed)

GitHub builds a universal macOS app (Apple Silicon + Intel) on every push:

1. Go to the repo's **Actions** tab → **Build macOS app** → open the latest successful run.
2. Download the **Folio-macOS** artifact (a zip containing `Folio_x.y.z_universal.dmg`).
   Tagged versions (`v0.1.0`, …) also get the `.dmg` attached on the **Releases** page.
3. Open the `.dmg` and drag Folio to Applications.
4. The app isn't code-signed. The first time, right-click `Folio.app` and choose **Open**, or run:

   ```bash
   xattr -cr /Applications/Folio.app
   ```

Running Folio needs only what your Quarto book already needs: Quarto, plus Python with
`jupyter_client` and `ipykernel` for running cells. You don't need Rust or Node.

## Build from source (macOS)

Rust is only needed to *compile* the app's native shell (Tauri). It has nothing to do with the code in
your `.qmd` files.

Prerequisites:
- [Rust](https://rustup.rs)
- Node 20+
- [Quarto](https://quarto.org/docs/get-started/), for the Render buttons
- Python with `jupyter_client` and `ipykernel`, for running cells (Quarto already needs these for Python books)

```bash
npm install
```

Run the app in development mode:

```bash
npm run tauri dev
```

Build `Folio.app` and a `.dmg` into `src-tauri/target/release/bundle/`:

```bash
npm run tauri build
```

The app isn't code-signed. The first time, right-click `Folio.app` and choose **Open**, or run:

```bash
xattr -cr /Applications/Folio.app
```

### Try it in a browser (no Rust needed)

```bash
npm install
```

```bash
FOLIO_ROOT=/path/to/your/book npm run dev
```

Then open http://127.0.0.1:1420. A small Vite middleware (`server/devApi.ts`) provides file access, the
Python kernel and `quarto render`. It only serves folders you open, and it listens only on localhost.
Without `FOLIO_ROOT`, it opens the sample book in `examples/book`.

## Python environment

Click the Python version in the bottom bar to choose an interpreter. Until you choose one, Folio uses
the first it finds, in this order:
1. `.venv/bin/python`, `venv/bin/python` or `env/bin/python` in the project, or any folder with `pyvenv.cfg`
2. `FOLIO_PYTHON`
3. `QUARTO_PYTHON`
4. conda, pyenv and system Pythons

That interpreter needs `jupyter_client` and `ipykernel`:

```bash
python3 -m pip install jupyter_client ipykernel
```

The macOS app picks up your login shell's `PATH`, so Homebrew, conda and pyenv installs are found even
when you launch it from Finder.

## Working with projects

* **New document:** the **＋** button in the sidebar creates a `.qmd` file. In a book, it can
  also add the file to `book.chapters` right after the current chapter. Folio edits `_quarto.yml` as
  text, so your comments and formatting are kept.
* **Source control** (branch icon in the top bar, ⌘⇧G): a right-hand panel that uses the git
  installed on your Mac, with your usual GitHub login (SSH key or Keychain).
  * **Initialize repository** creates a `.gitignore` for build output, `.folio/` and `.venv/`.
  * It works like VS Code's source control: **Staged Changes** and **Changes** groups, with
    ＋ Stage, − Unstage and ↶ Discard on each file and Stage All / Unstage All / Discard All on each
    group.
  * The commit box commits the staged files, or everything when nothing is staged (⌘↵ to commit).
    **Push** sends your commits; when no remote is set yet, the button reads **Connect
    repository…** and asks for a URL.
  * A **History** section shows the commit graph with branch and tag labels.
  * It also shows a live diff of the open chapter against the last commit; click a change to jump to
    it.
* **Line numbers:** toggle with the # button in the top bar (⌘⇧L).
* **Project settings:** **⚙** in the sidebar opens `_quarto.yml` in a plain YAML editor. When you save,
  the sidebar, numbering and bibliography reload, and YAML errors show in the status bar.
* **Empty folder:** opening a folder with no Quarto files shows a start screen where you can create a
  **Book**, a **Presentation** (Reveal.js) or a **Single document**.
* **Files in the sidebar:** **ALL FILES** shows every `.qmd`/`.md` in the folder and its
  sub-folders as a tree. Right-click a file for **Duplicate** (⌘D), **Rename…** (↩) and
  **Delete** (⌘⌫), or select it and press Enter to rename it in place, as in Finder.
  * In a book, renaming updates `_quarto.yml`, and a duplicate is added right after the original.
  * Delete moves the file to the macOS Trash (in browser mode, to `.folio/trash/`).
  * ↑/↓ move through the files.
* **Copy code:** every code block has a copy button that copies the code without its `#|` options.
* **Python interpreter:** the bottom bar shows the Python that runs your cells, for example
  `Python 3.12.3 (.venv)`. Click it to pick another one. Like VS Code, Folio detects virtual
  environments in the project (`.venv`, `venv`, `env`, or any folder with `pyvenv.cfg`), conda
  environments, pyenv versions and system Pythons. It flags interpreters that are missing
  `ipykernel`, and you can also enter a path. Folio remembers your choice per project and also
  passes it to Quarto as `QUARTO_PYTHON`. When the project has no virtual environment, the picker
  offers **＋ Create virtual environment (.venv)**: pick a base Python, and optionally install
  everything needed to run cells *and* render with Quarto (`jupyter_client`, `ipykernel`, `pyyaml`,
  `nbformat`, `nbclient`) in one step.
  * An interpreter that is missing packages is shown in orange, and the picker offers **Install
    missing packages**.
  * Before Render or Export PDF, Folio warns and offers to install them instead of letting
    Quarto fail with `No module named 'yaml'`.
* **Export PDF** (top bar): runs `quarto render --to pdf`, for the whole book or for the current
  document. This needs a LaTeX installation; `quarto install tinytex` is the easiest.
* **Layout:** **Render** / **Render book** and **Export PDF** sit in the top bar; the Python and kernel controls live in the bottom bar. Drag the sidebar edge to resize it
  (double-click resets it; the width isn't remembered between launches).
* **Three views:** the icon switch in the top bar (✎ │ `</>` │ book) picks one of three modes. Folio
  remembers the one you used last.
  * **Edit** (⌘1) is the live preview. Every cell's code and output are visible. Options like
    `include: false` or `echo: false` show as "hidden in book" badges in the cell header.
  * **Source** (⌘2) shows the plain `.qmd` text.
  * **Reader** (⌘3) is read-only and looks like the HTML book: cell options are applied, PDF-only
    content is hidden, and footnotes are listed at the end.
* **Hover previews:** hover a cross-reference (`@fig-…`, `@tbl-…`, `@eq-…`, `@thm-…`, `@sec-…`), a
  citation or a footnote to preview it.
  **A− / A+** change the text size.

## Keyboard

| Keys | Action |
|---|---|
| ⌘P | Go to file / chapter |
| ⌘O | Open project folder |
| ⌘↵ / ⇧↵ | Run cell / run cell and move to the next |
| ⌘⌥↵ | Run all cells above the cursor |
| ⌘1 / ⌘2 / ⌘3 | Edit / Source / Reader view |
| ⌘⇧E | Toggle Edit ↔ Source |
| ⌘⌥R | Toggle Reader |
| ⌘⇧G | Source control panel |
| ⌘⇧L | Line numbers |
| ↩ / ⌘D / ⌘⌫ | Rename / duplicate / delete the selected file (sidebar) |
| ⌘+ / ⌘− | Larger / smaller text (`A+` / `A−`) |
| ⌘B / ⌘I / ⌘E | Bold / italic / inline code |
| ⌘-click | Follow a cross-reference or link |
| ⌘F | Find & replace |
| ⇧⌘R | Render current chapter with Quarto |
| ⌘\\ | Toggle sidebar |
| `/` | Insert block (on an empty line) |
| `@` | Reference / citation autocomplete |

## What renders live

| Quarto feature | Live preview |
|---|---|
| Headings with `{#sec-…}` / `{.unnumbered}` | ✅ numbered like Quarto |
| `**bold**`, `*italic*`, `~~strike~~`, `` `code` ``, `^sup^`, `~sub~`, links, `[span]{.class}` | ✅ |
| `$inline$`, `$$display$$ {#eq-…}` | ✅ KaTeX, with equation numbers |
| `![cap](img.png){#fig-… width=60%}` | ✅ with "Figure n.m:" caption |
| Pipe tables + `: caption {#tbl-…}` | ✅ with `tbl-colwidths="[75,25]"` and relative dash widths |
| HTML tables (`<table>` or ```` ```{=html} ````) | ✅ rendered, with scripts and event handlers removed |
| Subfigures `::: {#fig-x layout-ncol=2}` | ✅ grid with (a), (b) sub-captions; `@fig-x-a` → "Figure 1.2(a)" |
| Figure panels / custom layouts (`layout-ncol`, `layout-nrow`, `layout="[[1,1],[1]]"`) | ✅ side by side, also for code-cell plots with `fig-subcap` |
| Callouts (all 5 types, titles) | ✅ — `collapse="true"/"false"` gives a ▸/▾ toggle |
| `.panel-tabset` | ✅ clickable tabs |
| Theorem-like divs (`#thm-…`, `#lem-…`, `#def-…`, …) | ✅ "Theorem 2.1 (Name)" |
| `.columns` / `.column width=…` | ✅ side by side (editable when you click in) |
| Other fenced divs (custom classes) | ✅ shown as a framed block |
| ```` ```{mermaid} ```` / ```` ```{dot} ```` | ✅ rendered diagram (Mermaid / Graphviz) |
| ```` ```{python} ```` | ✅ syntax-highlighted cell; run it for inline output, or see the outputs of your last `quarto render` (read from `_freeze/`) |
| Reveal.js presentations (`format: revealjs`) | ✅ slide dividers with slide numbers |
| YAML front matter | ✅ title + metadata chips |
| `[@cite]`, `@cite`, `@fig-x` etc. | ✅ resolved across the book |
| Shortcodes `{{< … >}}` | shown as code chips; `{{< include file.qmd >}}` shows the included file inline |
| Cell options `include`, `echo`, `output`, `eval` | ✅ badges while editing; applied as in the book in Reader view |
| `\index{…}`, `\newpage`, `\label{…}` and other LaTeX-only commands | ✅ hidden (🔖 marker for index entries) |
| Footnotes `[^id]`, `^[inline]` | ✅ numbered superscripts, hover to read, listed at the end in reader view |
| `.column-margin`, `.aside` | ✅ in the right margin on wide windows |
| `.content-visible` / `.content-hidden` (`when-format`, `unless-format`) | ✅ labelled ("PDF only"); reader view shows what the HTML book shows |
| ```` ```{=latex} ```` and `` `…`{=latex} `` | ✅ compact "LaTeX · PDF only" chip |
| `{r}`/`{julia}` cells, Observable JS | syntax-highlighted only; use **Render** (their `_freeze` outputs still show) |

## Project layout

```
src/core/       pure logic: _quarto.yml outline, cross-ref index & numbering, BibTeX, inline Markdown
src/editor/     CodeMirror 6: Quarto syntax extensions, live-preview decorations, widgets, cells, completions
src/ui/         app shell: sidebar, quick open, autosave, kernel routing, render panel
src/backend/    Backend interface + Tauri and HTTP implementations
src-tauri/      Rust: scoped file I/O, file watcher, kernel process, quarto render
kernel/         folio_kernel.py — jupyter_client bridge (JSON lines over stdio)
server/         Vite dev middleware mirroring the Rust commands (browser mode)
examples/book/  sample Quarto book used for development and tests
```

## Development

Unit tests (parser, cross-refs, decorations, cells, freeze, templates):

```bash
npm test
```

End-to-end tests run Folio in a headless browser against a scratch copy of the sample book. They
check that edits in rendered mode change only the typed bytes on disk, and they also test running a
Python cell, creating a chapter, creating a project in an empty folder, and `quarto render` (when
Quarto is installed). CI runs all of these on every push.

```bash
npm run e2e
```

Rust tests:

```bash
cd src-tauri && cargo test
```

Type-check and production build:

```bash
npm run build
```

Add `.folio/` to your book's `.gitignore`. It only holds cached cell outputs.
