/** Shared, mutable editor context: project-wide knowledge the decorations need. */
import { StateEffect } from "@codemirror/state";
import type { XrefIndex, XrefTarget, HeadingNumber } from "../core/xref";
import type { BibEntry } from "../core/bibtex";
import type { KernelOutput } from "../backend/types";

export interface EditorContext {
  root: string;
  file: string; // absolute path of the open document
  index: XrefIndex;
  headings: HeadingNumber[]; // for the open document
  bib: Map<string, BibEntry>;
  fileUrl(absPath: string): string;
  resolvePath(rel: string): string; // relative to the open document
  openRef(target: XrefTarget): void;
  openLink(url: string): void;
  runCell(view: import("@codemirror/view").EditorView, fencePos: number): void;
  kernelAvailable: boolean;
}

export const ctx: EditorContext = {
  root: "",
  file: "",
  index: { targets: new Map(), chapters: new Map() },
  headings: [],
  bib: new Map(),
  fileUrl: (p) => p,
  resolvePath: (p) => p,
  openRef: () => {},
  openLink: () => {},
  runCell: () => {},
  kernelAvailable: true,
};

/** Dispatch to force decorations to be recomputed after the context changed. */
export const refreshEffect = StateEffect.define<null>();

export type CellOutputs = { outputs: KernelOutput[]; running: boolean; req: string | null; hash: string; error?: string };

/** Switch the visible tab of a `.panel-tabset` (by tabset ordinal in the document). */
export const setTabEffect = StateEffect.define<{ tabset: number; tab: number }>();
