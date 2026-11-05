/** Candidate Python interpreters, in priority order (shared logic for detection, unit-tested). */
export interface PythonCandidate {
  path: string;
  label: string;
  source: "project" | "env" | "conda" | "pyenv" | "system" | "custom";
}

export interface CandidateInputs {
  root: string;
  home: string;
  env: Record<string, string | undefined>;
  /** Directory listing helper: names of entries in `dir` (empty if missing). */
  list: (dir: string) => string[];
  /** Whether a file exists. */
  exists: (path: string) => boolean;
  /** Lines of ~/.conda/environments.txt (empty if missing). */
  condaEnvs: string[];
  windows?: boolean;
}

export function pythonCandidates(i: CandidateInputs): PythonCandidate[] {
  const bin = i.windows ? "Scripts/python.exe" : "bin/python";
  const out: PythonCandidate[] = [];
  const add = (path: string, label: string, source: PythonCandidate["source"]) => {
    if (path && !out.some((c) => c.path === path)) out.push({ path, label, source });
  };
  // 1. virtual environments inside the project
  for (const name of [".venv", "venv", "env", ".env"]) {
    const p = `${i.root}/${name}/${bin}`;
    if (i.exists(p)) add(p, name, "project");
  }
  for (const name of i.list(i.root)) {
    if (i.exists(`${i.root}/${name}/pyvenv.cfg`) && i.exists(`${i.root}/${name}/${bin}`)) add(`${i.root}/${name}/${bin}`, name, "project");
  }
  // 2. explicit configuration
  for (const v of ["FOLIO_PYTHON", "QUARTO_PYTHON"]) {
    const p = i.env[v];
    if (p) add(p, v, "env");
  }
  // 3. conda
  const condaRoots = ["miniconda3", "anaconda3", "miniforge3", "mambaforge"].map((d) => `${i.home}/${d}`);
  const condaDirs = new Set<string>(i.condaEnvs.map((l) => l.trim()).filter(Boolean));
  for (const r of condaRoots) {
    if (i.exists(`${r}/${bin}`)) condaDirs.add(r);
    for (const e of i.list(`${r}/envs`)) condaDirs.add(`${r}/envs/${e}`);
  }
  for (const d of condaDirs) {
    if (!i.exists(`${d}/${bin}`)) continue;
    const name = condaRoots.includes(d) ? "base" : d.split("/").pop()!;
    add(`${d}/${bin}`, `conda: ${name}`, "conda");
  }
  // 4. pyenv
  for (const v of i.list(`${i.home}/.pyenv/versions`)) {
    const p = `${i.home}/.pyenv/versions/${v}/${bin}`;
    if (i.exists(p)) add(p, `pyenv ${v}`, "pyenv");
  }
  // 5. system: whatever `python3` a terminal would run first, then well-known locations
  add("python3", "python3 on PATH", "system");
  for (const p of ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"]) {
    if (i.exists(p)) add(p, p.startsWith("/opt/homebrew") ? "Homebrew" : "system", "system");
  }
  return out;
}

/** Packages Folio installs into a project environment: kernel (Folio) + Quarto's renderer. */
export const KERNEL_PACKAGES = ["jupyter_client", "ipykernel", "pyyaml", "nbformat", "nbclient"];
/** Modules checked by the probe, with the pip package that provides each. */
export const PROBE_MODULES: Record<string, string> = {
  jupyter_client: "jupyter_client",
  ipykernel: "ipykernel",
  yaml: "pyyaml",
  nbformat: "nbformat",
  nbclient: "nbclient",
};
const KERNEL_ONLY = ["jupyter_client", "ipykernel"];

/** Python snippet printing "<version> <missing,modules|->". */
export const PROBE =
  "import sys,importlib.util as u;m=[n for n in ('jupyter_client','ipykernel','yaml','nbformat','nbclient') if u.find_spec(n) is None];print(sys.version.split()[0], ','.join(m) or '-')";

export interface ProbeResult {
  version: string;
  ready: boolean; // can run cells in Folio
  renderReady: boolean; // can also be used by `quarto render` for Python cells
  missing: string[]; // pip package names
}

export function parseProbe(out: string): ProbeResult | null {
  const m = /^(\d+\.\d+\.\d+\S*)\s+(\S+)\s*$/m.exec(out);
  if (!m) return null;
  const missingMods = m[2] === "-" ? [] : m[2].split(",").filter(Boolean);
  return {
    version: m[1],
    ready: !missingMods.some((x) => KERNEL_ONLY.includes(x)),
    renderReady: missingMods.length === 0,
    missing: missingMods.map((x) => PROBE_MODULES[x] ?? x),
  };
}

/** Sources Folio may pip-install into (never system / Homebrew Pythons, see PEP 668). */
export function canInstallInto(source: string): boolean {
  return source === "project" || source === "conda" || source === "pyenv" || source === "custom";
}

export interface DetectedPython {
  path: string;
  label: string;
  source: string;
  version: string | null;
  ready: boolean;
  renderReady?: boolean;
  missing?: string[];
}

/**
 * The interpreter to use: the user's explicit choice, else a project venv, else the first
 * interpreter that can actually run cells (has jupyter_client + ipykernel), else the first found.
 */
export function defaultPython<T extends DetectedPython>(list: T[], chosen: string | null): T | DetectedPython | null {
  if (chosen) return list.find((p) => p.path === chosen) ?? { path: chosen, label: "custom", source: "custom", version: null, ready: false };
  return list.find((p) => p.source === "project") ?? list.find((p) => p.ready) ?? list[0] ?? null;
}
