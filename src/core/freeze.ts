/**
 * Read cell outputs from Quarto's freezer (`_freeze/<chapter>/execute-results/html.json`) so
 * chapters show the outputs of the last `quarto render` without re-running anything.
 */
import type { KernelOutput } from "../backend/types";

export interface FrozenCell {
  index: number;
  outputs: KernelOutput[];
}

/** Path of the freeze file for a chapter, relative to the project root. */
export function freezePath(relChapter: string): { json: string; dir: string } {
  const base = relChapter.replace(/\.[^./]+$/, "");
  return { json: `_freeze/${base}/execute-results/html.json`, dir: `_freeze/${base}` };
}

const DIV_OPEN = /^\s*(:{3,})\s*\{([^}]*)\}\s*$/;
const DIV_CLOSE = /^\s*:{3,}\s*$/;
const FENCE = /^\s*(`{3,}|~{3,})\s*(.*)$/;

interface Block {
  classes: string;
  body: string[];
}

/** Split markdown into top-level `.cell` divs, each with its `.cell-output*` child divs. */
function cellsOf(markdown: string): Block[][] {
  const lines = markdown.split(/\r?\n/);
  const cells: Block[][] = [];
  let depth = 0;
  let cur: Block[] | null = null;
  let out: Block | null = null;
  let outDepth = -1;
  let fence: string | null = null;
  for (const line of lines) {
    const f = FENCE.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !f[2].trim()) fence = null;
      out?.body.push(line);
      continue;
    }
    if (f) {
      fence = f[1];
      out?.body.push(line);
      continue;
    }
    const o = DIV_OPEN.exec(line);
    if (o) {
      depth++;
      const attrs = o[2];
      if (depth === 1 && /(^|\s)\.cell(\s|$)/.test(attrs)) {
        cur = [];
        cells.push(cur);
      } else if (cur && !out && /\.cell-output/.test(attrs)) {
        out = { classes: attrs, body: [] };
        outDepth = depth;
        cur.push(out);
      } else out?.body.push(line);
      continue;
    }
    if (DIV_CLOSE.test(line)) {
      if (out && depth === outDepth) {
        out = null;
        outDepth = -1;
      } else out?.body.push(line);
      depth = Math.max(0, depth - 1);
      if (depth === 0) cur = null;
      continue;
    }
    out?.body.push(line);
  }
  return cells;
}

function fencedContent(body: string[]): { info: string; text: string }[] {
  const res: { info: string; text: string }[] = [];
  let cur: { info: string; lines: string[]; marker: string } | null = null;
  for (const line of body) {
    const f = FENCE.exec(line);
    if (cur) {
      if (f && f[1][0] === cur.marker[0] && f[1].length >= cur.marker.length && !f[2].trim()) {
        res.push({ info: cur.info, text: cur.lines.join("\n") });
        cur = null;
      } else cur.lines.push(line);
      continue;
    }
    if (f) cur = { info: f[2].trim(), lines: [], marker: f[1] };
  }
  return res;
}

/**
 * Parse a freeze JSON file. `freezeDirAbs` is the absolute `_freeze/<chapter>` folder, used to
 * resolve figure paths (Quarto stores them under `<freezeDir>/figure-html/`).
 */
export function parseFreeze(json: string, freezeDirAbs: string): FrozenCell[] {
  let data: any;
  try {
    data = JSON.parse(json);
  } catch {
    return [];
  }
  const md: string = data?.result?.markdown ?? "";
  return cellsOf(md).map((blocks, index) => {
    const outputs: KernelOutput[] = [];
    for (const b of blocks) {
      const code = fencedContent(b.body);
      if (/cell-output-stdout/.test(b.classes) || /cell-output-stderr/.test(b.classes)) {
        const name = /stderr/.test(b.classes) ? "stderr" : "stdout";
        outputs.push({ type: "stream", name, text: code.map((c) => c.text).join("\n") + "\n" });
      } else if (/cell-output-error/.test(b.classes)) {
        const text = code.map((c) => c.text).join("\n");
        const last = text.trim().split("\n").pop() ?? "";
        const m = /^(\w+(?:Error|Exception|Warning)?):\s*(.*)$/.exec(last);
        outputs.push({ type: "error", ename: m?.[1] ?? "Error", evalue: m?.[2] ?? last, traceback: text.split("\n") });
      } else {
        const html = code.filter((c) => /^\{=html\}$/.test(c.info)).map((c) => c.text).join("\n");
        if (html) {
          outputs.push({ type: "display", data: { "text/html": html } });
          continue;
        }
        const body = b.body.filter((l) => !FENCE.test(l)).join("\n").trim();
        const img = /!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/.exec(body);
        if (img) {
          const file = img[2].split("/").pop()!;
          const path = /^https?:|^data:/.test(img[2]) ? img[2] : `${freezeDirAbs}/figure-html/${decodeURIComponent(file)}`;
          outputs.push({ type: "display", data: { "image/x-folio-path": path, "text/plain": img[1] } });
        } else if (code.length) {
          outputs.push({ type: "display", data: { "text/plain": code.map((c) => c.text).join("\n") } });
        } else if (body) {
          outputs.push({ type: "display", data: { "text/markdown": body } });
        }
      }
    }
    return { index, outputs };
  });
}
