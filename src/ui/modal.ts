import { h } from "./dom";

export interface Field {
  name: string;
  label: string;
  type?: "text" | "checkbox";
  value?: string | boolean;
  placeholder?: string;
}

export interface Choice {
  id: string;
  label: string;
  description?: string;
}

function overlay(box: HTMLElement, onCancel: () => void): { close: () => void } {
  const ov = h("div", { class: "quick-open modal" }, box);
  document.body.appendChild(ov);
  const close = () => {
    ov.remove();
    document.removeEventListener("keydown", onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      onCancel();
    }
  };
  document.addEventListener("keydown", onKey, true);
  ov.addEventListener("mousedown", (e) => {
    if (e.target === ov) {
      close();
      onCancel();
    }
  });
  return { close };
}

/** Show a small form; resolves with the values, or null when cancelled. */
export function formModal(title: string, fields: Field[], submit = "Create"): Promise<Record<string, string | boolean> | null> {
  return new Promise((resolve) => {
    const form = h("form", { class: "qo-box modal-box" });
    form.appendChild(h("div", { class: "modal-title" }, title));
    const inputs = new Map<string, HTMLInputElement>();
    for (const f of fields) {
      const input = h("input", { type: f.type ?? "text", name: f.name, placeholder: f.placeholder ?? "", spellcheck: "false" });
      if (f.type === "checkbox") input.checked = !!f.value;
      else input.value = String(f.value ?? "");
      inputs.set(f.name, input);
      form.appendChild(
        f.type === "checkbox"
          ? h("label", { class: "modal-check" }, input, " ", f.label)
          : h("label", { class: "modal-field" }, h("span", {}, f.label), input),
      );
    }
    const cancel = h("button", { type: "button" }, "Cancel");
    form.appendChild(h("div", { class: "modal-actions" }, cancel, h("button", { type: "submit", class: "primary" }, submit)));
    const { close } = overlay(form, () => resolve(null));
    cancel.onclick = () => {
      close();
      resolve(null);
    };
    form.onsubmit = (e) => {
      e.preventDefault();
      const out: Record<string, string | boolean> = {};
      for (const [k, i] of inputs) out[k] = i.type === "checkbox" ? i.checked : i.value.trim();
      close();
      resolve(out);
    };
    (form.querySelector("input:not([type=checkbox])") as HTMLInputElement | null)?.focus();
  });
}

/** Show a list of choices; resolves with the chosen id, or null when cancelled. */
export function choiceModal(title: string, text: string, choices: Choice[]): Promise<string | null> {
  return new Promise((resolve) => {
    const box = h("div", { class: "qo-box modal-box" });
    box.appendChild(h("div", { class: "modal-title" }, title));
    if (text) box.appendChild(h("p", { class: "modal-text" }, text));
    const { close } = overlay(box, () => resolve(null));
    for (const c of choices) {
      const b = h("button", { class: "modal-choice", "data-choice": c.id }, h("b", {}, c.label));
      if (c.description) b.appendChild(h("small", {}, c.description));
      b.onclick = () => {
        close();
        resolve(c.id);
      };
      box.appendChild(b);
    }
    (box.querySelector("button") as HTMLButtonElement | null)?.focus();
  });
}

/** Confirmation dialog; resolves with `{ ok, checked }` (checked = optional checkbox state). */
export function confirmModal(
  title: string,
  text: string,
  opts: { confirm?: string; danger?: boolean; checkbox?: { label: string; value: boolean } } = {},
): Promise<{ ok: boolean; checked: boolean }> {
  return new Promise((resolve) => {
    const box = h("div", { class: "qo-box modal-box", role: "alertdialog" });
    box.appendChild(h("div", { class: "modal-title" }, title));
    if (text) box.appendChild(h("p", { class: "modal-text" }, text));
    let check: HTMLInputElement | null = null;
    if (opts.checkbox) {
      check = h("input", { type: "checkbox", name: "confirm-check" });
      check.checked = opts.checkbox.value;
      box.appendChild(h("label", { class: "modal-check" }, check, " ", opts.checkbox.label));
    }
    const cancel = h("button", { type: "button" }, "Cancel");
    const ok = h("button", { type: "button", class: opts.danger ? "danger" : "primary", "data-confirm": "" }, opts.confirm ?? "OK");
    box.appendChild(h("div", { class: "modal-actions" }, cancel, ok));
    const { close } = overlay(box, () => resolve({ ok: false, checked: false }));
    cancel.onclick = () => {
      close();
      resolve({ ok: false, checked: false });
    };
    ok.onclick = () => {
      close();
      resolve({ ok: true, checked: !!check?.checked });
    };
    cancel.focus();
  });
}

export interface PickItem {
  id: string;
  label: string;
  detail?: string;
  group?: string;
  badge?: string;
  selected?: boolean;
}

/** Filterable picker (like VS Code's quick pick); resolves with the chosen id, or null. */
export function pickModal(title: string, items: PickItem[], placeholder = "Filter…"): Promise<string | null> {
  return new Promise((resolve) => {
    const input = h("input", { type: "text", placeholder, spellcheck: "false" });
    const list = h("ul", { class: "pick-list" });
    const box = h("div", { class: "qo-box pick-box" }, h("div", { class: "modal-title pick-title" }, title), input, list);
    const { close } = overlay(box, () => resolve(null));
    let shown: PickItem[] = [];
    let sel = 0;
    const done = (id: string | null) => {
      close();
      resolve(id);
    };
    const draw = () => {
      const q = input.value.trim().toLowerCase();
      shown = items.filter((i) => !q || `${i.label} ${i.detail ?? ""} ${i.group ?? ""}`.toLowerCase().includes(q));
      sel = Math.max(0, Math.min(sel, shown.length - 1));
      list.innerHTML = "";
      let group: string | undefined;
      shown.forEach((it, idx) => {
        if (it.group && it.group !== group) {
          group = it.group;
          list.appendChild(h("li", { class: "pick-group" }, group));
        }
        const li = h("li", { class: `pick-item${idx === sel ? " sel" : ""}`, "data-id": it.id });
        li.appendChild(h("span", { class: "pick-label" }, (it.selected ? "✓ " : "") + it.label));
        if (it.badge) li.appendChild(h("span", { class: "pick-badge" }, it.badge));
        if (it.detail) li.appendChild(h("small", {}, it.detail));
        li.onmousedown = (e) => {
          e.preventDefault();
          done(it.id);
        };
        list.appendChild(li);
      });
    };
    input.addEventListener("input", () => {
      sel = 0;
      draw();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") sel = Math.min(sel + 1, shown.length - 1);
      else if (e.key === "ArrowUp") sel = Math.max(sel - 1, 0);
      else if (e.key === "Enter") return shown[sel] && done(shown[sel].id);
      else return;
      e.preventDefault();
      draw();
      list.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
    });
    draw();
    input.focus();
  });
}
