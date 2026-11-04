/** Starter projects, written directly so creating a project doesn't require the quarto CLI. */

export type TemplateKind = "book" | "presentation" | "document";

const GITIGNORE = `/.quarto/
/_book/
/_site/
/_freeze/
.folio/
*_files/
`;

export function projectTemplate(kind: TemplateKind, title: string, author: string): Record<string, string> {
  const t = title.replace(/"/g, '\\"');
  const a = author.replace(/"/g, '\\"');
  if (kind === "book") {
    return {
      "_quarto.yml": `project:
  type: book
  output-dir: _book

book:
  title: "${t}"
  author: "${a}"
  date: today
  chapters:
    - index.qmd
    - intro.qmd
    - summary.qmd
    - references.qmd

bibliography: references.bib

format:
  html:
    theme: cosmo
  pdf:
    documentclass: scrreprt

execute:
  freeze: auto
`,
      "index.qmd": `# Preface {.unnumbered}

This is a Quarto book.

To learn more about Quarto books visit <https://quarto.org/docs/books>.
`,
      "intro.qmd": `# Introduction {#sec-intro}

This is a book created from markdown and executable code.

See @knuth84 for additional discussion of literate programming.

::: {.callout-tip}
## Tip
Type \`/\` on an empty line to insert callouts, figures, equations and code cells.
:::
`,
      "summary.qmd": `# Summary

In summary, this book has no content whatsoever.
`,
      "references.qmd": `# References {.unnumbered}

::: {#refs}
:::
`,
      "references.bib": `@article{knuth84,
  author = {Knuth, Donald E.},
  title = {Literate Programming},
  year = {1984},
  journal = {The Computer Journal},
  volume = {27},
  number = {2},
  pages = {97--111}
}
`,
      ".gitignore": GITIGNORE,
    };
  }
  if (kind === "presentation") {
    return {
      "slides.qmd": `---
title: "${t}"
author: "${a}"
format: revealjs
---

## Getting started

- Each \`##\` heading starts a new slide
- Use \`---\` for a slide without a title

## Two columns

:::: {.columns}

::: {.column width="50%"}
Left column
:::

::: {.column width="50%"}
Right column
:::

::::

## Math and code

$$
e^{i\\pi} + 1 = 0
$$

\`\`\`{python}
1 + 1
\`\`\`
`,
      ".gitignore": GITIGNORE,
    };
  }
  return {
    "document.qmd": `---
title: "${t}"
author: "${a}"
format: html
---

## Introduction

Start writing here.
`,
    ".gitignore": GITIGNORE,
  };
}

/** Content for a new chapter/document file. */
export function newDocument(title: string): string {
  return `# ${title}\n\n`;
}
