import "katex/dist/katex.min.css";
import "./styles.css";
import { createBackend } from "./backend";
import { App, applyTheme } from "./ui/app";
import { $ } from "./ui/dom";

async function main() {
  applyTheme();
  const backend = await createBackend();
  const app = new App(backend);
  (window as any).folio = app;
  const initial = await backend.initialFolder();
  if (initial) {
    try {
      await app.openProject(initial);
      return;
    } catch (e) {
      console.warn("Could not open last project", e);
    }
  }
  $("#welcome").hidden = false;
}

main();
