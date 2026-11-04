/** Quarto conditional content: `.content-visible` / `.content-hidden` with when-/unless- format/profile. */
import type { Attrs } from "./attrs";

const FORMAT_ALIASES: Record<string, string[]> = {
  html: ["html", "html4", "html5", "revealjs", "dashboard", "epub"],
  latex: ["latex", "pdf", "beamer"],
  pdf: ["latex", "pdf", "beamer"],
  revealjs: ["revealjs"],
  docx: ["docx"],
  epub: ["epub"],
};

function formatMatches(spec: string, format: string): boolean {
  return spec
    .split(/[,\s]+/)
    .filter(Boolean)
    .some((f) => f === format || (FORMAT_ALIASES[f] ?? [f]).includes(format));
}

export function isConditional(a: Attrs): boolean {
  return a.classes.includes("content-visible") || a.classes.includes("content-hidden");
}

/** Whether a conditional div is shown in the given output format (profiles are assumed inactive). */
export function visibleIn(a: Attrs, format: string, profiles: string[] = []): boolean {
  const kv = a.kv;
  const fmtCond = kv["when-format"] ? formatMatches(kv["when-format"], format) : kv["unless-format"] ? !formatMatches(kv["unless-format"], format) : true;
  const profCond = kv["when-profile"] ? profiles.includes(kv["when-profile"]) : kv["unless-profile"] ? !profiles.includes(kv["unless-profile"]) : true;
  const cond = fmtCond && profCond;
  if (a.classes.includes("content-visible")) return cond;
  if (a.classes.includes("content-hidden")) {
    // content-hidden with no condition hides everywhere
    const hasCond = !!(kv["when-format"] || kv["unless-format"] || kv["when-profile"] || kv["unless-profile"]);
    return hasCond ? !cond : false;
  }
  return true;
}

/** Short human label, e.g. "PDF only", "hidden in HTML", "profile: draft". */
export function conditionLabel(a: Attrs): string {
  const kv = a.kv;
  const nice = (f: string) => f.split(/[,\s]+/).filter(Boolean).map((x) => (x === "latex" ? "PDF" : x.toUpperCase())).join("/");
  const visible = a.classes.includes("content-visible");
  if (kv["when-format"]) return visible ? `${nice(kv["when-format"])} only` : `hidden in ${nice(kv["when-format"])}`;
  if (kv["unless-format"]) return visible ? `not in ${nice(kv["unless-format"])}` : `${nice(kv["unless-format"])} only`;
  if (kv["when-profile"]) return `${visible ? "profile" : "hidden in profile"}: ${kv["when-profile"]}`;
  if (kv["unless-profile"]) return `${visible ? "unless profile" : "hidden unless profile"}: ${kv["unless-profile"]}`;
  return visible ? "visible" : "hidden";
}
