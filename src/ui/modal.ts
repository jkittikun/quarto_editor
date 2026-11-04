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
