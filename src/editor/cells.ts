import { StateEffect, StateField, MapMode, type EditorState } from "@codemirror/state";
import { syntaxTree, ensureSyntaxTree } from "@codemirror/language";
import { load } from "js-yaml";
import type { KernelMsg, KernelOutput } from "../backend/types";
import type { CellOutputs } from "./context";

export function hashCode(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

export const setCellEffect = StateEffect.define<{ pos: number; value: CellOutputs | null }>({
  map: (v, ch) => ({ ...v, pos: ch.mapPos(v.pos) }),
});
export const kernelMsgEffect = StateEffect.define<KernelMsg>();
export const loadOutputsEffect = StateEffect.define<Map<number, CellOutputs>>();

function applyMsg(st: CellOutputs, msg: KernelMsg): CellOutputs {
  switch (msg.type) {
    case "status":
      return { ...st, running: msg.state !== "restarted" };
    case "clear":
      return { ...st, outputs: [] };
    case "done":
      return { ...st, running: false, req: null, error: msg.error };
    case "stream": {
      const outs = st.outputs.slice();
      const last = outs[outs.length - 1];
      if (last && last.type === "stream" && last.name === msg.name) outs[outs.length - 1] = { ...last, text: last.text + msg.text };
      else outs.push({ type: "stream", name: msg.name, text: msg.text });
      return { ...st, outputs: outs };
    }
    default: {
      const { req: _r, ...out } = msg as any;
      return { ...st, outputs: [...st.outputs, out as KernelOutput] };
    }
  }
}

/** Outputs of executed cells, keyed by the position of the cell's opening fence. */
export const outputsField = StateField.define<Map<number, CellOutputs>>({
  create: () => new Map(),
  update(map, tr) {
    let m = map;
    if (tr.docChanged && m.size) {
      const next = new Map<number, CellOutputs>();
      for (const [pos, v] of m) {
        const np = tr.changes.mapPos(pos, 1, MapMode.TrackDel);
        if (np !== null) next.set(np, v);
      }
      m = next;
    }
    for (const e of tr.effects) {
      if (e.is(loadOutputsEffect)) m = new Map(e.value);
      else if (e.is(setCellEffect)) {
        m = new Map(m);
        if (e.value.value) m.set(e.value.pos, e.value.value);
        else m.delete(e.value.pos);
      } else if (e.is(kernelMsgEffect)) {
        for (const [pos, v] of m) {
          if (v.req === e.value.req) {
            m = new Map(m);
            m.set(pos, applyMsg(v, e.value));
            break;
          }
        }
      }
    }
    return m;
  },
});

export interface CellInfo {
  pos: number; // opening fence position
  lang: string;
  executable: boolean;
  code: string;
  options: Record<string, string>;
  closeLineEnd: number;
  codeFrom: number;
  codeTo: number;
}

export function parseInfo(info: string): { lang: string; executable: boolean } {
  const executable = /^\s*\{/.test(info);
  const lang = info.replace(/[{}]/g, " ").trim().split(/[\s,]+/)[0]?.toLowerCase() ?? "";
  return { lang: lang.replace(/^\./, ""), executable };
}

/**
 * Leading `#|` cell options, parsed as YAML (so lists like `fig-subcap: [A, B]` or multi-line
 * `#|   - A` work). Scalars become strings; lists/objects are JSON-encoded strings.
 */
export function cellOptions(code: string): Record<string, string> {
  const lines: string[] = [];
  for (const line of code.split("\n")) {
    const m = /^\s*(?:#|%%|\/\/)\|\s?(.*)$/.exec(line);
    if (!m) {
      if (line.trim()) break;
      continue;
    }
    lines.push(m[1]);
  }
  const opts: Record<string, string> = {};
  if (!lines.length) return opts;
  let parsed: unknown = null;
  try {
    parsed = load(lines.join("\n"));
  } catch {
    parsed = null;
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      opts[k] = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    }
    return opts;
  }
  // not valid YAML: fall back to simple "key: value" lines
  for (const l of lines) {
    const m = /^([\w-]+)\s*:\s*(.*?)\s*$/.exec(l);
    if (m) opts[m[1]] = m[2].replace(/^["'](.*)["']$/, "$1");
  }
  return opts;
}

/** A list-valued option (JSON-encoded by cellOptions), e.g. fig-subcap. */
export function optionList(v: string | undefined): string[] {
  if (!v) return [];
  try {
    const x = JSON.parse(v);
    return Array.isArray(x) ? x.map(String) : [String(x)];
  } catch {
    return [v];
  }
}

export function listCells(state: EditorState): CellInfo[] {
  const tree = ensureSyntaxTree(state, state.doc.length, 200) ?? syntaxTree(state);
  const out: CellInfo[] = [];
  tree.iterate({
    enter(n) {
      if (n.name !== "FencedCode") return;
      const info = n.node.getChild("CodeInfo");
      const { lang, executable } = parseInfo(info ? state.doc.sliceString(info.from, info.to) : "");
      const first = state.doc.lineAt(n.from);
      const last = state.doc.lineAt(n.to);
      const closed = last.number > first.number && /^\s*(`{3,}|~{3,})\s*$/.test(last.text);
      const codeFrom = Math.min(first.to + 1, state.doc.length);
      const codeTo = closed ? Math.max(codeFrom, last.from - 1) : n.to;
      const code = state.doc.sliceString(codeFrom, codeTo);
      out.push({ pos: n.from, lang, executable, code, options: cellOptions(code), closeLineEnd: last.to, codeFrom, codeTo });
      return false;
    },
  });
  return out;
}

export interface CachedCell {
  index: number;
  hash: string;
  outputs: KernelOutput[];
}

export function serializeOutputs(state: EditorState): CachedCell[] {
  const outs = state.field(outputsField);
  return listCells(state)
    .map((c, index) => ({ c, index, o: outs.get(c.pos) }))
    .filter((x) => x.o && x.o.outputs.length && !x.o.running)
    .map((x) => ({ index: x.index, hash: x.o!.hash, outputs: x.o!.outputs }));
}

/** Match cached outputs to cells by code hash first, then by position in the document. */
export function matchCachedOutputs(state: EditorState, cached: CachedCell[]): Map<number, CellOutputs> {
  const cells = listCells(state).filter((c) => c.executable);
  const all = listCells(state);
  const map = new Map<number, CellOutputs>();
  const used = new Set<number>();
  const byHash = new Map(cells.map((c) => [hashCode(c.code), c]));
  for (const entry of cached) {
    const c = byHash.get(entry.hash);
    if (c && !used.has(c.pos)) {
      used.add(c.pos);
      map.set(c.pos, { outputs: entry.outputs, running: false, req: null, hash: entry.hash });
    }
  }
  for (const entry of cached) {
    const c = all[entry.index];
    if (c && c.executable && !used.has(c.pos) && ![...map.values()].some((v) => v.hash === entry.hash)) {
      used.add(c.pos);
      map.set(c.pos, { outputs: entry.outputs, running: false, req: null, hash: entry.hash });
    }
  }
  return map;
}
