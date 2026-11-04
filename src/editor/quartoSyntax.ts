/**
 * Lezer Markdown extensions for Quarto/Pandoc syntax:
 * YAML front matter, display math, fenced divs (:::), inline math, citations,
 * @-references, shortcodes and attribute blocks.
 */
import type { MarkdownConfig, BlockContext, Line, InlineContext } from "@lezer/markdown";
import { tags as t } from "@lezer/highlight";
import { parseBracketCitation } from "../core/cite";

const DOLLAR = 36, AT = 64, BRACKET = 91, BRACE = 123, COLON = 58, BACKSLASH = 92;

function isWord(ch: number) {
  return (ch >= 48 && ch <= 57) || (ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122) || ch === 95;
}

const frontMatter = {
  name: "FrontMatter",
  before: "HorizontalRule",
  parse(cx: BlockContext, line: Line) {
    if (cx.lineStart !== 0 || !/^---\s*$/.test(line.text)) return false;
    const start = cx.lineStart;
    const marks = [cx.elt("FrontMatterMark", start, start + 3)];
    let end = -1;
    while (cx.nextLine()) {
      if (/^(---|\.\.\.)\s*$/.test(line.text)) {
        marks.push(cx.elt("FrontMatterMark", cx.lineStart, cx.lineStart + 3));
        end = cx.lineStart + line.text.length;
        cx.nextLine();
        break;
      }
    }
    if (end < 0) end = cx.prevLineEnd();
    cx.addElement(cx.elt("FrontMatter", start, end, marks));
    return true;
  },
};

function startsDisplayMath(line: Line) {
  return line.next === DOLLAR && line.text.charCodeAt(line.pos + 1) === DOLLAR;
}

const displayMath = {
  name: "DisplayMath",
  before: "FencedCode",
  parse(cx: BlockContext, line: Line) {
    if (!startsDisplayMath(line)) return false;
    const from = cx.lineStart + line.pos;
    const children = [cx.elt("DisplayMathMark", from, from + 2)];
    const rest = line.text.slice(line.pos + 2);
    const close = rest.indexOf("$$");
    let to: number;
    if (close >= 0) {
      const cpos = from + 2 + close;
      children.push(cx.elt("DisplayMathMark", cpos, cpos + 2));
      to = cx.lineStart + line.text.length;
      cx.nextLine();
    } else {
      to = -1;
      while (cx.nextLine()) {
        const idx = line.text.indexOf("$$");
        if (idx >= 0) {
          children.push(cx.elt("DisplayMathMark", cx.lineStart + idx, cx.lineStart + idx + 2));
          to = cx.lineStart + line.text.length;
          cx.nextLine();
          break;
        }
      }
      if (to < 0) to = cx.prevLineEnd();
    }
    cx.addElement(cx.elt("DisplayMath", from, to, children));
    return true;
  },
  endLeaf(_cx: BlockContext, line: Line) {
    return startsDisplayMath(line);
  },
};

function isDivFence(line: Line) {
  return line.next === COLON && /^:{3,}/.test(line.text.slice(line.pos));
}

const divFence = {
  name: "DivFence",
  before: "FencedCode",
  parse(cx: BlockContext, line: Line) {
    if (!isDivFence(line)) return false;
    const from = cx.lineStart + line.pos;
    cx.addElement(cx.elt("DivFence", from, cx.lineStart + line.text.length));
    cx.nextLine();
    return true;
  },
  endLeaf(_cx: BlockContext, line: Line) {
    return isDivFence(line);
  },
};

const inlineMath = {
  name: "InlineMath",
  before: "Escape",
  parse(cx: InlineContext, next: number, pos: number) {
    if (next !== DOLLAR || cx.char(pos - 1) === BACKSLASH) return -1;
    if (cx.char(pos + 1) === DOLLAR) {
      // $$...$$ inline (display math inside a paragraph)
      for (let i = pos + 2; i < cx.end - 1; i++) {
        if (cx.char(i) === BACKSLASH) { i++; continue; }
        if (cx.char(i) === DOLLAR && cx.char(i + 1) === DOLLAR) {
          return cx.addElement(cx.elt("InlineMath", pos, i + 2, [
            cx.elt("InlineMathMark", pos, pos + 2),
            cx.elt("InlineMathMark", i, i + 2),
          ]));
        }
      }
      return -1;
    }
    const first = cx.char(pos + 1);
    if (first === 32 || first === 9 || first === 10 || first < 0) return -1;
    for (let i = pos + 1; i < cx.end; i++) {
      const ch = cx.char(i);
      if (ch === BACKSLASH) { i++; continue; }
      if (ch === DOLLAR) {
        const prev = cx.char(i - 1);
        const after = cx.char(i + 1);
        if (prev === 32 || prev === 9 || prev === 10 || (after >= 48 && after <= 57)) return -1;
        return cx.addElement(cx.elt("InlineMath", pos, i + 1, [
          cx.elt("InlineMathMark", pos, pos + 1),
          cx.elt("InlineMathMark", i, i + 1),
        ]));
      }
    }
    return -1;
  },
};

const citation = {
  name: "Citation",
  before: "Link",
  parse(cx: InlineContext, next: number, pos: number) {
    if (next !== BRACKET) return -1;
    let depth = 0;
    for (let i = pos; i < cx.end && i < pos + 600; i++) {
      const ch = cx.char(i);
      if (ch === BRACKET) depth++;
      else if (ch === 93) {
        depth--;
        if (depth === 0) {
          const inner = cx.slice(pos + 1, i);
          if (!inner.includes("@") || cx.char(i + 1) === 40 /* ( */ || cx.char(i + 1) === BRACE) return -1;
          if (!parseBracketCitation(inner)) return -1;
          return cx.addElement(cx.elt("Citation", pos, i + 1));
        }
      }
    }
    return -1;
  },
};

const KEY_CHAR = /[\w:.#$%&\-+?<>~/]/;
const atRef = {
  name: "AtRef",
  before: "Emphasis",
  parse(cx: InlineContext, next: number, pos: number) {
    if (next !== AT) return -1;
    const prev = cx.char(pos - 1);
    if (isWord(prev) || prev === AT) return -1;
    let start = pos + 1;
    if (!isWord(cx.char(start))) return -1;
    let end = start;
    while (end < cx.end && KEY_CHAR.test(String.fromCharCode(cx.char(end)))) end++;
    while (end > start && !isWord(cx.char(end - 1))) end--; // trailing punctuation is not part of key
    if (end <= start) return -1;
    return cx.addElement(cx.elt("AtRef", pos, end));
  },
};

const shortcode = {
  name: "Shortcode",
  before: "Escape",
  parse(cx: InlineContext, next: number, pos: number) {
    if (next !== BRACE || cx.char(pos + 1) !== BRACE || cx.char(pos + 2) !== 60 /* < */) return -1;
    const text = cx.slice(pos, Math.min(cx.end, pos + 500));
    const m = /^\{\{<[\s\S]*?>\}\}/.exec(text);
    if (!m) return -1;
    return cx.addElement(cx.elt("Shortcode", pos, pos + m[0].length));
  },
};

const attributes = {
  name: "Attributes",
  after: "Shortcode",
  parse(cx: InlineContext, next: number, pos: number) {
    if (next !== BRACE) return -1;
    const prev = cx.char(pos - 1);
    // Only right after a link/image/span (`)` or `]`) or a display-math / inline-math close (`$`)
    if (prev !== 41 && prev !== 93 && prev !== DOLLAR && prev !== 32) return -1;
    const text = cx.slice(pos, Math.min(cx.end, pos + 400));
    const m = /^\{[^{}\n]*\}/.exec(text);
    if (!m) return -1;
    if (prev === 32 && !/^\{\s*[#.]/.test(m[0])) return -1;
    return cx.addElement(cx.elt("Attributes", pos, pos + m[0].length));
  },
};

/** LaTeX-only inline commands that have no HTML output: \index{..}, \label{..}, \newpage, … */
const LATEX_CMDS = /^\\(index|label|newpage|clearpage|cleardoublepage|noindent|pagebreak|vspace|hspace|vfill|hfill|smallskip|medskip|bigskip)\b/;
const latexCommand = {
  name: "LatexCommand",
  before: "Escape",
  parse(cx: InlineContext, next: number, pos: number) {
    if (next !== BACKSLASH) return -1;
    const head = LATEX_CMDS.exec(cx.slice(pos, Math.min(cx.end, pos + 20)));
    if (!head) return -1;
    let end = pos + head[0].length;
    while (cx.char(end) === 42 /* * */) end++;
    // optional [..] and {..} arguments with balanced braces
    while (cx.char(end) === BRACKET || cx.char(end) === BRACE) {
      const open = cx.char(end);
      const close = open === BRACE ? 125 : 93;
      let depth = 0;
      let i = end;
      for (; i < cx.end; i++) {
        const ch = cx.char(i);
        if (ch === BACKSLASH) {
          i++;
          continue;
        }
        if (ch === open) depth++;
        else if (ch === close && --depth === 0) break;
      }
      if (i >= cx.end) return -1;
      end = i + 1;
    }
    return cx.addElement(cx.elt("LatexCommand", pos, end));
  },
};

/** Footnote reference `[^id]`. */
const footnoteRef = {
  name: "FootnoteRef",
  before: "Link",
  parse(cx: InlineContext, next: number, pos: number) {
    if (next !== BRACKET || cx.char(pos + 1) !== 94 /* ^ */) return -1;
    const m = /^\[\^([^\]\s]+)\](?!:)/.exec(cx.slice(pos, Math.min(cx.end, pos + 100)));
    if (!m) return -1;
    return cx.addElement(cx.elt("FootnoteRef", pos, pos + m[0].length));
  },
};

/** Inline footnote `^[text]`. */
const inlineFootnote = {
  name: "InlineFootnote",
  before: "Emphasis",
  parse(cx: InlineContext, next: number, pos: number) {
    if (next !== 94 || cx.char(pos + 1) !== BRACKET) return -1;
    let depth = 0;
    for (let i = pos + 1; i < cx.end; i++) {
      const ch = cx.char(i);
      if (ch === BACKSLASH) {
        i++;
        continue;
      }
      if (ch === BRACKET) depth++;
      else if (ch === 93 && --depth === 0) return cx.addElement(cx.elt("InlineFootnote", pos, i + 1));
    }
    return -1;
  },
};

export const quartoMarkdown: MarkdownConfig = {
  defineNodes: [
    { name: "FrontMatter", block: true, style: t.meta },
    { name: "FrontMatterMark", style: t.processingInstruction },
    { name: "DisplayMath", block: true, style: t.special(t.string) },
    { name: "DisplayMathMark", style: t.processingInstruction },
    { name: "DivFence", block: true, style: t.processingInstruction },
    { name: "InlineMath", style: t.special(t.string) },
    { name: "InlineMathMark", style: t.processingInstruction },
    { name: "Citation", style: t.link },
    { name: "AtRef", style: t.link },
    { name: "Shortcode", style: t.macroName },
    { name: "Attributes", style: t.attributeName },
    { name: "LatexCommand", style: t.macroName },
    { name: "FootnoteRef", style: t.link },
    { name: "InlineFootnote", style: t.link },
  ],
  parseBlock: [frontMatter, displayMath, divFence],
  parseInline: [inlineMath, latexCommand, footnoteRef, inlineFootnote, citation, atRef, shortcode, attributes],
};
