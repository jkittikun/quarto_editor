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
  runAbove(view: import("@codemirror/view").EditorView): void;
  kernelAvailable: boolean;
  /** Output formats declared by the project (_quarto.yml `format:` keys). */
  projectFormats: string[];
  /** Reader view: read-only, rendered like the HTML book (no source reveal). */
  reader: boolean;
  /** Source text of another project file (absolute path), or null if not loaded yet (loading starts). */
  sourceOf(absPath: string): string | null;
  openFile(absPath: string): void;
  /** Mount a read-only live-preview editor for included content. */
  makeIncludeView(parent: HTMLElement, text: string): void;
  toggleReader(): void;
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
  runAbove: () => {},
  kernelAvailable: true,
  projectFormats: [],
  reader: false,
  sourceOf: () => null,
  openFile: () => {},
  makeIncludeView: () => {},
  toggleReader: () => {},
};

/** Dispatch to force decorations to be recomputed after the context changed. */
export const refreshEffect = StateEffect.define<null>();

export type CellOutputs = {
  outputs: KernelOutput[];
  running: boolean;
  req: string | null;
  hash: string;
  error?: string;
  source?: "freeze"; // outputs read from Quarto's _freeze (last quarto render)
};

/** Switch the visible tab of a `.panel-tabset` (by tabset ordinal in the document). */
export const setTabEffect = StateEffect.define<{ tabset: number; tab: number }>();

/** Expand/collapse a callout (by callout ordinal in the document). */
export const toggleCalloutEffect = StateEffect.define<{ callout: number; collapsed: boolean }>();

/**
 * Mark the editor as actively edited: source is revealed around the cursor only after the
 * selection has been placed while focused (see focusField in livePreview.ts).
 */
export const activateEffect = StateEffect.define<null>();
