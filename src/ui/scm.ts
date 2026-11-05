/**
 * Source-control panel (right sidebar): init, changed files, commit, push, and a live diff of the
 * open file against the last commit.
 */
import type { App } from "./app";
import { fileDiff, statusLetter, buildGraph, parseGitLog, NO_REPO, type GitStatus } from "../core/git";
import { escapeHtml } from "../core/inline";
import { formModal, confirmModal } from "./modal";

const svg = (body: string) => `<svg viewBox="0 0 16 16" aria-hidden="true">${body}</svg>`;
const ICON = {
  plus: svg('<path d="M8 3v10M3 8h10"/>'),
  minus: svg('<path d="M3 8h10"/>'),
  discard: svg('<path d="M5.5 3.5L3 6l2.5 2.5"/><path d="M3 6h6.5a3.5 3.5 0 0 1 0 7H6"/>'),
  plug: svg('<path d="M6 2.5v3M10 2.5v3"/><path d="M4.5 5.5h7v2.5a3.5 3.5 0 0 1-7 0z"/><path d="M8 11.5v2"/>'),
};
import { $, h, debounce } from "./dom";

const LETTER_TITLE: Record<string, string> = { M: "Modified", A: "Added", D: "Deleted", R: "Renamed", U: "Conflict", "?": "Untracked" };

export class ScmPanel {
  status: GitStatus = NO_REPO;
  open = false;
  historyOpen = true;
  private draft = ""; // commit message survives redraws
  private headCache = new Map<string, string | null>();
  private busy = false;
  private el = $("#scm-panel");

  constructor(private app: App) {
    $("#toggle-scm").onclick = () => this.toggle();
    this.wireResizer();
  }

  toggle(force?: boolean) {
    this.open = force ?? !this.open;
    this.el.hidden = !this.open;
    $("#scm-resizer").hidden = !this.open;
    $("#toggle-scm").setAttribute("aria-pressed", String(this.open));
    $("#toggle-scm").classList.toggle("active", this.open);
    if (this.open) this.refresh();
    this.app.view.requestMeasure();
  }

  /** Re-read `git status` (cheap) and redraw; the badge on the toolbar button stays current. */
  async refresh(clearHead = false) {
    if (!this.app.root) return;
    if (clearHead) this.headCache.clear();
    try {
      this.status = await this.app.backend.gitStatus(this.app.root);
    } catch {
      this.status = { ...NO_REPO, installed: false };
    }
    const n = this.status.files.length;
    const badge = $("#scm-count");
    badge.hidden = !n;
    badge.textContent = n > 99 ? "99+" : String(n);
    if (this.open) {
      this.render();
      await this.renderDiff();
    }
  }

  refreshSoon = debounce(() => this.refresh(), 700);
  diffSoon = debounce(() => this.open && this.renderDiff(), 300);

  /** Called when a different project is opened. */
  reset() {
    this.headCache.clear();
    this.status = NO_REPO;
    this.refresh();
  }

  private currentRel(): string | null {
    const cur = this.app.current;
    return cur ? this.app.rel(cur.path) : null;
  }

  render() {
    const st = this.status;
    const el = this.el;
    el.innerHTML = "";
    const head = h("div", { class: "scm-head" });
    head.appendChild(h("span", { class: "scm-title" }, "Source control"));
    const refresh = h("button", { class: "icon", title: "Refresh" }, "↻");
    refresh.onclick = () => this.refresh(true);
    head.appendChild(refresh);
    el.appendChild(head);

    if (!st.installed) {
      el.appendChild(this.note("Git isn't installed.", "On macOS, install it with: xcode-select --install"));
      return;
    }
    if (!st.isRepo) {
      el.appendChild(this.note("This folder isn't a git repository.", "Initialize one to track versions of your book."));
      const init = h("button", { class: "primary scm-wide", "data-scm": "init" }, "Initialize repository");
      init.onclick = () => this.init();
      el.appendChild(init);
      return;
    }

    const branch = h("div", { class: "scm-branch" });
    branch.innerHTML =
      `<span class="scm-branch-name">⎇ ${escapeHtml(st.branch ?? "?")}</span>` +
      (st.upstream ? `<span class="scm-ab" title="Commits to push / to pull">↑${st.ahead} ↓${st.behind}</span>` : st.remote ? "" : `<span class="scm-ab">no remote</span>`);
    el.appendChild(branch);

    // which files are staged (index column) and which have unstaged changes (worktree column)
    const staged = st.files.filter((f) => f.index !== "." && f.index !== "?" && f.index !== "U");
    const unstaged = st.files.filter((f) => f.worktree !== "." || f.index === "?" || f.index === "U");

    // commit box
    const box = h("div", { class: "scm-commit" });
    const msg = h("textarea", { id: "scm-message", rows: "2", placeholder: "Commit message (⌘↵ to commit)" });
    msg.value = this.draft;
    const commit = h("button", { class: "primary", "data-scm": "commit" }, staged.length ? "Commit" : "Commit All");
    commit.title = staged.length ? `Commit the ${staged.length} staged file(s)` : "Stage and commit all changes";
    const connect = !st.remote;
    const push = h("button", { "data-scm": "push", class: connect ? "scm-connect" : "" });
    if (connect) push.innerHTML = `${ICON.plug}<span>Connect repository…</span>`;
    else push.textContent = st.ahead ? `Push ↑${st.ahead}` : "Push";
    push.title = connect ? "Link this folder to a remote repository (e.g. on GitHub) and push" : "Push commits to " + st.remote;
    const sync = () => {
      this.draft = msg.value;
      commit.disabled = this.busy || !msg.value.trim() || !st.files.length;
      push.disabled = this.busy || !st.hasCommits || (!connect && !st.ahead && !!st.upstream);
    };
    msg.addEventListener("input", sync);
    msg.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        if (!commit.disabled) this.commit(msg.value, staged.length > 0);
      }
    });
    commit.onclick = () => this.commit(msg.value, staged.length > 0);
    push.onclick = () => this.push();
    sync();
    box.append(msg, h("div", { class: "scm-actions" }, commit, push));
    el.appendChild(box);

    const cur = this.currentRel();
    const group = (title: string, files: typeof st.files, kind: "staged" | "changes") => {
      const head = h("div", { class: "scm-group", "data-group": kind });
      head.appendChild(h("span", { class: "scm-group-title" }, `${title}${files.length ? ` (${files.length})` : ""}`));
      const acts = h("span", { class: "scm-row-actions" });
      if (kind === "changes" && files.length) {
        acts.append(
          this.actionBtn(ICON.discard, "Discard All Changes", "discard-all", () => this.discard(files)),
          this.actionBtn(ICON.plus, "Stage All Changes", "stage-all", () => this.stage("all")),
        );
      }
      if (kind === "staged" && files.length) acts.append(this.actionBtn(ICON.minus, "Unstage All Changes", "unstage-all", () => this.unstage("all")));
      head.appendChild(acts);
      el.appendChild(head);
      const list = h("ul", { class: "scm-files", "data-list": kind });
      if (!files.length && kind === "changes") list.appendChild(h("li", { class: "scm-empty" }, staged.length ? "No unstaged changes" : "No changes"));
      for (const f of files) {
        const letter = kind === "staged" ? (f.index === "T" ? "M" : f.index) : statusLetter(f);
        const shown = letter === "?" ? "U" : letter;
        const li = h("li", { class: `scm-file${f.path === cur ? " active" : ""}`, title: f.path, "data-path": f.path });
        li.append(h("span", { class: "scm-name" }, f.path.split("/").pop()!), h("span", { class: "scm-dir" }, f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : ""));
        const rowActs = h("span", { class: "scm-row-actions" });
        if (kind === "changes") {
          rowActs.append(
            this.actionBtn(ICON.discard, "Discard Changes", "discard", () => this.discard([f])),
            this.actionBtn(ICON.plus, "Stage Changes", "stage", () => this.stage([f.path])),
          );
        } else rowActs.append(this.actionBtn(ICON.minus, "Unstage Changes", "unstage", () => this.unstage([f.path])));
        li.appendChild(rowActs);
        li.appendChild(h("span", { class: `scm-letter scm-${shown}`, title: LETTER_TITLE[letter] ?? letter }, shown));
        if (letter !== "D") li.onclick = () => this.app.openFile(this.app.abs(f.path));
        list.appendChild(li);
      }
      el.appendChild(list);
    };
    if (staged.length) group("Staged Changes", staged, "staged");
    group("Changes", unstaged, "changes");

    el.appendChild(h("div", { class: "scm-section", id: "scm-diff-title" }, "Changes in this file"));
    el.appendChild(h("div", { id: "scm-diff", class: "scm-diff" }));

    // history graph
    const histHead = h("button", { class: "scm-section scm-collapsible", "data-scm": "history" }, `${this.historyOpen ? "▾" : "▸"} History`);
    histHead.onclick = () => {
      this.historyOpen = !this.historyOpen;
      this.render();
      this.renderDiff();
    };
    el.appendChild(histHead);
    if (this.historyOpen) {
      const hist = h("div", { id: "scm-history", class: "scm-history" });
      el.appendChild(hist);
      this.renderHistory(hist);
    }
  }

  private actionBtn(icon: string, title: string, id: string, fn: () => void) {
    const b = h("button", { class: "scm-act", title, "aria-label": title, "data-act": id });
    b.innerHTML = icon;
    b.onclick = (e) => {
      e.stopPropagation();
      if (!this.busy) fn();
    };
    return b;
  }

  async stage(paths: string[] | "all") {
    await this.withBusy(() => this.app.backend.gitStage(this.app.root, paths));
  }

  async unstage(paths: string[] | "all") {
    await this.withBusy(() => this.app.backend.gitUnstage(this.app.root, paths));
  }

  async discard(files: GitStatus["files"]) {
    const untracked = files.filter((f) => f.index === "?").map((f) => f.path);
    const tracked = files.filter((f) => f.index !== "?").map((f) => f.path);
    const what = files.length === 1 ? files[0].path.split("/").pop() : `${files.length} files`;
    const { ok } = await confirmModal(
      `Discard changes in ${what}?`,
      untracked.length
        ? `${untracked.length === files.length ? "This will delete the untracked file" + (untracked.length > 1 ? "s" : "") : "Untracked files will be deleted"}. This can't be undone.`
        : "Your changes will be lost. This can't be undone.",
      { confirm: "Discard", danger: true },
    );
    if (!ok) return;
    if (this.app.current) await this.app.flushSave(this.app.current);
    await this.withBusy(async () => {
      const r = await this.app.backend.gitDiscard(this.app.root, tracked, untracked);
      if (!r.ok) this.app.setSaveStatus(`Discard failed: ${r.output.trim().split("\n")[0]}`, true);
      await this.app.reloadFromDisk([...tracked, ...untracked].map((p) => this.app.abs(p)));
    });
  }

  private async renderHistory(box: HTMLElement) {
    if (!this.status.hasCommits) {
      box.appendChild(h("div", { class: "scm-empty" }, "No commits yet"));
      return;
    }
    const rows = buildGraph(parseGitLog(await this.app.backend.gitLog(this.app.root, 200).catch(() => "")));
    box.innerHTML = "";
    const COL = 12;
    const H = 24;
    const colors = ["var(--accent)", "var(--tip)", "var(--warning)", "var(--important)", "var(--note)"];
    const X = (lane: number) => 8 + lane * COL;
    for (const r of rows) {
      const width = 8 + Math.max(1, r.width) * COL;
      let svg = `<svg class="scm-graph" width="${width}" height="${H}" viewBox="0 0 ${width} ${H}">`;
      for (const [a, b] of r.top) svg += `<path d="M${X(a)} 0 C ${X(a)} ${H / 4}, ${X(b)} ${H / 4}, ${X(b)} ${H / 2}" stroke="${colors[a % colors.length]}" />`;
      for (const [a, b] of r.bottom) svg += `<path d="M${X(a)} ${H / 2} C ${X(a)} ${(3 * H) / 4}, ${X(b)} ${(3 * H) / 4}, ${X(b)} ${H}" stroke="${colors[b % colors.length]}" />`;
      svg += `<circle cx="${X(r.col)}" cy="${H / 2}" r="3.6" fill="var(--bg-side)" stroke="${colors[r.col % colors.length]}" stroke-width="2" /></svg>`;
      const row = h("div", { class: "scm-commit-row", title: `${r.commit.hash.slice(0, 7)} · ${r.commit.author} · ${r.commit.date}\nClick to copy the commit hash` });
      row.innerHTML = svg;
      const text = h("div", { class: "scm-commit-text" });
      text.appendChild(h("span", { class: "scm-commit-msg" }, r.commit.subject));
      for (const ref of r.commit.refs) text.appendChild(h("span", { class: "scm-ref" }, ref.replace(/^tag: /, "🏷 ")));
      text.appendChild(h("span", { class: "scm-commit-meta" }, `${r.commit.author}, ${r.commit.date}`));
      row.appendChild(text);
      row.onclick = () => {
        navigator.clipboard?.writeText(r.commit.hash.slice(0, 7)).catch(() => {});
        this.app.setSaveStatus(`Copied ${r.commit.hash.slice(0, 7)}`);
      };
      box.appendChild(row);
    }
  }

  private note(title: string, text: string) {
    return h("div", { class: "scm-note" }, h("b", {}, title), h("span", {}, text));
  }

  /** Unified diff of the open file against HEAD, computed from the live editor text. */
  async renderDiff() {
    const box = document.getElementById("scm-diff");
    const title = document.getElementById("scm-diff-title");
    if (!box || !title) return;
    const rel = this.currentRel();
    const st = this.status;
    if (!rel) {
      box.innerHTML = `<div class="scm-empty">No file open</div>`;
      return;
    }
    title.textContent = `Changes in ${rel.split("/").pop()} since last commit`;
    if (!st.hasCommits) {
      box.innerHTML = `<div class="scm-empty">No commits yet — commit to start tracking changes.</div>`;
      return;
    }
    if (!this.headCache.has(rel)) {
      this.headCache.set(rel, await this.app.backend.gitShowHead(this.app.root, rel).catch(() => null));
    }
    const old = this.headCache.get(rel);
    if (rel !== this.currentRel()) return; // switched files meanwhile
    if (old === null || old === undefined) {
      box.innerHTML = `<div class="scm-empty">New file — not committed yet.</div>`;
      return;
    }
    const hunks = fileDiff(old, this.app.view.state.doc.toString());
    box.innerHTML = "";
    if (!hunks.length) {
      box.appendChild(h("div", { class: "scm-empty" }, "No changes since the last commit."));
      return;
    }
    for (const hk of hunks) {
      const hunk = h("div", { class: "scm-hunk", title: "Click to show in the editor" });
      hunk.appendChild(h("div", { class: "scm-hunk-head" }, `line ${hk.newStart}`));
      for (const l of hk.lines) {
        const row = h("div", { class: `scm-line scm-${l.kind}` });
        row.append(h("span", { class: "scm-ln" }, l.newLine != null ? String(l.newLine) : ""), h("span", { class: "scm-sign" }, l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "), h("span", { class: "scm-text" }, l.text || " "));
        hunk.appendChild(row);
      }
      const firstChange = hk.lines.find((l) => l.kind !== "ctx");
      const line = (firstChange?.newLine ?? hk.lines.find((l) => l.newLine != null && l.kind !== "del")?.newLine ?? hk.newStart) - 1;
      hunk.onclick = () => this.app.revealLine(Math.max(0, line));
      box.appendChild(hunk);
    }
  }

  private log(title: string) {
    $("#log-panel").hidden = false;
    $("#log-title").textContent = title;
    const log = $("#log");
    log.textContent = "";
    return (line: string) => {
      log.textContent += line + "\n";
      log.scrollTop = log.scrollHeight;
    };
  }

  private async withBusy<T>(fn: () => Promise<T>): Promise<T> {
    this.busy = true;
    this.render();
    try {
      return await fn();
    } finally {
      this.busy = false;
      await this.refresh(true);
    }
  }

  async init() {
    await this.withBusy(async () => {
      const r = await this.app.backend.gitInit(this.app.root);
      this.app.setSaveStatus(r.ok ? "Initialized git repository" : `git init failed: ${r.output.trim()}`, !r.ok);
    });
  }

  async commit(message: string, stagedOnly = false) {
    if (!message.trim()) return;
    if (this.app.current) await this.app.flushSave(this.app.current);
    await this.withBusy(async () => {
      // like VS Code: commit what is staged, or everything when nothing is staged
      if (!stagedOnly) await this.app.backend.gitStage(this.app.root, "all");
      let r = await this.app.backend.gitCommit(this.app.root, message.trim());
      if (!r.ok && /user\.email|user\.name|tell me who you are/i.test(r.output)) {
        const id = await formModal(
          "Who is committing?",
          [
            { name: "name", label: "Your name", placeholder: "Jane Doe" },
            { name: "email", label: "Email", placeholder: "jane@example.com" },
          ],
          "Save & commit",
        );
        if (!id || !id.name || !id.email) return;
        await this.app.backend.gitSetIdentity(this.app.root, String(id.name), String(id.email));
        r = await this.app.backend.gitCommit(this.app.root, message.trim());
      }
      if (r.ok) {
        this.app.setSaveStatus(`Committed: ${message.trim().split("\n")[0]}`);
        const box = document.getElementById("scm-message") as HTMLTextAreaElement | null;
        if (box) box.value = "";
        this.draft = "";
      } else {
        const done = this.log("Commit failed");
        r.output.split("\n").forEach(done);
      }
    });
  }

  async push() {
    let url: string | null = null;
    if (!this.status.remote) {
      const res = await formModal(
        "Connect repository",
        [
          {
            name: "url",
            label: "Repository URL — create an empty repository on GitHub (no README), then paste its URL",
            placeholder: "git@github.com:you/my-book.git  or  https://github.com/you/my-book.git",
          },
        ],
        "Connect & push",
      );
      if (!res || !res.url) return;
      url = String(res.url);
    }
    await this.withBusy(async () => {
      const out = this.log("Pushing…");
      const r = await this.app.backend.gitPush(this.app.root, url, out);
      $("#log-title").textContent = r.ok ? "Push complete" : "Push failed";
      if (!r.ok && /auth|permission denied|could not read username|403|publickey/i.test(r.output)) {
        out("");
        out("Hint: Folio uses your normal git login. Check that `git push` works in Terminal for this folder");
        out("(SSH key added to GitHub, or GitHub credentials saved in the macOS Keychain).");
      }
    });
  }

  private wireResizer() {
    const handle = $("#scm-resizer");
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startW = this.el.getBoundingClientRect().width;
      document.body.classList.add("resizing");
      const move = (ev: PointerEvent) => {
        this.el.style.width = `${Math.min(640, Math.max(240, startW - (ev.clientX - startX)))}px`;
      };
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        document.body.classList.remove("resizing");
        this.app.view.requestMeasure();
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
    });
    handle.addEventListener("dblclick", () => {
      this.el.style.width = "";
      this.app.view.requestMeasure();
    });
  }
}
