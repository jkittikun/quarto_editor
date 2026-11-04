import { h, fuzzyScore } from "./dom";
import { escapeHtml } from "../core/inline";
import { ctx } from "../editor/context";

/** ⌘P file switcher. */
export class QuickOpen {
  private overlay: HTMLDivElement;
  private input: HTMLInputElement;
  private list: HTMLUListElement;
  private files: string[] = [];
  private shown: string[] = [];
  private sel = 0;

  constructor(private onPick: (rel: string) => void) {
    this.input = h("input", { type: "text", placeholder: "Go to file or chapter…", spellcheck: "false" });
    this.list = h("ul", {});
    this.overlay = h("div", { class: "quick-open", hidden: "" }, h("div", { class: "qo-box" }, this.input, this.list));
    document.body.appendChild(this.overlay);
    this.overlay.addEventListener("mousedown", (e) => {
      if (e.target === this.overlay) this.hide();
    });
    this.input.addEventListener("input", () => this.update());
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") this.move(1);
      else if (e.key === "ArrowUp") this.move(-1);
      else if (e.key === "Enter") this.pick(this.shown[this.sel]);
      else if (e.key === "Escape") this.hide();
      else return;
      e.preventDefault();
    });
  }

  show(files: string[]) {
    this.files = files;
    this.overlay.hidden = false;
    this.input.value = "";
    this.update();
    this.input.focus();
  }

  hide() {
    this.overlay.hidden = true;
  }

  private title(f: string) {
    return ctx.index.chapters.get(f)?.title ?? "";
  }

  private update() {
    const q = this.input.value.trim();
    this.shown = this.files
      .map((f) => ({ f, s: Math.max(fuzzyScore(q, f), fuzzyScore(q, this.title(f))) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 50)
      .map((x) => x.f);
    this.sel = 0;
    this.list.innerHTML = "";
    this.shown.forEach((f, i) => {
      const li = h("li", { class: i === 0 ? "sel" : "" });
      const t = this.title(f);
      li.innerHTML = t ? `<span>${escapeHtml(t)}</span><small>${escapeHtml(f)}</small>` : `<span>${escapeHtml(f)}</span>`;
      li.onmousedown = (e) => {
        e.preventDefault();
        this.pick(f);
      };
      this.list.appendChild(li);
    });
  }

  private move(d: number) {
    if (!this.shown.length) return;
    this.sel = (this.sel + d + this.shown.length) % this.shown.length;
    [...this.list.children].forEach((c, i) => c.classList.toggle("sel", i === this.sel));
    this.list.children[this.sel]?.scrollIntoView({ block: "nearest" });
  }

  private pick(f: string | undefined) {
    if (!f) return;
    this.hide();
    this.onPick(f);
  }
}
