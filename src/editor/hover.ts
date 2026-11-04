/**
 * Hover cards: previews of cross-reference targets, citations, footnotes and index entries.
 * DOM-based (rendered widgets carry the data), shown after a short delay.
 */
import { ViewPlugin, type EditorView } from "@codemirror/view";
import { previewTarget } from "../core/preview";
import { formatReference } from "../core/bibtex";
import { isXrefLabel } from "../core/xref";
import { escapeHtml } from "../core/inline";
import { joinPath, dirname } from "../backend/types";
import { ctx } from "./context";
import { renderMath, md, inlineCtx, tableHtml } from "./widgets";

function resolveFrom(file: string, src: string): string {
  if (/^(https?:|data:)/.test(src)) return src;
  return ctx.fileUrl(src.startsWith("/") ? joinPath(ctx.root, src) : joinPath(dirname(file), decodeURI(src)));
}

/** HTML for an @key / [@a; @b] reference, or null when there is nothing to show. */
export function previewForKeys(keys: string[]): string | null {
  const parts: string[] = [];
  for (const key of keys) {
    if (isXrefLabel(key)) {
      const t = ctx.index.targets.get(key);
      if (!t) {
        parts.push(`<div class="pv"><div class="pv-head pv-missing">Unresolved reference @${escapeHtml(key)}</div></div>`);
        continue;
      }
      const abs = joinPath(ctx.root, t.file);
      const src = ctx.sourceOf(abs) ?? "";
      parts.push(
        previewTarget(t, src, {
          ...inlineCtx,
          math: renderMath,
          image: (s) => resolveFrom(abs, s),
          table: tableHtml,
        }) + (abs !== ctx.file ? `<div class="pv-file">${escapeHtml(t.file)} · ⌘-click to open</div>` : ""),
      );
    } else {
      const e = ctx.bib.get(key);
      parts.push(
        e
          ? `<div class="pv pv-cite">${md(formatReference(e))}</div>`
          : `<div class="pv"><div class="pv-head pv-missing">No bibliography entry for ${escapeHtml(key)}</div></div>`,
      );
    }
  }
  return parts.length ? parts.join("") : null;
}

export const hoverPreviews = ViewPlugin.fromClass(
  class {
    card: HTMLDivElement | null = null;
    timer: ReturnType<typeof setTimeout> | null = null;
    current: HTMLElement | null = null;
    constructor(readonly view: EditorView) {
      view.contentDOM.addEventListener("mouseover", this.over);
      view.contentDOM.addEventListener("mouseout", this.out);
      view.scrollDOM.addEventListener("scroll", this.hide, { passive: true });
    }
    over = (e: MouseEvent) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>(".cm-ref, .cm-fn, .cm-index-mark");
      if (!el || el === this.current) return;
      this.current = el;
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => this.show(el), 300);
    };
    out = (e: MouseEvent) => {
      const to = e.relatedTarget as HTMLElement | null;
      if (to && (this.current?.contains(to) || this.card?.contains(to))) return;
      this.hide();
    };
    show(el: HTMLElement) {
      let html: string | null = null;
      if ((el as any).folioPreview) html = (el as any).folioPreview();
      else if (el.dataset.keys || el.dataset.ref) html = previewForKeys((el.dataset.keys ?? el.dataset.ref!).split(";").filter(Boolean));
      if (!html) return;
      this.card?.remove();
      const card = document.createElement("div");
      card.className = "hover-card";
      card.innerHTML = html;
      card.addEventListener("mouseleave", () => this.hide());
      document.body.appendChild(card);
      const r = el.getBoundingClientRect();
      const w = Math.min(420, window.innerWidth - 24);
      card.style.width = `${w}px`;
      card.style.left = `${Math.max(12, Math.min(r.left, window.innerWidth - w - 12))}px`;
      const below = r.bottom + 8;
      card.style.top = `${below}px`;
      requestAnimationFrame(() => {
        const h = card.getBoundingClientRect().height;
        if (below + h > window.innerHeight - 8 && r.top - h - 8 > 0) card.style.top = `${r.top - h - 8}px`;
      });
      this.card = card;
    }
    hide = () => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.current = null;
      this.card?.remove();
      this.card = null;
    };
    destroy() {
      this.hide();
      this.view.contentDOM.removeEventListener("mouseover", this.over);
      this.view.contentDOM.removeEventListener("mouseout", this.out);
      this.view.scrollDOM.removeEventListener("scroll", this.hide);
    }
  },
);
