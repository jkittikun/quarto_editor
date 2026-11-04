/**
 * Source-control panel (right sidebar): init, changed files, commit, push, and a live diff of the
 * open file against the last commit.
 */
import type { App } from "./app";
import { fileDiff, statusLetter, NO_REPO, type GitStatus } from "../core/git";
import { escapeHtml } from "../core/inline";
import { formModal } from "./modal";
import { $, h, debounce } from "./dom";

const LETTER_TITLE: Record<string, string> = { M: "Modified", A: "Added", D: "Deleted", R: "Renamed", U: "Conflict", "?": "Untracked" };

export class ScmPanel {
  status: GitStatus = NO_REPO;
  open = false;
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

    // commit box
    const box = h("div", { class: "scm-commit" });
    const msg = h("textarea", { id: "scm-message", rows: "2", placeholder: "Commit message (⌘↵ to commit)" });
    const commit = h("button", { class: "primary", "data-scm": "commit" }, "Commit");
    const push = h("button", { "data-scm": "push" }, st.remote ? (st.ahead ? `Push ↑${st.ahead}` : "Push") : "Publish…");
    const sync = () => {
      commit.disabled = this.busy || !msg.value.trim() || !st.files.length;
      push.disabled = this.busy || !st.hasCommits;
    };
    msg.addEventListener("input", sync);
    msg.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        if (!commit.disabled) this.commit(msg.value);
      }
    });
    commit.onclick = () => this.commit(msg.value);
    push.onclick = () => this.push();
    sync();
    box.append(msg, h("div", { class: "scm-actions" }, commit, push));
    el.appendChild(box);

    // changed files
    el.appendChild(h("div", { class: "scm-section" }, `Changes${st.files.length ? ` (${st.files.length})` : ""}`));
    const list = h("ul", { class: "scm-files" });
    if (!st.files.length) list.appendChild(h("li", { class: "scm-empty" }, "No changes"));
    const cur = this.currentRel();
    for (const f of st.files) {
      const letter = statusLetter(f);
      const li = h("li", { class: `scm-file${f.path === cur ? " active" : ""}`, title: f.path });
      li.append(h("span", { class: "scm-name" }, f.path.split("/").pop()!), h("span", { class: "scm-dir" }, f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : ""));
      li.appendChild(h("span", { class: `scm-letter scm-${letter === "?" ? "U" : letter}`, title: LETTER_TITLE[letter] ?? letter }, letter === "?" ? "U" : letter));
      if (letter !== "D") li.onclick = () => this.app.openFile(this.app.abs(f.path));
      list.appendChild(li);
    }
    el.appendChild(list);

    el.appendChild(h("div", { class: "scm-section", id: "scm-diff-title" }, "Changes in this file"));
    el.appendChild(h("div", { id: "scm-diff", class: "scm-diff" }));
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

  async commit(message: string) {
    if (!message.trim()) return;
    if (this.app.current) await this.app.flushSave(this.app.current);
    await this.withBusy(async () => {
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
        "Publish repository",
        [{ name: "url", label: "Remote URL (create an empty repository on GitHub first)", placeholder: "git@github.com:you/my-book.git" }],
        "Push",
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
